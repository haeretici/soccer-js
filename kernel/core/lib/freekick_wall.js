/**
 * A.6 Free-kick walls — geometry, hold, jump-on-kick, fixed-body shot safety, ball contact.
 *
 * Wall players are tagged `isInWall` with `wallHoldX/Y` anchors. They freeze on the
 * line until a freekick Pass clears them or a Shoot kick triggers a jump arc.
 * Shot safety treats wall bodies as stationary obstacles; optional chip samples
 * clear "over" when estimated ball height exceeds stand height at the wall.
 *
 * Determinism: jump + hold use logic time (LOGIC_DT / Time.deltaTime), not wall clock.
 */

const { Settings } = require('../../settings.js');
const {
    isPassSafeFromOpponent,
    estimateShotGroundSpeed,
    getGoalMouthYBounds,
    dist2d,
    NUM_SHOOT_ATTEMPTS,
    PASS_SAFETY_BALL_RADIUS
} = require('./pass_safety.js');
const { Utils } = require('./utils.js');
const { timeToCoverDistance } = require('./ball_prediction.js');
const { GOAL_HEIGHT_REF } = require('../entities/goal.js');
const { clearIfkOnTouch } = require('./match_rules.js');

const WALL_JUMP_VZ_DEFAULT = 4.5;
const WALL_JUMP_GRAVITY_DEFAULT = 12.0;
const WALL_JUMP_TRIGGER_T_DEFAULT = 0; // jump starts on kick release
const WALL_STAND_HEIGHT_DEFAULT = 1.75;
const WALL_JUMP_BLOCK_HEIGHT_DEFAULT = 2.45;
const WALL_BODY_RADIUS_DEFAULT = 0.45;
// Chip vz for over-wall samples (g ≈ 9.81 → peak ~2.9 m at 7.5)
const CHIP_VZ_DEFAULT = 7.5;

/** Ball gravity from Settings.physics (must match ball.js). */
function ballGravity() {
    const g = Settings.physics && Settings.physics.GRAVITY;
    return typeof g === 'number' ? g : 9.81;
}

function wallJumpGravity() {
    const g = Settings.physics && Settings.physics.PLAYER_JUMP_GRAVITY;
    return typeof g === 'number' ? g : WALL_JUMP_GRAVITY_DEFAULT;
}

function wallStandHeight() {
    return (Settings.AI && Settings.AI.FREEKICK_WALL_STAND_HEIGHT) || WALL_STAND_HEIGHT_DEFAULT;
}

function wallBodyRadius() {
    return (Settings.AI && Settings.AI.FREEKICK_WALL_BODY_RADIUS) || WALL_BODY_RADIUS_DEFAULT;
}

function chipVz() {
    return (Settings.AI && Settings.AI.FREEKICK_CHIP_VZ) || CHIP_VZ_DEFAULT;
}

/**
 * Ball height at time t for a kick with initial vz (from z=0).
 * Uses Settings.physics.GRAVITY (same as ball.js).
 * @param {number} vz0
 * @param {number} t
 * @returns {number}
 */
function estimateBallHeightAtTime(vz0, t) {
    if (t <= 0) return 0;
    const g = ballGravity();
    const z = vz0 * t - 0.5 * g * t * t;
    return z > 0 ? z : 0;
}

/**
 * Build wall player positions perpendicular to the shot line.
 */
function buildWallPositions(bx, by, nx, ny, wallSize, wallDist, spacing) {
    const wx = bx + nx * wallDist;
    const wy = by + ny * wallDist;
    const px = -ny;
    const py = nx;

    const positions = [];
    const count = Math.max(1, Math.min(5, wallSize | 0));
    for (let i = 0; i < count; i++) {
        const offset = (i - (count - 1) / 2) * spacing;
        positions.push({
            x: wx + px * offset,
            y: wy + py * offset
        });
    }
    return positions;
}

/**
 * Assign nearest defenders to wall slots; tags isInWall + hold anchors.
 */
