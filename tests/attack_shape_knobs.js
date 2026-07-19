#!/usr/bin/env node
/**
 * Attack shape Engine Tweakings knobs — live posture, support form pull, archetype isolation.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { computeAttackSupportTarget } = require('../kernel/core/entities/player.js');
const {
    ALL_UI_KNOBS,
    STRATEGY_KNOBS,
    isValidKnobValue
} = require('../kernel/core/lib/ai_ui_knobs.js');

function log(...args) {
    if (process.env.VERBOSE) console.log(...args);
}

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;

async function main() {
    assert.ok(ALL_UI_KNOBS.length >= 11, 'UI knobs registered');
    assert.ok(STRATEGY_KNOBS.length === 4, 'four strategy knobs');
    assert.ok(isValidKnobValue('ATTACK_DEPTH_BIAS_REF', 7.5));
    assert.ok(!isValidKnobValue('ATTACK_DEPTH_BIAS_REF', 99));
    log('PASS ai_ui_knobs metadata');

    const sim = new Simulator({ seed: 55 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    const a = sim.teamA;
    const field = Utils.getFieldBounds();
    assert.ok(a && field);

    a.fsm.changeState(TeamStates.Attacking);
    assert.strictEqual(a.depthBiasRef, Settings.AI.ATTACK_DEPTH_BIAS_REF, 'default attack depth');
    assert.strictEqual(a.homeRegionColumnDelta, Settings.AI.ATTACK_REGION_COL_DELTA, 'default region shift');
    log('PASS default attack posture');

    sim.updateBaseStrategyValue('A', 'ATTACK_DEPTH_BIAS_REF', 18);
    sim.updateBaseStrategyValue('A', 'ATTACK_REGION_COL_DELTA', 2);
    sim.updateBaseStrategyValue('A', 'ATTACK_ROLE_REGION_BIAS', 2);
    assert.strictEqual(Settings.AI.A.ATTACK_DEPTH_BIAS_REF, 18);
    assert.strictEqual(a.depthBiasRef, 18, 'live depth via updateBaseStrategyValue');
    assert.strictEqual(a.homeRegionColumnDelta, 2, 'live region via updateBaseStrategyValue');
    log('PASS live posture refresh');

    const carrier = a.getOutfieldPlayers()[0];
    const mate = a.getOutfieldPlayers()[1];
    sim.ball.owner = carrier;
    carrier.x = field.width * 0.25;
    carrier.y = field.centerY;
    Settings.AI.A.ATTACK_SUPPORT_FORM_PULL = 1;
    const t1 = computeAttackSupportTarget(mate, carrier, sim);
    Settings.AI.A.ATTACK_SUPPORT_FORM_PULL = 0.1;
    const t2 = computeAttackSupportTarget(mate, carrier, sim);
    assert.ok(
        Math.abs(t2.x - t1.x) > 0.5 || Math.abs(t2.y - t1.y) > 0.5,
        'form pull changes support target'
    );
    log('PASS ATTACK_SUPPORT_FORM_PULL');

    const beforeDepth = Settings.AI.A.ATTACK_DEPTH_BIAS_REF;
    sim.applyStrategyOverride('A', 'catenaccio');
    assert.strictEqual(Settings.AI.A.ATTACK_DEPTH_BIAS_REF, beforeDepth, 'late-game shift keeps shape knobs');
    assert.ok(Settings.AI.A.FORMATION_HOLD > 0.7, 'catenaccio sets hold');
    log('PASS dynamic strategy shift does not wipe shape');

    const {
        getArchetypeFullValues,
        getArchetypeValues,
        matchArchetype
    } = require('../kernel/core/lib/ai_archetypes.js');
    const fullCat = getArchetypeFullValues('catenaccio');
    assert.ok(fullCat && typeof fullCat.ATTACK_DEPTH_BIAS_REF === 'number', 'full preset has shape');
    assert.ok(fullCat.ATTACK_DEPTH_BIAS_REF < 8, 'catenaccio deep attack line');
    const stratOnly = getArchetypeValues('gegenpressing');
    assert.ok(stratOnly.DEFENSIVE_PRESS_INTENSITY >= 0.85);
    assert.strictEqual(stratOnly.ATTACK_DEPTH_BIAS_REF, undefined, 'strategy-only has no shape key');
    const matched = matchArchetype(fullCat);
    assert.strictEqual(matched, 'catenaccio', 'full values match preset');
    log('PASS getArchetypeFullValues / matchArchetype');

    const cfg = sim.captureReplayConfig();
    assert.strictEqual(cfg.aiA.ATTACK_DEPTH_BIAS_REF, 18);
    assert.ok(typeof cfg.aiA.ATTACK_SUPPORT_OWN_HALF_BLEND === 'number');
    assert.ok(typeof cfg.aiA.SUPPORT_WIDTH === 'number');
    log('PASS captureReplayConfig includes shape knobs');

    console.log('All attack_shape_knobs tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
