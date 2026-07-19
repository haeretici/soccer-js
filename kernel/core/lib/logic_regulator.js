/**
 * Logic-time regulators for fixed-step sims.
 *
 * IMPORTANT (soccer-js):
 *   Settings.TIME_SPEED only changes how many logic ticks run per wall-clock
 *   second. Each tick still uses fixed LOGIC_DT (0.05 s). Cooldowns driven by
 *   Time.deltaTime (or logic ticks) therefore keep the same rates in *match
 *   time* at 1× or 10× play speed. These helpers are NOT a fix for “high UPS”;
 *   they unify decision throttles and kick timing so everything stays
 *   logic-time (never wall-clock / Date.now).
 */
const { Settings } = require('../../settings.js');

/** Defaults when Settings.AI keys are absent (seconds of logic time). */
const KICK_DEFAULTS = {
    KICK_WINDUP: 0.2,
    KICKER_CLAIM_COOLDOWN: 0.3,
    KICKER_CLAIM_COOLDOWN_SETPIECE: 1.0,
    /** Seconds last kicker is excluded from ChaseBall after a kick. */
    PASS_FOLLOW_SUPPRESS: 1.35,
    /** Min logic seconds between dribble pass/shoot *decision rolls*. */
    KICK_DECISION_INTERVAL: 0.25
};

/**
 * Logic-tick interval gate (support-spot / decision throttle style).
 * Ready on first call, then waits intervalTicks-1 false calls.
 */
class TickRegulator {
    /**
     * @param {number} intervalTicks
     */
    constructor(intervalTicks) {
        this.intervalTicks = Math.max(1, intervalTicks | 0);
        this.ticksUntilReady = 0;
    }

    setInterval(intervalTicks) {
        this.intervalTicks = Math.max(1, intervalTicks | 0);
    }

    /**
     * @returns {boolean} true when work should run this tick
     */
    isReady() {
        if (this.ticksUntilReady > 0) {
            this.ticksUntilReady--;
            return false;
        }
        this.ticksUntilReady = this.intervalTicks - 1;
        return true;
    }

    forceReady() {
        this.ticksUntilReady = 0;
    }
}

/**
 * Countdown in logic seconds (uses Time.deltaTime at call sites).
 * ready when remaining <= 0.
 */
class LogicTimeCooldown {
    /**
     * @param {number} [defaultDuration=0]
     */
    constructor(defaultDuration = 0) {
        this.defaultDuration = Math.max(0, defaultDuration);
        this.remaining = 0;
    }

    /**
     * @param {number} [duration] - defaults to defaultDuration
     */
    start(duration) {
        const d = duration != null ? duration : this.defaultDuration;
        this.remaining = Math.max(0, d);
    }

    clear() {
        this.remaining = 0;
    }

    /**
     * Advance by one logic step.
     * @param {number} dt - Time.deltaTime (logic seconds)
     * @returns {boolean} true if cooldown finished this tick or was already ready
     */
    tick(dt) {
        if (this.remaining <= 0) return true;
        const step = typeof dt === 'number' && dt > 0 ? dt : 0;
        this.remaining -= step;
        if (this.remaining < 0) this.remaining = 0;
        return this.remaining <= 0;
    }

    get ready() {
        return this.remaining <= 0;
    }

    get active() {
        return this.remaining > 0;
    }
}

/**
 * Resolve kick timing params from Settings.AI (team-split aware via Settings.AI[team]).
 * @param {object|null} [player]
 */
function getKickTimingParams(player) {
    const team = player && player.team;
    const a = (team && Settings.AI && Settings.AI[team]) || Settings.AI || {};
    const base = Settings.AI || {};
    const num = (obj, key, fallback) => {
        const v = obj && typeof obj[key] === 'number' ? obj[key] : base[key];
        return typeof v === 'number' ? v : fallback;
    };
    return {
        windup: num(a, 'KICK_WINDUP', KICK_DEFAULTS.KICK_WINDUP),
        claimOpen: num(a, 'KICKER_CLAIM_COOLDOWN', KICK_DEFAULTS.KICKER_CLAIM_COOLDOWN),
        claimSetPiece: num(a, 'KICKER_CLAIM_COOLDOWN_SETPIECE', KICK_DEFAULTS.KICKER_CLAIM_COOLDOWN_SETPIECE),
        passFollowSuppress: num(a, 'PASS_FOLLOW_SUPPRESS', KICK_DEFAULTS.PASS_FOLLOW_SUPPRESS),
        decisionInterval: num(a, 'KICK_DECISION_INTERVAL', KICK_DEFAULTS.KICK_DECISION_INTERVAL)
    };
}

