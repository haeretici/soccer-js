/**
 * Manual control (Stage 1–4): resolve controlled player, map keyboard onto
 * existing Pass/Shoot/tackle/Header primitives without rewriting AI teammates.
 *
 * Design:
 *  - Only outfield players; GK stays AI.
 *  - Team A uses gameKeyboard; Team B flag reserved (second device later).
 *  - Human movement applied in outfield states via player._humanInput.
 *  - Kick/tackle applied each Play logic tick (before AI assign).
 *  - Stage 1.5: facing pass assist, auto-switch on pass, input log stub.
 *  - Stage 2: hold-to-power (release-to-fire), lob vz identity, directional
 *    curl, aim-assist on/off. Power uses logic ticks (never Date.now).
 *  - Stage 3: body shove, directional slide, soft take-charge, recovery lock.
 *  - Stage 4: timed headers (short/long/shot) when ball in air window;
 *    shared 3D intercept helpers for AI + human.
 */

const { Settings } = require('../../settings.js');
const { Time } = require('./time.js');
const { Utils } = require('./utils.js');
const { SoundDB } = require('./sounddb.js');
const { gameKeyboard } = require('./input_keyboard.js');
const {
    holdPower01,
    lateralBiasFromMove,
    buildHumanPassKick,
    buildHumanShootKick,
    buildHumanHeaderKick,
    resolveReleasedAction,
    resolveChargeStart,
    isChargeHeld,
    slideLaunchTarget,
    bodyTackleInRange,
    takeChargeContact
} = require('./manual_commands.js');
const {
    findHeaderOpportunity,
    isBallAirborne
} = require('./ball_prediction.js');

/** Facing unit vector from 8-way orientation (0=UP … 7=UP_LEFT). */
const ORIENT_DIR = [
    { x: 0, y: -1 },
    { x: 0.7071, y: -0.7071 },
    { x: 1, y: 0 },
    { x: 0.7071, y: 0.7071 },
    { x: 0, y: 1 },
    { x: -0.7071, y: 0.7071 },
    { x: -1, y: 0 },
    { x: -0.7071, y: -0.7071 }
];

function isHeadless() {
    return !!(Settings.HEADLESS);
}

/**
 * @param {'A'|'B'} teamKey
 * @returns {boolean}
 */
function isManualTeamEnabled(teamKey) {
    if (isHeadless()) return false;
    const mc = Settings.manualControl;
    if (!mc) return false;
    if (teamKey === 'A') return !!mc.teamA;
    if (teamKey === 'B') return !!mc.teamB;
    return false;
}

function anyManualEnabled() {
    return isManualTeamEnabled('A') || isManualTeamEnabled('B');
}

/**
 * @param {object} player
 * @returns {{ x: number, y: number }}
 */
function orientationDir(player) {
    const o = player && typeof player.orientation === 'number' ? player.orientation : 2;
    return ORIENT_DIR[((o % 8) + 8) % 8] || ORIENT_DIR[2];
}

/**
 * Facing / aim direction: stick if held, else last charge aim, else sprite orientation.
 * @param {object} player
 * @param {{ moveX?: number, moveY?: number }|null} [cmd]
 * @param {{ aimX?: number, aimY?: number }|null} [charge]
 * @returns {{ x: number, y: number }}
 */
function humanFacingDir(player, cmd, charge) {
    if (cmd && (Math.abs(cmd.moveX) > 1e-4 || Math.abs(cmd.moveY) > 1e-4)) {
        const len = Math.sqrt(cmd.moveX * cmd.moveX + cmd.moveY * cmd.moveY);
        if (len > 1e-6) return { x: cmd.moveX / len, y: cmd.moveY / len };
    }
    if (charge && typeof charge.aimX === 'number' && typeof charge.aimY === 'number') {
        const len = Math.sqrt(charge.aimX * charge.aimX + charge.aimY * charge.aimY);
        if (len > 1e-6) return { x: charge.aimX / len, y: charge.aimY / len };
    }
    const inp = player && player._humanInput;
    if (inp && (Math.abs(inp.moveX) > 1e-4 || Math.abs(inp.moveY) > 1e-4)) {
        const len = Math.sqrt(inp.moveX * inp.moveX + inp.moveY * inp.moveY);
        if (len > 1e-6) return { x: inp.moveX / len, y: inp.moveY / len };
    }
    if (player && player.humanKick && player.humanKick.aimDir) {
        const a = player.humanKick.aimDir;
        const len = Math.sqrt((a.x || 0) * (a.x || 0) + (a.y || 0) * (a.y || 0));
        if (len > 1e-6) return { x: a.x / len, y: a.y / len };
    }
    return orientationDir(player);
}

/**
 * Seed / refresh charge aim from stick (sticky when stick released mid-hold).
 * @param {object} charge
 * @param {object} player
 * @param {{ moveX?: number, moveY?: number }|null} cmd
 */
function updateChargeAim(charge, player, cmd) {
    if (!charge) return;
    if (cmd && (Math.abs(cmd.moveX) > 1e-4 || Math.abs(cmd.moveY) > 1e-4)) {
        const len = Math.sqrt(cmd.moveX * cmd.moveX + cmd.moveY * cmd.moveY);
        if (len > 1e-6) {
            charge.aimX = cmd.moveX / len;
            charge.aimY = cmd.moveY / len;
            return;
        }
    }
    if (typeof charge.aimX !== 'number' || typeof charge.aimY !== 'number') {
        const d = humanFacingDir(player, cmd, null);
        charge.aimX = d.x;
        charge.aimY = d.y;
    }
}

function manualOpts() {
    return (Settings && Settings.manualControl) || {};
}

/**
 * Cosine of half-angle for pass-assist cone.
 * @param {number} [deg]
 */
function passAssistCosThreshold(deg) {
    const d = typeof deg === 'number' ? deg : 58;
    return Math.cos((Math.max(15, Math.min(89, d)) * Math.PI) / 180);
}

/**
 * Soft pass assist: only lock to a teammate **inside the facing/aim cone**.
 * Outside the cone returns null so the kick goes free along stick direction
 * (ISS-style directional pass / lob). Never snaps to a mate behind the player.
 *
 * @param {object} player
 * @param {'short'|'long'|null} passType
 * @param {{ moveX?: number, moveY?: number }|null} [cmd]
 * @param {{ aimX?: number, aimY?: number }|null} [charge]
 * @returns {{ teammate: object, type: string, aim: object|null }|null}
 */