function assignWallPlayers(defenders, positions, clampX, clampY) {
    if (!positions || !positions.length) return [];
    const centre = positions.reduce(
        (acc, p) => ({ x: acc.x + p.x / positions.length, y: acc.y + p.y / positions.length }),
        { x: 0, y: 0 }
    );
    const sorted = defenders.slice().sort((a, b) => {
        const da = (a.x - centre.x) ** 2 + (a.y - centre.y) ** 2;
        const db = (b.x - centre.x) ** 2 + (b.y - centre.y) ** 2;
        return da - db;
    });

    const assigned = [];
    for (let i = 0; i < positions.length; i++) {
        const player = sorted[i];
        const pos = positions[i];
        if (!player || !pos) continue;

        const x = clampX(pos.x);
        const y = clampY(pos.y);
        player.x = x;
        player.y = y;
        player.wallHoldX = x;
        player.wallHoldY = y;
        player.isInWall = true;
        player.wallJumpTimer = 0;
        player.wallJumpActive = false;
        player.wallJumpVz = 0;
        assigned.push(player);
    }
    return assigned;
}

/**
 * Clear wall tags (hold, jump, isInWall). Does not empty the caller's array.
 */
function clearWallPlayers(wallPlayers) {
    if (!wallPlayers) return;
    for (let i = 0; i < wallPlayers.length; i++) {
        const p = wallPlayers[i];
        if (!p) continue;
        p.isInWall = false;
        p.wallJumpTimer = 0;
        p.wallJumpActive = false;
        p.wallJumpVz = 0;
        p.wallHoldX = null;
        p.wallHoldY = null;
        p.z = 0;
    }
}

/**
 * Snap wall players onto hold anchors when freekick timer ends (resume).
 * Clears walk-back so mid-walk bodies do not leave gaps when the kick starts.
 * @param {object} sim
 */
function snapWallToHold(sim) {
    if (!sim || !sim.freekickWallPlayers || !sim.freekickWallPlayers.length) return;
    for (let i = 0; i < sim.freekickWallPlayers.length; i++) {
        const p = sim.freekickWallPlayers[i];
        if (!p || !p.isInWall) continue;
        // Prefer hold anchors; fall back to unfinished walk target
        const hx = p.wallHoldX != null
            ? p.wallHoldX
            : (p.setPieceTarget ? p.setPieceTarget.x : p.x);
        const hy = p.wallHoldY != null
            ? p.wallHoldY
            : (p.setPieceTarget ? p.setPieceTarget.y : p.y);
        p.wallHoldX = hx;
        p.wallHoldY = hy;
        p.x = hx;
        p.y = hy;
        p.z = 0;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.isWalkingToSetPiece = false;
        p.setPieceTarget = null;
        p.wallJumpTimer = 0;
        p.wallJumpActive = false;
        p.wallJumpVz = 0;
        p.frame = 0;
    }
}

/**
 * Freekick Pass: dissolve wall immediately (no jump).
 * @param {object} sim
 */
function releaseWallOnPass(sim) {
    if (!sim || !sim.freekickWallPlayers) return;
    clearWallPlayers(sim.freekickWallPlayers);
    sim.freekickWallPlayers = [];
}

/**
 * Freekick Shoot at ball release: arm jump countdown (default 0 = immediate).
 * @param {object} sim
 */
function releaseWallOnShotKick(sim) {
    if (!sim || !sim.freekickWallPlayers || !sim.freekickWallPlayers.length) return;
    const delay = (Settings.AI && Settings.AI.FREEKICK_WALL_JUMP_TRIGGER_T != null)
        ? Settings.AI.FREEKICK_WALL_JUMP_TRIGGER_T
        : WALL_JUMP_TRIGGER_T_DEFAULT;
    triggerWallJump(sim.freekickWallPlayers, delay);
}

