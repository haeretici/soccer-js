#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Marking & cover assignments.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const {
    MARK_DEFAULTS,
    markerRoleFitness,
    scoreAttackerThreat,
    computeCoverPoint,
    assignMarkers,
    computeMarkingAssignments,
    resolveOwnGoal
} = require('../kernel/core/lib/marking.js');
const { PositionLayer } = require('../kernel/core/lib/positioning_policy.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function mainUnit() {
    assert.ok(markerRoleFitness('CB') > markerRoleFitness('ST'));
    assert.ok(markerRoleFitness('LB') > markerRoleFitness('AM'));
    assert.strictEqual(markerRoleFitness('GK'), 0);
    log('PASS markerRoleFitness prefers defenders');

    const field = Utils.getFieldBounds();
    const cover = computeCoverPoint(
        { x: field.width * 0.5, y: field.centerY },
        0,
        field.centerY,
        null
    );
    // Stand-off from left goal toward midfield mark → cover.x > 0 and < mark.x
    assert.ok(cover.x > 0.5, `cover off goal line x=${cover.x}`);
    assert.ok(cover.x < field.width * 0.5, `cover short of mark x=${cover.x}`);
    log('PASS computeCoverPoint interposes goal→mark');

    // Deterministic assignment: same inputs → same pairs (within MARK_MAX_ASSIGN_DIST)
    const m1 = { name: 'DEF 1', role: 'CB', x: 20, y: 20, isSentOff: false };
    const m2 = { name: 'DEF 2', role: 'CB', x: 20, y: 40, isSentOff: false };
    const t1 = { name: 'ATK 1', role: 'ST', x: 32, y: 22 };
    const t2 = { name: 'ATK 2', role: 'ST', x: 32, y: 42 };
    const threats = [
        { player: t1, score: 10 },
        { player: t2, score: 9 }
    ];
    const a = assignMarkers({ teamKey: 'A' }, threats, [m1, m2], null, 2);
    const b = assignMarkers({ teamKey: 'A' }, threats, [m1, m2], null, 2);
    assert.strictEqual(a.length, 2);
    assert.strictEqual(a[0].marker, b[0].marker);
    assert.strictEqual(a[0].target, b[0].target);
    assert.strictEqual(a[1].marker, b[1].marker);
    log('PASS assignMarkers deterministic');

    // Stickiness keeps previous when still near-optimal
    const sticky = assignMarkers(
        { teamKey: 'A' },
        threats,
        [m1, m2],
        [{ marker: m1, target: t1 }, { marker: m2, target: t2 }],
        2
    );
    assert.ok(sticky.some(p => p.marker === m1 && p.target === t1));
    assert.ok(sticky.some(p => p.marker === m2 && p.target === t2));
    log('PASS assignment stickiness');

    assert.ok(MARK_DEFAULTS.MARK_MAX_MARKERS >= 1);
}