function findHumanPassTarget(player, passType, cmd, charge) {
    if (!player) return null;
    const mc = manualOpts();
    const assistOn = mc.passAssistFacing !== false && mc.aimAssist !== false;
    if (!assistOn) return null;

    const team = typeof player.getTeam === 'function' ? player.getTeam() : null;
    const mates = team && typeof team.getOutfieldPlayers === 'function'
        ? team.getOutfieldPlayers().filter((p) => p && p !== player && !p.isSentOff)
        : (player.level && player.level.players
            ? player.level.players.filter(
                (p) => p && p !== player && p.team === player.team && p.role !== 'GK' && !p.isSentOff
            )
            : []);
    if (!mates.length) return null;

    const facing = humanFacingDir(player, cmd, charge);
    const cosMin = passAssistCosThreshold(mc.passAssistConeDeg);

    const shortMin = (Settings.AI && Settings.AI.SHORT_PASS_MIN_DIST) || 3.0;
    const longMax = (Settings.AI && Settings.AI.LONG_PASS_MAX_DIST) || 60.0;

    let best = null;
    let bestScore = -Infinity;
    let bestDot = -1;

    for (let i = 0; i < mates.length; i++) {
        const mate = mates[i];
        const dx = mate.x - player.x;
        const dy = mate.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < shortMin * 0.85 || dist > longMax) continue;

        const inv = dist > 1e-6 ? 1 / dist : 0;
        const dot = dx * inv * facing.x + dy * inv * facing.y;
        // Hard cone gate — outside → not a candidate (free directional kick)
        if (dot < cosMin) continue;

        // Prefer more central to aim, slight preference for medium range
        const facingScore = 0.55 + 0.45 * ((dot - cosMin) / Math.max(1e-6, 1 - cosMin));
        let typeBias = 0.1;
        if (passType === 'long' && dist >= shortMin * 2.5) typeBias = 0.25;
        if (passType === 'short' && dist <= longMax * 0.45) typeBias = 0.25;
        // Mild closeness preference so nearest open option wins ties
        const distScore = 1.0 / (1.0 + dist * 0.04);

        const score = facingScore * 0.75 + distScore * 0.15 + typeBias;
        if (score > bestScore) {
            bestScore = score;
            best = mate;
            bestDot = dot;
        }
    }

    if (!best) return null;

    // Aim at feet (lead aim is AI-heavy; stick already chose the lane)
    let aim = { x: best.x, y: best.y };
    let type = passType || 'short';

    if (!passType) {
        const d = dist2(player.x, player.y, best.x, best.y);
        type = d > ((Settings.AI && Settings.AI.LONG_PASS_MIN_DIST) || 18) ? 'long' : 'short';
    } else {
        type = passType;
    }

    return { teammate: best, type, aim, facingDot: bestDot };
}

/**
 * Soft midpoint camera toward controlled player + ball (centered mode only).
 * @param {object} sim
 * @param {object|null} controlled
 */
function updateManualCameraFollow(sim, controlled) {
    const mc = manualOpts();
    if (mc.cameraFollow === false) return;
    if (!sim || !sim.ball || Settings.HEADLESS) return;
    if (!Settings.app || !Settings.app.canvas) return;
    if (Settings.camera && Settings.camera.type === 'static') return;
    if (!anyManualEnabled()) return;

    const ball = sim.ball;
    let wx = ball.x;
    let wy = ball.y;
    if (controlled) {
        const blend = typeof mc.cameraFollowPlayerBlend === 'number'
            ? Math.max(0, Math.min(1, mc.cameraFollowPlayerBlend))
            : 0.45;
        wx = ball.x * (1 - blend) + controlled.x * blend;
        wy = ball.y * (1 - blend) + controlled.y * blend;
    }

    const targetScreen = Utils.toScreen(wx, wy, ball.z || 0);
    const wantX = Settings.app.canvas.width / 2 - targetScreen.x;
    const wantY = Settings.app.canvas.height / 2 - targetScreen.y;
    const lerp = typeof mc.cameraFollowLerp === 'number'
        ? Math.max(0.05, Math.min(1, mc.cameraFollowLerp))
        : 0.18;

    if (typeof Settings.app.camX !== 'number') Settings.app.camX = wantX;
    if (typeof Settings.app.camY !== 'number') Settings.app.camY = wantY;
    Settings.app.camX += (wantX - Settings.app.camX) * lerp;
    Settings.app.camY += (wantY - Settings.app.camY) * lerp;
    sim._manualCameraActive = true;
}

/**
 * Optional input recording stub for future replay.
 * @param {object} sim
 * @param {object} cmd
 */
function recordManualInput(sim, cmd) {
    const mc = manualOpts();
    if (!mc.recordInput || !sim) return;
    if (!sim._manualInputLog) sim._manualInputLog = [];
    const max = typeof mc.recordInputMax === 'number' ? mc.recordInputMax : 2400;
    const charge = sim._manualCharge;
    sim._manualInputLog.push({
        f: sim.currentFrameCount | 0,
        mx: cmd.moveX || 0,
        my: cmd.moveY || 0,
        p: !!cmd.pass,
        l: !!cmd.lob,
        s: !!cmd.shoot,
        pr: !!cmd.passReleased,
        lr: !!cmd.lobReleased,
        sr: !!cmd.shootReleased,
        sw: !!cmd.switchPlayer,
        sp: !!cmd.sprint,
        ch: charge ? charge.action : null,
        ct: charge ? (charge.ticks | 0) : 0
    });
    while (sim._manualInputLog.length > max) {
        sim._manualInputLog.shift();
    }
}

/**
 * Eligible outfield candidates for control on a team.
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 * @returns {object[]}
 */
function getControllablePlayers(sim, teamKey) {
    if (!sim || !sim.players) return [];
    return sim.players.filter(
        (p) => p
            && p.team === teamKey
            && p.role !== 'GK'
            && !p.isSentOff
    );
}

/**
 * Pick human avatar: ball owner on team → sticky previous → closest to ball.
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 * @param {object|null} prev
 * @returns {object|null}
 */
function resolveControlledPlayer(sim, teamKey, prev) {
    const pool = getControllablePlayers(sim, teamKey);
    if (!pool.length) return null;

    const ball = sim.ball;
    if (ball && ball.owner && ball.owner.team === teamKey && pool.includes(ball.owner)) {
        return ball.owner;
    }

    if (prev && pool.includes(prev) && !prev.isSentOff && prev.role !== 'GK') {
        // Keep sticky control while off-ball unless far from play and someone much closer
        if (ball) {
            const prevD = dist2(prev.x, prev.y, ball.x, ball.y);
            let closest = prev;
            let bestD = prevD;
            for (let i = 0; i < pool.length; i++) {
                const p = pool[i];
                const d = dist2(p.x, p.y, ball.x, ball.y);
                if (d < bestD) {
                    bestD = d;
                    closest = p;
                }
            }
            // Switch sticky only if challenger is clearly closer (mirror AI marker feel)
            if (closest !== prev && bestD < prevD - 2.5) {
                return closest;
            }
        }
        return prev;
    }

    if (!ball) return pool[0];

    let best = pool[0];
    let bestD = Infinity;
    for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const d = dist2(p.x, p.y, ball.x, ball.y);
        if (d < bestD) {
            bestD = d;
            best = p;
        }
    }
    return best;
}

/**
 * Cycle to next-nearest teammate to the ball (or next in list).
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 * @param {object|null} current
 * @returns {object|null}
 */
function switchControlledPlayer(sim, teamKey, current) {
    const pool = getControllablePlayers(sim, teamKey);
    if (!pool.length) return null;
    const ball = sim.ball || { x: 0, y: 0 };

    const ranked = pool.slice().sort((a, b) => {
        const da = dist2(a.x, a.y, ball.x, ball.y);
        const db = dist2(b.x, b.y, ball.x, ball.y);
        return da - db;
    });

    if (!current || !ranked.includes(current)) {
        return ranked[0];
    }
    const idx = ranked.indexOf(current);
    return ranked[(idx + 1) % ranked.length];
}

function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
}

function getPlayerStates() {
    // Lazy require avoids circular init with player.js
    return require('../entities/player.js').PlayerStates;
}

function getPlayerHelpers() {
    return require('../entities/player.js');
}

function stateName(player) {
    if (!player || !player.fsm || typeof player.fsm.getNameOfCurrentState !== 'function') {
        return '';
    }
    return player.fsm.getNameOfCurrentState() || '';
}

