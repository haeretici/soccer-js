#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * A.6 Free-kick walls — geometry, hold, jump-on-kick, fixed-body safety, ball contact.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Time, LOGIC_DT } = require('../kernel/core/lib/time.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { resumeSetPieceToPlay } = require('../kernel/providers/simulator/set_piece_resume.js');
const { PlayerStates } = require('../kernel/core/entities/player.js');
const {
    buildWallPositions,
    assignWallPlayers,
    clearWallPlayers,
    triggerWallJump,
    updateWallJumps,
    canShootPastWall,
    tryBallWallCollisions,
    releaseWallOnPass,
    releaseWallOnShotKick,
    pruneFreekickWall,
    applyWallHold,
    snapWallToHold,
    estimateBallHeightAtTime,
    isLaneSafePastWallBody,
    WALL_JUMP_VZ_DEFAULT
} = require('../kernel/core/lib/freekick_wall.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function testBuildWallPositions() {
    const field = Utils.getFieldBounds();
    const s = (v) => Utils.scaleFieldX(v);
    const bx = field.centerX;
    const by = field.centerY;
    const wallDist = s(10.9375);
    const spacing = s(0.875);

    const pos3 = buildWallPositions(bx, by, 1, 0, 3, wallDist, spacing);
    assert.strictEqual(pos3.length, 3);
    assert.ok(Math.abs(pos3[1].x - (bx + wallDist)) < 0.01);
    assert.ok(Math.abs(pos3[0].y - (by - spacing)) < 0.01);
    assert.ok(Math.abs(pos3[2].y - (by + spacing)) < 0.01);

    const pos1 = buildWallPositions(bx, by, 1, 0, 1, wallDist, spacing);
    assert.strictEqual(pos1.length, 1);

    const pos5 = buildWallPositions(bx, by, 1, 0, 5, wallDist, spacing);
    assert.strictEqual(pos5.length, 5);
    log('PASS buildWallPositions');
}

function testAssignAndClear() {
    const field = Utils.getFieldBounds();
    const s = (v) => Utils.scaleFieldX(v);
    const positions = buildWallPositions(field.centerX, field.centerY, 1, 0, 3, s(10.9375), s(0.875));
    const defenders = [];
    for (let i = 0; i < 5; i++) {
        defenders.push({
            x: field.centerX + s(10) + i,
            y: field.centerY + i * 0.2,
            isInWall: false
        });
    }
    const assigned = assignWallPlayers(defenders, positions, (v) => v, (v) => v);
    assert.strictEqual(assigned.length, 3);
    for (const wp of assigned) {
        assert.strictEqual(wp.isInWall, true);
        assert.ok(wp.wallHoldX != null && wp.wallHoldY != null);
    }
    clearWallPlayers(assigned);
    for (const wp of assigned) {
        assert.strictEqual(wp.isInWall, false);
        assert.strictEqual(wp.wallHoldX, null);
    }
    log('PASS assign + clear + hold anchors');
}

function testJumpOnKickTiming() {
    const player = {
        isInWall: true, wallJumpTimer: 0, wallJumpActive: false,
        wallJumpVz: 0, z: 0, wallHoldX: 10, wallHoldY: 10, frame: 0
    };
    // Immediate jump (trigger delay 0)
    triggerWallJump([player], 0);
    assert.strictEqual(player.wallJumpActive, true, 'delay 0 starts jump immediately');
    assert.ok(player.wallJumpVz > 0);
    assert.strictEqual(applyWallHold(player), true, 'hold during jump');
    assert.strictEqual(player.frame, 10, 'airborne wall uses jump pose');
    assert.strictEqual(player.x, 10);
    assert.strictEqual(player.y, 10);

    // Land after enough steps
    let steps = 0;
    while (player.wallJumpActive && steps < 100) {
        updateWallJumps([player], 0.05);
        steps++;
    }
    assert.strictEqual(player.z, 0);
    assert.strictEqual(player.isInWall, false);
    assert.strictEqual(player.wallHoldX, null);
    log('PASS jump on kick (delay 0) + land clears hold');
}

