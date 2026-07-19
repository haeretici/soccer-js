#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Pitch regions + dynamic home regions on Team attack/defense.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const {
    createPitchRegions,
    gridSize,
    regionContaining,
    computeHomeFromRegion,
    bindPlayerHomeRegion,
    POSTURE_REGION_COL_DELTA,
    DEFAULT_COLS,
    DEFAULT_ROWS
} = require('../kernel/core/lib/pitch_regions.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const field = Utils.getFieldBounds();
    const regions = createPitchRegions(field, DEFAULT_COLS, DEFAULT_ROWS);
    assert.strictEqual(regions.length, DEFAULT_COLS * DEFAULT_ROWS);
    const gs = gridSize(regions);
    assert.strictEqual(gs.cols, DEFAULT_COLS);
    assert.strictEqual(gs.rows, DEFAULT_ROWS);
    // Centers cover field
    assert.ok(regions[0].centerX > 0 && regions[0].centerX < field.width);
    log('PASS createPitchRegions grid');

    const mid = regionContaining(field.centerX, field.centerY, regions);
    assert.ok(mid);
    assert.ok(mid.left <= field.centerX && mid.right >= field.centerX);
    log('PASS regionContaining');

    // Fine offset preserved under column shift
    const player = {
        role: 'CM',
        formationBaseX: mid.centerX + 1.5,
        formationBaseY: mid.centerY - 0.8,
        baseX: mid.centerX + 1.5,
        baseY: mid.centerY - 0.8
    };
    bindPlayerHomeRegion(player, regions);
    assert.strictEqual(player.defaultRegionId, mid.id);
    assert.ok(Math.abs(player.regionFineOffsetX - 1.5) < 1e-6);
    assert.ok(Math.abs(player.regionFineOffsetY - (-0.8)) < 1e-6);

    const atk = computeHomeFromRegion(player, regions, 'attacking', true);
    assert.ok(atk);
    assert.ok(atk.region.ix >= mid.ix, 'attack shifts right when attacksRight');
    assert.ok(Math.abs((atk.baseX - atk.region.centerX) - 1.5) < 1e-6, 'fine offset kept');

    const def = computeHomeFromRegion(player, regions, 'defending', true);
    assert.ok(def.region.ix <= mid.ix, 'defend shifts left when attacksRight');
    assert.ok(POSTURE_REGION_COL_DELTA.attacking === 1);
    assert.ok(POSTURE_REGION_COL_DELTA.defending === -1);
    log('PASS computeHomeFromRegion column shift + fine offset');

    // --- Live Team ---
    const sim = new Simulator({ seed: 101 });
    await sim.start();
    assert.ok(sim.pitch && sim.pitch.regions && sim.pitch.regions.length > 0);
    assert.strictEqual(typeof sim.pitch.ensureRegions, 'function');
    assert.ok(sim.pitch.getRegionFromIndex(0));

    const a = sim.teamA;
    const outfield = a.getOutfieldPlayers();
    assert.ok(outfield.length >= 5);
    for (const p of outfield) {
        assert.ok(p.formationBaseX != null, 'formationBase stored');
        assert.ok(p.defaultRegionId != null, 'default region bound');
        assert.ok(typeof p.regionFineOffsetX === 'number');
    }
    log('PASS players bound to default regions at bootstrap');

    // Capture bases in kickoff posture then force attack/defend
    const sample = outfield.find(p => /CM|S|ST|CF|AM/i.test(p.role || '')) || outfield[0];
    a.applyPosture('kickoffprepare');
    const baseKick = sample.baseX;
    const regionKick = sample.homeRegionId;

    a.applyPosture('attacking');
    const baseAtk = sample.baseX;
    const regionAtk = sample.homeRegionId;
    // Team A 1st half attacks right — attacking base should not be left of kickoff
    assert.ok(baseAtk >= baseKick - 0.01 || regionAtk !== regionKick,
        `attack should push home (kick=${baseKick} atk=${baseAtk})`);

    a.applyPosture('defending');
    const baseDef = sample.baseX;
    assert.ok(baseDef <= baseAtk + 0.01, `defend home left of attack (def=${baseDef} atk=${baseAtk})`);
    log('PASS Team applyPosture shifts home bases via regions');

    // Possession-driven FSM still applies posture (attacking when in control)
    const carrier = outfield[0];
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.ball.owner = carrier;
    a.setControllingPlayer(carrier);
    a.syncFsmFromMatch();
    assert.ok(a.fsm.isInState(TeamStates.Attacking));
    assert.strictEqual(a.postureName, 'attacking');
    log('PASS Attacking posture + regions when in control');

    // recalculateReferencePositions rebinds
    const formName = a.formationName || sim.formationAName;
    const formation = sim.formationsPreset[formName];
    const oldFine = sample.regionFineOffsetX;
    a.recalculateReferencePositions(formation);
    assert.ok(sample.defaultRegionId != null);
    // fine offset may change if formation base changes cell — just ensure defined
    assert.ok(typeof sample.regionFineOffsetX === 'number');
    void oldFine;
    log('PASS recalculateReferencePositions rebinds regions');

    log('\nAll pitch region tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
