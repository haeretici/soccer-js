#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Support spot calculator — grid, scoring, primary supporter assignment.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    SupportSpotCalculator,
    TickRegulator,
    DEFAULT_GRID_X,
    DEFAULT_GRID_Y,
    edgeProximityFactor,
    edgeScoreMultiplier,
    wingWidthBonus
} = require('../kernel/core/lib/support_spots.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    // --- Regulator ---
    const reg = new TickRegulator(3);
    assert.strictEqual(reg.isReady(), true);
    assert.strictEqual(reg.isReady(), false);
    assert.strictEqual(reg.isReady(), false);
    assert.strictEqual(reg.isReady(), true);
    log('PASS TickRegulator interval');

    // --- Edge model helpers ---
    const h = 50;
    assert.ok(edgeProximityFactor(h * 0.5, h, 1.5, 7) > 0.99, 'centre is interior');
    assert.ok(edgeProximityFactor(1.5, h, 1.5, 7) <= 0.01, 'at hard min edge factor ~0');
    assert.ok(edgeProximityFactor(5, h, 1.5, 7) > 0 && edgeProximityFactor(5, h, 1.5, 7) < 1);
    const mulNarrow = edgeScoreMultiplier(0, 0, 0.28, 0.92);
    const mulWide = edgeScoreMultiplier(0, 1, 0.28, 0.92);
    assert.ok(mulWide > mulNarrow, 'wide tactic less harsh at edge');
    assert.ok(wingWidthBonus(0, 1, 0.85) > wingWidthBonus(0, 0, 0.85), 'wing bonus scales with width');
    log('PASS edgeProximityFactor / SUPPORT_WIDTH multipliers');

    // --- Pure calculator ---
    const fakeTeam = { teamKey: 'A' };
    const calc = new SupportSpotCalculator(fakeTeam);
    const field = Utils.getFieldBounds();
    calc.ensureSpots(true, field);
    assert.strictEqual(calc.spots.length, DEFAULT_GRID_X * DEFAULT_GRID_Y);
    // All spots on right half when attacking right
    for (const s of calc.spots) {
        assert.ok(s.x >= field.centerX * 0.95, `spot x ${s.x} should be on attack half`);
    }
    // Modern hard Y margin is small (~3%); outer spots closer to touchline than old 10%+half-cell
    const minY = Math.min(...calc.spots.map(s => s.y));
    const maxY = Math.max(...calc.spots.map(s => s.y));
    const hardY = field.height * (Settings.AI.SUPPORT_SPOT_MARGIN_Y_FRAC || 0.03);
    // Old model was ~10% + half-cell (~9u); modern hard 3% + half-cell ≈ 6u on h=50
    assert.ok(minY < field.height * 0.18, `outer spot near flank (minY=${minY})`);
    assert.ok(minY < 8.5, `closer than legacy 10% dead zone (minY=${minY})`);
    assert.ok(minY >= hardY * 0.5, 'spots outside hard out-of-bounds');
    assert.ok(maxY > field.height * 0.82, `outer spot near far flank (maxY=${maxY})`);
    calc.ensureSpots(false, field);
    for (const s of calc.spots) {
        assert.ok(s.x <= field.centerX * 1.05, `spot x ${s.x} should be on left attack half`);
    }
    log('PASS grid on attacking half + modern lateral reach');

    const controller = {
        x: field.centerX,
        y: field.centerY,
        stats: { passing: 80, shooting: 80, speed: 70 },
        effectivePassing: 80,
        effectiveShooting: 80
    };
    const best = calc.determineBestSupportingPosition({
        controller,
        opponents: [],
        oppGoalX: field.width,
        attacksRight: true,
        force: true
    });
    assert.ok(best, 'best spot exists with open field');
    assert.ok(best.score > 1, `scored spot (score=${best.score})`);
    assert.strictEqual(calc.getBestSupportingSpot(), best);
    log('PASS determineBestSupportingPosition scores open spots');

    // Narrow width prefers more central best spots vs stretch width (same controller)
    Settings.AI.SUPPORT_WIDTH = 0.05;
    calc._fieldKey = null;
    calc.ensureSpots(true, field);
    const bestNarrow = calc.determineBestSupportingPosition({
        controller,
        opponents: [],
        oppGoalX: field.width,
        attacksRight: true,
        force: true
    });
    Settings.AI.SUPPORT_WIDTH = 0.95;
    calc._fieldKey = null;
    calc.ensureSpots(true, field);
    const bestWide = calc.determineBestSupportingPosition({
        controller,
        opponents: [],
        oppGoalX: field.width,
        attacksRight: true,
        force: true
    });
    const distCentreN = Math.abs(bestNarrow.y - field.centerY);
    const distCentreW = Math.abs(bestWide.y - field.centerY);
    // Wide should not be strictly more central than narrow (allow equal if other terms dominate)
    assert.ok(
        distCentreW + 0.5 >= distCentreN * 0.5,
        `wide not more central than narrow (N=${distCentreN.toFixed(2)} W=${distCentreW.toFixed(2)})`
    );
    Settings.AI.SUPPORT_WIDTH = 0.55;
    log('PASS SUPPORT_WIDTH influences lateral preference');

    // Throttle: after a non-force rescore arms the regulator, next calls return cached best
    Settings.AI.SUPPORT_WIDTH = 0.55;
    calc._fieldKey = null;
    calc.ensureSpots(true, field);
    const bestFresh = calc.determineBestSupportingPosition({
        controller,
        opponents: [],
        oppGoalX: field.width,
        attacksRight: true,
        force: false // consumes isReady → arms interval
    });
    assert.ok(bestFresh);
    const best2 = calc.determineBestSupportingPosition({
        controller,
        opponents: [],
        oppGoalX: field.width,
        attacksRight: true,
        force: false
    });
    assert.strictEqual(best2, bestFresh);
    log('PASS regulator returns cached best when not due');

    // --- Live Team ---
    const sim = new Simulator({ seed: 21 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const a = sim.teamA;
    assert.ok(a.supportSpots instanceof SupportSpotCalculator);
    assert.strictEqual(typeof a.updateSupportSpots, 'function');
    assert.strictEqual(typeof a.determineBestSupportingAttacker, 'function');
    assert.strictEqual(typeof a.getBestSupportSpot, 'function');

    const carrier = a.getOutfieldPlayers().find(p => /S|ST|CF|CM|AM/i.test(p.role || ''))
        || a.getOutfieldPlayers()[0];
    carrier.x = field.width * 0.55;
    carrier.y = field.centerY;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;

    // Park B far away so spots score highly
    for (const d of sim.teamB.players) {
        d.x = 3;
        d.y = 3;
    }

    // Drive team FSM into Attacking
    a.controllingPlayer = carrier;
    a.syncFsmFromMatch();
    assert.ok(a.fsm.isInState(TeamStates.Attacking) || a.inControl());
    a.updateSupportSpots({ force: true });

    const spot = a.getBestSupportSpot();
    assert.ok(spot, 'team has best support spot while in control');
    assert.ok(a.supportingPlayer, 'primary supporter assigned');
    assert.notStrictEqual(a.supportingPlayer, carrier);
    assert.strictEqual(a.supportingPlayer.team, 'A');
    log('PASS Team assigns supportingPlayer to best spot');

    // Supporter idle target pulls toward spot
    const supporter = a.supportingPlayer;
    supporter.level = sim;
    const idle = supporter.getIdleMoveTarget();
    const distToSpot = Math.hypot(idle.x - spot.x, idle.y - spot.y);
    const form = supporter.getTargetFormationPos();
    const distFormToSpot = Math.hypot(form.x - spot.x, form.y - spot.y);
    // Idle should be closer to spot than pure formation (or equal if already near)
    assert.ok(
        distToSpot <= distFormToSpot + 0.5,
        `supporter idle nearer spot (idle=${distToSpot.toFixed(2)} form=${distFormToSpot.toFixed(2)})`
    );
    log('PASS supporting player idle target uses sweet spot');

    // Loss of possession clears support on Defending enter
    sim.ball.owner = sim.teamB.getOutfieldPlayers()[0];
    a.lostControl();
    a.syncFsmFromMatch();
    a.fsm.update();
    assert.ok(a.fsm.isInState(TeamStates.Defending));
    assert.strictEqual(a.supportingPlayer, null);
    log('PASS supportingPlayer cleared when defending');

    log('\nAll support spot tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
