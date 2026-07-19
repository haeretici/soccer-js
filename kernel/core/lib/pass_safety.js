/**
 * Pass lane safety + lead-pass geometry.
 * Ground-plane only (ignores ball z).
 *
 * Ball travel time uses shared friction model (ball_prediction.js) so
 * CanShoot / pass safety match loose-ball FuturePosition.
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');
const {
    timeToCoverDistance: timeToCoverDistancePredicted,
    initialSpeedForDistance,
    speedAfterDistance,
    maxTravelDistance,
    longPassInitialSpeed
} = require('./ball_prediction.js');
const { clearIfkOnTouch } = require('./match_rules.js');

/** Logical radii for intercept reach (world units). */
const PASS_SAFETY_BALL_RADIUS = 0.11;
const PASS_SAFETY_PLAYER_RADIUS = 0.4;

/**
 * Fraction of (ball-flight-time × receiver max speed) used as lead circle radius.
 * Scale 0.3 so lead aims stay reachable, not max sprint range.
 */
const LEAD_RANGE_SCALE = 0.3;

/** A.7: weight progressive x-gain when ranking safe lead aims */
const PROGRESSIVE_LEAD_WEIGHT_DEFAULT = 1.15;
/** A.7: bonus when aim lands beyond second-last defender (line break) */
const LINE_BREAK_BONUS_DEFAULT = 3.5;
/** A.7: ref-field depth past defensive line for through-ball samples */
const THROUGH_BALL_DEPTH_REF_DEFAULT = 7.5;
/** A.7: extra forward-lead scale beyond classic intercept circle */
const THROUGH_BALL_LEAD_EXTRA_DEFAULT = 1.35;

/** Goal mouth in reference-field Y — shared with Goal entity (presets: 40–60). */
const {
    GOAL_MOUTH_Y_REF_MIN,
    GOAL_MOUTH_Y_REF_MAX
} = require('../entities/goal.js');

/** Default mouth samples when probing for a valid strike */
const NUM_SHOOT_ATTEMPTS = 5;