function isBusyKicking(player) {
    const n = stateName(player);
    return n === 'Pass' || n === 'Shoot' || n === 'Header';
}

/**
 * Kickoff dead-ball / opening pass in progress.
 * Opening kick is always AI (`forceKickoffPass`); no human input until it clears.
 * @param {object|null} simOrPlayer - Simulator, or a player with `.level`
 * @returns {boolean}
 */
function isKickoffControlBlocked(simOrPlayer) {
    if (!simOrPlayer) return false;
    const level = simOrPlayer.ball != null || simOrPlayer.matchState != null
        ? simOrPlayer
        : simOrPlayer.level;
    if (!level) return false;
    if (level.matchState === 'kickoff') return true;
    if (level.setPieceType === 'kickoff') return true;
    return false;
}

/**
 * @deprecated use isKickoffControlBlocked — kept for tests / call sites
 * @param {object} player
 */
function isKickoffCarrierLocked(player) {
    if (!player || !player.humanControlled) return false;
    return isKickoffControlBlocked(player);
}

function clearHumanFlags(sim) {
    if (!sim || !sim.players) return;
    for (let i = 0; i < sim.players.length; i++) {
        const p = sim.players[i];
        if (p) {
            p.humanControlled = false;
            p._humanInput = null;
        }
    }
}

/**
 * Ground range (m) for a free directional pass/lob from hold power.
 * @param {number} power
 * @param {boolean} isLob
 */
function freeKickRange(power, isLob) {
    const p = Math.max(0, Math.min(1, power != null ? power : 0.5));
    if (isLob) {
        // ~10 m tap cross → ~38 m full lofted switch
        return 10 + 28 * p;
    }
    // ~5 m tap poke → ~22 m driven ground pass
    return 5 + 17 * p;
}

/**
 * Free directional kick along stick/aim (no teammate lock).
 * Used when assist finds no mate in cone, or assist is off.
 *
 * @param {object} player
 * @param {boolean} isLob
 * @param {object|null} [humanKick]
 * @param {{ moveX?: number, moveY?: number }|null} [cmd]
 * @param {{ aimX?: number, aimY?: number }|null} [charge]
 */
function fallbackKickAlongFacing(player, isLob, humanKick, cmd, charge) {
    const ball = player.level && player.level.ball;
    if (!ball || ball.owner !== player) return;

    const hk = humanKick || player.humanKick || null;
    const dir = (hk && hk.aimDir)
        ? humanFacingDir(player, { moveX: hk.aimDir.x, moveY: hk.aimDir.y }, charge)
        : humanFacingDir(player, cmd, charge);

    // Re-orient sprite to kick direction so visuals match the ball
    // ORIENT_DIR: 0=UP(-Y), 2=RIGHT(+X), 4=DOWN(+Y), 6=LEFT(-X)
    if (typeof player.orientation === 'number') {
        const deg = (Math.atan2(dir.x, -dir.y) * 180) / Math.PI; // 0 = up
        player.orientation = ((Math.round(deg / 45) % 8) + 8) % 8;
    }

    const power = hk && typeof hk.power === 'number' ? hk.power : 0.55;
    const range = freeKickRange(power, isLob);
    const aim = { x: player.x + dir.x * range, y: player.y + dir.y * range };

    // Prefer shared pass physics without requiring player.js (avoids circular load)
    let speed = isLob ? 14.0 : 12.0;
    try {
        const { estimatePassGroundSpeed } = require('./pass_safety.js');
        if (typeof estimatePassGroundSpeed === 'function') {
            const v = estimatePassGroundSpeed(
                { x: player.x, y: player.y },
                aim,
                player,
                isLob ? 'long' : 'short'
            );
            if (v > 0) speed = v;
        }
    } catch (_e) { /* keep base */ }
    if (hk && typeof hk.speedMul === 'number') {
        speed *= hk.speedMul;
    }

    let vz = 0;
    if (isLob) {
        try {
            const { longPassVzForDistance } = require('./ball_prediction.js');
            if (typeof longPassVzForDistance === 'function') {
                vz = longPassVzForDistance(range);
            } else {
                vz = 3.5 + 3.0 * power;
            }
        } catch (_e) {
            vz = 3.5 + 3.0 * power;
        }
        if (hk && typeof hk.vzMul === 'number') {
            vz *= hk.vzMul;
        }
        if (vz < 1.5) vz = 1.5; // lob identity: always airborne
    }
    const curve = hk && typeof hk.curveForce === 'number' ? hk.curveForce : 0;
    ball.kick(dir.x * speed, dir.y * speed, vz, curve);
    SoundDB.play(isLob ? 'lob' : 'pass');
    player.humanKick = null;
    // Free-kick path skips Pass FSM — still clear kickoff dead-ball bookkeeping
    if (player.level && player.level.setPieceType === 'kickoff') {
        player.level.setPieceType = '';
    }

    const PlayerStates = getPlayerStates();
    // Brief recovery pose then idle
    player.actionTimer = 0.2;
    player.frame = 3;
    if (player.fsm && PlayerStates.Idle) {
        player.fsm.changeState(PlayerStates.Idle);
    }
}

/**
 * Aim assist flags from Settings.manualControl.
 * @returns {{ pass: boolean, shoot: boolean }}
 */
function aimAssistFlags() {
    const mc = manualOpts();
    // aimAssist master (Stage 2); fall back to passAssistFacing for pass
    const master = mc.aimAssist !== false;
    return {
        pass: master && mc.passAssistFacing !== false,
        shoot: master && mc.shotAimAssist !== false
    };
}

/**
 * Hold-power options from settings.
 */
function holdPowerOpts() {
    const mc = manualOpts();
    return {
        minSec: typeof mc.holdPowerMinSec === 'number' ? mc.holdPowerMinSec : 0.05,
        maxSec: typeof mc.holdPowerMaxSec === 'number' ? mc.holdPowerMaxSec : 0.6,
        tapFloor: typeof mc.holdPowerTapFloor === 'number' ? mc.holdPowerTapFloor : 0.28
    };
}

/**
 * Whether Stage 2 release-to-fire is active.
 */
function holdToPowerEnabled() {
    const mc = manualOpts();
    return mc.holdToPower !== false;
}

/**
 * @param {object} player
 * @param {'short'|'long'} passType
 * @param {{ moveX?: number, moveY?: number }|null} [cmd]
 * @param {object|null} [humanKick] - Stage 2 power/curl payload
 * @param {{ aimX?: number, aimY?: number }|null} [charge]
 * @returns {object|null} receiver when a pass was started (for auto-switch)
 */
function startHumanPass(player, passType, cmd, humanKick, charge) {
    const PlayerStates = getPlayerStates();
    if (!player || !player.fsm) return null;

    // Always stamp aim direction onto the kick payload (stick / charge sticky)
    const aimDir = humanFacingDir(player, cmd, charge);
    if (humanKick) {
        humanKick.aimDir = { x: aimDir.x, y: aimDir.y };
        player.humanKick = humanKick;
    } else {
        player.humanKick = { kind: passType === 'long' ? 'lob' : 'pass', aimDir: { x: aimDir.x, y: aimDir.y } };
    }

    const assist = aimAssistFlags().pass
        && !(humanKick && humanKick.aimAssist === false);

    // Soft-lock only if a teammate sits inside the aim cone
    const decision = assist ? findHumanPassTarget(player, passType, cmd, charge) : null;

    if (decision && decision.teammate) {
        player.passTarget = decision.teammate;
        player.passType = passType || decision.type || 'short';
        if (passType === 'long') player.passType = 'long';
        if (passType === 'short') player.passType = 'short';
        player.passAim = decision.aim || null;
        player.fsm.changeState(PlayerStates.Pass);
        return decision.teammate;
    }

    // Free directional pass/lob along stick (power scales range)
    fallbackKickAlongFacing(
        player,
        passType === 'long',
        humanKick || player.humanKick,
        cmd,
        charge
    );
    return null;
}