function triggerWallJump(wallPlayers, triggerDelay) {
    if (!wallPlayers || !wallPlayers.length) return;
    const settingsT = (Settings.AI && Settings.AI.FREEKICK_WALL_JUMP_TRIGGER_T != null)
        ? Settings.AI.FREEKICK_WALL_JUMP_TRIGGER_T
        : WALL_JUMP_TRIGGER_T_DEFAULT;
    const delay = typeof triggerDelay === 'number' ? triggerDelay : settingsT;
    for (let i = 0; i < wallPlayers.length; i++) {
        const p = wallPlayers[i];
        if (!p || !p.isInWall) continue;
        p.wallJumpTimer = Math.max(0, delay);
        p.wallJumpActive = false;
        p.wallJumpVz = 0;
        // delay 0: start jump this tick via updateWallJumps, or arm active now
        if (p.wallJumpTimer <= 0) {
            p.wallJumpTimer = 0;
            p.wallJumpActive = true;
            p.wallJumpVz = (Settings.AI && Settings.AI.FREEKICK_WALL_JUMP_VZ) || WALL_JUMP_VZ_DEFAULT;
        }
    }
}

/**
 * Integrate jump arcs. Returns true if any player still counting down or airborne.
 */
function updateWallJumps(wallPlayers, dt) {
    if (!wallPlayers || !wallPlayers.length) return false;
    const vz0 = (Settings.AI && Settings.AI.FREEKICK_WALL_JUMP_VZ) || WALL_JUMP_VZ_DEFAULT;
    const gravity = wallJumpGravity();
    let anyActive = false;

    for (let i = 0; i < wallPlayers.length; i++) {
        const p = wallPlayers[i];
        if (!p || !p.isInWall) continue;

        if (!p.wallJumpActive) {
            if (p.wallJumpTimer > 0) {
                p.wallJumpTimer -= dt;
                if (p.wallJumpTimer <= 0) {
                    p.wallJumpTimer = 0;
                    p.wallJumpActive = true;
                    p.wallJumpVz = vz0;
                }
                anyActive = true;
            }
        } else {
            p.wallJumpVz -= gravity * dt;
            p.z = (p.z || 0) + p.wallJumpVz * dt;
            if (p.z <= 0) {
                p.z = 0;
                p.wallJumpVz = 0;
                p.wallJumpActive = false;
                p.isInWall = false;
                p.wallHoldX = null;
                p.wallHoldY = null;
            } else {
                anyActive = true;
            }
        }
    }
    return anyActive;
}

/**
 * Drop empty/finished wall list from sim after jumps land.
 * @param {object} sim
 */
function pruneFreekickWall(sim) {
    if (!sim || !sim.freekickWallPlayers || !sim.freekickWallPlayers.length) return;
    const still = sim.freekickWallPlayers.some((p) => p && p.isInWall);
    if (!still) {
        sim.freekickWallPlayers = [];
    }
}

/**
 * Fixed-body lane check vs one wall player (no sprint reach).
 * Returns true if lane is safe past this wall body on the ground plane.
 */
function isLaneSafePastWallBody(from, target, wallPlayer, passSpeed) {
    return isPassSafeFromOpponent(from, target, null, wallPlayer, passSpeed, {
        maxSpeed: 0,
        playerRadius: wallBodyRadius(),
        ballRadius: PASS_SAFETY_BALL_RADIUS
    });
}

/**
 * Wall-aware CanShoot: fixed wall bodies + optional chip-over when height clears stand line.
 * @returns {{ ok: boolean, target: object|null, power: number, heightSpeed: number|null }}
 */
