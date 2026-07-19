/**
 * Thin steering layer (pragmatic subset for discrete-step agents).
 *
 * Soccer-js moves agents with discrete position steps (not force integrators).
 * These helpers return desired points / speed scales that `Player.moveTo` consumes.
 *
 * Behaviors:
 *  - seek / arrive  — approach a point (arrive decelerates near target)
 *  - separation     — anti-bunching offset from nearby players
 *  - pursuit        — intercept predicted ball (or moving target) position
 *  - interpose      — stand between ball and an anchor (GK tend / cut-off)
 */
const { Settings } = require('../../settings.js');
const { futurePositionFromVelocity } = require('./ball_prediction.js');

/** Default neighbor view radius (world units). */
const DEFAULT_VIEW_DISTANCE = 4.5;
/** Separation strength multiplier. */
const DEFAULT_SEP_MULT = 2.2;
/** Arrive slow-down radius (world units). */
const DEFAULT_ARRIVE_RADIUS = 3.5;
/** Arrive min speed scale so agents don't freeze too early. */
const ARRIVE_MIN_SCALE = 0.18;

function dist2d(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
}

function length2(x, y) {
    return Math.sqrt(x * x + y * y);
}

function normalize(x, y) {
    const len = length2(x, y);
    if (len < 1e-8) return { x: 0, y: 0 };
    return { x: x / len, y: y / len };
}

/**
 * Seek: unit direction toward target (full speed intent).
 * @returns {{ x: number, y: number, dist: number }}
 */
function seek(agent, target) {
    const dx = target.x - agent.x;
    const dy = target.y - agent.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-8) return { x: 0, y: 0, dist: 0 };
    return { x: dx / dist, y: dy / dist, dist };
}

/**
 * Arrive speed scale 0–1: full speed far away, decelerate inside radius.
 * Classic arrive: speed scales with dist / deceleration; we map to a multiplier.
 *
 * @param {number} dist
 * @param {number} [slowRadius]
 * @param {number} [deceleration] - 1=fast, 2=normal, 3=slow
 */
function arriveSpeedScale(dist, slowRadius = DEFAULT_ARRIVE_RADIUS, deceleration = 2) {
    if (dist <= 0.08) return 0;
    const radius = slowRadius * (deceleration / 2);
    if (dist >= radius) return 1;
    return Math.max(ARRIVE_MIN_SCALE, dist / radius);
}

/**
 * Separation force: sum of (away-from-neighbor / distance) for neighbors in view.
 * @param {{ x: number, y: number }} agent
 * @param {Array<{ x: number, y: number, isSentOff?: boolean }>} neighbors
 * @param {number} [viewDistance]
 * @returns {{ x: number, y: number }}
 */
function separation(agent, neighbors, viewDistance = DEFAULT_VIEW_DISTANCE) {
    let fx = 0;
    let fy = 0;
    if (!neighbors || !neighbors.length) return { x: 0, y: 0 };

    const viewSq = viewDistance * viewDistance;
    for (let i = 0; i < neighbors.length; i++) {
        const n = neighbors[i];
        if (!n || n === agent || n.isSentOff) continue;
        const dx = agent.x - n.x;
        const dy = agent.y - n.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < 1e-8 || dSq > viewSq) continue;
        const d = Math.sqrt(dSq);
        // Normalize * (1/d) ≡ ToAgent / d²  — stronger when closer
        fx += dx / (d * d);
        fy += dy / (d * d);
    }
    return { x: fx, y: fy };
}

/**
 * Pursuit: predict where a moving target (ball) will be.
 * Uses shared ground-friction FuturePosition when quarry looks like the ball.
 * @param {{ x: number, y: number }} agent
 * @param {{ x: number, y: number, vx?: number, vy?: number }} quarry
 * @param {number} [agentSpeed=5.0] - for look-ahead scale (matches new base jog speed)
 * @returns {{ x: number, y: number }}
 */
function pursuitPoint(agent, quarry, agentSpeed = 5.0) {
    if (!quarry) return { x: agent.x, y: agent.y };
    const qvx = quarry.vx || 0;
    const qvy = quarry.vy || 0;
    const qSpeed = Math.sqrt(qvx * qvx + qvy * qvy);
    const toQx = quarry.x - agent.x;
    const toQy = quarry.y - agent.y;
    const toQ = Math.sqrt(toQx * toQx + toQy * toQy);

    let lookAhead = 0;
    if (qSpeed > 0.15) {
        lookAhead = toQ / Math.max(qSpeed, agentSpeed * 0.5);
        lookAhead = Math.min(lookAhead, 1.2); // cap for stability
    }
    // Friction decay for loose ball; carriers/players keep near-constant vel approx
    const pred = futurePositionFromVelocity(quarry.x, quarry.y, qvx, qvy, lookAhead);
    return { x: pred.x, y: pred.y };
}

