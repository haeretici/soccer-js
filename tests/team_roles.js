#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Team key-player roles: controlling / supporting / receiving / closest / press sticky.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { PlayerStates } = require('../kernel/core/entities/player.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const sim = new Simulator({ seed: 55 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    // Clear kickoff bookkeeping so Wait outfielders canBecomeChaser / press.
    sim.setPieceType = '';


    const a = sim.teamA;
    const b = sim.teamB;
    assert.ok(a && b);

    const carrier = a.getOutfieldPlayers()[0];
    const mate = a.getOutfieldPlayers().find(p => p !== carrier);
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;

    a.syncRolesFromBall(sim.ball);
    b.syncRolesFromBall(sim.ball);

    assert.strictEqual(a.controllingPlayer, carrier, 'A controlling');
    assert.ok(a.isControllingPlayer(carrier));
    assert.strictEqual(b.controllingPlayer, null, 'B not controlling');
    assert.ok(a.playerClosestToBall, 'closest-to-ball set');
    log('PASS controlling + closest from ball sync');

    // Opponent lostControl clears attack roles
    b.supportingPlayer = b.getOutfieldPlayers()[0];
    b.receivingPlayer = b.getOutfieldPlayers()[1];
    a.setControllingPlayer(carrier); // forces B.lostControl
    assert.strictEqual(b.controllingPlayer, null);
    assert.strictEqual(b.supportingPlayer, null);
    assert.strictEqual(b.receivingPlayer, null);
    log('PASS LostControl clears supporting/receiving');

    // Receiving role
    a.receivingPlayer = mate;
    assert.ok(a.isReceivingPlayer(mate));
    a.lostControl();
    assert.strictEqual(a.receivingPlayer, null);
    log('PASS receiving cleared on lostControl');

    // Press stickiness on defending team
    sim.ball.owner = carrier;
    a.setControllingPlayer(carrier);
    b.stickyPrimaryChaser = null;
    const pressers = b.getPressChasers(carrier, (p) => p.role !== 'GK' && !p.isSentOff);
    assert.ok(pressers.length >= 1, 'at least one presser');
    assert.ok(b.stickyPrimaryChaser, 'sticky set on Team B');
    assert.ok(pressers.includes(b.stickyPrimaryChaser));
    log('PASS getPressChasers + stickyPrimaryChaser on Team');

    // Simulator facade aggregates
    sim.syncTeamKeyPlayers();
    const chasers = sim.getActiveChasers();
    assert.ok(chasers.size >= 1);
    assert.strictEqual(sim._stickyPrimaryChasers.B, b.stickyPrimaryChaser);
    log('PASS getActiveChasers uses Team press + mirrors sticky map');

    // Loose ball: each team sticky nearest
    sim.ball.owner = null;
    a.lostControl();
    b.lostControl();
    a.stickyPrimaryChaser = null;
    b.stickyPrimaryChaser = null;
    const loose = sim.getActiveChasers();
    assert.ok(loose.size >= 1, 'loose ball has chasers');
    assert.ok(a.playerClosestToBall || b.playerClosestToBall);
    log('PASS loose ball chasers via Team');

    // Support role still assigned while attacking
    sim.ball.owner = carrier;
    a.setControllingPlayer(carrier);
    for (const d of b.players) {
        d.x = 2;
        d.y = 2;
    }
    a.updateSupportSpots({ force: true });
    if (a.supportingPlayer) {
        assert.ok(a.isSupportingPlayer(a.supportingPlayer));
        assert.notStrictEqual(a.supportingPlayer, carrier);
        log('PASS supportingPlayer role while in control');
    } else {
        log('PASS supportingPlayer optional when no candidate');
    }

    // Controller dribble assignment uses Team role
    sim.ball.owner = carrier;
    a.setControllingPlayer(carrier);
    carrier.fsm.setCurrentState(PlayerStates.Idle);
    sim.updatePlayerAIStates();
    assert.ok(
        carrier.fsm.isInState(PlayerStates.Dribble) || sim.shouldPreserveAIState(carrier),
        'controller pushed to Dribble'
    );
    log('PASS updatePlayerAIStates respects controlling role');

    log('\nAll team role tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