async function mainSim() {
    const sim = new Simulator({ seed: 202 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();

    // A has ball deep in B half — B defends
    const carrier = sim.teamA.getOutfieldPlayers().find(p => /S|ST|CF|AM|CM/i.test(p.role || ''))
        || sim.teamA.getOutfieldPlayers()[0];
    carrier.x = field.width * 0.68;
    carrier.y = field.centerY * 0.7;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    sim.ball.z = 0;

    // Park free attackers: far-post + late mid
    const attackers = sim.teamA.getOutfieldPlayers().filter(p => p !== carrier);
    if (attackers[0]) {
        attackers[0].x = field.width * 0.78;
        attackers[0].y = field.height * 0.85;
        attackers[0].role = attackers[0].role || 'ST';
    }
    if (attackers[1]) {
        attackers[1].x = field.width * 0.72;
        attackers[1].y = field.height * 0.2;
    }

    sim.teamA.setControllingPlayer(carrier);
    sim.teamA.syncFsmFromMatch();
    sim.teamB.syncFsmFromMatch();
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Defending));

    // Force marking update
    sim.teamB.updateMarking({ force: true });

    assert.ok(sim.teamB.markingPairs.length >= 1, `expected ≥1 mark, got ${sim.teamB.markingPairs.length}`);
    assert.ok(sim.teamB.markingPairs.length <= (Settings.AI.MARK_MAX_MARKERS || 2));
    log(`PASS markingPairs count=${sim.teamB.markingPairs.length}`);

    for (const pair of sim.teamB.markingPairs) {
        assert.ok(pair.marker && pair.target);
        assert.strictEqual(pair.marker.team, 'B');
        assert.strictEqual(pair.target.team, 'A');
        assert.notStrictEqual(pair.target, carrier, 'must not mark the ball carrier');
        assert.ok(sim.teamB.isMarkingPlayer(pair.marker));
        assert.ok(pair.marker.markCoverPoint, 'cover point set');
        // Cover between goal and mark (B defends right in 1st half → goal at width)
        const g = resolveOwnGoal(sim.teamB);
        const cover = pair.marker.markCoverPoint;
        const mark = pair.target;
        const dGoalMark = Math.hypot(mark.x - g.ownGoalX, mark.y - g.ownGoalY);
        const dGoalCover = Math.hypot(cover.x - g.ownGoalX, cover.y - g.ownGoalY);
        assert.ok(dGoalCover < dGoalMark + 0.5, 'cover closer to goal than mark');
    }
    log('PASS markers are B defenders covering A free attackers');

    // Idle target for marker is L5 mark_cover
    const marker = sim.teamB.markingPairs[0].marker;
    marker.level = sim;
    const idle = marker.resolveIdlePosition();
    assert.strictEqual(idle.winningLayer, PositionLayer.ROLE_OVERRIDE);
    assert.strictEqual(idle.mode, 'mark_cover');
    log('PASS marker idle wins L5 mark_cover');

    // Pure computeMarkingAssignments API
    const computed = computeMarkingAssignments(sim.teamB, { force: true });
    assert.ok(computed.pairs.length >= 1);
    log('PASS computeMarkingAssignments');

    // Threat: closer attacker scores higher
    const far = { role: 'ST', x: field.width * 0.3, y: field.centerY, isSentOff: false };
    const near = { role: 'ST', x: field.width * 0.85, y: field.centerY, isSentOff: false };
    const goalX = field.width;
    const sNear = scoreAttackerThreat(near, carrier, sim.teamB, goalX, field.centerY, sim.teamB.getOutfieldPlayers());
    const sFar = scoreAttackerThreat(far, carrier, sim.teamB, goalX, field.centerY, sim.teamB.getOutfieldPlayers());
    assert.ok(sNear > sFar, `near threat ${sNear} > far ${sFar}`);
    log('PASS threat score favors attackers near defending goal');

    // Attacking clears marks
    sim.ball.owner = sim.teamB.getOutfieldPlayers()[0];
    sim.teamB.setControllingPlayer(sim.ball.owner);
    sim.teamB.syncFsmFromMatch();
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Attacking));
    assert.strictEqual(sim.teamB.markingPairs.length, 0);
    log('PASS Attacking clears marking');

    // Regulator soft-refresh doesn't clear when still defending
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    sim.teamB.lostControl();
    sim.teamA.setControllingPlayer(carrier);
    sim.teamB.syncFsmFromMatch();
    sim.teamB.updateMarking({ force: true });
    const n1 = sim.teamB.markingPairs.length;
    assert.ok(n1 >= 1);
    // Not ready: soft refresh keeps pairs
    sim.teamB.markingRegulator.ticksUntilReady = 5;
    sim.teamB.updateMarking({ force: false });
    assert.strictEqual(sim.teamB.markingPairs.length, n1);
    log('PASS regulator soft-refresh keeps pairs');
}

async function main() {
    mainUnit();
    await mainSim();
    log('\nAll marking tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
