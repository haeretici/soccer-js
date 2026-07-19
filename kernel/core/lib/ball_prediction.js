/**
 * Ball prediction helpers — TimeToCoverDistance /
 * FuturePosition spirit, matched to soccer-js ground friction.
 *
 * Ground model (see ball.js): when z === 0 each sub-step multiplies
 *   vx,vy *= Math.pow(GROUND_FRICTION_BASE, dt)
 * which is continuous exponential decay:
 *   v(t) = v0 * BASE^t = v0 * exp(-k t),  k = -ln(BASE)
 *   s(t) = (v0 / k) * (1 - exp(-k t))
 *
 * Pass safety, CanShoot reachability, and loose-ball intercepts share this math.
 * 3D path (predict3D) mirrors ball.js using Settings.physics.
 */

const { Settings } = require('../../settings.js');

function phys() {
    return (Settings && Settings.physics) || {};
}

/** Live gravity (m/s²) — always read from Settings.physics. */
function getGravity() {
    const g = phys().GRAVITY;
    return typeof g === 'number' ? g : 9.81;
}

function getGroundFrictionBase() {
    const v = phys().GROUND_FRICTION_BASE;
    return typeof v === 'number' ? v : 0.65;
}

/** Horizontal drag base while airborne (must match ball.js). */
function getAirDragBase() {
    const v = phys().AIR_DRAG_BASE;
    return typeof v === 'number' ? v : 0.88;
}

function getBallStopSpeed() {
    const v = phys().BALL_STOP_SPEED;
    return typeof v === 'number' ? v : 0.1;
}

/** Same base as ball.js ground friction: v *= pow(BASE, dt). */
const GROUND_FRICTION_BASE = getGroundFrictionBase();

/** Speeds below this are treated as stopped (matches ball.js). */
const BALL_STOP_SPEED = getBallStopSpeed();

/** Decay rate k where v(t) = v0 * e^{-k t}. */
const FRICTION_K = -Math.log(GROUND_FRICTION_BASE);

/**
 * Long/lob pass initial vz from distance (Settings.physics loft curve).
 * @param {number} dist - ground distance (m)
 * @returns {number} vz (m/s)
 */
function longPassVzForDistance(dist) {
    const p = phys();
    const base = typeof p.LONG_PASS_VZ_BASE === 'number' ? p.LONG_PASS_VZ_BASE : 5.5;
    const per = typeof p.LONG_PASS_VZ_PER_DIST === 'number' ? p.LONG_PASS_VZ_PER_DIST : 0.16;
    const cap = typeof p.LONG_PASS_VZ_CAP === 'number' ? p.LONG_PASS_VZ_CAP : 7.5;
    const d = Math.max(0, dist || 0);
    return base + Math.min(d * per, cap);
}

/**
 * Hang time for a lob from z=0 with given vz (first landing, no bounce).
 * @param {number} vz
 * @returns {number} seconds
 */
function longPassHangTime(vz) {
    const g = getGravity();
    if (!(vz > 0) || !(g > 0)) return 0.5;
    return Math.max(0.35, (2 * vz) / g);
}

/**
 * Initial horizontal speed for a long/lob pass covering `dist` in the air.
 * Uses hang time from loft + AIR_DRAG (not ground friction — air has no roll decay).
 * @param {number} dist
 * @returns {number} m/s
 */