/**
 * Interpose: point between anchor and ball, DistFromAnchor along ball←anchor.
 * Arrive-style: point along anchor→ball at DistFromAnchor from the anchor.
 * For GK: anchor = goal mouth point, stand off the goal line toward the ball.
 *
 * @param {{ x: number, y: number }} ball
 * @param {{ x: number, y: number }} anchor
 * @param {number} distFromAnchor
 * @returns {{ x: number, y: number }}
 */
function interposePoint(ball, anchor, distFromAnchor) {
    const dx = ball.x - anchor.x;
    const dy = ball.y - anchor.y;
    const n = normalize(dx, dy);
    return {
        x: anchor.x + n.x * distFromAnchor,
        y: anchor.y + n.y * distFromAnchor
    };
}

/**
 * Blend seek direction with separation into a final aim point + speed scale.
 *
 * @param {{ x: number, y: number }} agent
 * @param {{ x: number, y: number }} target
 * @param {object} [opts]
 * @param {boolean} [opts.arrive=true]
 * @param {boolean} [opts.separate=false]
 * @param {Array} [opts.neighbors]
 * @param {number} [opts.viewDistance]
 * @param {number} [opts.sepMult]
 * @param {number} [opts.arriveRadius]
 * @param {number} [opts.deceleration]
 * @returns {{ aim: {x:number,y:number}, speedScale: number, dist: number }}
 */
function composeSteer(agent, target, opts = {}) {
    const useArrive = opts.arrive !== false;
    const useSep = !!opts.separate;
    const neighbors = opts.neighbors || [];
    const viewDistance = opts.viewDistance != null
        ? opts.viewDistance
        : (Settings.AI && Settings.AI.STEER_VIEW_DISTANCE) || DEFAULT_VIEW_DISTANCE;
    const sepMult = opts.sepMult != null
        ? opts.sepMult
        : (Settings.AI && Settings.AI.STEER_SEPARATION_MULT) || DEFAULT_SEP_MULT;
    const arriveRadius = opts.arriveRadius != null
        ? opts.arriveRadius
        : (Settings.AI && Settings.AI.STEER_ARRIVE_RADIUS) || DEFAULT_ARRIVE_RADIUS;
    const deceleration = opts.deceleration != null ? opts.deceleration : 2;

    const to = seek(agent, target);
    let dirX = to.x;
    let dirY = to.y;

    if (useSep && neighbors.length) {
        const sep = separation(agent, neighbors, viewDistance);
        // Mix separation into direction (capped so we still progress toward target)
        dirX += sep.x * sepMult;
        dirY += sep.y * sepMult;
        const n = normalize(dirX, dirY);
        dirX = n.x;
        dirY = n.y;
        // If almost pure separation with no seek, keep moving along separation
        if (to.dist < 0.1 && (Math.abs(sep.x) + Math.abs(sep.y) > 1e-6)) {
            const sn = normalize(sep.x, sep.y);
            dirX = sn.x;
            dirY = sn.y;
        }
    }

    // Aim a short step ahead so moveTo still uses position-based integration
    const step = Math.max(to.dist, 0.5);
    const aim = {
        x: agent.x + dirX * step,
        y: agent.y + dirY * step
    };

    // When separating near target, still prefer true target for final snap
    if (to.dist < 0.35 && !useSep) {
        aim.x = target.x;
        aim.y = target.y;
    }

    const speedScale = useArrive
        ? arriveSpeedScale(to.dist, arriveRadius, deceleration)
        : 1;

    return { aim, speedScale, dist: to.dist };
}

/**
 * Collect neighbor players for separation (same level roster).
 * @param {object} player
 * @param {Array} allPlayers
 * @param {number} [viewDistance]
 */
function collectNeighbors(player, allPlayers, viewDistance = DEFAULT_VIEW_DISTANCE) {
    if (!allPlayers || !allPlayers.length) return [];
    const viewSq = viewDistance * viewDistance;
    const out = [];
    for (let i = 0; i < allPlayers.length; i++) {
        const n = allPlayers[i];
        if (!n || n === player || n.isSentOff) continue;
        if (n.team && player.team && n.team !== player.team) continue;
        const dx = n.x - player.x;
        const dy = n.y - player.y;
        if (dx * dx + dy * dy <= viewSq) out.push(n);
    }
    return out;
}

module.exports = {
    DEFAULT_VIEW_DISTANCE,
    DEFAULT_SEP_MULT,
    DEFAULT_ARRIVE_RADIUS,
    ARRIVE_MIN_SCALE,
    dist2d,
    seek,
    arriveSpeedScale,
    separation,
    pursuitPoint,
    interposePoint,
    composeSteer,
    collectNeighbors
};
