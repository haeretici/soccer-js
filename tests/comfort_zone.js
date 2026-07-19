#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Comfort zone / isThreatened — data-driven pass bias when pressured.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    isThreatened,
    getThreatInfo,
    getComfortZoneRadii,
    computeDribblePassChance
} = require('../kernel/core/entities/player.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const radii = getComfortZoneRadii({ team: 'A' });
    assert.ok(radii.comfort > 0);
    assert.ok(radii.pressure >= radii.comfort);
    assert.strictEqual(radii.comfort, Settings.AI.PLAYER_COMFORT_ZONE);
    log('PASS getComfortZoneRadii from Settings');

    const sim = new Simulator({ seed: 42 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const carrier = sim.teamA.getOutfieldPlayers().find(p => p.role !== 'GK') || sim.teamA.players[1];
    const opp = sim.teamB.getOutfieldPlayers()[0];
    assert.ok(carrier && opp);

    // Park all B outfielders far away so only our placed opp matters
    for (const p of sim.teamB.getOutfieldPlayers()) {
        p.x = 2;
        p.y = 2;
    }

    // Far: not threatened
    carrier.x = 40;
    carrier.y = 25;
    opp.x = 10;
    opp.y = 10;
    let info = getThreatInfo(carrier);
    assert.ok(info.dist > info.comfortZone, `far dist=${info.dist} comfort=${info.comfortZone}`);
    assert.ok(!info.threatened);
    assert.ok(!isThreatened(carrier));
    log('PASS far opponent not threatened');

    // Inside comfort zone
    opp.x = carrier.x + 1.0;
    opp.y = carrier.y;
    info = getThreatInfo(carrier);
    assert.ok(info.threatened, 'close opponent threatens');
    assert.ok(info.underPressure);
    assert.ok(isThreatened(carrier));
    assert.ok(sim.teamA.isPlayerThreatened(carrier));
    log('PASS isThreatened / Team.isPlayerThreatened');

    // Pass chance: threatened > pressure > free
    Settings.AI.PASS_AGGRESSION = 1.0;
    const chanceThreat = computeDribblePassChance(carrier, info);
    const chancePressure = computeDribblePassChance(carrier, {
        dist: (info.comfortZone + info.pressureZone) * 0.5,
        comfortZone: info.comfortZone,
        pressureZone: info.pressureZone,
        threatened: false,
        underPressure: true
    });
    const chanceFree = computeDribblePassChance(carrier, {
        dist: 20,
        comfortZone: info.comfortZone,
        pressureZone: info.pressureZone,
        threatened: false,
        underPressure: false
    });
    assert.ok(chanceThreat > chancePressure, `threat ${chanceThreat} > pressure ${chancePressure}`);
    assert.ok(chancePressure > chanceFree, `pressure ${chancePressure} > free ${chanceFree}`);
    log('PASS computeDribblePassChance prefers pass when threatened');

    // Numeric distance API (legacy call sites)
    assert.ok(computeDribblePassChance(carrier, 1.0) > computeDribblePassChance(carrier, 10));
    log('PASS distance-number API still works');

    // Custom comfort radius
    Settings.AI.PLAYER_COMFORT_ZONE = 8;
    opp.x = carrier.x + 5;
    opp.y = carrier.y;
    assert.ok(isThreatened(carrier), 'custom larger comfort zone');
    Settings.AI.PLAYER_COMFORT_ZONE = 3.0;
    log('PASS PLAYER_COMFORT_ZONE override');

    // Debug flag sets highlight fields when computing chance
    Settings.AI.DEBUG_HIGHLIGHT_THREATENED = true;
    carrier.debugThreatened = false;
    computeDribblePassChance(carrier, getThreatInfo(carrier));
    // threatened with opp at +1
    opp.x = carrier.x + 0.5;
    computeDribblePassChance(carrier);
    assert.strictEqual(carrier.debugThreatened, true);
    Settings.AI.DEBUG_HIGHLIGHT_THREATENED = false;
    log('PASS DEBUG_HIGHLIGHT_THREATENED flag');

    log('\nAll comfort zone / isThreatened tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
