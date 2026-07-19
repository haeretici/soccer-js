/**
 * Pure helpers for manual control:
 *  - Stage 2: hold-to-power, lob identity, directional curl
 *  - Stage 3: directional slide launch, body-shove range, take-charge eligibility
 *  - Stage 4: header outcomes (short / long / shot) from hold power
 *
 * Logic-time only (ticks × LOGIC_DT). No DOM, no Simulator, no Date.now.
 * Consumers (manual_control + Pass/Shoot/Header FSMs) apply results via
 * player.humanKick / player.humanHeader.
 */

const LOGIC_DT = 0.05;

/**
 * Normalize hold duration to power ∈ [tapFloor, 1].
 * Tap (minSec) → tapFloor; full hold (maxSec) → 1.
 *
 * @param {number} holdTicks - consecutive logic ticks action was held
 * @param {{
 *   tickDt?: number,
 *   minSec?: number,
 *   maxSec?: number,
 *   tapFloor?: number
 * }} [opts]
 * @returns {number} power 0..1 (actually tapFloor..1)
 */
function holdPower01(holdTicks, opts = {}) {
    const tickDt = typeof opts.tickDt === 'number' ? opts.tickDt : LOGIC_DT;
    const minSec = typeof opts.minSec === 'number' ? opts.minSec : 0.05;
    const maxSec = typeof opts.maxSec === 'number' ? opts.maxSec : 0.6;
    const tapFloor = typeof opts.tapFloor === 'number' ? opts.tapFloor : 0.28;
    const ticks = Math.max(0, holdTicks | 0);
    // At least one tick of contact when released after a press
    const sec = Math.max(minSec, Math.min(maxSec, Math.max(1, ticks) * tickDt));
    const span = Math.max(1e-6, maxSec - minSec);
    const t = (sec - minSec) / span;
    const floor = Math.max(0, Math.min(1, tapFloor));
    return floor + (1 - floor) * t;
}

/**
 * Lateral bias relative to facing (−1 = left of face, +1 = right of face).
 * Prefers move stick; falls back to raw A/D when move is zero.
 *
 * @param {{ x: number, y: number }} facing - unit facing
 * @param {number} moveX
 * @param {number} moveY
 * @returns {number} −1..1
 */
function lateralBiasFromMove(facing, moveX, moveY) {
    const fx = (facing && facing.x) || 0;
    const fy = (facing && facing.y) || 0;
    const flen = Math.sqrt(fx * fx + fy * fy);
    if (flen < 1e-6) {
        // No facing: raw left/right on world X
        const m = Math.max(-1, Math.min(1, moveX || 0));
        return m;
    }
    const nx = fx / flen;
    const ny = fy / flen;
    // Right-hand perpendicular in pitch plane
    const rx = -ny;
    const ry = nx;
    const mx = moveX || 0;
    const my = moveY || 0;
    const mlen = Math.sqrt(mx * mx + my * my);
    if (mlen < 1e-4) return 0;
    const bias = (mx / mlen) * rx + (my / mlen) * ry;
    return Math.max(-1, Math.min(1, bias));
}

/**
 * Magnus curve force from human lateral bias + small noise.
 * Replaces pure random sample when human is shaping a kick.
 *
 * @param {number} bias - −1..1 (left/right of facing)
 * @param {number} power - 0..1 hold power
 * @param {number} [shooting=65]
 * @param {{ noise?: number, random?: function }} [opts]
 * @returns {number}
 */
function curveForceFromBias(bias, power, shooting = 65, opts = {}) {
    const maxCurve = (Math.max(0, Math.min(100, shooting)) / 100.0) * 1.8;
    const p = Math.max(0, Math.min(1, power));
    const b = Math.max(-1, Math.min(1, bias || 0));
    // Stronger curl when fully charged; weak taps barely bend
    const magnitude = maxCurve * (0.35 + 0.65 * p) * Math.abs(b);
    const sign = b >= 0 ? 1 : -1;
    const noiseAmp = typeof opts.noise === 'number' ? opts.noise : 0.12;
    const rnd = typeof opts.random === 'function' ? opts.random : Math.random;
    const noise = (rnd() - 0.5) * 2 * noiseAmp * maxCurve * (0.4 + 0.6 * p);
    if (Math.abs(b) < 0.08) {
        // Near-zero bias: tiny residual noise only (not full random curve)
        return noise * 0.5;
    }
    return sign * magnitude + noise;
}

