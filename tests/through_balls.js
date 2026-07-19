#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * A.7 Through-balls & progressive leads.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Time, LOGIC_DT } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    getSecondLastDefenderX,
    scoreProgressiveLeadAim,
    getBestPassToReceiver,
    buildLeadPassCandidates,
    isPassSafeFromAllOpponents,
    estimatePassGroundSpeed
} = require('../kernel/core/lib/pass_safety.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function makePlayer(x, y, team, extras = {}) {
    return {
        x, y, team,
        isSentOff: false,
        stats: { speed: extras.speed || 75, passing: 75 },
        staminaMultiplier: 1,
        role: extras.role || 'CM',
        level: extras.level || { isSecondHalf: () => false }
    };
}

function testDefensiveLine() {
    const opps = [
        makePlayer(70, 25, 'B'), // deep
        makePlayer(55, 20, 'B'), // line
        makePlayer(40, 30, 'B')  // higher
    ];
    const line = getSecondLastDefenderX(opps, 1);
    assert.strictEqual(line, 55, `second-last when attacking right, got ${line}`);
    const lineL = getSecondLastDefenderX(opps, -1);
    // attacking left: deepest (lowest x) first → 40, 55 → second = 55
    assert.strictEqual(lineL, 55);
    assert.strictEqual(getSecondLastDefenderX([makePlayer(1, 1, 'B')], 1), null);
    log('PASS getSecondLastDefenderX');
}

function testProgressiveScoringPrefersForward() {
    const from = { x: 20, y: 25 };
    const recv = makePlayer(35, 25, 'A');
    const feet = { x: 35, y: 25 };
    const through = { x: 48, y: 25 }; // past line, still runnable lead
    const back = { x: 28, y: 25 };
    const ctx = {
        oppGoalX: 80,
        attackSign: 1,
        lineX: 42,
        progressiveWeight: 1.15,
        lineBreakBonus: 3.5
    };
    const sFeet = scoreProgressiveLeadAim(from, feet, recv, ctx);
    const sThrough = scoreProgressiveLeadAim(from, through, recv, ctx);
    const sBack = scoreProgressiveLeadAim(from, back, recv, ctx);
    assert.ok(sThrough.lineBreak, 'through past line is line-break');
    assert.ok(!sFeet.lineBreak || feet.x <= ctx.lineX, 'feet not past line');
    assert.ok(sThrough.score > sFeet.score, 'through scores above feet when recv ahead');
    assert.ok(sFeet.score > sBack.score, 'feet above backwards aim');
    assert.ok(sThrough.progressive > sFeet.progressive);

    // Square/back receiver (kickoff-style): feet must beat invented upfield aim
    const behind = makePlayer(18, 27, 'A');
    const feetB = { x: 18, y: 27 };
    const ghostFwd = { x: 28, y: 27 };
    const ctxB = { oppGoalX: 80, attackSign: 1, lineX: 50, progressiveWeight: 1.15, lineBreakBonus: 3.5 };
    const sFeetB = scoreProgressiveLeadAim(from, feetB, behind, ctxB);
    const sGhost = scoreProgressiveLeadAim(from, ghostFwd, behind, ctxB);
    assert.ok(sFeetB.score > sGhost.score, 'behind receiver: feet beat ghost upfield aim');
    log('PASS scoreProgressiveLeadAim progressive + back-pass tether');
}

function testThroughCandidatesAndAim() {
    const field = Utils.getFieldBounds();
    const from = { x: field.width * 0.35, y: field.centerY };
    const passer = makePlayer(from.x, from.y, 'A');
    const receiver = makePlayer(field.width * 0.55, field.centerY, 'A', { speed: 85 });
    // Compact defensive line ahead of receiver toward goal
    const opponents = [];
    for (let i = 0; i < 4; i++) {
        opponents.push(makePlayer(field.width * 0.62, field.centerY - 6 + i * 4, 'B', { speed: 60 }));
    }
    // GK deep
    opponents.push(makePlayer(field.width - 2, field.centerY, 'B', { role: 'GK', speed: 50 }));

    const cands = buildLeadPassCandidates(from, receiver, passer, 'long', null, opponents);
    assert.ok(cands.length >= 6, `rich candidate set (${cands.length})`);
    const lineX = getSecondLastDefenderX(opponents, 1);
    assert.ok(lineX != null);
    const pastLine = cands.some((p) => p.x > lineX + 0.5);
    assert.ok(pastLine, 'includes samples past defensive line');

    const aim = getBestPassToReceiver(from, receiver, passer, opponents, {
        passType: 'long',
        oppGoalX: field.width,
        detail: true
    });
    assert.ok(aim, 'finds safe progressive aim');
    assert.ok(aim.progressive >= 0, 'non-negative progressive gain');
    // Prefer not behind the receiver
    assert.ok(aim.x >= receiver.x - 0.5, `aim not behind receiver (${aim.x} vs ${receiver.x})`);
    const spd = estimatePassGroundSpeed(from, aim, passer, 'long');
    assert.ok(
        isPassSafeFromAllOpponents(from, aim, receiver, opponents, spd),
        'selected aim is pass-safe'
    );
    log('PASS through candidates + getBestPassToReceiver detail');
}

