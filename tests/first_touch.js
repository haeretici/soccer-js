#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * A.8 First touch & heavy touch.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const {
    computeFirstTouchControl,
    computeFumbleChance,
    applyFirstTouch,
    POOR_TOUCH_DRIBBLE_MULT
} = require('../kernel/core/lib/first_touch.js');
const { tryClaimLooseBall, PlayerStates } = require('../kernel/core/entities/player.js');
const { canClaimAfterKick } = require('../kernel/core/lib/logic_regulator.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function testControlAndFumbleCurve() {
    const good = { stats: { dribbling: 90 }, traits: [] };
    const poor = { stats: { dribbling: 40 }, traits: ['Poor Touch'] };
    const cGood = computeFirstTouchControl(good, 4);
    const cPoor = computeFirstTouchControl(poor, 4);
    assert.ok(cGood > cPoor, `good control ${cGood} > poor ${cPoor}`);
    assert.ok(cPoor < 0.35, 'Poor Touch + low dribble is weak');

    const fGood = computeFumbleChance(cGood, 10);
    const fPoor = computeFumbleChance(cPoor, 10);
    assert.ok(fPoor > fGood, 'poor fumbles more');
    assert.strictEqual(computeFumbleChance(0.5, 2.0), 0, 'soft residual no fumble');
    assert.ok(computeFumbleChance(0.3, 8) > 0, 'hot ball can fumble');
    assert.ok(POOR_TOUCH_DRIBBLE_MULT < 1);
    log('PASS control + fumble curve');
}

function testApplyCleanAndHeavy() {
    const player = {
        role: 'MF',
        stats: { dribbling: 80 },
        traits: [],
        kickerClaimCooldown: 0
    };
    const ball = { vx: 8, vy: 0, vz: 0, owner: null, curveForce: 0 };

    const clean = applyFirstTouch(player, { ...ball }, { forceClean: true });
    assert.strictEqual(clean.fumbled, false);

    const heavyBall = { vx: 10, vy: 2, vz: 0, owner: null, curveForce: 1 };
    const heavy = applyFirstTouch(player, heavyBall, { forceFumble: true, random: () => 0.5 });
    assert.strictEqual(heavy.fumbled, true);
    assert.strictEqual(heavyBall.owner, null);
    assert.ok(Math.hypot(heavyBall.vx, heavyBall.vy) > 0.5, 'residual velocity');
    assert.ok(player.kickerClaimCooldown > 0, 'claim lock after heavy');
    log('PASS applyFirstTouch clean/heavy');
}