function longPassInitialSpeed(dist) {
    const p = phys();
    const d = Math.max(0, dist || 0);
    const vz = longPassVzForDistance(d);
    const hang = longPassHangTime(vz);
    const scale = typeof p.PASS_LONG_AIR_RANGE_SCALE === 'number'
        ? p.PASS_LONG_AIR_RANGE_SCALE
        : 0.90;
    const target = d * scale;
    const airBase = getAirDragBase();
    const k = frictionDecayRate(airBase);
    let v0;
    if (k <= 1e-12) {
        v0 = hang > 1e-6 ? target / hang : target;
    } else {
        // Under air drag: s = (v0/k)*(1 − e^{−kT}) ⇒ v0 = s·k / (1 − e^{−kT})
        const denom = 1 - Math.exp(-k * hang);
        v0 = denom > 1e-9 ? (target * k) / denom : target / hang;
    }
    const minS = typeof p.PASS_LONG_MIN_SPEED === 'number' ? p.PASS_LONG_MIN_SPEED : 8.0;
    const maxS = typeof p.PASS_LONG_MAX_SPEED === 'number' ? p.PASS_LONG_MAX_SPEED : 16.5;
    if (v0 < minS) v0 = minS;
    if (v0 > maxS) v0 = maxS;
    return v0;
}

/**
 * @param {number} [frictionBase=GROUND_FRICTION_BASE]
 * @returns {number}
 */
function frictionDecayRate(frictionBase = GROUND_FRICTION_BASE) {
    if (!(frictionBase > 0) || frictionBase >= 1) {
        // No decay / invalid → treat as constant speed (k → 0)
        return 0;
    }
    return -Math.log(frictionBase);
}

/**
 * Max ground distance a ball can travel before stopping (friction model).
 * @param {number} initialSpeed
 * @param {number} [frictionBase]
 * @returns {number} Infinity if no friction
 */
function maxTravelDistance(initialSpeed, frictionBase = GROUND_FRICTION_BASE) {
    if (!(initialSpeed > BALL_STOP_SPEED)) return 0;
    const k = frictionDecayRate(frictionBase);
    if (k <= 1e-12) return Infinity;
    return initialSpeed / k;
}

/**
 * Ground speed after traveling `distance` under friction (v = v0 − k·s).
 * @param {number} initialSpeed
 * @param {number} distance
 * @param {number} [frictionBase]
 * @returns {number}
 */
function speedAfterDistance(initialSpeed, distance, frictionBase = GROUND_FRICTION_BASE) {
    if (!(initialSpeed > BALL_STOP_SPEED) || !(distance > 0)) {
        return initialSpeed > 0 ? initialSpeed : 0;
    }
    const k = frictionDecayRate(frictionBase);
    if (k <= 1e-12) return initialSpeed;
    const maxD = initialSpeed / k;
    if (distance >= maxD) return 0;
    const v = initialSpeed - k * distance;
    return v > 0 ? v : 0;
}

/**
 * Choose initial kick speed so the ball arrives near `distance` with a soft residual.
 *
 * Under ground friction: v_arrival = v0 − k·d  ⇒  v0 = v_arrival + k·d.
 * A small range cushion (>1) keeps the ball crawling slightly past the feet
 * instead of dying short.
 *
 * @param {number} distance - aim distance (world units)
 * @param {{
 *   arrivalSpeed?: number,
 *   cushion?: number,
 *   minSpeed?: number,
 *   maxSpeed?: number,
 *   frictionBase?: number
 * }} [opts]
 * @returns {number}
 */
function initialSpeedForDistance(distance, opts = {}) {
    const frictionBase = opts.frictionBase != null ? opts.frictionBase : GROUND_FRICTION_BASE;
    const k = frictionDecayRate(frictionBase);
    const arrival = opts.arrivalSpeed != null ? opts.arrivalSpeed : 3.0; // Bumped from 2.0
    const cushion = opts.cushion != null ? opts.cushion : 1.08;
    const minSpeed = opts.minSpeed != null ? opts.minSpeed : 5.0; // Bumped from 3.5
    const maxSpeed = opts.maxSpeed != null ? opts.maxSpeed : 35.0; // Accommodate new 32m/s shots

    const d = Math.max(0, distance);
    let v0;
    if (k <= 1e-12) {
        // Constant-speed fallback: cover distance in ~0.6–1.2s
        v0 = d > 0.05 ? d / 0.75 : minSpeed;
    } else {
        // Slightly beyond aim so residual at feet is still positive / soft
        const dEff = d * cushion;
        v0 = arrival + k * dEff;
        // Guarantee aim is reachable (max range > d)
        const minReach = k * d * 1.02 + Math.max(0.5, arrival * 0.35);
        if (v0 < minReach) v0 = minReach;
    }

    if (v0 < minSpeed) v0 = minSpeed;
    if (v0 > maxSpeed) v0 = maxSpeed;
    return v0;
}