/**
 * Pass speed multiplier from hold power.
 * Tap ≈ soft roll; full hold ≈ firm driven ground pass.
 *
 * @param {number} power - 0..1
 * @param {boolean} isLob
 * @returns {number}
 */
function passSpeedMulFromPower(power, isLob) {
    const p = Math.max(0, Math.min(1, power));
    if (isLob) {
        // Lob: more of the hold goes into hang; ground speed still scales
        return 0.72 + 0.48 * p;
    }
    return 0.62 + 0.55 * p;
}

/**
 * Lob vertical launch multiplier from hold power.
 * Always used with vz > 0 (lob identity).
 *
 * @param {number} power
 * @returns {number}
 */
function lobVzMulFromPower(power) {
    const p = Math.max(0, Math.min(1, power));
    return 0.55 + 0.70 * p;
}

/**
 * Shot ground-speed multiplier from hold power.
 * Tap = weak poke; full = heavy drive.
 *
 * @param {number} power
 * @returns {number}
 */
function shootSpeedMulFromPower(power) {
    const p = Math.max(0, Math.min(1, power));
    return 0.48 + 0.72 * p;
}

/**
 * Peak height (m) from vertical launch speed under constant g.
 * Matches ball.js free flight: z_max = vz² / (2g) from rest ground.
 * @param {number} vz
 * @param {number} [g=9.81]
 */
function peakHeightFromVz(vz, g = 9.81) {
    if (!(vz > 0) || !(g > 0)) return 0;
    return (vz * vz) / (2 * g);
}

/**
 * Vertical launch (vz) for a desired peak height under gravity.
 * @param {number} peakH - metres
 * @param {number} [g=9.81]
 */
function vzForPeakHeight(peakH, g = 9.81) {
    const h = Math.max(0, peakH || 0);
    if (!(g > 0) || h <= 0) return 0;
    return Math.sqrt(2 * g * h);
}

/**
 * Shot heightSpeed (vz) from hold power + distance band.
 *
 * Previous curve used raw vz ≈ 0.5–3 m/s → peak height only ~0.01–0.5 m
 * (never reached 1 m). Map hold power to **peak height** then convert with
 * vz = √(2gh) so full holds clear the bar / chip GK intentionally.
 *
 * Tap  → driven / low (box poke, hard near-post)
 * Full → rising / chip (far = ~3 m peak; near = ~1.6 m lift)
 *
 * @param {number} power
 * @param {number} dist - distance to aim (m)
 * @param {{ closeRange?: number, gravity?: number }} [opts]
 * @returns {number} heightSpeed (m/s vertical)
 */
function shootHeightFromPower(power, dist, opts = {}) {
    const p = Math.max(0, Math.min(1, power));
    const close = typeof opts.closeRange === 'number' ? opts.closeRange : 18.75;
    const g = typeof opts.gravity === 'number' ? opts.gravity : 9.81;
    const d = Math.max(0, dist || 0);

    // Peak height targets (metres above pitch)
    let peakH;
    if (d < close) {
        // Near: tap ~0.2 m skid, full ~1.7 m (still scoreable under bar ~2.4 m)
        peakH = 0.18 + 1.05 * p + 0.45 * p * p;
    } else {
        // Far: tap ~0.35 m driven, half-hold ~1.3 m, full ~3.1 m chip
        peakH = 0.30 + 1.55 * p + 1.25 * p * p;
    }
    return vzForPeakHeight(peakH, g);
}

/**
 * Build humanKick payload for Pass FSM.
 *
 * @param {{
 *   power: number,
 *   isLob: boolean,
 *   curveBias?: number,
 *   shooting?: number,
 *   aimAssist?: boolean,
 *   random?: function
 * }} opts
 */
