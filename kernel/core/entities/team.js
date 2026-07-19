const { GameObject } = require('./gameobject.js');
const { Settings } = require('../../settings.js');
const { Utils } = require('../lib/utils.js');
const { Time } = require('../lib/time.js');
const { StateMachine } = require('../lib/fsm.js');
const {
    TeamStates,
    POSTURE_DEPTH_REF,
    POSTURE_HOLD_BIAS,
    resolveTeamStateFromMatch
} = require('./team_states.js');
const {
    bindPlayerHomeRegion,
    computeHomeFromRegion,
    POSTURE_REGION_COL_DELTA
} = require('../lib/pitch_regions.js');
const {
    Player,
    ai,
    attacksRightGoal,
    isPassReceiverAhead,
    isTeammateOpen,
    scorePassTarget,
    choosePassType,
    getPassReceiverPosition,
    dist2d,
    canPressCarrier,
    computePressPriority,
    getAheadDelta,
    isCarrierInDangerZone,
    isThreatened,
    getThreatInfo,
    getNearestOpponent
} = require('./player.js');
const {
    estimatePassGroundSpeed,
    isPassSafeFromOpponent: passSafeFromOpponent,
    isPassSafeFromAllOpponents: passSafeFromAllOpponents,
    pickBestSafePassTarget,
    getBestPassToReceiver,
    getTangentPoints,
    canShoot: canShootPure,
    estimateShotGroundSpeed
} = require('../lib/pass_safety.js');
const { SupportSpotCalculator } = require('../lib/support_spots.js');
const {
    createMarkingRegulator,
    computeMarkingAssignments,
    computeCoverPoint,
    resolveOwnGoal
} = require('../lib/marking.js');
const {
    PlayPhase,
    getPhaseMods,
    resolveTeamPlayPhase
} = require('../lib/play_phase.js');
const { SoccerMsg } = require('../lib/soccer_messages.js');
const { dispatchSoccerMsg } = require('../lib/message_dispatcher.js');

/** Max squad size including goalkeeper (FIFA 11-a-side). */
const MAX_PLAYERS = 11;

/** Roles that may be assigned as primary support runner (attackers + advanced mids). */
function isSupportCandidateRole(role) {
    if (!role || role === 'GK') return false;
    return /S|CF|ST|LW|RW|AM|CAM|SS|CM|LCM|RCM|LM|RM|F|W|WF/i.test(role);
}

/**
 * Role weight for posture depth (home-region push is stronger for attackers).
 * @param {string} role
 */
function roleDepthMultiplier(role) {
    if (!role || role === 'GK') return 0;
    if (/CB|LB|RB|LCB|RCB|LWB|RWB|DM|CDM/i.test(role)) return 0.35;
    if (/CM|LCM|RCM|LM|RM|AM|CAM/i.test(role)) return 0.75;
    return 1.0;
}

/**
 * Team — scene-graph node owning up to 11 Player children (incl. GK).
 *
 * Hierarchy (scene graph + future ECS scripts):
 *   Simulator → Pitch → Team → Player
 *
 * Team-scoped tactics (closest-to-ball, pass selection, formation bases, posture FSM)
 * live here so Player stays focused on per-agent FSM / motion / render.
 * Scripts are not attached yet; insertScript remains available for future
 * TeamAI / SupportSpot components.
 */
class Team extends GameObject {
    /**
     * @param {string} teamKey - Side id 'A' or 'B' (used by Settings.AI and match state)
     * @param {string} [nationName=''] - Display / palette nation name
     */
    constructor(teamKey, nationName = '') {
        super(teamKey === 'A' ? 'TeamA' : 'TeamB');
        this.teamKey = teamKey;
        this.nationName = nationName;
        this.formationName = '4-4-2';

        /** @type {import('./player.js').Player[]} explicit roster (also in this.children) */
        this.players = [];
        this.bench = [];
        this.substitutionsMade = 0;

        /** Opposing Team instance (set by Pitch / Simulator after both exist) */
        this.opponents = null;

        // Key-player bookkeeping (single source of truth per tick)
        this.controllingPlayer = null;
        this.supportingPlayer = null;
        this.receivingPlayer = null;
        this.playerClosestToBall = null;
        this.closestDistToBallSq = Infinity;
        /** Sticky primary presser when this team is defending / chasing loose ball */
        this.stickyPrimaryChaser = null;

        /**
         * A.2 Marking: pairs of { marker, target, score } for free attackers.
         * Updated on markingRegulator while Defending.
         * @type {Array<{ marker: object, target: object, score?: number }>}
         */
        this.markingPairs = [];
        /** @type {Map<object, object>} marker → mark target */
        this.markingMap = new Map();
        /** @type {import('../lib/logic_regulator.js').TickRegulator} */
        this.markingRegulator = createMarkingRegulator(this);
        /** Cached own goal for cover geometry (refreshed with assignments) */
        this._markOwnGoalX = 0;
        this._markOwnGoalY = 0;

        /**
         * A.3 possession phase (build / progress / finish / none).
         * Soft modifier while Attacking — not a separate FSM.
         * @type {string}
         */
        this.playPhase = PlayPhase.NONE;

        /**
         * A.4 counterpress — logic seconds remaining after loss of possession.
         * Nearest 2–3 surge-press; non-surge delay deep defensive drop.
         * @type {number}
         */
        this.transitionTimer = 0;
        /** @type {object[]} last surge chaser set while counterpressing */
        this.counterpressSurge = [];

        // Posture (driven by TeamStates; does not write Settings.AI)
        this.postureName = 'kickoffprepare';
        /** @type {number} reference-field X bias (+ toward opp goal) */
        this.depthBiasRef = POSTURE_DEPTH_REF.kickoffprepare;
        /** @type {number} additive FORMATION_HOLD for this squad only */
        this.postureHoldBias = POSTURE_HOLD_BIAS.kickoffprepare;

        this.fsm = new StateMachine(this);
        // setCurrentState avoids enter side-effects before the level is wired
        this.fsm.setCurrentState(TeamStates.KickoffPrepare);

        /** Support spot calculator — sweet spots for primary support runner */
        this.supportSpots = new SupportSpotCalculator(this);
        /** Last player messaged for SupportAttacker (avoid spam) */
        this._lastSupportMsgPlayer = null;
        /**
         * Team-wide RequestPass gate (logic seconds remaining).
         * Limits Msg_PassToMe spam independently of play speed.
         */
        this.passRequestCooldown = 0;
        /** @type {object|null} last requester that passed safety + gate */
        this.lastPassRequester = null;
        /** Region column shift for posture (toward attack when positive) */
        this.homeRegionColumnDelta = 0;

        /**
         * Home / opponents goal pointers (re-resolved each half via wireGoals
         * or getters that consult Pitch + isSecondHalf).
         * @type {import('./goal.js').Goal|null}
         */
        this.homeGoal = null;
        /** @type {import('./goal.js').Goal|null} */
        this.opponentsGoal = null;
    }

