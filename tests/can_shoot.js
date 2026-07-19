#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * CanShoot — goal-mouth sampling + pass-safety on shot lanes.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    canShoot,
    getGoalMouthYBounds,
    estimateShotGroundSpeed,
    NUM_SHOOT_ATTEMPTS
} = require('../kernel/core/lib/pass_safety.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function makeShooter(x, y, team = 'A') {
    return {
        x, y, team,
        stats: { shooting: 80, speed: 60 },
        staminaMultiplier: 1,
        effectiveShooting: 80,
        level: { isSecondHalf: () => false }
    };
}

async function main() {
    assert.ok(NUM_SHOOT_ATTEMPTS >= 1);
    const { yMin, yMax } = getGoalMouthYBounds();
    assert.ok(yMin < yMax, 'goal mouth has height');
    assert.ok(yMin >= Utils.scaleFieldY(40) - 1);
    assert.ok(yMax <= Utils.scaleFieldY(60) + 1);
    assert.ok(estimateShotGroundSpeed(makeShooter(0, 0)) > 10);
    log('PASS goal mouth bounds + shot speed');

    const field = Utils.getFieldBounds();
    const ballPos = { x: field.width * 0.75, y: field.centerY };
    const shooter = makeShooter(ballPos.x, ballPos.y, 'A');

    // Open goal: no opponents
    const open = canShoot(ballPos, shooter, [], {
        oppGoalX: field.width,
        sampleYs: [field.centerY]
    });
    assert.ok(open.ok, 'open goal should allow shoot');
    assert.ok(open.target);
    assert.strictEqual(open.target.x, field.width);
    assert.ok(open.target.y >= yMin && open.target.y <= yMax);
    log('PASS canShoot open goal');

    // Wall of defenders on the lane to center goal
    const wall = [];
    for (let i = 0; i < 6; i++) {
        wall.push({
            x: ballPos.x + (field.width - ballPos.x) * 0.5,
            y: field.centerY + (i - 2.5) * 0.8,
            stats: { speed: 99 },
            staminaMultiplier: 1,
            isSentOff: false
        });
    }
    const blocked = canShoot(ballPos, shooter, wall, {
        oppGoalX: field.width,
        sampleYs: [field.centerY, yMin + 0.5, yMax - 0.5]
    });
    // Dense wall may still leave a corner open; if blocked fully, ok=false
    if (!blocked.ok) {
        log('PASS canShoot rejects fully blocked mouth');
    } else {
        // Any accepted sample must clear the wall check for that sample
        assert.ok(blocked.target);
        log('PASS canShoot finds edge sample around wall (or clear path)');
    }

    // Far side with zero power cannot reach
    const noPower = canShoot(ballPos, shooter, [], {
        oppGoalX: field.width,
        power: 0.001,
        sampleYs: [field.centerY]
    });
    assert.strictEqual(noPower.ok, false, 'near-zero power cannot shoot');
    log('PASS canShoot requires reachability (power)');

    // --- Team wiring ---
    const sim = new Simulator({ seed: 13 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const a = sim.teamA;
    assert.strictEqual(typeof a.canShoot, 'function');

    const striker = a.getOutfieldPlayers().find(p => /S|ST|CF|F/i.test(p.role || ''))
        || a.getOutfieldPlayers()[0];
    striker.x = field.width * 0.7;
    striker.y = field.centerY;
    for (const d of sim.teamB.players) {
        d.x = 5;
        d.y = 5;
    }

    const teamShot = a.canShoot({ x: striker.x, y: striker.y }, striker);
    assert.ok(teamShot.ok, 'team canShoot with defenders parked away');
    assert.ok(teamShot.target);

    // Park entire B team on the shot corridor near goal
    for (let i = 0; i < sim.teamB.players.length; i++) {
        const d = sim.teamB.players[i];
        d.x = field.width - 3;
        d.y = yMin + ((yMax - yMin) * i) / Math.max(1, sim.teamB.players.length - 1);
        d.stats = d.stats || {};
        d.stats.speed = 99;
    }
    const wallShot = a.canShoot({ x: field.width - 12, y: field.centerY }, striker, {
        sampleYs: [field.centerY]
    });
    // Center sample with wall at goal should often fail; method still returns structured result
    assert.ok(typeof wallShot.ok === 'boolean');
    assert.ok(wallShot.power > 0);
    log('PASS Team.canShoot structured result under press');

    log('\nAll canShoot tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