function buildHumanPassKick(opts = {}) {
    const power = Math.max(0, Math.min(1, opts.power != null ? opts.power : 0.5));
    const isLob = !!opts.isLob;
    const bias = opts.curveBias || 0;
    const shooting = opts.shooting != null ? opts.shooting : 65;
    const speedMul = passSpeedMulFromPower(power, isLob);
    const vzMul = isLob ? lobVzMulFromPower(power) : 0;
    // Ground pass: no curve (Stage 2 curl is shoot/lob). Lob can bend.
    let curveForce = 0;
    if (isLob && Math.abs(bias) > 0.05) {
        curveForce = curveForceFromBias(bias, power, shooting, {
            noise: 0.08,
            random: opts.random
        });
    }
    return {
        kind: isLob ? 'lob' : 'pass',
        power,
        isLob,
        speedMul,
        vzMul: isLob ? vzMul : 0,
        /** Force vz > 0 for lobs even on short distance */
        forceLob: isLob,
        curveForce,
        aimAssist: opts.aimAssist !== false
    };
}

/**
 * Build humanKick payload for Shoot FSM / computeShootKick.
 *
 * @param {{
 *   power: number,
 *   curveBias?: number,
 *   shooting?: number,
 *   dist?: number,
 *   aimAssist?: boolean,
 *   random?: function
 * }} opts
 */
function buildHumanShootKick(opts = {}) {
    const power = Math.max(0, Math.min(1, opts.power != null ? opts.power : 0.5));
    const bias = opts.curveBias || 0;
    const shooting = opts.shooting != null ? opts.shooting : 65;
    const dist = opts.dist != null ? opts.dist : 20;
    const speedMul = shootSpeedMulFromPower(power);
    const heightSpeed = shootHeightFromPower(power, dist);
    const curveForce = curveForceFromBias(bias, power, shooting, {
        noise: 0.10,
        random: opts.random
    });
    return {
        kind: 'shoot',
        power,
        speedMul,
        heightSpeed,
        curveForce,
        aimAssist: opts.aimAssist !== false
    };
}

/**
 * Ground speed (m/s) for a human header from hold power + outcome kind.
 * short: soft nod · long: powered clearance/cross · shot: driven header
 *
 * @param {number} power
 * @param {'short'|'long'|'shot'} kind
 * @returns {number}
 */
function headerSpeedFromPower(power, kind) {
    const p = Math.max(0, Math.min(1, power));
    if (kind === 'shot') {
        // ~8 m/s tap → ~15 m/s full power header
        return 8.0 + 7.0 * p;
    }
    if (kind === 'long') {
        // ~7 → ~13.5
        return 7.0 + 6.5 * p;
    }
    // short: ~4.5 → ~8.5
    return 4.5 + 4.0 * p;
}

/**
 * Vertical pop (m/s) after header contact.
 * Shots stay flatter; long headers hang more for crosses/clears.
 *
 * @param {number} power
 * @param {'short'|'long'|'shot'} kind
 * @returns {number}
 */
function headerVzFromPower(power, kind) {
    const p = Math.max(0, Math.min(1, power));
    if (kind === 'shot') {
        // Low-driven → slight rising
        return 0.9 + 1.4 * p;
    }
    if (kind === 'long') {
        return 2.0 + 2.2 * p;
    }
    return 1.4 + 1.2 * p;
}

/**
 * Build humanHeader payload for Header FSM contact.
 *
 * @param {{
 *   kind: 'short'|'long'|'shot',
 *   power: number,
 *   aimDir?: { x: number, y: number },
 *   curveBias?: number,
 *   shooting?: number,
 *   aimAssist?: boolean,
 *   random?: function
 * }} opts
 */
function buildHumanHeaderKick(opts = {}) {
    const kind = opts.kind === 'long' || opts.kind === 'shot' ? opts.kind : 'short';
    const power = Math.max(0, Math.min(1, opts.power != null ? opts.power : 0.5));
    const bias = opts.curveBias || 0;
    const shooting = opts.shooting != null ? opts.shooting : 65;
    let curveForce = 0;
    // Mild curl only on long / shot headers with clear lateral bias
    if ((kind === 'long' || kind === 'shot') && Math.abs(bias) > 0.12) {
        curveForce = curveForceFromBias(bias, power, shooting, {
            noise: 0.06,
            random: opts.random
        }) * 0.55;
    }
    const aim = opts.aimDir || null;
    return {
        kind,
        power,
        speed: headerSpeedFromPower(power, kind),
        vz: headerVzFromPower(power, kind),
        curveForce,
        aimDir: aim ? { x: aim.x, y: aim.y } : null,
        aimAssist: opts.aimAssist !== false
    };
}

