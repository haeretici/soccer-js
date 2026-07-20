const { GameObject } = require('../../core/entities/gameobject.js');
const { Time, LOGIC_DT } = require('../../core/lib/time.js');
const { Settings } = require('../../settings.js');
const {
    Player,
    PlayerStates,
    isGkProtected,
    grantGkPossession,
    canPressCarrier,
    computePressPriority,
    getAheadDelta,
    isCarrierInDangerZone,
    getGoalkeeperBaseX,
    attacksRightGoal
} = require('../../core/entities/player.js');
const { StateMachine } = require('../../core/lib/fsm.js');
const {
    prepareSetPieceReady,
    executeSetPieceKick,
    SET_PIECE_READY_HOLD
} = require('./set_piece_resume.js');
const {
    pickPlaybook,
    applyCornerPositions,
    resolveWallSize,
    applyThrowInReceiverBias
} = require('../../core/lib/set_piece_playbooks.js');
const { Ball } = require('../../core/entities/ball.js');
const { Pitch } = require('../../core/entities/pitch.js');
const { SoundDB } = require('../../core/lib/sounddb.js');
const { registerPlayerSheetsFromPng } = require('../../core/lib/sprite_sheets.js');
const { Utils } = require('../../core/lib/utils.js');
const { appUrl } = require('../../core/lib/app_paths.js');
const { MessageDispatcher } = require('../../core/lib/message_dispatcher.js');
const { drawAiDebugOverlays } = require('../../core/lib/ai_debug_draw.js');
const {
    buildWallPositions,
    assignWallPlayers,
    clearWallPlayers,
    updateWallJumps,
    pruneFreekickWall,
    tryBallWallCollisions
} = require('../../core/lib/freekick_wall.js');
const { tryBallShotBlocking } = require('../../core/lib/pass_safety.js');
const {
    tickManualControl,
    shouldSkipAIAssign
} = require('../../core/lib/manual_control.js');
const {
    isPenaltyFoul,
    getPenaltySpot,
    defendingGoalSide,
    getPenaltyArea,
    shouldPlayAdvantage,
    advantageStillHolds,
    ADVANTAGE_WINDOW_SEC,
    clearIfkOnTouch
} = require('../../core/lib/match_rules.js');

// Official FIFA 3-Letter Country Codes for the 48 World Cup 2026 Teams
let headlessPresetsCache = null;

const FALLBACK_FORMATIONS_PRESET = require('../../../presets/formations.json');

const TeamCodes = {
    "Algeria": "ALG", "Argentina": "ARG", "Australia": "AUS", "Austria": "AUT",
    "Belgium": "BEL", "Bosnia and Herzegovina": "BIH", "Brazil": "BRA", "Cabo Verde": "CPV",
    "Canada": "CAN", "Colombia": "COL", "Congo DR": "COD", "Croatia": "CRO",
    "Curaçao": "CUW", "Czechia": "CZE", "Côte d'Ivoire": "CIV", "Ecuador": "ECU",
    "Egypt": "EGY", "England": "ENG", "France": "FRA", "Germany": "GER",
    "Ghana": "GHA", "Haiti": "HAI", "IR Iran": "IRN", "Iraq": "IRQ",
    "Japan": "JPN", "Jordan": "JOR", "Korea Republic": "KOR", "Mexico": "MEX",
    "Morocco": "MAR", "Netherlands": "NED", "New Zealand": "NZL", "Norway": "NOR",
    "Panama": "PAN", "Paraguay": "PAR", "Portugal": "POR", "Qatar": "QAT",
    "Saudi Arabia": "KSA", "Scotland": "SCO", "Senegal": "SEN", "South Africa": "RSA",
    "Spain": "ESP", "Sweden": "SWE", "Switzerland": "SUI", "Tunisia": "TUN",
    "Türkiye": "TUR", "United States": "USA", "Uruguay": "URU", "Uzbekistan": "UZB"
};

const NATIVE_MATH_RANDOM = Math.random;
const REPLAY_LOGIC_DT = LOGIC_DT;
const FOUL_REACT_DURATION = 0.7;
const FOUL_OVERLAY_DELAY = 0.25;

/**
 * AI kickoff lay-off: short pass to nearest eligible teammate (or Dribble if alone).
 * @param {Simulator} s
 */
function forceKickoffPass(s) {
    if (!s || !s.ball || !s.ball.owner || s.ball.owner.team !== s.kickoffTeam) return;
    const taker = s.ball.owner;
    const squad = s.getTeam ? s.getTeam(taker.team) : null;
    const teammates = squad
        ? squad.members().filter(p => p !== taker)
        : s.players.filter(p => p.team === taker.team && p !== taker && !p.isSentOff);
    if (teammates.length > 0) {
        // Prefer feet aim — progressive through-ball scoring must not invent upfield targets.
        teammates.sort((a, b) => {
            const da = Math.pow(a.x - taker.x, 2) + Math.pow(a.y - taker.y, 2);
            const db = Math.pow(b.x - taker.x, 2) + Math.pow(b.y - taker.y, 2);
            return da - db;
        });
        let support = teammates[0];
        if (squad && typeof squad.pickBestSafePassTarget === 'function') {
            const nearPool = teammates.slice(0, Math.min(4, teammates.length));
            const safeNear = squad.pickBestSafePassTarget(taker, nearPool, {
                passType: 'short',
                scoreFn: (c) => {
                    const d = Math.pow(c.x - taker.x, 2) + Math.pow(c.y - taker.y, 2);
                    return -d;
                }
            });
            if (safeNear) support = safeNear;
        }
        taker.passTarget = support;
        taker.passType = 'short';
        if (squad && support && typeof squad.getBestPassToReceiver === 'function') {
            taker.passAim = squad.getBestPassToReceiver(taker, support, {
                passType: 'short',
                preferFeet: true
            });
        } else if (support) {
            taker.passAim = { x: support.x, y: support.y };
        } else {
            taker.passAim = null;
        }
        taker.fsm.changeState(PlayerStates.Pass);
    } else {
        taker.fsm.changeState(PlayerStates.Dribble);
    }
}

/**
 * Shared corner / goalkick / freekick / throw-in countdown:
 * 1) setup/walk phase (stateTimer from enter)
 * 2) snap + ready pose for SET_PIECE_READY_HOLD (~2s reaction window)
 * 3) execute Pass/Shoot and return to Play
 * @param {Simulator} s
 * @param {'corner'|'goalkick'|'freekick'|'throwin'} type
 * @param {number} _setupDuration unused (enter sets timer); kept for call-site clarity
 */
/** Extra logic seconds a throw-in may wait for a far taker before force-snapping. */
const THROW_IN_MAX_EXTRA_WAIT = 5.0;
/** Taker must be this close (world units) before ready/kick, unless max wait elapsed. */
const THROW_IN_TAKER_ARRIVE_DIST = 1.35;

/** Boundary set-pieces (throw-in / corner) pin the ball to a fixed in-field spot. */
function isBoundarySetPiece(type) {
    return type === 'throwin' || type === 'corner';
}

function pinBallToSetPieceSpot(s) {
    if (!s || !s.ball || !s._setPieceBallSpot) return;
    const spot = s._setPieceBallSpot;
    s.ball.x = spot.x;
    s.ball.y = spot.y;
    s.ball.z = 0;
    s.ball.vx = 0;
    s.ball.vy = 0;
    s.ball.vz = 0;
}

function tickSetPieceCountdown(s, type, _setupDuration) {
    s.stateTimer -= Time.deltaTime;

    s._freezeBallStatic();

    // Boundary set-pieces (throw-in / corner): pin ball to a fixed in-field spot.
    // Carry offset near the paint / corner flag pushes the ball OOB and restarts
    // the set piece in a loop (especially when the taker stands slightly outside).
    if (isBoundarySetPiece(type) && s.ball && s._setPieceBallSpot) {
        pinBallToSetPieceSpot(s);
    } else if (s.ball && s.ball.owner && (s.setPieceReadyPhase || type !== 'throwin')) {
        // After ready snap, owner is set — keep ball with taker (open-field set pieces).
        s.ball.syncToOwner();
    }

    if (!s.setPieceReadyPhase && s.stateTimer <= 0) {
        // Far throw-in taker: do not snap/kick until they arrive (or max wait).
        // Early snap while teammates are still mid-pitch looks like a drop at the
        // spot and often produces a skim throw that restarts the set piece.
        if (type === 'throwin' && s.throwInTaker && !s.throwInTaker.isSentOff && s.ball) {
            const t = s.throwInTaker;
            const spot = s._setPieceBallSpot || { x: s.ball.x, y: s.ball.y };
            const dist = Math.hypot(t.x - spot.x, t.y - spot.y);
            const waited = s._throwInExtraWait || 0;
            if (dist > THROW_IN_TAKER_ARRIVE_DIST && waited < THROW_IN_MAX_EXTRA_WAIT) {
                s._throwInExtraWait = waited + Time.deltaTime;
                s.stateTimer = 0.05;
                // Keep them walking to the spot (may have cleared walk flag on arrive-near)
                if (!t.isWalkingToSetPiece) {
                    t.setPieceTarget = { x: spot.x, y: spot.y };
                    t.isWalkingToSetPiece = true;
                }
                return;
            }
        }

        prepareSetPieceReady(s, type);
        s.setPieceReadyPhase = true;
        s.stateTimer = SET_PIECE_READY_HOLD;
        return;
    }

    if (s.setPieceReadyPhase && s.stateTimer <= 0) {
        executeSetPieceKick(s, type);
        SoundDB.play('whistle');
        s.setPieceReadyPhase = false;
        s.fsm.changeState(MatchStates.Play);
    }
}

const {
    STRATEGY_KNOBS,
    ALL_UI_KNOBS,
    readTeamUiKnobs
} = require('../../core/lib/ai_ui_knobs.js');

/** Legacy inline-panel slider ids (popup uses postMessage; kept for tests/compat). */
const UI_AI_SLIDER_BINDINGS = [
    { id: 'formationHoldSliderA', team: 'A', key: 'FORMATION_HOLD' },
    { id: 'attackSupportSliderA', team: 'A', key: 'ATTACK_SUPPORT_INTENSITY' },
    { id: 'defensivePressSliderA', team: 'A', key: 'DEFENSIVE_PRESS_INTENSITY' },
    { id: 'passAggressionSliderA', team: 'A', key: 'PASS_AGGRESSION' },
    { id: 'formationHoldSliderB', team: 'B', key: 'FORMATION_HOLD' },
    { id: 'attackSupportSliderB', team: 'B', key: 'ATTACK_SUPPORT_INTENSITY' },
    { id: 'defensivePressSliderB', team: 'B', key: 'DEFENSIVE_PRESS_INTENSITY' },
    { id: 'passAggressionSliderB', team: 'B', key: 'PASS_AGGRESSION' }
];

// Match state singletons for Simulator FSM (reference equality, one object per logical state)
const MatchStates = {
    Kickoff: {
        name: 'kickoff',
        enter(s) {
            s.stateTimer = 2.0;
            s._kickoffWhistlePlayed = false;
            // Hard-snap camera off any goal celebration orbit
            if (typeof s.snapCameraToKickoff === 'function') s.snapCameraToKickoff();
            SoundDB.startCrowd();
            SoundDB.updateCrowd({ matchState: 'kickoff' });
        },
        execute(s) {
            s.stateTimer -= Time.deltaTime;
            // Hold formation pins every tick (stops drift / carry-offset walk)
            if (typeof s.pinKickoffSpots === 'function') s.pinKickoffSpots();
            // Always AI opening pass (manual or not) — avoids human aim/switch bugs
            // on the dead ball. tickManualControl is gated until setPieceType clears.
            if (s.stateTimer <= 0) {
                if (!s._kickoffWhistlePlayed) {
                    SoundDB.play('whistle');
                    SoundDB.crowdReact('burst', 0.2);
                    s._kickoffWhistlePlayed = true;
                }
                forceKickoffPass(s);
                s.fsm.changeState(MatchStates.Play);
            }
        },
        exit(s) {
            s._kickoffWhistlePlayed = false;
        }
    },
    Play: {
        name: 'play',
        enter(s) {
            SoundDB.startCrowd();
            SoundDB.updateCrowd({ matchState: 'play' });
        },
        execute(s) {
            const dt = Time.deltaTime;
            // 1. Tick match clock
            const timeScale = 5400 / s.matchDuration;
            s.matchTimer += dt * timeScale;
            s.updateDynamicStrategies();

            // Halftime trigger
            if (!s.halfTimeTriggered && s.matchTimer >= 2700) {
                s.halfTimeTriggered = true;
                s.fsm.changeState(MatchStates.Halftime);
                return;
            }
            // Fulltime trigger
            if (s.matchTimer >= 5400) {
                s.fsm.changeState(MatchStates.Fulltime);
                return;
            }

            if (!Settings.HEADLESS) {
                s.updateActivePlayerMarkers();
                // Crowd bed: final-third heat + recent shot energy
                const field = Utils.getFieldBounds();
                const ball = s.ball;
                const shotBoost = ball && ball.isShot ? 1 : 0;
                SoundDB.updateCrowd({
                    matchState: 'play',
                    ballX: ball ? ball.x : field.centerX,
                    fieldWidth: field.width,
                    isShot: !!shotBoost,
                    excitement: shotBoost
                });
            }

            // 2b. Stage 1 manual control: resolve avatar + edges before AI assign
            tickManualControl(s);

            // 2c. Advantage window (delayed foul whistle)
            if (typeof s.tickAdvantage === 'function') s.tickAdvantage(dt);

            // 3. Make nearest player chase ball, others follow formation
            s.updatePlayerAIStates();

            // 4. Out of bounds & Goal detection
            s.checkBallCollisions();
        },
        exit(s) {}
    },
    Goal: {
        name: 'goal',
        enter(s) {
            s.stateTimer = 5.0;
            SoundDB.play('whistle');
            SoundDB.play('net');
            // roar also spikes the continuous crowd bed
            SoundDB.play('roar');
            SoundDB.updateCrowd({ matchState: 'goal' });
        },
        execute(s) {
            s.stateTimer -= Time.deltaTime;

            // Run net collisions and damp velocity to settle inside the net
            s.checkGoalNetCollisions();

            const drag = Math.pow(0.12, Time.deltaTime);
            s.ball.vx *= drag;
            s.ball.vy *= drag;
            if (s.ball.z === 0) {
                s.ball.vx *= Math.pow(0.3, Time.deltaTime);
                s.ball.vy *= Math.pow(0.3, Time.deltaTime);
            }

            if (s.stateTimer <= 0) {
                s.kickoffTeam = s.goalScoredTeam === 'A' ? 'B' : 'A';
                s.resetToKickoff();
                s.fsm.changeState(MatchStates.Kickoff);
            }
        },
        exit(s) {
            // Drop celebration camera lock so kickoff can re-center immediately
            s._manualCameraActive = false;
        }
    },
    Foul: {
        name: 'foul',
        enter(s) {
            s.stateTimer = FOUL_REACT_DURATION;
            SoundDB.play('foul');
            SoundDB.play('whistle');
            SoundDB.updateCrowd({ matchState: 'foul' });
        },
        execute(s) {
            s.stateTimer -= Time.deltaTime;

            if (s.ball) {
                s.ball.x = s.setPieceX;
                s.ball.y = s.setPieceY;
                s.ball.z = 0;
                s.ball.vx = 0;
                s.ball.vy = 0;
                s.ball.vz = 0;
                s.ball.owner = null;
            }

            if (s.stateTimer <= 0) {
                s.resolvePendingFoul();
            }
        },
        exit(s) {}
    },
    Corner: {
        name: 'corner',
        enter(s) {
            s.stateTimer = 1.5;
            s.setPieceReadyPhase = false;
            SoundDB.play('whistle');
            SoundDB.crowdReact('burst', 0.25);
            SoundDB.updateCrowd({ matchState: 'corner' });
        },
        execute(s) {
            tickSetPieceCountdown(s, 'corner', 1.5);
            if (!Settings.HEADLESS) SoundDB.updateCrowd({ matchState: 'corner' });
        },
        exit(s) {
            s.setPieceReadyPhase = false;
        }
    },
    Goalkick: {
        name: 'goalkick',
        enter(s) {
            s.stateTimer = 1.5;
            s.setPieceReadyPhase = false;
            SoundDB.updateCrowd({ matchState: 'goalkick' });
        },
        execute(s) {
            tickSetPieceCountdown(s, 'goalkick', 1.5);
            if (!Settings.HEADLESS) SoundDB.updateCrowd({ matchState: 'goalkick' });
        },
        exit(s) {
            s.setPieceReadyPhase = false;
        }
    },
    Freekick: {
        name: 'freekick',
        enter(s) {
            s.stateTimer = 2.0;
            s.setPieceReadyPhase = false;
            SoundDB.play('whistle');
            SoundDB.crowdReact('burst', 0.2);
            SoundDB.updateCrowd({ matchState: 'freekick' });
        },
        execute(s) {
            tickSetPieceCountdown(s, 'freekick', 2.0);
            if (!Settings.HEADLESS) SoundDB.updateCrowd({ matchState: 'freekick' });
        },
        exit(s) {
            s.setPieceReadyPhase = false;
        }
    },
    Penalty: {
        name: 'penalty',
        enter(s) {
            s.stateTimer = 2.0;
            s.setPieceReadyPhase = false;
            SoundDB.play('whistle');
            SoundDB.crowdReact('burst', 0.35);
            SoundDB.updateCrowd({ matchState: 'penalty' });
        },
        execute(s) {
            tickSetPieceCountdown(s, 'penalty', 2.0);
            if (!Settings.HEADLESS) SoundDB.updateCrowd({ matchState: 'penalty' });
        },
        exit(s) {
            s.setPieceReadyPhase = false;
        }
    },
    Throwin: {
        name: 'throwin',
        enter(s) {
            // Base walk window; far takers get up to THROW_IN_MAX_EXTRA_WAIT more.
            s.stateTimer = 3.0;
            s.setPieceReadyPhase = false;
            s._throwInExtraWait = 0;
            SoundDB.updateCrowd({ matchState: 'throwin' });
        },
        execute(s) {
            tickSetPieceCountdown(s, 'throwin', 3.0);
            if (!Settings.HEADLESS) SoundDB.updateCrowd({ matchState: 'throwin' });
        },
        exit(s) {
            s.setPieceReadyPhase = false;
            s._throwInExtraWait = 0;
        }
    },
    Card: {
        name: 'card',
        enter(s) {
            s.stateTimer = 2.5;
            SoundDB.play('card');
            SoundDB.play('whistle');
            SoundDB.updateCrowd({ matchState: 'card' });
        },
        execute(s) {
            s.stateTimer -= Time.deltaTime;

            if (s.ball) {
                s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0;
                s.ball.z = 0;
            }

            if (s.stateTimer <= 0) {
                const kickingTeam = s.cardedPlayer && s.cardedPlayer.team === 'A' ? 'B' : 'A';
                s.setPieceKickingTeam = kickingTeam;
                // Preserve penalty vs freekick decided at foul time
                const isPen = s.setPieceType === 'penalty';
                if (isPen) {
                    s.setPieceType = 'penalty';
                    s.setPieceIndirect = false;
                    s.setupSetPiecePositions('penalty', s.setPieceSide, kickingTeam);
                    s.fsm.changeState(MatchStates.Penalty);
                } else {
                    s.setPieceType = 'freekick';
                    s.setupSetPiecePositions('freekick', s.setPieceSide, kickingTeam);
                    s.fsm.changeState(MatchStates.Freekick);
                }
            }
        },
        exit(s) {}
    },
    Offside: {
        name: 'offside',
        enter(s) {
            s.stateTimer = 2.0;
            SoundDB.play('offside');
            SoundDB.updateCrowd({ matchState: 'offside' });
        },
        execute(s) {
            s.stateTimer -= Time.deltaTime;

            if (s.ball) {
                s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0;
                s.ball.z = 0;
            }

            if (s.stateTimer <= 0) {
                const defendingTeam = s.setPieceKickingTeam;
                s.setPieceType = 'freekick';
                s.setupSetPiecePositions('freekick', s.setPieceSide, defendingTeam);
                s.fsm.changeState(MatchStates.Freekick);
            }
        },
        exit(s) {}
    },
    Halftime: {
        name: 'halftime',
        enter(s) {
            s.stateTimer = 5.0;
            SoundDB.play('whistle_long');
            SoundDB.updateCrowd({ matchState: 'halftime' });
        },
        execute(s) {
            s.stateTimer -= Time.deltaTime;
            if (s.ball) {
                s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0;
            }
            for (const p of s.players) p.frame = 0;

            if (s.stateTimer <= 0) {
                s.matchTimer = 2700;
                s.kickoffTeam = s.kickoffTeam === 'A' ? 'B' : 'A';
                s.swapSides();
                s._scoreboardCache = { flagA: null, flagB: null, displayA: null, displayB: null };
                s.resetToKickoff();
                s.fsm.changeState(MatchStates.Kickoff);
            }
        },
        exit(s) {}
    },
    Fulltime: {
        name: 'fulltime',
        enter(s) {
            SoundDB.play('whistle_end');
            SoundDB.play('roar');
            SoundDB.updateCrowd({ matchState: 'fulltime' });
            s._playbackRecordingStopped = true;
            s.playbackMaxElapsedTicks = s.playbackElapsedTicks;
            s.playbackMaxElapsedSec = s.playbackElapsedTicks * s.getReplayStepDt();
        },
        execute(s) {
            if (s.ball) {
                s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0;
            }
            let winningTeam = null;
            if (s.scoreA > s.scoreB) winningTeam = 'A';
            else if (s.scoreB > s.scoreA) winningTeam = 'B';
            for (const p of s.players) {
                if (p.team !== winningTeam) {
                    p.frame = 0;
                }
            }
        },
        exit(s) {}
    }
};

