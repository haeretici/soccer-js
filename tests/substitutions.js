#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Unit tests for B.5 Substitutions & fatigue tactics.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { runBatch } = require('../kernel/providers/simulator/headless_runner.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };
Settings.HEADLESS = true;



async function testBenchCreation() {
    log('--- Testing Bench Creation ---');
    const sim = new Simulator({ seed: 100 });
    await sim.start();

    const teamA = sim.teamA;
    const teamB = sim.teamB;

    assert.ok(teamA.bench, 'Team A should have a bench array');
    assert.strictEqual(teamA.bench.length, 11, 'Team A bench should have 11 players');

    const subRoles = teamA.bench.map(p => p.role);
    assert.deepStrictEqual(subRoles, ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'], 'Bench roles mismatch');

    const subJerseys = teamA.bench.map(p => p.jersey);
    assert.deepStrictEqual(subJerseys, [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], 'Bench jerseys mismatch');

    for (const sub of teamA.bench) {
        assert.strictEqual(sub.team, 'A', 'Bench player should belong to team A');
        assert.ok(sub.stats, 'Bench player should have stats');
        assert.strictEqual(sub.currentStamina, 1.0, 'Bench player should have 1.0 starting stamina');
    }

    log('PASS: Bench players initialized correctly.');
}

async function testSubstitutionTriggers() {
    log('--- Testing Substitution Triggers ---');
    const sim = new Simulator({ seed: 101 });
    await sim.start();

    const teamA = sim.teamA;
    const teamB = sim.teamB;

    // Simulate late-game (simulated 70th minute = 4200 seconds)
    sim.matchTimer = 4200;

    // Set match state to a paused state (e.g. foul)
    sim.fsm.changeState(MatchStates.Foul);

    // Case 1: Early game guard (matchTimer < 3240)
    // Even if players are exhausted, they shouldn't be subbed before the 54th minute
    sim.matchTimer = 3000;
    const tiredPlayer = teamA.getOutfieldPlayers()[0];
    tiredPlayer.currentStamina = 0.40;
    sim.checkForSubstitutions();
    assert.strictEqual(teamA.substitutionsMade, 0, 'No subs should be made early in the game');

    // Restore late-game timer
    sim.matchTimer = 4200;

    // Case 2: Exhaustion (any outfield player stamina < 0.55)
    sim.checkForSubstitutions();
    assert.strictEqual(teamA.substitutionsMade, 1, 'Exhausted player should be substituted');
    assert.ok(tiredPlayer.isSubbedOut, 'Tired player should be marked isSubbedOut');
    const newPlayer = teamA.players.find(p => p.jersey === 13 || p.jersey === 14 || p.jersey === 15 || p.jersey === 16);
    assert.ok(newPlayer, 'Substitute player should now be on the field');
    assert.ok(newPlayer.isSubbedIn, 'Substitute player should be marked isSubbedIn');
    assert.strictEqual(newPlayer.currentStamina, 1.0, 'Substitute player should have full stamina');

    // Case 3: Tired wide player (role matches wide, stamina < 0.65)
    // Let's find a wide player on Team B
    const widePlayer = teamB.players.find(p => /^(LB|RB|LM|RM|LWB|RWB|LW|RW)$/i.test(p.role));
    assert.ok(widePlayer, 'Should find a wide player on Team B');
    widePlayer.currentStamina = 0.60;
    sim.checkForSubstitutions();
    assert.strictEqual(teamB.substitutionsMade, 1, 'Tired wide player should be substituted late-game');
    assert.ok(widePlayer.isSubbedOut, 'Wide player should be marked isSubbedOut');

    // Case 4: Trailing team auto-sub (any outfield player stamina < 0.70 when trailing)
    // Make Team B trail by scoring for Team A
    sim.scoreA = 1;
    sim.scoreB = 0;
    
    // Find an outfield player on Team B who is not already subbed out
    const normalPlayer = teamB.players.find(p => p.role !== 'GK' && !p.isSentOff && !p.isSubbedOut);
    normalPlayer.currentStamina = 0.68; // less than 0.70
    sim.checkForSubstitutions();
    assert.strictEqual(teamB.substitutionsMade, 2, 'Trailing fatigued player should be substituted');
    assert.ok(normalPlayer.isSubbedOut, 'Normal player should be marked isSubbedOut');

    log('PASS: Substitution triggers (exhaustion, wide player, trailing) work perfectly.');
}

async function testHeadlessTelemetry() {
    log('--- Testing Telemetry Integration ---');
    const batchInput = {
        iterations: 1,
        seed: 42,
        headless: true,
        matchDurationSeconds: 120, // short match
        maxFramesPerMatch: 8000
    };

    // To ensure substitutions happen, let's force stamina drain by draining starting players
    const { matches, summary } = await runBatch(batchInput);

    assert.ok('substitutionsAPerMatch' in summary.tactical, 'Summary should contain substitutionsAPerMatch');
    assert.ok('substitutionsBPerMatch' in summary.tactical, 'Summary should contain substitutionsBPerMatch');
    
    log(`PASS: Telemetry tracking verified. A sub avg: ${summary.tactical.substitutionsAPerMatch.toFixed(2)}, B sub avg: ${summary.tactical.substitutionsBPerMatch.toFixed(2)}`);
}

async function run() {
    try {
        await testBenchCreation();
        await testSubstitutionTriggers();
        await testHeadlessTelemetry();
        log('\nALL SUBSTITUTIONS & FATIGUE TESTS PASSED');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

run();