    /**
     * Wire homeGoal / opponentsGoal from Pitch fixed goals.
     * Call after ensureGoals and whenever ends swap (halftime).
     * @param {import('./pitch.js').Pitch|null} [pitch]
     */
    wireGoals(pitch = null) {
        const p = pitch || (this.parent && this.parent.leftGoal != null ? this.parent : null)
            || (this.level && this.level.pitch) || null;
        if (!p || !p.leftGoal || !p.rightGoal) {
            this.homeGoal = null;
            this.opponentsGoal = null;
            return;
        }
        const level = this.level;
        const second = level && typeof level.isSecondHalf === 'function'
            ? level.isSecondHalf()
            : false;
        // 1st half: A defends left, B defends right; 2nd half swapped.
        if (this.teamKey === 'A') {
            this.homeGoal = second ? p.rightGoal : p.leftGoal;
            this.opponentsGoal = second ? p.leftGoal : p.rightGoal;
        } else {
            this.homeGoal = second ? p.leftGoal : p.rightGoal;
            this.opponentsGoal = second ? p.rightGoal : p.leftGoal;
        }
    }

    /**
     * Resolve opponents goal (half-aware; re-wires each call so HT side swap is live).
     * @returns {import('./goal.js').Goal|null}
     */
    getOpponentsGoal() {
        this.wireGoals();
        return this.opponentsGoal;
    }

    /**
     * Resolve home (defended) goal (half-aware).
     * @returns {import('./goal.js').Goal|null}
     */
    getHomeGoal() {
        this.wireGoals();
        return this.homeGoal;
    }