/**
 * Resolve which charged action (if any) released this tick.
 * Priority if multiple released: shoot > lob > pass (rarest first).
 *
 * @param {{
 *   passReleased?: boolean,
 *   lobReleased?: boolean,
 *   shootReleased?: boolean
 * }} cmd
 * @param {'pass'|'lob'|'shoot'|null} charging
 * @returns {'pass'|'lob'|'shoot'|null}
 */
function resolveReleasedAction(cmd, charging) {
    if (!charging || !cmd) return null;
    if (charging === 'shoot' && cmd.shootReleased) return 'shoot';
    if (charging === 'lob' && cmd.lobReleased) return 'lob';
    if (charging === 'pass' && cmd.passReleased) return 'pass';
    // Allow release detection even if charge action mismatched (edge case)
    if (cmd.shootReleased && charging === 'shoot') return 'shoot';
    if (cmd.lobReleased && charging === 'lob') return 'lob';
    if (cmd.passReleased && charging === 'pass') return 'pass';
    return null;
}

/**
 * Pick which action to start charging on press (has-ball only).
 * Priority if multiple pressed same tick: shoot > lob > pass.
 * Does not steal an in-progress charge of a different button.
 *
 * @param {{ pass?: boolean, lob?: boolean, shoot?: boolean }} cmd
 * @param {'pass'|'lob'|'shoot'|null} current
 * @returns {'pass'|'lob'|'shoot'|null}
 */
function resolveChargeStart(cmd, current) {
    if (current) return current;
    if (!cmd) return null;
    if (cmd.shoot) return 'shoot';
    if (cmd.lob) return 'lob';
    if (cmd.pass) return 'pass';
    return null;
}

/**
 * True if the charged action button is still held this tick.
 * @param {{ passDown?: boolean, lobDown?: boolean, shootDown?: boolean }} cmd
 * @param {'pass'|'lob'|'shoot'|null} action
 */
function isChargeHeld(cmd, action) {
    if (!cmd || !action) return false;
    if (action === 'shoot') return !!cmd.shootDown;
    if (action === 'lob') return !!cmd.lobDown;
    if (action === 'pass') return !!cmd.passDown;
    return false;
}

/**
 * Unit direction for a slide launch: stick if held, else toward ball, else facing.
 *
 * @param {{ x: number, y: number }} playerPos
 * @param {{ moveX?: number, moveY?: number }|null} cmd
 * @param {{ x: number, y: number }|null} ball
 * @param {{ x: number, y: number }|null} [facing]
 * @returns {{ x: number, y: number }}
 */
function slideLaunchDir(playerPos, cmd, ball, facing) {
    if (cmd && (Math.abs(cmd.moveX) > 1e-4 || Math.abs(cmd.moveY) > 1e-4)) {
        const len = Math.sqrt(cmd.moveX * cmd.moveX + cmd.moveY * cmd.moveY);
        if (len > 1e-6) return { x: cmd.moveX / len, y: cmd.moveY / len };
    }
    if (ball && playerPos) {
        const dx = ball.x - playerPos.x;
        const dy = ball.y - playerPos.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1e-4) return { x: dx / len, y: dy / len };
    }
    if (facing) {
        const len = Math.sqrt((facing.x || 0) ** 2 + (facing.y || 0) ** 2);
        if (len > 1e-6) return { x: facing.x / len, y: facing.y / len };
    }
    return { x: 1, y: 0 };
}