function dist2d(ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * World-unit top speed (m/s) — must match Player.moveTo / Settings.physics.
 * @param {{ stats?: { speed?: number }, staminaMultiplier?: number, currentStamina?: number }} player
 */
function estimatePlayerMaxSpeed(player) {
    const phys = (Settings && Settings.physics) || {};
    const base = typeof phys.PLAYER_BASE_SPEED === 'number' ? phys.PLAYER_BASE_SPEED : 4.6;
    const bonusMax = typeof phys.PLAYER_SPEED_STAT_BONUS === 'number' ? phys.PLAYER_SPEED_STAT_BONUS : 3.4;
    if (!player) return (base + bonusMax * 0.6) * (Settings.SPRITE_SPEED || 1);

    const baseStats = (player.stats && player.stats.speed) || 60;
    const stam = player.staminaMultiplier != null
        ? player.staminaMultiplier
        : (player.currentStamina != null ? player.currentStamina : 1);

    // speed 60 ≈ 6.6 m/s; speed 100 ≈ 8.0 m/s (sprint mul applied only in manual control)
    const speedBonus = (baseStats / 100.0) * bonusMax * stam;
    return (base + speedBonus) * (Settings.SPRITE_SPEED || 1);
}

/**
 * Initial ground speed of a pass — friction-aware so the ball arrives soft at `to`.
 * Shared by Pass kicks, pass safety, lead geometry, and support scoring.
 *
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {object} passer
 * @param {'short'|'long'} [passType='short']
 * @param {{ arrivalSpeed?: number, cushion?: number }} [opts]
 */
function estimatePassGroundSpeed(from, to, passer, passType = 'short', opts = {}) {
    const dist = from && to ? dist2d(from.x, from.y, to.x, to.y) : 0;
    let passing = 70;
    if (passer) {
        if (typeof passer.effectivePassing === 'number') {
            passing = passer.effectivePassing;
        } else if (passer.stats && typeof passer.stats.passing === 'number') {
            const stam = passer.staminaMultiplier != null ? passer.staminaMultiplier : 1;
            passing = passer.stats.passing * stam;
        }
    }

    const isLong = passType === 'long';
    const phys = (Settings && Settings.physics) || {};

    let v0;
    if (isLong) {
        // Hang-time + air-drag model (ground-friction arrival overshoots badly in the air)
        v0 = typeof longPassInitialSpeed === 'function'
            ? longPassInitialSpeed(dist)
            : (typeof phys.PASS_LONG_MIN_SPEED === 'number' ? phys.PASS_LONG_MIN_SPEED : 10);
    } else {
        // Short: ground-friction soft arrival at feet
        const arrival = opts.arrivalSpeed != null
            ? opts.arrivalSpeed
            : (typeof phys.PASS_SHORT_ARRIVAL === 'number' ? phys.PASS_SHORT_ARRIVAL : 4);
        const cushion = opts.cushion != null
            ? opts.cushion
            : (typeof phys.PASS_SHORT_CUSHION === 'number' ? phys.PASS_SHORT_CUSHION : 1.06);
        const minSpeed = typeof phys.PASS_SHORT_MIN_SPEED === 'number' ? phys.PASS_SHORT_MIN_SPEED : 6.0;
        const maxSpeed = typeof phys.PASS_SHORT_MAX_SPEED === 'number' ? phys.PASS_SHORT_MAX_SPEED : 14.0;

        v0 = initialSpeedForDistance(dist, {
            arrivalSpeed: arrival,
            cushion,
            minSpeed,
            maxSpeed
        });
    }

    // Passing skill: small band around physics base (~±8%)
    const skill = 0.94 + (passing / 100) * 0.12;
    v0 *= skill;

    if (passer && passer.traits && passer.traits.includes('Playmaker')) {
        v0 *= 1.04;
    }

    return v0;
}

/**
 * Time for the ball to cover a distance under ground friction.
 * Returns -1 if unreachable (speed non-positive or beyond max range).
 * @param {number} distance
 * @param {number} speed - initial ground speed
 * @param {{ constantSpeed?: boolean, frictionBase?: number }} [opts]
 */
function timeToCoverDistance(distance, speed, opts) {
    return timeToCoverDistancePredicted(distance, speed, opts || {});
}

/**
 * True if a single opponent cannot intercept the pass lane.
 *
 * @param {{ x: number, y: number }} from - kick origin
 * @param {{ x: number, y: number }} target - pass destination
 * @param {{ x: number, y: number }|null} receiver - intended receiver (may be null for spots/shots)
 * @param {{ x: number, y: number, stats?: object, isSentOff?: boolean }} opp
 * @param {number} passSpeed - initial ground speed of the ball
 * @param {{ ballRadius?: number, playerRadius?: number, maxSpeed?: number }} [opts]
 *   maxSpeed: when set (e.g. 0 for freekick wall bodies), overrides sprint estimate
 */
function isPassSafeFromOpponent(from, target, receiver, opp, passSpeed, opts = {}) {
    if (!from || !target || !opp || opp.isSentOff) return true;

    const ballR = opts.ballRadius != null ? opts.ballRadius : PASS_SAFETY_BALL_RADIUS;
    const plyR = opts.playerRadius != null ? opts.playerRadius : PASS_SAFETY_PLAYER_RADIUS;

    const toTx = target.x - from.x;
    const toTy = target.y - from.y;
    const distSq = toTx * toTx + toTy * toTy;
    if (distSq < 1e-10) return true;

    const dist = Math.sqrt(distSq);
    const nx = toTx / dist;
    const ny = toTy / dist;

    // Opponent in pass-local frame (x along lane, y perpendicular)
    const relx = opp.x - from.x;
    const rely = opp.y - from.y;
    const localX = relx * nx + rely * ny;
    const localY = -relx * ny + rely * nx;

    // Behind the kicker: ball outruns lateral chase
    if (localX < 0) return true;

    const oppDistSqFromPasser = relx * relx + rely * rely;

    // Opponent farther from passer than the target: race to the landing spot
    if (distSq < oppDistSqFromPasser) {
        if (receiver) {
            const dOpp = dist2d(opp.x, opp.y, target.x, target.y);
            const dRecv = dist2d(receiver.x, receiver.y, target.x, target.y);
            return dOpp > dRecv;
        }
        return true;
    }

    const timeForBall = timeToCoverDistance(localX, passSpeed);
    if (timeForBall < 0) return false;

    let oppSpeed = opts.maxSpeed != null ? opts.maxSpeed : estimatePlayerMaxSpeed(opp);
    // Shot / soft-lane probes may under-weight defender close speed (arcade ISS-style)
    if (opts.maxSpeed == null && typeof opts.maxSpeedScale === 'number' && opts.maxSpeedScale > 0) {
        oppSpeed *= opts.maxSpeedScale;
    }
    const reach = oppSpeed * timeForBall + ballR + plyR;
    if (Math.abs(localY) < reach) {
        return false;
    }
    return true;
}

/**
 * True if no opponent in the pool can cut the pass.
 *
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} target
 * @param {{ x: number, y: number }|null} receiver
 * @param {Array} opponents
 * @param {number} passSpeed
 * @param {{ ballRadius?: number, playerRadius?: number }} [opts]
 */
function isPassSafeFromAllOpponents(from, target, receiver, opponents, passSpeed, opts = {}) {
    if (!opponents || opponents.length === 0) return true;
    for (let i = 0; i < opponents.length; i++) {
        const opp = opponents[i];
        if (!opp || opp.isSentOff) continue;
        if (!isPassSafeFromOpponent(from, target, receiver, opp, passSpeed, opts)) {
            return false;
        }
    }
    return true;
}

/**
 * Among candidates, prefer safe targets; fall back to closest if none are safe.
 * When lead geometry is available, each candidate is scored at their best aim point.
 * @param {object} passer
 * @param {Array} candidates
 * @param {Array} opponents
 * @param {{ passType?: string, scoreFn?: function, oppGoalX?: number }} [opts]
 * @returns {object|null} player entity (not aim)
 */
function pickBestSafePassTarget(passer, candidates, opponents, opts = {}) {
    if (!passer || !candidates || candidates.length === 0) return null;
    const passType = opts.passType || 'short';
    const from = { x: passer.x, y: passer.y };

    let bestSafe = null;
    let bestSafeScore = -Infinity;
    let bestAny = null;
    let bestAnyScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c || c.isSentOff || c === passer) continue;
        const dist = dist2d(passer.x, passer.y, c.x, c.y);
        // Default score: nearer is better (negative distance)
        const score = opts.scoreFn ? opts.scoreFn(c, dist) : -dist;
        if (score > bestAnyScore) {
            bestAnyScore = score;
            bestAny = c;
        }

        const lead = getBestPassToReceiver(from, c, passer, opponents, {
            passType,
            oppGoalX: opts.oppGoalX
        });
        if (lead) {
            if (score > bestSafeScore) {
                bestSafeScore = score;
                bestSafe = c;
            }
        } else {
            // Fallback: feet only (no lead) if that lane is still safe
            const speed = estimatePassGroundSpeed(from, c, passer, passType);
            if (isPassSafeFromAllOpponents(from, c, c, opponents, speed)) {
                if (score > bestSafeScore) {
                    bestSafeScore = score;
                    bestSafe = c;
                }
            }
        }
    }
    return bestSafe || bestAny;
}

