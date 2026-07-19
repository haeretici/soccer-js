/**
 * Match-rule geometry & pure helpers: penalty area, advantage, indirect free kicks.
 * Kept free of Simulator so unit tests can exercise without a full match bootstrap.
 */
const { Utils } = require('./utils.js');

/** Reference-space box depth / half-height matching pitch.js markings. */
const BOX_DEPTH_REF = 15.625;
const BOX_Y_MIN_REF = 12.5;
const BOX_Y_MAX_REF = 50;
/** Penalty spot distance from goal line (pitch.js). */
const PENALTY_SPOT_X_REF = 12.5;

/** How long the referee holds the whistle when playing advantage (logic seconds). */
const ADVANTAGE_WINDOW_SEC = 2.5;

/**
 * Axis-aligned penalty area for the goal on `side` ('left' | 'right').
 * @param {'left'|'right'} side
 * @param {{ width: number, height: number }|null} [field]
 * @returns {{ xMin: number, xMax: number, yMin: number, yMax: number, side: string }}
 */
function getPenaltyArea(side, field = null) {
    const f = field || Utils.getFieldBounds();
    const s = (v) => Utils.scaleFieldX(v);
    const yMin = Utils.scaleFieldY(BOX_Y_MIN_REF);
    const yMax = Utils.scaleFieldY(BOX_Y_MAX_REF);
    const depth = s(BOX_DEPTH_REF);
    if (side === 'right') {
        return { xMin: f.width - depth, xMax: f.width, yMin, yMax, side: 'right' };
    }
    return { xMin: 0, xMax: depth, yMin, yMax, side: 'left' };
}

/**
 * Which goal end a team defends this half.
 * Team A attacks right in first half → defends left; flips after half.
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 * @returns {'left'|'right'}
 */
function defendingGoalSide(sim, teamKey) {
    const secondHalf = !!(sim && typeof sim.isSecondHalf === 'function' && sim.isSecondHalf());
    // First half: A defends left, B right. Second half: swapped.
    if (teamKey === 'A') return secondHalf ? 'right' : 'left';
    return secondHalf ? 'left' : 'right';
}

/**
 * @param {number} x
 * @param {number} y
 * @param {'left'|'right'} side
 * @param {{ width: number, height: number }|null} [field]
 * @returns {boolean}
 */
function isInPenaltyArea(x, y, side, field = null) {
    const box = getPenaltyArea(side, field);
    return x >= box.xMin && x <= box.xMax && y >= box.yMin && y <= box.yMax;
}

/**
 * Foul by `foulingTeam` at (x,y) is a penalty if inside their own box.
 * @param {object} sim
 * @param {'A'|'B'} foulingTeam
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isPenaltyFoul(sim, foulingTeam, x, y) {
    if (!foulingTeam) return false;
    const side = defendingGoalSide(sim, foulingTeam);
    return isInPenaltyArea(x, y, side);
}

/**
 * World position of the penalty spot for the goal on `side`.
 * @param {'left'|'right'} side
 * @param {{ width: number, height: number, centerY: number }|null} [field]
 * @returns {{ x: number, y: number }}
 */
function getPenaltySpot(side, field = null) {
    const f = field || Utils.getFieldBounds();
    const spotX = Utils.scaleFieldX(PENALTY_SPOT_X_REF);
    const x = side === 'right' ? f.width - spotX : spotX;
    return { x, y: f.centerY };
}

/**
 * Clear IFK second-touch gate when a different player contacts the ball.
 * @param {object|null} ball
 * @param {object|null} player
 */
function clearIfkOnTouch(ball, player) {
    if (!ball || !ball.ifkActive) return;
    if (!player || player === ball.ifkTaker) return;
    ball.ifkActive = false;
    ball.ifkTaker = null;
}

/**
 * Arm IFK second-touch rule after an indirect free-kick is taken.
 * @param {object} ball
 * @param {object} taker
 */
function armIndirectFreeKick(ball, taker) {
    if (!ball || !taker) return;
    ball.ifkActive = true;
    ball.ifkTaker = taker;
}

/**
 * Whether the referee should play advantage instead of stopping for a free kick.
 * No advantage for penalties, red cards, or when the fouled side no longer has the ball.
 *
 * @param {object} sim
 * @param {object} tackler
 * @param {object} fouledPlayer
 * @param {{ cardType?: string|null, isPenalty?: boolean }} meta
 * @returns {boolean}
 */
function shouldPlayAdvantage(sim, tackler, fouledPlayer, meta = {}) {
    if (!sim || !fouledPlayer || !sim.ball) return false;
    if (meta.isPenalty) return false;
    if (meta.cardType === 'red' || meta.cardType === 'doubleyellow') return false;

    const ball = sim.ball;
    const team = fouledPlayer.team;
    // Need clear possession for the fouled team (carrier or very short loose reclaim)
    let hasBall = false;
    if (ball.owner && ball.owner.team === team && !ball.owner.isSentOff) {
        hasBall = true;
    } else if (!ball.owner) {
        // Loose ball still near fouled player and moving into attack — rare but allow
        const dx = ball.x - fouledPlayer.x;
        const dy = ball.y - fouledPlayer.y;
        if (dx * dx + dy * dy < 2.5 * 2.5) hasBall = true;
    }
    if (!hasBall) return false;

    // Only play advantage in the fouled team's attacking half (retro simplicity)
    const field = Utils.getFieldBounds();
    const defSide = defendingGoalSide(sim, team);
    const inAttackHalf = defSide === 'left'
        ? ball.x > field.centerX
        : ball.x < field.centerX;
    if (!inAttackHalf) return false;

    return true;
}

/**
 * Advantage still valid: fouled team has possession (or short loose window), no stoppage.
 * @param {object} sim
 * @param {{ kickingTeam: string }} pending
 * @returns {boolean}
 */
function advantageStillHolds(sim, pending) {
    if (!sim || !pending || !sim.ball) return false;
    if (sim.matchState && sim.matchState !== 'play') return false;
    const ball = sim.ball;
    const team = pending.kickingTeam;
    if (ball.owner) {
        return ball.owner.team === team && !ball.owner.isSentOff;
    }
    // Loose: last touch still fouled team, or no opponent claim yet
    if (sim.lastTouchPlayer && sim.lastTouchPlayer.team === team) return true;
    return false;
}

module.exports = {
    BOX_DEPTH_REF,
    BOX_Y_MIN_REF,
    BOX_Y_MAX_REF,
    PENALTY_SPOT_X_REF,
    ADVANTAGE_WINDOW_SEC,
    getPenaltyArea,
    defendingGoalSide,
    isInPenaltyArea,
    isPenaltyFoul,
    getPenaltySpot,
    clearIfkOnTouch,
    armIndirectFreeKick,
    shouldPlayAdvantage,
    advantageStillHolds
};