/**
 * Shot aim along stick/facing toward the goal line (directional, not AI mouth pick).
 * @param {object} player
 * @param {{ moveX?: number, moveY?: number }|null} [cmd]
 * @param {{ aimX?: number, aimY?: number }|null} [charge]
 */
function facingShotAim(player, cmd, charge) {
    const helpers = getPlayerHelpers();
    const field = Utils.getFieldBounds();
    const attacksRight = helpers.attacksRightGoal(player.level, player.team);
    const goalX = attacksRight ? field.width : 0;
    const dir = humanFacingDir(player, cmd, charge);
    // Project aim ray onto goal plane
    let aimY = player.y;
    const dx = goalX - player.x;
    if (Math.abs(dir.x) > 0.08) {
        const t = dx / dir.x;
        if (t > 0) {
            aimY = player.y + dir.y * t;
        } else {
            // Facing away from goal: still aim along stick into a virtual target
            aimY = player.y + dir.y * Math.abs(dx);
        }
    } else {
        aimY = player.y + dir.y * Math.abs(dx);
    }
    // Soft clamp near goal mouth (allow near-post / far-post, not full touchline)
    const halfMouth = typeof Utils.scaleFieldY === 'function'
        ? Utils.scaleFieldY(5.5)
        : 5.5;
    const cy = field.centerY;
    aimY = Math.max(cy - halfMouth * 1.35, Math.min(cy + halfMouth * 1.35, aimY));
    return { x: goalX, y: aimY };
}

/**
 * @param {object} player
 * @param {{ moveX?: number, moveY?: number }|null} [cmd]
 * @param {object|null} [humanKick]
 * @param {{ aimX?: number, aimY?: number }|null} [charge]
 */
function startHumanShoot(player, cmd, humanKick, charge) {
    const PlayerStates = getPlayerStates();
    const helpers = getPlayerHelpers();
    if (!player || !player.fsm) return;

    const aimDir = humanFacingDir(player, cmd, charge);
    if (humanKick) {
        humanKick.aimDir = { x: aimDir.x, y: aimDir.y };
        player.humanKick = humanKick;
        if (typeof humanKick.heightSpeed === 'number') {
            player.shotHeightBoost = humanKick.heightSpeed;
        }
    } else {
        player.humanKick = { kind: 'shoot', aimDir: { x: aimDir.x, y: aimDir.y } };
    }

    const assist = aimAssistFlags().shoot
        && !(humanKick && humanKick.aimAssist === false);

    // Default: directional aim along stick toward goal
    let aim = facingShotAim(player, cmd, charge);

    if (assist) {
        const team = typeof player.getTeam === 'function' ? player.getTeam() : null;
        if (team && typeof team.canShoot === 'function') {
            const shot = team.canShoot({ x: player.x, y: player.y }, player);
            if (shot && shot.ok && shot.target) {
                // Only soft-lock AI mouth sample if it lies roughly along aim
                const tdx = shot.target.x - player.x;
                const tdy = shot.target.y - player.y;
                const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
                const dot = (tdx / tlen) * aimDir.x + (tdy / tlen) * aimDir.y;
                if (dot >= 0.55) {
                    // Blend AI mouth with stick aim so player still steers near/far post
                    aim = {
                        x: shot.target.x,
                        y: shot.target.y * 0.45 + aim.y * 0.55
                    };
                }
            }
        }
    }

    player.shotAim = aim;
    player.fsm.changeState(PlayerStates.Shoot);
}

/**
 * Clear in-progress charge (lost ball, switch, busy, etc.).
 * @param {object} sim
 */
function clearManualCharge(sim) {
    if (!sim) return;
    sim._manualCharge = null;
}

/**
 * Get or init charge state on sim.
 * @param {object} sim
 * @returns {{ action: string, ticks: number, curveBias: number }|null}
 */
function getManualCharge(sim) {
    return sim && sim._manualCharge ? sim._manualCharge : null;
}

/**
 * Fire a charged pass/lob/shoot with Stage 2 power + curl.
 * Direction comes from charge sticky aim (stick during hold) or live stick.
 * @returns {object} maybe-updated controlled player (auto-switch)
 */
function fireChargedAction(player, action, charge, cmd, sim, teamKey) {
    if (!player || !action) return player;
    if (charge) updateChargeAim(charge, player, cmd);

    const power = holdPower01(charge ? charge.ticks : 1, holdPowerOpts());
    const bias = charge && typeof charge.curveBias === 'number' ? charge.curveBias : 0;
    const facing = humanFacingDir(player, cmd, charge);
    // Curl: lateral of stick vs sticky aim (small stick bias while holding)
    let curveBias = bias;
    if (cmd && (Math.abs(cmd.moveX) > 1e-4 || Math.abs(cmd.moveY) > 1e-4)) {
        const live = lateralBiasFromMove(facing, cmd.moveX || 0, cmd.moveY || 0);
        // Prefer accumulated charge bias; top up if stick is clearly lateral
        if (Math.abs(curveBias) < 0.12 && Math.abs(live) > 0.2) {
            curveBias = live;
        }
    }
    const shooting = player.effectiveShooting || 65;
    const assist = action === 'shoot' ? aimAssistFlags().shoot : aimAssistFlags().pass;

    if (action === 'shoot') {
        // Rough dist for height curve
        const field = Utils.getFieldBounds();
        const helpers = getPlayerHelpers();
        const attacksRight = helpers.attacksRightGoal(player.level, player.team);
        const gx = attacksRight ? field.width : 0;
        const dist = dist2(player.x, player.y, gx, field.centerY);
        const hk = buildHumanShootKick({
            power,
            curveBias,
            shooting,
            dist,
            aimAssist: assist
        });
        hk.aimDir = { x: facing.x, y: facing.y };
        startHumanShoot(player, cmd, hk, charge);
        player._humanInput = null;
        return player;
    }

    const isLob = action === 'lob';
    const hk = buildHumanPassKick({
        power,
        isLob,
        curveBias,
        shooting,
        aimAssist: assist
    });
    hk.aimDir = { x: facing.x, y: facing.y };
    const receiver = startHumanPass(player, isLob ? 'long' : 'short', cmd, hk, charge);
    player._humanInput = null;
    if (receiver && manualOpts().autoSwitchOnPass !== false) {
        player.humanControlled = false;
        receiver.humanControlled = true;
        if (sim) {
            sim._manualPendingReceiver = receiver;
            sim._manualPassSwitchTicks = 0;
        }
        return receiver;
    }
    return player;
}

/**
 * Stage 4: evaluate whether the human can time a header this tick.
 * @param {object} player
 * @param {object|null} ball
 * @returns {{ ok: boolean, t?: number, x?: number, y?: number, z?: number }}
 */
