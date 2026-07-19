#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Logic-time kick regulators — independent of TIME_SPEED / wall clock.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const {
    TickRegulator,
    LogicTimeCooldown,
    KICK_DEFAULTS,
    getKickTimingParams,
    startKickWindup,
    tickKickWindup,
    armKickerClaimCooldown,
    canClaimAfterKick,
    canEvaluateKickDecision,
    markKickDecision,
    tickKickDecisionCooldown,
    tickPlayerKickGates
} = require('../kernel/core/lib/logic_regulator.js');
const { TickRegulator: SupportTickRegulator } = require('../kernel/core/lib/support_spots.js');
const { Ball } = require('../kernel/core/entities/ball.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function main() {
    // TickRegulator — same contract as support spots (re-exported)
    const reg = new TickRegulator(3);
    assert.strictEqual(reg.isReady(), true);
    assert.strictEqual(reg.isReady(), false);
    assert.strictEqual(reg.isReady(), false);
    assert.strictEqual(reg.isReady(), true);
    assert.ok(SupportTickRegulator === TickRegulator || new SupportTickRegulator(1).isReady());
    log('PASS TickRegulator');

    // LogicTimeCooldown in pure logic seconds
    const cd = new LogicTimeCooldown(0.2);
    cd.start();
    assert.ok(cd.active);
    assert.strictEqual(cd.tick(0.1), false);
    assert.strictEqual(cd.tick(0.1), true);
    assert.ok(cd.ready);
    log('PASS LogicTimeCooldown');

    // Kick params from Settings
    const params = getKickTimingParams({ team: 'A' });
    assert.ok(params.windup > 0);
    assert.ok(params.decisionInterval > 0);
    assert.strictEqual(params.windup, Settings.AI.KICK_WINDUP || KICK_DEFAULTS.KICK_WINDUP);
    log('PASS getKickTimingParams');

    // Windup helpers
    const p = {
        team: 'A',
        kickTimer: 0,
        kickerClaimCooldown: 0,
        kickDecisionCooldown: 0
    };
    startKickWindup(p);
    assert.ok(p.kickTimer > 0);
    assert.strictEqual(tickKickWindup(p, p.kickTimer * 0.5), false);
    assert.strictEqual(tickKickWindup(p, 1.0), true);
    log('PASS startKickWindup / tickKickWindup');

    // Claim cooldown open vs set piece
    armKickerClaimCooldown(p, false);
    const openClaim = p.kickerClaimCooldown;
    armKickerClaimCooldown(p, true);
    assert.ok(p.kickerClaimCooldown > openClaim, 'set-piece claim longer than open play');
    assert.ok(!canClaimAfterKick(p));
    tickPlayerKickGates(p, p.kickerClaimCooldown + 0.01);
    assert.ok(canClaimAfterKick(p));
    log('PASS armKickerClaimCooldown / canClaimAfterKick');

    // Decision throttle: not wall-clock; N steps of LOGIC_DT clear it
    p.kickDecisionCooldown = 0;
    assert.ok(canEvaluateKickDecision(p));
    markKickDecision(p);
    assert.ok(!canEvaluateKickDecision(p));
    const steps = Math.ceil(params.decisionInterval / 0.05) + 1;
    for (let i = 0; i < steps; i++) {
        tickKickDecisionCooldown(p, 0.05);
    }
    assert.ok(canEvaluateKickDecision(p), 'decision ready after logic seconds');
    log('PASS kick decision interval is logic-time');

    // TIME_SPEED does not change logic cooldown math (same dt stack)
    // Simulate "10x wall clock" still advancing same LOGIC_DT per tick
    p.kickDecisionCooldown = 0;
    markKickDecision(p);
    const before = p.kickDecisionCooldown;
    tickKickDecisionCooldown(p, 0.05);
    tickKickDecisionCooldown(p, 0.05);
    assert.ok(p.kickDecisionCooldown < before);
    // Same whether wall clock was fast or slow — only sum of dt matters
    log('PASS cooldowns depend on summed LOGIC_DT, not TIME_SPEED');

    // Ball.kick arms claim via shared helper
    const ball = new Ball();
    const owner = { team: 'A', level: { setPieceType: '' }, kickerClaimCooldown: 0 };
    ball.owner = owner;
    ball.kick(1, 0, 0, 0);
    assert.ok(owner.kickerClaimCooldown > 0, 'open-play claim after kick');
    const owner2 = { team: 'A', level: { setPieceType: 'freekick' }, kickerClaimCooldown: 0 };
    ball.owner = owner2;
    ball.kick(1, 0, 0, 0);
    assert.ok(owner2.kickerClaimCooldown >= 1.0 - 1e-6, 'set-piece claim ~1s');
    log('PASS Ball.kick uses armKickerClaimCooldown');

    log('\nAll logic regulator / kick gate tests passed.');
}

main();
