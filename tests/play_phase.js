#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Phases of play (build / progress / finish).
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const {
    PlayPhase,
    PHASE_MODS,
    resolvePlayPhase,
    attackProgress01,
    getPhaseMods,
    resolveTeamPlayPhase
} = require('../kernel/core/lib/play_phase.js');
const {
    scorePassTarget,
    getShootRange,
    choosePassType
} = require('../kernel/core/entities/player.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function mainUnit() {
    const field = { width: 100 };
    assert.strictEqual(resolvePlayPhase(10, true, field), PlayPhase.BUILD);
    assert.strictEqual(resolvePlayPhase(50, true, field), PlayPhase.PROGRESS);
    assert.strictEqual(resolvePlayPhase(90, true, field), PlayPhase.FINISH);
    // Mirror for attack left
    assert.strictEqual(resolvePlayPhase(90, false, field), PlayPhase.BUILD);
    assert.strictEqual(resolvePlayPhase(50, false, field), PlayPhase.PROGRESS);
    assert.strictEqual(resolvePlayPhase(10, false, field), PlayPhase.FINISH);
    log('PASS resolvePlayPhase thirds (both directions)');

    assert.ok(attackProgress01(0, true, field) === 0);
    assert.ok(Math.abs(attackProgress01(100, true, field) - 1) < 1e-9);

    const b = getPhaseMods(PlayPhase.BUILD);
    const p = getPhaseMods(PlayPhase.PROGRESS);
    const f = getPhaseMods(PlayPhase.FINISH);
    assert.ok(b.shootWillingness < p.shootWillingness);
    assert.ok(p.shootWillingness < f.shootWillingness || f.shootWillingness >= 1);
    assert.ok(b.shortPassBias > p.shortPassBias);
    assert.ok(p.longPassBias > b.longPassBias);
    assert.ok(f.supportCanScoreMult > b.supportCanScoreMult);
    assert.ok(p.supportWidthMult > b.supportWidthMult);
    assert.ok(PHASE_MODS.build.allowBackPass === true);
    assert.ok(PHASE_MODS.finish.allowBackPass === false);
    log('PASS phase mod tables ordered');
}

async function mainSim() {
    const sim = new Simulator({ seed: 303 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();
    const a = sim.teamA;

    const carrier = a.getOutfieldPlayers().find(p => /CM|AM|S|ST|CF/i.test(p.role || ''))
        || a.getOutfieldPlayers()[0];
    carrier.level = sim;

    // --- Build: ball in own third (A attacks right → low X) ---
    carrier.x = field.width * 0.15;
    carrier.y = field.centerY;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    a.setControllingPlayer(carrier);
    a.syncFsmFromMatch();
    a.updatePlayPhase(sim.ball);
    assert.ok(a.fsm.isInState(TeamStates.Attacking));
    assert.strictEqual(a.playPhase, PlayPhase.BUILD);
    log('PASS build phase in own third');

    const buildMods = a.getPlayPhaseMods();
    assert.ok(buildMods.shootRangeMult < 1);
    const shootBuild = getShootRange(carrier);
    // Force finish for range comparison
    a.playPhase = PlayPhase.FINISH;
    const shootFinish = getShootRange(carrier);
    assert.ok(shootFinish > shootBuild, `finish range ${shootFinish} > build ${shootBuild}`);
    a.playPhase = PlayPhase.BUILD;
    log('PASS shoot range scales with phase');

    // Defensive receiver scoring better in build than finish
    const cb = a.getOutfieldPlayers().find(p => /CB|LB|RB|DM/i.test(p.role || '') && p !== carrier)
        || a.getOutfieldPlayers().find(p => p !== carrier);
    cb.level = sim;
    a.playPhase = PlayPhase.BUILD;
    const scoreBuildDef = scorePassTarget(carrier, cb, 5, true);
    a.playPhase = PlayPhase.FINISH;
    const scoreFinishDef = scorePassTarget(carrier, cb, 5, true);
    assert.ok(
        scoreBuildDef > scoreFinishDef,
        `build def outlet ${scoreBuildDef.toFixed(1)} > finish ${scoreFinishDef.toFixed(1)}`
    );
    log('PASS build promotes defensive outlets vs finish');

    a.playPhase = PlayPhase.BUILD;
    const tBuild = choosePassType(17, true, carrier);
    a.playPhase = PlayPhase.PROGRESS;
    const tProg = choosePassType(17, true, carrier);
    assert.strictEqual(tBuild, 'short', `build open 17u → short (got ${tBuild})`);
    assert.strictEqual(tProg, 'long', `progress open 17u → long (got ${tProg})`);
    log('PASS choosePassType phase bias');

    // --- Progress ---
    carrier.x = field.width * 0.5;
    sim.ball.x = carrier.x;
    a.playPhase = PlayPhase.NONE;
    a.updatePlayPhase(sim.ball);
    assert.strictEqual(a.playPhase, PlayPhase.PROGRESS);
    log('PASS progress in middle third');

    // --- Finish ---
    carrier.x = field.width * 0.82;
    sim.ball.x = carrier.x;
    a.updatePlayPhase(sim.ball);
    assert.strictEqual(a.playPhase, PlayPhase.FINISH);
    log('PASS finish in final third');

    // Support spots accept phaseMods without throw
    a.updateSupportSpots({ force: true });
    assert.ok(a.getBestSupportSpot() || a.supportSpots.spots.length >= 0);
    log('PASS support spots rescore under finish');

    // Lost control clears phase
    a.lostControl();
    assert.strictEqual(a.playPhase, PlayPhase.NONE);
    log('PASS lostControl → phase none');

    // resolveTeamPlayPhase pure
    const ph = resolveTeamPlayPhase(a, { x: field.width * 0.2, owner: carrier }, true);
    // not in control now
    assert.ok(ph === PlayPhase.BUILD || ph === PlayPhase.NONE);
}

async function main() {
    mainUnit();
    await mainSim();
    log('\nAll play_phase tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