/**
 * Ground distance covered in time t under exponential friction.
 * @param {number} initialSpeed
 * @param {number} time
 * @param {number} [frictionBase]
 */
function distanceCoveredInTime(initialSpeed, time, frictionBase = GROUND_FRICTION_BASE) {
    if (!(initialSpeed > 0) || !(time > 0)) return 0;
    const k = frictionDecayRate(frictionBase);
    if (k <= 1e-12) return initialSpeed * time;
    return (initialSpeed / k) * (1 - Math.exp(-k * time));
}

/**
 * Time for a kicked ball to travel `distance` under ground friction
 * on the ground under friction, given initial ground speed.
 *
 * Returns -1 if unreachable (speed too low or distance beyond max range).
 *
 * @param {number} distance
 * @param {number} initialSpeed - kick / pass ground speed
 * @param {{ frictionBase?: number, constantSpeed?: boolean }} [opts]
 * @returns {number}
 */
function timeToCoverDistance(distance, initialSpeed, opts = {}) {
    if (distance <= 0) return 0;
    if (!(initialSpeed > 0.01)) return -1;

    // Legacy / unit tests: pure constant velocity
    if (opts.constantSpeed) {
        return distance / initialSpeed;
    }

    const frictionBase = opts.frictionBase != null ? opts.frictionBase : GROUND_FRICTION_BASE;
    const k = frictionDecayRate(frictionBase);

    if (k <= 1e-12) {
        return distance / initialSpeed;
    }

    const maxDist = initialSpeed / k;
    // Small epsilon so floating noise at the asymptote does not falsely allow
    if (distance >= maxDist * 0.999999) return -1;

    // s = (v0/k)(1 - e^{-kt})  →  t = -ln(1 - s*k/v0) / k
    const ratio = (distance * k) / initialSpeed;
    if (ratio >= 1) return -1;
    return -Math.log(1 - ratio) / k;
}

/**
 * Future ground position after time t under friction (no Magnus / no bounce).
 *
 * @param {number} x
 * @param {number} y
 * @param {number} vx
 * @param {number} vy
 * @param {number} time
 * @param {{ frictionBase?: number }} [opts]
 * @returns {{ x: number, y: number, vx: number, vy: number }}
 */
function futurePositionFromVelocity(x, y, vx, vy, time, opts = {}) {
    const speed0 = Math.sqrt(vx * vx + vy * vy);
    if (!(time > 0) || speed0 < BALL_STOP_SPEED) {
        return { x, y, vx: speed0 < BALL_STOP_SPEED ? 0 : vx, vy: speed0 < BALL_STOP_SPEED ? 0 : vy };
    }

    const frictionBase = opts.frictionBase != null ? opts.frictionBase : GROUND_FRICTION_BASE;
    const k = frictionDecayRate(frictionBase);
    const ux = vx / speed0;
    const uy = vy / speed0;

    let dist;
    let speedT;
    if (k <= 1e-12) {
        dist = speed0 * time;
        speedT = speed0;
    } else {
        dist = (speed0 / k) * (1 - Math.exp(-k * time));
        speedT = speed0 * Math.exp(-k * time);
        if (speedT < BALL_STOP_SPEED) {
            speedT = 0;
        }
    }

    return {
        x: x + ux * dist,
        y: y + uy * dist,
        vx: ux * speedT,
        vy: uy * speedT
    };
}

