#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * AI debug overlays — flags, HEADLESS skip, draw no-ops when off.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const {
    ensureDebugAI,
    isAiDebugActive,
    drawAiDebugOverlays,
    DEBUG_AI_DEFAULTS
} = require('../kernel/core/lib/ai_debug_draw.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };



function makeMockG() {
    const calls = [];
    const g = {
        calls,
        save() { calls.push('save'); },
        restore() { calls.push('restore'); },
        beginPath() { calls.push('beginPath'); },
        arc() { calls.push('arc'); },
        fill() { calls.push('fill'); },
        stroke() { calls.push('stroke'); },
        moveTo() {},
        lineTo() {},
        closePath() {},
        fillText() { calls.push('fillText'); },
        strokeText() {},
        rect() {},
        fillRect() {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        globalAlpha: 1
    };
    return g;
}

async function main() {
    // Defaults off
    Settings.debugAI = Object.assign({}, DEBUG_AI_DEFAULTS);
    Settings.HEADLESS = false;
    assert.strictEqual(isAiDebugActive(), false);
    log('PASS defaults inactive');

    Settings.debugAI.enabled = true;
    Settings.debugAI.roles = true;
    assert.strictEqual(isAiDebugActive(), true);
    log('PASS enabled + layer active');

    Settings.HEADLESS = true;
    assert.strictEqual(isAiDebugActive(), false, 'HEADLESS disables overlays');
    log('PASS HEADLESS suppresses debug');

    Settings.HEADLESS = false;
    Settings.debugAI.enabled = true;
    Settings.debugAI.roles = false;
    Settings.debugAI.states = false;
    Settings.debugAI.supportSpots = false;
    Settings.debugAI.regions = false;
    Settings.debugAI.homeTargets = false;
    Settings.debugAI.threatened = false;
    Settings.debugAI.passLanes = false;
    Settings.debugAI.positionTrace = false;
    Settings.debugAI.marking = false;
    Settings.debugAI.playPhase = false;
    Settings.debugAI.freekickWall = false;
    assert.strictEqual(isAiDebugActive(), false, 'master on but no layers');
    log('PASS master alone not enough');

    Settings.debugAI.positionTrace = true;
    assert.strictEqual(isAiDebugActive(), true, 'positionTrace alone activates');
    Settings.debugAI.positionTrace = false;
    Settings.debugAI.marking = true;
    assert.strictEqual(isAiDebugActive(), true, 'marking alone activates');
    Settings.debugAI.marking = false;
    Settings.debugAI.playPhase = true;
    assert.strictEqual(isAiDebugActive(), true, 'playPhase alone activates');
    Settings.debugAI.playPhase = false;
    Settings.debugAI.freekickWall = true;
    assert.strictEqual(isAiDebugActive(), true, 'freekickWall alone activates');
    Settings.debugAI.freekickWall = false;
    Settings.debugAI.predictedPath = true;
    assert.strictEqual(isAiDebugActive(), true, 'predictedPath alone activates');
    Settings.debugAI.predictedPath = false;
    Settings.debugAI.goalMouth = true;
    assert.strictEqual(isAiDebugActive(), true, 'goalMouth alone activates');
    Settings.debugAI.goalMouth = false;
    log('PASS positionTrace + marking + playPhase + freekickWall + predictedPath + goalMouth layer flags');

    // Draw with all layers: should call canvas ops
    const sim = new Simulator({ seed: 11 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    Settings.HEADLESS = false;
    Settings.debugAI = {
        enabled: true,
        supportSpots: true,
        regions: true,
        homeTargets: true,
        roles: true,
        states: true,
        threatened: true,
        passLanes: true,
        positionTrace: true,
        predictedPath: true,
        goalMouth: true
    };

    const g = makeMockG();
    drawAiDebugOverlays(g, sim);
    assert.ok(g.calls.includes('save'));
    assert.ok(g.calls.includes('restore'));
    assert.ok(g.calls.length > 4, `drew something (${g.calls.length} ops)`);
    log('PASS drawAiDebugOverlays issues canvas commands');

    // HEADLESS: no draw
    Settings.HEADLESS = true;
    const g2 = makeMockG();
    drawAiDebugOverlays(g2, sim);
    assert.strictEqual(g2.calls.length, 0);
    log('PASS no draw when HEADLESS');

    // Simulator.onGUI exists and respects HEADLESS
    Settings.HEADLESS = true;
    assert.strictEqual(typeof sim.onGUI, 'function');
    const g3 = makeMockG();
    sim.onGUI(g3);
    assert.strictEqual(g3.calls.length, 0);
    log('PASS Simulator.onGUI HEADLESS no-op');

    Settings.HEADLESS = false;
    Settings.debugAI.enabled = false;
    ensureDebugAI();
    assert.ok(Settings.debugAI);
    log('PASS ensureDebugAI');

    // Reset for other tests
    Settings.debugAI = Object.assign({}, DEBUG_AI_DEFAULTS);
    Settings.HEADLESS = true;

    log('\nAll AI debug draw tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
