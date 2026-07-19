/**
 * AI debug canvas overlays (support spots, regions, roles, pass lanes, …).
 *
 * Dev-only: all flags default false. No-ops when Settings.HEADLESS or master
 * enabled is false. Drawn in Simulator.onGUI (screen space via Utils.toScreen).
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');
const {
    isPassSafeFromAllOpponents,
    estimatePassGroundSpeed,
    timeToCoverDistance,
    estimateShotGroundSpeed
} = require('./pass_safety.js');
const { isThreatened, getThreatInfo } = require('../entities/player.js');

/** Default debugAI flags (production: all off). */
const DEBUG_AI_DEFAULTS = {
    enabled: false,
    supportSpots: false,
    regions: false,
    homeTargets: false,
    roles: false,
    states: false,
    threatened: false,
    passLanes: false,
    positionTrace: false,
    marking: false,
    playPhase: false,
    offsideLine: false,
    /** A.6: freekick wall positions + jump arc */
    freekickWall: false,
    predictedPath: false,
    goalMouth: false
};

/**
 * Ensure Settings.debugAI exists with defaults.
 * @returns {typeof DEBUG_AI_DEFAULTS}
 */
function ensureDebugAI() {
    if (!Settings.debugAI || typeof Settings.debugAI !== 'object') {
        Settings.debugAI = Object.assign({}, DEBUG_AI_DEFAULTS);
    } else {
        for (const [k, v] of Object.entries(DEBUG_AI_DEFAULTS)) {
            if (Settings.debugAI[k] === undefined) Settings.debugAI[k] = v;
        }
    }
    return Settings.debugAI;
}

/**
 * @returns {boolean}
 */
function isAiDebugActive() {
    if (Settings.HEADLESS) return false;
    const d = ensureDebugAI();
    if (!d.enabled) return false;
    return !!(
        d.supportSpots || d.regions || d.homeTargets || d.roles
        || d.states || d.threatened || d.passLanes || d.positionTrace || d.marking || d.playPhase
        || d.freekickWall || d.offsideLine || d.predictedPath || d.goalMouth
    );
}

function worldToScreen(x, y, z = 0) {
    return Utils.toScreen(x, y, z);
}

function drawRing(g, x, y, radiusPx, stroke, lineWidth = 2) {
    const s = worldToScreen(x, y, 0);
    g.beginPath();
    g.strokeStyle = stroke;
    g.lineWidth = lineWidth;
    g.arc(s.x, s.y, Math.max(0.1, radiusPx), 0, Math.PI * 2);
    g.stroke();
}

function drawLineWorld(g, x0, y0, x1, y1, stroke, lineWidth = 1.5, alpha = 1) {
    const a = worldToScreen(x0, y0, 0);
    const b = worldToScreen(x1, y1, 0);
    g.save();
    g.globalAlpha = alpha;
    g.beginPath();
    g.strokeStyle = stroke;
    g.lineWidth = lineWidth;
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    g.restore();
}

function drawLabel(g, x, y, text, fill = '#fff', font = '10px monospace') {
    const s = worldToScreen(x, y, 0);
    g.save();
    g.font = font;
    g.fillStyle = fill;
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.lineWidth = 3;
    g.strokeText(text, s.x + 6, s.y - 8);
    g.fillText(text, s.x + 6, s.y - 8);
    g.restore();
}

