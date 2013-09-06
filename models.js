var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var bcrypt = require('bcrypt');
var SALT_WORK_FACTOR = 10;
var _ = require('lodash');
var moment = require('moment');
var hljs = require('./highlight.js');
var cheerio = require('cheerio');

var enet = require('./eventnet');

var UserSchema = new Schema({
    username: { type: String, required: true, index: { unique: true } },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    bestTime: { type: Number },
    bestSpeed: { type: Number },
    gamesWon: { type: Number },
    totalGames: { type: Number },
    currentGame: { type: Schema.ObjectId, ref: 'GameSchema' }
});

// TODO: Look into using async library to avoid the spaghetti nesting
UserSchema.pre('save', function(next) {
    var user = this;

    if (!user.isModified('password')) {
        return next();
    }
    bcrypt.genSalt(SALT_WORK_FACTOR, function(err, salt) {
        if (err) {
            console.log(err);
            return next(err);
        }
        bcrypt.hash(user.password, salt, function(err, hash) {
            if (err) {
                console.log(err);
                return next(err);
            }
            user.password = hash;
            next();
        });
    });
});

UserSchema.methods.comparePassword = function(candidate, callback) {
    bcrypt.compare(candidate, this.password, function(err, isMatch) {
        if (err) {
            console.log(err);
            return callback(err);
        }
        callback(null, isMatch);
    });
};

UserSchema.methods.joinGame = function(game, callback) {
    var user = this;

    if (!game.isJoinable) {
        return callback('game is not joinable', false);
    }

    // A player cannot play against himself
    if (!game.isNew && _.contains(game.players, user._id)) {
        return callback('cannot play against self', false);
    }

    var wasNew = game.isNew;
    user.currentGame = game._id;
    game.players.push(user._id);
    game.numPlayers += 1;

    game.save(function(err) {
        if (err) {
            console.log(err);
            return callback('error saving game', false);
        }
        if (wasNew) {
            enet.emit('games:new', game);
        } else {
            enet.emit('games:update', game);
        }
        user.save(function(err) {
            if (err) {
                console.log(err);
                return callback('error saving user', false);
            }
            enet.emit('users:update', user);
            return callback(null, true, game);
        });
    });
};

UserSchema.methods.createGame = function(opts, callback) {
    var user = this;

    // User cannot create a game when he is already in one
    if (user.currentGame) {
        return callback('already in a game', false);
    }

    var game = new Game();
    _.forOwn(opts, function(v, k) {
        if (k in game) {
            game[k] = v;
        }
    });

    game.setStatus('waiting');
    game.isJoinable = true;
    game.isComplete = false;
    game.creator = user._id;

    return user.joinGame(game, callback);
};

UserSchema.methods.quitCurrentGame = function(callback) {
    var user = this;
    if (user.currentGame) {
        Game.findById(user.currentGame, function(err, game) {
            if (err) {
                console.log(err);
                return callback('error retrieving game');
            }
            if (game) {
                game.players.remove(user._id);
                game.numPlayers = game.numPlayers <= 0 ? 0 : game.numPlayers - 1;
                if (game.numPlayers === 0) {
                    game.isComplete = true;
                }
                game.save(function(err) {
                    if (err) {
                        console.log(err);
                        return callback('error saving game');
                    }
                    if (game.isComplete) {
                        enet.emit('games:remove', game);
                    } else {
                        enet.emit('games:update', game);
                    }

                    user.currentGame = undefined;
                    user.save(function(err) {
                        if (err) {
                            console.log(err);
                            return callback('error saving user');
                        }
                        return callback(null, game);
                    });
                });
            }
        });
    } else {
        return callback();
    }
};

UserSchema.statics.resetCurrentGames = function() {
    var users = this;
    users.update({
        currentGame: { $exists: true }
    }, {
        $unset: { currentGame: true }
    }, {
        multi: true
    }, function(err) {
        if (err) {
            console.log(err);
        }
        console.log('users reset');
    });
};

var LangSchema = new Schema({
    key: { type: String },
    name: { type: String },
    projectName: { type: String },
    order: { type: Number },
    exercises: [Schema.ObjectId]
});

LangSchema.methods.randomExercise = function() {
    return this.exercises[Math.floor(Math.random() * this.exercises.length)];
};

var ExerciseSchema = new Schema({
    isInitialized: { type: Boolean },
    lang: { type: String },
    exerciseName: { type: String },
    code: { type: String },
    highlitCode: { type: String },
    commentlessCode: { type: String },
    typeableCode: { type: String },
    typeables: { type: Number }
});

var NON_TYPEABLES = ['comment', 'template_comment', 'diff', 'javadoc', 'phpdoc'];
var NON_TYPEABLE_CLASSES = _.map(NON_TYPEABLES, function(c) { return '.' + c; }).join(',');

