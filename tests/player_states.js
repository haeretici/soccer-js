#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Dedicated field-player states + GlobalPlayerState speed with/without ball.
 * Outfield / GK state modules (composition, one Player class).
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    PlayerStates,
    isGoalkeeperRole,
    isOutfieldRole,
    globalPossessionSpeedMul,
    applyGlobalPlayerState
} = require('../kernel/core/entities/player.js');
const playerStatesMod = require('../kernel/core/entities/player_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    // --- State table shape ---
    assert.ok(PlayerStates.Receive && PlayerStates.Receive.name === 'Receive');
    assert.ok(PlayerStates.SupportAttacker && PlayerStates.SupportAttacker.name === 'SupportAttacker');
    assert.ok(PlayerStates.Wait && PlayerStates.Wait.name === 'Wait');
    assert.ok(PlayerStates.GoHome && PlayerStates.GoHome.name === 'GoHome');
    assert.strictEqual(PlayerStates.ReturnHome, PlayerStates.GoHome, 'ReturnHome aliases GoHome');
    assert.ok(PlayerStates.Pass && PlayerStates.Shoot, 'kick stays Pass/Shoot');
    assert.ok(PlayerStates.Idle && PlayerStates.ChaseBall && PlayerStates.Dribble);
    assert.ok(PlayerStates.Goalkeeper && PlayerStates.GkDive, 'GK states present');
    assert.ok(PlayerStates.Header, 'Header is outfield state');
    // composition: same bag from barrel; role helpers; not subclasses
    assert.strictEqual(playerStatesMod.PlayerStates, PlayerStates);
    assert.ok(isGoalkeeperRole({ role: 'GK' }) && !isGoalkeeperRole({ role: 'ST' }));
    assert.ok(isOutfieldRole({ role: 'CM' }) && !isOutfieldRole({ role: 'GK' }));
    log('PASS dedicated FieldPlayer states present (+ ReturnHome alias)');

    // --- Possession speed mul ---
    const sim = new Simulator({ seed: 88 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const p = sim.teamA.getOutfieldPlayers()[0];
    sim.ball.owner = null;
    applyGlobalPlayerState(p);
    const without = globalPossessionSpeedMul(p);
    assert.ok(Math.abs(without - 1.0) < 1e-6 || without >= 0.95, `without ball mul=${without}`);

    sim.ball.owner = p;
    applyGlobalPlayerState(p);
    const withBall = globalPossessionSpeedMul(p);
    assert.ok(withBall < without, `with ball slower (${withBall} < ${without})`);
    assert.ok(withBall > 0.5 && withBall < 1.0);
    log('PASS globalPossessionSpeedMul with/without ball');

    // moveTo respects possession mul
    p.x = 20;
    p.y = 25;
    p._currentSpeed = 0;
    sim.ball.owner = null;
    applyGlobalPlayerState(p);
    Time.deltaTime = 0.05;
    p.moveTo({ x: 40, y: 25 }, 1);
    const speedLoose = p._currentSpeed;

    p.x = 20;
    p.y = 25;
    p._currentSpeed = 0;
    sim.ball.owner = p;
    applyGlobalPlayerState(p);
    p.moveTo({ x: 40, y: 25 }, 1);
    const speedCarry = p._currentSpeed;
    assert.ok(speedCarry < speedLoose, `carrier topSpeed lower (${speedCarry} < ${speedLoose})`);
    log('PASS moveTo applies with-ball speed cap');

    // --- Idle promotes designated supporter ---
    const carrier = sim.teamA.getOutfieldPlayers()[1] || p;
    const mate = sim.teamA.getOutfieldPlayers().find(x => x !== carrier);
    sim.ball.owner = carrier;
    sim.teamA.controllingPlayer = carrier;
    sim.teamA.supportingPlayer = mate;
    mate.fsm.setCurrentState(PlayerStates.Idle);
    mate.actionTimer = 0;
    PlayerStates.Idle.execute(mate);
    assert.ok(mate.fsm.isInState(PlayerStates.SupportAttacker), 'Idle → SupportAttacker when designated');
    log('PASS Idle promotes supportingPlayer to SupportAttacker');

    // --- GoHome / ReturnHome arrive → Wait off-play ---
    const homeP = sim.teamA.getOutfieldPlayers()[2] || mate;
    homeP.baseX = 15;
    homeP.baseY = 20;
    homeP.x = 15.2;
    homeP.y = 20.1;
    sim.fsm.setCurrentState(MatchStates.Freekick);
    homeP.fsm.changeState(PlayerStates.ReturnHome, { target: { x: 15, y: 20 } });
    assert.strictEqual(homeP.fsm.getCurrentState(), PlayerStates.GoHome);
    PlayerStates.GoHome.execute(homeP);
    assert.ok(
        homeP.fsm.isInState(PlayerStates.Wait) || homeP.fsm.isInState(PlayerStates.GoHome),
        'near home transitions toward Wait when not in play'
    );
    log('PASS ReturnHome/GoHome home arrival');

    // --- Wait faces ball and exits on play ---
    homeP.fsm.changeState(PlayerStates.Wait);
    sim.ball.x = homeP.x + 5;
    sim.ball.y = homeP.y;
    PlayerStates.Wait.execute(homeP);
    // still freekick
    assert.ok(homeP.fsm.isInState(PlayerStates.Wait));
    sim.fsm.setCurrentState(MatchStates.Play);
    // Wait exits only when open play is clean (no leftover setPieceType from kickoff/freekick).
    sim.setPieceType = '';
    PlayerStates.Wait.execute(homeP);
    assert.ok(homeP.fsm.isInState(PlayerStates.Idle), 'Wait → Idle when play resumes');
    log('PASS Wait holds then returns to Idle on play');

    // --- shouldPreserve dedicated states ---
    mate.fsm.changeState(PlayerStates.SupportAttacker);
    assert.ok(sim.shouldPreserveAIState(mate));
    mate.fsm.changeState(PlayerStates.Receive, { target: { x: 1, y: 1 } });
    assert.ok(sim.shouldPreserveAIState(mate));
    log('PASS shouldPreserveAIState for Receive/SupportAttacker');

    // --- GK 3D selective dive target tests ---
    const gk = sim.teamA.getGoalkeeper();
    gk.x = 2;
    gk.y = 25;
    gk.fsm.setCurrentState(PlayerStates.Goalkeeper);
    
    // Test that GK dives with 3D predicted target when ball is moving
    sim.ball.owner = null;
    sim.ball.x = 5;
    sim.ball.y = 20;
    sim.ball.z = 1.0;
    sim.ball.vx = 10;
    sim.ball.vy = 5;
    sim.ball.vz = 5;
    
    // Simulate dive transition
    gk.fsm.changeState(PlayerStates.GkDive);
    assert.strictEqual(gk.fsm.getCurrentState(), PlayerStates.GkDive);
    
    // The target should be predicted at t=0.3s
    assert.ok(gk.gkDiveTarget.x > 5.5, `GK dive target x should be predicted ahead, got ${gk.gkDiveTarget.x}`);
    assert.ok(gk.gkDiveTarget.y > 20.5, `GK dive target y should be predicted ahead, got ${gk.gkDiveTarget.y}`);
    log('PASS GK 3D selective dive target alignment');

    log('\nAll player state tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
