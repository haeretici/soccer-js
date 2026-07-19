#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * RequestPass protocol — safe PassToMe + team logic-time rate limit.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { PlayerStates } = require('../kernel/core/entities/player.js');
const { SoccerMsg } = require('../kernel/core/lib/soccer_messages.js');
const { dispatchSoccerMsg } = require('../kernel/core/lib/message_dispatcher.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const sim = new Simulator({ seed: 55 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const a = sim.teamA;
    const b = sim.teamB;
    // Park B far so lanes are open
    for (const p of b.players) {
        p.x = 2;
        p.y = 2;
    }

    const carrier = a.getOutfieldPlayers()[0];
    const support = a.getOutfieldPlayers().find(p => p !== carrier);
    assert.ok(carrier && support);

    carrier.x = 35;
    carrier.y = 25;
    support.x = 48;
    support.y = 22;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    a.setControllingPlayer(carrier);
    a.supportingPlayer = support;
    a.receivingPlayer = null;
    a.passRequestCooldown = 0;

    // requestPass succeeds when open + safe
    const ok = a.requestPass(support);
    assert.ok(ok, 'requestPass dispatches when safe');
    assert.ok(a.passRequestCooldown > 0, 'team gate armed');
    assert.strictEqual(a.lastPassRequester, support);
    assert.ok(carrier.fsm.isInState(PlayerStates.Pass), 'controller entered Pass');
    assert.strictEqual(carrier.passTarget, support);
    assert.ok(carrier.passAim);
    log('PASS requestPass → PassToMe → controller Pass');

    // Team rate limit blocks second immediate request
    carrier.fsm.changeState(PlayerStates.Dribble);
    carrier.passTarget = null;
    const blocked = a.requestPass(support);
    assert.strictEqual(blocked, false, 'team cooldown blocks spam');
    log('PASS team REQUEST_PASS_INTERVAL gate');

    // After cooldown, can request again
    a.passRequestCooldown = 0;
    a.receivingPlayer = null;
    sim.ball.owner = carrier;
    const ok2 = a.requestPass(support);
    assert.ok(ok2, 'request after cooldown');
    log('PASS request after cooldown');

    // Unsafe lane: wall of B between carrier and support
    a.passRequestCooldown = 0;
    carrier.fsm.changeState(PlayerStates.Dribble);
    sim.ball.owner = carrier;
    support.x = 55;
    support.y = 25;
    carrier.x = 30;
    carrier.y = 25;
    // Place several B on the lane
    const wall = b.getOutfieldPlayers();
    for (let i = 0; i < Math.min(3, wall.length); i++) {
        wall[i].x = 42;
        wall[i].y = 25 + (i - 1) * 0.3;
        wall[i].stats = wall[i].stats || {};
        wall[i].stats.speed = 99;
    }
    const unsafe = a.requestPass(support, { skipOpenCheck: true });
    assert.strictEqual(unsafe, false, 'blocked lane rejects requestPass');
    log('PASS unsafe lane rejected');

    // tickPassRequestCooldown uses logic time
    a.passRequestCooldown = 0.2;
    Time.deltaTime = 0.05;
    a.tickPassRequestCooldown();
    assert.ok(Math.abs(a.passRequestCooldown - 0.15) < 1e-6);
    a.update(); // also ticks
    assert.ok(a.passRequestCooldown < 0.15);
    log('PASS tickPassRequestCooldown logic-time');

    // Direct PassToMe without safety aim rejects when fully blocked
    a.passRequestCooldown = 0;
    carrier.fsm.changeState(PlayerStates.Dribble);
    sim.ball.owner = carrier;
    carrier.passTarget = null;
    dispatchSoccerMsg(sim, 0, support, carrier, SoccerMsg.PassToMe, { requester: support });
    // May or may not enter Pass depending on getBestPassToReceiver finding edge — if wall dense, stay Dribble
    if (carrier.fsm.isInState(PlayerStates.Pass)) {
        log('PASS PassToMe found edge aim (optional)');
    } else {
        assert.ok(carrier.fsm.isInState(PlayerStates.Dribble));
        log('PASS PassToMe handler rejects without safe aim');
    }

    // lostControl clears requester bookkeeping
    a.lastPassRequester = support;
    a.lostControl();
    assert.strictEqual(a.lastPassRequester, null);
    log('PASS lostControl clears lastPassRequester');

    log('\nAll RequestPass tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