// Helper to map string name to singleton state key (for compat setter)
function _matchStateNameToKey(name) {
    const m = {
        'kickoff': 'Kickoff', 'play': 'Play', 'goal': 'Goal', 'halftime': 'Halftime', 'fulltime': 'Fulltime',
        'foul': 'Foul', 'corner': 'Corner', 'goalkick': 'Goalkick', 'freekick': 'Freekick',
        'penalty': 'Penalty', 'throwin': 'Throwin', 'card': 'Card', 'offside': 'Offside'
    };
    return m[name] || null;
}

class Simulator extends GameObject {
    constructor(config = {}) {
        super('Simulator');
        if (typeof config.seed === 'number' && !isNaN(config.seed)) {
            this.seed = (config.seed >>> 0) || 1;
        } else {
            this.seed = Math.floor(NATIVE_MATH_RANDOM() * 999999) + 1;
        }
        this.replayConfig = null;
        this.playbackElapsedTicks = 0;
        this.playbackMaxElapsedTicks = 0;
        this.playbackElapsedSec = 0;
        this.playbackMaxElapsedSec = 0;
        this._fastForwardReplay = false;
        this._seekInProgress = false;
        this._playbackRecordingStopped = false;
        this.rngState = 0;

        this.pitch = null;
        this.ball = null;
        /** Flat roster (teamA.players + teamB.players) for match-wide queries & legacy tests */
        this.players = [];
        /** @type {import('../../core/entities/team.js').Team|null} */
        this.teamA = null;
        /** @type {import('../../core/entities/team.js').Team|null} */
        this.teamB = null;
        /** Logic-tick AI message bus */
        this.msgDispatcher = new MessageDispatcher();

        this.offsideLineA = 0;
        this.offsideLineB = 0;

        this.scoreA = 0;
        this.scoreB = 0;
        this.teamAName = "Brazil";
        this.teamBName = "Argentina";
        this.formationAName = "4-4-2";
        this.formationBName = "4-4-2";

        this.baseStrategyA = null;
        this.baseStrategyB = null;
        this.activeShiftA = null;
        this.activeShiftB = null;
        this.strategyShiftsA = 0;
        this.strategyShiftsB = 0;

        this.setPieceType = '';
        this.setPieceSide = '';
        this.setPieceCornerY = 0;
        this.setPieceX = 0;
        this.setPieceY = 0;
        this.throwInTaker = null;
        this.activePlaybook = null;
        /** A.6 Wall players (defenders) for the active freekick. Cleared on kick/reset. */
        this.freekickWallPlayers = [];
        /** After set-piece snap: hold before Pass/Shoot (reaction window). */
        this.setPieceReadyPhase = false;
        /** True while the next free kick must be taken as an indirect free kick (offside, etc.). */
        this.setPieceIndirect = false;
        /** Active advantage window: delayed foul whistle while fouled team keeps the ball. */
        this._pendingAdvantage = null;

        this.matchTimer = 0; // in simulated seconds (0 to 5400)
        this.stateTimer = 2.0; // delay timer for goals/kickoffs
        this.kickoffTeam = 'A';
        this.goalScoredTeam = '';
        this.lastTouchPlayer = null;
        this.halfTimeTriggered = false;

        // C.3 Balance metrics & "xG-lite"
        this.xgA = 0;
        this.xgB = 0;
        this.progressivePassesA = 0;
        this.progressivePassesB = 0;
        this.pressSuccessesA = 0;
        this.pressSuccessesB = 0;
        this.transitionGoalsA = 0;
        this.transitionGoalsB = 0;
        this.lastTurnoverFrameA = -9999;
        this.lastTurnoverFrameB = -9999;
        this.currentFrameCount = 0;
        this._lastPossessorTeam = null;

        // Match Duration
        this.matchDuration = 10 * 60; // default 10 mins (600 seconds) in real time

        this._scoreboardCache = {
            flagA: null,
            flagB: null,
            displayA: null,
            displayB: null
        };
        this._stickyPrimaryChasers = { A: null, B: null };
        /** Sticky active-player highlights per team (loose ball / press marker). */
        this._stickyActiveMarker = { A: null, B: null };

        // FSM for match states (singleton states, controlled via changeState/enter/execute/exit)
        this.fsm = new StateMachine(this);

        // Thin compat layer: matchState getter returns fsm name; setter drives changeState (for legacy test direct assigns)
        const self = this;
        Object.defineProperty(this, 'matchState', {
            configurable: true,
            enumerable: true,
            get() {
                return (self.fsm && self.fsm.getNameOfCurrentState()) || 'kickoff';
            },
            set(val) {
                if (!self.fsm) return;
                const key = _matchStateNameToKey(val);
                const target = key ? MatchStates[key] : null;
                if (target && !self.fsm.isInState(target)) {
                    self.fsm.changeState(target);
                }
            }
        });

        this.fsm.setCurrentState(MatchStates.Kickoff);
    }

    async start() {
        if (!Settings.HEADLESS) {
            if (typeof document !== 'undefined') {
                const seedInput = document.getElementById('seedInput');
                if (seedInput) {
                    seedInput.value = this.seed.toString();
                }
            }
        }

        await this.bootstrapMatch(null);

        if (!Settings.HEADLESS && typeof document !== 'undefined') {
            this.replayConfig = this.captureReplayConfig();
            this.playbackElapsedTicks = 0;
            this.playbackMaxElapsedTicks = 0;
            this.playbackElapsedSec = 0;
            this.playbackMaxElapsedSec = 0;
            this._fastForwardReplay = false;
            this._playbackRecordingStopped = false;
        }
    }

    getReplayStepDt() {
        return REPLAY_LOGIC_DT;
    }

    restoreMatchAIStrategySettings() {
        if (Settings.HEADLESS || typeof document === 'undefined') return;

        Settings.AI.A = Settings.AI.A || Object.create(Settings.AI);
        Settings.AI.B = Settings.AI.B || Object.create(Settings.AI);

        for (const binding of UI_AI_SLIDER_BINDINGS) {
            const el = document.getElementById(binding.id);
            if (!el) continue;
            const val = parseFloat(el.value);
            if (!isNaN(val)) {
                Settings.AI[binding.team][binding.key] = val;
            }
        }
    }

    bindSeededRandom() {
        this.seededRandom = this.createSeededRandom(this.seed);
        Math.random = this.seededRandom;
    }

    captureReplayConfig() {
        const aiBlock = (teamKey) => readTeamUiKnobs(Settings.AI[teamKey], Settings.AI);

        return {
            seed: this.seed,
            teamAName: this.teamAName,
            teamBName: this.teamBName,
            formationAName: this.formationAName,
            formationBName: this.formationBName,
            matchDuration: this.matchDuration,
            fieldSizeMultiplier: Settings.FIELD_SIZE_MULTIPLIER,
            matchDurationSetting: Settings.MATCH_DURATION,
            timeSpeed: Settings.TIME_SPEED,
            refereeStrictness: Settings.REFEREE_STRICTNESS,
            dynamicStrategyShifting: Settings.AI.dynamicStrategyShifting,
            aiA: aiBlock('A'),
            aiB: aiBlock('B')
        };
    }

    applyReplayConfig(cfg) {
        this.seed = cfg.seed;
        this.teamAName = cfg.teamAName;
        this.teamBName = cfg.teamBName;
        this.formationAName = cfg.formationAName;
        this.formationBName = cfg.formationBName;
        this.matchDuration = cfg.matchDuration;
        Settings.FIELD_SIZE_MULTIPLIER = cfg.fieldSizeMultiplier;
        Settings.MATCH_DURATION = cfg.matchDurationSetting;
        if (typeof cfg.timeSpeed === 'number') Settings.TIME_SPEED = cfg.timeSpeed;
        if (typeof cfg.refereeStrictness === 'number') Settings.REFEREE_STRICTNESS = cfg.refereeStrictness;
        Settings.AI.dynamicStrategyShifting = cfg.dynamicStrategyShifting;

        for (const key of ALL_UI_KNOBS) {
            if (cfg.aiA && typeof cfg.aiA[key] === 'number') Settings.AI.A[key] = cfg.aiA[key];
            if (cfg.aiB && typeof cfg.aiB[key] === 'number') Settings.AI.B[key] = cfg.aiB[key];
        }
    }

    clearMatchEntities() {
        this.children = [];
        this.scripts = [];
        this.players = [];
        this.pitch = null;
        this.ball = null;
        this.teamA = null;
        this.teamB = null;
        if (this.msgDispatcher) this.msgDispatcher.clear();
        this._stickyPrimaryChasers = { A: null, B: null };
        this._stickyActiveMarker = { A: null, B: null };
        this._scoreboardCache = { flagA: null, flagB: null, displayA: null, displayB: null };
    }

    /** Rebuild flat this.players from pitch teams (A then B). */
    syncPlayersList() {
        this.players = [
            ...(this.teamA ? this.teamA.players : []),
            ...(this.teamB ? this.teamB.players : [])
        ];
    }

    getTeam(teamKey) {
        if (teamKey === 'B') return this.teamB;
        if (teamKey === 'A') return this.teamA;
        return null;
    }

    resetMatchStateCounters() {
        this.scoreA = 0;
        this.scoreB = 0;
        this.matchTimer = 0;
        this.stateTimer = 2.0;
        this.kickoffTeam = Math.random() < 0.5 ? 'A' : 'B';
        this.lastTouchPlayer = null;
        this.halfTimeTriggered = false;
        this.goalScoredTeam = '';
        this.cardedPlayer = null;
        this.cardType = null;
        this.fouledPlayer = null;
        this._pendingFoulOutcome = null;
        this._pendingAdvantage = null;
        this.setPieceType = '';
        this.setPieceSide = '';
        this.setPieceCornerY = 0;
        this.setPieceX = 0;
        this.setPieceY = 0;
        this.setPieceIndirect = false;
        this.throwInReceivers = null;
        this.throwInTaker = null;
        this.activePlaybook = null;
        this.setPieceReadyPhase = false;
        clearWallPlayers(this.freekickWallPlayers);
        this.freekickWallPlayers = [];
        this._stickyPrimaryChasers = { A: null, B: null };
        this._stickyActiveMarker = { A: null, B: null };
        this.activeShiftA = null;
        this.activeShiftB = null;
        this.strategyShiftsA = 0;
        this.strategyShiftsB = 0;
        if (this.ball) {
            this.ball.ifkActive = false;
            this.ball.ifkTaker = null;
        }
        if (this.fsm) {
            this.fsm.setCurrentState(MatchStates.Kickoff);
        }
    }

    async loadPresets() {
        if (this.defaultStats && this.formationsPreset) {
            return;
        }

        try {
            if (Settings.HEADLESS && headlessPresetsCache) {
                this.defaultStats = headlessPresetsCache.defaultStats;
                this.teamStatsPreset = headlessPresetsCache.teamStatsPreset;
                this.formationsPreset = headlessPresetsCache.formationsPreset;
            } else {
                const statsRes = await fetch(appUrl('presets/player_stats.json'));
                const statsPreset = await statsRes.json();
                this.defaultStats = statsPreset.default_stats;
                this.teamStatsPreset = statsPreset.teams;

                const formationsRes = await fetch(appUrl('presets/formations.json'));
                this.formationsPreset = await formationsRes.json();

                if (Settings.HEADLESS) {
                    headlessPresetsCache = {
                        defaultStats: this.defaultStats,
                        teamStatsPreset: this.teamStatsPreset,
                        formationsPreset: this.formationsPreset
                    };
                }
            }
        } catch (e) {
            console.error("Failed loading JSON presets, using disk fallbacks:", e);
            this.defaultStats = { speed: 60, stamina: 80, passing: 70, dribbling: 70, shooting: 65, tackling: 60, goalkeeping: 50 };
            this.formationsPreset = FALLBACK_FORMATIONS_PRESET;
        }
    }

    getPlayerStatsForSprites() {
        if (!this.teamStatsPreset) return {};
        return this.teamStatsPreset.teams
            ? this.teamStatsPreset
            : { teams: this.teamStatsPreset };
    }

    async ensureActiveTeamSprites() {
        if (Settings.HEADLESS || typeof document === 'undefined') return;
        if (!this.teamAName || !this.teamBName) return;

        try {
            const palettesRes = await fetch(appUrl('presets/palettes.json'));
            const palettes = await palettesRes.json();
            await registerPlayerSheetsFromPng(
                palettes,
                this.getPlayerStatsForSprites(),
                [this.teamAName, this.teamBName]
            );
        } catch (e) {
            console.error('Failed to register active team sprites:', e);
        }
    }

    async bootstrapMatch(replayConfig) {
        if (replayConfig) {
            this.applyReplayConfig(replayConfig);
        } else {
            this.restoreMatchAIStrategySettings();
            this.readConfig();
        }

        this.clearMatchEntities();
        await this.loadPresets();
        await this.ensureActiveTeamSprites();

        const prevRandom = Math.random;
        try {
            this.bindSeededRandom();
            Math.random = this.seededRandom;

            this.resetMatchStateCounters();

            this.pitch = new Pitch();
            this.insertChild(this.pitch);

            const teams = this.pitch.createTeams(this.teamAName, this.teamBName);
            this.teamA = teams.teamA;
            this.teamB = teams.teamB;

            this.ball = new Ball();
            this.insertChild(this.ball);

            this.players = [];
            this.setupTeam('A', this.teamAName, this.formationAName);
            this.setupTeam('B', this.teamBName, this.formationBName);

            // Base strategy = archetype-overridable knobs only (shape knobs stay live)
            this.baseStrategyA = Object.fromEntries(
                STRATEGY_KNOBS.map((key) => [key, Settings.AI.A[key]])
            );
            this.baseStrategyB = Object.fromEntries(
                STRATEGY_KNOBS.map((key) => [key, Settings.AI.B[key]])
            );

            this.resetToKickoff();
            // Ensure Kickoff.enter runs for the very first match kickoff (ctor/reset use setCurrent to avoid early side-effects)
            if (this.fsm) {
                this.fsm.changeState(MatchStates.Kickoff);
            }
        } finally {
            Math.random = prevRandom;
        }
    }

    async seekPlayback(targetTicks) {
        if (!this.replayConfig || Settings.HEADLESS || typeof document === 'undefined') {
            return;
        }

        const maxTarget = Math.max(0, this.playbackMaxElapsedTicks);
        const target = Math.max(0, Math.min(Math.floor(Number(targetTicks) || 0), maxTarget));
        const prevMuted = Settings.soundsMuted;
        const wasActive = this.active;
        const liveTimeSpeed = Settings.TIME_SPEED;

        this._fastForwardReplay = true;
        this._seekInProgress = true;
        this._playbackRecordingStopped = false;
        Settings.soundsMuted = true;
        this.active = true;

        await this.bootstrapMatch(this.replayConfig);

        let ticks = 0;
        const stepDt = this.getReplayStepDt();
        const frameCap = maxTarget + 5000;

        while (ticks < target && this.matchState !== 'fulltime' && ticks < frameCap) {
            Time.advanceFixedLogicStep();
            this.updateAll();
            ticks++;
        }

        this.playbackElapsedTicks = ticks;
        this.playbackElapsedSec = ticks * stepDt;
        this._fastForwardReplay = false;
        this._seekInProgress = false;
        if (this.matchState === 'fulltime') {
            this._playbackRecordingStopped = true;
            this.playbackMaxElapsedTicks = this.playbackElapsedTicks;
            this.playbackMaxElapsedSec = this.playbackElapsedTicks * stepDt;
        }
        this.active = wasActive;
        Settings.soundsMuted = prevMuted;
        Settings.TIME_SPEED = liveTimeSpeed;

        this._scoreboardCache = { flagA: null, flagB: null, displayA: null, displayB: null };
        this.updateHTMLStats();
        this.updateScrubberUI();
    }

    readConfig() {
        if (Settings.batchConfig) {
            const bc = Settings.batchConfig;
            if (bc.teamA) this.teamAName = bc.teamA;
            if (bc.teamB) this.teamBName = bc.teamB;
            if (bc.formationA) this.formationAName = bc.formationA;
            if (bc.formationB) this.formationBName = bc.formationB;
        } else if (typeof document !== 'undefined') {
            const teamASelect = document.getElementById('teamASelect');
            const teamBSelect = document.getElementById('teamBSelect');
            const formationASelect = document.getElementById('formationASelect');
            const formationBSelect = document.getElementById('formationBSelect');

            if (teamASelect) this.teamAName = teamASelect.value;
            if (teamBSelect) this.teamBName = teamBSelect.value;
            if (formationASelect) this.formationAName = formationASelect.value;
            if (formationBSelect) this.formationBName = formationBSelect.value;
        }

        // Read match duration from settings
        if (Settings.MATCH_DURATION) {
            this.matchDuration = Settings.MATCH_DURATION;
        }
    }

    updateDynamicStrategies() {
        if (!Settings.AI.dynamicStrategyShifting) {
            if (this.activeShiftA) {
                this.activeShiftA = null;
                this.restoreBaseStrategy('A');
            }
            if (this.activeShiftB) {
                this.activeShiftB = null;
                this.restoreBaseStrategy('B');
            }
            return;
        }

        const isLateGame = this.matchTimer >= 4800; // 80th minute or later

        this.processTeamDynamicStrategy('A', isLateGame);
        this.processTeamDynamicStrategy('B', isLateGame);
    }

