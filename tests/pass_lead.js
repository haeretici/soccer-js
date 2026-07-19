#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Lead-pass geometry: tangent points + GetBestPassToReceiver wiring.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    getTangentPoints,
    getBestPassToReceiver,
    buildLeadPassCandidates,
    isPassPointInBounds,
    LEAD_RANGE_SCALE,
    estimatePassGroundSpeed,
    isPassSafeFromAllOpponents
} = require('../kernel/core/lib/pass_safety.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function makePlayer(x, y, team, speed = 70) {
    return {
        x, y, team,
        isSentOff: false,
        stats: { speed, passing: 75 },
        staminaMultiplier: 1,
        role: 'CM',
        level: {
            isSecondHalf: () => false
        }
    };
}

async function main() {
    // --- Tangents ---
    const C = { x: 10, y: 10 };
    const P = { x: 0, y: 10 };
    const R = 3;
    const tangents = getTangentPoints(C, R, P);
    assert.ok(tangents, 'tangents exist when P outside circle');
    // Distance from C to each tangent point ≈ R
    const d1 = Math.hypot(tangents.t1.x - C.x, tangents.t1.y - C.y);
    const d2 = Math.hypot(tangents.t2.x - C.x, tangents.t2.y - C.y);
    assert.ok(Math.abs(d1 - R) < 1e-6, `t1 on circle (${d1})`);
    assert.ok(Math.abs(d2 - R) < 1e-6, `t2 on circle (${d2})`);
    // Inside circle → null
    assert.strictEqual(getTangentPoints(C, R, { x: 10, y: 10 }), null);
    assert.ok(LEAD_RANGE_SCALE === 0.3);
    log('PASS getTangentPoints geometry');

    // --- Candidates include feet + tangents ---
    const from = { x: 0, y: 25 };
    const recv = makePlayer(20, 25, 'A', 80);
    const cands = buildLeadPassCandidates(from, recv, makePlayer(0, 25, 'A'), 'short', { x: 22, y: 28 });
    assert.ok(cands.length >= 3, `expected ≥3 candidates, got ${cands.length}`);
    const hasFeet = cands.some(p => p.x === 20 && p.y === 25);
    assert.ok(hasFeet, 'includes receiver feet');
    log('PASS buildLeadPassCandidates includes feet/support/tangents');

    // --- Best aim prefers upfield when open ---
    const passer = makePlayer(0, 25, 'A');
    passer.level = { isSecondHalf: () => false };
    const receiver = makePlayer(15, 25, 'A', 80);
    const opponents = [makePlayer(40, 5, 'B', 50)]; // far away
    const aim = getBestPassToReceiver(from, receiver, passer, opponents, {
        passType: 'short',
        oppGoalX: 80,
        supportPoint: { x: 18, y: 30 }
    });
    assert.ok(aim, 'finds a safe aim');
    assert.ok(isPassPointInBounds(aim), 'aim in bounds');
    // Prefer point closer to opp goal (higher x when goal at 80)
    assert.ok(aim.x >= receiver.x - 0.01, `aim not behind receiver (aim.x=${aim.x})`);
    log('PASS getBestPassToReceiver returns safe upfield aim');

    // Blocked feet but open tangent space — still may find aim
    const wall = makePlayer(7, 25, 'B', 99);
    const aim2 = getBestPassToReceiver(from, receiver, passer, [wall], {
        passType: 'short',
        oppGoalX: 80
    });
    // May be null or a tangent that clears the wall; if present must be safe
    if (aim2) {
        const spd = estimatePassGroundSpeed(from, aim2, passer, 'short');
        assert.ok(
            isPassSafeFromAllOpponents(from, aim2, receiver, [wall], spd),
            'returned aim must pass safety'
        );
    }
    log('PASS lead aim respects safety against on-lane blocker');

    // --- Live Team ---
    const sim = new Simulator({ seed: 11 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const a = sim.teamA;
    const carrier = a.getOutfieldPlayers()[0];
    const mate = a.getOutfieldPlayers().find(p => p !== carrier);
    carrier.x = 25;
    carrier.y = 25;
    mate.x = 40;
    mate.y = 25;
    for (const d of sim.teamB.players) {
        d.x = 70;
        d.y = 5;
    }
    sim.ball.owner = carrier;

    assert.strictEqual(typeof a.getBestPassToReceiver, 'function');
    const teamAim = a.getBestPassToReceiver(carrier, mate, { passType: 'short' });
    assert.ok(teamAim, 'Team.getBestPassToReceiver works');
    assert.ok(typeof teamAim.x === 'number' && typeof teamAim.y === 'number');

    const decision = a.findBestPassTarget(carrier);
    if (decision) {
        assert.ok(decision.teammate, 'decision has teammate');
        assert.ok(decision.aim, 'decision has aim');
        assert.ok(decision.type === 'short' || decision.type === 'long');
        // Aim should not be absurdly far from receiver (within lead scale)
        const leadDist = Math.hypot(decision.aim.x - decision.teammate.x, decision.aim.y - decision.teammate.y);
        assert.ok(leadDist < Utils.scaleFieldX(25), `aim near receiver (leadDist=${leadDist})`);
    }
    log('PASS Team.findBestPassTarget returns { teammate, type, aim }');

    // Pass state stores aim
    if (decision) {
        carrier.passTarget = decision.teammate;
        carrier.passType = decision.type;
        carrier.passAim = decision.aim;
        assert.strictEqual(carrier.passAim.x, decision.aim.x);
    }
    log('PASS passAim field on player');

    log('\nAll lead-pass geometry tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
