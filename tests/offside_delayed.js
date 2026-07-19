#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Delayed offside whistle tests.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { tryClaimLooseBall } = require('../kernel/core/entities/player.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const sim = new Simulator({ seed: 42 });
    await sim.start();
    
    // Mock players
    const passer = { team: 'A', x: 40, y: 25, level: sim, fsm: { changeState() {} } };
    const offsideReceiver = { team: 'A', x: 80, y: 25, level: sim, role: 'CF', stats: { speed: 60 }, staminaMultiplier: 1, fsm: { changeState() {} } };
    const defender = { team: 'B', x: 75, y: 25, level: sim, role: 'DF', stats: { speed: 60 }, staminaMultiplier: 1, fsm: { changeState() {} } };
    
    // Set up ball with offside receiver
    sim.ball.x = 45;
    sim.ball.y = 25;
    sim.ball.z = 0;
    sim.ball.owner = null;
    sim.ball.offsideReceiver = offsideReceiver;
    sim.ball.offsideLineX = 75;
    
    // 1. Defender tries to claim the ball first (interception)
    sim.ball.x = 75; // Ball reaches defender
    const defenderClaimed = tryClaimLooseBall(defender, sim.ball);
    assert.strictEqual(defenderClaimed, true, "Defender should claim the ball");
    assert.strictEqual(sim.ball.offsideReceiver, null, "Offside receiver should be cleared on defender claim");
    assert.strictEqual(sim.ball.owner, defender, "Defender should own the ball");
    log("PASS defender intercept cleans offside");
    
    // Reset ball offside
    sim.ball.owner = null;
    sim.ball.offsideReceiver = offsideReceiver;
    sim.ball.offsideLineX = 75;
    
    // 2. Offside receiver tries to claim the ball (offside violation)
    sim.ball.x = 80; // Ball reaches offside receiver
    
    let offsideTriggered = false;
    sim.triggerOffside = (player) => {
        assert.strictEqual(player, offsideReceiver, "Trigger offside should receive the offside receiver");
        offsideTriggered = true;
    };
    
    const receiverClaimed = tryClaimLooseBall(offsideReceiver, sim.ball);
    assert.strictEqual(receiverClaimed, true, "Receiver claim should return true (intercepted by whistle)");
    assert.strictEqual(offsideTriggered, true, "Offside whistle should have blown");
    assert.strictEqual(sim.ball.offsideReceiver, null, "Offside receiver property should be cleared");
    log("PASS offside receiver claim triggers whistle");
    
    log("\nAll delayed offside tests passed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