/**
 * Future position from a ball-like object ({ x, y, z, vx, vy, vz }).
 * @param {{ x: number, y: number, z?: number, vx?: number, vy?: number, vz?: number, curveForce?: number }} ball
 * @param {number} time
 * @param {{ frictionBase?: number }} [opts]
 */
function futurePosition(ball, time, opts = {}) {
    if (!ball) return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    const bz = ball.z || 0;
    const bvz = ball.vz || 0;
    if (bz > 0.0001 || bvz > 0) {
        return predict3D(ball, time, opts);
    }
    const groundPred = futurePositionFromVelocity(
        ball.x,
        ball.y,
        ball.vx || 0,
        ball.vy || 0,
        time,
        opts
    );
    return {
        x: groundPred.x,
        y: groundPred.y,
        z: 0,
        vx: groundPred.vx,
        vy: groundPred.vy,
        vz: 0
    };
}

/**
 * Predicts the 3D position and velocity of the ball at time t using 3D flight integration.
 * @param {{ x: number, y: number, z?: number, vx?: number, vy?: number, vz?: number, curveForce?: number }} ball
 * @param {number} time
 * @param {object} [opts]
 * @returns {{ x: number, y: number, z: number, vx: number, vy: number, vz: number }}
 */
function predict3D(ball, time, opts = {}) {
    let x = ball.x;
    let y = ball.y;
    let z = ball.z || 0;
    let vx = ball.vx || 0;
    let vy = ball.vy || 0;
    let vz = ball.vz || 0;
    let curveForce = ball.curveForce || 0;

    let dtRemaining = time;
    const maxStep = 0.05;
    // Snapshot Settings.physics once (must match ball.js)
    const p = phys();
    const magnusScale = typeof p.MAGNUS_ACC_SCALE === 'number' ? p.MAGNUS_ACC_SCALE : 0.15;
    const magnusCap = typeof p.MAGNUS_VEL_CAP === 'number' ? p.MAGNUS_VEL_CAP : 10.0;
    const curveDecay = typeof p.CURVE_DECAY_BASE === 'number' ? p.CURVE_DECAY_BASE : 0.80;
    const curveStop = typeof p.CURVE_FORCE_STOP === 'number' ? p.CURVE_FORCE_STOP : 0.05;
    const bounceMinVz = typeof p.BOUNCE_MIN_VZ === 'number' ? p.BOUNCE_MIN_VZ : 1.5;
    const bounceRest = typeof p.BOUNCE_RESTITUTION === 'number' ? p.BOUNCE_RESTITUTION : 0.6;
    const bounceDamp = typeof p.BOUNCE_HORIZONTAL_DAMP === 'number' ? p.BOUNCE_HORIZONTAL_DAMP : 0.85;
    const g = getGravity();
    const frictionBase = getGroundFrictionBase();
    const airDragBase = getAirDragBase();
    const stopSpeed = getBallStopSpeed();

    while (dtRemaining > 0.0001) {
        const dt = Math.min(maxStep, dtRemaining);
        dtRemaining -= dt;

        if (curveForce && (vx !== 0 || vy !== 0)) {
            const vel = Math.sqrt(vx * vx + vy * vy);
            if (vel > 0.1) {
                const px = -vy / vel;
                const py = vx / vel;

                const magnusVel = Math.min(vel, magnusCap);
                const accX = px * curveForce * magnusVel * magnusScale;
                const accY = py * curveForce * magnusVel * magnusScale;

                vx += accX * dt;
                vy += accY * dt;
                curveForce *= Math.pow(curveDecay, dt);
                if (Math.abs(curveForce) < curveStop) curveForce = 0;
            }
        }

        if (z > 0) {
            vz -= g * dt;
            // Horizontal air drag (long balls must not cruise at constant speed)
            const airF = Math.pow(airDragBase, dt);
            vx *= airF;
            vy *= airF;
        }

        // Move
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;

        // Bounce on ground
        if (z <= 0) {
            z = 0;
            if (Math.abs(vz) > bounceMinVz) {
                vz = -vz * bounceRest;
                vx *= bounceDamp;
                vy *= bounceDamp;
            } else {
                vz = 0;
            }
        }

        // Ground friction
        if (z === 0) {
            const friction = Math.pow(frictionBase, dt);
            vx *= friction;
            vy *= friction;

            if (Math.sqrt(vx * vx + vy * vy) < stopSpeed) {
                vx = 0;
                vy = 0;
            }
        }
    }

    return { x, y, z, vx, vy, vz };
}