    /**
     * Distance from point (or player) to opponent goal mouth center.
     * @param {{ x: number, y: number }|number} xOrPos
     * @param {number} [y]
     */
    distToOpponentsGoal(xOrPos, y) {
        const goal = this.getOpponentsGoal();
        let x;
        let py;
        if (typeof xOrPos === 'object' && xOrPos) {
            x = xOrPos.x;
            py = xOrPos.y;
        } else {
            x = xOrPos;
            py = y;
        }
        if (goal) return goal.distanceTo(x, py);
        const gx = this.getOpponentsGoalX();
        const field = Utils.getFieldBounds();
        const dx = gx - x;
        const dy = field.centerY - py;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Level root (Simulator). */
    get level() {
        return this.getRoot();
    }

    /** Active squad members (not sent off). */
    members(includeSentOff = false) {
        if (includeSentOff) return this.players.slice();
        return this.players.filter(p => !p.isSentOff);
    }

    getGoalkeeper(includeSentOff = false) {
        return this.players.find(p => p.role === 'GK' && (includeSentOff || !p.isSentOff))
            || this.players.find(p => p.role === 'GK')
            || null;
    }

    getOutfieldPlayers(includeSentOff = false) {
        return this.players.filter(p => p.role !== 'GK' && (includeSentOff || !p.isSentOff));
    }

    /**
     * Remove all Player children and clear roster.
     * Non-player children (future scripts as objects, markers, etc.) are kept.
     */
    clearPlayers() {
        const remaining = [];
        for (const child of this.children) {
            if (child instanceof Player) {
                child.parent = null;
                child.active = false;
            } else {
                remaining.push(child);
            }
        }
        this.children = remaining;
        this.players = [];
        this.controllingPlayer = null;
        this.supportingPlayer = null;
        this.receivingPlayer = null;
        this.playerClosestToBall = null;
        this.closestDistToBallSq = Infinity;
        this.stickyPrimaryChaser = null;
        this._lastSupportMsgPlayer = null;
        this.clearMarking();
        if (this.supportSpots) {
            this.supportSpots.bestSpot = null;
            this.supportSpots.spots = [];
            this.supportSpots._fieldKey = null;
        }
    }

    /**
     * Build up to 11 players from a formation preset and insert as children.
     *
     * @param {object} opts
     * @param {Array} opts.formation - 11 formation slots { x, y, role }
     * @param {Array|null} opts.teamStatsList - per-slot stats from player_stats.json
     * @param {object} opts.defaultStats - fallback stats
     * @param {string} opts.code - FIFA 3-letter prefix for jersey names
     */
    createPlayers({ formation, teamStatsList = null, defaultStats = {}, code = 'XXX' }) {
        if (!formation || formation.length !== 11) {
            throw new Error(`Team ${this.teamKey}: formation must define 11 slots`);
        }

        this.clearPlayers();

        const count = Math.min(MAX_PLAYERS, formation.length);
        for (let i = 0; i < count; i++) {
            const item = formation[i];
            const pName = `${code} ${i + 1}`;

            let stats = null;
            if (teamStatsList && teamStatsList[i]) {
                stats = Object.assign({}, teamStatsList[i]);
            } else {
                stats = Object.assign({}, defaultStats);
                if (item.role === 'GK') {
                    stats.goalkeeping = 85;
                }
            }

            const player = new Player(pName, this.teamKey, item.role, stats);
            player.formationIndex = i;

            if (this.teamKey === 'A') {
                player.baseX = Utils.scaleFieldX(item.x);
                player.baseY = Utils.scaleFieldY(item.y);
            } else {
                player.baseX = Utils.scaleFieldX(Settings.REFERENCE_FIELD_WIDTH - item.x);
                player.baseY = Utils.scaleFieldY(Settings.REFERENCE_FIELD_HEIGHT - item.y);
            }
            // Authored formation home (before region column shifts)
            player.formationBaseX = player.baseX;
            player.formationBaseY = player.baseY;

            this.players.push(player);
            this.insertChild(player);
        }
        this.createBenchPlayers({ code, defaultStats, teamStatsList });
        this.bindAndApplyHomeRegions();
    }

    createBenchPlayers({ code, defaultStats, teamStatsList }) {
        this.bench = [];
        this.substitutionsMade = 0;

        // Load bench players from the JSON stats list if available
        if (teamStatsList && teamStatsList.length > 11) {
            for (let i = 11; i < teamStatsList.length; i++) {
                const stats = Object.assign({}, teamStatsList[i]);
                const role = stats.role || 'MF';
                const jerseyNum = stats.jersey || (i + 1);
                const pName = `${code} ${jerseyNum}`;
                const subPlayer = new Player(pName, this.teamKey, role, stats);
                subPlayer.level = this.getRoot();
                this.bench.push(subPlayer);
            }
        }
    }

    /**
     * Pitch region grid from parent Pitch (or build ad-hoc if missing).
     * @returns {Array|null}
     */
    getPitchRegions() {
        const pitch = this.parent;
        if (pitch && typeof pitch.ensureRegions === 'function') {
            return pitch.ensureRegions();
        }
        if (pitch && pitch.regions) return pitch.regions;
        // Fallback for unit tests without a full Pitch
        const { createPitchRegions, configuredGrid } = require('../lib/pitch_regions.js');
        const field = Utils.getFieldBounds();
        const { cols, rows } = configuredGrid();
        return createPitchRegions(field, cols, rows);
    }

    /**
     * Bind default regions from formation bases, then apply current posture shift.
     */
    bindAndApplyHomeRegions() {
        const regions = this.getPitchRegions();
        if (!regions || !regions.length) return;
        for (const p of this.players) {
            if (p.formationBaseX == null) {
                p.formationBaseX = p.baseX;
                p.formationBaseY = p.baseY;
            }
            bindPlayerHomeRegion(p, regions);
        }
        this.applyHomeRegions();
    }

    /**
     * Reassign player baseX/baseY from region center + fine offset (home region).
     * Called on posture change and after formation recalculation.
     */
    applyHomeRegions() {
        const regions = this.getPitchRegions();
        if (!regions || !regions.length) return;
        const level = this.level;
        const attacksRight = level && typeof level.isSecondHalf === 'function'
            ? attacksRightGoal(level, this.teamKey)
            : (this.teamKey === 'A');
        const posture = this.postureName || 'kickoffprepare';

        for (const p of this.players) {
            if (p.isSentOff) continue;
            const home = computeHomeFromRegion(p, regions, posture, attacksRight);
            if (!home) continue;
            p.homeRegionId = home.homeRegionId;
            p.baseX = home.baseX;
            p.baseY = home.baseY;
        }
    }

    /**
     * Recompute baseX/baseY (and role) from formation after multiplier/formation changes.
     * @param {Array} formation
     */
    recalculateReferencePositions(formation) {
        if (!formation) return;
        const refW = Settings.REFERENCE_FIELD_WIDTH || 100;
        const refH = Settings.REFERENCE_FIELD_HEIGHT || 100;

        for (const player of this.players) {
            if (player.isSentOff || player.formationIndex === undefined) continue;
            const item = formation[player.formationIndex];
            if (!item) continue;

            player.role = item.role;
            if (this.teamKey === 'A') {
                player.formationBaseX = Utils.scaleFieldX(item.x);
                player.formationBaseY = Utils.scaleFieldY(item.y);
            } else {
                player.formationBaseX = Utils.scaleFieldX(refW - item.x);
                player.formationBaseY = Utils.scaleFieldY(refH - item.y);
            }
            player.baseX = player.formationBaseX;
            player.baseY = player.formationBaseY;
        }
        this.bindAndApplyHomeRegions();
    }

    /** Mirror home bases across field centre (halftime side swap). */
    swapSides(field) {
        const w = field.width;
        const h = field.height;
        for (const p of this.players) {
            if (p.formationBaseX != null) {
                p.formationBaseX = w - p.formationBaseX;
                p.formationBaseY = h - p.formationBaseY;
            }
            p.baseX = w - p.baseX;
            p.baseY = h - p.baseY;
        }
        // Rebind default regions on the mirrored field and re-apply posture
        this.bindAndApplyHomeRegions();
        // Home/opp goals swap ends with the half (pointers re-resolved from Pitch)
        this.wireGoals();
    }

    /**
     * True if player has an opponent inside comfort zone.
     * @param {object} player
     * @param {number} [radius]
     */
    isPlayerThreatened(player, radius) {
        return isThreatened(player, radius);
    }

    /**
     * Shared threat info (nearest opp, comfort/pressure bands) for tactics / debug.
     * @param {object} player
     */
    getPlayerThreatInfo(player) {
        return getThreatInfo(player);
    }

    /**
     * Nearest opposing outfielder to player (comfort-zone queries).
     * @param {object} player
     */
    getNearestOpponentTo(player) {
        return getNearestOpponent(player);
    }

    /**
     * Closest roster player to a world point.
     * @param {number} x
     * @param {number} y
     * @param {{ outfieldOnly?: boolean, exclude?: object|null }} [opts]
     */
    findClosestPlayer(x, y, opts = {}) {
        const { outfieldOnly = false, exclude = null } = opts;
        let best = null;
        let minDist = Infinity;
        for (const p of this.players) {
            if (p.isSentOff) continue;
            if (outfieldOnly && p.role === 'GK') continue;
            if (exclude && p === exclude) continue;
            const d = dist2d(p.x, p.y, x, y);
            if (d < minDist) {
                minDist = d;
                best = p;
            }
        }
        return best;
    }

    /** Nearest outfield player for set-piece taker selection. */
    findSetPieceTaker(x, y) {
        return this.findClosestPlayer(x, y, { outfieldOnly: true });
    }

    /** Active opposing players (sent-off excluded). */
    getOpponentPool() {
        if (this.opponents) return this.opponents.members();
        const level = this.level;
        if (!level || !level.players) return [];
        return level.players.filter(p => p.team !== this.teamKey && !p.isSentOff);
    }

    /**
     * True if pass lane cannot be cut by one defender.
     * @param {{ x: number, y: number }} from
     * @param {{ x: number, y: number }} target
     * @param {{ x: number, y: number }|null} receiver
     * @param {object} opp
     * @param {number} passSpeed
     */
    isPassSafeFromOpponent(from, target, receiver, opp, passSpeed) {
        return passSafeFromOpponent(from, target, receiver, opp, passSpeed);
    }

    /**
     * True if pass lane is safe against all opponents.
     * @param {{ x: number, y: number }} from
     * @param {{ x: number, y: number }} target
     * @param {{ x: number, y: number }|null} receiver
     * @param {number} passSpeed
     * @param {Array} [opponents] - defaults to opposing squad
     */
    isPassSafeFromAllOpponents(from, target, receiver, passSpeed, opponents) {
        const pool = opponents || this.getOpponentPool();
        return passSafeFromAllOpponents(from, target, receiver, pool, passSpeed);
    }

    /**
     * Prefer a pass-safe candidate; fall back to best unsafe if none are clear.
     * @param {object} passer
     * @param {Array} candidates
     * @param {{ passType?: string, scoreFn?: function }} [opts]
     */
    pickBestSafePassTarget(passer, candidates, opts = {}) {
        return pickBestSafePassTarget(passer, candidates, this.getOpponentPool(), opts);
    }

    /** Opponent goal line X for lead-pass “closest to goal” scoring. */
    getOpponentsGoalX() {
        const goal = this.getOpponentsGoal();
        if (goal) return goal.lineX;
        const field = Utils.getFieldBounds();
        const level = this.level;
        if (level && typeof level.isSecondHalf === 'function') {
            return attacksRightGoal(level, this.teamKey) ? field.width : 0;
        }
        return this.teamKey === 'A' ? field.width : 0;
    }

    /**
     * Best in-bounds, pass-safe aim point for a teammate.
     * @param {object} passer
     * @param {object} receiver
     * @param {{ passType?: string, supportPoint?: {x,y}|null }} [opts]
     * @returns {{ x: number, y: number }|null}
     */
    getBestPassToReceiver(passer, receiver, opts = {}) {
        const from = { x: passer.x, y: passer.y };
        return getBestPassToReceiver(from, receiver, passer, this.getOpponentPool(), {
            passType: opts.passType || 'short',
            oppGoalX: this.getOpponentsGoalX(),
            supportPoint: opts.supportPoint != null
                ? opts.supportPoint
                : getPassReceiverPosition(receiver, passer, passer.level),
            preferFeet: !!opts.preferFeet,
            detail: !!opts.detail
        });
    }

    /**
     * Sample goal mouth; true if a safe, reachable path exists.
     *
     * @param {{ x: number, y: number }|null} [ballPos] - defaults to level.ball or shooter
     * @param {object|null} [shooter] - power / context; defaults not used if ballPos given alone
     * @param {{
     *   power?: number,
     *   numAttempts?: number,
     *   sampleYs?: number[],
     *   random?: function,
     *   allowContested?: boolean,
     *   requireSafe?: boolean
     * }} [opts]
     * @returns {{ ok: boolean, target: {x:number,y:number}|null, power: number, contested?: boolean, soft?: boolean }}
     */
    canShoot(ballPos, shooter = null, opts = {}) {
        const level = this.level;
        const ball = level && level.ball;
        let from = ballPos;
        if (!from && ball) {
            from = { x: ball.x, y: ball.y };
        }
        if (!from && shooter) {
            from = { x: shooter.x, y: shooter.y };
        }
        if (!from) {
            return { ok: false, target: null, power: 0 };
        }

        const striker = shooter
            || (ball && ball.owner && ball.owner.team === this.teamKey ? ball.owner : null)
            || this.controllingPlayer;

        const oppGoal = this.getOpponentsGoal();
        return canShootPure(from, striker, this.getOpponentPool(), {
            oppGoalX: this.getOpponentsGoalX(),
            goal: oppGoal || undefined,
            power: opts.power,
            numAttempts: opts.numAttempts,
            sampleYs: opts.sampleYs,
            random: opts.random,
            allowContested: opts.allowContested,
            requireSafe: opts.requireSafe
        });
    }

    /**
     * Best supporting spot (world coords) or null if not computed yet.
     * @returns {{ x: number, y: number, score?: number }|null}
     */
    getBestSupportSpot() {
        return this.supportSpots ? this.supportSpots.getBestSupportingSpot() : null;
    }

    /**
     * Closest eligible outfielder to the best support spot (not the controller).
     * Closest eligible support runner to best spot — attackers/mids preferred.
     * @returns {object|null}
     */
    determineBestSupportingAttacker() {
        const spot = this.getBestSupportSpot();
        if (!spot) return null;
        const controller = this.controllingPlayer;
        let best = null;
        let bestD = Infinity;

        for (const p of this.getOutfieldPlayers()) {
            if (p === controller) continue;
            if (!isSupportCandidateRole(p.role)) continue;
            const d = (p.x - spot.x) * (p.x - spot.x) + (p.y - spot.y) * (p.y - spot.y);
            if (d < bestD) {
                bestD = d;
                best = p;
            }
        }

        // Fallback: any outfielder if no role match
        if (!best) {
            for (const p of this.getOutfieldPlayers()) {
                if (p === controller) continue;
                const d = (p.x - spot.x) * (p.x - spot.x) + (p.y - spot.y) * (p.y - spot.y);
                if (d < bestD) {
                    bestD = d;
                    best = p;
                }
            }
        }
        return best;
    }

    /**
     * Rescore support grid (throttled) and assign primary supportingPlayer.
     * Call while team is Attacking / in control.
     * @param {{ force?: boolean }} [opts]
     */
    updateSupportSpots(opts = {}) {
        if (!this.supportSpots) return;
        if (!this.inControl() || !this.controllingPlayer) {
            this.supportingPlayer = null;
            return;
        }

        const level = this.level;
        const attacksRight = level && typeof level.isSecondHalf === 'function'
            ? attacksRightGoal(level, this.teamKey)
            : (this.teamKey === 'A');

        // Keep phase current so support width / can-score weights track thirds
        this.updatePlayPhase(level && level.ball);

        this.supportSpots.determineBestSupportingPosition({
            controller: this.controllingPlayer,
            opponents: this.getOpponentPool(),
            oppGoalX: this.getOpponentsGoalX(),
            attacksRight,
            force: !!opts.force,
            phaseMods: this.getPlayPhaseMods()
        });

        const prevSupport = this.supportingPlayer;
        this.supportingPlayer = this.determineBestSupportingAttacker();
        this._notifySupportAttacker(prevSupport, !!opts.force);
    }

    /**
     * Dispatch Msg_SupportAttacker when the designated supporter changes or on force.
     * @param {object|null} prevSupport
     * @param {boolean} force
     */
    _notifySupportAttacker(prevSupport, force) {
        const level = this.level;
        const next = this.supportingPlayer;
        const spot = this.getBestSupportSpot();
        if (!next || !spot) {
            this._lastSupportMsgPlayer = null;
            return;
        }
        const changed = next !== prevSupport || next !== this._lastSupportMsgPlayer;
        if (!force && !changed) {
            // Soft-update target if already supporting
            if (next.supportTarget) {
                next.supportTarget.x = spot.x;
                next.supportTarget.y = spot.y;
            }
            return;
        }
        dispatchSoccerMsg(level, 0, this, next, SoccerMsg.SupportAttacker, {
            target: { x: spot.x, y: spot.y }
        });
        this._lastSupportMsgPlayer = next;
    }

    /**
     * Msg_GoHome / Msg_Wait to squad (kickoff / set-piece coordination).
     * @param {'GoHome'|'Wait'} kind
     * @param {{ exclude?: object|null }} [opts]
     */
    broadcastFormationMessage(kind, opts = {}) {
        const level = this.level;
        const msg = kind === 'Wait' ? SoccerMsg.Wait : SoccerMsg.GoHome;
        const exclude = opts.exclude || null;
        for (const p of this.getOutfieldPlayers()) {
            if (p === exclude) continue;
            const extra = msg === SoccerMsg.GoHome
                ? { target: { x: p.baseX, y: p.baseY } }
                : null;
            dispatchSoccerMsg(level, 0, this, p, msg, extra);
        }
    }

    /**
     * Best short/long pass receiver for a passer.
     * Lead-pass geometry (tangents + feet + support) + pass safety; openness scores quality.
     * @param {import('./player.js').Player} passer
     * @returns {{ teammate: object, type: string, aim: {x:number,y:number} }|null}
     */
    findBestPassTarget(passer, opts = {}) {
        // Phase tracks ball zone for pass-length / receiver bias (A.3)
        this.updatePlayPhase(this.level && this.level.ball);
        const mods = this.getPlayPhaseMods();

        const teammates = this.getOutfieldPlayers().filter(p => p !== passer);
        const shortPassMin = Team._aiShortPassMin(passer);
        const longPassMax = Team._aiLongPassMax(passer);
        const opponents = this.getOpponentPool();
        const from = { x: passer.x, y: passer.y };
        const oppGoalX = this.getOpponentsGoalX();
        let bestShort = null;
        let bestLong = null;
        let bestShortScore = -Infinity;
        let bestLongScore = -Infinity;

        const passTypeOverride = opts.passType;
        for (const teammate of teammates) {
            if (teammate === passer.lastPassFrom && passer.passLinkCooldown > 0) continue;
            if (!isPassReceiverAhead(passer, teammate, passer.level)) continue;

            const support = getPassReceiverPosition(teammate, passer, passer.level);
            const dx = support.x - passer.x;
            const dy = support.y - passer.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const teammateDist = Math.sqrt(
                Math.pow(teammate.x - passer.x, 2) + Math.pow(teammate.y - passer.y, 2)
            );
            if (teammateDist < shortPassMin || dist < shortPassMin) continue;
            if (dist > longPassMax) continue;

            const open = isTeammateOpen(passer.level, teammate, 3.2);
            let passType = passTypeOverride;
            if (passType) {
                if (passType === 'short' && dist > longPassMax * 0.45) continue;
                if (passType === 'long' && dist < shortPassMin * 1.5) continue;
            } else {
                passType = choosePassType(dist, open, passer);
                if (!passType) {
                    if (dist <= longPassMax * 0.45) passType = 'short';
                    else continue;
                }
            }

            // Lead geometry: progressive / through-ball aims (A.7); must be safe + in-bounds
            const aimDetail = getBestPassToReceiver(from, teammate, passer, opponents, {
                passType,
                oppGoalX,
                supportPoint: support,
                detail: true
            });
            if (!aimDetail) continue;
            const aim = { x: aimDetail.x, y: aimDetail.y };

            const aimDist = Math.sqrt(
                Math.pow(aim.x - passer.x, 2) + Math.pow(aim.y - passer.y, 2)
            );
            let score = scorePassTarget(passer, teammate, aimDist, open);
            // A.7: reward progressive x-gain of the chosen aim + line-break through-balls
            if (typeof aimDetail.progressive === 'number') {
                score += Math.max(0, aimDetail.progressive) * 0.2 * (mods.forwardGainWeight || 1);
            }
            if (aimDetail.lineBreak) {
                const teamBonus = (Settings.AI && Settings.AI.THROUGH_BALL_TEAM_BONUS != null)
                    ? Settings.AI.THROUGH_BALL_TEAM_BONUS
                    : 2.5;
                score += teamBonus * (mods.longPassBias >= 1.05 || passType === 'long' ? 1.15 : 1);
            }
            // Phase length bias (short build-up vs progressive switches)
            if (passType === 'short') score *= mods.shortPassBias;
            else score *= mods.longPassBias;
            if (score < 5) continue;

            const decision = {
                teammate,
                type: passType,
                aim,
                progressive: aimDetail.progressive,
                lineBreak: !!aimDetail.lineBreak
            };
            if (passType === 'short' && score > bestShortScore) {
                bestShortScore = score;
                bestShort = decision;
            }
            if (passType === 'long' && score > bestLongScore) {
                bestLongScore = score;
                bestLong = decision;
            }
        }

        // Progress: slightly easier to pick long (switch); build needs higher long bar
        const longBar = 6 * (mods.longPassBias < 0.85 ? 1.25 : mods.longPassBias > 1.05 ? 0.85 : 1);
        const shortBar = 4 * (mods.shortPassBias > 1.15 ? 0.85 : 1);
        if (bestLongScore > longBar) return bestLong;
        if (bestShortScore > shortBar) return bestShort;
        return null;
    }

    findBestPassTeammate(passer) {
        const result = this.findBestPassTarget(passer);
        return result ? result.teammate : null;
    }

    /** Resolve LONG_PASS_MAX_DIST with team AI overrides + proxy scaling. */
    static _aiLongPassMax(passer) {
        return ai(passer).LONG_PASS_MAX_DIST;
    }

    /** Resolve SHORT_PASS_MIN_DIST with team AI overrides + proxy scaling. */
    static _aiShortPassMin(passer) {
        return ai(passer).SHORT_PASS_MIN_DIST;
    }

    /**
     * Refresh closest-to-ball cache.
     * @param {{ x: number, y: number }|null} ball
     */
    calculateClosestPlayerToBall(ball) {
        if (!ball) {
            this.playerClosestToBall = null;
            this.closestDistToBallSq = Infinity;
            return;
        }

        let closest = null;
        let closestSq = Infinity;
        for (const p of this.players) {
            if (p.isSentOff) continue;
            const dx = p.x - ball.x;
            const dy = p.y - ball.y;
            const dSq = dx * dx + dy * dy;
            if (dSq < closestSq) {
                closestSq = dSq;
                closest = p;
            }
        }
        this.playerClosestToBall = closest;
        this.closestDistToBallSq = closestSq;
    }

    /**
     * Set controlling player — also forces opponents.lostControl().
     * @param {object|null} player
     */
    setControllingPlayer(player) {
        this.controllingPlayer = player || null;
        // Owning the ball: not a presser — clear sticky chase + end our counterpress
        if (player) {
            this.stickyPrimaryChaser = null;
            this.transitionTimer = 0;
            this.counterpressSurge = [];
        }
        if (this.opponents && player) {
            this.opponents.lostControl();
        }
    }

    /**
     * Clear attack roles on loss of possession (not defensive press stickiness).
     * Starts A.4 counterpress only if this team actually had the ball (not first
     * touch by the opponent at kickoff).
     */
    lostControl() {
        const hadPossession = !!this.controllingPlayer
            || (this.fsm && this.fsm.isInState(TeamStates.Attacking));
        this.controllingPlayer = null;
        this.supportingPlayer = null;
        this.receivingPlayer = null;
        this._lastSupportMsgPlayer = null;
        this.lastPassRequester = null;
        this.playPhase = PlayPhase.NONE;
        if (hadPossession) {
            this.beginCounterpress();
        }
        // Marking is owned by the defending side (this team after loss);
        // force a refresh on next Defending tick via regulator.
        if (this.markingRegulator) this.markingRegulator.forceReady();
    }

    /**
     * Start / refresh transition window after losing the ball.
     * @param {number} [duration] - logic seconds; default Settings.AI.COUNTERPRESS_DURATION
     */
    beginCounterpress(duration) {
        const d = typeof duration === 'number' ? duration : ai(this.teamKey).COUNTERPRESS_DURATION;
        this.transitionTimer = Math.max(0, d);
        this.counterpressSurge = [];
    }

    /** Clear counterpress window (regain ball or expire). */
    clearCounterpress() {
        const was = this.transitionTimer > 0;
        this.transitionTimer = 0;
        this.counterpressSurge = [];
        // Full defensive drop once the surge window ends
        if (was && this.fsm && this.fsm.isInState(TeamStates.Defending)) {
            this.applyPosture('defending');
        }
    }

    /**
     * @returns {boolean}
     */
    isCounterpressing() {
        return this.transitionTimer > 0;
    }

    /**
     * Whether this player is one of the surge pressers in the current window.
     * @param {object} player
     */
    isCounterpressSurge(player) {
        if (!player || !this.isCounterpressing()) return false;
        if (this.counterpressSurge && this.counterpressSurge.includes(player)) return true;
        return this.stickyPrimaryChaser === player;
    }

    /**
     * Tick transition timer (logic time). Call from Team.update.
     * @param {number} [dt]
     */
    tickCounterpress(dt) {
        if (this.transitionTimer <= 0) return;
        const step = dt != null ? dt : (Time.deltaTime || 0);
        this.transitionTimer -= step;
        if (this.transitionTimer <= 0) {
            this.transitionTimer = 0;
            this.counterpressSurge = [];
            // Resume normal defend posture (deep homes) after window
            if (this.fsm && this.fsm.isInState(TeamStates.Defending)) {
                this.applyPosture('defending');
            }
        }
    }

    /**
     * A.3 — refresh coarse possession phase from ball zone (while in control).
     * @param {{ x: number, owner?: object|null }|null} [ball]
     */
    updatePlayPhase(ball) {
        const b = ball != null ? ball : (this.level && this.level.ball);
        if (!b || !this.inControl()) {
            // Own the ball even if controllingPlayer lag one tick
            if (!b || !b.owner || b.owner.team !== this.teamKey) {
                this.playPhase = PlayPhase.NONE;
                return this.playPhase;
            }
        }
        const level = this.level;
        const attacksRight = level && typeof level.isSecondHalf === 'function'
            ? attacksRightGoal(level, this.teamKey)
            : (this.teamKey === 'A');
        this.playPhase = resolveTeamPlayPhase(this, b, attacksRight);
        return this.playPhase;
    }

    /**
     * @returns {object} phase modifiers (see play_phase.PHASE_MODS)
     */
    getPlayPhaseMods() {
        return getPhaseMods(this.playPhase || PlayPhase.NONE);
    }

    /** Clear A.2 mark / cover assignments. */
    clearMarking() {
        this.markingPairs = [];
        if (this.markingMap) this.markingMap.clear();
        else this.markingMap = new Map();
        for (const p of this.players || []) {
            if (p) {
                p.markTarget = null;
                p.markCoverPoint = null;
            }
        }
    }

    /**
     * Rescore free-attacker threats and assign 1–2 markers (A.2).
     * Call while Defending with opponent on the ball.
     * @param {{ force?: boolean, excludePlayers?: object[] }} [opts]
     */
    updateMarking(opts = {}) {
        const ball = this.level && this.level.ball;
        if (!ball || !ball.owner || ball.owner.team === this.teamKey) {
            this.clearMarking();
            return;
        }
        if (ball.owner.role === 'GK') {
            this.clearMarking();
            return;
        }

        if (!opts.force && this.markingRegulator && !this.markingRegulator.isReady()) {
            // Soft-refresh cover points every other logic tick (marks move slowly)
            this._markSoftRefreshParity = 1 - (this._markSoftRefreshParity || 0);
            if (this._markSoftRefreshParity) {
                this._refreshMarkCoverPoints();
            }
            return;
        }

        // Exclude active press chasers so markers don't double as ball hunters.
        // Do NOT call getPressChasers here — it mutates sticky primary selection.
        let exclude = opts.excludePlayers ? opts.excludePlayers.slice() : [];
        if (this.stickyPrimaryChaser && !exclude.includes(this.stickyPrimaryChaser)) {
            exclude.push(this.stickyPrimaryChaser);
        }
        const pressDist = ai(this.teamKey).PRESS_SECOND_CHASER_DIST;
        const carrier = ball.owner;
        for (const p of this.getOutfieldPlayers()) {
            if (!p || exclude.includes(p)) continue;
            // Players currently chasing the ball
            if (p.fsm && typeof p.fsm.getNameOfCurrentState === 'function'
                && p.fsm.getNameOfCurrentState() === 'ChaseBall') {
                exclude.push(p);
                continue;
            }
            // Near-ball secondary pressers (distance only — no sticky mutation)
            if (dist2d(p.x, p.y, carrier.x, carrier.y) < pressDist * 0.85) {
                exclude.push(p);
            }
        }

        const { pairs, ownGoalX, ownGoalY } = computeMarkingAssignments(this, {
            force: !!opts.force,
            excludePlayers: exclude,
            prevPairs: this.markingPairs
        });

        this._markOwnGoalX = ownGoalX;
        this._markOwnGoalY = ownGoalY;

        // Clear previous mark tags
        for (const p of this.players || []) {
            if (p) {
                p.markTarget = null;
                p.markCoverPoint = null;
            }
        }

        this.markingPairs = pairs;
        this.markingMap = new Map();
        for (let i = 0; i < pairs.length; i++) {
            const pair = pairs[i];
            if (!pair || !pair.marker || !pair.target) continue;
            this.markingMap.set(pair.marker, pair.target);
            pair.marker.markTarget = pair.target;
            const cover = computeCoverPoint(
                pair.target, ownGoalX, ownGoalY, this
            );
            pair.marker.markCoverPoint = cover;
        }
    }

    _refreshMarkCoverPoints() {
        if (!this.markingPairs || !this.markingPairs.length) return;
        let { ownGoalX, ownGoalY } = resolveOwnGoal(this);
        if (this._markOwnGoalX != null) ownGoalX = this._markOwnGoalX;
        if (this._markOwnGoalY != null) ownGoalY = this._markOwnGoalY;
        for (let i = 0; i < this.markingPairs.length; i++) {
            const pair = this.markingPairs[i];
            if (!pair || !pair.marker || !pair.target) continue;
            if (pair.target.isSentOff || pair.marker.isSentOff) continue;
            const cover = computeCoverPoint(pair.target, ownGoalX, ownGoalY, this);
            pair.marker.markTarget = pair.target;
            pair.marker.markCoverPoint = cover;
            this.markingMap.set(pair.marker, pair.target);
        }
    }

    /**
     * Whether this player is assigned as a marker.
     * @param {object} player
     */
    isMarkingPlayer(player) {
        return !!(player && this.markingMap && this.markingMap.has(player));
    }

    /**
     * Mark target for a marker, or null.
     * @param {object} player
     */
    getMarkTarget(player) {
        if (!player || !this.markingMap) return null;
        return this.markingMap.get(player) || null;
    }

    /**
     * Cover point for a marker (interpose mark ↔ own goal), or null.
     * Optionally blends with a shape base point.
     * @param {object} player
     * @param {{ x: number, y: number }|null} [shapeBase]
     * @returns {{ x: number, y: number }|null}
     */
    getMarkCoverPoint(player, shapeBase = null) {
        if (!player) return null;
        let cover = player.markCoverPoint;
        if (!cover && this.isMarkingPlayer(player) && player.markTarget) {
            const g = resolveOwnGoal(this);
            cover = computeCoverPoint(player.markTarget, g.ownGoalX, g.ownGoalY, this);
            player.markCoverPoint = cover;
        }
        if (!cover) return null;
        if (!shapeBase) return { x: cover.x, y: cover.y };

        const blend = ai(this.teamKey).MARK_SHAPE_BLEND ?? 0.28;
        const b = Math.max(0, Math.min(0.6, blend));
        return {
            x: cover.x * (1 - b) + shapeBase.x * b,
            y: cover.y * (1 - b) + shapeBase.y * b
        };
    }

    /**
     * Tick team-wide RequestPass rate limit (logic time).
     * @param {number} [dt]
     */
    tickPassRequestCooldown(dt) {
        const step = dt != null ? dt : (Time.deltaTime || 0);
        if (this.passRequestCooldown > 0) {
            this.passRequestCooldown -= step;
            if (this.passRequestCooldown < 0) this.passRequestCooldown = 0;
        }
    }

    /**
     * Open teammate asks controller for the ball (rate-limited, pass-safe).
     * Only dispatches Msg_PassToMe when:
     *   - team owns possession / controller has the ball
     *   - team-wide logic-time gate is ready
     *   - requester is open
     *   - pass lane is safe (pass_safety)
     *
     * @param {object} requester - supporting / open teammate
     * @param {{ force?: boolean, skipOpenCheck?: boolean }} [opts]
     * @returns {boolean} true if PassToMe was dispatched
     */
    requestPass(requester, opts = {}) {
        if (!requester || requester.isSentOff || requester.role === 'GK') return false;
        if (requester.team !== this.teamKey) return false;

        if (!opts.force && this.passRequestCooldown > 0) return false;

        const level = this.level;
        const ball = level && level.ball;
        if (!ball || !ball.owner || ball.owner.team !== this.teamKey) return false;

        const controller = this.controllingPlayer || ball.owner;
        if (!controller || controller === requester || controller.isSentOff) return false;
        if (ball.owner !== controller) return false;
        // Manual Stage 1: do not spam PassToMe at a human-controlled carrier
        if (controller.humanControlled) return false;
        if (this.receivingPlayer) return false;

        if (!opts.skipOpenCheck) {
            if (!isTeammateOpen(level, requester, 3.2)) return false;
        }

        const from = { x: controller.x, y: controller.y };
        const to = { x: requester.x, y: requester.y };
        const dist = dist2d(from.x, from.y, to.x, to.y);

        // Grab the proxy-scaled params for this team
        const aiParams = ai(this.teamKey);

        if (dist < aiParams.SHORT_PASS_MIN_DIST) return false;
        if (dist > aiParams.LONG_PASS_MAX_DIST) return false;

        const passType = dist > aiParams.LONG_PASS_MIN_DIST ? 'long' : 'short';
        const speed = estimatePassGroundSpeed(from, to, controller, passType);

        if (!passSafeFromAllOpponents(from, to, requester, this.getOpponentPool(), speed)) {
            return false;
        }

        // Arm team gate (logic seconds)
        this.passRequestCooldown = Math.max(0.05, aiParams.REQUEST_PASS_INTERVAL ?? 1.0);
        this.lastPassRequester = requester;

        dispatchSoccerMsg(level, 0, requester, controller, SoccerMsg.PassToMe, {
            requester,
            passType,
            aimHint: { x: requester.x, y: requester.y }
        });
        return true;
    }

    inControl() {
        return !!this.controllingPlayer;
    }

    isControllingPlayer(player) {
        return !!player && this.controllingPlayer === player;
    }

    isSupportingPlayer(player) {
        return !!player && this.supportingPlayer === player;
    }

    isReceivingPlayer(player) {
        return !!player && this.receivingPlayer === player;
    }

    isClosestToBall(player) {
        return !!player && this.playerClosestToBall === player;
    }

    clearPrimaryPresser() {
        this.stickyPrimaryChaser = null;
    }

    /**
     * Score helper for press ranking (priority or dist).
     * @param {{ priority?: number, dist?: number }} entry
     */
    static candidateScore(entry) {
        return typeof entry.priority === 'number' ? entry.priority : entry.dist;
    }

    /**
     * Sticky primary chaser selection (moved from Simulator.pickPrimaryChaser).
     * @param {Array<{ player: object, dist: number, priority?: number }>} rankedCandidates
     * @param {{ carrier?: object }|null} [context]
     * @returns {object|null}
     */
    pickPrimaryChaser(rankedCandidates, context = null) {
        if (!rankedCandidates || !rankedCandidates.length) {
            this.stickyPrimaryChaser = null;
            return null;
        }

        const level = this.level;
        const aiParams = ai(this.teamKey);
        const margin = aiParams.CHASER_STICKINESS_MARGIN;
        const best = rankedCandidates[0];
        const bestScore = Team.candidateScore(best);
        const prev = this.stickyPrimaryChaser;
        const carrier = context && context.carrier;

        if (prev) {
            const prevEntry = rankedCandidates.find(c => c.player === prev);
            if (prevEntry) {
                let keepSticky = Team.candidateScore(prevEntry) <= bestScore + margin;
                if (carrier && level) {
                    if (!canPressCarrier(prev, carrier, level)) {
                        keepSticky = false;
                    } else {
                        const beaten = getAheadDelta(prev, carrier, level) < -aiParams.CHASE_BEATEN_AHEAD_DIST
                            && prevEntry.dist > aiParams.CHASE_COMMIT_DIST;
                        if (beaten) keepSticky = false;
                    }
                }
                if (keepSticky) {
                    this.stickyPrimaryChaser = prev;
                    return prev;
                }
            }
        }

        this.stickyPrimaryChaser = best.player;
        return best.player;
    }

    /**
     * Press duty when the opponent has the ball (this team defends).
     * @param {object} carrier - ball owner on the other team
     * @param {(p: object) => boolean} canBecomeChaser
     * @returns {object[]} pressers (primary + secondaries)
     */
    getPressChasers(carrier, canBecomeChaser) {
        const level = this.level;
        if (!carrier || !level) {
            this.stickyPrimaryChaser = null;
            this.counterpressSurge = [];
            return [];
        }

        const counter = this.isCounterpressing();
        const aiParams = ai(this.teamKey);
        const pressDist = counter ? aiParams.COUNTERPRESS_SECONDARY_DIST : aiParams.PRESS_SECOND_CHASER_DIST;
        const cpBonus = counter ? aiParams.COUNTERPRESS_PRIORITY_BONUS : 0;

        const ranked = this.players
            .filter(p => canBecomeChaser(p))
            .map(p => {
                const dist = dist2d(p.x, p.y, carrier.x, carrier.y);
                let priority = computePressPriority(p, carrier, level);
                if (counter) {
                    priority -= cpBonus * Math.max(0, 1 - dist / Math.max(1, pressDist));
                }
                return { player: p, dist, priority };
            })
            .filter(c => {
                if (counter) {
                    if (c.dist <= pressDist * 1.15) return true;
                    return canPressCarrier(c.player, carrier, level);
                }
                return canPressCarrier(c.player, carrier, level);
            })
            .sort((a, b) => a.priority - b.priority);

        const primary = this.pickPrimaryChaser(ranked, { carrier });
        const out = [];
        if (primary) out.push(primary);

        const inDanger = isCarrierInDangerZone(carrier, this.teamKey, level);
        let maxSecondary;
        if (counter) {
            const maxSurge = Math.max(1, aiParams.COUNTERPRESS_MAX_SURGE | 0);
            maxSecondary = Math.max(0, maxSurge - 1);
        } else {
            maxSecondary = inDanger ? aiParams.PRESS_MAX_SECONDARY_DANGER : 1;
        }

        let secondaryCount = 0;
        for (let i = 0; i < ranked.length && secondaryCount < maxSecondary; i++) {
            const entry = ranked[i];
            if (!entry || entry.player === primary) continue;
            if (entry.dist < pressDist) {
                out.push(entry.player);
                secondaryCount++;
            }
        }
        if (counter) {
            this.counterpressSurge = out.slice();
        } else if (this.transitionTimer <= 0) {
            this.counterpressSurge = [];
        }
        return out;
    }

    /**
     * Loose-ball chase candidates for this team (sticky nearest + proximity).
     * @param {{ x: number, y: number }} ball
     * @param {(p: object) => boolean} canBecomeChaser
     * @returns {object[]}
     */
    getLooseBallChasers(ball, canBecomeChaser) {
        if (!ball) {
            this.stickyPrimaryChaser = null;
            return [];
        }

        const ranked = this.players
            .filter(p => canBecomeChaser(p))
            .map(p => {
                const dist = dist2d(p.x, p.y, ball.x, ball.y);
                return { player: p, dist, priority: dist };
            })
            .sort((a, b) => a.priority - b.priority);

        const out = [];
        const primary = this.pickPrimaryChaser(ranked);
        if (primary) out.push(primary);

        const proximity = ai(this.teamKey).LOOSE_BALL_PROXIMITY_RANGE;
        for (const p of this.players) {
            if (!canBecomeChaser(p) || out.includes(p)) continue;
            if (dist2d(p.x, p.y, ball.x, ball.y) < proximity) {
                out.push(p);
            }
        }
        return out;
    }

    /**
     * Sync controlling player + closest-to-ball from live ball (call before AI assign).
     * @param {{ owner?: object|null, x?: number, y?: number }|null} ball
     */
    syncRolesFromBall(ball) {
        this.calculateClosestPlayerToBall(ball);
        if (ball && ball.owner && ball.owner.team === this.teamKey) {
            if (this.controllingPlayer !== ball.owner) {
                this.setControllingPlayer(ball.owner);
            }
        } else if (this.controllingPlayer) {
            if (!ball || !ball.owner || ball.owner.team !== this.teamKey) {
                this.lostControl();
            }
        }
    }

    /**
     * Apply formation-depth posture + home-region column shift for the team state.
     * On attack/defend posture we shift region columns
     * and keep fine formation offsets within each cell.
     * @param {'attacking'|'defending'|'setpiece'|'kickoffprepare'} postureName
     * @param {{ delayRegionDrop?: boolean }} [opts] - A.4: milder defend while counterpressing
     */
    applyPosture(postureName, opts = {}) {
        const key = POSTURE_DEPTH_REF[postureName] !== undefined ? postureName : 'kickoffprepare';
        this.postureName = key;
        let depth = POSTURE_DEPTH_REF[key];
        let holdBias = POSTURE_HOLD_BIAS[key];
        let colDelta = POSTURE_REGION_COL_DELTA[key] != null
            ? POSTURE_REGION_COL_DELTA[key]
            : 0;

        // A.4: during counterpress, non-surge "delay drop" — hold higher line / no deep column shift
        if (opts.delayRegionDrop && key === 'defending') {
            const scale = ai(this.teamKey).COUNTERPRESS_DELAY_DEPTH_SCALE ?? 0.3;
            depth = depth * scale;
            holdBias = holdBias * 0.5;
            colDelta = 0;
        }

        this.depthBiasRef = depth;
        this.postureHoldBias = holdBias;
        this.homeRegionColumnDelta = colDelta;
        this.applyHomeRegions();
    }

    /**
     * World-space X offset for a player's formation target under current posture.
     * Uses attack direction (half-aware) × role multiplier × depthBiasRef.
     * Non-surge players during counterpress get extra depth scale-down (delay drop).
     * @param {{ role?: string }} player
     */
    getDepthWorldOffset(player) {
        if (!this.depthBiasRef || !player) return 0;
        const mult = roleDepthMultiplier(player.role);
        if (mult === 0) return 0;
        const level = this.level;
        if (!level || typeof level.isSecondHalf !== 'function') return 0;
        const sign = attacksRightGoal(level, this.teamKey) ? 1 : -1;
        let bias = this.depthBiasRef;
        // Extra delay for non-surge if posture already fully defending but window still open
        if (
            this.isCounterpressing()
            && !this.isCounterpressSurge(player)
            && this.postureName === 'defending'
            && this.homeRegionColumnDelta < 0
        ) {
            const scale = ai(this.teamKey).COUNTERPRESS_DELAY_DEPTH_SCALE ?? 0.3;
            bias *= scale;
        }
        return sign * Utils.scaleFieldX(bias * mult);
    }

    /**
     * Effective FORMATION_HOLD for this squad: Settings.AI (incl. dynamic archetype
     * shifts) + posture bias. Clamped to [0, 1].
     */
    getEffectiveFormationHold() {
        const base = ai(this.teamKey).FORMATION_HOLD ?? 0.55;
        const biased = base + (this.postureHoldBias || 0);
        return Math.max(0, Math.min(1, biased));
    }

    /**
     * Choose TeamStates singleton from match phase + possession (in control).
     */
    resolveDesiredState() {
        const level = this.level;
        const matchState = (level && level.matchState) ? level.matchState : 'kickoff';
        return resolveTeamStateFromMatch(matchState, this.inControl());
    }

    /** Transition team FSM when match phase or possession changes. */
    syncFsmFromMatch() {
        const desired = this.resolveDesiredState();
        if (!this.fsm.isInState(desired)) {
            this.fsm.changeState(desired);
        }
    }

    update() {
        const level = this.level;
        const ball = level && level.ball;
        // Roles also synced earlier in Simulator.updatePlayerAIStates; keep in lockstep here
        this.syncRolesFromBall(ball);

        this.tickPassRequestCooldown(Time.deltaTime);
        this.tickCounterpress(Time.deltaTime);

        this.syncFsmFromMatch();
        // A.3 phase before Attacking execute (support spots / pass use mods)
        this.updatePlayPhase(ball);
        if (this.fsm) {
            this.fsm.update();
        }
    }

    /**
     * Players are y-sorted and drawn by Simulator with the ball.
     * Team itself has no pitch-space visual; do not cascade renderAll to children.
     */
    renderAll(g) {
        if (!this.active) return;
        this.render(g);
        for (const script of this.scripts) {
            script.render(g);
        }
    }

    /**
     * Same idea for GUI: team-level overlays only (future); players use own onGUI via level path if needed.
     */
    onGUIAll(g) {
        if (!this.active) return;
        this.onGUI(g);
        for (const script of this.scripts) {
            script.onGUI(g);
        }
    }
}

module.exports = {
    Team,
    MAX_PLAYERS,
    TeamStates,
    PlayPhase,
    POSTURE_DEPTH_REF,
    POSTURE_HOLD_BIAS,
    POSTURE_REGION_COL_DELTA,
    resolveTeamStateFromMatch,
    roleDepthMultiplier,
    // Pass safety + lead geometry (re-export for tests / providers)
    isPassSafeFromOpponent: passSafeFromOpponent,
    isPassSafeFromAllOpponents: passSafeFromAllOpponents,
    estimatePassGroundSpeed,
    pickBestSafePassTarget,
    getBestPassToReceiver,
    getTangentPoints,
    canShoot: canShootPure,
    estimateShotGroundSpeed
};
