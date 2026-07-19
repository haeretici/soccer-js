#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Team FSM: posture states vs match phase + possession; depth bias; archetype stacking.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    TeamStates,
    POSTURE_DEPTH_REF,
    resolveTeamStateFromMatch,
    roleDepthMultiplier
} = require('../kernel/core/entities/team.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function stepTeams(sim) {
    if (sim.teamA) sim.teamA.update();
    if (sim.teamB) sim.teamB.update();
}

async function main() {
    // --- Pure resolvers ---
    assert.strictEqual(
        resolveTeamStateFromMatch('play', true),
        TeamStates.Attacking,
        'play + control => Attacking'
    );
    assert.strictEqual(
        resolveTeamStateFromMatch('play', false),
        TeamStates.Defending,
        'play + no control => Defending'
    );
    assert.strictEqual(
        resolveTeamStateFromMatch('kickoff', false),
        TeamStates.KickoffPrepare
    );
    assert.strictEqual(
        resolveTeamStateFromMatch('freekick', true),
        TeamStates.SetPiece,
        'set piece wins over possession'
    );
    assert.strictEqual(
        resolveTeamStateFromMatch('corner', false),
        TeamStates.SetPiece
    );
    assert.ok(roleDepthMultiplier('GK') === 0);
    assert.ok(roleDepthMultiplier('CB') < roleDepthMultiplier('ST'));
    log('PASS resolveTeamStateFromMatch + roleDepthMultiplier');

    // --- Live match bootstrap ---
    const sim = new Simulator({ seed: 99 });
    await sim.start();
    assert.ok(sim.teamA && sim.teamB, 'teams exist');
    assert.ok(sim.teamA.fsm, 'teamA has fsm');

    // After start, match is in Kickoff
    stepTeams(sim);
    assert.ok(sim.teamA.fsm.isInState(TeamStates.KickoffPrepare), 'kickoff => KickoffPrepare A');
    assert.ok(sim.teamB.fsm.isInState(TeamStates.KickoffPrepare), 'kickoff => KickoffPrepare B');
    assert.strictEqual(sim.teamA.postureName, 'kickoffprepare');
    assert.strictEqual(sim.teamA.depthBiasRef, POSTURE_DEPTH_REF.kickoffprepare);
    log('PASS KickoffPrepare on match kickoff');

    // Open play: give ball to team A outfielder
    const carrier = sim.teamA.getOutfieldPlayers()[0];
    assert.ok(carrier, 'has outfielder');
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.ball.owner = carrier;
    carrier.x = sim.ball.x;
    carrier.y = sim.ball.y;
    stepTeams(sim);

    assert.ok(sim.teamA.inControl(), 'A in control');
    assert.ok(sim.teamA.fsm.isInState(TeamStates.Attacking), 'A Attacking');
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Defending), 'B Defending');
    assert.strictEqual(sim.teamA.depthBiasRef, POSTURE_DEPTH_REF.attacking);
    assert.strictEqual(sim.teamB.depthBiasRef, POSTURE_DEPTH_REF.defending);
    assert.ok(sim.teamA.postureHoldBias < sim.teamB.postureHoldBias, 'attacking hold bias looser than defending');
    log('PASS Attacking/Defending from possession in play');

    // Depth: sign is attack direction; defending uses negative depthBiasRef → toward own goal.
    // 1st half: A attacks +X, B attacks -X. B defending → toward own goal (+X).
    const aStriker = sim.teamA.players.find(p => /S|ST|CF|F/i.test(p.role || '')) || carrier;
    const bStriker = sim.teamB.players.find(p => /S|ST|CF|F/i.test(p.role || '')) || sim.teamB.getOutfieldPlayers()[0];
    const depthA = sim.teamA.getDepthWorldOffset(aStriker);
    const depthB = sim.teamB.getDepthWorldOffset(bStriker);
    assert.ok(depthA > 0, `A attacking should push +X (got ${depthA})`);
    assert.ok(depthB > 0, `B defending should sit toward own goal +X in 1st half (got ${depthB})`);
    // When B attacks, depth should reverse relative to defending
    sim.teamB.applyPosture('attacking');
    const depthBAtk = sim.teamB.getDepthWorldOffset(bStriker);
    assert.ok(depthBAtk < 0, `B attacking should push -X (got ${depthBAtk})`);
    sim.teamB.applyPosture('defending'); // restore for later asserts
    // GK never shifts
    const gkA = sim.teamA.getGoalkeeper(true);
    assert.strictEqual(sim.teamA.getDepthWorldOffset(gkA), 0, 'GK depth 0');
    log('PASS formation depth world offsets by role and side');

    // getTargetFormationPos includes depth
    const form = aStriker.getTargetFormationPos();
    assert.ok(Math.abs(form.x - (aStriker.baseX + depthA)) < 8, 'formation target near base+depth (ball shift allowed)');
    log('PASS getTargetFormationPos uses team depth');

    // Loose ball: both defending
    sim.ball.owner = null;
    stepTeams(sim);
    assert.ok(sim.teamA.fsm.isInState(TeamStates.Defending), 'loose => A Defending');
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Defending), 'loose => B Defending');
    log('PASS loose ball both Defending');

    // Set piece overrides possession
    sim.ball.owner = carrier;
    sim.fsm.setCurrentState(MatchStates.Freekick);
    stepTeams(sim);
    assert.ok(sim.teamA.fsm.isInState(TeamStates.SetPiece), 'freekick => SetPiece A');
    assert.ok(sim.teamB.fsm.isInState(TeamStates.SetPiece), 'freekick => SetPiece B');
    assert.strictEqual(sim.teamA.depthBiasRef, 0);
    log('PASS SetPiece from freekick');

    // Flip possession mid-play
    sim.fsm.setCurrentState(MatchStates.Play);
    const bCarrier = sim.teamB.getOutfieldPlayers()[0];
    sim.ball.owner = bCarrier;
    stepTeams(sim);
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Attacking), 'B Attacking after gain');
    assert.ok(sim.teamA.fsm.isInState(TeamStates.Defending), 'A Defending after loss');
    log('PASS possession flip swaps attack/defend');

    // dynamicStrategyShifting stacks: change FORMATION_HOLD, effective hold still includes bias
    const prevHold = Settings.AI.A.FORMATION_HOLD;
    Settings.AI.A.FORMATION_HOLD = 0.9;
    sim.teamA.applyPosture('attacking');
    const eff = sim.teamA.getEffectiveFormationHold();
    assert.ok(eff < 0.9, 'attacking bias lowers effective hold below raw knob');
    assert.ok(eff > 0.7, 'effective hold still near high knob');
    Settings.AI.A.FORMATION_HOLD = prevHold;
    log('PASS posture hold bias stacks on Settings.AI (archetype layer)');

    // Reference equality for isInState
    assert.ok(sim.teamA.fsm.isInState(TeamStates.Defending));
    assert.ok(sim.teamA.fsm.getCurrentState() === TeamStates.Defending);
    log('PASS TeamStates singleton reference equality');

    // Deterministic: two steps with same ownership do not thrash
    sim.ball.owner = bCarrier;
    stepTeams(sim);
    stepTeams(sim);
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Attacking));
    assert.strictEqual(sim.teamB.fsm.getNameOfCurrentState(), 'attacking');
    log('PASS stable state under repeated updates');

    // Silence unused Time import if tree-shaken — keep for future tick tests
    void Time;

    log('\nAll team FSM tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