function evalHumanHeaderWindow(player, ball) {
    const mc = manualOpts();
    if (mc.manualHeader === false) return { ok: false };
    if (!player || !ball || ball.owner) return { ok: false };
    if (!isBallAirborne(ball) && (ball.z || 0) < 0.85) return { ok: false };

    const helpers = getPlayerHelpers();
    let speed = 5.5;
    if (typeof helpers.estimatePlayerTopSpeed === 'function') {
        speed = helpers.estimatePlayerTopSpeed(player);
    }
    const maxT = typeof mc.headerWindowMaxT === 'number' ? mc.headerWindowMaxT : 0.95;
    const contactR = typeof mc.headerContactRadius === 'number' ? mc.headerContactRadius : 1.9;
    const opp = findHeaderOpportunity(
        ball,
        { x: player.x, y: player.y, speed },
        {
            maxTime: maxT,
            contactRadius: contactR,
            jumpLead: 0.45,
            playerSpeed: speed
        }
    );
    if (!opp || !opp.ok) return { ok: false };
    return opp;
}

/**
 * Map charge/press action to header outcome kind.
 * @param {'pass'|'lob'|'shoot'|string} action
 * @returns {'short'|'long'|'shot'}
 */
function headerKindFromAction(action) {
    if (action === 'shoot') return 'shot';
    if (action === 'lob') return 'long';
    return 'short';
}

/**
 * Start Header FSM with Stage 4 humanHeader payload.
 * @param {object} player
 * @param {'short'|'long'|'shot'} kind
 * @param {number} power
 * @param {{ moveX?: number, moveY?: number }|null} cmd
 * @param {{ aimX?: number, aimY?: number, curveBias?: number }|null} charge
 * @returns {boolean}
 */
function startHumanHeader(player, kind, power, cmd, charge) {
    const PlayerStates = getPlayerStates();
    if (!player || !player.fsm || !PlayerStates.Header) return false;
    if (isBusyKicking(player)) return false;

    const facing = humanFacingDir(player, cmd, charge);
    const bias = charge && typeof charge.curveBias === 'number' ? charge.curveBias : 0;
    const shooting = player.effectiveShooting || 65;
    const assist = aimAssistFlags().pass || aimAssistFlags().shoot;

    player.humanHeader = buildHumanHeaderKick({
        kind: kind || 'short',
        power: power != null ? power : 0.55,
        aimDir: { x: facing.x, y: facing.y },
        curveBias: bias,
        shooting,
        aimAssist: assist
    });

    // Face jump toward aim
    if (typeof player.orientation === 'number') {
        const deg = (Math.atan2(facing.x, -facing.y) * 180) / Math.PI;
        player.orientation = ((Math.round(deg / 45) % 8) + 8) % 8;
    }

    player.fsm.changeState(PlayerStates.Header);
    player._humanInput = null;
    return true;
}

/**
 * Stage 4 charge tick for headers (off-ball air window).
 * Reuses pass/lob/shoot buttons → short / long / head-shot.
 * @returns {{ player: object, handled: boolean }}
 */
function tickHeaderChargeAndFire(player, cmd, sim, teamKey, window) {
    if (!player || !cmd) return { player, handled: false };

    if (!holdToPowerEnabled()) {
        // Press-to-jump: map 1/2/3 immediately
        if (cmd.pass || cmd.lob || cmd.shoot) {
            const kind = cmd.shoot ? 'shot' : (cmd.lob ? 'long' : 'short');
            startHumanHeader(player, kind, 0.55, cmd, null);
            return { player, handled: true };
        }
        return { player, handled: false };
    }

    let charge = getManualCharge(sim);

    // If an on-ball style charge leaked in, clear when off-ball header starts
    if (charge && !charge.header) {
        clearManualCharge(sim);
        charge = null;
    }

    const start = resolveChargeStart(cmd, charge ? charge.action : null);
    if (start && (!charge || charge.action !== start)) {
        charge = {
            action: start,
            ticks: 0,
            curveBias: 0,
            aimX: null,
            aimY: null,
            header: true
        };
        updateChargeAim(charge, player, cmd);
        sim._manualCharge = charge;
    }

    if (charge && charge.header) {
        const released = resolveReleasedAction(cmd, charge.action);
        if (released) {
            const power = holdPower01(charge.ticks, holdPowerOpts());
            startHumanHeader(player, headerKindFromAction(released), power, cmd, charge);
            clearManualCharge(sim);
            return { player, handled: true };
        }

        if (isChargeHeld(cmd, charge.action)) {
            charge.ticks = (charge.ticks | 0) + 1;
            const maxTicks = Math.ceil((holdPowerOpts().maxSec || 0.6) / 0.05) + 2;
            if (charge.ticks > maxTicks) charge.ticks = maxTicks;
            updateChargeAim(charge, player, cmd);
            const body = orientationDir(player);
            const bias = lateralBiasFromMove(body, cmd.moveX || 0, cmd.moveY || 0);
            if (Math.abs(bias) > 0.12) {
                charge.curveBias = charge.curveBias * 0.4 + bias * 0.6;
            }
            sim._manualCharge = charge;
            // Move under the flight path while charging the jump
            const tx = window && typeof window.x === 'number' ? window.x : null;
            const ty = window && typeof window.y === 'number' ? window.y : null;
            player._humanInput = {
                moveX: cmd.moveX || 0,
                moveY: cmd.moveY || 0,
                sprint: !!cmd.sprint,
                charging: charge.action,
                chargeTicks: charge.ticks,
                headerWindow: true
            };
            // Soft steer toward predicted contact if stick idle
            if (tx != null && ty != null
                && Math.abs(cmd.moveX || 0) < 1e-4
                && Math.abs(cmd.moveY || 0) < 1e-4) {
                const dx = tx - player.x;
                const dy = ty - player.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len > 0.35 && len < 8) {
                    player._humanInput.moveX = dx / len;
                    player._humanInput.moveY = dy / len;
                }
            }
            return { player, handled: true };
        }

        // Missed keyup: fire with accumulated power
        if (!isChargeHeld(cmd, charge.action)) {
            const power = holdPower01(charge.ticks, holdPowerOpts());
            startHumanHeader(player, headerKindFromAction(charge.action), power, cmd, charge);
            clearManualCharge(sim);
            return { player, handled: true };
        }
    }

    return { player, handled: false };
}

/**
 * Stage 2 charge tick: accumulate hold, fire on release.
 * @returns {{ player: object, handled: boolean }} handled=true means kick/charge consumed the ball path
 */
