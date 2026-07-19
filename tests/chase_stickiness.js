#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Loose-ball chase + active-marker stickiness (anti-flicker).
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time, LOGIC_DT } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { PlayerStates } = require('../kernel/core/entities/player.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = false; // markers only run when not headless



async function testActiveMarkerStickiness() {
    const sim = new Simulator({ seed: 11 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.ball.owner = null;
    sim.ball.x = 40;
    sim.ball.y = 25;

    const aOut = sim.players.filter((p) => p.team === 'A' && p.role !== 'GK' && !p.isSentOff);
    const bOut = sim.players.filter((p) => p.team === 'B' && p.role !== 'GK' && !p.isSentOff);
    // Park most players far away
    for (const p of aOut) { p.x = 5; p.y = 5; }
    for (const p of bOut) { p.x = 75; p.y = 45; }

    const nearA1 = aOut[0];
    const nearA2 = aOut[1];
    nearA1.x = 39.5;
    nearA1.y = 25;
    nearA2.x = 40.4;
    nearA2.y = 25.2;
    // Far "nearest" on B — outside ACTIVE_MARKER_MAX_DIST after we place him far
    bOut[0].x = 70;
    bOut[0].y = 40;

    sim.updateActivePlayerMarkers();
    assert.strictEqual(nearA1.isActivePlayer || nearA2.isActivePlayer, true, 'one A near ball marked');
    const first = nearA1.isActivePlayer ? nearA1 : nearA2;
    assert.ok(first.isActivePlayer);
    // B too far → no marker
    assert.ok(!bOut.some((p) => p.isActivePlayer), 'far team B not marked');

    // Oscillate which A is closer — sticky should not flip every tick
    let flips = 0;
    let last = first;
    for (let i = 0; i < 30; i++) {
        // Swap who is nearer by ~0.3 units (less than stickiness margin)
        if (i % 2 === 0) {
            nearA1.x = 39.7;
            nearA2.x = 40.2;
        } else {
            nearA1.x = 40.2;
            nearA2.x = 39.7;
        }
        sim.updateActivePlayerMarkers();
        const cur = nearA1.isActivePlayer ? nearA1 : (nearA2.isActivePlayer ? nearA2 : null);
        assert.ok(cur, 'always one sticky A marker');
        if (cur !== last) flips++;
        last = cur;
    }
    assert.ok(flips <= 2, `active marker should barely flip under micro-oscillation (flips=${flips})`);
    log('PASS active marker stickiness + max dist');
}

async function testLooseChaseReleaseHysteresis() {
    Settings.HEADLESS = true;
    const sim = new Simulator({ seed: 22 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.ball.owner = null;
    sim.ball.x = 40;
    sim.ball.y = 25;
    sim.ball.vx = 0;
    sim.ball.vy = 0;

    const aOut = sim.players.filter((p) => p.team === 'A' && p.role !== 'GK' && !p.isSentOff);
    for (const p of sim.players) {
        if (p.role === 'GK') continue;
        p.x = 10;
        p.y = 10;
        p.fsm.changeState(PlayerStates.Idle);
    }
    const p1 = aOut[0];
    const p2 = aOut[1];
    p1.x = 40.5;
    p1.y = 25;
    p2.x = 41.2;
    p2.y = 25;
    // Park B far
    for (const p of sim.players) {
        if (p.team === 'B' && p.role !== 'GK') {
            p.x = 5;
            p.y = 5;
        }
    }

    // Assign chasers
    sim.updatePlayerAIStates();
    assert.ok(
        p1.fsm.isInState(PlayerStates.ChaseBall) || p2.fsm.isInState(PlayerStates.ChaseBall),
        'someone chases'
    );

    // Both near — may both chase. Force p1 chasing, nudge p2 just outside enter proximity
    p1.fsm.changeState(PlayerStates.ChaseBall);
    const prox = Settings.AI.LOOSE_BALL_PROXIMITY_RANGE;
    const release = prox * (Settings.AI.LOOSE_CHASE_RELEASE_MULT || 1.85);
    // Place p2 between enter and release radii
    p2.x = 40 + (prox + release) * 0.5;
    p2.y = 25;
    p2.fsm.changeState(PlayerStates.ChaseBall);

    let dropToIdle = 0;
    for (let i = 0; i < 20; i++) {
        // Micro-wobble distance around boundary
        p2.x = 40 + prox * 0.9 + (i % 2) * prox * 0.3;
        sim.updatePlayerAIStates();
        if (!p2.fsm.isInState(PlayerStates.ChaseBall) && !p2.fsm.isInState(PlayerStates.Idle)) {
            // other states unexpected
        }
        if (p2.fsm.isInState(PlayerStates.Idle)) dropToIdle++;
        // p1 should stay chasing (primary / sticky)
        assert.ok(
            p1.fsm.isInState(PlayerStates.ChaseBall) || p1.fsm.isInState(PlayerStates.Idle),
            'p1 valid state'
        );
    }
    // With hysteresis, p2 should not thrash to Idle every other frame while inside release
    // (still inside release when at prox*0.9 + small)
    assert.ok(dropToIdle < 10, `p2 should not Idle-thrash (Idle counts=${dropToIdle}/20)`);
    log('PASS loose chase release hysteresis');
}

async function main() {
    await testActiveMarkerStickiness();
    await testLooseChaseReleaseHysteresis();
    log('chase_stickiness: ALL PASS');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