/**
 * Start Pass/Shoot animation windup (logic seconds on player.kickTimer).
 * @param {object} player
 * @param {number} [seconds]
 */
function startKickWindup(player, seconds) {
    if (!player) return;
    const params = getKickTimingParams(player);
    player.kickTimer = seconds != null ? seconds : params.windup;
}

/**
 * Tick kick windup; true when the kick may be released.
 * @param {object} player
 * @param {number} dt
 */
function tickKickWindup(player, dt) {
    if (!player) return true;
    if (player.kickTimer > 0) {
        player.kickTimer -= dt;
        if (player.kickTimer < 0) player.kickTimer = 0;
    }
    return player.kickTimer <= 0;
}

/**
 * After a kick leaves the foot: lock reclaim (double-touch / self-pass lag)
 * and suppress ChaseBall so the passer does not immediately follow the ball.
 * Uses set-piece vs open-play durations from Settings.AI.
 * @param {object} player
 * @param {boolean} [isSetPiece]
 */
function armKickerClaimCooldown(player, isSetPiece) {
    if (!player) return;
    const params = getKickTimingParams(player);
    player.kickerClaimCooldown = isSetPiece ? params.claimSetPiece : params.claimOpen;
    // Chase suppress is longer than claim lock so open-play passes fly without the kicker hunting the ball
    const suppress = params.passFollowSuppress != null ? params.passFollowSuppress : KICK_DEFAULTS.PASS_FOLLOW_SUPPRESS;
    player.passFollowSuppress = Math.max(player.passFollowSuppress || 0, suppress);
}

/**
 * @param {object} player
 * @param {number} dt
 */
function tickKickerClaimCooldown(player, dt) {
    if (!player) return;
    if (player.kickerClaimCooldown > 0) {
        player.kickerClaimCooldown -= dt;
        if (player.kickerClaimCooldown < 0) player.kickerClaimCooldown = 0;
    }
    if (player.passFollowSuppress > 0) {
        player.passFollowSuppress -= dt;
        if (player.passFollowSuppress < 0) player.passFollowSuppress = 0;
    }
}

/**
 * @param {object} player
 * @returns {boolean}
 */
function canClaimAfterKick(player) {
    return !player || !(player.kickerClaimCooldown > 0);
}

/**
 * Dribble AI may roll pass/shoot this tick (logic-time decision throttle).
 * Independent of play-speed: interval is always in match seconds.
 * @param {object} player
 */
function canEvaluateKickDecision(player) {
    return !player || !(player.kickDecisionCooldown > 0);
}

/**
 * Call after a dribble decision evaluation (whether or not a pass was chosen).
 * @param {object} player
 * @param {number} [interval]
 */
function markKickDecision(player, interval) {
    if (!player) return;
    const params = getKickTimingParams(player);
    player.kickDecisionCooldown = interval != null ? interval : params.decisionInterval;
}

/**
 * @param {object} player
 * @param {number} dt
 */
function tickKickDecisionCooldown(player, dt) {
    if (!player) return;
    if (player.kickDecisionCooldown > 0) {
        player.kickDecisionCooldown -= dt;
        if (player.kickDecisionCooldown < 0) player.kickDecisionCooldown = 0;
    }
}

/**
 * Tick all player kick-related logic-time cooldowns (call once per player update).
 * @param {object} player
 * @param {number} dt
 */
function tickPlayerKickGates(player, dt) {
    tickKickerClaimCooldown(player, dt);
    tickKickDecisionCooldown(player, dt);
}

module.exports = {
    KICK_DEFAULTS,
    TickRegulator,
    LogicTimeCooldown,
    getKickTimingParams,
    startKickWindup,
    tickKickWindup,
    armKickerClaimCooldown,
    tickKickerClaimCooldown,
    canClaimAfterKick,
    canEvaluateKickDecision,
    markKickDecision,
    tickKickDecisionCooldown,
    tickPlayerKickGates
};