ExerciseSchema.pre('save', function(next) {
    var exercise = this;
    if (!exercise.isInitialized) {
        exercise.initialize();
    }
    next();
});

ExerciseSchema.methods.initialize = function() {
    var exercise = this;
    exercise.normalizeNewlines();
    exercise.countTypeables();
    exercise.isInitialized = true;
};

ExerciseSchema.methods.normalizeNewlines = function() {
    var exercise = this;
    exercise.code = exercise.code.replace(/\r\n|\n\r|\r|\n/g, '\n');
};

ExerciseSchema.methods.countTypeables = function() {
    var exercise = this;
    exercise.code = exercise.code.replace(/\s+$/g, '');

    // Highlight.js doesn't always get it right with autodetection
    var highlight = (exercise.lang in hljs.LANGUAGES) ?
                    hljs.highlight(exercise.lang, exercise.code, true) :
                    hljs.highlightAuto(exercise.code);

    exercise.highlitCode = highlight.value;

    // Remove comments because we don't want the player to type out
    // a 500 word explanation for some obscure piece of code
    var $ = cheerio.load(exercise.highlitCode);
    $(NON_TYPEABLE_CLASSES).remove();

    exercise.commentlessCode = $.root().text();
    exercise.typeableCode = exercise.commentlessCode.replace(/(^[ \t]+)|([ \t]+$)/gm, '')
                            .replace(/\n+/g, '\n').trim() + '\n';
    exercise.typeables = exercise.typeableCode.length;
};

var GameSchema = new Schema({
    lang: { type: String, required: true },
    langName: { type: String },
    exercise: { type: Schema.ObjectId },
    numPlayers: { type: Number, min: 0, default: 0 },
    maxPlayers: { type: Number, min: 0 },
    status: { type: String },
    statusText: { type: String },
    isJoinable: { type: Boolean, default: true },
    isComplete: { type: Boolean, default: false },
    starting: { type: Boolean, default: false },
    started: { type: Boolean, default: false },
    startTime: { type: Date },
    creator: { type: Schema.ObjectId, ref: 'UserSchema' },
    winner: { type: Schema.ObjectId, ref: 'UserSchema' },
    winnerTime: { type: Number, min: 0 },
    winnerSpeed: { type: Number, min: 0 },
    players: [Schema.ObjectId],
    wasReset: { type: Boolean, default: false }
});

GameSchema.pre('save', function(next) {
    var game = this;

    if (game.isModified('numPlayers')) {
        if (game.numPlayers == game.maxPlayers) {
            game.isJoinable = false;
        }
    }
    return next();
});

GameSchema.methods.setStatus = function(status) {
    var bindings = {
        'waiting': 'Waiting',
        'ingame': 'In game'
    };
    this.status = status;
    this.statusText = bindings[status];
};

GameSchema.methods.updateGameStatus = function(callback) {
    var game = this;
    var modified = false;
    if (game.starting) {
        if (game.numPlayers < 2) {
            game.starting = false;
            game.startTime = undefined;
            game.isJoinable = true;
            modified = true;
        } else {
            var timeLeft = moment(game.startTime).diff(moment());
            if (game.isJoinable) {
                if (timeLeft < 5000) {
                    game.isJoinable = false;
                    modified = true;
                }
            }
            if (!game.isJoinable) {
                if (timeLeft < 0) {
                    game.started = true;
                    game.setStatus('ingame');
                    modified = true;
                }
            }
        }
    } else {
        if (game.numPlayers > 1) {
            game.starting = true;
            game.startTime = moment().add(15, 'seconds').toDate();
            modified = true;
        }
    }

    if (modified) {
        game.save(function(err) {
            if (err) {
                console.log(err);
                return callback('error saving user');
            }
            enet.emit('games:update', game);
            return callback(null, modified, game);
        });
    } else {
        return callback(null, modified, game);
    }
};

GameSchema.statics.resetIncomplete = function() {
    var games = this;
    games.update({
        $or: [{ isComplete: false }, { isViewable: true }]
    }, {
        isComplete: true,
        isViewable: false,
        numPlayers: 0,
        players: [],
        isJoinable: false,
        wasReset: true
    }, {
        multi: true
    }, function(err) {
        if (err) {
            console.log(err);
        }
        console.log('games reset');
    });
};

var User = mongoose.model('User', UserSchema);
var Lang = mongoose.model('Lang', LangSchema);
var Exercise = mongoose.model('Exercise', ExerciseSchema);
var Game = mongoose.model('Game', GameSchema);

module.exports.User = User;
module.exports.Lang = Lang;
module.exports.Exercise = Exercise;
module.exports.Game = Game;

module.exports.NON_TYPEABLES = NON_TYPEABLES;
module.exports.NON_TYPEABLE_CLASSES = NON_TYPEABLE_CLASSES;