    processTeamDynamicStrategy(team, isLateGame) {
        const scoreSelf = team === 'A' ? this.scoreA : this.scoreB;
        const scoreOpp = team === 'A' ? this.scoreB : this.scoreA;

        let targetArchetype = null;

        if (isLateGame) {
            if (scoreSelf < scoreOpp) {
                targetArchetype = 'gegenpressing';
            } else if (scoreSelf > scoreOpp) {
                targetArchetype = 'catenaccio';
            }
        }

        const currentShift = team === 'A' ? this.activeShiftA : this.activeShiftB;

        if (targetArchetype !== currentShift) {
            if (team === 'A') {
                this.activeShiftA = targetArchetype;
                if (targetArchetype) this.strategyShiftsA++;
            } else {
                this.activeShiftB = targetArchetype;
                if (targetArchetype) this.strategyShiftsB++;
            }

            if (targetArchetype) {
                this.applyStrategyOverride(team, targetArchetype);
            } else {
                this.restoreBaseStrategy(team);
            }
        }
    }

    applyStrategyOverride(team, archetypeId) {
        const { getArchetypeValues } = require('../../core/lib/ai_archetypes.js');
        const values = getArchetypeValues(archetypeId);
        if (values) {
            for (const key of STRATEGY_KNOBS) {
                Settings.AI[team][key] = values[key];
            }
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('strategy-shifted', { detail: { team, archetypeId } }));
            }
        }
    }

    restoreBaseStrategy(team) {
        const base = team === 'A' ? this.baseStrategyA : this.baseStrategyB;
        if (base) {
            for (const key of STRATEGY_KNOBS) {
                Settings.AI[team][key] = base[key];
            }
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('strategy-shifted', { detail: { team, archetypeId: null } }));
            }
        }
    }

    /**
     * Apply a live Engine Tweakings / UI knob for a team.
     * Strategy knobs update baseStrategy (for dynamic shift restore); shape knobs always apply live.
     * Re-applies squad posture so region depth shifts take effect immediately.
     */
    updateBaseStrategyValue(team, key, value) {
        Settings.AI[team] = Settings.AI[team] || Object.create(Settings.AI);
        const isStrategy = STRATEGY_KNOBS.includes(key);
        if (isStrategy) {
            const base = team === 'A' ? this.baseStrategyA : this.baseStrategyB;
            if (base) {
                base[key] = value;
            }
            const currentShift = team === 'A' ? this.activeShiftA : this.activeShiftB;
            if (!currentShift) {
                Settings.AI[team][key] = value;
            }
        } else {
            // Shape / advanced knobs are never replaced by archetype shifts
            Settings.AI[team][key] = value;
        }
        this.refreshTeamPosture(team);
    }

    /** Re-bind home regions / depth after live AI shape knobs change. */
    refreshTeamPosture(teamKey) {
        const team = this.getTeam(teamKey);
        if (!team || typeof team.applyPosture !== 'function') return;
        const posture = team.postureName || 'kickoffprepare';
        const opts = {};
        // Preserve counterpress delay-drop if still in window
        if (
            posture === 'defending'
            && typeof team.isCounterpressing === 'function'
            && team.isCounterpressing()
        ) {
            opts.delayRegionDrop = true;
        }
        team.applyPosture(posture, opts);
    }

    /**
     * Ensure pitch + both Team nodes exist (for tests that call setupTeam without full bootstrap).
     */
    ensureTeams() {
        if (!this.pitch) {
            this.pitch = new Pitch();
            this.insertChild(this.pitch);
        }
        if (!this.teamA || !this.teamB) {
            const teams = this.pitch.createTeams(this.teamAName, this.teamBName);
            this.teamA = teams.teamA;
            this.teamB = teams.teamB;
        }
    }

    setupTeam(teamKey, teamName, formationName) {
        const formation = this.formationsPreset[formationName];
        if (!formation || formation.length !== 11) {
            const available = Object.keys(this.formationsPreset || {}).sort().join(', ');
            throw new Error(`Unknown or invalid formation "${formationName}" (available: ${available || 'none'})`);
        }

        this.ensureTeams();

        const team = this.getTeam(teamKey);
        if (!team) {
            throw new Error(`setupTeam: unknown teamKey "${teamKey}"`);
        }

        team.nationName = teamName;
        team.formationName = formationName;
        if (teamKey === 'A') {
            this.teamAName = teamName;
            this.formationAName = formationName;
        } else {
            this.teamBName = teamName;
            this.formationBName = formationName;
        }

        const code = TeamCodes[teamName] || teamName.substring(0, 3).toUpperCase();
        const teamStatsList = (this.teamStatsPreset && this.teamStatsPreset[teamName])
            ? this.teamStatsPreset[teamName]
            : null;

        team.createPlayers({
            formation,
            teamStatsList,
            defaultStats: this.defaultStats || {},
            code
        });

        this.syncPlayersList();
    }

    recalculateReferencePositions() {
        if (this.teamA) {
            this.teamA.recalculateReferencePositions(this.formationsPreset[this.formationAName]);
        }
        if (this.teamB) {
            this.teamB.recalculateReferencePositions(this.formationsPreset[this.formationBName]);
        }
    }

    changeFormation(teamKey, formationName) {
        if (teamKey === 'A') {
            this.formationAName = formationName;
            if (this.teamA) this.teamA.formationName = formationName;
        } else {
            this.formationBName = formationName;
            if (this.teamB) this.teamB.formationName = formationName;
        }
        this.recalculateReferencePositions();
    }

    /**
     * Snap cam to center-spot kickoff (clears celebration orbit + manual follow lock).
     */
    snapCameraToKickoff() {
        this._manualCameraActive = false;
        if (Settings.HEADLESS || !Settings.app || !Settings.app.canvas) return;
        if (Settings.camera && Settings.camera.type === 'static') {
            Settings.app.camX = 0;
            Settings.app.camY = 0;
            return;
        }
        const field = Utils.getFieldBounds();
        const x = this.ball ? this.ball.x : field.centerX;
        const y = this.ball ? this.ball.y : field.centerY;
        const z = this.ball ? (this.ball.z || 0) : 0;
        const screen = Utils.toScreen(x, y, z);
        Settings.app.camX = Settings.app.canvas.width / 2 - screen.x;
        Settings.app.camY = Settings.app.canvas.height / 2 - screen.y;
    }

    /**
     * Re-apply frozen kickoff spots (taker slightly on own half, ball on center mark).
     * Call while setPieceType === 'kickoff' and the taker still owns the ball.
     */
    pinKickoffSpots() {
        const pin = this._kickoffPins;
        if (!pin || this.setPieceType !== 'kickoff') return;
        if (!this.ball || this.ball.owner !== pin.taker) return;

        if (pin.taker && !pin.taker.isSentOff) {
            pin.taker.x = pin.takerX;
            pin.taker.y = pin.takerY;
            pin.taker.z = 0;
            pin.taker.vx = 0;
            pin.taker.vy = 0;
            pin.taker.vz = 0;
            pin.taker._currentSpeed = 0;
            pin.taker.orientation = pin.takerOrient;
            pin.taker.isWalkingToSetPiece = false;
            pin.taker.setPieceTarget = null;
        }
        if (pin.support && !pin.support.isSentOff) {
            pin.support.x = pin.supportX;
            pin.support.y = pin.supportY;
            pin.support.z = 0;
            pin.support.vx = 0;
            pin.support.vy = 0;
            pin.support.vz = 0;
            pin.support._currentSpeed = 0;
            pin.support.orientation = pin.supportOrient;
            pin.support.isWalkingToSetPiece = false;
            pin.support.setPieceTarget = null;
        }
        // Ball sits on the center mark — not carry-offset "ahead" of the taker
        this.ball.x = pin.ballX;
        this.ball.y = pin.ballY;
        this.ball.z = 0;
        this.ball.vx = 0;
        this.ball.vy = 0;
        this.ball.vz = 0;
        this.ball.curveForce = 0;
        // Keep prev in sync so render spin does not accumulate from pin snaps
        this.ball.prevX = pin.ballX;
        this.ball.prevY = pin.ballY;
        this.ball.prevZ = 0;
    }

    resetToKickoff() {
        this.setPieceType = 'kickoff';
        this._kickoffWhistlePlayed = false;
        this._kickoffPins = null;
        this._stickyPrimaryChasers = { A: null, B: null };
        this._stickyActiveMarker = { A: null, B: null };
        // Drop sticky human flags so Idle during Kickoff does not walk off the spot
        for (const p of this.players) {
            if (p) {
                p.humanControlled = false;
                p._humanInput = null;
            }
        }
        if (this._manualControlled) {
            this._manualControlled.A = null;
            this._manualControlled.B = null;
        }
        this._manualPendingReceiver = null;
        this._manualPassSwitchTicks = 0;
        this._manualCharge = null;
        this._manualCameraActive = false;
        const field = Utils.getFieldBounds();
        this.ball.owner = null;
        this.ball.x = field.centerX;
        this.ball.y = field.centerY;
        this.ball.z = 0;
        this.ball.vx = 0;
        this.ball.vy = 0;
        this.ball.vz = 0;
        this.ball.curveForce = 0;
        this.ball.isShot = false;
        this.ball.isThrowInFlight = false;

        const secondHalf = this.isSecondHalf();
        const isTeamLeft = (team) => {
            return secondHalf ? (team === 'B') : (team === 'A');
        };

        // Position players at their base positions clamped to their own half
        const buffer = Utils.scaleFieldX(1.5);
        const centerCircleRadius = Utils.scaleFieldX(10.9375) + Utils.scaleFieldX(0.5);

        for (const p of this.players) {
            if (p.isSentOff) continue;
            // Clear residual celebration / set-piece motion
            p.vx = 0;
            p.vy = 0;
            p.vz = 0;
            p._currentSpeed = 0;
            p.z = 0;
            p.actionTimer = 0;
            p.isSliding = false;
            p.isWalkingToSetPiece = false;
            p.setPieceTarget = null;
            if (p.role === 'GK') {
                p.x = getGoalkeeperBaseX(this, p.team);
                p.y = field.centerY;
            } else {
                if (isTeamLeft(p.team)) {
                    p.x = Math.min(p.baseX, field.centerX - buffer);
                } else {
                    p.x = Math.max(p.baseX, field.centerX + buffer);
                }
                p.y = p.baseY;

                // Defending team players must stay outside the center circle
                if (p.team !== this.kickoffTeam) {
                    const dx = p.x - field.centerX;
                    const dy = p.y - field.centerY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < centerCircleRadius) {
                        const angle = Math.atan2(dy, dx);
                        p.x = field.centerX + centerCircleRadius * Math.cos(angle);
                        p.y = field.centerY + centerCircleRadius * Math.sin(angle);
                    }
                }
            }
            const facesRight = isTeamLeft(p.team);
            p.orientation = facesRight ? 2 : 6; // Face inside
            // Wait freezes feet until open play (Idle would repath to formation)
            p.fsm.changeState(p.role === 'GK' ? PlayerStates.Goalkeeper : PlayerStates.Wait);
        }

        // Setup kickoff ball holder
        const kickoffSquad = this.getTeam(this.kickoffTeam);
        const kickoffTeamPlayers = kickoffSquad
            ? kickoffSquad.getOutfieldPlayers()
            : this.players.filter(p => p.team === this.kickoffTeam && p.role !== 'GK' && !p.isSentOff);

        const kickOffLeft = isTeamLeft(this.kickoffTeam);
        const supportOffset = kickOffLeft ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5);
        // Taker stands slightly on own half so the ball stays on the center mark
        const takerBack = kickOffLeft ? -Utils.scaleFieldX(0.55) : Utils.scaleFieldX(0.55);

        // Select up to 2 players from the kicking team to be at/near center for kick-off.
        // Prefer strikers/attackers, but fall back to any available outfield players.
        // This ensures 2 players when the team has them (even after some sent offs).
        let centerPlayers = kickoffTeamPlayers.filter(p => p.role && (p.role.includes('S') || p.role.includes('F') || p.role.includes('A') || p.role.includes('ST')));
        if (centerPlayers.length < 2) {
            centerPlayers = kickoffTeamPlayers.slice();
        }

        const facesRight = kickOffLeft;
        const takerOrient = facesRight ? 2 : 6;
        const supportOrient = takerOrient;

        if (centerPlayers.length >= 2) {
            const taker = centerPlayers[0];
            const support = centerPlayers[1];
            const takerX = field.centerX + takerBack;
            const takerY = field.centerY;
            const supportX = field.centerX + supportOffset;
            const supportY = field.centerY + Utils.scaleFieldY(5.0);

            taker.x = takerX;
            taker.y = takerY;
            support.x = supportX;
            support.y = supportY;
            taker.orientation = takerOrient;
            support.orientation = supportOrient;
            taker.fsm.changeState(PlayerStates.Wait);
            support.fsm.changeState(PlayerStates.Wait);

            this.ball.owner = taker;
            this.ball.x = field.centerX;
            this.ball.y = field.centerY;
            this.ball.z = 0;
            this.ball.vx = 0;
            this.ball.vy = 0;
            this.ball.vz = 0;

            this._kickoffPins = {
                taker,
                support,
                takerX,
                takerY,
                supportX,
                supportY,
                takerOrient,
                supportOrient,
                ballX: field.centerX,
                ballY: field.centerY
            };
        } else if (centerPlayers.length > 0) {
            const taker = centerPlayers[0];
            const takerX = field.centerX + takerBack;
            const takerY = field.centerY;
            taker.x = takerX;
            taker.y = takerY;
            taker.orientation = takerOrient;
            taker.fsm.changeState(PlayerStates.Wait);

            this.ball.owner = taker;
            this.ball.x = field.centerX;
            this.ball.y = field.centerY;
            this.ball.z = 0;
            this.ball.vx = 0;
            this.ball.vy = 0;
            this.ball.vz = 0;

            this._kickoffPins = {
                taker,
                support: null,
                takerX,
                takerY,
                supportX: 0,
                supportY: 0,
                takerOrient,
                supportOrient: takerOrient,
                ballX: field.centerX,
                ballY: field.centerY
            };
        }

        this.snapCameraToKickoff();
    }

    // Internal helper used by set-piece state executes (avoids dupe freeze code)
    _freezeBallStatic() {
        if (!this.ball) return;
        this.ball.vx = 0;
        this.ball.vy = 0;
        this.ball.vz = 0;
        this.ball.z = 0;
    }

    updateAll() {
        if (!this.active) return;

        const prevRandom = Math.random;
        try {
            Math.random = this.seededRandom || prevRandom;

            this.currentFrameCount++;
            if (this.ball && this.ball.owner) {
                this.registerPossessionChange(this.ball.owner);
            }

            if (!Settings.HEADLESS && typeof document !== 'undefined' && !this._fastForwardReplay && !this._playbackRecordingStopped) {
                this.playbackElapsedTicks++;
                const stepDt = this.getReplayStepDt();
                this.playbackElapsedSec = this.playbackElapsedTicks * stepDt;
                if (this.playbackElapsedTicks > this.playbackMaxElapsedTicks) {
                    this.playbackMaxElapsedTicks = this.playbackElapsedTicks;
                    this.playbackMaxElapsedSec = this.playbackElapsedTicks * stepDt;
                }
                this.updateScrubberUI();
            }

            this.cacheOffsideLines();
            this.updateGlobalPos();
            this.update();

            for (const script of this.scripts) {
                script.update();
            }

            if (this.pitch) {
                this.pitch.updateGlobalPos();
                this.pitch.update();
                for (const script of this.pitch.scripts) {
                    script.update();
                }
            }

            // Team bookkeeping (closest-to-ball, control) before player FSMs
            if (this.teamA) {
                this.teamA.updateGlobalPos();
                this.teamA.update();
                for (const script of this.teamA.scripts) {
                    script.update();
                }
            }
            if (this.teamB) {
                this.teamB.updateGlobalPos();
                this.teamB.update();
                for (const script of this.teamB.scripts) {
                    script.update();
                }
            }

            for (const player of this.players) {
                player.updateGlobalPos();
                player.update();
                for (const script of player.scripts) {
                    script.update();
                }
            }

            if (this.ball) {
                this.ball.updateGlobalPos();
                this.ball.update();
                // Kickoff: re-pin after ball.syncToOwner so carry offset cannot
                // pull the ball/taker off the center mark before the AI pass.
                if (this.setPieceType === 'kickoff') {
                    this.pinKickoffSpots();
                }
                // Solid posts / crossbar / exterior net before shot-block & OOB
                // (valid pitch→mouth path stays open so goals still register).
                this.resolveGoalFrameCollisions();
                tryBallShotBlocking(this);
                // A.6: free ball vs wall bodies (product block / deflection)
                if (this.freekickWallPlayers && this.freekickWallPlayers.length) {
                    tryBallWallCollisions(this.ball, this.freekickWallPlayers);
                }
                for (const script of this.ball.scripts) {
                    script.update();
                }
            }

            // Flush delayed AI messages after this logic tick's state updates (deterministic)
            if (this.msgDispatcher) {
                this.msgDispatcher.advanceTick();
            }

            // A.6: tick wall-player jump arcs (z-height; fixed LOGIC_DT) then prune finished walls
            if (this.freekickWallPlayers && this.freekickWallPlayers.length) {
                updateWallJumps(this.freekickWallPlayers, Time.deltaTime);
                pruneFreekickWall(this);
            }
        } finally {
            Math.random = prevRandom;
        }
    }

    registerPossessionChange(newOwner) {
        if (!newOwner) return;
        const prevOwnerTeam = this._lastPossessorTeam;
        const newOwnerTeam = newOwner.team;

        if (prevOwnerTeam && prevOwnerTeam !== newOwnerTeam) {
            // Turnover!
            if (newOwnerTeam === 'A') {
                this.lastTurnoverFrameA = this.currentFrameCount;
            } else {
                this.lastTurnoverFrameB = this.currentFrameCount;
            }
        }
        this._lastPossessorTeam = newOwnerTeam;
    }

    update() {
        if (!this.ball) return;
        const dt = Time.deltaTime;

        if (!Settings.HEADLESS) {
            const isStatic = Settings.camera && Settings.camera.type === 'static';
            const matchStateName = this.fsm ? this.fsm.getNameOfCurrentState() : 'play';
            if (matchStateName === 'goal' && this.goalScoredTeam) {
                this._manualCameraActive = false;
                let avgX = 0, avgY = 0, count = 0;
                for (const p of this.players) {
                    if (p.team === this.goalScoredTeam && !p.isSentOff) {
                        avgX += p.x;
                        avgY += p.y;
                        count++;
                    }
                }
                if (count > 0) {
                    avgX /= count;
                    avgY /= count;
                } else {
                    avgX = this.ball.x;
                    avgY = this.ball.y;
                }

                const centerScreen = Utils.toScreen(avgX, avgY, 0);
                const timePassed = 5.0 - this.stateTimer;
                const angle = timePassed * 1.5;
                const radius = 50 + Math.sin(timePassed * 2.0) * 20;

                Settings.app.camX = Settings.app.canvas.width / 2 - (centerScreen.x + Math.cos(angle) * radius);
                Settings.app.camY = Settings.app.canvas.height / 2 - (centerScreen.y + Math.sin(angle) * radius);
            } else if (matchStateName === 'kickoff' || this.setPieceType === 'kickoff') {
                // Always re-center on the ball / center spot — never keep celebration orbit
                // or a stale manual-follow lock from open play.
                this._manualCameraActive = false;
                if (isStatic) {
                    Settings.app.camX = 0;
                    Settings.app.camY = 0;
                } else {
                    const ballScreen = Utils.toScreen(this.ball.x, this.ball.y, this.ball.z || 0);
                    Settings.app.camX = Settings.app.canvas.width / 2 - ballScreen.x;
                    Settings.app.camY = Settings.app.canvas.height / 2 - ballScreen.y;
                }
            } else if (matchStateName === 'fulltime') {
                let winningTeam = null;
                if (this.scoreA > this.scoreB) {
                    winningTeam = 'A';
                } else if (this.scoreB > this.scoreA) {
                    winningTeam = 'B';
                }

                if (winningTeam) {
                    let avgX = 0, avgY = 0, count = 0;
                    for (const p of this.players) {
                        if (p.team === winningTeam && !p.isSentOff) {
                            avgX += p.x;
                            avgY += p.y;
                            count++;
                        }
                    }
                    if (count > 0) {
                        avgX /= count;
                        avgY /= count;
                    } else {
                        avgX = this.ball.x;
                        avgY = this.ball.y;
                    }

                    const centerScreen = Utils.toScreen(avgX, avgY, 0);
                    const logicalSeconds = this.currentFrameCount * 0.05;
                    const angle = logicalSeconds;
                    const radius = 50 + Math.sin(logicalSeconds * 1.5) * 20;

                    Settings.app.camX = Settings.app.canvas.width / 2 - (centerScreen.x + Math.cos(angle) * radius);
                    Settings.app.camY = Settings.app.canvas.height / 2 - (centerScreen.y + Math.sin(angle) * radius);
                } else if (isStatic) {
                    Settings.app.camX = 0;
                    Settings.app.camY = 0;
                } else {
                    const ballScreen = Utils.toScreen(this.ball.x, this.ball.y, this.ball.z);
                    Settings.app.camX = Settings.app.canvas.width / 2 - ballScreen.x;
                    Settings.app.camY = Settings.app.canvas.height / 2 - ballScreen.y;
                }
            } else if (isStatic) {
                Settings.app.camX = 0;
                Settings.app.camY = 0;
            } else if (this._manualCameraActive) {
                // Stage 1.5 soft follow already wrote camX/camY in tickManualControl
            } else {
                const ballScreen = Utils.toScreen(this.ball.x, this.ball.y, this.ball.z);
                Settings.app.camX = Settings.app.canvas.width / 2 - ballScreen.x;
                Settings.app.camY = Settings.app.canvas.height / 2 - ballScreen.y;
            }
        }

        // Track last touch player
        if (this.ball.owner) {
            this.lastTouchPlayer = this.ball.owner;
        }

        // Delegate match flow to FSM (states are singletons; all transitions via changeState for enter/exit)
        if (this.fsm) {
            this.fsm.update();
        }
        this.checkForSubstitutions();

        if (!this._fastForwardReplay) {
            this.updateHTMLStats();
        }
    }

    shouldPreserveAIState(p) {
        if (p.role === 'GK') return true;
        // Human avatar: assignment is owned by manual_control (not AI force)
        if (shouldSkipAIAssign(p)) return true;
        const stateName = p.fsm.getNameOfCurrentState();
        if (stateName === 'Pass' || stateName === 'Shoot' || stateName === 'Header') return true;
        // Message-driven states must not be overwritten by chaser assignment
        if (stateName === 'Receive' || stateName === 'SupportAttacker') return true;
        // GoHome / ReturnHome share the same state object (name remains 'GoHome')
        if (stateName === 'GoHome' || stateName === 'ReturnHome') return true;
        // Hold Wait through kickoff countdown and until set-piece bookkeeping clears
        if (stateName === 'Wait' && (this.matchState !== 'play' || this.setPieceType)) return true;
        if (p.actionTimer > 0 || p.kickTimer > 0) return true;
        if (isGkProtected(p)) return true;
        return false;
    }

    /**
     * Sticky nearest outfielder for active-player highlight.
     * Keeps previous pick unless a challenger is clearly closer, and drops when far.
     * @param {'A'|'B'} teamKey
     * @param {{ x: number, y: number }} ball
     * @returns {object|null}
     */
    pickStickyActiveMarker(teamKey, ball) {
        if (!ball || !this.players) {
            if (this._stickyActiveMarker) this._stickyActiveMarker[teamKey] = null;
            return null;
        }
        if (!this._stickyActiveMarker) this._stickyActiveMarker = { A: null, B: null };

        const margin = (Settings.AI && Settings.AI.ACTIVE_MARKER_STICKINESS != null)
            ? Settings.AI.ACTIVE_MARKER_STICKINESS
            : 1.85;
        const maxDist = (Settings.AI && Settings.AI.ACTIVE_MARKER_MAX_DIST != null)
            ? Settings.AI.ACTIVE_MARKER_MAX_DIST
            : 14;

        let nearest = null;
        let nearestD = Infinity;
        for (const p of this.players) {
            if (!p || p.isSentOff || p.role === 'GK' || p.team !== teamKey) continue;
            const d = Math.sqrt(Math.pow(p.x - ball.x, 2) + Math.pow(p.y - ball.y, 2));
            if (d < nearestD) {
                nearestD = d;
                nearest = p;
            }
        }
        if (!nearest || nearestD > maxDist) {
            this._stickyActiveMarker[teamKey] = null;
            return null;
        }

        const prev = this._stickyActiveMarker[teamKey];
        if (prev && !prev.isSentOff && prev.team === teamKey && prev.role !== 'GK') {
            const prevD = Math.sqrt(Math.pow(prev.x - ball.x, 2) + Math.pow(prev.y - ball.y, 2));
            if (prevD <= maxDist && prevD <= nearestD + margin) {
                return prev;
            }
        }
        this._stickyActiveMarker[teamKey] = nearest;
        return nearest;
    }

    /**
     * Update isActivePlayer rings: owner + sticky presser, or sticky nearest per team on loose ball.
     * Far "nearest" on the opposite team is suppressed so markers don't hop across the pitch.
     */
    updateActivePlayerMarkers() {
        if (!this.players) return;
        for (const p of this.players) {
            p.isActivePlayer = false;
        }
        if (!this.ball) {
            this._stickyActiveMarker = { A: null, B: null };
            return;
        }

        if (this.ball.owner && !this.ball.owner.isSentOff) {
            this.ball.owner.isActivePlayer = true;
            // Clear sticky on owner's team; sticky presser on the other
            const own = this.ball.owner.team;
            const opp = own === 'A' ? 'B' : 'A';
            if (this._stickyActiveMarker) this._stickyActiveMarker[own] = null;
            const presser = this.pickStickyActiveMarker(opp, this.ball);
            if (presser) presser.isActivePlayer = true;
            return;
        }

        // Loose ball: sticky nearest per side, only if within max dist
        const a = this.pickStickyActiveMarker('A', this.ball);
        const b = this.pickStickyActiveMarker('B', this.ball);
        if (a) a.isActivePlayer = true;
        if (b) b.isActivePlayer = true;
    }

    canBecomeChaser(p) {
        if (!p || p.isSentOff || p.role === 'GK') return false;
        // Human player is not an AI presser — teammates still chase
        if (shouldSkipAIAssign(p)) return false;
        // After a kick: do not chase your own pass (manual + AI).
        // Covers claim lock, dedicated suppress timer, and in-flight ReceiveBall.
        if (this.ball && this.ball.owner === null && this.ball.lastKicker === p) {
            if (p.passFollowSuppress > 0 || p.kickerClaimCooldown > 0) {
                return false;
            }
            const team = this.getTeam(p.team);
            if (team && team.receivingPlayer && team.receivingPlayer !== p) {
                return false;
            }
        }
        return !this.shouldPreserveAIState(p);
    }

    /**
     * Mirror Team sticky pressers for legacy tests that read/write `_stickyPrimaryChasers`.
     */
    _syncStickyFromTeams() {
        this._stickyPrimaryChasers = {
            A: this.teamA ? this.teamA.stickyPrimaryChaser : null,
            B: this.teamB ? this.teamB.stickyPrimaryChaser : null
        };
    }

    _applyStickyToTeams() {
        if (this.teamA && this._stickyPrimaryChasers) {
            this.teamA.stickyPrimaryChaser = this._stickyPrimaryChasers.A || null;
        }
        if (this.teamB && this._stickyPrimaryChasers) {
            this.teamB.stickyPrimaryChaser = this._stickyPrimaryChasers.B || null;
        }
    }

    /**
     * Keep Team controlling / closest roles in sync with the ball before AI assign.
     */
    syncTeamKeyPlayers() {
        if (this.teamA) this.teamA.syncRolesFromBall(this.ball);
        if (this.teamB) this.teamB.syncRolesFromBall(this.ball);
    }

    candidateScore(entry) {
        const { Team } = require('../../core/entities/team.js');
        return Team.candidateScore(entry);
    }

    /**
     * Facade: sticky primary presser lives on Team.
     * @param {string} teamKey - 'A' | 'B'
     * @param {Array} rankedCandidates
     * @param {{ carrier?: object }|null} [context]
     */
    pickPrimaryChaser(teamKey, rankedCandidates, context = null) {
        this._applyStickyToTeams();
        const team = this.getTeam(teamKey);
        if (!team) {
            // Bare simulator without Team nodes (should not happen after bootstrap)
            return rankedCandidates && rankedCandidates[0] ? rankedCandidates[0].player : null;
        }
        const pick = team.pickPrimaryChaser(rankedCandidates, context);
        this._syncStickyFromTeams();
        return pick;
    }

    /**
     * Active ChaseBall candidates — Team owns press/loose primary + stickiness.
     * @returns {Set<object>}
     */
    getActiveChasers() {
        const chasers = new Set();
        if (!this.ball) return chasers;

        this._applyStickyToTeams();
        this.syncTeamKeyPlayers();

        if (this.ball.owner && this.ball.owner.role === 'GK') {
            if (this.teamA) this.teamA.clearPrimaryPresser();
            if (this.teamB) this.teamB.clearPrimaryPresser();
            this._syncStickyFromTeams();
            return chasers;
        }

        const canChase = (p) => this.canBecomeChaser(p);
        const pressDist = Settings.AI.PRESS_SECOND_CHASER_DIST;

        if (this.ball.owner) {
            const carrier = this.ball.owner;
            const oppTeam = this.getTeam(carrier.team === 'A' ? 'B' : 'A');
            // Attacking team keeps control roles; defending team supplies pressers
            if (oppTeam) {
                for (const p of oppTeam.getPressChasers(carrier, canChase)) {
                    chasers.add(p);
                }
            }
            this._syncStickyFromTeams();
            return chasers;
        }

        // Loose ball: each Team contributes sticky nearest + proximity
        for (const team of [this.teamA, this.teamB]) {
            if (!team) continue;
            for (const p of team.getLooseBallChasers(this.ball, canChase)) {
                chasers.add(p);
            }
        }

        // Extra global secondaries by pure distance (cross-team packing)
        const sorted = this.players
            .filter(p => canChase(p))
            .map(p => ({
                player: p,
                dist: Math.sqrt(Math.pow(p.x - this.ball.x, 2) + Math.pow(p.y - this.ball.y, 2))
            }))
            .sort((a, b) => a.dist - b.dist);

        if (sorted[1] && sorted[1].dist < pressDist && !chasers.has(sorted[1].player)) {
            chasers.add(sorted[1].player);
        }
        if (sorted[2] && sorted[2].dist < pressDist * 0.75 && !chasers.has(sorted[2].player)) {
            chasers.add(sorted[2].player);
        }

        this._syncStickyFromTeams();
        return chasers;
    }

    cacheOffsideLines() {
        const field = Utils.getFieldBounds();

        const getLine = (attackingTeamKey) => {
            const oppTeam = attackingTeamKey === 'A' ? this.teamB : this.teamA;
            if (!oppTeam) return attackingTeamKey === 'A' ? field.width : 0;

            const defenders = oppTeam.members();
            if (defenders.length < 2) {
                const attacksRight = attacksRightGoal(this, attackingTeamKey);
                return attacksRight ? field.width : 0;
            }

            const attacksRight = attacksRightGoal(this, attackingTeamKey);
            if (attacksRight) {
                defenders.sort((a, b) => b.x - a.x);
            } else {
                defenders.sort((a, b) => a.x - b.x);
            }
            return defenders[1].x;
        };

        this.offsideLineA = getLine('A');
        this.offsideLineB = getLine('B');
    }

    updatePlayerAIStates() {
        if (this.ball.owner && this.ball.owner.isSentOff) {
            this.ball.owner = null;
        }

        // Team roles first so support/receive/control are authoritative this tick
        this.syncTeamKeyPlayers();

        const chasers = this.getActiveChasers();

        // Safety: loose ball but no player is actively chasing — force nearest eligible per team.
        const ball = this.ball;
        const ballIsLoose = ball && ball.owner === null;
        if (ballIsLoose) {
            // Hysteresis: keep anyone already chasing until clearly out of the loose zone
            // (stops rapid ChaseBall ↔ Idle thrashing when two players straddle proximity).
            const proximity = (Settings.AI && Settings.AI.LOOSE_BALL_PROXIMITY_RANGE) || 1.2;
            const releaseMult = (Settings.AI && Settings.AI.LOOSE_CHASE_RELEASE_MULT != null)
                ? Settings.AI.LOOSE_CHASE_RELEASE_MULT
                : 1.85;
            const releaseDist = Math.max(
                proximity * releaseMult,
                ((Settings.AI && Settings.AI.PRESS_SECOND_CHASER_DIST) || 7) * 0.9
            );
            for (const p of this.players) {
                if (!p || p.isSentOff || !this.canBecomeChaser(p)) continue;
                if (!p.fsm || !p.fsm.isInState(PlayerStates.ChaseBall)) continue;
                if (chasers.has(p)) continue;
                const d = Math.sqrt(Math.pow(p.x - ball.x, 2) + Math.pow(p.y - ball.y, 2));
                if (d <= releaseDist) {
                    chasers.add(p);
                }
            }

            const activeChasers = [...chasers].filter(p => p.fsm.isInState(PlayerStates.ChaseBall));
            if (activeChasers.length === 0) {
                for (const team of [this.teamA, this.teamB]) {
                    if (!team) continue;
                    const closest = team.playerClosestToBall;
                    if (closest && this.canBecomeChaser(closest)) {
                        chasers.add(closest);
                    } else {
                        // Fallback scan
                        let best = null;
                        let bestD = Infinity;
                        for (const p of team.players) {
                            if (!this.canBecomeChaser(p)) continue;
                            const d = Math.sqrt(Math.pow(p.x - ball.x, 2) + Math.pow(p.y - ball.y, 2));
                            if (d < bestD) {
                                bestD = d;
                                best = p;
                            }
                        }
                        if (best) chasers.add(best);
                    }
                }
            }
        }

        for (const p of this.players) {
            if (p.isSentOff) continue;
            // Manual avatar: state + movement owned by manual_control / human gates
            if (shouldSkipAIAssign(p)) continue;
            if (this.shouldPreserveAIState(p)) continue;

            // Controller (Team role or live owner) dribbles
            const team = this.getTeam(p.team);
            const isController = (team && team.isControllingPlayer(p)) || this.ball.owner === p;

            if (isController && this.ball.owner === p) {
                if (!p.fsm.isInState(PlayerStates.Dribble)) {
                    p.fsm.changeState(PlayerStates.Dribble);
                }
            } else if (chasers.has(p)) {
                if (!p.fsm.isInState(PlayerStates.ChaseBall)) {
                    p.fsm.changeState(PlayerStates.ChaseBall);
                }
            } else if (!p.fsm.isInState(PlayerStates.Idle)) {
                // Keep SupportAttacker/Receive via shouldPreserveAIState
                p.fsm.changeState(PlayerStates.Idle);
            }
        }
    }

    /**
     * Fixed left/right goals from Pitch (ensureGoals). Fallback create if pitch missing.
     * @returns {{ left: import('../../core/entities/goal.js').Goal, right: import('../../core/entities/goal.js').Goal }}
     */
    getGoals() {
        if (this.pitch && typeof this.pitch.ensureGoals === 'function') {
            return this.pitch.ensureGoals();
        }
        const { Goal } = require('../../core/entities/goal.js');
        return Goal.createPair(Utils.getFieldBounds());
    }

    checkBallCollisions() {
        const field = Utils.getFieldBounds();

        // Throw-in flight grace: release is on the touchline. Clearing the flag on
        // the first barely-in sample lets a shallow throw re-trigger OOB and restart
        // the set piece. Require real depth before arming boundaries; only a true
        // deep exit falls through to a new throw-in while still in flight.
        if (this.ball && this.ball.isThrowInFlight) {
            const inMargin = Math.max(2.5, field.multiplier * 2.5);
            const farOut = Math.max(3.0, field.multiplier * 3.0);
            const speed = Math.hypot(this.ball.vx || 0, this.ball.vy || 0);
            const oobNow =
                this.ball.x < 0
                || this.ball.x > field.width
                || this.ball.y < 0
                || this.ball.y > field.height;
            const clearlyIn =
                this.ball.x >= inMargin
                && this.ball.x <= field.width - inMargin
                && this.ball.y >= inMargin
                && this.ball.y <= field.height - inMargin;
            if (clearlyIn) {
                this.ball.isThrowInFlight = false;
            } else {
                const farOutside =
                    this.ball.x < -farOut
                    || this.ball.x > field.width + farOut
                    || this.ball.y < -farOut
                    || this.ball.y > field.height + farOut;
                // Stuck just outside with residual speed gone: end grace and restart
                // rather than soft-locking in the near-line strip forever.
                if (farOutside || (oobNow && speed < 0.35)) {
                    this.ball.isThrowInFlight = false; // fall through to OOB restart
                } else {
                    return; // Near-line grace (inside strip or just outside)
                }
            }
        }

        const { left: leftGoal, right: rightGoal } = this.getGoals();
        const secondHalf = this.isSecondHalf();

        if (this.ball) {
            const isOOB = this.ball.x < 0 || this.ball.x > field.width || this.ball.y < 0 || this.ball.y > field.height;
            const isGoalL = this.ball.x < leftGoal.lineX || leftGoal.isGoalEvent(this.ball);
            const isGoalR = this.ball.x > rightGoal.lineX || rightGoal.isGoalEvent(this.ball);
            if (isOOB || isGoalL || isGoalR) {
                this.ball.offsideReceiver = null;
                this.ball.offsideLineX = null;
                this.ball.passFromX = null;
                this.ball.passFromY = null;
            }
        }

        // Left goal line / mouth (segment scored test + set-piece OOB)
        if (this.ball.x < leftGoal.lineX || leftGoal.isGoalEvent(this.ball)) {
            if (leftGoal.isGoalEvent(this.ball)) {
                // Indirect free kick: goal only if another player touched first
                if (this.ball.ifkActive) {
                    this._resolveInvalidIfkGoal('left', secondHalf, field);
                    return;
                }
                this._pendingAdvantage = null;
                const scoringTeam = leftGoal.scoringTeam(secondHalf);
                if (scoringTeam === 'A') this.scoreA++; else this.scoreB++;

                // C.3 Transition goal check
                const lastTurnover = scoringTeam === 'A' ? this.lastTurnoverFrameA : this.lastTurnoverFrameB;
                if (this.currentFrameCount - lastTurnover <= 200) {
                    if (scoringTeam === 'A') this.transitionGoalsA++; else this.transitionGoalsB++;
                    if (this._telemetry && typeof this._telemetry.onTransitionGoal === 'function') {
                        this._telemetry.onTransitionGoal({ team: scoringTeam });
                    }
                }

                this.goalScoredTeam = scoringTeam;
                this.fsm.changeState(MatchStates.Goal);
                return;
            }
            if (this.ball.x < leftGoal.lineX) {
                SoundDB.play('whistle');
                this._pendingAdvantage = null;
                this.ball.owner = null;
                this.ball.vx = 0; this.ball.vy = 0; this.ball.vz = 0;
                this.ball.ifkActive = false;
                this.ball.ifkTaker = null;

                const defendingTeam = leftGoal.defendingTeam(secondHalf);
                const attackingTeam = defendingTeam === 'A' ? 'B' : 'A';
                const lastTouchTeam = this.lastTouchPlayer ? this.lastTouchPlayer.team : attackingTeam;

                if (lastTouchTeam === defendingTeam) {
                    this.setPieceType = 'corner';
                    this.setPieceSide = 'left';
                    this.setPieceKickingTeam = attackingTeam;
                    this.setPieceCornerY = (this.ball.y < field.centerY) ? 0 : field.height;
                    this.setupSetPiecePositions('corner', 'left', attackingTeam, this.setPieceCornerY);
                    this.fsm.changeState(MatchStates.Corner);
                } else {
                    this.setPieceType = 'goalkick';
                    this.setPieceSide = 'left';
                    this.setPieceKickingTeam = defendingTeam;
                    this.setupSetPiecePositions('goalkick', 'left', defendingTeam);
                    this.fsm.changeState(MatchStates.Goalkick);
                }
                return;
            }
        }

        // Right goal line / mouth
        if (this.ball.x > rightGoal.lineX || rightGoal.isGoalEvent(this.ball)) {
            if (rightGoal.isGoalEvent(this.ball)) {
                if (this.ball.ifkActive) {
                    this._resolveInvalidIfkGoal('right', secondHalf, field);
                    return;
                }
                this._pendingAdvantage = null;
                const scoringTeam = rightGoal.scoringTeam(secondHalf);
                if (scoringTeam === 'A') this.scoreA++; else this.scoreB++;

                // C.3 Transition goal check
                const lastTurnover = scoringTeam === 'A' ? this.lastTurnoverFrameA : this.lastTurnoverFrameB;
                if (this.currentFrameCount - lastTurnover <= 200) {
                    if (scoringTeam === 'A') this.transitionGoalsA++; else this.transitionGoalsB++;
                    if (this._telemetry && typeof this._telemetry.onTransitionGoal === 'function') {
                        this._telemetry.onTransitionGoal({ team: scoringTeam });
                    }
                }

                this.goalScoredTeam = scoringTeam;
                this.fsm.changeState(MatchStates.Goal);
                return;
            }
            if (this.ball.x > rightGoal.lineX) {
                SoundDB.play('whistle');
                this._pendingAdvantage = null;
                this.ball.owner = null;
                this.ball.vx = 0; this.ball.vy = 0; this.ball.vz = 0;
                this.ball.ifkActive = false;
                this.ball.ifkTaker = null;

                const defendingTeam = rightGoal.defendingTeam(secondHalf);
                const attackingTeam = defendingTeam === 'A' ? 'B' : 'A';
                const lastTouchTeam = this.lastTouchPlayer ? this.lastTouchPlayer.team : attackingTeam;

                if (lastTouchTeam === defendingTeam) {
                    this.setPieceType = 'corner';
                    this.setPieceSide = 'right';
                    this.setPieceKickingTeam = attackingTeam;
                    this.setPieceCornerY = (this.ball.y < field.centerY) ? 0 : field.height;
                    this.setupSetPiecePositions('corner', 'right', attackingTeam, this.setPieceCornerY);
                    this.fsm.changeState(MatchStates.Corner);
                } else {
                    this.setPieceType = 'goalkick';
                    this.setPieceSide = 'right';
                    this.setPieceKickingTeam = defendingTeam;
                    this.setupSetPiecePositions('goalkick', 'right', defendingTeam);
                    this.fsm.changeState(MatchStates.Goalkick);
                }
                return;
            }
        }

        // Sidelines (y-axis)
        if (this.ball.y < 0 || this.ball.y > field.height) {
            SoundDB.play('whistle');
            const margin = field.multiplier;
            // Place slightly further in than the old 0.2×margin (too tight vs carry
            // offset + kick noise). Still on the touchline strip for the taker.
            const touchInset = Math.max(margin * 0.45, 0.55);
            const outX = Math.max(margin, Math.min(field.width - margin, this.ball.x));
            const outY = this.ball.y < 0 ? touchInset : field.height - touchInset;

            // Find throw-in taker: nearest player of the opposite team that did not touch it
            const throwingTeam = (this.lastTouchPlayer && this.lastTouchPlayer.team === 'A') ? 'B' : 'A';
            let nearestTaker = null;
            let minDist = Infinity;

            for (const p of this.players) {
                if (p.team === throwingTeam && p.role !== 'GK' && !p.isSentOff) {
                    const d = Math.sqrt(Math.pow(p.x - outX, 2) + Math.pow(p.y - outY, 2));
                    if (d < minDist) {
                        minDist = d;
                        nearestTaker = p;
                    }
                }
            }

            this.ball.owner = null;
            // Must freeze like corner/goalkick OOB: same-frame ball.update() would
            // otherwise integrate residual OOB velocity, drift past the touchline
            // inset, freeze still out-of-bounds, and re-trigger throw-in on resume.
            this.ball.vx = 0;
            this.ball.vy = 0;
            this.ball.vz = 0;
            this.ball.z = 0;
            this.ball.isThrowInFlight = false;
            this.ball.curveForce = 0;
            if (nearestTaker) {
                nearestTaker.setPieceTarget = { x: outX, y: outY };
                nearestTaker.isWalkingToSetPiece = true;
                this.ball.x = outX;
                this.ball.y = outY;
                // Fixed throw spot for countdown pin + release origin (no carry drift).
                this._setPieceBallSpot = { x: outX, y: outY };
                this._throwInExtraWait = 0;
                // Do NOT assign owner yet. Ball stays at the sideline spot.
                // The player walks to it. Owner will be set in resume when throw happens.
                this.throwInTaker = nearestTaker;

                // Select 2 nearest teammates of the taker (excluding GK and sent-off)
                const teammates = this.players.filter(p => p.team === throwingTeam && p !== nearestTaker && p.role !== 'GK' && !p.isSentOff);
                teammates.sort((a, b) => {
                    const da = Math.pow(a.x - outX, 2) + Math.pow(a.y - outY, 2);
                    const db = Math.pow(b.x - outX, 2) + Math.pow(b.y - outY, 2);
                    return da - db;
                });

                const teammate1 = teammates[0];
                const teammate2 = teammates[1];
                this.throwInReceivers = [];

                // Position targets inside the field
                const secondHalf = this.isSecondHalf();
                const isTeamLeft = (team) => {
                    return secondHalf ? (team === 'B') : (team === 'A');
                };
                const isTopLine = (outY < field.centerY);
                const shiftY = isTopLine ? Utils.scaleFieldY(8) : -Utils.scaleFieldY(8);
                const shiftY2 = isTopLine ? Utils.scaleFieldY(10) : -Utils.scaleFieldY(10);

                const clampX = (val) => Math.max(Utils.scaleFieldX(3), Math.min(field.width - Utils.scaleFieldX(3), val));
                const clampY = (val) => Math.max(Utils.scaleFieldY(3), Math.min(field.height - Utils.scaleFieldY(3), val));

                if (teammate1) {
                    const target1 = {
                        x: clampX(outX - Utils.scaleFieldX(5)),
                        y: clampY(outY + shiftY)
                    };
                    teammate1.setPieceTarget = target1;
                    teammate1.isWalkingToSetPiece = true;
                    this.throwInReceivers.push(teammate1);
                }

                if (teammate2) {
                    const target2 = {
                        x: clampX(outX + Utils.scaleFieldX(5)),
                        y: clampY(outY + shiftY2)
                    };
                    teammate2.setPieceTarget = target2;
                    teammate2.isWalkingToSetPiece = true;
                    this.throwInReceivers.push(teammate2);
                }

                // Select 2 nearest opponents to mark them
                const opponents = this.players.filter(p => p.team !== throwingTeam && p.role !== 'GK' && !p.isSentOff);
                opponents.sort((a, b) => {
                    const da = Math.pow(a.x - outX, 2) + Math.pow(a.y - outY, 2);
                    const db = Math.pow(b.x - outX, 2) + Math.pow(b.y - outY, 2);
                    return da - db;
                });

                if (teammate1 && opponents[0]) {
                    const opp1 = opponents[0];
                    opp1.setPieceTarget = {
                        x: clampX(teammate1.setPieceTarget.x + (isTeamLeft(opp1.team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
                        y: teammate1.setPieceTarget.y
                    };
                    opp1.isWalkingToSetPiece = true;
                }

                if (teammate2 && opponents[1]) {
                    const opp2 = opponents[1];
                    opp2.setPieceTarget = {
                        x: clampX(teammate2.setPieceTarget.x + (isTeamLeft(opp2.team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
                        y: teammate2.setPieceTarget.y
                    };
                    opp2.isWalkingToSetPiece = true;
                }

                // A.5: throw-in playbook biases receiver walk targets
                const throwPb = pickPlaybook('throwin');
                this.activePlaybook = throwPb;
                applyThrowInReceiverBias(this, throwPb, outX, outY);
                // Re-sync marker targets after receiver bias
                if (teammate1 && opponents[0] && teammate1.setPieceTarget) {
                    opponents[0].setPieceTarget = {
                        x: clampX(teammate1.setPieceTarget.x + (isTeamLeft(opponents[0].team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
                        y: teammate1.setPieceTarget.y
                    };
                }
                if (teammate2 && opponents[1] && teammate2.setPieceTarget) {
                    opponents[1].setPieceTarget = {
                        x: clampX(teammate2.setPieceTarget.x + (isTeamLeft(opponents[1].team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
                        y: teammate2.setPieceTarget.y
                    };
                }

                // Pause gameplay and setup throw-in set piece
                this.setPieceType = 'throwin';
                this.setPieceKickingTeam = throwingTeam;
                this.fsm.changeState(MatchStates.Throwin);
            } else {
                // Fallback
                this.ball.x = field.centerX;
                this.ball.y = field.centerY;
            }
        }
    }

    getFlagUrl(teamName) {
        return appUrl(`assets/flags/${teamName.toLowerCase().replace(/\s+/g, '_')}.svg`);
    }

    setFlagSrcIfChanged(imgEl, cacheKey, teamName) {
        if (!imgEl) return;
        const url = this.getFlagUrl(teamName);
        if (this._scoreboardCache[cacheKey] === url) return;
        this._scoreboardCache[cacheKey] = url;
        imgEl.src = url;
    }

    setTextIfChanged(el, cacheKey, text) {
        if (!el) return;
        const value = String(text);
        if (this._scoreboardCache[cacheKey] === value) return;
        this._scoreboardCache[cacheKey] = value;
        el.innerText = value;
    }

    updateHTMLStats() {
        if (Settings.HEADLESS) return;
        if (typeof document === 'undefined') return;

        const scoreAEl = document.getElementById('scoreA');
        const scoreBEl = document.getElementById('scoreB');
        const matchClockEl = document.getElementById('matchClock');
        const matchStateEl = document.getElementById('matchStateBadge');
        const displayA = document.getElementById('teamANameDisplay');
        const displayB = document.getElementById('teamBNameDisplay');
        const flagA = document.getElementById('flagA');
        const flagB = document.getElementById('flagB');

        const swapped = this.isScoreboardSwapped();
        const leftScore = swapped ? this.scoreB : this.scoreA;
        const rightScore = swapped ? this.scoreA : this.scoreB;

        if (swapped) {
            this.setTextIfChanged(displayA, 'displayA', this.teamBName);
            this.setTextIfChanged(displayB, 'displayB', this.teamAName);
            this.setFlagSrcIfChanged(flagA, 'flagA', this.teamBName);
            this.setFlagSrcIfChanged(flagB, 'flagB', this.teamAName);
        } else {
            this.setTextIfChanged(displayA, 'displayA', this.teamAName);
            this.setTextIfChanged(displayB, 'displayB', this.teamBName);
            this.setFlagSrcIfChanged(flagA, 'flagA', this.teamAName);
            this.setFlagSrcIfChanged(flagB, 'flagB', this.teamBName);
        }

        this.setTextIfChanged(scoreAEl, 'scoreBoardLeft', leftScore);
        this.setTextIfChanged(scoreBEl, 'scoreBoardRight', rightScore);

        if (matchClockEl) {
            const totalSecs = Math.floor(this.matchTimer);
            const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
            const secs = (totalSecs % 60).toString().padStart(2, '0');
            matchClockEl.innerText = `${mins}:${secs}`;
        }

        if (matchStateEl) {
            if (this.matchState === 'kickoff') {
                matchStateEl.innerText = "KICKOFF";
                matchStateEl.className = "badge bg-info";
            } else if (this.matchState === 'play') {
                const totalSecs = Math.floor(this.matchTimer);
                const halfStr = totalSecs < 2700 ? "1st Half" : "2nd Half";
                matchStateEl.innerText = halfStr;
                matchStateEl.className = "badge bg-success";
            } else if (this.matchState === 'goal') {
                matchStateEl.innerText = "GOAL!";
                matchStateEl.className = "badge bg-danger animate-pulse";
            } else if (this.matchState === 'halftime') {
                matchStateEl.innerText = "HALF TIME";
                matchStateEl.className = "badge bg-warning text-dark";
            } else if (this.matchState === 'fulltime') {
                matchStateEl.innerText = "FULL TIME";
                matchStateEl.className = "badge bg-secondary";
            } else if (this.matchState === 'corner') {
                matchStateEl.innerText = "CORNER KICK";
                matchStateEl.className = "badge bg-info";
            } else if (this.matchState === 'goalkick') {
                matchStateEl.innerText = "GOAL KICK";
                matchStateEl.className = "badge bg-info";
            } else if (this.matchState === 'foul') {
                matchStateEl.innerText = "FOUL";
                matchStateEl.className = "badge bg-warning text-dark animate-pulse";
            } else if (this.matchState === 'freekick') {
                matchStateEl.innerText = this.setPieceIndirect ? "INDIRECT FK" : "FREE KICK";
                matchStateEl.className = "badge bg-info";
            } else if (this.matchState === 'penalty') {
                matchStateEl.innerText = "PENALTY";
                matchStateEl.className = "badge bg-danger animate-pulse";
            } else if (this.matchState === 'card') {
                matchStateEl.innerText = "CARD ALERT";
                matchStateEl.className = "badge bg-warning text-dark animate-pulse";
            } else if (this.matchState === 'offside') {
                matchStateEl.innerText = "OFFSIDE";
                matchStateEl.className = "badge bg-warning text-dark animate-pulse";
            }
        }
    }

    renderAll(g) {
        if (Settings.HEADLESS) return;
        if (!this.active) return;

        // 1. Draw the pitch background first (teams/players are children of pitch but y-sorted here)
        if (this.pitch) {
            this.pitch.render(g);
        }

        // 2. Y-Sorting: Players (via teams) + Ball — not pitch's raw child tree
        if (!this._renderEntities) this._renderEntities = [];
        const entities = this._renderEntities;
        entities.length = 0;
        for (const player of this.players) {
            player.preRender(g);
            if (player.active && !player.isSentOff) {
                entities.push(player);
            }
        }
        if (this.ball) {
            entities.push(this.ball);
        }

        // Sort entities by their true top-down ground coordinate Y
        entities.sort((a, b) => a.y - b.y);

        // Render sorted entities (players and ball)
        for (const entity of entities) {
            entity.renderAll(g);
        }

        // 3. Render Level scripts (effects, etc.)
        for (const script of this.scripts) {
            script.render(g);
        }

        // 4. Render Level/Simulator's own overlay elements (Goal alerts, halftime screens, etc.)
        this.render(g);
    }

    /**
     * GUI layer (engine onGUI) — AI debug overlays when Settings.debugAI enabled.
     * Skipped entirely in HEADLESS.
     */
    onGUI(g) {
        if (Settings.HEADLESS) return;
        drawAiDebugOverlays(g, this);
    }

    getScreenOverlayBounds() {
        const app = Settings.app;
        const canvas = app && app.canvas;
        const width = canvas ? canvas.width : 720;
        const height = canvas ? canvas.height : 528;
        const camX = app ? app.camX : 0;
        const camY = app ? app.camY : 0;
        return {
            x: -camX,
            y: -camY,
            width,
            height,
            centerX: -camX + width / 2,
            centerY: -camY + height / 2
        };
    }

    drawScreenDimOverlay(g, alpha) {
        const b = this.getScreenOverlayBounds();
        g.fillStyle = `rgba(0, 0, 0, ${alpha})`;
        g.fillRect(b.x, b.y, b.width, b.height);
    }

    render(g) {
        if (Settings.HEADLESS) return;
        if (!this.ball) return;

        // Draw GOAL overlay
        // Advantage signal (soft — play continues)
        if (this.matchState === 'play' && this._pendingAdvantage) {
            const g = Settings.app.g;
            if (g) {
                const { centerX: textX, centerY: textY } = this.getScreenOverlayBounds();
                g.save();
                g.font = 'bold 28px Arial';
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillStyle = 'rgba(255, 220, 80, 0.9)';
                g.strokeStyle = 'rgba(0,0,0,0.7)';
                g.lineWidth = 3;
                g.strokeText('ADVANTAGE', textX, textY - 80);
                g.fillText('ADVANTAGE', textX, textY - 80);
                g.restore();
            }
        }

        // Interruption overlays (Kickoff, Goal, Corner, Goalkick, Freekick, Penalty, Halftime, Fulltime)
        if (this.matchState !== 'play') {
            g.save();

            let dimAlpha = 0.3;
            let title = "";
            let subtitle = "";
            const titleSize = "54px";

            const kickingTeamName = this.setPieceKickingTeam === 'A' ? this.teamAName : this.teamBName;

            switch (this.matchState) {
                case 'kickoff':
                    dimAlpha = 0.3;
                    title = "KICK OFF!";
                    subtitle = `${this.teamAName} vs ${this.teamBName}`;
                    break;
                case 'goal':
                    dimAlpha = 0.4;
                    title = "GOOOAL!!!";
                    const scoringTeamName = this.goalScoredTeam === 'A' ? this.teamAName : this.teamBName;
                    subtitle = `${scoringTeamName} Scores!`;
                    break;
                case 'goalkick':
                    dimAlpha = 0.3;
                    title = "GOAL KICK!";
                    subtitle = `${kickingTeamName}'s Ball`;
                    break;
                case 'corner':
                    dimAlpha = 0.3;
                    title = "CORNER KICK!";
                    subtitle = `${kickingTeamName}'s Attack`;
                    break;
                case 'foul':
                    if (this.stateTimer <= FOUL_REACT_DURATION - FOUL_OVERLAY_DELAY) {
                        dimAlpha = 0.35;
                        title = "FOUL!";
                        subtitle = `${kickingTeamName}'s Ball`;
                    }
                    break;
                case 'freekick':
                    dimAlpha = 0.3;
                    title = this.setPieceIndirect ? "INDIRECT FREE KICK!" : "FREE KICK!";
                    subtitle = `${kickingTeamName}'s Ball`;
                    break;
                case 'penalty':
                    dimAlpha = 0.35;
                    title = "PENALTY!";
                    subtitle = `${kickingTeamName}'s Spot Kick`;
                    break;
                case 'card':
                    dimAlpha = 0.5;
                    title = (this.cardType === 'yellow') ? "YELLOW CARD" : "RED CARD";
                    subtitle = (this.cardType === 'doubleyellow')
                        ? `${this.cardedPlayer.name} receives 2nd Yellow!`
                        : `${this.cardedPlayer.name} is penalized!`;
                    break;
                case 'offside':
                    dimAlpha = 0.4;
                    title = "OFFSIDE!";
                    subtitle = `Indirect Free Kick`;
                    break;
                case 'halftime':
                    dimAlpha = 0.5;
                    title = "HALF TIME";
                    subtitle = `Score: ${this.teamAName} ${this.scoreA} - ${this.scoreB} ${this.teamBName}`;
                    break;
                case 'fulltime':
                    dimAlpha = 0.5;
                    title = "FULL TIME";
                    subtitle = `Score: ${this.teamAName} ${this.scoreA} - ${this.scoreB} ${this.teamBName}`;
                    break;
            }

            if (title) {
                this.drawScreenDimOverlay(g, dimAlpha);

                const fillAlpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(performance.now() * 0.008));
                const { centerX: textX, centerY: textY } = this.getScreenOverlayBounds();

                // Draw literal card graphic for yellow/red card overlays
                if (this.matchState === 'card') {
                    g.save();
                    const cardW = 60;
                    const cardH = 90;
                    const cardColor = (this.cardType === 'yellow') ? '#FFD700' : '#FF0000';

                    g.fillStyle = cardColor;
                    g.strokeStyle = '#000000';
                    g.lineWidth = 3;
                    g.shadowColor = 'rgba(0, 0, 0, 0.7)';
                    g.shadowBlur = 12;

                    const rx = textX - cardW / 2;
                    const ry = textY - 140;

                    g.beginPath();
                    g.roundRect ? g.roundRect(rx, ry, cardW, cardH, 8) : g.rect(rx, ry, cardW, cardH);
                    g.fill();
                    g.stroke();
                    g.restore();
                }

                // Draw Title
                g.font = `900 ${titleSize} "Orbitron", sans-serif`;
                g.fillStyle = `rgba(255, 255, 255, ${fillAlpha})`;
                g.strokeStyle = '#000000';
                g.lineWidth = 6;
                g.textAlign = 'center';
                g.shadowColor = 'rgba(0, 0, 0, 0.6)';
                g.shadowBlur = 10;

                g.strokeText(title, textX, textY - 25);
                g.fillText(title, textX, textY - 25);

                // Draw Subtitle
                if (subtitle) {
                    g.font = 'bold 26px "Orbitron", sans-serif';
                    g.fillStyle = '#FFFFFF';
                    g.strokeStyle = '#000000';
                    g.lineWidth = 4;
                    g.strokeText(subtitle, textX, textY + 35);
                    g.fillText(subtitle, textX, textY + 35);
                }
            }

            g.restore();
        }

        // 7. Render flat top-down 2D minimap (independent of projectionMode)
        this.renderMinimap();
    }

    renderMinimap() {
        if (!this.ball) return;
        if (typeof document === 'undefined') return;
        const minimapCanvas = document.getElementById('minimap');
        if (!minimapCanvas) return;

        const mg = minimapCanvas.getContext('2d');
        const mw = minimapCanvas.width;
        const mh = minimapCanvas.height;

        // Clear minimap background
        mg.fillStyle = '#2b752b';
        mg.fillRect(0, 0, mw, mh);

        // Draw pitch border
        mg.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        mg.lineWidth = 2;
        mg.strokeRect(10, 10, mw - 20, mh - 20);

        // Draw halfway line
        mg.beginPath();
        mg.moveTo(mw / 2, 10);
        mg.lineTo(mw / 2, mh - 10);
        mg.stroke();

        // Draw center circle
        mg.beginPath();
        mg.arc(mw / 2, mh / 2, (mh - 20) * 0.15, 0, Math.PI * 2);
        mg.stroke();

        const field = Utils.getFieldBounds();
        const mapX = (lx) => 10 + (lx / field.width) * (mw - 20);
        const mapY = (ly) => 10 + (ly / field.height) * (mh - 20);
        const fcY = field.centerY;
        const arcRadius = Utils.scaleFieldX(10.9375);
        const penSpotLeftX = Utils.scaleFieldX(12.5);
        const penSpotRightX = field.width - penSpotLeftX;
        const penBoxLineLeftX = Utils.scaleFieldX(15.625);
        const penBoxLineRightX = field.width - penBoxLineLeftX;

        const drawPenaltyArc = (cx, cy, radius, boxLineX, side) => {
            const dx = Math.abs(boxLineX - cx);
            if (dx >= radius) return;
            const alpha = Math.acos(dx / radius);
            const segments = 12;
            mg.beginPath();
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const angle = side === 'left'
                    ? -alpha + 2 * alpha * t
                    : Math.PI - alpha + 2 * alpha * t;
                const lx = cx + radius * Math.cos(angle);
                const ly = cy + radius * Math.sin(angle);
                if (i === 0) mg.moveTo(mapX(lx), mapY(ly));
                else mg.lineTo(mapX(lx), mapY(ly));
            }
            mg.stroke();
        };

        mg.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        mg.strokeRect(mapX(0), mapY(Utils.scaleFieldY(20)), mapX(Utils.scaleFieldX(15.625)) - mapX(0), mapY(Utils.scaleFieldY(80)) - mapY(Utils.scaleFieldY(20)));
        mg.strokeRect(mapX(field.width - Utils.scaleFieldX(15.625)), mapY(Utils.scaleFieldY(20)), mapX(field.width) - mapX(field.width - Utils.scaleFieldX(15.625)), mapY(Utils.scaleFieldY(80)) - mapY(Utils.scaleFieldY(20)));
        drawPenaltyArc(penSpotLeftX, fcY, arcRadius, penBoxLineLeftX, 'left');
        drawPenaltyArc(penSpotRightX, fcY, arcRadius, penBoxLineRightX, 'right');

        // Draw Corner Arcs on Minimap
        const rPx = Math.max(3, (Utils.scaleFieldX(1.25) / field.width) * (mw - 20));
        mg.beginPath();
        mg.arc(10, 10, rPx, 0, Math.PI / 2);
        mg.stroke();

        mg.beginPath();
        mg.arc(10, mh - 10, rPx, 1.5 * Math.PI, 2 * Math.PI);
        mg.stroke();

        mg.beginPath();
        mg.arc(mw - 10, 10, rPx, Math.PI / 2, Math.PI);
        mg.stroke();

        mg.beginPath();
        mg.arc(mw - 10, mh - 10, rPx, Math.PI, 1.5 * Math.PI);
        mg.stroke();

        // Draw Players as dots
        for (const p of this.players) {
            if (p.isSentOff) continue;
            mg.fillStyle = p.team === 'A' ? '#FFFF00' : '#00FFFF'; // Team A = Yellow, Team B = Cyan
            if (p.role === 'GK') {
                mg.fillStyle = p.team === 'A' ? '#00FF00' : '#FF5500'; // GKs are different
            }

            mg.beginPath();
            mg.arc(mapX(p.x), mapY(p.y), 3.5, 0, Math.PI * 2);
            mg.fill();
            mg.strokeStyle = '#000000';
            mg.lineWidth = 0.5;
            mg.stroke();
        }

        // Draw Ball as white dot
        mg.fillStyle = '#FFFFFF';
        mg.beginPath();
        mg.arc(mapX(this.ball.x), mapY(this.ball.y), 2.5, 0, Math.PI * 2);
        mg.fill();
        mg.strokeStyle = '#000000';
        mg.lineWidth = 0.5;
        mg.stroke();
    }

    setupSetPiecePositions(type, side, attackingTeam, cornerY = 0) {
        const isWalkBackType = (type === 'freekick' || type === 'throwin' || type === 'penalty');
        const prevPositions = new Map();
        for (const p of this.players) {
            if (!p.isSentOff) {
                prevPositions.set(p, { x: p.x, y: p.y });
            }
        }

        const field = Utils.getFieldBounds();
        const fcY = field.centerY;
        const fw = field.width;
        const s = (v) => Utils.scaleFieldX(v);

        const kickingTeam = attackingTeam;
        const defendingTeam = kickingTeam === 'A' ? 'B' : 'A';

        // A.5: weighted set-piece playbook (seeded via Math.random override)
        // Penalties use a fixed script (no playbook pack)
        const playbook = (type === 'penalty') ? null : pickPlaybook(type);
        this.activePlaybook = playbook;

        // 1. Reset outfield to Idle; keep GKs in Goalkeeper (Idle breaks claim/hold logic)
        for (const p of this.players) {
            p.z = 0;
            p.vx = 0; p.vy = 0; p.vz = 0;
            if (p.role === 'GK') {
                p.fsm.changeState(PlayerStates.Goalkeeper);
            } else {
                p.fsm.changeState(PlayerStates.Idle);
            }
        }

        if (type === 'goalkick') {
            const kickX = (side === 'left') ? s(6.25) : fw - s(6.25);
            const kickY = fcY;

            const kickSquad = this.getTeam(kickingTeam);
            const defSquad = this.getTeam(defendingTeam);
            const gk = kickSquad ? kickSquad.getGoalkeeper(true) : this.players.find(p => p.team === kickingTeam && p.role === 'GK');
            if (gk) {
                gk.x = kickX;
                gk.y = kickY;
                this.ball.x = kickX;
                this.ball.y = kickY;
                this.ball.z = 0;
                this.ball.owner = gk;
                gk.orientation = (side === 'left') ? 2 : 6;
                gk.fsm.changeState(PlayerStates.Goalkeeper);
            }

            const defGk = defSquad ? defSquad.getGoalkeeper(true) : this.players.find(p => p.team === defendingTeam && p.role === 'GK');
            if (defGk) {
                defGk.x = getGoalkeeperBaseX(this, defendingTeam);
                defGk.y = fcY;
                defGk.fsm.changeState(PlayerStates.Goalkeeper);
            }

            // Reposition outfield players
            for (const p of this.players) {
                if (p.role === 'GK' || p.isSentOff) continue;
                p.x = p.baseX;
                p.y = p.baseY;

                // Keep opponent team out of the box
                if (p.team === defendingTeam) {
                    if (side === 'left' && p.x < s(18.75)) {
                        p.x = s(20.3125) + Math.random() * 2;
                    } else if (side === 'right' && p.x > fw - s(18.75)) {
                        p.x = fw - s(20.3125) - Math.random() * 2;
                    }
                }
            }
        }
        else if (type === 'corner') {
            const cornerX = (side === 'left') ? 0 : fw;

            // Find taker: nearest outfielder
            let taker = null;
            let minDist = Infinity;
            for (const p of this.players) {
                if (p.team === kickingTeam && p.role !== 'GK') {
                    const d = Math.sqrt(Math.pow(p.x - cornerX, 2) + Math.pow(p.y - cornerY, 2));
                    if (d < minDist) {
                        minDist = d;
                        taker = p;
                    }
                }
            }

            if (taker) {
                // Ball must sit *inside* the pitch. Taker can stand just outside the
                // flag for look, but carry-sync must not drag the ball OOB (that
                // immediately re-triggers corner/throw-in when Play starts).
                const inset = Math.max(0.55, field.multiplier * 0.55);
                const ballX = (side === 'left') ? inset : fw - inset;
                const ballY = (cornerY < field.centerY) ? inset : field.height - inset;
                const offset = 0.35;
                taker.x = (side === 'left') ? -offset : fw + offset;
                taker.y = (cornerY < field.centerY) ? -offset : field.height + offset;
                // Face the box (infield diagonal)
                if (side === 'left') {
                    taker.orientation = (cornerY < field.centerY) ? 3 : 1; // down-right / up-right
                } else {
                    taker.orientation = (cornerY < field.centerY) ? 5 : 7; // down-left / up-left
                }

                this.ball.x = ballX;
                this.ball.y = ballY;
                this.ball.z = 0;
                this.ball.vx = 0;
                this.ball.vy = 0;
                this.ball.vz = 0;
                this.ball.isThrowInFlight = false;
                this.ball.curveForce = 0;
                this.ball.owner = taker;
                this._setPieceBallSpot = { x: ballX, y: ballY };
            }

            // Position Goalkeepers
            const defGk = this.players.find(p => p.team === defendingTeam && p.role === 'GK');
            if (defGk) {
                defGk.x = (side === 'left') ? s(0.625) : fw - s(0.625);
                defGk.y = fcY;
                defGk.fsm.changeState(PlayerStates.Goalkeeper);
            }
            const atkGk = this.players.find(p => p.team === kickingTeam && p.role === 'GK');
            if (atkGk) {
                atkGk.x = (side === 'left') ? fw - s(0.625) : s(0.625);
                atkGk.y = fcY;
                atkGk.fsm.changeState(PlayerStates.Goalkeeper);
            }

            // A.5: playbook-biased box packing (near/far/short/edge)
            const attackers = this.players.filter(p => p.team === kickingTeam && p !== taker && p.role !== 'GK');
            const defenders = this.players.filter(p => p.team === defendingTeam && p.role !== 'GK');
            const cornerResult = applyCornerPositions(this, playbook, attackers, defenders, side, cornerY);
            if (playbook && cornerResult && cornerResult.shortAttacker) {
                playbook._shortAttacker = cornerResult.shortAttacker;
            }
        }
        else if (type === 'freekick') {
            const bx = this.setPieceX;
            const by = this.setPieceY;

            this.ball.x = bx;
            this.ball.y = by;
            this.ball.z = 0;

            // Find taker: nearest outfielder of kickingTeam
            let taker = null;
            let minDist = Infinity;
            for (const p of this.players) {
                if (p.team === kickingTeam && p.role !== 'GK' && !p.isSentOff) {
                    const d = Math.sqrt(Math.pow(p.x - bx, 2) + Math.pow(p.y - by, 2));
                    if (d < minDist) {
                        minDist = d;
                        taker = p;
                    }
                }
            }

            // Position taker slightly behind the ball relative to defending goal
            const gx = (defendingTeam === 'A') ? 0 : fw;
            const gy = fcY;
            const dx = gx - bx;
            const dy = gy - by;
            const distToGoal = Math.sqrt(dx * dx + dy * dy);
            const nx = dx / (distToGoal || 0.001);
            const ny = dy / (distToGoal || 0.001);

            if (taker) {
                taker.x = bx - nx * 0.3;
                taker.y = by - ny * 0.3;
                taker.orientation = (nx > 0) ? 2 : 6;
                this.ball.owner = null;
            }

            // Position other players at formation base positions first
            for (const p of this.players) {
                if (p === taker || p.isSentOff) continue;
                p.x = p.baseX;
                p.y = p.baseY;
            }

            // Position Goalkeepers
            const gkA = this.players.find(p => p.team === 'A' && p.role === 'GK');
            if (gkA) {
                gkA.x = getGoalkeeperBaseX(this, 'A');
                gkA.y = fcY;
                gkA.fsm.changeState(PlayerStates.Goalkeeper);
            }
            const gkB = this.players.find(p => p.team === 'B' && p.role === 'GK');
            if (gkB) {
                gkB.x = getGoalkeeperBaseX(this, 'B');
                gkB.y = fcY;
                gkB.fsm.changeState(PlayerStates.Goalkeeper);
            }

            // Form a wall if in the defending half of the defending team (which is the attacking half of kicking team)
            const isDefendingHalf = (defendingTeam === 'A') ? (bx < field.centerX) : (bx > field.centerX);
            // A.6: clear any previous wall before building a new one
            clearWallPlayers(this.freekickWallPlayers);
            this.freekickWallPlayers = [];
            if (isDefendingHalf) {
                // A.5+A.6: wall size from playbook (auto = distance heuristic; 0 = no wall)
                const wallSize = resolveWallSize(playbook, distToGoal, s);
                const wallDist = s(10.9375);
                const spacing = s(0.875);

                let wallPlayers = [];
                if (wallSize > 0) {
                    // A.6: geometry from freekick_wall module
                    const wallPositions = buildWallPositions(bx, by, nx, ny, wallSize, wallDist, spacing);
                    const defenders = this.players.filter(p => p.team === defendingTeam && p.role !== 'GK' && !p.isSentOff);
                    const clampX = (val) => Math.max(s(1.5625), Math.min(fw - s(1.5625), val));
                    const clampY = (val) => Math.max(s(1.5625), Math.min(field.height - s(1.5625), val));
                    wallPlayers = assignWallPlayers(defenders, wallPositions, clampX, clampY);
                    // Orient wall players to face the ball
                    for (const wp of wallPlayers) {
                        wp.orientation = (bx > wp.x) ? 2 : 6;
                    }
                    this.freekickWallPlayers = wallPlayers;
                }

                // Push other defenders away if they are too close to the ball
                for (const p of this.players) {
                    if (p.team === defendingTeam && p.role !== 'GK' && !p.isSentOff) {
                        if (wallPlayers.indexOf(p) >= 0) continue;

                        const distToBall = Math.sqrt(Math.pow(p.x - bx, 2) + Math.pow(p.y - by, 2));
                        if (distToBall < s(10.9375)) {
                            const pdx = p.x - bx;
                            const pdy = p.y - by;
                            const pd = Math.sqrt(pdx*pdx + pdy*pdy) || 0.001;
                            p.x = bx + (pdx / pd) * s(11.25);
                            p.y = by + (pdy / pd) * s(11.25);
                        }
                    }
                }
            } else {
                // If in the opponent's half, just push defenders away if too close
                for (const p of this.players) {
                    if (p.team === defendingTeam && p.role !== 'GK' && !p.isSentOff) {
                        const distToBall = Math.sqrt(Math.pow(p.x - bx, 2) + Math.pow(p.y - by, 2));
                        if (distToBall < s(10.9375)) {
                            // push back towards their goal
                            const pdx = p.x - bx;
                            const pdy = p.y - by;
                            const pd = Math.sqrt(pdx*pdx + pdy*pdy) || 0.001;
                            p.x = bx + (pdx / pd) * s(11.25);
                            p.y = by + (pdy / pd) * s(11.25);
                        }
                    }
                }
            }
        }
        else if (type === 'penalty') {
            // Spot is always on the defending goal of the non-kicking team
            const penSide = side === 'right' ? 'right' : 'left';
            const spot = getPenaltySpot(penSide, field);
            const bx = spot.x;
            const by = spot.y;
            this.setPieceX = bx;
            this.setPieceY = by;
            this.setPieceSide = penSide;

            this.ball.x = bx;
            this.ball.y = by;
            this.ball.z = 0;
            this.ball.vx = 0;
            this.ball.vy = 0;
            this.ball.vz = 0;
            this.ball.owner = null;
            this.ball.ifkActive = false;
            this.ball.ifkTaker = null;
            this.setPieceIndirect = false;

            // Taker: nearest outfielder of kicking team
            let taker = null;
            let minDist = Infinity;
            for (const p of this.players) {
                if (p.team === kickingTeam && p.role !== 'GK' && !p.isSentOff) {
                    const d = Math.sqrt(Math.pow(p.x - bx, 2) + Math.pow(p.y - by, 2));
                    if (d < minDist) {
                        minDist = d;
                        taker = p;
                    }
                }
            }

            // Face the goal; stand slightly behind the ball
            const goalX = penSide === 'left' ? 0 : fw;
            const nx = (goalX - bx) >= 0 ? 1 : -1;
            if (taker) {
                taker.x = bx - nx * 0.55;
                taker.y = by;
                taker.orientation = nx > 0 ? 2 : 6;
                this.ball.owner = null;
            }

            // GK on the line of the defending goal
            const defGk = this.players.find(p => p.team === defendingTeam && p.role === 'GK' && !p.isSentOff);
            if (defGk) {
                defGk.x = penSide === 'left' ? s(0.4) : fw - s(0.4);
                defGk.y = fcY;
                defGk.orientation = penSide === 'left' ? 2 : 6;
                defGk.fsm.changeState(PlayerStates.Goalkeeper);
            }
            const atkGk = this.players.find(p => p.team === kickingTeam && p.role === 'GK' && !p.isSentOff);
            if (atkGk) {
                atkGk.x = penSide === 'left' ? fw - s(0.625) : s(0.625);
                atkGk.y = fcY;
                atkGk.fsm.changeState(PlayerStates.Goalkeeper);
            }

            // Everyone else outside the penalty area (FIFA: also outside the arc — box is enough)
            const box = getPenaltyArea(penSide, field);
            const outsidePad = s(1.0);
            for (const p of this.players) {
                if (p === taker || p.role === 'GK' || p.isSentOff) continue;
                p.x = p.baseX;
                p.y = p.baseY;
                // Push out of the box if still inside
                if (p.x >= box.xMin - 0.01 && p.x <= box.xMax + 0.01
                    && p.y >= box.yMin - 0.01 && p.y <= box.yMax + 0.01) {
                    if (penSide === 'left') {
                        p.x = box.xMax + outsidePad + Math.random() * s(2);
                    } else {
                        p.x = box.xMin - outsidePad - Math.random() * s(2);
                    }
                    p.y = Math.max(box.yMin - outsidePad, Math.min(box.yMax + outsidePad, p.y));
                }
                // Also keep clear of the ball (10y rule ≈ 9.15m → use box edge)
                const distToSpot = Math.sqrt(Math.pow(p.x - bx, 2) + Math.pow(p.y - by, 2));
                if (distToSpot < s(10.5)) {
                    const pdx = p.x - bx;
                    const pdy = p.y - by;
                    const pd = Math.sqrt(pdx * pdx + pdy * pdy) || 0.001;
                    p.x = bx + (pdx / pd) * s(11.0);
                    p.y = by + (pdy / pd) * s(11.0);
                    // Re-clamp out of box after radial push
                    if (penSide === 'left' && p.x < box.xMax + outsidePad) p.x = box.xMax + outsidePad;
                    if (penSide === 'right' && p.x > box.xMin - outsidePad) p.x = box.xMin - outsidePad;
                }
            }

            clearWallPlayers(this.freekickWallPlayers);
            this.freekickWallPlayers = [];
        }

        if (isWalkBackType) {
            for (const p of this.players) {
                if (p.isSentOff) continue;
                const prev = prevPositions.get(p);
                if (prev) {
                    const targetX = p.x;
                    const targetY = p.y;
                    p.x = prev.x;
                    p.y = prev.y;
                    p.setPieceTarget = { x: targetX, y: targetY };
                    p.isWalkingToSetPiece = true;
                }
            }
        }
    }

    findSetPieceTaker(team, x, y) {
        const squad = this.getTeam(team);
        if (squad) {
            return squad.findSetPieceTaker(x, y);
        }
        let taker = null;
        let minDist = Infinity;
        for (const p of this.players) {
            if (p.team !== team || p.role === 'GK' || p.isSentOff) continue;
            const d = Math.sqrt(Math.pow(p.x - x, 2) + Math.pow(p.y - y, 2));
            if (d < minDist) {
                minDist = d;
                taker = p;
            }
        }
        return taker;
    }

    sendOffPlayer(player) {
        player.isSentOff = true;
        player.x = -9999;
        player.y = -9999;
        player.vx = 0;
        player.vy = 0;
        player.actionTimer = 0;
        player.fsm.changeState(PlayerStates.Idle);
        if (this.ball && this.ball.owner === player) {
            this.ball.owner = null;
        }
    }

    applyFouledPlayerFall(fouledPlayer, tackler) {
        const recovery = Settings.AI.TACKLE_RECOVERY_SLIDE;
        fouledPlayer.actionTimer = recovery * 1.5;
        fouledPlayer.frame = 5;
        fouledPlayer.isWalkingToSetPiece = false;
        fouledPlayer.setPieceTarget = null;
        fouledPlayer.vx = 0;
        fouledPlayer.vy = 0;
        fouledPlayer.fsm.changeState(PlayerStates.Idle);

        if (tackler) {
            tackler.actionTimer = 0;
            tackler.isSliding = false;
            tackler.fsm.changeState(PlayerStates.Idle);
        }
    }

    resolvePendingFoul() {
        const outcome = this._pendingFoulOutcome;
        this._pendingFoulOutcome = null;

        if (!outcome) {
            this.setPieceType = 'freekick';
            this.setPieceIndirect = false;
            this.fsm.changeState(MatchStates.Freekick);
            return;
        }

        const { kickingTeam, showCard, cardType, tackler, isPenalty } = outcome;
        this.setPieceKickingTeam = kickingTeam;
        this.setPieceIndirect = false;

        if (showCard && tackler) {
            this.cardType = cardType;
            this.cardedPlayer = tackler;
            // Card state transitions into set-piece; keep type for Card exit
            this.setPieceType = isPenalty ? 'penalty' : 'freekick';

            if (cardType === 'yellow') {
                tackler.yellowCards = 1;
            } else {
                this.sendOffPlayer(tackler);
            }
            this.fsm.changeState(MatchStates.Card);
            return;
        }

        if (isPenalty) {
            this.setPieceType = 'penalty';
            this.setupSetPiecePositions('penalty', this.setPieceSide, kickingTeam);
            this.fsm.changeState(MatchStates.Penalty);
        } else {
            this.setPieceType = 'freekick';
            this.setupSetPiecePositions('freekick', this.setPieceSide, kickingTeam);
            this.fsm.changeState(MatchStates.Freekick);
        }
    }

    /**
     * Roll card outcome for a foul (shared by stoppage and advantage paths).
     * @param {object} tackler
     * @param {{ tackleType?: string }} meta
     * @returns {{ showCard: boolean, cardType: string|null }}
     */
    rollFoulCard(tackler, meta = {}) {
        const tacklingStat = (tackler && tackler.stats && typeof tackler.stats.tackling === 'number')
            ? tackler.stats.tackling
            : 50;
        const strictness = (typeof Settings.REFEREE_STRICTNESS === 'number') ? Settings.REFEREE_STRICTNESS : 0.5;
        const aiRoot = Settings.AI || {};
        const cardBase = typeof aiRoot.FOUL_CARD_CHANCE_BASE === 'number'
            ? aiRoot.FOUL_CARD_CHANCE_BASE
            : 0.14;
        const redShare = typeof aiRoot.FOUL_CARD_RED_SHARE === 'number'
            ? aiRoot.FOUL_CARD_RED_SHARE
            : 0.06;

        let cardChance = cardBase + (strictness - 0.5) * 0.22 - (tacklingStat - 50) * 0.002;
        if (tackler && tackler.traits && tackler.traits.includes('Hard Tackler')) {
            cardChance += 0.08;
        }
        const tackleType = meta && meta.tackleType;
        if (tackleType === 'body') {
            const bodyMul = typeof aiRoot.BODY_CARD_CHANCE_MUL === 'number'
                ? aiRoot.BODY_CARD_CHANCE_MUL
                : 1.55;
            cardChance *= bodyMul;
        }
        const showCard = Math.random() < Math.max(0.04, Math.min(0.55, cardChance));

        let cardType = null;
        if (showCard && tackler) {
            let redP = redShare;
            if (tackleType === 'body') {
                redP = Math.min(0.18, redShare * 1.35);
            }
            cardType = Math.random() < (1 - redP) ? 'yellow' : 'red';
            if (cardType === 'yellow' && tackler.yellowCards === 1) {
                cardType = 'doubleyellow';
            }
        }
        return { showCard, cardType, tackleType };
    }

    /**
     * Freeze ball and enter Foul react → freekick / penalty / card.
     * @param {object} outcome pending foul outcome
     */
    beginFoulStoppage(outcome) {
        this._pendingAdvantage = null;
        this._pendingFoulOutcome = outcome;
        this.fouledPlayer = outcome.fouledPlayer || this.fouledPlayer;
        this.setPieceKickingTeam = outcome.kickingTeam;
        this.setPieceX = outcome.foulX != null ? outcome.foulX : this.setPieceX;
        this.setPieceY = outcome.foulY != null ? outcome.foulY : this.setPieceY;
        this.setPieceSide = outcome.setPieceSide || this.setPieceSide;
        this.setPieceType = outcome.isPenalty ? 'penalty' : 'freekick';
        this.setPieceIndirect = false;

        if (this.ball) {
            this.ball.owner = null;
            this.ball.vx = 0;
            this.ball.vy = 0;
            this.ball.vz = 0;
            this.ball.z = 0;
            this.ball.x = this.setPieceX;
            this.ball.y = this.setPieceY;
            this.ball.ifkActive = false;
            this.ball.ifkTaker = null;
        }

        if (outcome.fouledPlayer) {
            this.applyFouledPlayerFall(outcome.fouledPlayer, outcome.tackler);
        }
        SoundDB.play('whistle');
        this.fsm.changeState(MatchStates.Foul);
    }

    /**
     * Logic-tick advantage window: cancel if possession lost; expire quietly if held.
     * @param {number} dt
     */
    tickAdvantage(dt) {
        const pending = this._pendingAdvantage;
        if (!pending) return;

        pending.timer -= dt;
        if (!advantageStillHolds(this, pending)) {
            // Advantage fizzled — whistle for the original foul spot
            this.beginFoulStoppage(pending);
            return;
        }
        if (pending.timer <= 0) {
            // Advantage realized: play on (yellows not shown after successful advantage)
            this._pendingAdvantage = null;
        }
    }

    /**
     * @param {object} tackler
     * @param {object} fouledPlayer
     * @param {{ tackleType?: string }} [meta] - Stage 3: body shove raises card risk
     */
    triggerFoul(tackler, fouledPlayer, meta = {}) {
        // Nested foul while advantage pending: resolve previous first
        if (this._pendingAdvantage) {
            this.beginFoulStoppage(this._pendingAdvantage);
            return;
        }

        const kickingTeam = fouledPlayer.team;
        const foulX = this.ball ? this.ball.x : fouledPlayer.x;
        const foulY = this.ball ? this.ball.y : fouledPlayer.y;
        const foulingTeam = tackler ? tackler.team : (kickingTeam === 'A' ? 'B' : 'A');
        const isPenalty = isPenaltyFoul(this, foulingTeam, foulX, foulY);

        // Penalty restart side is the goal end being attacked (defending goal of fouling team)
        const penSide = defendingGoalSide(this, foulingTeam);
        const field = Utils.getFieldBounds();
        const setPieceSide = isPenalty
            ? penSide
            : ((foulX < field.centerX) ? 'left' : 'right');

        if (isPenalty) {
            const spot = getPenaltySpot(penSide, field);
            this.setPieceX = spot.x;
            this.setPieceY = spot.y;
        } else {
            this.setPieceX = foulX;
            this.setPieceY = foulY;
        }
        this.setPieceSide = setPieceSide;
        this.fouledPlayer = fouledPlayer;

        const { showCard, cardType, tackleType } = this.rollFoulCard(tackler, meta);
        const outcome = {
            kickingTeam,
            showCard,
            cardType,
            tackler,
            tackleType,
            isPenalty,
            fouledPlayer,
            foulX: this.setPieceX,
            foulY: this.setPieceY,
            setPieceSide
        };

        // Advantage: play on when fouled team still has the ball (never for pen/red)
        if (shouldPlayAdvantage(this, tackler, fouledPlayer, { cardType, isPenalty })) {
            // Soft stumble only — do not freeze the match
            if (fouledPlayer) {
                fouledPlayer.actionTimer = Math.max(fouledPlayer.actionTimer || 0, 0.35);
                fouledPlayer.frame = 5;
            }
            if (tackler) {
                tackler.isSliding = false;
                tackler.actionTimer = Math.max(tackler.actionTimer || 0, 0.2);
            }
            this._pendingAdvantage = {
                ...outcome,
                timer: ADVANTAGE_WINDOW_SEC
            };
            return;
        }

        this.beginFoulStoppage(outcome);
    }

    /**
     * IFK taken straight into the net without a second touch → goalkick
     * (not a goal). Clears IFK flags and restarts from the defending goal.
     * @param {'left'|'right'} goalSide
     * @param {boolean} secondHalf
     * @param {{ centerY: number, height: number }} field
     */
    _resolveInvalidIfkGoal(goalSide, secondHalf, field) {
        SoundDB.play('whistle');
        this._pendingAdvantage = null;
        if (this.ball) {
            this.ball.owner = null;
            this.ball.vx = 0;
            this.ball.vy = 0;
            this.ball.vz = 0;
            this.ball.z = 0;
            this.ball.ifkActive = false;
            this.ball.ifkTaker = null;
        }
        const { left: leftGoal, right: rightGoal } = this.getGoals();
        const goal = goalSide === 'left' ? leftGoal : rightGoal;
        const defendingTeam = goal.defendingTeam(secondHalf);
        this.setPieceType = 'goalkick';
        this.setPieceSide = goalSide;
        this.setPieceKickingTeam = defendingTeam;
        this.setPieceIndirect = false;
        this.setupSetPiecePositions('goalkick', goalSide, defendingTeam);
        this.fsm.changeState(MatchStates.Goalkick);
    }

    triggerOffside(offsidePlayer) {
        SoundDB.play('whistle');
        this._pendingAdvantage = null;

        const passingTeam = offsidePlayer.team;
        const defendingTeam = passingTeam === 'A' ? 'B' : 'A';

        this.setPieceType = 'offside';
        this.setPieceKickingTeam = defendingTeam;
        // Offside restart is always an indirect free kick
        this.setPieceIndirect = true;

        // Award IFK at the ball's current position (where the pass was made),
        // NOT at the offside receiver — that would teleport the ball to the opposite side of the field.
        const fkX = this.ball.x;
        const fkY = this.ball.y;
        this.setPieceX = fkX;
        this.setPieceY = fkY;
        this.setPieceSide = (fkX < Utils.getFieldBounds().centerX) ? 'left' : 'right';

        // Stop the ball at the free kick position
        this.ball.x = fkX;
        this.ball.y = fkY;
        this.ball.z = 0;
        this.ball.vx = 0; this.ball.vy = 0; this.ball.vz = 0;
        this.ball.owner = null;
        this.ball.ifkActive = false;
        this.ball.ifkTaker = null;

        this.setupSetPiecePositions('freekick', this.setPieceSide, defendingTeam);
        this.fsm.changeState(MatchStates.Offside);
    }

    swapSides() {
        const field = Utils.getFieldBounds();
        if (this.teamA) this.teamA.swapSides(field);
        if (this.teamB) this.teamB.swapSides(field);
        // Re-point home/opp goals for the new half (also done inside Team.swapSides)
        if (this.teamA) this.teamA.wireGoals(this.pitch);
        if (this.teamB) this.teamB.wireGoals(this.pitch);
        // Fallback if teams were not wired (legacy bare player lists)
        if (!this.teamA && !this.teamB) {
            for (const p of this.players) {
                p.baseX = field.width - p.baseX;
                p.baseY = field.height - p.baseY;
            }
        }
    }

    isSecondHalf() {
        return this.matchTimer >= 2700;
    }

    /** Scoreboard side swap applies only after halftime ends and teams have switched ends. */
    isScoreboardSwapped() {
        return this.halfTimeTriggered
            && this.matchState !== 'halftime'
            && this.matchTimer >= 2700;
    }

    /**
     * Free-ball solid goal frame (posts, bar, exterior cage). Open mouth remains
     * free so pitch→net segments still score via Goal.scored.
     */
    resolveGoalFrameCollisions() {
        if (!this.ball || this.ball.owner) return;
        // Soft net settle owns the ball after a goal is already awarded
        if (this.matchState === 'goal') return;
        const { left: leftGoal, right: rightGoal } = this.getGoals();
        if (leftGoal && typeof leftGoal.resolveBallCollisions === 'function') {
            leftGoal.resolveBallCollisions(this.ball);
        }
        if (rightGoal && typeof rightGoal.resolveBallCollisions === 'function') {
            rightGoal.resolveBallCollisions(this.ball);
        }
    }

    checkGoalNetCollisions() {
        if (!this.ball) return;
        const { left: leftGoal, right: rightGoal } = this.getGoals();

        const settleInNet = (goal, netExpVelKey) => {
            const yMin = goal.yMin;
            const yMax = goal.yMax;
            const goalHeight = goal.height;
            const backX = goal.netBackX();
            const pastLine = (this.ball.x - goal.lineX) * goal.facingX < 0;
            if (!pastLine) return false;
            if (this.ball.y < yMin || this.ball.y > yMax || this.ball.z > goalHeight) return false;

            // Past back of net plane
            const pastBack = goal.facingX > 0
                ? this.ball.x <= backX
                : this.ball.x >= backX;
            if (pastBack) {
                const penetration = Math.abs(this.ball.x - backX);
                this.ball.x = backX + goal.facingX * 0.02;
                this.ball.vx = goal.facingX * Math.abs(this.ball.vx) * 0.15;
                this.ball.vy *= 0.8;
                this.ball.vz *= 0.8;
                if (this.pitch) {
                    this.pitch[netExpVelKey] = Math.max(
                        this.pitch[netExpVelKey],
                        penetration * 15.0 + Math.abs(this.ball.vx) * 2.0
                    );
                }
            }

            if (this.ball.y < yMin + 0.1) {
                this.ball.y = yMin + 0.1;
                this.ball.vy = Math.abs(this.ball.vy) * 0.2;
            } else if (this.ball.y > yMax - 0.1) {
                this.ball.y = yMax - 0.1;
                this.ball.vy = -Math.abs(this.ball.vy) * 0.2;
            }

            if (this.ball.z > goalHeight - 0.1) {
                this.ball.z = goalHeight - 0.1;
                this.ball.vz = -Math.abs(this.ball.vz) * 0.2;
            }
            return true;
        };

        if (settleInNet(leftGoal, 'leftNetExpVel')) return;
        settleInNet(rightGoal, 'rightNetExpVel');
    }

    createSeededRandom(seed) {
        this.rngState = (seed >>> 0) || 1;
        return () => {
            this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
            return this.rngState / 0x100000000;
        };
    }

    formatMatchClock(matchTimerSecs) {
        const totalSecs = Math.floor(matchTimerSecs);
        const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
        const secs = (totalSecs % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    }

    updateScrubberUI() {
        if (Settings.HEADLESS) return;
        if (typeof document === 'undefined') return;
        if (!this.replayConfig) return;

        const slider = document.getElementById('playbackSlider');
        const badge = document.getElementById('playbackFrameVal');
        const timeDisplay = document.getElementById('playbackTimeDisplay');

        if (slider) {
            const maxTicks = Math.max(0, this.playbackMaxElapsedTicks);
            const curTicks = Math.max(0, this.playbackElapsedTicks);
            const stepDt = this.getReplayStepDt();
            const maxSec = maxTicks * stepDt;
            const curSec = curTicks * stepDt;
            slider.min = 0;
            slider.max = Math.max(1, maxTicks);
            slider.step = 1;
            slider.disabled = maxTicks <= 0;

            if (document.activeElement !== slider) {
                slider.value = Math.min(curTicks, slider.max);
            }

            if (badge) {
                badge.innerText = `${this.formatMatchClock(this.matchTimer)} · ${curTicks}/${maxTicks}`;
            }

            if (timeDisplay) {
                timeDisplay.innerText = `${curSec.toFixed(1)}s / ${maxSec.toFixed(1)}s`;
            }
        }
    }

    checkForSubstitutions() {
        const stateName = this.fsm ? this.fsm.getNameOfCurrentState() : '';
        if (stateName === 'play' || stateName === 'fulltime' || stateName === 'stopped') {
            return;
        }

        // Only allow substitutions late in the game (after 60% of the match)
        // Simulated matchTimer runs 0 to 5400 (5400 is fulltime).
        // 60% of 5400 is 3240 (54th minute).
        if (this.matchTimer < 3240) {
            return;
        }

        if (this.teamA) this.evaluateTeamSubstitutions(this.teamA);
        if (this.teamB) this.evaluateTeamSubstitutions(this.teamB);
    }

    evaluateTeamSubstitutions(team) {
        if (!team.bench || team.bench.length === 0) return;
        if (team.substitutionsMade >= 3) return;

        const opponent = team.opponents;
        const isTrailing = opponent && (team.teamKey === 'A' ? this.scoreA < this.scoreB : this.scoreB < this.scoreA);

        const fieldPlayers = team.players.filter(p => p.role !== 'GK' && !p.isSentOff);

        for (const player of fieldPlayers) {
            if (team.substitutionsMade >= 3) break;

            const playerState = player.fsm ? player.fsm.getNameOfCurrentState() : '';
            if (playerState === 'Pass' || playerState === 'Shoot') {
                continue;
            }

            let shouldSub = false;
            let reason = '';

            const isWide = /^(LB|RB|LM|RM|LWB|RWB|LW|RW|W|WF)$/i.test(player.role) || (/L|R|W/i.test(player.role) && !/LCM|RCM/i.test(player.role));

            if (player.currentStamina < 0.55) {
                shouldSub = true;
                reason = 'exhaustion';
            } else if (isWide && player.currentStamina < 0.65) {
                shouldSub = true;
                reason = 'tired wide player';
            } else if (isTrailing && player.currentStamina < 0.70) {
                shouldSub = true;
                reason = 'fatigued & trailing';
            }

            if (shouldSub) {
                const sub = this.findReplacementOnBench(team, player);
                if (sub) {
                    this.executeSubstitution(team, player, sub, reason);
                }
            }
        }
    }

    findReplacementOnBench(team, player) {
        let group = 'MF';
        const role = player.role;
        if (/DF|CB|LB|RB|LWB|RWB/i.test(role)) group = 'DF';
        else if (/FW|CF|ST|LW|RW|SS|W|WF/i.test(role)) group = 'FW';
        else if (/MF|CM|LM|RM|AM|DM|CAM|CDM/i.test(role)) group = 'MF';

        let candidates = team.bench.filter(p => !p.isSubbedIn && !p.isSentOff);
        let match = candidates.find(p => {
            let pGroup = 'MF';
            if (/DF|CB|LB|RB|LWB|RWB/i.test(p.role)) pGroup = 'DF';
            else if (/FW|CF|ST|LW|RW|SS|W|WF/i.test(p.role)) pGroup = 'FW';
            else if (/MF|CM|LM|RM|AM|DM|CAM|CDM/i.test(p.role)) pGroup = 'MF';
            return pGroup === group;
        });

        if (!match) {
            match = candidates.find(p => p.role !== 'GK');
        }

        return match;
    }

    executeSubstitution(team, oldPlayer, newPlayer, reason) {
        console.log(`[SUBSTITUTION] Team ${team.teamKey} replacing ${oldPlayer.name} (${oldPlayer.role}, Stamina: ${oldPlayer.currentStamina.toFixed(2)}) with ${newPlayer.name} (${newPlayer.role}) [Reason: ${reason}]`);

        // Copy position and orientation
        newPlayer.x = oldPlayer.x;
        newPlayer.y = oldPlayer.y;
        newPlayer.z = oldPlayer.z;
        newPlayer.orientation = oldPlayer.orientation;

        // Copy tactical fields
        newPlayer.formationIndex = oldPlayer.formationIndex;
        newPlayer.baseX = oldPlayer.baseX;
        newPlayer.baseY = oldPlayer.baseY;
        newPlayer.formationBaseX = oldPlayer.formationBaseX;
        newPlayer.formationBaseY = oldPlayer.formationBaseY;
        newPlayer.defaultRegionId = oldPlayer.defaultRegionId;
        newPlayer.homeRegionId = oldPlayer.homeRegionId;
        newPlayer.regionFineOffsetX = oldPlayer.regionFineOffsetX;
        newPlayer.regionFineOffsetY = oldPlayer.regionFineOffsetY;

        // Remove oldPlayer child
        const childIdx = team.children.indexOf(oldPlayer);
        if (childIdx !== -1) {
            team.children.splice(childIdx, 1);
            oldPlayer.parent = null;
        }

        // Add newPlayer child
        newPlayer.parent = team;
        newPlayer.updateGlobalPos();
        newPlayer.start();
        team.children.push(newPlayer);

        // Update team.players
        const playerIdx = team.players.indexOf(oldPlayer);
        if (playerIdx !== -1) {
            team.players[playerIdx] = newPlayer;
        }

        // Update bench state
        const benchIdx = team.bench.indexOf(newPlayer);
        if (benchIdx !== -1) {
            team.bench.splice(benchIdx, 1);
        }
        oldPlayer.isSubbedOut = true;
        newPlayer.isSubbedIn = true;

        team.substitutionsMade = (team.substitutionsMade || 0) + 1;

        this.syncPlayersList();

        // Clear any oldPlayer references in bookkeeping
        if (team.controllingPlayer === oldPlayer) team.controllingPlayer = newPlayer;
        if (team.supportingPlayer === oldPlayer) team.supportingPlayer = newPlayer;
        if (team.receivingPlayer === oldPlayer) team.receivingPlayer = newPlayer;
        if (team.playerClosestToBall === oldPlayer) team.playerClosestToBall = newPlayer;
        if (team.stickyPrimaryChaser === oldPlayer) team.stickyPrimaryChaser = newPlayer;
        if (this.lastTouchPlayer === oldPlayer) this.lastTouchPlayer = newPlayer;
        if (this.ball && this.ball.owner === oldPlayer) this.ball.owner = newPlayer;

        if (this._telemetry && typeof this._telemetry.onSubstitution === 'function') {
            this._telemetry.onSubstitution({ team: team.teamKey, oldPlayer, newPlayer, reason });
        }
    }

    destroy() {
        Math.random = NATIVE_MATH_RANDOM;
    }
    // === SNAPSHOT SUPPORT (exact current frame) ===
    getPlayerIdentifier(player) {
        if (!player)
            return null;
        return `${player.team || 'X'}-${player.role || 'X'}-${player.formationIndex !== undefined ? player.formationIndex : 'X'}`;
    }

    serializePlayer(player) {
        if (!player)
            return null;
        return {
            id: this.getPlayerIdentifier(player),
            team: player.team,
            role: player.role,
            name: player.name,
            x: player.x, y: player.y, z: player.z || 0,
            vx: player.vx || 0, vy: player.vy || 0, vz: player.vz || 0,
            orientation: player.orientation || 0,
            frame: player.frame || 0,
            currentStamina: player.currentStamina ?? 1,
            isSentOff: !!player.isSentOff,
            isSubbedOut: !!player.isSubbedOut,
            isSubbedIn: !!player.isSubbedIn,
            yellowCards: player.yellowCards || 0,
            actionTimer: player.actionTimer || 0,
            isWalkingToSetPiece: !!player.isWalkingToSetPiece,
            setPieceTarget: player.setPieceTarget ? {x: player.setPieceTarget.x, y: player.setPieceTarget.y} : null,
            playerState: player.fsm ? (player.fsm.getNameOfCurrentState() || 'Idle') : 'Idle',
            baseX: player.baseX || 0, baseY: player.baseY || 0,
            formationBaseX: player.formationBaseX || 0, formationBaseY: player.formationBaseY || 0,
            defaultRegionId: player.defaultRegionId,
            homeRegionId: player.homeRegionId,
            regionFineOffsetX: player.regionFineOffsetX || 0,
            regionFineOffsetY: player.regionFineOffsetY || 0,
        };
    }

    serializeBall(ball) {
        if (!ball)
            return null;
        return {
            x: ball.x, y: ball.y, z: ball.z || 0,
            vx: ball.vx || 0, vy: ball.vy || 0, vz: ball.vz || 0,
            ownerId: ball.owner ? this.getPlayerIdentifier(ball.owner) : null,
            ifkActive: !!ball.ifkActive,
            ifkTakerId: ball.ifkTaker ? this.getPlayerIdentifier(ball.ifkTaker) : null,
        };
    }

    serializeTeam(team) {
        if (!team)
            return null;
        return {
            teamKey: team.teamKey,
            substitutionsMade: team.substitutionsMade || 0,
        };
    }

    getSnapshot() {
        const snap = {
            version: 1,
            seed: this.seed,
            matchTimer: this.matchTimer,
            scoreA: this.scoreA,
            scoreB: this.scoreB,
            teamAName: this.teamAName,
            teamBName: this.teamBName,
            formationAName: this.formationAName,
            formationBName: this.formationBName,
            kickoffTeam: this.kickoffTeam,
            goalScoredTeam: this.goalScoredTeam || '',
            halfTimeTriggered: !!this.halfTimeTriggered,
            setPieceType: this.setPieceType || '',
            setPieceSide: this.setPieceSide || '',
            setPieceX: this.setPieceX || 0,
            setPieceY: this.setPieceY || 0,
            setPieceCornerY: this.setPieceCornerY || 0,
            setPieceReadyPhase: !!this.setPieceReadyPhase,
            setPieceIndirect: !!this.setPieceIndirect,
            stateTimer: this.stateTimer || 0,
            currentMatchState: this.fsm ? this.fsm.getNameOfCurrentState() : 'kickoff',
            players: this.players.map(p => this.serializePlayer(p)),
            ball: this.serializeBall(this.ball),
            teamA: this.serializeTeam(this.teamA),
            teamB: this.serializeTeam(this.teamB),
            xgA: this.xgA || 0, xgB: this.xgB || 0,
            progressivePassesA: this.progressivePassesA || 0,
            progressivePassesB: this.progressivePassesB || 0,
            lastTouchPlayerId: this.lastTouchPlayer ? this.getPlayerIdentifier(this.lastTouchPlayer) : null,
            cardType: this.cardType || null,
            cardedPlayerId: this.cardedPlayer ? this.getPlayerIdentifier(this.cardedPlayer) : null,
            fouledPlayerId: this.fouledPlayer ? this.getPlayerIdentifier(this.fouledPlayer) : null,
            throwInTakerId: this.throwInTaker ? this.getPlayerIdentifier(this.throwInTaker) : null,
            _pendingFoulOutcome: this._pendingFoulOutcome ? {
                kickingTeam: this._pendingFoulOutcome.kickingTeam,
                showCard: this._pendingFoulOutcome.showCard,
                cardType: this._pendingFoulOutcome.cardType,
                isPenalty: !!this._pendingFoulOutcome.isPenalty,
                tacklerId: this._pendingFoulOutcome.tackler ? this.getPlayerIdentifier(this._pendingFoulOutcome.tackler) : null,
            } : null,
            _pendingAdvantage: this._pendingAdvantage ? {
                kickingTeam: this._pendingAdvantage.kickingTeam,
                showCard: this._pendingAdvantage.showCard,
                cardType: this._pendingAdvantage.cardType,
                isPenalty: !!this._pendingAdvantage.isPenalty,
                foulX: this._pendingAdvantage.foulX,
                foulY: this._pendingAdvantage.foulY,
                setPieceSide: this._pendingAdvantage.setPieceSide,
                timer: this._pendingAdvantage.timer,
                tacklerId: this._pendingAdvantage.tackler ? this.getPlayerIdentifier(this._pendingAdvantage.tackler) : null,
                fouledPlayerId: this._pendingAdvantage.fouledPlayer
                    ? this.getPlayerIdentifier(this._pendingAdvantage.fouledPlayer)
                    : null,
            } : null,
            freekickWallPlayersIds: (this.freekickWallPlayers || []).map(p => this.getPlayerIdentifier(p)),
            _stickyPrimaryChasers: this._stickyPrimaryChasers ? {
                A: this.getPlayerIdentifier(this._stickyPrimaryChasers.A),
                B: this.getPlayerIdentifier(this._stickyPrimaryChasers.B),
            } : {A: null, B: null},
            _stickyActiveMarker: this._stickyActiveMarker ? {
                A: this.getPlayerIdentifier(this._stickyActiveMarker.A),
                B: this.getPlayerIdentifier(this._stickyActiveMarker.B),
            } : {A: null, B: null},
            playbackElapsedTicks: this.playbackElapsedTicks || 0,
            rngState: this.rngState || 0,
            matchDuration: this.matchDuration,
        };
        return snap;
    }

    setSnapshot(snapshot) {
        if (!snapshot || snapshot.version !== 1) {
            console.warn('[Snapshot] Invalid version');
            return false;
        }

        // Restore scalars
        Object.assign(this, {
            seed: snapshot.seed ?? this.seed,
            matchTimer: snapshot.matchTimer ?? 0,
            scoreA: snapshot.scoreA ?? 0,
            scoreB: snapshot.scoreB ?? 0,
            kickoffTeam: snapshot.kickoffTeam || 'A',
            goalScoredTeam: snapshot.goalScoredTeam || '',
            halfTimeTriggered: !!snapshot.halfTimeTriggered,
            setPieceType: snapshot.setPieceType || '',
            setPieceSide: snapshot.setPieceSide || '',
            setPieceX: snapshot.setPieceX || 0,
            setPieceY: snapshot.setPieceY || 0,
            setPieceCornerY: snapshot.setPieceCornerY || 0,
            setPieceReadyPhase: !!snapshot.setPieceReadyPhase,
            setPieceIndirect: !!snapshot.setPieceIndirect,
            stateTimer: snapshot.stateTimer || 0,
            xgA: snapshot.xgA || 0, xgB: snapshot.xgB || 0,
            progressivePassesA: snapshot.progressivePassesA || 0,
            progressivePassesB: snapshot.progressivePassesB || 0,
            playbackElapsedTicks: snapshot.playbackElapsedTicks || 0,
            rngState: snapshot.rngState || 0,
            matchDuration: snapshot.matchDuration || this.matchDuration,
        });

        // Restore player references
        const findPlayer = (id) => id ? this.players.find(p => this.getPlayerIdentifier(p) === id) : null;

        this.lastTouchPlayer = findPlayer(snapshot.lastTouchPlayerId);
        this.cardedPlayer = findPlayer(snapshot.cardedPlayerId);
        this.fouledPlayer = findPlayer(snapshot.fouledPlayerId);
        this.throwInTaker = findPlayer(snapshot.throwInTakerId);

        if (snapshot._pendingFoulOutcome) {
            const po = snapshot._pendingFoulOutcome;
            this._pendingFoulOutcome = {
                kickingTeam: po.kickingTeam,
                showCard: po.showCard,
                cardType: po.cardType,
                isPenalty: !!po.isPenalty,
                tackler: findPlayer(po.tacklerId),
            };
        } else {
            this._pendingFoulOutcome = null;
        }

        if (snapshot._pendingAdvantage) {
            const pa = snapshot._pendingAdvantage;
            this._pendingAdvantage = {
                kickingTeam: pa.kickingTeam,
                showCard: pa.showCard,
                cardType: pa.cardType,
                isPenalty: !!pa.isPenalty,
                foulX: pa.foulX,
                foulY: pa.foulY,
                setPieceSide: pa.setPieceSide,
                timer: pa.timer,
                tackler: findPlayer(pa.tacklerId),
                fouledPlayer: findPlayer(pa.fouledPlayerId),
            };
        } else {
            this._pendingAdvantage = null;
        }

        this.freekickWallPlayers = (snapshot.freekickWallPlayersIds || [])
                .map(id => findPlayer(id)).filter(Boolean);

        this._stickyPrimaryChasers = {
            A: findPlayer(snapshot._stickyPrimaryChasers?.A),
            B: findPlayer(snapshot._stickyPrimaryChasers?.B),
        };
        this._stickyActiveMarker = {
            A: findPlayer(snapshot._stickyActiveMarker?.A),
            B: findPlayer(snapshot._stickyActiveMarker?.B),
        };

        // Restore all players
        for (const pData of snapshot.players || []) {
            const p = findPlayer(pData.id);
            if (!p)
                continue;

            Object.assign(p, {
                x: pData.x, y: pData.y, z: pData.z || 0,
                vx: pData.vx || 0, vy: pData.vy || 0, vz: pData.vz || 0,
                orientation: pData.orientation || 0,
                frame: pData.frame || 0,
                currentStamina: pData.currentStamina ?? 1,
                isSentOff: !!pData.isSentOff,
                isSubbedOut: !!pData.isSubbedOut,
                isSubbedIn: !!pData.isSubbedIn,
                yellowCards: pData.yellowCards || 0,
                actionTimer: pData.actionTimer || 0,
                isWalkingToSetPiece: !!pData.isWalkingToSetPiece,
                setPieceTarget: pData.setPieceTarget || null,
                baseX: pData.baseX || p.baseX,
                baseY: pData.baseY || p.baseY,
                formationBaseX: pData.formationBaseX || p.formationBaseX,
                formationBaseY: pData.formationBaseY || p.formationBaseY,
                defaultRegionId: pData.defaultRegionId,
                homeRegionId: pData.homeRegionId,
                regionFineOffsetX: pData.regionFineOffsetX || 0,
                regionFineOffsetY: pData.regionFineOffsetY || 0,
            });

            // Restore player FSM state
            if (p.fsm && pData.playerState) {
                const stateName = pData.playerState;
                const map = {
                    idle: 'Idle', dribble: 'Dribble', pass: 'Pass', shoot: 'Shoot',
                    tackle: 'Tackle', slide: 'Slide', goalkeeper: 'Goalkeeper',
                };
                const key = map[stateName.toLowerCase()] || stateName;
                if (PlayerStates[key])
                    p.fsm.changeState(PlayerStates[key]);
            }
        }

        // Restore ball
        if (snapshot.ball && this.ball) {
            Object.assign(this.ball, {
                x: snapshot.ball.x, y: snapshot.ball.y, z: snapshot.ball.z || 0,
                vx: snapshot.ball.vx || 0, vy: snapshot.ball.vy || 0, vz: snapshot.ball.vz || 0,
            });
            this.ball.owner = findPlayer(snapshot.ball.ownerId);
            this.ball.ifkActive = !!snapshot.ball.ifkActive;
            this.ball.ifkTaker = findPlayer(snapshot.ball.ifkTakerId);
            if (this.ball.owner)
                this.ball.syncToOwner();
        }

        // Restore match FSM
        if (this.fsm && snapshot.currentMatchState) {
            const key = _matchStateNameToKey(snapshot.currentMatchState);
            const target = key ? MatchStates[key] : null;
            if (target && !this.fsm.isInState(target)) {
                this.fsm.changeState(target);
            }
        }

        this._scoreboardCache = {flagA: null, flagB: null, displayA: null, displayB: null};

        console.log('[Snapshot] Exact frame restored successfully');
        return true;
    }
}

module.exports = { Simulator, MatchStates, TeamCodes, REPLAY_LOGIC_DT };