function tickChargeAndKick(player, cmd, sim, teamKey) {
    if (!holdToPowerEnabled()) {
        // Legacy Stage 1: fire on press — still aim along stick
        if (cmd.pass || cmd.lob) {
            const receiver = startHumanPass(player, cmd.lob ? 'long' : 'short', cmd, null, null);
            player._humanInput = null;
            if (receiver && manualOpts().autoSwitchOnPass !== false) {
                player.humanControlled = false;
                receiver.humanControlled = true;
                if (sim) {
                    sim._manualPendingReceiver = receiver;
                    sim._manualPassSwitchTicks = 0;
                }
                return { player: receiver, handled: true };
            }
            return { player, handled: true };
        }
        if (cmd.shoot) {
            startHumanShoot(player, cmd, null, null);
            player._humanInput = null;
            return { player, handled: true };
        }
        return { player, handled: false };
    }

    let charge = getManualCharge(sim);

    // Start charge on press edge
    const start = resolveChargeStart(cmd, charge ? charge.action : null);
    if (start && (!charge || charge.action !== start)) {
        charge = { action: start, ticks: 0, curveBias: 0, aimX: null, aimY: null };
        updateChargeAim(charge, player, cmd);
        sim._manualCharge = charge;
    }

    // Fire on release of the charged button
    if (charge) {
        const released = resolveReleasedAction(cmd, charge.action);
        if (released) {
            const next = fireChargedAction(player, released, charge, cmd, sim, teamKey);
            clearManualCharge(sim);
            return { player: next, handled: true };
        }

        // Still holding: accumulate ticks, sticky aim, curl bias
        if (isChargeHeld(cmd, charge.action)) {
            charge.ticks = (charge.ticks | 0) + 1;
            const maxTicks = Math.ceil(
                (holdPowerOpts().maxSec || 0.6) / 0.05
            ) + 2;
            if (charge.ticks > maxTicks) charge.ticks = maxTicks;
            updateChargeAim(charge, player, cmd);
            // Curl from lateral stick relative to body orientation (not aim —
            // pure aim stick would otherwise zero the bias every tick)
            const body = orientationDir(player);
            const bias = lateralBiasFromMove(body, cmd.moveX || 0, cmd.moveY || 0);
            if (Math.abs(bias) > 0.12) {
                charge.curveBias = charge.curveBias * 0.4 + bias * 0.6;
            }
            sim._manualCharge = charge;
            // While charging: aim/body from stick, but freeze feet on kickoff hold
            const koLock = isKickoffCarrierLocked(player);
            player._humanInput = {
                moveX: koLock ? 0 : (cmd.moveX || 0),
                moveY: koLock ? 0 : (cmd.moveY || 0),
                sprint: koLock ? false : !!cmd.sprint,
                charging: charge.action,
                chargeTicks: charge.ticks
            };
            return { player, handled: true };
        }

        // Button no longer down and no release edge (focus loss / missed keyup):
        // fire with accumulated power rather than discard
        if (!isChargeHeld(cmd, charge.action)) {
            const next = fireChargedAction(player, charge.action, charge, cmd, sim, teamKey);
            clearManualCharge(sim);
            return { player: next, handled: true };
        }
    }

    return { player, handled: false };
}

/**
 * Continue / finish an in-progress slide for the human player.
 * Stage 3: launch direction is fixed at start (stick vector); do not retarget ball each tick.
 * Soft ball bias only when very close so contact still lands.
 *
 * @param {object} player
 * @param {object} ball
 */
function tickHumanSlide(player, ball) {
    const helpers = getPlayerHelpers();
    if (!player.isSliding) return false;

    player.slideTimer -= Time.deltaTime || 0.05;

    // Prefer locked launch target; soft blend toward ball only inside contact band
    let target = player.slideTarget;
    if (!target || typeof target.x !== 'number') {
        target = ball ? { x: ball.x, y: ball.y } : { x: player.x, y: player.y };
        player.slideTarget = target;
    }
    if (ball) {
        const dBall = dist2(player.x, player.y, ball.x, ball.y);
        if (dBall < 1.4) {
            target = {
                x: target.x * 0.35 + ball.x * 0.65,
                y: target.y * 0.35 + ball.y * 0.65
            };
        }
    }
    player.moveTo(target, 1.6);
    player.frame = 4;

    const slideDist = ball ? dist2(player.x, player.y, ball.x, ball.y) : 99;
    const footRange = (Settings.AI && Settings.AI.FOOT_TACKLE_RANGE) || 0.75;
    const slideRange = (Settings.AI && Settings.AI.SLIDE_TACKLE_RANGE) || 2.2;

    if (slideDist < footRange + 0.25 || player.slideTimer <= 0) {
        if (ball && ball.owner && ball.owner.team !== player.team && slideDist < slideRange + 0.3) {
            helpers.attemptTackle(player, ball, 'slide');
        } else {
            // Missed slide → recovery animation lock
            const rec = (Settings.AI && Settings.AI.TACKLE_RECOVERY_SLIDE) || 0.95;
            if (typeof helpers.applyActionLock === 'function') {
                helpers.applyActionLock(player, rec * 0.55);
            } else {
                player.actionTimer = rec * 0.55;
                player.frame = 5;
            }
            if (player.fsm) {
                const PlayerStates = getPlayerStates();
                if (PlayerStates.Idle) player.fsm.changeState(PlayerStates.Idle);
            }
        }
        player.isSliding = false;
        player.slideTimer = 0;
    }
    return true;
}

/**
 * Soft take-charge: slight collision advantage when overlapping carrier (no button).
 * @param {object} player
 * @param {object} ball
 * @param {{ moveX?: number, moveY?: number, sprint?: boolean }|null} cmd
 */
function applyTakeCharge(player, ball, cmd) {
    const mc = manualOpts();
    if (mc.takeCharge === false) return;
    if (!player || !ball || !ball.owner) return;
    const owner = ball.owner;
    if (owner.team === player.team || owner.role === 'GK') return;
    if (!canTackleSafe(owner)) return;

    const contact = takeChargeContact(player, owner, cmd, {
        range: typeof mc.takeChargeRange === 'number' ? mc.takeChargeRange : 1.15
    });
    if (!contact.ok) return;

    const push = typeof mc.takeChargePush === 'number' ? mc.takeChargePush : 0.055;
    // Stronger shove when sprinting into the carrier
    const mul = contact.sprint ? 1.35 : 1.0;
    owner.x += contact.nx * push * mul;
    owner.y += contact.ny * push * mul;
    // Slightly bleed carrier speed (body contact)
    if (typeof owner._currentSpeed === 'number') {
        owner._currentSpeed *= contact.sprint ? 0.88 : 0.94;
    }

    // Rare soft dislodge when sprint-overlapping (no foul — "taking charge")
    const dislodge = typeof mc.takeChargeDislodgeChance === 'number'
        ? mc.takeChargeDislodgeChance
        : 0.035;
    if (contact.sprint && contact.dist < 0.7 && Math.random() < dislodge) {
        ball.owner = null;
        ball.vx = contact.nx * 1.6 + (player.vx || 0) * 0.2;
        ball.vy = contact.ny * 1.6 + (player.vy || 0) * 0.2;
        ball.vz = 0.25;
        SoundDB.play('tackle');
    }
}

function canTackleSafe(owner) {
    const helpers = getPlayerHelpers();
    if (typeof helpers.canTackleOwner === 'function') {
        return helpers.canTackleOwner(owner);
    }
    return true;
}