/**
 * Tangent points from P to circle center C radius R.
 * @returns {{ t1: {x,y}, t2: {x,y} }|null} null if P is inside/on the circle
 */
function getTangentPoints(C, R, P) {
    if (!C || !P || !(R > 1e-6)) return null;
    const dx = P.x - C.x;
    const dy = P.y - C.y;
    const sqrLen = dx * dx + dy * dy;
    const rSqr = R * R;
    if (sqrLen <= rSqr) return null;

    const invSqrLen = 1 / sqrLen;
    const root = Math.sqrt(Math.abs(sqrLen - rSqr));

    return {
        t1: {
            x: C.x + R * (R * dx - dy * root) * invSqrLen,
            y: C.y + R * (R * dy + dx * root) * invSqrLen
        },
        t2: {
            x: C.x + R * (R * dx + dy * root) * invSqrLen,
            y: C.y + R * (R * dy - dx * root) * invSqrLen
        }
    };
}

/**
 * True if point is inside the playing field with a small margin.
 * @param {{ x: number, y: number }} pt
 * @param {{ width: number, height: number, multiplier?: number }|null} [field]
 * @param {number} [margin]
 */
function isPassPointInBounds(pt, field = null, margin = null) {
    if (!pt) return false;
    const f = field || Utils.getFieldBounds();
    const m = margin != null ? margin : 0.5 * (f.multiplier || 1);
    return pt.x >= m && pt.x <= f.width - m && pt.y >= m && pt.y <= f.height - m;
}

/**
 * Attack direction: +1 toward +X goal, −1 toward 0.
 * @param {object|null} passer
 * @param {object|null} [field]
 * @returns {number}
 */
function getAttackSign(passer, field = null) {
    if (passer && passer.level && typeof passer.level.isSecondHalf === 'function') {
        const attacksRight = passer.level.isSecondHalf()
            ? (passer.team === 'B')
            : (passer.team === 'A');
        return attacksRight ? 1 : -1;
    }
    return 1;
}

/**
 * Second-last defender X (offside / defensive line). Includes GK in the pool.
 * FIFA-style: opponents sorted by how deep they are toward the goal being attacked;
 * index 1 is the offside line.
 * @param {Array} opponents
 * @param {number} attackSign +1 attack right, −1 attack left
 * @returns {number|null}
 */
function getSecondLastDefenderX(opponents, attackSign) {
    if (!opponents || opponents.length < 2) return null;
    const xs = [];
    for (let i = 0; i < opponents.length; i++) {
        const p = opponents[i];
        if (!p || p.isSentOff) continue;
        xs.push(p.x);
    }
    if (xs.length < 2) return null;
    // Attacking +X: deepest defenders have largest x → sort desc, second entry is line
    if (attackSign > 0) {
        xs.sort((a, b) => b - a);
    } else {
        xs.sort((a, b) => a - b);
    }
    return xs[1];
}

function progressiveLeadWeight() {
    const v = Settings.AI && Settings.AI.PROGRESSIVE_LEAD_WEIGHT;
    return typeof v === 'number' ? v : PROGRESSIVE_LEAD_WEIGHT_DEFAULT;
}

function lineBreakBonus() {
    const v = Settings.AI && Settings.AI.LINE_BREAK_BONUS;
    return typeof v === 'number' ? v : LINE_BREAK_BONUS_DEFAULT;
}

function throughBallDepthWu() {
    const ref = (Settings.AI && Settings.AI.THROUGH_BALL_DEPTH_REF != null)
        ? Settings.AI.THROUGH_BALL_DEPTH_REF
        : THROUGH_BALL_DEPTH_REF_DEFAULT;
    return Utils.scaleFieldX(ref);
}

function throughBallLeadExtra() {
    const v = Settings.AI && Settings.AI.THROUGH_BALL_LEAD_EXTRA;
    return typeof v === 'number' ? v : THROUGH_BALL_LEAD_EXTRA_DEFAULT;
}

/**
 * Build lead-pass candidate points for a receiver.
 * Classic: tangents + feet + support + short forward lead.
 * A.7: deeper progressive leads + samples into space past the defensive line.
 *
 * @param {{ x: number, y: number }} from
 * @param {object} receiver
 * @param {object} passer
 * @param {'short'|'long'} [passType]
 * @param {{ x: number, y: number }|null} [supportPoint] - formation-support blend fallback
 * @param {Array|null} [opponents] - for through-ball line samples
 * @returns {Array<{ x: number, y: number }>}
 */