function testFixedBodyAndOverWall() {
    const field = Utils.getFieldBounds();
    const s = (v) => Utils.scaleFieldX(v);
    const ballPos = { x: field.width - s(20), y: field.centerY };
    const shooter = {
        team: 'A', stats: { shooting: 70 },
        staminaMultiplier: 1,
        level: { isSecondHalf: () => false }
    };
    const oppGoalX = field.width;
    const wallX = ballPos.x + s(10.9375);

    // Dense wall — centre sample blocked on ground
    const dense = [];
    for (let i = -2; i <= 2; i++) {
        dense.push({
            x: wallX,
            y: field.centerY + i * s(0.875),
            isInWall: true,
            isSentOff: false,
            stats: { speed: 99 },
            staminaMultiplier: 1
        });
    }
    // Centre only: ground blocked; chip-over may still be ok with heightSpeed
    const centre = canShootPastWall(ballPos, shooter, dense, [], {
        oppGoalX, field, sampleYs: [field.centerY], random: () => 0.5
    });
    if (centre.ok) {
        assert.ok(centre.heightSpeed != null && centre.heightSpeed > 1, 'centre needs chip heightSpeed');
    } else {
        // If chip cannot clear at this distance, blocked is also valid
        assert.strictEqual(centre.ok, false);
    }

    // Full mouth samples: prefer around-wall (heightSpeed null) before chip
    const around = canShootPastWall(ballPos, shooter, dense, [], {
        oppGoalX, field, random: () => 0.5
    });
    assert.ok(around.ok, 'finds a path (around or over)');
    // Driven around-wall should win first when corners open
    if (around.heightSpeed == null) {
        assert.ok(around.target && Math.abs(around.target.y - field.centerY) > 1, 'around not dead centre');
    }

    // Fixed body: maxSpeed 0 — fast wall player still blocks only by body radius
    const one = dense[2];
    assert.strictEqual(
        isLaneSafePastWallBody(ballPos, { x: oppGoalX, y: field.centerY }, one, 17),
        false,
        'body blocks centre lane'
    );

    // Chip height: FREEKICK_CHIP_VZ (~7.5) clears stand height near apex
    const z = estimateBallHeightAtTime(7.5, 0.35);
    assert.ok(z > 1.15, `chip height ${z}`);

    log('PASS fixed-body safety + around wall + height estimate');
}

function testBallWallCollision() {
    const wall = [{
        x: 40, y: 25, isInWall: true, isSentOff: false,
        wallJumpActive: false
    }];
    const ball = {
        owner: null, x: 40.3, y: 25, z: 0.2,
        vx: -8, vy: 0, vz: 0, radius: 0.25
    };
    const hit = tryBallWallCollisions(ball, wall);
    assert.ok(hit, 'low ball collides with wall body');
    assert.ok(ball.vx > -8 || Math.abs(ball.x - 40) > 0.3, 'ball deflected');

    // High ball flies over
    const ballHigh = {
        owner: null, x: 40.3, y: 25, z: 2.5,
        vx: -8, vy: 0, vz: 0, radius: 0.25
    };
    assert.strictEqual(tryBallWallCollisions(ballHigh, wall), false, 'high ball clears wall');
    log('PASS ball-wall collision');
}

