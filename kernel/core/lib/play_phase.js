/**
 * Phases of play (build / progress / finish)
 *
 * Coarse possession phase from ball zone along the attack axis (thirds).
 * Not a Team FSM — a soft modifier while Attacking / in control.
 *
 *   build    — own third: safer short, defensive receivers OK, low shoot
 *   progress — middle: switch-play bias, wider support
 *   finish   — final third: CanShoot weight up, fewer backwards
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');

/** Stable phase ids */
const PlayPhase = {
    NONE: 'none',
    BUILD: 'build',
    PROGRESS: 'progress',
    FINISH: 'finish'
};

/**
 * Multipliers / biases applied by decision sites (pass, shoot, support).
 * Values are relative to neutral 1.0 unless noted.
 */
const PHASE_MODS = {
    [PlayPhase.NONE]: {
        shortPassBias: 1.0,
        longPassBias: 1.0,
        shootRangeMult: 1.0,
        shootWillingness: 1.0,
        canShootWeight: 1.0,
        /** Multiplier on defensive-receiver score (build lifts CB/DM involvement) */
        defReceiverWeight: 1.0,
        /** Multiplier on forward-progress term in pass scoring */
        forwardGainWeight: 1.0,
        /** Extra score when pass dist is short */
        shortDistBonus: 0,
        supportWidthMult: 1.0,
        supportDepthMult: 1.0,
        supportCanScoreMult: 1.0,
        supportWingMult: 1.0,
        passChanceMult: 1.0,
        /** Min forward gain ref-units for isPassReceiverAhead (scaled later) */
        minForwardGainRef: 4.6875,
        allowBackPass: false
    },
    [PlayPhase.BUILD]: {
        shortPassBias: 1.4,
        longPassBias: 0.5,
        shootRangeMult: 0.55,
        shootWillingness: 0.32,
        canShootWeight: 0.55,
        defReceiverWeight: 2.4,
        forwardGainWeight: 0.72,
        shortDistBonus: 3.5,
        supportWidthMult: 0.82,
        supportDepthMult: 0.72,
        supportCanScoreMult: 0.45,
        supportWingMult: 0.7,
        passChanceMult: 1.15,
        minForwardGainRef: 1.5,
        allowBackPass: true
    },
    [PlayPhase.PROGRESS]: {
        shortPassBias: 0.95,
        longPassBias: 1.25,
        shootRangeMult: 0.95,
        // ISS: mid-third carriers often pull the trigger when in range
        shootWillingness: 0.88,
        canShootWeight: 1.15,
        defReceiverWeight: 0.9,
        forwardGainWeight: 1.28,
        shortDistBonus: 0.4,
        supportWidthMult: 1.22,
        supportDepthMult: 1.08,
        supportCanScoreMult: 1.15,
        supportWingMult: 1.35,
        passChanceMult: 0.95,
        minForwardGainRef: 4.0,
        allowBackPass: false
    },
    [PlayPhase.FINISH]: {
        shortPassBias: 1.05,
        longPassBias: 0.55,
        shootRangeMult: 1.35,
        shootWillingness: 1.55,
        canShootWeight: 1.7,
        defReceiverWeight: 0.3,
        forwardGainWeight: 1.5,
        shortDistBonus: 0.85,
        supportWidthMult: 1.05,
        supportDepthMult: 1.22,
        supportCanScoreMult: 1.8,
        supportWingMult: 1.05,
        // Prefer shot attempts over recycling once in the final third
        passChanceMult: 0.68,
        minForwardGainRef: 3.5,
        allowBackPass: false
    }
};

/**
 * @param {string} phase
 * @returns {typeof PHASE_MODS[string]}
 */
function getPhaseMods(phase) {
    return PHASE_MODS[phase] || PHASE_MODS[PlayPhase.NONE];
}

/**
 * Progress along attack axis in [0, 1]: 0 = own goal line, 1 = opp goal line.
 *
 * @param {number} ballX
 * @param {boolean} attacksRight
 * @param {{ width: number }} field
 */
function attackProgress01(ballX, attacksRight, field) {
    const w = field.width || 1;
    if (attacksRight) {
        return Math.max(0, Math.min(1, ballX / w));
    }
    return Math.max(0, Math.min(1, (w - ballX) / w));
}

/**
 * Resolve phase from ball position + attack direction.
 * Thirds: [0, 1/3) build, [1/3, 2/3) progress, [2/3, 1] finish.
 *
 * @param {number} ballX
 * @param {boolean} attacksRight
 * @param {{ width: number }|null} [field]
 * @returns {string} PlayPhase.*
 */
function resolvePlayPhase(ballX, attacksRight, field) {
    const f = field || Utils.getFieldBounds();
    const p = attackProgress01(ballX, attacksRight, f);
    const buildEnd = (Settings.AI && typeof Settings.AI.PHASE_BUILD_END === 'number')
        ? Settings.AI.PHASE_BUILD_END
        : (1 / 3);
    const finishStart = (Settings.AI && typeof Settings.AI.PHASE_FINISH_START === 'number')
        ? Settings.AI.PHASE_FINISH_START
        : (2 / 3);
    if (p < buildEnd) return PlayPhase.BUILD;
    if (p < finishStart) return PlayPhase.PROGRESS;
    return PlayPhase.FINISH;
}

/**
 * Resolve phase for a Team entity (in control + ball).
 * @param {object} team
 * @param {{ x: number }|null} [ball]
 * @param {boolean} [attacksRight]
 * @returns {string}
 */
function resolveTeamPlayPhase(team, ball, attacksRight) {
    if (!team || !ball) return PlayPhase.NONE;
    // Only meaningful while team has / is attacking with possession
    if (typeof team.inControl === 'function' && !team.inControl()) {
        // Still allow if ball.owner is on this team (controller not yet set)
        if (!ball.owner || ball.owner.team !== team.teamKey) {
            return PlayPhase.NONE;
        }
    }
    let ar = attacksRight;
    if (ar == null) {
        const level = team.level;
        if (level && typeof level.isSecondHalf === 'function') {
            ar = level.isSecondHalf() ? team.teamKey === 'B' : team.teamKey === 'A';
        } else {
            ar = team.teamKey === 'A';
        }
    }
    return resolvePlayPhase(ball.x, !!ar, Utils.getFieldBounds());
}

/**
 * Safe mods lookup from a player (via Team.playPhase if set).
 * @param {object|null} player
 * @returns {typeof PHASE_MODS[string]}
 */
function getPlayPhaseModsForPlayer(player) {
    if (!player) return getPhaseMods(PlayPhase.NONE);
    const team = player.parent && typeof player.parent.getOutfieldPlayers === 'function'
        ? player.parent
        : (player.level && player.team === 'A' && player.level.teamA)
            ? player.level.teamA
            : (player.level && player.team === 'B' && player.level.teamB)
                ? player.level.teamB
                : null;
    if (team && team.playPhase) {
        return getPhaseMods(team.playPhase);
    }
    // Fallback: resolve live from ball
    if (team && player.level && player.level.ball) {
        return getPhaseMods(resolveTeamPlayPhase(team, player.level.ball));
    }
    return getPhaseMods(PlayPhase.NONE);
}

module.exports = {
    PlayPhase,
    PHASE_MODS,
    getPhaseMods,
    attackProgress01,
    resolvePlayPhase,
    resolveTeamPlayPhase,
    getPlayPhaseModsForPlayer
};