function buildLeadPassCandidates(from, receiver, passer, passType = 'short', supportPoint = null, opponents = null) {
    const recvPos = { x: receiver.x, y: receiver.y };
    const speed = estimatePassGroundSpeed(from, recvPos, passer, passType);
    const distToRecv = dist2d(from.x, from.y, recvPos.x, recvPos.y);
    const time = timeToCoverDistance(distToRecv, speed);
    const field = Utils.getFieldBounds();
    const sign = getAttackSign(passer, field);
    const baseRange = interceptRangeOr(time, receiver);
    const extra = throughBallLeadExtra();
    // Receiver ahead of passer along attack axis → allow deep progressive / through samples
    const recvAhead = (recvPos.x - from.x) * sign;

    const candidates = [];
    if (time >= 0 && baseRange > 1e-6) {
        const interceptRange = baseRange;
        const tangents = getTangentPoints(recvPos, interceptRange, from);
        if (tangents) {
            candidates.push(tangents.t1, tangents.t2);
        }
        // Deeper lead circle only when receiver is ahead (through-ball, not square/back)
        if (recvAhead > 0.25) {
            const deepR = interceptRange * extra;
            if (deepR > interceptRange + 0.05) {
                const deepT = getTangentPoints(recvPos, deepR, from);
                if (deepT) {
                    candidates.push(deepT.t1, deepT.t2);
                }
            }
        }
    }
    candidates.push(recvPos);

    if (supportPoint && (supportPoint.x !== recvPos.x || supportPoint.y !== recvPos.y)) {
        candidates.push({ x: supportPoint.x, y: supportPoint.y });
    }

    // Mild forward lead along attack axis — only if receiver is not behind the ball
    // (kickoff partner often sits slightly behind center; don't invent upfield aims)
    if (recvAhead > -0.15) {
        const maxFwd = Math.max(baseRange * (recvAhead > 0.5 ? extra : 0.85), Utils.scaleFieldX(2.5));
        const fwdDepths = recvAhead > 0.5 ? [0.45, 0.85, 1.15] : [0.35, 0.65];
        for (let i = 0; i < fwdDepths.length; i++) {
            const d = Math.min(maxFwd, Utils.scaleFieldX(6) * (passType === 'long' ? 1.35 : 1) * fwdDepths[i]);
            const fwd = {
                x: recvPos.x + sign * d,
                y: recvPos.y
            };
            if (isPassPointInBounds(fwd, field)) {
                candidates.push(fwd);
            }
            const lat = Utils.scaleFieldY(2.5) * (i === 1 ? 1 : 0.55);
            if (lat > 0.1 && recvAhead > 0.5) {
                const a = { x: fwd.x, y: recvPos.y + lat };
                const b = { x: fwd.x, y: recvPos.y - lat };
                if (isPassPointInBounds(a, field)) candidates.push(a);
                if (isPassPointInBounds(b, field)) candidates.push(b);
            }
        }
    }

    // A.7 through-ball corridor only when receiver is already ahead of passer
    const lineX = getSecondLastDefenderX(opponents, sign);
    if (lineX != null && recvAhead > 0.5) {
        const depth = throughBallDepthWu();
        const pastFracs = [0.2, 0.5, 0.85];
        const maxFwd = Math.max(baseRange * extra, Utils.scaleFieldX(4));
        for (let i = 0; i < pastFracs.length; i++) {
            const past = depth * pastFracs[i];
            const px = lineX + sign * past;
            const ys = [
                recvPos.y,
                recvPos.y * 0.65 + field.centerY * 0.35
            ];
            for (let j = 0; j < ys.length; j++) {
                const pt = { x: px, y: ys[j] };
                const dRecv = dist2d(recvPos.x, recvPos.y, pt.x, pt.y);
                if (dRecv > Math.max(maxFwd * 1.4, depth * 1.2)) continue;
                if (isPassPointInBounds(pt, field)) {
                    candidates.push(pt);
                }
            }
        }
    }

    return candidates;
}

function interceptRangeOr(time, receiver) {
    if (time < 0) return 0;
    return time * estimatePlayerMaxSpeed(receiver) * LEAD_RANGE_SCALE;
}

/**
 * A.7 score for a safe lead aim: progressive x-gain + line-break + goal proximity,
 * strongly tethered to the receiver (never invent an upfield aim for a back/square mate).
 *
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} pt
 * @param {object} receiver
 * @param {{
 *   oppGoalX: number,
 *   attackSign: number,
 *   lineX?: number|null,
 *   progressiveWeight?: number,
 *   lineBreakBonus?: number,
 *   preferFeet?: boolean
 * }} ctx
 * @returns {{ score: number, progressive: number, lineBreak: boolean }}
 */