function canShootPastWall(ballPos, shooter, wallPlayers, otherOpponents, opts = {}) {
    if (!ballPos) return { ok: false, target: null, power: 0, heightSpeed: null };

    const field = opts.field || Utils.getFieldBounds();
    const goal = opts.goal || null;
    let oppGoalX = opts.oppGoalX;
    if (oppGoalX == null && goal && goal.lineX != null) oppGoalX = goal.lineX;
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

    const { yMin, yMax } = getGoalMouthYBounds(field, goal);
    const power = opts.power != null ? opts.power : estimateShotGroundSpeed(shooter);
    const rand = typeof opts.random === 'function' ? opts.random : Math.random;
    const attempts = opts.numAttempts != null ? opts.numAttempts : NUM_SHOOT_ATTEMPTS;
    const standH = wallStandHeight();
    const chip = chipVz();

    const wallList = [];
    if (wallPlayers) {
        for (let i = 0; i < wallPlayers.length; i++) {
            if (wallPlayers[i] && !wallPlayers[i].isSentOff) wallList.push(wallPlayers[i]);
        }
    }
    const otherList = [];
    if (otherOpponents) {
        for (let i = 0; i < otherOpponents.length; i++) {
            if (otherOpponents[i] && !otherOpponents[i].isSentOff && !otherOpponents[i].isInWall) {
                otherList.push(otherOpponents[i]);
            }
        }
    }

    const sampleYs = [];
    if (opts.sampleYs && opts.sampleYs.length) {
        for (let i = 0; i < opts.sampleYs.length; i++) sampleYs.push(opts.sampleYs[i]);
    } else if (goal && typeof goal.sampleMouthTargets === 'function') {
        const targets = goal.sampleMouthTargets(attempts, rand, 0.25);
        for (let i = 0; i < targets.length; i++) sampleYs.push(targets[i].y);
    } else {
        // Prefer corners first so "around the wall" is found before dense centre samples
        sampleYs.push(yMin);
        sampleYs.push(yMax);
        sampleYs.push(yMin + (yMax - yMin) * 0.12);
        sampleYs.push(yMin + (yMax - yMin) * 0.88);
        sampleYs.push((yMin + yMax) * 0.5);
        sampleYs.push(yMin + (yMax - yMin) * 0.25);
        sampleYs.push(yMin + (yMax - yMin) * 0.75);
        for (let i = 0; i < attempts; i++) sampleYs.push(yMin + rand() * (yMax - yMin));
    }

    let chipCandidate = null;

    for (let i = 0; i < sampleYs.length; i++) {
        let y = sampleYs[i];
        if (y < yMin) y = yMin;
        if (y > yMax) y = yMax;
        const target = { x: oppGoalX, y };

        const dist = dist2d(ballPos.x, ballPos.y, target.x, target.y);
        const time = timeToCoverDistance(dist, power, {});
        if (time < 0) continue;

        // Non-wall defenders: normal sprint intercept
        let blockedByField = false;
        for (let j = 0; j < otherList.length; j++) {
            if (!isPassSafeFromOpponent(ballPos, target, null, otherList[j], power)) {
                blockedByField = true;
                break;
            }
        }
        if (blockedByField) continue;

        // Wall: fixed bodies on ground plane
        let wallBlocksGround = false;
        let maxWallLocalX = 0;
        for (let j = 0; j < wallList.length; j++) {
            const wp = wallList[j];
            if (!isLaneSafePastWallBody(ballPos, target, wp, power)) {
                wallBlocksGround = true;
                const dx = wp.x - ballPos.x;
                const dy = wp.y - ballPos.y;
                const toTx = target.x - ballPos.x;
                const toTy = target.y - ballPos.y;
                const d = Math.sqrt(toTx * toTx + toTy * toTy) || 1;
                const localX = (dx * toTx + dy * toTy) / d;
                if (localX > maxWallLocalX) maxWallLocalX = localX;
            }
        }

        if (!wallBlocksGround) {
            return { ok: true, target, power, heightSpeed: null };
        }

        // Chip-over: ball height at wall crossing clears jump height
        if (maxWallLocalX > 0) {
            const tWall = timeToCoverDistance(maxWallLocalX, power, {});
            if (tWall >= 0) {
                const jumpH = (Settings.AI && Settings.AI.FREEKICK_WALL_JUMP_HEIGHT) || WALL_JUMP_BLOCK_HEIGHT_DEFAULT;
                const minClearHeight = jumpH + 0.1;
                const g = ballGravity();
                const vzRequired = (minClearHeight + 0.5 * g * tWall * tWall) / tWall;

                // Max vz limit to prevent absurd sky kicks
                if (vzRequired <= 13.0) {
                    const tGoal = timeToCoverDistance(dist, power, {});
                    if (tGoal >= 0) {
                        const zAtGoal = vzRequired * tGoal - 0.5 * g * tGoal * tGoal;
                        const goalHeight = goal && goal.height != null ? goal.height : Utils.scaleFieldY(GOAL_HEIGHT_REF);
                        if (zAtGoal < goalHeight - 0.15) {
                            if (!chipCandidate) {
                                chipCandidate = { ok: true, target, power, heightSpeed: vzRequired };
                            }
                        }
                    }
                }
            }
        }
    }

    if (chipCandidate) return chipCandidate;
    return { ok: false, target: null, power, heightSpeed: null };
}

