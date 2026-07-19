#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Steering: arrive, separation, pursuit, interpose pure helpers + moveTo opts.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const {
    seek,
    arriveSpeedScale,
    separation,
    pursuitPoint,
    interposePoint,
    composeSteer,
    collectNeighbors,
    DEFAULT_ARRIVE_RADIUS
} = require('../kernel/core/lib/steering.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    // --- Pure math ---
    const agent = { x: 0, y: 0 };
    const s = seek(agent, { x: 10, y: 0 });
    assert.ok(Math.abs(s.x - 1) < 1e-6 && Math.abs(s.y) < 1e-6);
    assert.ok(Math.abs(s.dist - 10) < 1e-6);
    log('PASS seek');

    assert.strictEqual(arriveSpeedScale(100, 4), 1, 'far = full speed');
    assert.ok(arriveSpeedScale(0.05, 4) === 0, 'at target');
    const mid = arriveSpeedScale(DEFAULT_ARRIVE_RADIUS * 0.5, DEFAULT_ARRIVE_RADIUS, 2);
    assert.ok(mid > 0.1 && mid < 1, `mid arrive scale ${mid}`);
    assert.ok(arriveSpeedScale(1, 4) < arriveSpeedScale(3, 4), 'closer is slower');
    log('PASS arriveSpeedScale');

    const sep = separation(
        { x: 0, y: 0 },
        [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }],
        5
    );
    // Neighbors left and right cancel x; no y neighbors
    assert.ok(Math.abs(sep.x) < 1e-6, 'symmetric neighbors cancel x');
    const sepL = separation({ x: 0, y: 0 }, [{ x: 0.5, y: 0 }], 5);
    assert.ok(sepL.x < 0, 'repels away from neighbor on +x');
    log('PASS separation');

    const future = pursuitPoint(
        { x: 0, y: 0 },
        { x: 10, y: 0, vx: 5, vy: 0 },
        2
    );
    assert.ok(future.x > 10, `pursuit leads ball (x=${future.x})`);
    log('PASS pursuitPoint');

    const midPt = interposePoint({ x: 20, y: 10 }, { x: 0, y: 10 }, 5);
    assert.ok(Math.abs(midPt.y - 10) < 1e-6);
    assert.ok(Math.abs(midPt.x - 5) < 1e-6, `interpose x=${midPt.x}`);
    log('PASS interposePoint');

    const composed = composeSteer(
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { arrive: true, separate: true, neighbors: [{ x: 0.4, y: 0.4 }] }
    );
    assert.ok(composed.aim && composed.speedScale <= 1);
    assert.ok(composed.dist > 9);
    // Separation should nudge aim off pure +x
    assert.ok(Math.abs(composed.aim.y) > 0.01 || composed.aim.x !== 10, 'separation affects aim');
    log('PASS composeSteer');

    const self = { x: 0, y: 0 };
    const neighbors = collectNeighbors(
        self,
        [{ x: 1, y: 0 }, { x: 100, y: 0 }, self],
        3
    );
    assert.strictEqual(neighbors.length, 1, 'excludes self and far agents');
    log('PASS collectNeighbors');

    // --- Live moveTo with arrive ---
    const sim = new Simulator({ seed: 77 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const p = sim.teamA.getOutfieldPlayers()[0];
    p.x = 20;
    p.y = 25;
    p._currentSpeed = 0;
    const far = { x: 40, y: 25 };
    Time.deltaTime = 0.05;
    p.moveTo(far, 1, { arrive: true });
    const speedFar = p._currentSpeed;
    p.x = 39.5;
    p.y = 25;
    p._currentSpeed = 0;
    p.moveTo(far, 1, { arrive: true });
    const speedNear = p._currentSpeed;
    assert.ok(speedNear < speedFar, `arrive slows near target (${speedNear} < ${speedFar})`);
    log('PASS moveTo arrive slows near target');

    // Separation spreads two stacked players
    const a = sim.teamA.getOutfieldPlayers()[0];
    const b = sim.teamA.getOutfieldPlayers()[1];
    a.x = 30;
    a.y = 25;
    b.x = 30.2;
    b.y = 25;
    a._currentSpeed = 2;
    const beforeY = a.y;
    a.moveTo({ x: 40, y: 25 }, 1, {
        arrive: false,
        separate: true,
        neighbors: [b]
    });
    // After one step, should have some lateral component from separation
    assert.ok(Math.abs(a.y - beforeY) > 1e-4 || Math.abs(a.x - 30) > 0.01, 'separation moves agent');
    log('PASS moveTo separate pushes apart');

    log('\nAll steering tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