function scoreProgressiveLeadAim(from, pt, receiver, ctx) {
    const sign = ctx.attackSign != null ? ctx.attackSign : 1;
    const wProg = ctx.progressiveWeight != null ? ctx.progressiveWeight : progressiveLeadWeight();
    const lb = ctx.lineBreakBonus != null ? ctx.lineBreakBonus : lineBreakBonus();
    const preferFeet = !!ctx.preferFeet;

    const progressive = (pt.x - from.x) * sign;
    const pastReceiver = (pt.x - receiver.x) * sign;
    const recvAhead = (receiver.x - from.x) * sign;
    const distRecv = dist2d(pt.x, pt.y, receiver.x, receiver.y);
    const goalProx = -Math.abs(pt.x - ctx.oppGoalX) * 0.08;

    // PreferFeet (kickoff / short lay-off): almost pure "to the player"
    if (preferFeet) {
        let score = -distRecv * 2.4 + progressive * 0.12 + goalProx * 0.25;
        return { score, progressive, lineBreak: false };
    }

    let score = goalProx;
    const maxLeadWu = throughBallDepthWu() * 1.15;

    // Progressive / through-ball when receiver is ahead; square/back stays glued to feet
    if (recvAhead > 0.25) {
        // Light tether + soft penalty only for runaway aims beyond runnable lead
        score -= distRecv * 0.22;
        const excess = Math.max(0, distRecv - maxLeadWu);
        score -= excess * 1.4;
        score += progressive * wProg * 0.9;
        score += Math.max(0, pastReceiver) * (wProg * 0.5);
    } else {
        // Square / back (e.g. kickoff partner): must aim near feet — no ghost upfield lead
        score -= distRecv * 1.85;
        score += progressive * 0.06;
        if (pastReceiver > 0.25) {
            score -= pastReceiver * 2.5;
        }
    }

    let lineBreak = false;
    if (recvAhead > 0.5 && ctx.lineX != null && Number.isFinite(ctx.lineX)) {
        const pastLine = (pt.x - ctx.lineX) * sign;
        if (pastLine > 0.05) {
            lineBreak = true;
            score += lb + Math.min(pastLine, throughBallDepthWu()) * 0.35;
        }
    }

    score -= Math.abs(pt.y - receiver.y) * 0.06;

    return { score, progressive, lineBreak };
}

/**
 * Goal-mouth Y bounds in world units (posts inset by ball radius).
 * Prefer Goal.getMouthYBounds when a Goal instance is available.
 * @param {{ multiplier?: number }|null} [field]
 * @param {{ yMin: number, yMax: number, getMouthYBounds?: function }|null} [goal]
 */
function getGoalMouthYBounds(field = null, goal = null) {
    const f = field || Utils.getFieldBounds();
    const ballR = PASS_SAFETY_BALL_RADIUS * (f.multiplier || 1);
    if (goal && typeof goal.getMouthYBounds === 'function') {
        return goal.getMouthYBounds(ballR);
    }
    if (goal && goal.yMin != null && goal.yMax != null) {
        return { yMin: goal.yMin + ballR, yMax: goal.yMax - ballR };
    }
    return {
        yMin: Utils.scaleFieldY(GOAL_MOUTH_Y_REF_MIN) + ballR,
        yMax: Utils.scaleFieldY(GOAL_MOUTH_Y_REF_MAX) - ballR
    };
}

/**
 * Initial ground speed for a shot (m/s) — matches computeShootKick / Settings.physics.
 * @param {object} [shooter]
 */
function estimateShotGroundSpeed(shooter) {
    let shooting = 65;
    if (shooter) {
        if (typeof shooter.effectiveShooting === 'number') {
            shooting = shooter.effectiveShooting;
        } else if (shooter.stats && typeof shooter.stats.shooting === 'number') {
            const stam = shooter.staminaMultiplier != null ? shooter.staminaMultiplier : 1;
            shooting = shooter.stats.shooting * stam;
        }
    }
    const phys = (Settings && Settings.physics) || {};
    const base = typeof phys.SHOOT_SPEED_BASE === 'number' ? phys.SHOOT_SPEED_BASE : 11.0;
    const scale = typeof phys.SHOOT_SPEED_STAT_SCALE === 'number' ? phys.SHOOT_SPEED_STAT_SCALE : 6.0;
    return base + (shooting / 100.0) * scale;
}

/**
 * AI knobs for arcade / ISS-leaning shot lane evaluation.
 * Strict pass-lane safety alone yields near-zero edge-of-box shots.
 */
function shootLaneAiNum(key, fallback) {
    const v = Settings.AI && Settings.AI[key];
    return typeof v === 'number' ? v : fallback;
}

/**
 * Count opponents who can cut a shot lane (standard reach rules).
 * @returns {number}
 */
function countShotLaneBlockers(from, target, opponents, power, laneOpts = {}) {
    if (!opponents || opponents.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < opponents.length; i++) {
        const opp = opponents[i];
        if (!opp || opp.isSentOff) continue;
        if (!isPassSafeFromOpponent(from, target, null, opp, power, laneOpts)) {
            n++;
        }
    }
    return n;
}

/**
 * Contested-shot acceptance probability (seeded via opts.random / Math.random).
 * Closer + fewer blockers → more likely (ISS shoot-on-sight).
 */
function contestedShotChance(distToMouth, blockers, shootRangeRef) {
    const base = shootLaneAiNum('SHOOT_CONTESTED_CHANCE', 0.42);
    const nearMult = shootLaneAiNum('SHOOT_CONTESTED_NEAR_MULT', 1.35);
    const farMult = shootLaneAiNum('SHOOT_CONTESTED_FAR_MULT', 0.55);
    const maxBlockers = shootLaneAiNum('SHOOT_CONTESTED_MAX_BLOCKERS', 3);

    if (blockers > maxBlockers) return 0;

    const range = Math.max(8, shootRangeRef || 42);
    // 0 at max range, 1 at feet of goal
    const near01 = Math.max(0, Math.min(1, 1 - distToMouth / range));
    const distMul = farMult + (nearMult - farMult) * near01;
    // Each blocker cuts chance; 0 blockers should not reach here
    const blockMul = Math.max(0.12, 1 - blockers * 0.28);
    return Math.max(0, Math.min(0.92, base * distMul * blockMul));
}

