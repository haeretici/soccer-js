#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * A.4 Counterpress & transition windows — surge after loss of possession.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;
Settings.AI.COUNTERPRESS_DURATION = 4.0;
Settings.AI.COUNTERPRESS_MAX_SURGE = 3;
Settings.AI.COUNTERPRESS_SECONDARY_DIST = 14;



async function main() {
    const sim = new Simulator({ seed: 404 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();

    const a = sim.teamA;
    const b = sim.teamB;

    // First touch: A takes ball — B never had possession → no counterpress
    const carrier = a.getOutfieldPlayers()[0];
    carrier.x = field.width * 0.55;
    carrier.y = field.centerY;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    a.setControllingPlayer(carrier);
    a.syncFsmFromMatch();
    b.syncFsmFromMatch();
    assert.ok(a.fsm.isInState(TeamStates.Attacking));
    assert.ok(b.fsm.isInState(TeamStates.Defending));
    assert.strictEqual(b.transitionTimer, 0, 'no counterpress without prior possession');
    log('PASS first possession does not counterpress the other team');

    // True turnover: B had the ball, then A steals → B counterpresses
    const bCarrier = b.getOutfieldPlayers()[0];
    bCarrier.x = field.width * 0.62;
    bCarrier.y = field.centerY;
    sim.ball.owner = bCarrier;
    sim.ball.x = bCarrier.x;
    sim.ball.y = bCarrier.y;
    b.setControllingPlayer(bCarrier);
    a.syncFsmFromMatch();
    b.syncFsmFromMatch();
    assert.ok(b.fsm.isInState(TeamStates.Attacking));
    // A just lost the ball → A counterpresses
    assert.ok(a.isCounterpressing(), `A transitionTimer=${a.transitionTimer}`);
    assert.ok(a.transitionTimer > 3.5 && a.transitionTimer <= 4.01);
    log('PASS turnover arms counterpress on the team that lost the ball');

    // Delayed region drop on Defending enter
    assert.strictEqual(a.homeRegionColumnDelta, 0, 'delay drop: no deep region column yet');
    log('PASS counterpress Defending enter uses delayRegionDrop');

    // Park A outfield near B carrier so surge can pick 2–3
    const aOut = a.getOutfieldPlayers();
    for (let i = 0; i < aOut.length; i++) {
        aOut[i].x = bCarrier.x - 2 - i * 0.8;
        aOut[i].y = bCarrier.y + (i - 2) * 1.5;
    }
    const canChase = (p) => p && !p.isSentOff && p.role !== 'GK';
    const surge = a.getPressChasers(bCarrier, canChase);
    assert.ok(surge.length >= 2, `surge count ${surge.length}`);
    assert.ok(surge.length <= 3, `surge capped ${surge.length}`);
    assert.ok(a.counterpressSurge.length >= 2);
    log(`PASS counterpress surge pressers=${surge.length}`);

    const nonSurge = aOut.find(p => !a.isCounterpressSurge(p));
    assert.ok(nonSurge, 'have non-surge player');
    nonSurge.level = sim;

    // Tick timer to expiry
    let steps = 0;
    while (a.isCounterpressing() && steps < 200) {
        a.tickCounterpress(0.05);
        steps++;
    }
    assert.strictEqual(a.isCounterpressing(), false);
    assert.ok(a.homeRegionColumnDelta < 0, 'full defend column shift after window');
    log('PASS timer expiry resumes full defending posture');

    const normal = a.getPressChasers(bCarrier, canChase);
    assert.ok(normal.length <= 3);
    log(`PASS normal press count=${normal.length}`);

    // Regain ball clears counterpress on that team
    a.beginCounterpress(4);
    assert.ok(a.isCounterpressing());
    a.setControllingPlayer(aOut[0]);
    assert.strictEqual(a.transitionTimer, 0);
    log('PASS setControllingPlayer clears own counterpress');

    // Explicit lostControl after having control arms timer
    a.lostControl();
    assert.ok(a.isCounterpressing());
    log('PASS lostControl() after possession arms transitionTimer');

    // depth offset milder with delayRegionDrop
    a.beginCounterpress(4);
    a.applyPosture('defending', { delayRegionDrop: true });
    const depthDelay = Math.abs(a.getDepthWorldOffset(nonSurge));
    a.transitionTimer = 0;
    a.applyPosture('defending');
    const depthFull = Math.abs(a.getDepthWorldOffset(nonSurge));
    assert.ok(
        depthDelay <= depthFull + 1e-6,
        `delay depth ${depthDelay.toFixed(2)} ≤ full ${depthFull.toFixed(2)}`
    );
    log('PASS delay drop uses shallower depth bias');

    log('\nAll counterpress tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
