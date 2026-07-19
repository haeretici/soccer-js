#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates, REPLAY_LOGIC_DT } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };

function runFrames(sim, count, dt = REPLAY_LOGIC_DT) {
    for (let i = 0; i < count; i++) {
        Time.deltaTime = dt;
        sim.updateAll();
    }
}

function runFramesAtPlaySpeed(sim, count, timeSpeed) {
    const prevSpeed = Settings.TIME_SPEED;
    Settings.TIME_SPEED = timeSpeed;
    for (let i = 0; i < count; i++) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
    }
    Settings.TIME_SPEED = prevSpeed;
}

function elapsedTicks(frameCount) {
    return frameCount;
}

(async () => {
    log("=== Running Seed Replay Scrubber Unit Tests ===");

    const seed = 12345;
    const sim1 = new Simulator({ seed });
    await sim1.start();
    runFrames(sim1, 50);

    const sim2 = new Simulator({ seed });
    await sim2.start();
    runFrames(sim2, 50);

    assert.strictEqual(sim1.ball.x, sim2.ball.x, "Ball X is deterministic");
    assert.strictEqual(sim1.ball.y, sim2.ball.y, "Ball Y is deterministic");
    assert.strictEqual(sim1.scoreA, sim2.scoreA, "Score A is deterministic");
    assert.strictEqual(sim1.scoreB, sim2.scoreB, "Score B is deterministic");
    log("PASS: Seed determinism verified");

    const sim3 = new Simulator({ seed: 999 });
    await sim3.start();
    assert.ok(sim3.replayConfig, "Replay config captured at match start");
    assert.strictEqual(sim3.replayConfig.seed, 999, "Replay config stores seed");
    assert.strictEqual(sim3.replayConfig.teamAName, sim3.teamAName, "Replay config stores teams");
    log("PASS: Replay config captured");

    const halfSim = new Simulator({ seed: 1 });
    halfSim.halfTimeTriggered = true;
    halfSim.matchTimer = 2700;
    halfSim.fsm.setCurrentState(MatchStates.Halftime);
    halfSim.scoreA = 2;
    halfSim.scoreB = 1;
    assert.strictEqual(halfSim.isScoreboardSwapped(), false, "Halftime break does not swap scoreboard");
    halfSim.fsm.setCurrentState(MatchStates.Play);
    assert.strictEqual(halfSim.isScoreboardSwapped(), true, "Second half play swaps scoreboard");
    log("PASS: Scoreboard swap gated on post-halftime play");

    runFrames(sim3, 80);
    sim3.playbackMaxElapsedTicks = sim3.playbackElapsedTicks;

    const refAtFourSec = {
        x: sim3.ball.x,
        y: sim3.ball.y,
        scoreA: sim3.scoreA,
        scoreB: sim3.scoreB
    };

    const liveSpeed = Settings.TIME_SPEED;
    Settings.TIME_SPEED = 3;
    await sim3.seekPlayback(elapsedTicks(80));
    assert.strictEqual(Settings.TIME_SPEED, 3, "Seek restores live TIME_SPEED after replay");
    Settings.TIME_SPEED = liveSpeed;

    const simSound = new Simulator({ seed: 413044 });
    await simSound.start();
    Settings.soundsMuted = false;
    runFrames(simSound, 5000);
    const scoreAt5000 = { scoreA: simSound.scoreA, scoreB: simSound.scoreB, ballX: simSound.ball.x };
    simSound.playbackMaxElapsedTicks = simSound.playbackElapsedTicks;
    await simSound.seekPlayback(5000);
    assert.strictEqual(simSound.scoreA, scoreAt5000.scoreA, "Seek with sound on matches live score A");
    assert.strictEqual(simSound.scoreB, scoreAt5000.scoreB, "Seek with sound on matches live score B");
    assert.strictEqual(simSound.ball.x, scoreAt5000.ballX, "Seek with sound on matches live ball X");
    log("PASS: Seek stays deterministic when match SFX are enabled");

    // Regression fixture from user report — only seed/teams are fixed; scores/ticks are
    // recorded at runtime so AI/balance edits do not false-fail scrubber determinism checks.
    Settings.batchConfig = {
        teamA: 'Brazil',
        teamB: 'Cabo Verde',
        formationA: '4-4-2',
        formationB: '4-4-2'
    };
    const simBraCpv = new Simulator({ seed: 413044 });
    await simBraCpv.start();
    Settings.soundsMuted = false;

    const liveCheckpoints = [];
    const recordCheckpoint = (sim, label) => {
        liveCheckpoints.push({
            label,
            tick: sim.playbackElapsedTicks,
            scoreA: sim.scoreA,
            scoreB: sim.scoreB,
            ballX: sim.ball.x,
            ballY: sim.ball.y
        });
    };

    runFrames(simBraCpv, 5000);
    recordCheckpoint(simBraCpv, 'mid-match');
    runFrames(simBraCpv, 5000);
    recordCheckpoint(simBraCpv, 'late-match');
    assert.ok(simBraCpv.playbackElapsedTicks >= 10000, "Fixture runs long enough to scrub");

    simBraCpv.playbackMaxElapsedTicks = simBraCpv.playbackElapsedTicks;
    await simBraCpv.seekPlayback(simBraCpv.playbackMaxElapsedTicks);
    for (const cp of [...liveCheckpoints].reverse()) {
        await simBraCpv.seekPlayback(cp.tick);
        assert.strictEqual(simBraCpv.scoreA, cp.scoreA, `Scrub (${cp.label}) matches live score A`);
        assert.strictEqual(simBraCpv.scoreB, cp.scoreB, `Scrub (${cp.label}) matches live score B`);
        assert.strictEqual(simBraCpv.ball.x, cp.ballX, `Scrub (${cp.label}) matches live ball X`);
        assert.strictEqual(simBraCpv.ball.y, cp.ballY, `Scrub (${cp.label}) matches live ball Y`);
    }
    Settings.batchConfig = null;
    log("PASS: Brazil vs Cabo Verde seed 413044 scrubber matches live timeline");
    assert.strictEqual(sim3.ball.x, refAtFourSec.x, "Seek to tick 80 matches live ball X");
    assert.strictEqual(sim3.ball.y, refAtFourSec.y, "Seek to tick 80 matches live ball Y");
    assert.strictEqual(sim3.scoreA, refAtFourSec.scoreA, "Seek to tick 80 matches live score A");
    log("PASS: Replay seek restores live match state");

    const sim4 = new Simulator({ seed: 777 });
    await sim4.start();
    runFrames(sim4, 100);
    sim4.playbackMaxElapsedTicks = sim4.playbackElapsedTicks;

    const refAtEightyTicks = { x: sim4.ball.x, y: sim4.ball.y };
    await sim4.seekPlayback(elapsedTicks(80));
    runFrames(sim4, 20);

    assert.strictEqual(sim4.ball.x, refAtEightyTicks.x, "Scrub-back resume ball X matches uninterrupted path");
    assert.strictEqual(sim4.ball.y, refAtEightyTicks.y, "Scrub-back resume ball Y matches uninterrupted path");
    log("PASS: Scrub-back resume via seed replay verified");

    const runCycle = async () => {
        const sim = new Simulator({ seed: 42 });
        await sim.start();
        runFrames(sim, 60);
        const snapshot = {
            ballX: sim.ball.x,
            ballY: sim.ball.y,
            scoreA: sim.scoreA,
            scoreB: sim.scoreB,
            kickoff: sim.kickoffTeam
        };
        sim.destroy();
        return snapshot;
    };

    const cycle1 = await runCycle();
    const cycle2 = await runCycle();
    assert.deepStrictEqual(cycle1, cycle2, "Repeated start/stop cycles with seed 42 are identical");
    log("PASS: Repeated match cycles are deterministic");

    const speedSeed = 4242;
    const simSpeed1 = new Simulator({ seed: speedSeed });
    await simSpeed1.start();
    runFramesAtPlaySpeed(simSpeed1, 120, 1);

    const simSpeed10 = new Simulator({ seed: speedSeed });
    await simSpeed10.start();
    runFramesAtPlaySpeed(simSpeed10, 120, 10);

    assert.strictEqual(simSpeed1.ball.x, simSpeed10.ball.x, "Ball X is play-speed invariant");
    assert.strictEqual(simSpeed1.ball.y, simSpeed10.ball.y, "Ball Y is play-speed invariant");
    assert.strictEqual(simSpeed1.scoreA, simSpeed10.scoreA, "Score A is play-speed invariant");
    assert.strictEqual(simSpeed1.scoreB, simSpeed10.scoreB, "Score B is play-speed invariant");
    assert.strictEqual(simSpeed1.matchTimer, simSpeed10.matchTimer, "Match timer is play-speed invariant");
    log("PASS: Play speed does not affect simulation outcome");

    const simFt = new Simulator({ seed: 55 });
    await simFt.start();
    runFrames(simFt, 60);
    const ticksBeforeFulltime = simFt.playbackElapsedTicks;
    simFt.fsm.changeState(MatchStates.Fulltime);
    runFrames(simFt, 40);
    assert.strictEqual(simFt.playbackElapsedTicks, ticksBeforeFulltime, "Playback ticks freeze at fulltime");
    assert.strictEqual(simFt.playbackMaxElapsedTicks, ticksBeforeFulltime, "Playback max ticks freeze at fulltime");
    log("PASS: Playback scrubber stops recording at fulltime");

    log("=== ALL SEED REPLAY SCRUBBER TESTS PASSED ===");
})();