/**
 * Sample goal mouth for a viable shot; require reachability + lane safety
 * (shot treated as a pass to the goal point with null receiver).
 *
 * Arcade path (default):
 *  1) Fully safe mouth sample (strict defender reach)
 *  2) Soft-lane sample (defenders close slower — Settings.AI.SHOOT_LANE_OPP_SPEED_SCALE)
 *  3) Contested sample: fewest blockers, accepted with distance-weighted RNG
 *
 * Support-spot ranking can pass `allowContested: false` to skip step 3 (deterministic).
 *
 * @param {{ x: number, y: number }} ballPos
 * @param {object} shooter - used for power estimate and team attack direction if needed
 * @param {Array} opponents
 * @param {{
 *   oppGoalX?: number,
 *   goal?: { lineX?: number, sampleMouthTargets?: function, getMouthYBounds?: function },
 *   power?: number,
 *   numAttempts?: number,
 *   sampleYs?: number[],
 *   random?: function,
 *   field?: object,
 *   allowContested?: boolean,
 *   requireSafe?: boolean
 * }} [opts]
 * @returns {{ ok: boolean, target: {x:number,y:number}|null, power: number, contested?: boolean, soft?: boolean }}
 */
function canShoot(ballPos, shooter, opponents, opts = {}) {
    if (!ballPos) {
        return { ok: false, target: null, power: 0 };
    }

    const field = opts.field || Utils.getFieldBounds();
    const goal = opts.goal || null;
    let oppGoalX = opts.oppGoalX;
    if (oppGoalX == null && goal && goal.lineX != null) {
        oppGoalX = goal.lineX;
    }
    if (oppGoalX == null) {
        if (shooter && shooter.level && typeof shooter.level.isSecondHalf === 'function') {
            const attacksRight = shooter.level.isSecondHalf()
                ? (shooter.team === 'B')
                : (shooter.team === 'A');
            oppGoalX = attacksRight ? field.width : 0;
        } else {
            oppGoalX = field.width;
        }
    }

    const ballR = PASS_SAFETY_BALL_RADIUS * (field.multiplier || 1);
    const { yMin, yMax } = getGoalMouthYBounds(field, goal);
    const power = opts.power != null ? opts.power : estimateShotGroundSpeed(shooter);
    const rand = typeof opts.random === 'function' ? opts.random : Math.random;
    const attempts = opts.numAttempts != null ? opts.numAttempts : NUM_SHOOT_ATTEMPTS;
    const allowContested = opts.allowContested !== false && opts.requireSafe !== true;
    const softScale = shootLaneAiNum('SHOOT_LANE_OPP_SPEED_SCALE', 0.58);
    const softLaneOpts = { maxSpeedScale: softScale };

    const sampleYs = [];
    if (opts.sampleYs && opts.sampleYs.length) {
        for (let i = 0; i < opts.sampleYs.length; i++) {
            sampleYs.push(opts.sampleYs[i]);
        }
    } else if (goal && typeof goal.sampleMouthTargets === 'function') {
        const targets = goal.sampleMouthTargets(attempts, rand, ballR);
        for (let i = 0; i < targets.length; i++) {
            sampleYs.push(targets[i].y);
        }
    } else {
        // Center first, then random samples along the mouth (seeded via Math.random in match)
        sampleYs.push((yMin + yMax) * 0.5);
        sampleYs.push(yMin + (yMax - yMin) * 0.2);
        sampleYs.push(yMin + (yMax - yMin) * 0.8);
        for (let i = 0; i < attempts; i++) {
            sampleYs.push(yMin + rand() * (yMax - yMin));
        }
    }

    let bestSoft = null;
    let bestContested = null;
    let bestBlockers = Infinity;
    let bestContestedDist = Infinity;

    for (let i = 0; i < sampleYs.length; i++) {
        let y = sampleYs[i];
        if (y < yMin) y = yMin;
        if (y > yMax) y = yMax;
        const target = { x: oppGoalX, y };

        const dist = dist2d(ballPos.x, ballPos.y, target.x, target.y);
        const time = timeToCoverDistance(dist, power);
        if (time < 0) continue;

        // 1) Fully clear lane (strict)
        if (isPassSafeFromAllOpponents(ballPos, target, null, opponents, power)) {
            return { ok: true, target, power };
        }

        // 2) Soft lane: defenders close less aggressively (arcade)
        if (softScale < 1 && isPassSafeFromAllOpponents(
            ballPos, target, null, opponents, power, softLaneOpts
        )) {
            if (!bestSoft) bestSoft = target;
        }

        // Track least-blocked sample for contested force-shot
        const blockers = countShotLaneBlockers(ballPos, target, opponents, power);
        if (blockers < bestBlockers || (blockers === bestBlockers && dist < bestContestedDist)) {
            bestBlockers = blockers;
            bestContested = target;
            bestContestedDist = dist;
        }
    }

    if (bestSoft) {
        return { ok: true, target: bestSoft, power, soft: true };
    }

    if (allowContested && bestContested && bestBlockers < Infinity) {
        const rangeRef = Utils.scaleFieldX(shootLaneAiNum('SHOOT_RANGE_REF', 42));
        const p = contestedShotChance(bestContestedDist, bestBlockers, rangeRef);
        if (p > 0 && rand() < p) {
            return {
                ok: true,
                target: bestContested,
                power,
                contested: true,
                blockers: bestBlockers
            };
        }
    }

    return { ok: false, target: null, power };
}