function drawSupportSpots(g, team) {
    if (!team || !team.supportSpots || !team.supportSpots.spots) return;
    const spots = team.supportSpots.spots;
    const best = team.supportSpots.bestSpot;
    let maxScore = 1;
    for (let i = 0; i < spots.length; i++) {
        if (spots[i].score > maxScore) maxScore = spots[i].score;
    }
    for (let i = 0; i < spots.length; i++) {
        const sp = spots[i];
        const t = maxScore > 1 ? Math.max(0, Math.min(1, (sp.score - 1) / (maxScore - 1 || 1))) : 0;
        const r = Math.max(0.5, 3 + t * 5);
        const s = worldToScreen(sp.x, sp.y, 0);
        const isBest = best && Math.abs(best.x - sp.x) < 1e-6 && Math.abs(best.y - sp.y) < 1e-6;
        g.beginPath();
        g.fillStyle = isBest
            ? 'rgba(0, 255, 180, 0.85)'
            : `rgba(80, 180, 255, ${0.25 + t * 0.55})`;
        g.arc(s.x, s.y, Math.max(0.1, isBest ? r + 2 : r), 0, Math.PI * 2);
        g.fill();

        // Draw numerical score value next to spot
        if (sp.score > 0) {
            g.save();
            g.fillStyle = 'rgba(255, 255, 255, 0.45)';
            g.font = '7px monospace';
            g.fillText(sp.score.toFixed(1), s.x + r + 2, s.y + 2.5);
            g.restore();
        }
    }
    if (team.supportingPlayer && best) {
        drawLineWorld(
            g,
            team.supportingPlayer.x, team.supportingPlayer.y,
            best.x, best.y,
            'rgba(0, 255, 180, 0.7)', 1.5
        );
    }
}

function drawRegions(g, pitch) {
    if (!pitch || typeof pitch.ensureRegions !== 'function') return;
    const regions = pitch.ensureRegions();
    if (!regions || !regions.length) return;
    g.save();
    g.lineWidth = 1;
    for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const c0 = worldToScreen(r.left, r.top, 0);
        const c1 = worldToScreen(r.right, r.top, 0);
        const c2 = worldToScreen(r.right, r.bottom, 0);
        const c3 = worldToScreen(r.left, r.bottom, 0);
        g.beginPath();
        g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        g.fillStyle = 'rgba(255, 255, 255, 0.03)';
        g.moveTo(c0.x, c0.y);
        g.lineTo(c1.x, c1.y);
        g.lineTo(c2.x, c2.y);
        g.lineTo(c3.x, c3.y);
        g.closePath();
        g.fill();
        g.stroke();
        const mid = worldToScreen(r.centerX, r.centerY, 0);
        g.fillStyle = 'rgba(200, 200, 200, 0.45)';
        g.font = '9px monospace';
        g.fillText(String(r.id), mid.x - 4, mid.y + 3);
    }
    g.restore();
}

function drawHomeTargets(g, players) {
    if (!players) return;
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || p.isSentOff || !p.active) continue;
        const hx = p.baseX;
        const hy = p.baseY;
        if (hx == null || hy == null) continue;
        const teamColor = p.team === 'A' ? 'rgba(0, 200, 255, 0.55)' : 'rgba(255, 200, 0, 0.55)';
        drawLineWorld(g, p.x, p.y, hx, hy, teamColor, 1, 0.7);
        const s = worldToScreen(hx, hy, 0);
        g.beginPath();
        g.strokeStyle = teamColor;
        g.lineWidth = 1.5;
        g.rect(s.x - 3, s.y - 3, 6, 6);
        g.stroke();
    }
}