async function testSimulatorHoldAndResume() {
    const sim = new Simulator({ seed: 99 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();

    sim.setPieceX = field.width * 0.7;
    sim.setPieceY = field.centerY;
    sim.setPieceSide = 'right';
    sim.setPieceType = 'freekick';
    sim.setPieceKickingTeam = 'A';
    sim.setupSetPiecePositions('freekick', 'right', 'A');

    assert.ok(sim.freekickWallPlayers.length >= 2, `wall formed (${sim.freekickWallPlayers.length})`);
    const wallSnap = sim.freekickWallPlayers.map((p) => ({
        p,
        holdX: p.wallHoldX,
        holdY: p.wallHoldY,
        startX: p.x,
        startY: p.y
    }));
    for (const { p, holdX, holdY, startX, startY } of wallSnap) {
        assert.ok(p.isInWall);
        assert.ok(holdX != null && holdY != null);
        // Walk-back leaves players off the line until resume snap
        assert.ok(
            Math.hypot(startX - holdX, startY - holdY) > 0.05 || p.isWalkingToSetPiece,
            'wall starts away from hold or walking'
        );
    }

    // Leave someone mid-walk (simulates short freekick timer)
    for (const { p } of wallSnap) {
        p.isWalkingToSetPiece = true;
        p.setPieceTarget = { x: p.wallHoldX, y: p.wallHoldY };
        p.x = p.wallHoldX - 3;
        p.y = p.wallHoldY + 2;
    }

    // Put taker into Pass via resume — wall snaps to hold then freezes until kick
    const taker = sim.players.find((p) => p.team === 'A' && p.role !== 'GK' && !p.isSentOff);
    sim.ball.x = sim.setPieceX;
    sim.ball.y = sim.setPieceY;
    sim.ball.owner = taker;
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.activePlaybook = {
        id: 'short_lay_off',
        type: 'freekick',
        def: { wallSize: 'auto', kick: { prefer: 'pass', passType: 'short', shootChance: 0 } }
    };
    resumeSetPieceToPlay(sim, 'freekick');

    assert.ok(sim.freekickWallPlayers.length > 0, 'wall held after resume into Pass/Shoot');
    for (const { p, holdX, holdY } of wallSnap) {
        assert.strictEqual(p.isWalkingToSetPiece, false, 'walk cleared on resume snap');
        assert.strictEqual(p.setPieceTarget, null);
        assert.ok(Math.abs(p.x - holdX) < 1e-6 && Math.abs(p.y - holdY) < 1e-6, 'snapped to hold');
        Time.deltaTime = LOGIC_DT;
        p.update();
        assert.ok(Math.abs(p.x - holdX) < 0.05 && Math.abs(p.y - holdY) < 0.05, 'hold freezes after snap');
    }

    // Unit: snapWallToHold alone
    const lone = {
        isInWall: true,
        wallHoldX: 50,
        wallHoldY: 25,
        x: 40,
        y: 10,
        isWalkingToSetPiece: true,
        setPieceTarget: { x: 50, y: 25 },
        vx: 1,
        vy: 1,
        z: 0.5
    };
    snapWallToHold({ freekickWallPlayers: [lone] });
    assert.strictEqual(lone.x, 50);
    assert.strictEqual(lone.y, 25);
    assert.strictEqual(lone.isWalkingToSetPiece, false);

    // Pass path: release wall on releaseWallOnPass
    releaseWallOnPass(sim);
    assert.strictEqual(sim.freekickWallPlayers.length, 0, 'pass clears wall list');
    for (const { p } of wallSnap) {
        assert.strictEqual(p.isInWall, false);
    }

    // Rebuild wall for shot-kick path
    sim.setPieceType = 'freekick';
    sim.setupSetPiecePositions('freekick', 'right', 'A');
    assert.ok(sim.freekickWallPlayers.length > 0);
    releaseWallOnShotKick(sim);
    const jumping = sim.freekickWallPlayers.filter((p) => p.wallJumpActive || p.wallJumpTimer > 0 || p.isInWall);
    assert.ok(jumping.length > 0, 'shot kick arms jump');
    // Run jumps to completion
    for (let i = 0; i < 80; i++) {
        updateWallJumps(sim.freekickWallPlayers, LOGIC_DT);
        pruneFreekickWall(sim);
        if (!sim.freekickWallPlayers.length) break;
    }
    assert.strictEqual(sim.freekickWallPlayers.length, 0, 'wall pruned after jump lands');

    // No wall in attacking own half
    sim.setPieceX = field.width * 0.25;
    sim.setPieceY = field.centerY;
    sim.setupSetPiecePositions('freekick', 'left', 'A');
    assert.strictEqual(sim.freekickWallPlayers.length, 0, 'no wall in own half');

    sim.resetMatchStateCounters();
    assert.strictEqual(sim.freekickWallPlayers.length, 0);

    log('PASS simulator hold / pass clear / shot jump / prune');
}

async function main() {
    testBuildWallPositions();
    testAssignAndClear();
    testJumpOnKickTiming();
    testFixedBodyAndOverWall();
    testBallWallCollision();
    await testSimulatorHoldAndResume();
    log('freekick_wall: ALL PASS');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