/**
 * Calculates the time until the ball next hits the ground (z <= 0).
 * If the ball is already on the ground (z === 0) and not rising, returns 0.
 * @param {{ x: number, y: number, z?: number, vx?: number, vy?: number, vz?: number, curveForce?: number }} ball
 * @param {number} [maxTime=4.0]
 * @returns {number} Time in seconds, or -1 if it doesn't bounce within maxTime
 */
function timeToBounce(ball, maxTime = 4.0) {
    let z = ball.z || 0;
    let vz = ball.vz || 0;
    if (z <= 0 && vz <= 0) return 0;

    let x = ball.x;
    let y = ball.y;
    let vx = ball.vx || 0;
    let vy = ball.vy || 0;
    let curveForce = ball.curveForce || 0;

    let elapsed = 0;
    const dt = 0.05; // Matches maxStep of predict3D and ball.js
    const p = phys();
    const magnusScale = typeof p.MAGNUS_ACC_SCALE === 'number' ? p.MAGNUS_ACC_SCALE : 0.15;
    const magnusCap = typeof p.MAGNUS_VEL_CAP === 'number' ? p.MAGNUS_VEL_CAP : 10.0;
    const curveDecay = typeof p.CURVE_DECAY_BASE === 'number' ? p.CURVE_DECAY_BASE : 0.80;
    const curveStop = typeof p.CURVE_FORCE_STOP === 'number' ? p.CURVE_FORCE_STOP : 0.05;
    const g = getGravity();
    const airDragBase = getAirDragBase();

    while (elapsed < maxTime) {
        if (curveForce && (vx !== 0 || vy !== 0)) {
            const vel = Math.sqrt(vx * vx + vy * vy);
            if (vel > 0.1) {
                const px = -vy / vel;
                const py = vx / vel;

                const magnusVel = Math.min(vel, magnusCap);
                const accX = px * curveForce * magnusVel * magnusScale;
                const accY = py * curveForce * magnusVel * magnusScale;

                vx += accX * dt;
                vy += accY * dt;
                curveForce *= Math.pow(curveDecay, dt);
                if (Math.abs(curveForce) < curveStop) curveForce = 0;
            }
        }

        if (z > 0) {
            vz -= g * dt;
            const airF = Math.pow(airDragBase, dt);
            vx *= airF;
            vy *= airF;
        }

        // Move
        const prevZ = z;
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        elapsed += dt;

        if (z <= 0) {
            // Interpolate for more precise time
            if (vz < 0 && prevZ > 0) {
                const fraction = prevZ / (prevZ - z);
                return elapsed - dt + fraction * dt;
            }
            return elapsed;
        }
    }
    return -1;
}

/**
 * Predicts the height of the ball at a specific time t, taking gravity and bounce into account.
 * @param {{ x: number, y: number, z?: number, vx?: number, vy?: number, vz?: number, curveForce?: number }} ball
 * @param {number} t
 * @returns {number}
 */
function heightAtT(ball, t) {
    if (t <= 0) return ball.z || 0;
    const pred = predict3D(ball, t);
    return pred.z;
}

/**
 * Sample ball positions along a predicted path (for debug / intercept search).
 * @param {{ x: number, y: number, vx?: number, vy?: number }} ball
 * @param {number} maxTime
 * @param {number} [dt=0.05]
 * @param {{ frictionBase?: number }} [opts]
 * @returns {{ x: number, y: number, z: number, t: number }[]}
 */