function drawRoles(g, team) {
    if (!team) return;
    const mark = (player, color, label) => {
        if (!player || player.isSentOff) return;
        drawRing(g, player.x, player.y, 12, color, 2.5);
        if (label) drawLabel(g, player.x, player.y, label, color, '9px monospace');
    };

    const ctrl = team.controllingPlayer;
    const sup = team.supportingPlayer;
    const rcv = team.receivingPlayer;

    // Draw dashed connection lines
    if (ctrl && !ctrl.isSentOff) {
        if (sup && !sup.isSentOff) {
            g.save();
            g.setLineDash([3, 3]);
            drawLineWorld(g, ctrl.x, ctrl.y, sup.x, sup.y, 'rgba(255, 220, 0, 0.5)', 1.5);
            g.restore();
        }
        if (rcv && !rcv.isSentOff) {
            g.save();
            g.setLineDash([3, 3]);
            drawLineWorld(g, ctrl.x, ctrl.y, rcv.x, rcv.y, 'rgba(120, 255, 80, 0.5)', 1.5);
            g.restore();
        }
    }

    mark(ctrl, 'rgba(0, 255, 255, 0.9)', 'CTRL');
    mark(sup, 'rgba(255, 220, 0, 0.9)', 'SUP');
    mark(rcv, 'rgba(120, 255, 80, 0.9)', 'RCV');
    mark(team.playerClosestToBall, 'rgba(255, 140, 40, 0.75)', 'CLB');
    if (team.stickyPrimaryChaser && team.stickyPrimaryChaser !== team.playerClosestToBall) {
        mark(team.stickyPrimaryChaser, 'rgba(255, 80, 80, 0.8)', 'PRS');
    }
}

function drawStates(g, players) {
    if (!players) return;
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || p.isSentOff || !p.fsm) continue;
        const name = typeof p.fsm.getNameOfCurrentState === 'function'
            ? p.fsm.getNameOfCurrentState()
            : '';
        if (!name) continue;
        const short = name.length > 10 ? name.slice(0, 9) + '…' : name;
        drawLabel(g, p.x, p.y, short, 'rgba(255,255,255,0.85)', '9px monospace');
    }
}

function drawThreatened(g, players) {
    if (!players) return;
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || p.isSentOff) continue;
        // Prefer live flag from dribble; else query comfort zone (carriers only for cost)
        let threatened = p.debugThreatened;
        if (threatened == null && p.level && p.level.ball && p.level.ball.owner === p) {
            threatened = isThreatened(p);
        }
        if (!threatened) continue;
        drawRing(g, p.x, p.y, 14, 'rgba(255, 60, 60, 0.9)', 2);
        const info = getThreatInfo(p);
        if (info.nearest) {
            drawLineWorld(
                g, p.x, p.y, info.nearest.x, info.nearest.y,
                'rgba(255, 80, 80, 0.45)', 1
            );
        }
    }
}

/** A.3 possession phase label near controller */
function drawPlayPhase(g, team) {
    if (!team || !team.playPhase || team.playPhase === 'none') return;
    const c = team.controllingPlayer
        || (team.level && team.level.ball && team.level.ball.owner
            && team.level.ball.owner.team === team.teamKey
            ? team.level.ball.owner
            : null);
    if (!c) return;
    const colors = {
        build: 'rgba(100, 200, 255, 0.95)',
        progress: 'rgba(180, 255, 140, 0.95)',
        finish: 'rgba(255, 160, 80, 0.95)'
    };
    drawLabel(
        g, c.x, c.y - 1.2,
        String(team.playPhase).toUpperCase(),
        colors[team.playPhase] || 'rgba(220, 220, 220, 0.95)',
        '10px monospace'
    );
}

/** A.2 mark links + cover points */
function drawMarking(g, team) {
    if (!team || !team.markingPairs || !team.markingPairs.length) return;
    for (let i = 0; i < team.markingPairs.length; i++) {
        const pair = team.markingPairs[i];
        if (!pair || !pair.marker || !pair.target) continue;
        const m = pair.marker;
        const t = pair.target;
        drawLineWorld(g, m.x, m.y, t.x, t.y, 'rgba(255, 180, 60, 0.7)', 1.6);
        if (m.markCoverPoint) {
            drawLineWorld(
                g, m.x, m.y, m.markCoverPoint.x, m.markCoverPoint.y,
                'rgba(255, 220, 100, 0.45)', 1.1
            );
            drawRing(g, m.markCoverPoint.x, m.markCoverPoint.y, 5, 'rgba(255, 200, 80, 0.85)', 1.5);
        }
        drawRing(g, t.x, t.y, 7, 'rgba(255, 140, 40, 0.9)', 2);
        drawLabel(g, t.x, t.y, 'MARK', 'rgba(255, 200, 120, 0.95)', '9px monospace');
    }
}

