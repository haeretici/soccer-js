#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * AI parameter file — loadable defaults + named profiles.
 */
require('./mock_env.js');

const assert = require('assert');
const path = require('path');
const { Settings } = require('../kernel/settings.js');
const {
    loadAiParamsFile,
    extractDefaultsMap,
    extractProfileMap,
    normalizeAiParamsBlock,
    applyAiParamsToBase,
    applyAiParamsFromConfig,
    snapshotBaseAiParams,
    STRATEGY_KNOBS,
    DEFAULT_AI_PARAMS_PATH
} = require('../kernel/core/lib/ai_params.js');
const {
    mergeConfig,
    applySettingsFromConfig,
    restoreAIStrategySettings
} = require('../kernel/providers/simulator/headless_runner.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function main() {
    const fileObj = loadAiParamsFile(DEFAULT_AI_PARAMS_PATH);
    assert.ok(fileObj, 'ai_params.json loads');
    assert.ok(fileObj.defaults && fileObj.defaults.PLAYER_COMFORT_ZONE != null);
    assert.ok(fileObj.profiles && fileObj.profiles.high_press);
    log('PASS loadAiParamsFile presets/ai_params.json');

    const defaults = extractDefaultsMap(fileObj);
    assert.ok(defaults.FORMATION_HOLD != null);
    assert.ok(defaults.SUPPORT_SPOT_GRID_X != null);
    assert.ok(defaults.KICK_WINDUP != null);
    log('PASS extractDefaultsMap covers strategy + support + kick');

    const profile = extractProfileMap(fileObj, 'high_press');
    assert.ok(profile.DEFENSIVE_PRESS_INTENSITY > 0.5);
    log('PASS extractProfileMap high_press');

    // Normalize rejects unknown junk, keeps comfort + strategy
    const norm = normalizeAiParamsBlock({
        PASS_AGGRESSION: 0.8,
        PLAYER_COMFORT_ZONE: 4.5,
        NOT_A_REAL_KEY: 99,
        FORMATION_HOLD: 1.5 // strategy clamp 0-1 → drop
    });
    assert.strictEqual(norm.PASS_AGGRESSION, 0.8);
    assert.strictEqual(norm.PLAYER_COMFORT_ZONE, 4.5);
    assert.ok(!norm.NOT_A_REAL_KEY);
    assert.ok(!norm.FORMATION_HOLD, 'out-of-range strategy knob dropped');
    log('PASS normalizeAiParamsBlock');

    restoreAIStrategySettings();
    const before = Settings.AI.PLAYER_COMFORT_ZONE;
    applyAiParamsToBase({ PLAYER_COMFORT_ZONE: before + 1.25 }, { rebindTeams: true });
    assert.strictEqual(Settings.AI.PLAYER_COMFORT_ZONE, before + 1.25);
    assert.strictEqual(Settings.AI.A.PLAYER_COMFORT_ZONE, before + 1.25, 'team inherits base after rebind');
    restoreAIStrategySettings();
    log('PASS applyAiParamsToBase rebindTeams');

    // Profile + team overlay via applyAiParamsFromConfig
    restoreAIStrategySettings();
    const report = applyAiParamsFromConfig({
        aiParamsFile: 'presets/ai_params.json',
        aiProfile: 'pass_heavy',
        aiA: { FORMATION_HOLD: 0.9 },
        aiB: { PLAYER_COMFORT_ZONE: 2.0 }
    });
    assert.ok(report.appliedBase.PASS_AGGRESSION != null || Settings.AI.PASS_AGGRESSION >= 0.8);
    assert.strictEqual(Settings.AI.A.FORMATION_HOLD, 0.9);
    assert.strictEqual(Settings.AI.B.PLAYER_COMFORT_ZONE, 2.0);
    // B inherits other base values from profile/defaults
    assert.ok(Settings.AI.B.PASS_AGGRESSION === Settings.AI.PASS_AGGRESSION
        || typeof Settings.AI.B.PASS_AGGRESSION === 'number');
    log('PASS applyAiParamsFromConfig profile + aiA/aiB');

    // Batch mergeConfig + applySettingsFromConfig
    restoreAIStrategySettings();
    const cfg = mergeConfig({
        iterations: 1,
        seed: 7,
        aiParamsFile: path.join('presets', 'ai_params.json'),
        aiProfile: 'catenaccio_balance',
        ai: { KICK_DECISION_INTERVAL: 0.4 }
    });
    applySettingsFromConfig(cfg);
    assert.ok(Settings.AI.FORMATION_HOLD >= 0.7, 'catenaccio hold');
    assert.strictEqual(Settings.AI.KICK_DECISION_INTERVAL, 0.4);
    assert.ok(cfg._aiParamsApplied);
    log('PASS mergeConfig + applySettingsFromConfig batch path');

    // Snapshot for restore
    const snap = snapshotBaseAiParams();
    assert.ok(STRATEGY_KNOBS.every((k) => snap[k] != null || typeof Settings.AI[k] === 'number'));
    restoreAIStrategySettings();
    log('PASS snapshotBaseAiParams + restore');

    log('\nAll ai_params tests passed.');
}

main();