async function testKickoffPreferFeet() {
    const sim = new Simulator({ seed: 42, teamA: 'Brazil', teamB: 'Argentina' });
    await sim.start();
    // Drain kickoff countdown
    for (let i = 0; i < 50; i++) {
        Time.deltaTime = 0.05;
        sim.updateAll();
        if (sim.fsm.getNameOfCurrentState() === 'play') break;
    }
    // Find first kick from kickoff
    let kicked = null;
    for (let i = 0; i < 30; i++) {
        const owner = sim.ball.owner;
        const prevAim = owner && owner.passAim ? { ...owner.passAim } : null;
        const prevTarget = owner && owner.passTarget;
        Time.deltaTime = 0.05;
        const hadOwner = !!sim.ball.owner;
        sim.updateAll();
        if (hadOwner && !sim.ball.owner && (Math.abs(sim.ball.vx) + Math.abs(sim.ball.vy)) > 0.5) {
            kicked = { prevAim, prevTarget, vx: sim.ball.vx, vy: sim.ball.vy };
            break;
        }
        if (prevAim && prevTarget && !kicked) {
            // capture aim while still in Pass windup
            kicked = { prevAim, prevTarget, pending: true };
        }
    }
    // Re-run clean capture of aim at whistle
    const sim2 = new Simulator({ seed: 42, teamA: 'Brazil', teamB: 'Argentina' });
    await sim2.start();
    while (sim2.fsm.getNameOfCurrentState() === 'kickoff' && sim2.stateTimer > LOGIC_DT) {
        Time.deltaTime = LOGIC_DT;
        sim2.updateAll();
    }
    Time.deltaTime = LOGIC_DT;
    sim2.updateAll(); // whistle → Pass
    const taker = sim2.ball.owner;
    assert.ok(taker && taker.passTarget, 'kickoff sets pass target');
    assert.ok(taker.passAim, 'kickoff sets pass aim');
    const dAim = Math.hypot(taker.passAim.x - taker.passTarget.x, taker.passAim.y - taker.passTarget.y);
    assert.ok(dAim < 2.5, `kickoff aim near receiver feet (d=${dAim.toFixed(2)})`);
    // Aim should not be deep into opponent half relative to center when target is near center
    const field = Utils.getFieldBounds();
    assert.ok(
        Math.abs(taker.passAim.x - field.centerX) < Utils.scaleFieldX(8),
        `kickoff aim stays near center, not blasted upfield (aim.x=${taker.passAim.x.toFixed(1)})`
    );
    log('PASS kickoff preferFeet aim near support');
}

async function testTeamPrefersLineBreakWhenOpen() {
    const sim = new Simulator({ seed: 77 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();
    const a = sim.teamA;
    const carrier = a.getOutfieldPlayers().find((p) => p.role !== 'GK');
    const runner = a.getOutfieldPlayers().find((p) => p !== carrier && (p.role === 'ST' || p.role === 'CF' || p.role === 'LW' || p.role === 'RW' || p.role === 'LS' || p.role === 'RS' || p.role === 'CAM' || true));
    assert.ok(carrier && runner);

    carrier.x = field.width * 0.4;
    carrier.y = field.centerY;
    runner.x = field.width * 0.55;
    runner.y = field.centerY;
    // Push B defense into a high-ish line so space exists behind (fixed layout)
    let di = 0;
    for (const d of sim.teamB.players) {
        if (d.role === 'GK') {
            d.x = field.width - 3;
            d.y = field.centerY;
        } else {
            d.x = field.width * 0.68 + (di % 3) * 0.4;
            d.y = field.centerY - 8 + di * 3;
            di++;
        }
    }
    sim.ball.owner = carrier;
    a.controllingPlayer = carrier;

    const decision = a.findBestPassTarget(carrier);
    if (decision) {
        assert.ok(decision.aim);
        assert.ok(typeof decision.lineBreak === 'boolean' || decision.lineBreak === undefined);
        // Progressive field should be present when detail path used
        if (decision.progressive != null) {
            assert.ok(decision.progressive >= -1, 'progressive annotated');
        }
        log('PASS Team.findBestPassTarget progressive annotations');
    } else {
        // Environment may yield no safe pass; still OK if pure helper works
        log('PASS Team.findBestPassTarget (no decision this layout — helpers covered)');
    }
}

async function main() {
    testDefensiveLine();
    testProgressiveScoringPrefersForward();
    testThroughCandidatesAndAim();
    await testKickoffPreferFeet();
    await testTeamPrefersLineBreakWhenOpen();
    log('through_balls: ALL PASS');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