function testTryClaimIntegration() {
    const player = {
        role: 'MF',
        x: 40,
        y: 25,
        stats: { dribbling: 30, speed: 60 },
        traits: ['Poor Touch'],
        staminaMultiplier: 1,
        kickerClaimCooldown: 0,
        isSentOff: false,
        fsm: {
            currentState: null,
            changeState(s) { this.currentState = s; }
        },
        level: {
            players: [],
            ball: null
        }
    };
    // canClaimAfterKick uses player.kickerClaimCooldown
    assert.ok(canClaimAfterKick(player));

    const field = { width: 80, height: 50 };
    // Patch getFieldBounds via ball in bounds
    const ball = {
        x: 40.2,
        y: 25,
        z: 0,
        vx: 12,
        vy: 0,
        vz: 0,
        owner: null,
        curveForce: 0
    };
    player.level.ball = ball;

    // Force heavy via global Math.random temporarily
    const real = Math.random;
    try {
        Math.random = () => 0; // always fumble if chance > 0
        Settings.AI.FIRST_TOUCH_FUMBLE_BASE = 1;
        Settings.AI.FIRST_TOUCH_FUMBLE_MAX = 1;
        Settings.AI.FIRST_TOUCH_MIN_SPEED = 0.5;
        Settings.AI.BALL_CLAIM_RANGE = 2;

        const touched = tryClaimLooseBall(player, ball);
        assert.strictEqual(touched, true);
        assert.strictEqual(ball.owner, null, 'heavy touch leaves ball free');
        assert.ok(player.kickerClaimCooldown > 0);
        assert.notStrictEqual(player.fsm.currentState, PlayerStates.Dribble);

        // Clean claim
        Math.random = () => 0.99;
        Settings.AI.FIRST_TOUCH_FUMBLE_BASE = 0;
        Settings.AI.FIRST_TOUCH_FUMBLE_SCALE = 0;
        Settings.AI.FIRST_TOUCH_FUMBLE_MAX = 0;
        player.kickerClaimCooldown = 0;
        ball.vx = 3;
        ball.vy = 0;
        ball.owner = null;
        const claimed = tryClaimLooseBall(player, ball);
        assert.strictEqual(claimed, true);
        assert.strictEqual(ball.owner, player);
        assert.strictEqual(player.fsm.currentState, PlayerStates.Dribble);
    } finally {
        Math.random = real;
    }
    // restore defaults
    Settings.AI.FIRST_TOUCH_FUMBLE_BASE = 0.03;
    Settings.AI.FIRST_TOUCH_FUMBLE_SCALE = 0.32;
    Settings.AI.FIRST_TOUCH_FUMBLE_MAX = 0.4;
    Settings.AI.FIRST_TOUCH_MIN_SPEED = 3.5;
    log('PASS tryClaimLooseBall integration');
}

function testOwnPassReclaimClean() {
    const player = {
        role: 'MF',
        x: 40, y: 25,
        stats: { dribbling: 35, speed: 60 },
        traits: ['Poor Touch'],
        staminaMultiplier: 1,
        kickerClaimCooldown: 0,
        isSentOff: false,
        fsm: { currentState: null, changeState(s) { this.currentState = s; } },
        level: { players: [] }
    };
    const ball = {
        x: 40.2, y: 25, z: 0,
        vx: 10, vy: 2, vz: 0,
        owner: null,
        lastKicker: player,
        curveForce: 0
    };
    player.level.ball = ball;
    Settings.AI.BALL_CLAIM_RANGE = 2;
    Settings.AI.FIRST_TOUCH_FUMBLE_BASE = 1;
    Settings.AI.FIRST_TOUCH_FUMBLE_MAX = 1;
    Settings.AI.FIRST_TOUCH_MIN_SPEED = 0.5;
    // Would always fumble if not own-pass — must still claim clean
    const realRandom = Math.random;
    try {
        Math.random = () => 0;
        const ok = tryClaimLooseBall(player, ball);
        assert.strictEqual(ok, true);
        assert.strictEqual(ball.owner, player, 'own-pass reclaim is clean');
        assert.strictEqual(ball.lastKicker, null);
        assert.strictEqual(player.fsm.currentState, PlayerStates.Dribble);
    } finally {
        Math.random = realRandom;
    }
    Settings.AI.FIRST_TOUCH_FUMBLE_BASE = 0.03;
    Settings.AI.FIRST_TOUCH_FUMBLE_MAX = 0.4;
    Settings.AI.FIRST_TOUCH_MIN_SPEED = 3.5;
    log('PASS own-pass reclaim clean (no fumble loop)');
}

function testGkSkipped() {
    const gk = { role: 'GK', stats: { dribbling: 20 }, traits: ['Poor Touch'] };
    const ball = { vx: 20, vy: 0, owner: null };
    const r = applyFirstTouch(gk, ball, { forceFumble: true });
    // forceFumble still runs path after skip check — GK returns skipped before force
    assert.strictEqual(r.skipped, true);
    log('PASS GK first-touch skipped');
}

function main() {
    testControlAndFumbleCurve();
    testApplyCleanAndHeavy();
    testTryClaimIntegration();
    testOwnPassReclaimClean();
    testGkSkipped();
    log('first_touch: ALL PASS');
}

main();