/**
 * Best pass aim point to a receiver: among lead candidates, pick the one that is
 * in-bounds, pass-safe, and best by A.7 progressive / line-break scoring
 * (forward x-gain + space behind defensive line + goal proximity).
 *
 * @param {{ x: number, y: number }} from
 * @param {object} receiver
 * @param {object} passer
 * @param {Array} opponents
 * @param {{
 *   passType?: string,
 *   oppGoalX?: number,
 *   supportPoint?: {x,y}|null,
 *   field?: object,
 *   detail?: boolean,
 *   preferFeet?: boolean
 * }} [opts]
 * @returns {{ x: number, y: number }|null|{ x, y, progressive, lineBreak, score }}
 */
function getBestPassToReceiver(from, receiver, passer, opponents, opts = {}) {
    if (!from || !receiver) return null;
    const passType = opts.passType || 'short';
    const field = opts.field || Utils.getFieldBounds();
    const supportPoint = opts.supportPoint || null;
    const attackSign = getAttackSign(passer, field);
    const preferFeet = !!opts.preferFeet;

    const candidates = buildLeadPassCandidates(
        from, receiver, passer, passType, supportPoint, opponents
    );

    let oppGoalX = opts.oppGoalX;
    if (oppGoalX == null) {
        if (passer && passer.level && typeof passer.level.isSecondHalf === 'function') {
            oppGoalX = attackSign > 0 ? field.width : 0;
        } else {
            oppGoalX = field.width;
        }
    }

    const lineX = getSecondLastDefenderX(opponents, attackSign);
    const scoreCtx = {
        oppGoalX,
        attackSign,
        lineX,
        progressiveWeight: progressiveLeadWeight(),
        lineBreakBonus: lineBreakBonus(),
        preferFeet
    };

    let best = null;
    let bestScore = -Infinity;
    let bestMeta = null;

    for (let i = 0; i < candidates.length; i++) {
        const pt = candidates[i];
        if (!isPassPointInBounds(pt, field)) continue;

        const speed = estimatePassGroundSpeed(from, pt, passer, passType);
        if (!isPassSafeFromAllOpponents(from, pt, receiver, opponents, speed)) continue;

        const meta = scoreProgressiveLeadAim(from, pt, receiver, scoreCtx);
        // Deterministic tie-break: higher progressive, then lower |y - recv|, then lower x
        let better = meta.score > bestScore + 1e-9;
        if (!better && Math.abs(meta.score - bestScore) <= 1e-9 && best) {
            if (meta.progressive > bestMeta.progressive + 1e-9) better = true;
            else if (Math.abs(meta.progressive - bestMeta.progressive) <= 1e-9) {
                const dy = Math.abs(pt.y - receiver.y);
                const bestDy = Math.abs(best.y - receiver.y);
                if (dy < bestDy - 1e-9) better = true;
                else if (Math.abs(dy - bestDy) <= 1e-9 && pt.x < best.x) better = true;
            }
        }
        if (better) {
            bestScore = meta.score;
            best = { x: pt.x, y: pt.y };
            bestMeta = meta;
        }
    }

    if (!best) return null;
    if (opts.detail) {
        return {
            x: best.x,
            y: best.y,
            progressive: bestMeta.progressive,
            lineBreak: bestMeta.lineBreak,
            score: bestScore
        };
    }
    return best;
}

/**
 * Outfield shot blocking check: checks if any outfield defender blocks a shot in flight.
 * Deflects the ball and returns true if blocked.
 * @param {object} sim - Simulator
 * @param {number} [dt=0.05]
 * @returns {boolean} true if blocked
 */