/**
 * A.6 freekick wall: draw player positions, the wall line, and a jump-arc indicator.
 * @param {CanvasRenderingContext2D} g
 * @param {object[]} wallPlayers
 */
function drawFreekickWall(g, wallPlayers) {
    if (!wallPlayers || !wallPlayers.length) return;
    // Draw wall player rings and jump-arc progress
    for (let i = 0; i < wallPlayers.length; i++) {
        const p = wallPlayers[i];
        if (!p) continue;
        const color = p.wallJumpActive ? 'rgba(255, 255, 80, 0.95)' : 'rgba(240, 100, 30, 0.85)';
        drawRing(g, p.x, p.y, 9, color, 2.5);
        drawLabel(g, p.x, p.y, p.wallJumpActive ? 'JUMP' : 'WALL', color, '9px monospace');
    }
    // Draw the wall line between outermost players
    if (wallPlayers.length >= 2) {
        const first = wallPlayers[0];
        const last = wallPlayers[wallPlayers.length - 1];
        drawLineWorld(g, first.x, first.y, last.x, last.y, 'rgba(240, 100, 30, 0.55)', 2);
    }
}

/** A.1 winning-layer labels + target markers */
function drawPositionTrace(g, players) {
    if (!players) return;
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || p.isSentOff || p.role === 'GK') continue;
        let tr = p._positionTrace;
        if ((!tr || tr.x == null) && typeof p.resolveIdlePosition === 'function') {
            tr = p.resolveIdlePosition();
        }
        if (!tr) continue;
        drawLineWorld(g, p.x, p.y, tr.x, tr.y, 'rgba(180, 120, 255, 0.55)', 1.2);
        const s = worldToScreen(tr.x, tr.y, 0);
        g.beginPath();
        g.strokeStyle = 'rgba(200, 140, 255, 0.9)';
        g.lineWidth = 1.5;
        g.arc(s.x, s.y, 5, 0, Math.PI * 2);
        g.stroke();
        const short = (tr.winningLayer || '').replace(/^L\d_/, '') || tr.mode || '?';
        drawLabel(g, tr.x, tr.y, short, 'rgba(220, 180, 255, 0.95)', '9px monospace');
    }
}

function drawPassLanes(g, team) {
    if (!team) return;
    const controller = team.controllingPlayer
        || (team.level && team.level.ball && team.level.ball.owner
            && team.level.ball.owner.team === team.teamKey
            ? team.level.ball.owner
            : null);
    if (!controller || controller.isSentOff) return;
    const ball = team.level && team.level.ball;
    if (!ball || (ball.owner && ball.owner !== controller)) return;

    const from = { x: controller.x, y: controller.y };
    const opponents = typeof team.getOpponentPool === 'function'
        ? team.getOpponentPool()
        : [];
    const mates = team.getOutfieldPlayers ? team.getOutfieldPlayers() : team.players;

    for (let i = 0; i < mates.length; i++) {
        const m = mates[i];
        if (!m || m === controller || m.isSentOff) continue;
        const to = { x: m.x, y: m.y };
        const speed = estimatePassGroundSpeed(from, to, controller, 'short');
        const safe = isPassSafeFromAllOpponents(from, to, m, opponents, speed);
        drawLineWorld(
            g,
            controller.x, controller.y,
            m.x, m.y,
            safe ? 'rgba(80, 255, 120, 0.55)' : 'rgba(255, 70, 70, 0.45)',
            safe ? 1.5 : 1.2
        );

        // Draw safety and time label
        const dist = Math.sqrt(Math.pow(m.x - controller.x, 2) + Math.pow(m.y - controller.y, 2));
        const time = timeToCoverDistance(dist, speed);
        const midX = (controller.x + m.x) * 0.5;
        const midY = (controller.y + m.y) * 0.5;
        const label = `${safe ? 'SAFE' : 'CUT'} (${time.toFixed(1)}s)`;
        drawLabel(g, midX, midY, label, safe ? 'rgba(80, 255, 120, 0.9)' : 'rgba(255, 100, 100, 0.9)', '8px monospace');
    }
}