function sampleTrajectory(ball, maxTime, dt = 0.05, opts = {}) {
    const out = [];
    if (!ball || !(maxTime > 0) || !(dt > 0)) return out;
    for (let t = 0; t <= maxTime + 1e-9; t += dt) {
        const p = futurePosition(ball, t, opts);
        out.push({ x: p.x, y: p.y, z: p.z || 0, t });
    }
    return out;
}

/** Default header contact band (m) — matches AI Header claim band. */
const HEADER_Z_MIN = 0.9;
const HEADER_Z_MAX = 2.0;

/**
 * True if height is in the header contact band.
 * @param {number} z
 * @param {{ zMin?: number, zMax?: number }} [opts]
 */
function isHeaderHeight(z, opts = {}) {
    const zMin = typeof opts.zMin === 'number' ? opts.zMin : HEADER_Z_MIN;
    const zMax = typeof opts.zMax === 'number' ? opts.zMax : HEADER_Z_MAX;
    const h = z || 0;
    return h >= zMin && h < zMax;
}

/**
 * True if the ball is currently (or soon) airborne enough to justify air intercepts.
 * @param {{ z?: number, vz?: number }|null} ball
 * @param {{ minZ?: number, minVz?: number }} [opts]
 */
function isBallAirborne(ball, opts = {}) {
    if (!ball) return false;
    const minZ = typeof opts.minZ === 'number' ? opts.minZ : 0.25;
    const minVz = typeof opts.minVz === 'number' ? opts.minVz : 0.8;
    return (ball.z || 0) > minZ || (ball.vz || 0) > minVz;
}

/**
 * Best 3D intercept sample along the ball path for an agent with known top speed.
 * Shared by loose-ball chase, AI Header entry, and human header windows.
 *
 * @param {{ x: number, y: number, z?: number, vx?: number, vy?: number, vz?: number, curveForce?: number }} ball
 * @param {{ x: number, y: number, speed?: number }} agent - position + optional top speed (m/s)
 * @param {{
 *   maxTime?: number,
 *   dt?: number,
 *   zMin?: number|null,
 *   zMax?: number|null,
 *   reachSlack?: number,
 *   preferT?: number,
 *   tWeight?: number
 * }} [opts]
 *   zMin/zMax: null = no height filter; numbers clamp the usable band.
 *   reachSlack: extra metres of “can still get there” forgiveness.
 *   preferT: bias score toward this arrival time (e.g. header contact ~0.45s).
 * @returns {{
 *   ok: boolean,
 *   t: number,
 *   x: number,
 *   y: number,
 *   z: number,
 *   reachDist: number,
 *   canReach: boolean,
 *   score: number
 * }}
 */
