/**
 * A.8 First touch & heavy touch.
 *
 * On loose-ball claim: control quality from dribbling + traits + incoming ball speed.
 * Clean control → solid claim (caller sets owner).
 * Heavy touch → residual velocity keeps ball free; short claim lockout (kickerClaimCooldown).
 *
 * Determinism: uses opts.random (match Math.random / seeded LCG). Never Date.now.
 */

const { Settings } = require('../../settings.js');

// Soft arrivals (friction-aware passes) often land ~1.5–3; only hot balls fumble
const FIRST_TOUCH_MIN_SPEED_DEFAULT = 5.0;
const FIRST_TOUCH_RESIDUAL_MIN_DEFAULT = 0.28;
const FIRST_TOUCH_RESIDUAL_MAX_DEFAULT = 0.55;
const FIRST_TOUCH_FUMBLE_BASE_DEFAULT = 0.03;
const FIRST_TOUCH_FUMBLE_SCALE_DEFAULT = 0.32;
const FIRST_TOUCH_FUMBLE_MAX_DEFAULT = 0.4;
const FIRST_TOUCH_CLAIM_LOCK_DEFAULT = 0.28;
const FIRST_TOUCH_NOISE_DEFAULT = 0.85;
const POOR_TOUCH_DRIBBLE_MULT = 0.52;

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function aiNum(key, fallback) {
    const v = Settings.AI && Settings.AI[key];
    return typeof v === 'number' ? v : fallback;
}

/**
 * @param {object} player
 * @param {number} ballSpeed
 * @returns {number} control quality 0..1 (higher = cleaner touch)
 */
function computeFirstTouchControl(player, ballSpeed) {
    let drib = 65;
    if (player) {
        if (typeof player.effectiveDribbling === 'number') {
            drib = player.effectiveDribbling;
        } else if (player.stats && typeof player.stats.dribbling === 'number') {
            const stam = player.staminaMultiplier != null ? player.staminaMultiplier : 1;
            drib = player.stats.dribbling * stam;
        }
    }
    if (player && player.traits && player.traits.includes('Poor Touch')) {
        drib *= POOR_TOUCH_DRIBBLE_MULT;
    }
    const skill = clamp(drib / 100, 0.08, 1);

    // Scale against 28.0 m/s (a very hard shot/cross) instead of 16
    const speedFactor = clamp(1 - (ballSpeed || 0) / 28.0, 0.18, 1);

    return clamp(skill * speedFactor, 0.05, 1);
}

/**
 * Probability of a heavy touch (ball pops free) given control and speed.
 * @param {number} control
 * @param {number} ballSpeed
 */
function computeFumbleChance(control, ballSpeed) {
    const base = aiNum('FIRST_TOUCH_FUMBLE_BASE', FIRST_TOUCH_FUMBLE_BASE_DEFAULT);
    const scale = aiNum('FIRST_TOUCH_FUMBLE_SCALE', FIRST_TOUCH_FUMBLE_SCALE_DEFAULT);
    const max = aiNum('FIRST_TOUCH_FUMBLE_MAX', FIRST_TOUCH_FUMBLE_MAX_DEFAULT);
    const minSpeed = aiNum('FIRST_TOUCH_MIN_SPEED', FIRST_TOUCH_MIN_SPEED_DEFAULT);

    if (ballSpeed < minSpeed) return 0;

    let p = base + (1 - control) * scale;

    // 14 m/s is a very firm driven pass or a soft shot (~50 km/h)
    if (ballSpeed > 14.0) p += 0.08;
    // 22 m/s is a genuine rocket shot or massive cross (~80 km/h)
    if (ballSpeed > 22.0) p += 0.06;

    return clamp(p, 0, max);
}

/**
 * Apply first-touch outcome at the moment of claim.
 * Mutates ball (and optionally player.kickerClaimCooldown) on fumble.
 *
 * @param {object} player
 * @param {object} ball
 * @param {{ random?: function, forceFumble?: boolean, forceClean?: boolean }} [opts]
 * @returns {{ fumbled: boolean, control: number, skipped?: boolean }}
 */
function applyFirstTouch(player, ball, opts = {}) {
    if (!player || !ball) {
        return { fumbled: false, control: 1, skipped: true };
    }
    // GKs trap cleanly (their claim path is separate; guard anyway)
    if (player.role === 'GK') {
        return { fumbled: false, control: 1, skipped: true };
    }

    const vx = ball.vx || 0;
    const vy = ball.vy || 0;
    const speed = Math.sqrt(vx * vx + vy * vy);
    const control = computeFirstTouchControl(player, speed);
    const rand = typeof opts.random === 'function' ? opts.random : Math.random;

    let fumble = false;
    if (opts.forceFumble) fumble = true;
    else if (opts.forceClean) fumble = false;
    else fumble = rand() < computeFumbleChance(control, speed);

    if (!fumble) {
        // Clean trap: absorb residual (caller assigns owner + Dribble)
        return { fumbled: false, control };
    }

    // Heavy touch: keep ball free with softened residual + noise
    const rMin = aiNum('FIRST_TOUCH_RESIDUAL_MIN', FIRST_TOUCH_RESIDUAL_MIN_DEFAULT);
    const rMax = aiNum('FIRST_TOUCH_RESIDUAL_MAX', FIRST_TOUCH_RESIDUAL_MAX_DEFAULT);
    const keep = rMin + (1 - control) * (rMax - rMin);
    const noise = aiNum('FIRST_TOUCH_NOISE', FIRST_TOUCH_NOISE_DEFAULT);

    ball.owner = null;
    if (speed > 1e-6) {
        ball.vx = vx * keep + (rand() - 0.5) * noise;
        ball.vy = vy * keep + (rand() - 0.5) * noise;
    } else {
        // Near-static: still pop a small loose touch away from player
        const ang = rand() * Math.PI * 2;
        const pop = 1.2 + (1 - control) * 1.5;
        ball.vx = Math.cos(ang) * pop;
        ball.vy = Math.sin(ang) * pop;
    }
    ball.vz = Math.max(ball.vz || 0, 0.25 + (1 - control) * 0.5);
    ball.curveForce = 0;

    const lock = aiNum('FIRST_TOUCH_CLAIM_LOCK', FIRST_TOUCH_CLAIM_LOCK_DEFAULT);
    if (lock > 0) {
        player.kickerClaimCooldown = Math.max(player.kickerClaimCooldown || 0, lock);
    }

    return { fumbled: true, control };
}

module.exports = {
    POOR_TOUCH_DRIBBLE_MULT,
    FIRST_TOUCH_MIN_SPEED_DEFAULT,
    FIRST_TOUCH_FUMBLE_BASE_DEFAULT,
    FIRST_TOUCH_CLAIM_LOCK_DEFAULT,
    computeFirstTouchControl,
    computeFumbleChance,
    applyFirstTouch
};