/**
 * Soft collision: free ball hits a wall body below block height → deflect.
 * @returns {boolean} true if a collision was applied
 */
function tryBallWallCollisions(ball, wallPlayers) {
    if (!ball || ball.owner || !wallPlayers || !wallPlayers.length) return false;
    const ballR = ball.radius != null ? ball.radius : 0.25;
    const bodyR = wallBodyRadius();
    const standH = wallStandHeight();
    const jumpH = (Settings.AI && Settings.AI.FREEKICK_WALL_JUMP_HEIGHT) || WALL_JUMP_BLOCK_HEIGHT_DEFAULT;
    let hit = false;

    for (let i = 0; i < wallPlayers.length; i++) {
        const p = wallPlayers[i];
        if (!p || !p.isInWall || p.isSentOff) continue;
        const dx = ball.x - p.x;
        const dy = ball.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minD = bodyR + ballR;
        if (d >= minD || d < 1e-8) continue;

        const blockH = p.wallJumpActive ? jumpH : standH;
        if ((ball.z || 0) >= blockH) continue; // over the wall

        const nx = dx / d;
        const ny = dy / d;
        const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
        ball.x = p.x + nx * minD;
        ball.y = p.y + ny * minD;
        // Reflect with energy loss
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
            ball.vx -= 1.6 * vn * nx;
            ball.vy -= 1.6 * vn * ny;
        } else {
            ball.vx = nx * Math.max(speed, 1.5) * 0.55;
            ball.vy = ny * Math.max(speed, 1.5) * 0.55;
        }
        ball.vx *= 0.7;
        ball.vy *= 0.7;
        ball.vz = Math.max(ball.vz || 0, 0.8);
        // Wall body counts as a second touch for IFK
        clearIfkOnTouch(ball, p);
        hit = true;
    }
    return hit;
}

/**
 * Hold wall player on anchor (call from Player.update when isInWall).
 * @param {object} player
 * @param {{ forceGround?: boolean }} [opts] forceGround: zero z/vz when not airborne (set-piece freeze)
 * @returns {boolean} true if caller should skip FSM / movement
 */
function applyWallHold(player, opts = {}) {
    if (!player || !player.isInWall) return false;
    if (player.isWalkingToSetPiece && player.setPieceTarget) return false;
    if (player.wallHoldX != null) {
        player.x = player.wallHoldX;
        player.y = player.wallHoldY;
    }
    player.vx = 0;
    player.vy = 0;
    // z integrated by updateWallJumps while jumping
    if (opts.forceGround && !player.wallJumpActive) {
        player.vz = 0;
        player.z = 0;
    }
    // Reuse header-jump pose (frame 10) for airborne wall jump; stand otherwise
    if (player.wallJumpActive) {
        player.frame = 10;
    } else if (!(player.wallJumpTimer > 0)) {
        player.frame = 0;
    }
    return true;
}

module.exports = {
    WALL_JUMP_VZ_DEFAULT,
    WALL_JUMP_GRAVITY_DEFAULT,
    WALL_JUMP_TRIGGER_T_DEFAULT,
    WALL_STAND_HEIGHT_DEFAULT,
    WALL_BODY_RADIUS_DEFAULT,
    ballGravity,
    wallJumpGravity,
    buildWallPositions,
    assignWallPlayers,
    clearWallPlayers,
    snapWallToHold,
    triggerWallJump,
    updateWallJumps,
    pruneFreekickWall,
    releaseWallOnPass,
    releaseWallOnShotKick,
    canShootPastWall,
    tryBallWallCollisions,
    applyWallHold,
    estimateBallHeightAtTime,
    isLaneSafePastWallBody
};