function findAirIntercept(ball, agent, opts = {}) {
    const empty = {
        ok: false,
        t: 0,
        x: ball ? ball.x : 0,
        y: ball ? ball.y : 0,
        z: ball ? (ball.z || 0) : 0,
        reachDist: Infinity,
        canReach: false,
        score: -Infinity
    };
    if (!ball || !agent) return empty;

    const maxTime = typeof opts.maxTime === 'number' ? opts.maxTime : 1.4;
    const dt = typeof opts.dt === 'number' ? opts.dt : 0.05;
    const zMin = opts.zMin === null ? null : (typeof opts.zMin === 'number' ? opts.zMin : null);
    const zMax = opts.zMax === null ? null : (typeof opts.zMax === 'number' ? opts.zMax : null);
    const reachSlack = typeof opts.reachSlack === 'number' ? opts.reachSlack : 0.55;
    const preferT = typeof opts.preferT === 'number' ? opts.preferT : 0.45;
    const tWeight = typeof opts.tWeight === 'number' ? opts.tWeight : 1.2;
    const speed = Math.max(0.5, typeof agent.speed === 'number' ? agent.speed : 5.5);

    let best = null;

    for (let t = 0; t <= maxTime + 1e-9; t += dt) {
        const pred = futurePosition(ball, t);
        const z = pred.z || 0;
        if (zMin != null && z < zMin) continue;
        if (zMax != null && z >= zMax) continue;

        const dx = pred.x - agent.x;
        const dy = pred.y - agent.y;
        const reachDist = Math.sqrt(dx * dx + dy * dy);
        const maxReach = speed * t + reachSlack;
        const canReach = reachDist <= maxReach;
        // Lower is better raw cost; invert to score
        const late = Math.abs(t - preferT);
        const reachPenalty = canReach ? 0 : (reachDist - maxReach) * 2.5;
        const cost = reachDist + late * tWeight + reachPenalty;
        const score = -cost + (canReach ? 4.0 : 0);

        if (!best || score > best.score) {
            best = {
                ok: canReach,
                t,
                x: pred.x,
                y: pred.y,
                z,
                reachDist,
                canReach,
                score
            };
        }
    }

    if (!best) return empty;
    // ok only when at least one reachable sample existed; still return best sample
    return best;
}

/**
 * Header opportunity for AI auto-jump and human timed headers.
 * Looks for a reachable sample in the header height band near contact timing.
 *
 * @param {{ x: number, y: number, z?: number, vx?: number, vy?: number, vz?: number }} ball
 * @param {{ x: number, y: number, speed?: number }} player
 * @param {{
 *   maxTime?: number,
 *   zMin?: number,
 *   zMax?: number,
 *   contactRadius?: number,
 *   jumpLead?: number,
 *   playerSpeed?: number
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   t: number,
 *   x: number,
 *   y: number,
 *   z: number,
 *   reachDist: number,
 *   inWindow: boolean
 * }}
 */
function findHeaderOpportunity(ball, player, opts = {}) {
    const empty = {
        ok: false,
        t: 0,
        x: 0,
        y: 0,
        z: 0,
        reachDist: Infinity,
        inWindow: false
    };
    if (!ball || !player) return empty;
    if (!isBallAirborne(ball) && !isHeaderHeight(ball.z || 0, opts)) {
        return empty;
    }

    const zMin = typeof opts.zMin === 'number' ? opts.zMin : HEADER_Z_MIN;
    const zMax = typeof opts.zMax === 'number' ? opts.zMax : HEADER_Z_MAX;
    const maxTime = typeof opts.maxTime === 'number' ? opts.maxTime : 0.95;
    const contactRadius = typeof opts.contactRadius === 'number' ? opts.contactRadius : 1.85;
    const jumpLead = typeof opts.jumpLead === 'number' ? opts.jumpLead : 0.45;
    const speed = typeof opts.playerSpeed === 'number'
        ? opts.playerSpeed
        : (typeof player.speed === 'number' ? player.speed : 5.5);

    const hit = findAirIntercept(
        ball,
        { x: player.x, y: player.y, speed },
        {
            maxTime,
            dt: 0.05,
            zMin,
            zMax,
            reachSlack: contactRadius * 0.45,
            preferT: jumpLead,
            tWeight: 1.6
        }
    );

    if (!hit || hit.score === -Infinity) return empty;

    // Window: reachable AND not absurdly far in XY at contact sample
    const inWindow = hit.canReach && hit.reachDist <= contactRadius + speed * Math.max(0, hit.t) * 0.15;
    // Also allow “ball already here” instant window
    const nowDist = Math.sqrt(
        (ball.x - player.x) * (ball.x - player.x) + (ball.y - player.y) * (ball.y - player.y)
    );
    const nowOk = isHeaderHeight(ball.z || 0, { zMin, zMax }) && nowDist <= contactRadius;

    return {
        ok: inWindow || nowOk,
        t: nowOk && (!inWindow || hit.t > 0.2) ? 0 : hit.t,
        x: nowOk && !inWindow ? ball.x : hit.x,
        y: nowOk && !inWindow ? ball.y : hit.y,
        z: nowOk && !inWindow ? (ball.z || 0) : hit.z,
        reachDist: nowOk && !inWindow ? nowDist : hit.reachDist,
        inWindow: inWindow || nowOk
    };
}