/**
 * @param {object} player
 * @param {object} cmd
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 */
function applyHumanCommand(player, cmd, sim, teamKey) {
    if (!player || !cmd || !sim) return player;

    const PlayerStates = getPlayerStates();
    const helpers = getPlayerHelpers();
    const ball = sim.ball;

    // Switch always available (even mid-kick for responsiveness)
    if (cmd.switchPlayer) {
        clearManualCharge(sim);
        const next = switchControlledPlayer(sim, teamKey, player);
        if (next && next !== player) {
            player.humanControlled = false;
            player._humanInput = null;
            next.humanControlled = true;
            return next;
        }
        return player;
    }

    // Stage 3: recovery / animation lock — no move, no new tackle, no charge
    if (player.actionTimer > 0) {
        clearManualCharge(sim);
        player._humanInput = null;
        player.isSliding = false;
        // Keep recovery pose (5/6) while locked; Idle execute also animates this
        if (player.frame !== 5 && player.frame !== 6) {
            player.frame = 5;
        }
        return player;
    }

    if (isBusyKicking(player)) {
        clearManualCharge(sim);
        player._humanInput = null;
        return player;
    }

    // Slide in progress (directional launch continues here)
    if (player.isSliding) {
        clearManualCharge(sim);
        tickHumanSlide(player, ball);
        player._humanInput = null;
        return player;
    }

    const hasBall = !!(ball && ball.owner === player);

    if (hasBall) {
        // Ensure dribble state for carry (AI assign skips human)
        if (PlayerStates.Dribble && stateName(player) !== 'Dribble' && stateName(player) !== 'Pass' && stateName(player) !== 'Shoot') {
            player.fsm.changeState(PlayerStates.Dribble);
        }

        // Stage 2 hold-to-power (or Stage 1 press-to-fire when holdToPower false)
        const charged = tickChargeAndKick(player, cmd, sim, teamKey);
        if (charged.handled) {
            return charged.player;
        }

        // Kickoff: stick aims the first pass but must not walk off the spot
        const koLock = isKickoffCarrierLocked(player);
        player._humanInput = {
            moveX: koLock ? 0 : (cmd.moveX || 0),
            moveY: koLock ? 0 : (cmd.moveY || 0),
            sprint: koLock ? false : !!cmd.sprint
        };
        return player;
    }

    // Off ball — Stage 4 timed headers take priority over tackles when the ball is
    // loose in the air window (keys 1/2/3 → short / long / head-shot).
    // Keep an in-progress header charge even if the window flickers closed mid-hold
    // so release still fires (missed timing = no contact, not a dropped input).
    const headerWin = evalHumanHeaderWindow(player, ball);
    const headerCharge = getManualCharge(sim);
    const headerActive = headerWin.ok || !!(headerCharge && headerCharge.header);
    if (headerActive) {
        if (headerCharge && !headerCharge.header) clearManualCharge(sim);

        const headed = tickHeaderChargeAndFire(
            player,
            cmd,
            sim,
            teamKey,
            headerWin.ok ? headerWin : null
        );
        if (headed.handled) {
            return headed.player;
        }
        // Still free to move under the ball; no tackle on air window presses
        player._humanInput = {
            moveX: cmd.moveX || 0,
            moveY: cmd.moveY || 0,
            sprint: !!cmd.sprint,
            headerWindow: true
        };
        // Soft auto-approach predicted contact when stick idle
        if (headerWin.ok
            && Math.abs(cmd.moveX || 0) < 1e-4 && Math.abs(cmd.moveY || 0) < 1e-4
            && typeof headerWin.x === 'number') {
            const dx = headerWin.x - player.x;
            const dy = headerWin.y - player.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0.4 && len < 10) {
                player._humanInput.moveX = dx / len;
                player._humanInput.moveY = dy / len;
            }
        }
        // Enter Idle for free movement unless already heading
        if (PlayerStates.Idle && stateName(player) !== 'Header' && stateName(player) !== 'Idle') {
            const n = stateName(player);
            if (n !== 'Receive' && n !== 'GoHome' && n !== 'Wait') {
                player.fsm.changeState(PlayerStates.Idle);
            }
        }
        return player;
    }

    // Off ball — drop any leftover charge (cannot fire without possession)
    clearManualCharge(sim);

    // Off ball — Idle for free movement / claim
    if (PlayerStates.Idle && !isBusyKicking(player) && stateName(player) !== 'Idle') {
        // Don't yank out of Receive if AI messaged us — but human owns body; prefer Idle
        const n = stateName(player);
        if (n !== 'Receive' && n !== 'GoHome' && n !== 'Wait') {
            player.fsm.changeState(PlayerStates.Idle);
        }
    }

    if (cmd.tackleFoot && ball && ball.owner && ball.owner.team !== player.team) {
        if (helpers.canTackleOwner(ball.owner)) {
            const d = dist2(player.x, player.y, ball.x, ball.y);
            const footRange = (Settings.AI && Settings.AI.FOOT_TACKLE_RANGE) || 0.75;
            if (d <= footRange + 0.5) {
                helpers.attemptTackle(player, ball, 'foot');
            } else {
                // Step in and poke when close enough next frames — still try if near slide range
                player.moveTo({ x: ball.x, y: ball.y }, 1.15);
                if (d <= footRange + 1.1) {
                    helpers.attemptTackle(player, ball, 'foot');
                }
            }
        }
        player._humanInput = { moveX: cmd.moveX || 0, moveY: cmd.moveY || 0, sprint: !!cmd.sprint };
        return player;
    }

    // Stage 3: body shove (numpad 3 / Digit3 off-ball)
    if (cmd.tackleBody && ball && ball.owner && ball.owner.team !== player.team) {
        if (helpers.canTackleOwner(ball.owner)) {
            const d = dist2(player.x, player.y, ball.owner.x, ball.owner.y);
            const bodyRange = (Settings.AI && Settings.AI.BODY_TACKLE_RANGE) || 1.05;
            if (bodyTackleInRange(d, bodyRange)) {
                helpers.attemptTackle(player, ball, 'body');
            } else if (d <= bodyRange + 0.85) {
                // Close the gap; shoulder next tick if still in range
                player.moveTo({ x: ball.owner.x, y: ball.owner.y }, 1.2);
            }
        }
        player._humanInput = { moveX: cmd.moveX || 0, moveY: cmd.moveY || 0, sprint: !!cmd.sprint };
        return player;
    }

    if (cmd.tackleSlide && ball && ball.owner && ball.owner.team !== player.team) {
        if (helpers.canTackleOwner(ball.owner) && (!player.tackleAttemptCooldown || player.tackleAttemptCooldown <= 0)) {
            const launchDist = (Settings.AI && Settings.AI.SLIDE_LAUNCH_DIST) || 3.2;
            const launch = slideLaunchTarget(
                { x: player.x, y: player.y },
                cmd,
                ball,
                { launchDist, facing: orientationDir(player) }
            );
            player.isSliding = true;
            player.slideTimer = 0.65;
            // Fixed directional launch (Stage 3) — not continuous ball chase
            player.slideTarget = { x: launch.x, y: launch.y };
            player.slideDir = launch.dir ? { x: launch.dir.x, y: launch.dir.y } : null;
            // Face the dive
            if (typeof player.orientation === 'number' && launch.dir) {
                const deg = (Math.atan2(launch.dir.x, -launch.dir.y) * 180) / Math.PI;
                player.orientation = ((Math.round(deg / 45) % 8) + 8) % 8;
            }
            player.frame = 4;
            SoundDB.play('slide');
            tickHumanSlide(player, ball);
            player._humanInput = null;
            return player;
        }
    }

    // Soft take-charge while jockeying / overlapping without a tackle press
    applyTakeCharge(player, ball, cmd);

    player._humanInput = {
        moveX: cmd.moveX || 0,
        moveY: cmd.moveY || 0,
        sprint: !!cmd.sprint
    };
    return player;
}

/**
 * Apply stored human movement for outfield states (called from Dribble/Idle/Chase).
 * @param {object} player
 * @returns {boolean} true if human handled this tick (caller should return)
 */