/**
 * Main entry: draw all enabled AI debug layers for a Simulator instance.
 * @param {CanvasRenderingContext2D} g
 * @param {object} sim - Simulator
 */
function drawAiDebugOverlays(g, sim) {
    if (!g || !sim || !isAiDebugActive()) return;

    const d = ensureDebugAI();
    g.save();

    try {
        if (d.regions && sim.pitch) {
            drawRegions(g, sim.pitch);
        }
        if (d.supportSpots) {
            if (sim.teamA) drawSupportSpots(g, sim.teamA);
            if (sim.teamB) drawSupportSpots(g, sim.teamB);
        }
        if (d.homeTargets && sim.players) {
            drawHomeTargets(g, sim.players);
        }
        if (d.passLanes) {
            if (sim.teamA) drawPassLanes(g, sim.teamA);
            if (sim.teamB) drawPassLanes(g, sim.teamB);
        }
        if (d.roles) {
            if (sim.teamA) drawRoles(g, sim.teamA);
            if (sim.teamB) drawRoles(g, sim.teamB);
        }
        if (d.threatened && sim.players) {
            drawThreatened(g, sim.players);
        }
        if (d.states && sim.players) {
            drawStates(g, sim.players);
        }
        if (d.positionTrace && sim.players) {
            drawPositionTrace(g, sim.players);
        }
        if (d.marking) {
            if (sim.teamA) drawMarking(g, sim.teamA);
            if (sim.teamB) drawMarking(g, sim.teamB);
        }
        if (d.playPhase) {
            if (sim.teamA) drawPlayPhase(g, sim.teamA);
            if (sim.teamB) drawPlayPhase(g, sim.teamB);
        }
        if (d.freekickWall && sim.freekickWallPlayers) {
            drawFreekickWall(g, sim.freekickWallPlayers);
        }
        if (d.offsideLine) {
            drawOffsideLines(g, sim);
        }
        if (d.predictedPath && sim.ball) {
            drawPredictedPath(g, sim.ball);
        }
        if (d.goalMouth) {
            drawGoalMouth(g, sim);
        }
    } finally {
        g.restore();
    }
}

function drawPredictedPath(g, ball) {
    if (!ball || (ball.vx === 0 && ball.vy === 0 && ball.vz === 0)) return;

    const steps = 30;
    const dt = 0.05;
    g.save();

    // 1. Draw projected shadow path (on the ground plane, z=0)
    g.beginPath();
    g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    g.lineWidth = 1.5;
    g.setLineDash([4, 4]);
    let firstShadow = worldToScreen(ball.x, ball.y, 0);
    g.moveTo(firstShadow.x, firstShadow.y);
    for (let i = 1; i <= steps; i++) {
        const t = i * dt;
        const pos = typeof ball.futurePosition === 'function' ? ball.futurePosition(t) : { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t, z: 0 };
        const s = worldToScreen(pos.x, pos.y, 0);
        g.lineTo(s.x, s.y);
    }
    g.stroke();

    // 2. Draw actual 3D path (taking z height into account)
    g.beginPath();
    g.strokeStyle = 'rgba(255, 255, 0, 0.75)'; // vibrant yellow
    g.lineWidth = 2.5;
    g.setLineDash([]);
    let firstBall = worldToScreen(ball.x, ball.y, ball.z);
    g.moveTo(firstBall.x, firstBall.y);
    for (let i = 1; i <= steps; i++) {
        const t = i * dt;
        const pos = typeof ball.futurePosition === 'function' ? ball.futurePosition(t) : { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t, z: ball.z + ball.vz * t - 9 * t * t };
        const s = worldToScreen(pos.x, pos.y, pos.z || 0);
        g.lineTo(s.x, s.y);
    }
    g.stroke();

    g.restore();
}

