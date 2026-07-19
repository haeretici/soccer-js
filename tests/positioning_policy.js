#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Positioning layer policy stack + idle resolve.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const {
    PositionLayer,
    POSITION_STACK_DOC,
    layerFormationBase,
    layerRegionHome,
    layerDepthHold,
    resolveIdleMoveTarget,
    isPositionTraceEnabled
} = require('../kernel/core/lib/positioning_policy.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function mainUnit() {
    assert.strictEqual(POSITION_STACK_DOC.length, 5);
    assert.strictEqual(POSITION_STACK_DOC[0].id, PositionLayer.FORMATION_BASE);
    assert.strictEqual(POSITION_STACK_DOC[4].id, PositionLayer.ROLE_OVERRIDE);
    log('PASS POSITION_STACK_DOC order L1–L5');

    const fake = {
        formationBaseX: 10,
        formationBaseY: 20,
        baseX: 12,
        baseY: 22,
        homeRegionId: 5
    };
    const l1 = layerFormationBase(fake);
    assert.strictEqual(l1.x, 10);
    assert.strictEqual(l1.y, 20);
    assert.strictEqual(l1.id, PositionLayer.FORMATION_BASE);
    const l2 = layerRegionHome(fake);
    assert.strictEqual(l2.x, 12);
    assert.strictEqual(l2.y, 22);
    assert.strictEqual(l2.homeRegionId, 5);
    log('PASS layerFormationBase / layerRegionHome');

    Settings.debugAI = { enabled: false, positionTrace: true };
    assert.strictEqual(isPositionTraceEnabled(), false);
    Settings.debugAI.enabled = true;
    assert.strictEqual(isPositionTraceEnabled(), true);
    log('PASS isPositionTraceEnabled needs master + flag');
}