function applyHumanMovement(player) {
    if (!player || !player.humanControlled) return false;
    // Stage 3 animation lock: freeze feet + recovery frames
    if (player.actionTimer > 0) {
        player._currentSpeed = 0;
        player.vx = 0;
        player.vy = 0;
        if (player.frame !== 5 && player.frame !== 6) player.frame = 5;
        return true;
    }
    if (isBusyKicking(player)) return true;
    if (player.isSliding) return true;

    // Kickoff hold: plant feet until the ball is released (pass/lob/shoot)
    if (isKickoffCarrierLocked(player)) {
        player._currentSpeed = 0;
        player.vx = 0;
        player.vy = 0;
        if (!player.isSliding) player.frame = 0;
        return true;
    }

    const inp = player._humanInput;
    const helpers = getPlayerHelpers();
    const ball = player.level && player.level.ball;

    // Always try to claim loose ball when close
    if (ball && ball.owner === null && typeof helpers.tryClaimLooseBall === 'function') {
        if (helpers.tryClaimLooseBall(player, ball)) {
            return true;
        }
    }

    if (!inp || (Math.abs(inp.moveX) < 1e-6 && Math.abs(inp.moveY) < 1e-6)) {
        player._currentSpeed = Math.max(0, (player._currentSpeed || 0) * 0.75);
        if (!player.isSliding) player.frame = 0;
        return true;
    }

    const step = Utils.scaleFieldX ? Utils.scaleFieldX(4.5) : 4.5;
    const phys = (Settings && Settings.physics) || {};
    const sprintMul = typeof phys.PLAYER_SPRINT_MUL === 'number' ? phys.PLAYER_SPRINT_MUL : 1.42;
    const speedMul = inp.sprint ? sprintMul : 1.0;
    const target = {
        x: player.x + inp.moveX * step,
        y: player.y + inp.moveY * step
    };
    player.moveTo(target, speedMul, { arrive: false, separate: true, sepMult: 0.85 });
    return true;
}

/**
 * Main per-tick entry from MatchStates.Play (before updatePlayerAIStates).
 * @param {object} sim - Simulator
 * @param {{ keyboard?: object }} [opts] - optional keyboard override for tests
 */
function tickManualControl(sim, opts = {}) {
    clearHumanFlags(sim);
    if (!sim || isHeadless() || !anyManualEnabled()) {
        if (sim) sim._manualCameraActive = false;
        return;
    }

    // Kickoff: AI lays off the ball. No move / pass / switch until open play.
    if (isKickoffControlBlocked(sim)) {
        sim._manualCameraActive = false;
        if (sim._manualControlled) {
            sim._manualControlled.A = null;
            sim._manualControlled.B = null;
        }
        sim._manualPendingReceiver = null;
        sim._manualPassSwitchTicks = 0;
        clearManualCharge(sim);
        // Keep view on center spot while dead-ball (overrides stale celebration cam)
        if (typeof sim.snapCameraToKickoff === 'function') {
            sim.snapCameraToKickoff();
        }
        return;
    }

    // Only Team A receives keyboard in Stage 1
    if (!isManualTeamEnabled('A')) {
        sim._manualCameraActive = false;
        return;
    }

    const keyboard = opts.keyboard || gameKeyboard;
    const frame = typeof keyboard.pollFrame === 'function'
        ? keyboard.pollFrame()
        : { command: { moveX: 0, moveY: 0 } };
    const cmd = frame.command || {
        moveX: 0, moveY: 0, pass: false, lob: false, shoot: false,
        passDown: false, lobDown: false, shootDown: false,
        passReleased: false, lobReleased: false, shootReleased: false,
        switchPlayer: false, sprint: false,
        tackleFoot: false, tackleSlide: false, tackleBody: false
    };

    if (!sim._manualControlled) {
        sim._manualControlled = { A: null, B: null };
    }

    // Sticky receiver after auto-switch (until they get the ball or timeout).
    // Do NOT treat the passer still holding the ball during Pass windup as a "claim".
    let stickyPrev = sim._manualControlled.A;
    if (manualOpts().autoSwitchOnPass !== false && sim._manualPendingReceiver) {
        const r = sim._manualPendingReceiver;
        const pool = getControllablePlayers(sim, 'A');
        sim._manualPassSwitchTicks = (sim._manualPassSwitchTicks || 0) + 1;
        if (pool.includes(r)) {
            stickyPrev = r;
        }
        const ball = sim.ball;
        const owner = ball && ball.owner;
        if (owner === r) {
            sim._manualPendingReceiver = null;
            sim._manualPassSwitchTicks = 0;
        } else if (owner && owner.team !== 'A') {
            sim._manualPendingReceiver = null;
            sim._manualPassSwitchTicks = 0;
        } else if (
            owner
            && owner.team === 'A'
            && pool.includes(owner)
            && owner !== r
            && stateName(owner) !== 'Pass'
            && stateName(owner) !== 'Shoot'
        ) {
            // Another teammate claimed after the ball was released
            stickyPrev = owner;
            sim._manualPendingReceiver = null;
            sim._manualPassSwitchTicks = 0;
        } else if ((sim._manualPassSwitchTicks || 0) > 90) {
            // ~4.5s at 20 UPS — drop sticky
            sim._manualPendingReceiver = null;
            sim._manualPassSwitchTicks = 0;
        }
    }

    let controlled = resolveControlledPlayer(sim, 'A', stickyPrev);
    // Keep receiver sticky while pass winds up / ball in flight (ISS auto-switch).
    // Prefer pending receiver over ball-owner (passer still has ball during windup).
    if (sim._manualPendingReceiver && getControllablePlayers(sim, 'A').includes(sim._manualPendingReceiver)) {
        const ball = sim.ball;
        const owner = ball && ball.owner;
        if (owner && owner.team !== 'A') {
            // Turnover — drop sticky (cleared above on next checks too)
            controlled = resolveControlledPlayer(sim, 'A', stickyPrev);
        } else if (
            owner
            && owner.team === 'A'
            && owner !== sim._manualPendingReceiver
            && stateName(owner) !== 'Pass'
            && stateName(owner) !== 'Shoot'
        ) {
            // Another teammate already has possession (not the passer winding up)
            controlled = owner;
            sim._manualPendingReceiver = null;
            sim._manualPassSwitchTicks = 0;
        } else {
            controlled = sim._manualPendingReceiver;
        }
    }

    if (controlled) {
        controlled.humanControlled = true;
        controlled = applyHumanCommand(controlled, cmd, sim, 'A');
        if (controlled) {
            controlled.humanControlled = true;
            controlled.isActivePlayer = true;
        }
    }
    sim._manualControlled.A = controlled || null;

    // Record after charge/apply so log includes this tick's charge state
    recordManualInput(sim, cmd);

    // Camera follow is applied in Simulator.update when this flag is set
    if (manualOpts().cameraFollow !== false) {
        updateManualCameraFollow(sim, controlled);
    } else {
        sim._manualCameraActive = false;
    }
}

/**
 * Whether AI assignment must leave this player alone.
 * @param {object} player
 */
function shouldSkipAIAssign(player) {
    return !!(player && player.humanControlled);
}

module.exports = {
    isManualTeamEnabled,
    anyManualEnabled,
    resolveControlledPlayer,
    switchControlledPlayer,
    getControllablePlayers,
    orientationDir,
    humanFacingDir,
    findHumanPassTarget,
    applyHumanMovement,
    applyHumanCommand,
    startHumanPass,
    startHumanShoot,
    startHumanHeader,
    evalHumanHeaderWindow,
    headerKindFromAction,
    fallbackKickAlongFacing,
    tickManualControl,
    shouldSkipAIAssign,
    clearHumanFlags,
    isBusyKicking,
    isKickoffControlBlocked,
    isKickoffCarrierLocked,
    updateManualCameraFollow,
    recordManualInput,
    clearManualCharge,
    fireChargedAction,
    holdToPowerEnabled,
    aimAssistFlags,
    tickHumanSlide,
    applyTakeCharge,
    commandFromFrame: require('./input_keyboard.js').commandFromFrame
};
