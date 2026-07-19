#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}

/**
 * Scenario Lab helpers — prune + force set-piece / open-play setups.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    SCENARIO_CATALOG,
    getScenarioDef,
    normalizeScenarioConfig,
    pruneTeamOutfield,
    applyTestScenario
} = require('../kernel/core/lib/test_scenarios.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;

function countOutfield(sim, teamKey) {
    return (sim.players || []).filter(
        (p) => p.team === teamKey && p.role !== 'GK' && !p.isSentOff
    ).length;
}

async function main() {
    assert.ok(SCENARIO_CATALOG.length >= 8, 'catalog has scenarios');
    assert.ok(getScenarioDef('throwin'), 'throwin def');
    assert.strictEqual(getScenarioDef('nope'), null);

    const cfg = normalizeScenarioConfig({ id: 'penalty', opponentOutfield: 0 });
    assert.strictEqual(cfg.id, 'penalty');
    assert.strictEqual(cfg.opponentOutfield, 0);
    assert.strictEqual(cfg.kickingTeam, 'A');
    log('PASS catalog + normalize');

    const sim = new Simulator({ seed: 42 });
    await sim.start();
    assert.ok(sim.players.length >= 22, 'full squads after start');

    // Prune opponents to zero outfield, keep GK
    pruneTeamOutfield(sim, 'B', 0, { keepGk: true });
    assert.strictEqual(countOutfield(sim, 'B'), 0);
    assert.ok(sim.players.some((p) => p.team === 'B' && p.role === 'GK' && !p.isSentOff));
    log('PASS pruneTeamOutfield');

    // Re-bootstrap for clean apply tests
    const sim2 = new Simulator({ seed: 77 });
    await sim2.start();
    const rCorner = applyTestScenario(sim2, {
        id: 'corner',
        cornerFlag: 'tr',
        opponentOutfield: 4,
        ownOutfield: 10
    }, MatchStates);
    assert.ok(rCorner.ok);
    assert.strictEqual(sim2.setPieceType, 'corner');
    assert.strictEqual(sim2.matchState, 'corner');
    assert.ok(sim2.ball.owner || sim2.ball.x != null);
    assert.ok(countOutfield(sim2, 'B') <= 4);
    log('PASS corner scenario');

    const sim3 = new Simulator({ seed: 88 });
    await sim3.start();
    const rPen = applyTestScenario(sim3, {
        id: 'penalty',
        opponentOutfield: 0,
        keepOpponentGk: true,
        goalSide: 'right'
    }, MatchStates);
    assert.ok(rPen.ok);
    assert.strictEqual(sim3.setPieceType, 'penalty');
    assert.strictEqual(sim3.matchState, 'penalty');
    assert.strictEqual(countOutfield(sim3, 'B'), 0);
    log('PASS penalty scenario');

    const sim4 = new Simulator({ seed: 99 });
    await sim4.start();
    const rThrow = applyTestScenario(sim4, {
        id: 'throwin',
        throwLine: 'top',
        throwThird: 'center',
        opponentOutfield: 2
    }, MatchStates);
    assert.ok(rThrow.ok);
    assert.strictEqual(sim4.setPieceType, 'throwin');
    assert.strictEqual(sim4.matchState, 'throwin');
    assert.ok(sim4.throwInTaker);
    log('PASS throw-in scenario');

    const sim5 = new Simulator({ seed: 111 });
    await sim5.start();
    const rPass = applyTestScenario(sim5, {
        id: 'pass',
        fieldThird: 'middle',
        opponentOutfield: 1
    }, MatchStates);
    assert.ok(rPass.ok);
    assert.strictEqual(sim5.matchState, 'play');
    assert.ok(sim5.ball.owner, 'pass scenario has ball owner');
    assert.strictEqual(sim5.ball.owner.team, 'A');
    log('PASS pass / possession scenario');

    const sim6 = new Simulator({ seed: 122 });
    await sim6.start();
    const rHead = applyTestScenario(sim6, {
        id: 'header',
        opponentOutfield: 0
    }, MatchStates);
    assert.ok(rHead.ok);
    assert.strictEqual(sim6.matchState, 'play');
    assert.strictEqual(sim6.ball.owner, null);
    assert.ok(sim6.ball.z > 0.5, 'header ball is airborne');
    log('PASS header scenario');

    // Same seed + scenario config must yield identical setup (playbook / ball / taker)
    async function snapshotScenario(seed, raw) {
        const s = new Simulator({ seed });
        await s.start();
        applyTestScenario(s, raw, MatchStates);
        return {
            matchState: s.matchState,
            setPieceType: s.setPieceType,
            playbookId: s.activePlaybook ? s.activePlaybook.id : null,
            ballX: s.ball.x,
            ballY: s.ball.y,
            ballZ: s.ball.z,
            ballVx: s.ball.vx,
            ownerName: s.ball.owner ? s.ball.owner.name : null,
            throwTaker: s.throwInTaker ? s.throwInTaker.name : null,
            wallCount: (s.freekickWallPlayers || []).length,
            outfieldB: countOutfield(s, 'B'),
            rngState: s.rngState
        };
    }

    const cornerCfg = {
        id: 'corner',
        cornerFlag: 'tr',
        opponentOutfield: 4,
        ownOutfield: 10
    };
    const a = await snapshotScenario(413044, cornerCfg);
    const b = await snapshotScenario(413044, cornerCfg);
    assert.deepStrictEqual(a, b, 'same seed → identical corner setup');
    log('PASS determinism corner seed 413044');

    const freekickCfg = {
        id: 'freekick',
        attackDepth: 'edge_box',
        channel: 'center',
        opponentOutfield: 5
    };
    const fa = await snapshotScenario(9001, freekickCfg);
    const fb = await snapshotScenario(9001, freekickCfg);
    assert.deepStrictEqual(fa, fb, 'same seed → identical freekick setup');
    assert.ok(fa.playbookId, 'freekick picks a playbook under seed');
    log('PASS determinism freekick seed 9001');

    const throwCfg = {
        id: 'throwin',
        throwLine: 'top',
        throwThird: 'center',
        opponentOutfield: 2
    };
    const ta = await snapshotScenario(55, throwCfg);
    const tb = await snapshotScenario(55, throwCfg);
    assert.deepStrictEqual(ta, tb, 'same seed → identical throw-in setup');
    log('PASS determinism throw-in seed 55');

    // Different seeds should be allowed to diverge (playbook / jitter)
    const other = await snapshotScenario(9002, freekickCfg);
    // Not required to differ, but rngState after bootstrap+apply almost always does
    assert.ok(other.rngState !== fa.rngState || other.playbookId !== fa.playbookId
        || other.ballX !== fa.ballX,
        'different seeds can diverge');
    log('PASS different seeds diverge');

    const field = Utils.getFieldBounds();
    assert.ok(field.width > 0);
    log('test_scenarios: ALL PASS');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