async function mainSim() {
    const sim = new Simulator({ seed: 101 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();

    // --- Formation target = L3 via getTargetFormationPos ---
    const mid = sim.teamA.getOutfieldPlayers().find(p => /CM|LCM|RCM|AM/i.test(p.role || ''))
        || sim.teamA.getOutfieldPlayers()[0];
    mid.level = sim;
    const form = mid.getTargetFormationPos();
    const l3 = layerDepthHold(mid, sim.teamA, sim.ball);
    assert.ok(Math.abs(form.x - l3.x) < 1e-6, 'getTargetFormationPos matches layerDepthHold X');
    assert.ok(Math.abs(form.y - l3.y) < 1e-6, 'getTargetFormationPos matches layerDepthHold Y');
    log('PASS getTargetFormationPos ≡ L3 depth+hold');

    // --- Own possession: non-supporter uses L4 attack support ---
    const carrier = sim.teamA.getOutfieldPlayers().find(p => /S|ST|CF|AM/i.test(p.role || ''))
        || sim.teamA.getOutfieldPlayers()[0];
    carrier.x = field.width * 0.62;
    carrier.y = field.centerY;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    sim.ball.z = 0;
    sim.teamA.setControllingPlayer(carrier);
    sim.teamA.syncFsmFromMatch();
    assert.ok(sim.teamA.fsm.isInState(TeamStates.Attacking));

    const mate = sim.teamA.getOutfieldPlayers().find(p => p !== carrier && p.role !== 'GK');
    mate.level = sim;
    // Ensure this mate is NOT primary supporter (if assigned, pick another)
    let laneMate = mate;
    if (sim.teamA.supportingPlayer === mate) {
        laneMate = sim.teamA.getOutfieldPlayers().find(
            p => p !== carrier && p !== mate && p.role !== 'GK'
        ) || mate;
    }
    // Force clear support assignment for a pure L4 check when possible
    if (sim.teamA.supportingPlayer === laneMate) {
        sim.teamA.supportingPlayer = null;
    }
    const atk = laneMate.resolveIdlePosition();
    assert.ok(
        atk.winningLayer === PositionLayer.BALL_SHAPE
            || atk.winningLayer === PositionLayer.DEPTH_HOLD
            || atk.winningLayer === PositionLayer.ROLE_OVERRIDE,
        `attack idle layer=${atk.winningLayer} mode=${atk.mode}`
    );
    assert.ok(atk.layers.length >= 3, 'trace includes foundation layers');
    assert.ok(atk.layers.some(l => l.id === PositionLayer.FORMATION_BASE));
    assert.ok(atk.layers.some(l => l.id === PositionLayer.DEPTH_HOLD));
    log(`PASS attack idle resolve mode=${atk.mode} layer=${atk.winningLayer}`);

    // --- Primary supporter → L5 support_spot ---
    sim.teamA.updateSupportSpots({ force: true });
    const supporter = sim.teamA.supportingPlayer;
    if (supporter) {
        supporter.level = sim;
        const sup = supporter.resolveIdlePosition();
        assert.strictEqual(sup.winningLayer, PositionLayer.ROLE_OVERRIDE);
        assert.strictEqual(sup.mode, 'support_spot');
        const spot = sim.teamA.getBestSupportSpot();
        assert.ok(spot);
        assert.ok(Math.abs(sup.x - spot.x) < 0.5);
        assert.ok(Math.abs(sup.y - spot.y) < 0.5);
        log('PASS primary supporter wins L5 support_spot');
    } else {
        log('SKIP primary supporter (none assigned)');
    }

    // --- Opponent possession → L4 defend mid-block (near ball; far players use L3 hold) ---
    const opp = sim.teamB.getOutfieldPlayers()[0];
    opp.x = field.width * 0.55;
    opp.y = field.centerY;
    sim.ball.owner = opp;
    sim.ball.x = opp.x;
    sim.ball.y = opp.y;
    sim.teamA.lostControl();
    sim.teamA.syncFsmFromMatch();
    sim.teamB.syncFsmFromMatch();
    const defP = sim.teamA.getOutfieldPlayers()[0];
    defP.level = sim;
    // Place defender within mid-block range of the ball
    defP.x = opp.x - Utils.scaleFieldX(8);
    defP.y = opp.y + Utils.scaleFieldY(2);
    const def = defP.resolveIdlePosition();
    assert.strictEqual(def.winningLayer, PositionLayer.BALL_SHAPE);
    assert.strictEqual(def.mode, 'defend_mid_block');
    const shape = defP.getDefensiveShapePos();
    assert.ok(Math.abs(def.x - shape.x) < 1e-6);
    assert.ok(Math.abs(def.y - shape.y) < 1e-6);
    log('PASS defend idle = L4 mid-block via getDefensiveShapePos');

    // --- Loose ball nearby → L5 intercept ---
    sim.ball.owner = null;
    sim.ball.z = 0.1;
    const claimer = sim.teamA.getOutfieldPlayers()[0];
    claimer.level = sim;
    claimer.x = sim.ball.x + 0.3;
    claimer.y = sim.ball.y;
    const loose = claimer.resolveIdlePosition();
    assert.strictEqual(loose.winningLayer, PositionLayer.ROLE_OVERRIDE);
    assert.strictEqual(loose.mode, 'loose_intercept');
    log('PASS loose nearby → L5 loose_intercept');

    // --- getIdleMoveTarget matches resolve coords; attach only when debug on ---
    Settings.debugAI = { enabled: true, positionTrace: false };
    claimer._positionTrace = null;
    const idleOnly = claimer.getIdleMoveTarget();
    assert.ok(idleOnly.x != null && idleOnly.y != null);
    assert.strictEqual(claimer._positionTrace, null, 'no attach when positionTrace off');

    Settings.debugAI.positionTrace = true;
    const idleDbg = claimer.getIdleMoveTarget();
    assert.ok(claimer._positionTrace);
    assert.strictEqual(claimer._positionTrace.x, idleDbg.x);
    assert.strictEqual(claimer.debugPositionLayer, claimer._positionTrace.winningLayer);
    log('PASS getIdleMoveTarget + optional attachPositionTrace');

    // Pure resolveIdleMoveTarget: hot path skips layers unless trace:true
    const bareHot = resolveIdleMoveTarget(mid, {
        getTeam: () => sim.teamA
    });
    assert.ok(bareHot.winningLayer);
    assert.ok(!bareHot.layers || bareHot.layers.length === 0);
    const bare = resolveIdleMoveTarget(mid, {
        getTeam: () => sim.teamA,
        trace: true
    });
    assert.ok(bare.layers.length >= 3);
    assert.ok(bare.winningLayer);
    log('PASS resolveIdleMoveTarget bare API (hot + trace)');
}

async function main() {
    mainUnit();
    await mainSim();
    log('\nAll positioning_policy tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