/**
 * World point the slider dives toward (fixed launch, not continuous ball track).
 *
 * @param {{ x: number, y: number }} playerPos
 * @param {{ moveX?: number, moveY?: number }|null} cmd
 * @param {{ x: number, y: number }|null} ball
 * @param {{ launchDist?: number, facing?: { x: number, y: number } }} [opts]
 * @returns {{ x: number, y: number, dir: { x: number, y: number } }}
 */
function slideLaunchTarget(playerPos, cmd, ball, opts = {}) {
    const launchDist = typeof opts.launchDist === 'number' ? opts.launchDist : 3.2;
    const dir = slideLaunchDir(playerPos, cmd, ball, opts.facing || null);
    return {
        x: playerPos.x + dir.x * launchDist,
        y: playerPos.y + dir.y * launchDist,
        dir
    };
}

/**
 * Whether distance is inside body-shove contact range.
 * @param {number} dist
 * @param {number} [range=1.05]
 */
function bodyTackleInRange(dist, range = 1.05) {
    const r = typeof range === 'number' && range > 0 ? range : 1.05;
    return dist >= 0 && dist <= r + 0.15;
}

/**
 * Soft take-charge: human overlapping opponent carrier while moving.
 * Requires proximity + forward/side contact (not pure backpedal chase from far).
 *
 * @param {{ x: number, y: number, vx?: number, vy?: number }} human
 * @param {{ x: number, y: number, vx?: number, vy?: number }} opponent
 * @param {{ moveX?: number, moveY?: number, sprint?: boolean }|null} cmd
 * @param {{
 *   range?: number,
 *   minMove?: number,
 *   minApproachDot?: number
 * }} [opts]
 * @returns {{ ok: boolean, nx: number, ny: number, dist: number, sprint: boolean }}
 */
function takeChargeContact(human, opponent, cmd, opts = {}) {
    const empty = { ok: false, nx: 0, ny: 0, dist: 99, sprint: false };
    if (!human || !opponent) return empty;
    const range = typeof opts.range === 'number' ? opts.range : 1.15;
    const minMove = typeof opts.minMove === 'number' ? opts.minMove : 0.2;
    const minDot = typeof opts.minApproachDot === 'number' ? opts.minApproachDot : -0.15;

    const dx = opponent.x - human.x;
    const dy = opponent.y - human.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!(dist > 1e-4) || dist > range) return { ...empty, dist };

    const mx = (cmd && cmd.moveX) || 0;
    const my = (cmd && cmd.moveY) || 0;
    const mlen = Math.sqrt(mx * mx + my * my);
    if (mlen < minMove) return { ...empty, dist };

    const inv = 1 / dist;
    const nx = dx * inv;
    const ny = dy * inv;
    // Moving toward / alongside the carrier (not pure retreat)
    const approach = (mx / mlen) * nx + (my / mlen) * ny;
    if (approach < minDot) return { ...empty, dist };

    return {
        ok: true,
        nx,
        ny,
        dist,
        sprint: !!(cmd && cmd.sprint)
    };
}

/**
 * Recovery lock duration for a tackle type (logic seconds).
 * @param {'foot'|'slide'|'body'|string} tackleType
 * @param {{ foot?: number, slide?: number, body?: number }} [table]
 */
function tackleRecoverySec(tackleType, table = {}) {
    if (tackleType === 'slide') {
        return typeof table.slide === 'number' ? table.slide : 0.95;
    }
    if (tackleType === 'body') {
        return typeof table.body === 'number' ? table.body : 0.78;
    }
    return typeof table.foot === 'number' ? table.foot : 0.45;
}

module.exports = {
    LOGIC_DT,
    holdPower01,
    lateralBiasFromMove,
    curveForceFromBias,
    passSpeedMulFromPower,
    lobVzMulFromPower,
    shootSpeedMulFromPower,
    shootHeightFromPower,
    peakHeightFromVz,
    vzForPeakHeight,
    buildHumanPassKick,
    buildHumanShootKick,
    headerSpeedFromPower,
    headerVzFromPower,
    buildHumanHeaderKick,
    resolveReleasedAction,
    resolveChargeStart,
    isChargeHeld,
    slideLaunchDir,
    slideLaunchTarget,
    bodyTackleInRange,
    takeChargeContact,
    tackleRecoverySec
};