/**
 * Kick direction noise (accuracy cone).
 * Rotates unit direction (nx, ny) by a random angle scaled by accuracy.
 *
 * @param {number} nx - unit x
 * @param {number} ny - unit y
 * @param {number} [accuracy=70] - 0–100 (higher = tighter cone)
 * @param {{
 *   angleScale?: number,
 *   playmaker?: boolean,
 *   random?: function
 * }} [opts]
 * @returns {{ nx: number, ny: number, angle: number }}
 */
function applyKickDirectionNoise(nx, ny, accuracy = 70, opts = {}) {
    const acc = typeof accuracy === 'number' ? accuracy : 70;
    let angleScale = opts.angleScale != null ? opts.angleScale : 0.0075;
    if (opts.playmaker) angleScale *= 0.6;
    const rand = typeof opts.random === 'function' ? opts.random : Math.random;
    const maxAngle = (100 - acc) * angleScale;
    const angle = (rand() - 0.5) * 2 * maxAngle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    return {
        nx: nx * cosA - ny * sinA,
        ny: nx * sinA + ny * cosA,
        angle
    };
}

/**
 * Magnus curve force sample for shots (matches computeShootKick scale).
 * @param {number} [shooting=65]
 * @param {function} [random=Math.random]
 * @returns {number}
 */
function sampleKickCurveForce(shooting = 65, random = Math.random) {
    const maxCurve = (shooting / 100.0) * 1.8;
    return (random() - 0.5) * 2 * maxCurve;
}

/**
 * Build noisy ground velocity from aim direction + speed + accuracy.
 *
 * @param {number} nx
 * @param {number} ny
 * @param {speed} speed
 * @param {{
 *   accuracy?: number,
 *   angleScale?: number,
 *   playmaker?: boolean,
 *   shooting?: number,
 *   withCurve?: boolean,
 *   random?: function
 * }} [opts]
 * @returns {{ vx: number, vy: number, nx: number, ny: number, curveForce: number }}
 */
function buildNoisyKickVelocity(nx, ny, speed, opts = {}) {
    const noisy = applyKickDirectionNoise(nx, ny, opts.accuracy != null ? opts.accuracy : 70, {
        angleScale: opts.angleScale,
        playmaker: opts.playmaker,
        random: opts.random
    });
    const curveForce = opts.withCurve
        ? sampleKickCurveForce(opts.shooting != null ? opts.shooting : 65, opts.random || Math.random)
        : 0;
    return {
        vx: noisy.nx * speed,
        vy: noisy.ny * speed,
        nx: noisy.nx,
        ny: noisy.ny,
        curveForce
    };
}

module.exports = {
    GROUND_FRICTION_BASE,
    BALL_STOP_SPEED,
    FRICTION_K,
    HEADER_Z_MIN,
    HEADER_Z_MAX,
    getGravity,
    getGroundFrictionBase,
    getAirDragBase,
    getBallStopSpeed,
    longPassVzForDistance,
    longPassHangTime,
    longPassInitialSpeed,
    frictionDecayRate,
    maxTravelDistance,
    speedAfterDistance,
    initialSpeedForDistance,
    distanceCoveredInTime,
    timeToCoverDistance,
    futurePositionFromVelocity,
    futurePosition,
    sampleTrajectory,
    isHeaderHeight,
    isBallAirborne,
    findAirIntercept,
    findHeaderOpportunity,
    applyKickDirectionNoise,
    sampleKickCurveForce,
    buildNoisyKickVelocity,
    predict3D,
    timeToBounce,
    heightAtT
};
