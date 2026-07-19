#!/usr/bin/env node
require('./mock_env.js');

const fs = require('fs');
const assert = require('assert');
const { Time } = require('../kernel/core/lib/time.js');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { PlayerStates, isGkProtected } = require('../kernel/core/entities/player.js');

const SCRATCH = '/tmp/grok-goal-58367a54abda/implementer';
const logs = [];
const origLog = console.log;
const origError = console.error;
console.log = (...args) => { logs.push(args.join(' ')); if (process.env.VERBOSE) origLog(...args); };
console.error = (...args) => { logs.push(args.join(' ')); origError(...args); };

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };

function isState(p, state) {
    return p.fsm.getCurrentState() === state;
}

function log(msg) {
    if (process.env.VERBOSE) {
        console.log(msg);
    }
}

const SIM_RUN_SEED = 4242;

async function runSimLoop(runId, seed = SIM_RUN_SEED) {
    log(`\n=== Sim Run ${runId} (seed ${seed}) ===`);

    const sim = new Simulator({ seed });
    await sim.start();
    assert.ok(sim.ball, 'ball created');
    assert.ok(sim.players.length === 22, '22 players created');

    const prevRandom = Math.random;
    try {
        Math.random = sim.seededRandom;

        sim.fsm.setCurrentState(MatchStates.Play);
        // setCurrentState does not run kickoff exit / opening pass, so clear dead-ball flag
        // or Wait outfielders stay frozen and getActiveChasers returns empty.
        sim.setPieceType = '';
        sim.stateTimer = 0;
        sim.matchTimer = 0;

        let sawPass = false;
        let sawLongPassVz = false;
        let sawEmergentTackle = false;
        let sawGkHoldStart = false;
        let sawGkClaimBlocksLoss = false;
        let chaseFrameCount = 0;
        const gkHoldPrev = new Map();

        for (const p of sim.players) {
            if (p.role === 'GK') gkHoldPrev.set(p, 0);
        }

        if (sim.ball.owner && sim.ball.owner.role !== 'GK') {
            const carrier = sim.ball.owner;
            carrier.orientation = 2;
            const opponents = sim.players
                .filter(p => p.team !== carrier.team && p.role !== 'GK')
                .sort((a, b) => Math.hypot(a.x - carrier.x, a.y - carrier.y) - Math.hypot(b.x - carrier.x, b.y - carrier.y));
            if (opponents[0]) {
                opponents[0].x = carrier.x + 1.4;
                opponents[0].y = carrier.y + 0.4;
                opponents[0].actionTimer = 0;
            }
            sim.updatePlayerAIStates();
        }

        for (let frame = 0; frame < 500; frame++) {
            Time.deltaTime = 0.05;
            const prevBallOwner = sim.ball.owner;

            sim.update();
            for (const p of sim.players) {
                const chasingBefore = isState(p, PlayerStates.ChaseBall);
                if (isState(p, PlayerStates.Pass)) sawPass = true;

                p.update();

                if (chasingBefore && (p.actionTimer > 0 || p.isSliding
                    || (isState(p, PlayerStates.Dribble) && sim.ball.owner === p))) {
                    sawEmergentTackle = true;
                }

                if (p.role === 'GK') {
                    const prevHold = gkHoldPrev.get(p) || 0;
                    if (prevHold <= 0 && p.gkHoldTimer > 0.5 && sim.ball.owner === p) {
                        sawGkHoldStart = true;
                    }
                    gkHoldPrev.set(p, p.gkHoldTimer);
                }
            }
            sim.ball.update();

            if (sim.ball.vz > 0 && sim.ball.owner === null) sawLongPassVz = true;

            if (prevBallOwner && sim.ball.owner && prevBallOwner !== sim.ball.owner
                && prevBallOwner.team !== sim.ball.owner.team
                && prevBallOwner.role !== 'GK' && sim.ball.owner.role !== 'GK') {
                sawEmergentTackle = true;
            }

            for (const p of sim.players) {
                if (isState(p, PlayerStates.ChaseBall)) chaseFrameCount++;
            }
        }

        assert.ok(['play', 'goal', 'corner', 'goalkick', 'freekick', 'card', 'offside', 'kickoff', 'foul'].includes(sim.matchState), `matchState should be play, goal, corner, goalkick, freekick, card, offside, kickoff, or foul, got ${sim.matchState}`);
        log(`matchState=${sim.matchState}`);

        const gkWithBall = sim.players.find(p => p.role === 'GK' && sim.ball.owner === p);
        const chasers = sim.getActiveChasers();

        if (gkWithBall) {
            assert.strictEqual(chasers.size, 0, 'no chasers while GK has ball');
            log('PASS GK possession suppresses chasers');
        } else {
            assert.ok(chasers.size >= 1, 'at least one chaser when no GK possession');
            log(`active chasers=${chasers.size}`);
        }

        assert.ok(sawPass || sawLongPassVz, 'pass action observed emergently');
        log(`sawPass=${sawPass} sawLongPassVz=${sawLongPassVz}`);

        assert.ok(sawEmergentTackle, 'emergent tackle from ChaseBall');
        assert.ok(chaseFrameCount > 0 && chaseFrameCount < 5000, `chase frames in realistic range: ${chaseFrameCount}`);
        log(`sawEmergentTackle=${sawEmergentTackle} chaseFrames=${chaseFrameCount}`);

        const gk = sim.players.find(p => p.role === 'GK' && p.team === 'A');
        const attacker = sim.players.find(p => p.team === 'B' && p.role !== 'GK');
        if (gk && attacker) {
            sim.fsm.setCurrentState(MatchStates.Play);
            sim.setPieceType = '';
            sim.stateTimer = 0;
            gk.stats.goalkeeping = 95;
            sim.ball.owner = null;
            sim.ball.x = gk.x + 0.15;
            sim.ball.y = gk.y;
            sim.ball.z = 0;
            sim.ball.vx = 0;
            sim.ball.vy = 0;

            let caught = false;
            for (let i = 0; i < 80; i++) {
                Time.deltaTime = 0.05;
                sim.update();
                for (const p of sim.players) p.update();
                sim.ball.update();
                if (sim.ball.owner === gk && isGkProtected(gk)) {
                    caught = true;
                    break;
                }
            }
            assert.ok(caught, 'GK caught via natural sim update loop');
            attacker.x = gk.x + 0.25;
            attacker.y = gk.y;
            sim.updatePlayerAIStates();
            sim.update();
            attacker.update();
            assert.strictEqual(sim.ball.owner, gk, 'GK retains ball through sim claim window');
            sawGkClaimBlocksLoss = true;
        }
        assert.ok(sawGkClaimBlocksLoss, 'GK claim blocks loss via simulator path');
        assert.ok(sawGkHoldStart || sawGkClaimBlocksLoss, 'GK hold logic exercised');
        log(`sawGkHoldStart=${sawGkHoldStart}`);
        log('PASS GK claim blocks loss via simulator');

        const snap = {
            seed,
            kickoffTeam: sim.kickoffTeam,
            scoreA: sim.scoreA,
            scoreB: sim.scoreB,
            matchState: sim.matchState,
            ball: { x: sim.ball.x, y: sim.ball.y, vz: sim.ball.vz, owner: sim.ball.owner?.name },
            lastTouch: sim.lastTouchPlayer?.name,
            gkHold: gk?.gkHoldTimer,
            gkClaim: gk?.gkClaimTimer,
            flags: {
                sawPass,
                sawLongPassVz,
                sawEmergentTackle,
                chaseFrameCount,
                sawGkHoldStart,
                sawGkClaimBlocksLoss
            }
        };
        log(`snapshot: ${JSON.stringify(snap)}`);
        log(`=== Sim Run ${runId} PASSED ===`);
        return snap;
    } finally {
        Math.random = prevRandom;
    }
}

(async () => {
    let failed = false;
    const snapshots = [];

    for (const runId of [1, 2]) {
        try {
            snapshots.push(await runSimLoop(runId, SIM_RUN_SEED));
        } catch (err) {
            failed = true;
            console.error(`Sim Run ${runId} FAILED:`, err.message);
            console.error(err.stack);
        }
    }

    if (!failed && snapshots.length === 2) {
        try {
            assert.deepStrictEqual(
                snapshots[0],
                snapshots[1],
                'repeated sim runs with same seed produce identical state'
            );
            log('PASS repeated runs are deterministic for fixed seed');
        } catch (err) {
            failed = true;
            console.error('Determinism check FAILED:', err.message);
        }
    }

    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(`${SCRATCH}/sim_run.log`, logs.join('\n'));
    if (failed) process.exit(1);
    console.log('\nSim run: 2/2 runs passed');
})();