function tryBallShotBlocking(sim, dt = 0.05) {
    const ball = sim.ball;
    if (!ball || !ball.isShot || ball.owner) return false;

    // We need to know who the opponents are.
    // If the ball has a lastKicker, opponents are on the other team.
    if (!ball.lastKicker) return false;

    const shooterTeam = ball.lastKicker.team;
    const opponentTeam = shooterTeam === 'A' ? sim.teamB : sim.teamA;
    if (!opponentTeam) return false;

    const opponents = opponentTeam.getOutfieldPlayers();
    if (!opponents || !opponents.length) return false;

    // Ball travel segment in the current tick
    const from = { x: ball.prevX, y: ball.prevY };
    const target = { x: ball.x, y: ball.y };

    const toTx = target.x - from.x;
    const toTy = target.y - from.y;
    const distSq = toTx * toTx + toTy * toTy;
    if (distSq < 1e-6) return false;

    const dist = Math.sqrt(distSq);
    const nx = toTx / dist;
    const ny = toTy / dist;

    const ballR = ball.radius || 0.11;
    // Arcade: thinner block body so more shots thread the box (still can block point-blank)
    const plyRDefault = 0.28;
    const plyRAi = Settings.AI && typeof Settings.AI.SHOT_BLOCK_PLAYER_RADIUS === 'number'
        ? Settings.AI.SHOT_BLOCK_PLAYER_RADIUS
        : plyRDefault;
    const plyR = plyRAi;
    const blockHeight = Settings.AI && typeof Settings.AI.SHOT_BLOCK_MAX_Z === 'number'
        ? Settings.AI.SHOT_BLOCK_MAX_Z
        : 1.55;

    // Check height: outfielders block low drives; lofted shots clear more often (ISS)
    if (ball.z >= blockHeight) return false;

    for (let i = 0; i < opponents.length; i++) {
        const opp = opponents[i];
        if (!opp || opp.isSentOff || opp.role === 'GK') continue;

        // Opponent in local frame (x along line, y perpendicular)
        const relx = opp.x - from.x;
        const rely = opp.y - from.y;
        const localX = relx * nx + rely * ny;
        const localY = -relx * ny + rely * nx;

        // Is the defender situated along the travel segment?
        // Allow a tiny margin at start/end
        if (localX < -0.1 || localX > dist + 0.1) continue;

        // Reuse lane geometry: can the opponent reach the lane in the time the ball takes to get there?
        // timeForBall is the fraction of dt corresponding to localX
        const timeFraction = Math.max(0, Math.min(1, localX / dist));
        const timeForBall = timeFraction * dt;

        // Smaller reaction time for last-ditch block, e.g. 0.02s
        const reactionTime = 0.02;
        const oppSpeed = estimatePlayerMaxSpeed(opp) * (
            Settings.AI && typeof Settings.AI.SHOT_BLOCK_OPP_SPEED_SCALE === 'number'
                ? Settings.AI.SHOT_BLOCK_OPP_SPEED_SCALE
                : 0.65
        );
        const reach = oppSpeed * Math.max(0, timeForBall - reactionTime) + ballR + plyR;

        if (Math.abs(localY) < reach) {
            // Blocked!
            ball.isShot = false;

            // Deflect the ball: soften velocity and reflect/scatter
            const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
            const defSpeed = Math.max(speed * 0.45, 2.5); // Softened speed

            // Scatter angle: redirect somewhat lateral or back
            // Find normal from player to ball intersection point on the lane
            const px = from.x + nx * localX;
            const py = from.y + ny * localX;
            const pdx = px - opp.x;
            const pdy = py - opp.y;
            const pd = Math.sqrt(pdx * pdx + pdy * pdy);

            let rx = -nx; // Default bounce backward
            let ry = -ny;
            if (pd > 0.01) {
                // Blend lateral normal with backward bounce
                const lx = pdx / pd;
                const ly = pdy / pd;
                const bx = lx * 0.6 - nx * 0.4;
                const by = ly * 0.6 - ny * 0.4;
                const bl = Math.sqrt(bx * bx + by * by);
                if (bl > 0.01) {
                    rx = bx / bl;
                    ry = by / bl;
                }
            }

            // Add a small random scatter angle (±30 degrees)
            const angle = (Math.random() - 0.5) * 2 * (30 * Math.PI / 180);
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            const dx = rx * cosA - ry * sinA;
            const dy = rx * sinA + ry * cosA;

            ball.vx = dx * defSpeed;
            ball.vy = dy * defSpeed;
            ball.vz = 0.5 + Math.random() * 0.8; // pop ball up slightly
            ball.curveForce = 0;

            // Reposition ball outside defender body to prevent overlap issues
            const overlapD = ballR + plyR;
            ball.x = opp.x + dx * overlapD;
            ball.y = opp.y + dy * overlapD;

            // Block deflection — body impact + crowd reaction
            const soundDbModule = require('./sounddb.js');
            if (soundDbModule && soundDbModule.SoundDB) {
                soundDbModule.SoundDB.play('tackle');
                soundDbModule.SoundDB.crowdReact('ooh', 0.3);
            }

            // Outfield block is a second touch (IFK becomes legal goal after this)
            clearIfkOnTouch(ball, opp);

            // Telemetry
            if (sim._telemetry && typeof sim._telemetry.onBlock === 'function') {
                sim._telemetry.onBlock();
            }
            return true;
        }
    }
    return false;
}

module.exports = {
    PASS_SAFETY_BALL_RADIUS,
    PASS_SAFETY_PLAYER_RADIUS,
    LEAD_RANGE_SCALE,
    PROGRESSIVE_LEAD_WEIGHT_DEFAULT,
    LINE_BREAK_BONUS_DEFAULT,
    THROUGH_BALL_DEPTH_REF_DEFAULT,
    THROUGH_BALL_LEAD_EXTRA_DEFAULT,
    GOAL_MOUTH_Y_REF_MIN,
    GOAL_MOUTH_Y_REF_MAX,
    NUM_SHOOT_ATTEMPTS,
    dist2d,
    estimatePlayerMaxSpeed,
    estimatePassGroundSpeed,
    speedAfterDistance,
    maxTravelDistance,
    estimateShotGroundSpeed,
    timeToCoverDistance,
    isPassSafeFromOpponent,
    isPassSafeFromAllOpponents,
    pickBestSafePassTarget,
    getTangentPoints,
    isPassPointInBounds,
    buildLeadPassCandidates,
    getBestPassToReceiver,
    getGoalMouthYBounds,
    canShoot,
    countShotLaneBlockers,
    contestedShotChance,
    getAttackSign,
    getSecondLastDefenderX,
    scoreProgressiveLeadAim,
    tryBallShotBlocking
};
