#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Goal entity — geometry, Scored segment, Team home/opp wiring.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const {
    Goal,
    GOAL_MOUTH_Y_REF_MIN,
    GOAL_MOUTH_Y_REF_MAX
} = require('../kernel/core/entities/goal.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { getGoalMouthYBounds } = require('../kernel/core/lib/pass_safety.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const field = Utils.getFieldBounds();
    const { left, right } = Goal.createPair(field);

    assert.strictEqual(left.side, 'left');
    assert.strictEqual(left.lineX, 0);
    assert.strictEqual(left.facingX, 1);
    assert.strictEqual(right.lineX, field.width);
    assert.strictEqual(right.facingX, -1);
    assert.ok(left.yMin < left.yMax);
    assert.ok(Math.abs(left.yMin - Utils.scaleFieldY(GOAL_MOUTH_Y_REF_MIN)) < 1e-6);
    assert.ok(Math.abs(left.yMax - Utils.scaleFieldY(GOAL_MOUTH_Y_REF_MAX)) < 1e-6);
    assert.strictEqual(left.center.y, (left.yMin + left.yMax) * 0.5);
    log('PASS Goal.createPair geometry');

    // Segment crosses left mouth
    const ballIn = {
        prevX: 1.0,
        prevY: field.centerY,
        prevZ: 0.5,
        x: -0.5,
        y: field.centerY,
        z: 0.5
    };
    assert.ok(left.scored(ballIn), 'left scored on segment through mouth');
    assert.ok(left.isGoalEvent(ballIn));
    assert.ok(!right.scored(ballIn));
    log('PASS Scored segment through left mouth');

    // Wide of post — not a goal
    const wide = {
        prevX: 1.0,
        prevY: left.yMin - 5,
        prevZ: 0,
        x: -0.5,
        y: left.yMin - 5,
        z: 0
    };
    assert.ok(!left.scored(wide));
    assert.ok(!left.isGoalEvent(wide));
    log('PASS Scored rejects wide of post');

    // Path crosses goal line outside posts, then ends inside mouth — NOT a goal
    // (old volume fallback falsely awarded this as a goal).
    const wideThenIn = {
        prevX: 0.5,
        prevY: 10,
        prevZ: 0,
        x: -0.3,
        y: left.center.y,
        z: 0
    };
    assert.ok(!left.scored(wideThenIn), 'wide-then-in must not score via segment');
    assert.ok(!left.isGoalEvent(wideThenIn), 'wide-then-in must not score via isGoalEvent');
    log('PASS rejects exterior path that ends in mouth');

    // Motion from inside the net toward the line — not a new goal
    const fromNet = {
        prevX: -2,
        prevY: left.center.y,
        prevZ: 0.5,
        x: 0,
        y: left.center.y,
        z: 0.5
    };
    assert.ok(!left.scored(fromNet), 'from-net motion must not score');
    assert.ok(!left.isGoalEvent(fromNet));
    log('PASS rejects scoring from inside/behind net');

    // Over the bar (whole segment above bar height)
    const over = {
        prevX: 1.0,
        prevY: field.centerY,
        prevZ: left.height + 1,
        x: -0.5,
        y: field.centerY,
        z: left.height + 1
    };
    assert.ok(!left.scored(over));
    assert.ok(!left.isGoalEvent(over));
    log('PASS Scored rejects over bar');

    // Right goal segment
    const rightShot = {
        prevX: field.width - 1,
        prevY: field.centerY,
        prevZ: 0,
        x: field.width + 0.4,
        y: field.centerY,
        z: 0
    };
    assert.ok(right.scored(rightShot));
    assert.ok(right.isGoalEvent(rightShot));
    log('PASS Scored segment through right mouth');

    // Posts bounce a free ball on the pitch side (no phase-through)
    const hitPost = {
        owner: null,
        radius: 0.11,
        x: 0.05,
        y: left.yMin,
        z: 0.5,
        vx: -8,
        vy: 0,
        vz: 0,
        prevX: 0.4,
        prevY: left.yMin,
        prevZ: 0.5
    };
    assert.ok(left.resolveBallCollisions(hitPost), 'post contact resolved');
    assert.ok(hitPost.x > 0, 'ball stays on pitch side of left goal after post hit');
    assert.ok(hitPost.vx >= 0, 'ball rebounds away from net after post hit');
    log('PASS post bounce keeps ball outside');

    // Exterior back-net: ball coming from behind cannot enter mouth volume
    const back = left.netBackX();
    const fromBehind = {
        owner: null,
        radius: 0.11,
        x: back - 0.05,
        y: left.center.y,
        z: 1,
        vx: 6,
        vy: 0,
        vz: 0,
        prevX: back - 1,
        prevY: left.center.y,
        prevZ: 1
    };
    left.resolveBallCollisions(fromBehind);
    assert.ok(
        !left.isInMouthVolume(fromBehind.x, fromBehind.y, fromBehind.z),
        'ball from behind net stays outside mouth volume'
    );
    assert.ok(!left.isGoalEvent(fromBehind), 'exterior back contact is not a goal');
    log('PASS exterior back net rejects entry');

    // Distance helper
    const d = left.distanceTo(field.centerX, field.centerY);
    assert.ok(d > 0);
    log('PASS distanceTo');

    // Mouth samples for CanShoot
    const samples = left.sampleMouthTargets(3, () => 0.5, 0);
    assert.ok(samples.length >= 3);
    assert.ok(samples.every(t => t.x === 0 && t.y >= left.yMin && t.y <= left.yMax));
    log('PASS sampleMouthTargets');

    // pass_safety bounds align with Goal
    const bounds = getGoalMouthYBounds(field, left);
    assert.ok(bounds.yMin >= left.yMin);
    assert.ok(bounds.yMax <= left.yMax);
    log('PASS getGoalMouthYBounds(goal)');

    // Simulator + Team wiring
    const sim = new Simulator();
    await sim.start();
    assert.ok(sim.pitch.leftGoal, 'pitch.leftGoal');
    assert.ok(sim.pitch.rightGoal, 'pitch.rightGoal');
    assert.ok(sim.teamA.getHomeGoal() === sim.pitch.leftGoal, 'A home left 1st half');
    assert.ok(sim.teamA.getOpponentsGoal() === sim.pitch.rightGoal, 'A opp right 1st half');
    assert.ok(sim.teamB.getHomeGoal() === sim.pitch.rightGoal, 'B home right 1st half');
    assert.strictEqual(sim.teamA.getOpponentsGoalX(), field.width);
    assert.strictEqual(sim.teamB.getOpponentsGoalX(), 0);

    const distA = sim.teamA.distToOpponentsGoal(field.centerX, field.centerY);
    assert.ok(distA > 0);
    log('PASS Team homeGoal / opponentsGoal 1st half');

    // Force 2nd half bookkeeping and rewire
    sim.matchTimer = 2700;
    sim.halfTimeTriggered = true;
    sim.swapSides();
    assert.ok(sim.isSecondHalf());
    assert.ok(sim.teamA.getHomeGoal() === sim.pitch.rightGoal, 'A home right 2nd half');
    assert.ok(sim.teamA.getOpponentsGoal() === sim.pitch.leftGoal, 'A opp left 2nd half');
    log('PASS Team goals swap after HT');

    // Live scoring via checkBallCollisions (right goal, 1st-half B scores... after HT A scores left)
    // Reset to 1st half for a clean goal event
    const sim2 = new Simulator();
    await sim2.start();
    sim2.fsm.setCurrentState(MatchStates.Play);
    const gR = sim2.pitch.rightGoal;
    sim2.ball.owner = null;
    sim2.ball.prevX = field.width - 1;
    sim2.ball.prevY = field.centerY;
    sim2.ball.prevZ = 0;
    sim2.ball.x = field.width + 0.5;
    sim2.ball.y = field.centerY;
    sim2.ball.z = 0;
    const beforeA = sim2.scoreA;
    const beforeB = sim2.scoreB;
    sim2.checkBallCollisions();
    assert.strictEqual(sim2.matchState, 'goal');
    assert.strictEqual(sim2.goalScoredTeam, 'A'); // 1st half right goal → A
    assert.ok(sim2.scoreA === beforeA + 1 || sim2.scoreB === beforeB + 1);
    assert.strictEqual(sim2.scoreA, beforeA + 1);
    log('PASS checkBallCollisions uses Goal.isGoalEvent');

    // Wide OOB → goalkick / corner (not goal)
    const sim3 = new Simulator();
    await sim3.start();
    sim3.fsm.setCurrentState(MatchStates.Play);
    sim3.lastTouchPlayer = sim3.players.find(p => p.team === 'A' && p.role !== 'GK');
    sim3.ball.owner = null;
    sim3.ball.prevX = 1;
    sim3.ball.prevY = -2;
    sim3.ball.x = -0.5;
    sim3.ball.y = -2;
    sim3.ball.z = 0;
    sim3.checkBallCollisions();
    assert.ok(sim3.matchState === 'corner' || sim3.matchState === 'goalkick',
        `expected set piece, got ${sim3.matchState}`);
    assert.notStrictEqual(sim3.matchState, 'goal');
    log('PASS OOB past goal line without mouth → set piece');

    // Exterior path that ends in mouth volume → set piece, never goal
    const sim4 = new Simulator();
    await sim4.start();
    sim4.fsm.setCurrentState(MatchStates.Play);
    sim4.lastTouchPlayer = sim4.players.find(p => p.team === 'A' && p.role !== 'GK');
    const gL = sim4.pitch.leftGoal;
    sim4.ball.owner = null;
    sim4.ball.prevX = 0.5;
    sim4.ball.prevY = 10;
    sim4.ball.prevZ = 0;
    sim4.ball.x = -0.3;
    sim4.ball.y = gL.center.y;
    sim4.ball.z = 0;
    const scoreBefore = sim4.scoreA + sim4.scoreB;
    sim4.checkBallCollisions();
    assert.notStrictEqual(sim4.matchState, 'goal', 'exterior mouth entry must not goal');
    assert.strictEqual(sim4.scoreA + sim4.scoreB, scoreBefore, 'score unchanged');
    assert.ok(sim4.matchState === 'corner' || sim4.matchState === 'goalkick',
        `expected set piece after exterior path, got ${sim4.matchState}`);
    log('PASS exterior path into mouth volume → set piece not goal');

    log('\nAll goal entity tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