function drawGoalMouth(g, sim) {
    if (!sim || !sim.ball) return;

    // Find attacking team
    const team = sim.teamA && sim.teamA.controllingPlayer ? sim.teamA :
                 (sim.teamB && sim.teamB.controllingPlayer ? sim.teamB :
                 (sim.ball.owner ? sim.ball.owner.getTeam() :
                 (sim.teamA && sim.teamB && sim.teamA.closestDistToBallSq < sim.teamB.closestDistToBallSq ? sim.teamA : sim.teamB)));

    if (!team || !team.opponentsGoal) return;

    const goal = team.opponentsGoal;
    const opponents = typeof team.getOpponentPool === 'function' ? team.getOpponentPool() : [];
    const shooter = team.controllingPlayer || team.playerClosestToBall;
    const ballPos = sim.ball;

    const bounds = goal.getMouthYBounds ? goal.getMouthYBounds() : { yMin: 40, yMax: 60 };
    const yMin = bounds.yMin;
    const yMax = bounds.yMax;
    const x = goal.lineX;

    const count = 12;
    g.save();

    for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const y = yMin + t * (yMax - yMin);
        const target = { x, y };

        const power = shooter ? estimateShotGroundSpeed(shooter) : 18.5;
        const safe = isPassSafeFromAllOpponents(ballPos, target, null, opponents, power);

        // Draw line from ball to goal sample
        drawLineWorld(
            g,
            ballPos.x, ballPos.y,
            target.x, target.y,
            safe ? 'rgba(80, 255, 120, 0.15)' : 'rgba(255, 70, 70, 0.15)',
            1.2
        );

        // Draw dot on the goal line
        const s = worldToScreen(target.x, target.y, 0);
        g.beginPath();
        g.fillStyle = safe ? 'rgba(80, 255, 120, 0.95)' : 'rgba(255, 70, 70, 0.95)';
        g.arc(s.x, s.y, 4, 0, Math.PI * 2);
        g.fill();
    }

    g.restore();
}

function drawOffsideLines(g, sim) {
    const field = Utils.getFieldBounds();
    
    // For Team A (attacking B's goal)
    if (sim.offsideLineA != null && sim.offsideLineA !== field.width && sim.offsideLineA !== 0) {
        g.strokeStyle = 'rgba(235, 64, 52, 0.7)'; // Red-ish semi-transparent
        g.lineWidth = 2;
        g.setLineDash([5, 5]);
        const p1 = Utils.toScreen(sim.offsideLineA, 0);
        const p2 = Utils.toScreen(sim.offsideLineA, field.height);
        g.beginPath();
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.stroke();
    }
    
    // For Team B (attacking A's goal)
    if (sim.offsideLineB != null && sim.offsideLineB !== field.width && sim.offsideLineB !== 0) {
        g.strokeStyle = 'rgba(235, 177, 52, 0.7)'; // Yellow-ish/orange semi-transparent
        g.lineWidth = 2;
        g.setLineDash([5, 5]);
        const p1 = Utils.toScreen(sim.offsideLineB, 0);
        const p2 = Utils.toScreen(sim.offsideLineB, field.height);
        g.beginPath();
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.stroke();
    }
    g.setLineDash([]); // Reset dash
}

module.exports = {
    DEBUG_AI_DEFAULTS,
    ensureDebugAI,
    isAiDebugActive,
    drawAiDebugOverlays,
    // exposed for unit tests
    drawSupportSpots,
    drawRegions,
    drawHomeTargets,
    drawRoles,
    drawStates,
    drawThreatened,
    drawPassLanes,
    drawMarking,
    drawPlayPhase,
    drawPositionTrace,
    drawFreekickWall,
    drawOffsideLines,
    drawPredictedPath,
    drawGoalMouth
};
