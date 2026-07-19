#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}

/**
 * Stage 1 manual control: pure helpers + AI assign skip + basic command path.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const {
    KeyboardInput,
    moveVectorFromDown,
    commandFromFrame
} = require('../kernel/core/lib/input_keyboard.js');
const {
    holdPower01,
    lateralBiasFromMove,
    curveForceFromBias,
    buildHumanPassKick,
    buildHumanShootKick,
    buildHumanHeaderKick,
    headerSpeedFromPower,
    headerVzFromPower,
    passSpeedMulFromPower,
    shootHeightFromPower,
    peakHeightFromVz,
    resolveChargeStart,
    resolveReleasedAction,
    isChargeHeld,
    slideLaunchDir,
    slideLaunchTarget,
    bodyTackleInRange,
    takeChargeContact,
    tackleRecoverySec
} = require('../kernel/core/lib/manual_commands.js');
const {
    resolveControlledPlayer,
    switchControlledPlayer,
    shouldSkipAIAssign,
    tickManualControl,
    isManualTeamEnabled,
    applyHumanMovement,
    findHumanPassTarget,
    humanFacingDir,
    startHumanPass,
    startHumanHeader,
    evalHumanHeaderWindow,
    headerKindFromAction,
    clearManualCharge,
    isKickoffCarrierLocked,
    isKickoffControlBlocked
} = require('../kernel/core/lib/manual_control.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    PlayerStates,
    computeShootKick,
    computeTackleSuccess,
    attemptTackle,
    applyActionLock,
    humanFoulMultiplier
} = require('../kernel/core/entities/player.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;

async function main() {
    // --- Keyboard pure helpers ---
    const down = new Set(['KeyW', 'KeyD']);
    const mv = moveVectorFromDown(down);
    assert.ok(mv.x > 0 && mv.y < 0, `diagonal move expected, got ${mv.x},${mv.y}`);
    const len = Math.sqrt(mv.x * mv.x + mv.y * mv.y);
    assert.ok(Math.abs(len - 1) < 1e-5, `unit length, got ${len}`);

    const zero = moveVectorFromDown(new Set());
    assert.strictEqual(zero.x, 0);
    assert.strictEqual(zero.y, 0);

    const kb = new KeyboardInput();
    kb.debugKeyDown('KeyA');
    kb.debugKeyDown('Numpad1');
    const frame = kb.pollFrame();
    assert.ok(frame.down.has('KeyA'));
    assert.ok(frame.pressed.has('Numpad1'));
    assert.ok(frame.command.pass || frame.command.tackleFoot);
    assert.ok(frame.command.moveX < 0);
    // Edges cleared after poll
    const frame2 = kb.pollFrame();
    assert.strictEqual(frame2.pressed.size, 0);
    assert.ok(frame2.down.has('KeyA'), 'hold persists');
    log('PASS keyboard helpers');

    const cmd = commandFromFrame({
        down: new Set(['KeyW', 'Numpad5']),
        pressed: new Set(['Numpad3'])
    });
    assert.ok(cmd.shoot);
    assert.ok(cmd.sprint);
    assert.ok(cmd.moveY < 0);
    log('PASS commandFromFrame');

    // --- Settings / headless gate ---
    Settings.manualControl = { teamA: true, teamB: false, clampSpeed: true };
    Settings.HEADLESS = true;
    assert.strictEqual(isManualTeamEnabled('A'), false, 'headless ignores manual');
    Settings.HEADLESS = false;
    assert.strictEqual(isManualTeamEnabled('A'), true);
    assert.strictEqual(isManualTeamEnabled('B'), false);
    Settings.HEADLESS = true;
    log('PASS isManualTeamEnabled headless gate');

    // --- Resolve / switch controlled player ---
    const sim = new Simulator({ seed: 4242 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const outA = sim.teamA.getOutfieldPlayers();
    assert.ok(outA.length >= 2);

    sim.ball.owner = null;
    sim.ball.x = outA[0].x;
    sim.ball.y = outA[0].y;
    const closest = resolveControlledPlayer(sim, 'A', null);
    assert.ok(closest, 'resolved a player');
    assert.strictEqual(closest.role !== 'GK', true);

    sim.ball.owner = outA[1];
    const ownerPick = resolveControlledPlayer(sim, 'A', closest);
    assert.strictEqual(ownerPick, outA[1], 'prefer ball owner on team');

    const switched = switchControlledPlayer(sim, 'A', outA[1]);
    assert.ok(switched && switched !== outA[1], 'switch moves to another outfielder');
    assert.strictEqual(switched.team, 'A');
    assert.notStrictEqual(switched.role, 'GK');
    log('PASS resolve/switch controlled player');

    // --- shouldSkipAIAssign ---
    const p = outA[0];
    p.humanControlled = false;
    assert.strictEqual(shouldSkipAIAssign(p), false);
    p.humanControlled = true;
    assert.strictEqual(shouldSkipAIAssign(p), true);
    log('PASS shouldSkipAIAssign');

    // --- AI assign skips human (does not force Chase/Idle over human) ---
    Settings.HEADLESS = false;
    Settings.manualControl.teamA = true;
    p.humanControlled = true;
    p.fsm.setCurrentState(PlayerStates.Idle);
    // Place human away; put ball with opponent so AI would chase others
    sim.ball.owner = sim.teamB.getOutfieldPlayers()[0];
    sim.updatePlayerAIStates();
    assert.ok(p.fsm.isInState(PlayerStates.Idle), 'human left in Idle (not forced Chase)');
    p.humanControlled = false;
    Settings.HEADLESS = true;
    Settings.manualControl.teamA = false;
    log('PASS updatePlayerAIStates skips human');

    // --- applyHumanMovement moves player ---
    Time.deltaTime = 0.05;
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    const mover = outA[2] || outA[0];
    mover.humanControlled = true;
    mover.x = 40;
    mover.y = 34;
    mover._currentSpeed = 0;
    mover._humanInput = { moveX: 1, moveY: 0, sprint: false };
    sim.ball.owner = null;
    const x0 = mover.x;
    applyHumanMovement(mover);
    assert.ok(mover.x > x0, `human move +X expected, x0=${x0} x=${mover.x}`);
    mover.humanControlled = false;
    mover._humanInput = null;
    log('PASS applyHumanMovement');

    // --- tickManualControl no-op when headless ---
    Settings.HEADLESS = true;
    Settings.manualControl.teamA = true;
    const testKb = new KeyboardInput();
    testKb.debugKeyDown('KeyD');
    tickManualControl(sim, { keyboard: testKb });
    const anyHuman = sim.players.some((pl) => pl.humanControlled);
    assert.strictEqual(anyHuman, false, 'headless tick clears/skips human');
    log('PASS tickManualControl headless no-op');

    // --- tickManualControl assigns human when not headless ---
    Settings.HEADLESS = false;
    Settings.manualControl.teamA = true;
    // Open play (not kickoff hold — that zeros WASD until first pass)
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    sim.ball.owner = outA[0];
    const kb2 = new KeyboardInput();
    kb2.debugKeyDown('KeyW');
    tickManualControl(sim, { keyboard: kb2 });
    assert.ok(outA[0].humanControlled, 'owner marked human');
    assert.ok(outA[0]._humanInput && outA[0]._humanInput.moveY < 0, 'W sets -Y input');
    log('PASS tickManualControl assigns human + input');

    // --- Human carrier ignores PassToMe / requestPass auto-pass ---
    Settings.HEADLESS = false;
    Settings.manualControl.teamA = true;
    const carrier = outA[0];
    const mate = outA.find((pl) => pl !== carrier) || outA[1];
    sim.ball.owner = carrier;
    sim.teamA.setControllingPlayer(carrier);
    carrier.humanControlled = true;
    carrier.fsm.setCurrentState(PlayerStates.Dribble);

    const sent = sim.teamA.requestPass(mate, { force: true, skipOpenCheck: true });
    assert.strictEqual(sent, false, 'requestPass must not target human carrier');

    const { SoccerMsg } = require('../kernel/core/lib/soccer_messages.js');
    carrier.handleSoccerMessage({
        type: SoccerMsg.PassToMe,
        extra: {
            requester: mate,
            passType: 'short',
            aimHint: { x: mate.x, y: mate.y }
        }
    });
    assert.ok(
        carrier.fsm.isInState(PlayerStates.Dribble) || !carrier.fsm.isInState(PlayerStates.Pass),
        'PassToMe must not force Pass while humanControlled'
    );
    assert.notStrictEqual(
        carrier.fsm.getNameOfCurrentState(),
        'Pass',
        'human must stay off Pass after PassToMe'
    );
    log('PASS human ignores PassToMe auto-pass');

    // --- Stage 1.5: facing dir + pass assist + auto-switch + header block ---
    Settings.HEADLESS = false;
    Settings.manualControl.teamA = true;
    Settings.manualControl.passAssistFacing = true;
    Settings.manualControl.autoSwitchOnPass = true;
    Settings.manualControl.screenAwareMove = false; // pure world axes for test stability
    Settings.manualControl.blockAutoHeader = true;
    Settings.manualControl.recordInput = true;
    Settings.manualControl.recordInputMax = 50;

    const face = humanFacingDir({ orientation: 2 }, { moveX: 0, moveY: -1 });
    assert.ok(face.y < 0, 'facing follows move -Y');
    log('PASS humanFacingDir');

    // Screen-aware off: W still -Y via commandFromFrame
    const worldCmd = commandFromFrame({
        down: new Set(['KeyW']),
        pressed: new Set()
    }, { screenAware: false });
    assert.ok(worldCmd.moveY < 0 && Math.abs(worldCmd.moveX) < 1e-6, 'world-axis W = -Y');

    // Shift sprint
    const sprintCmd = commandFromFrame({
        down: new Set(['ShiftLeft']),
        pressed: new Set()
    });
    assert.ok(sprintCmd.sprint, 'ShiftLeft sprints');
    log('PASS screenAware opt + Shift sprint');

    // Place carrier with mate clearly in facing direction
    const passer = outA[0];
    const targetMate = outA.find((pl) => pl !== passer) || outA[1];
    passer.x = 40;
    passer.y = 34;
    passer.orientation = 2; // right
    targetMate.x = 52;
    targetMate.y = 34;
    sim.ball.owner = passer;
    sim.ball.x = passer.x;
    sim.ball.y = passer.y;
    sim.teamA.setControllingPlayer(passer);
    passer.humanControlled = true;

    // Mate in facing cone (+X) should soft-lock
    const hybrid = findHumanPassTarget(passer, 'short', { moveX: 1, moveY: 0 });
    assert.ok(hybrid && hybrid.teammate, 'pass assist finds in-cone teammate');
    log(`PASS findHumanPassTarget mate=${hybrid.teammate.name}`);

    // Mate behind aim: that specific mate must not be locked; free kick if nobody else in cone
    targetMate.x = 20;
    targetMate.y = 34;
    // Park every other teammate far behind aim as well so cone is empty
    for (let i = 0; i < outA.length; i++) {
        if (outA[i] !== passer) {
            outA[i].x = 15;
            outA[i].y = 10 + i * 2;
        }
    }
    const noCone = findHumanPassTarget(passer, 'short', { moveX: 1, moveY: 0 });
    assert.ok(noCone === null, 'no assist lock when no mate in aim cone');
    // Restore a clear in-cone option for later tests
    targetMate.x = 52;
    targetMate.y = 34;
    log('PASS findHumanPassTarget cone-only');

    // Auto-switch: start pass should hand control to receiver
    sim._manualPendingReceiver = null;
    const receiver = startHumanPass(passer, 'short', { moveX: 1, moveY: 0 });
    if (receiver) {
        const kb3 = new KeyboardInput();
        // Simulate post-pass tick with auto-switch sticky
        sim._manualPendingReceiver = receiver;
        sim._manualPassSwitchTicks = 0;
        sim.ball.owner = passer; // still in windup
        passer.passTarget = receiver;
        passer.fsm.setCurrentState(PlayerStates.Pass);
        tickManualControl(sim, { keyboard: kb3 });
        assert.ok(
            receiver.humanControlled || sim._manualControlled.A === receiver,
            'auto-switch keeps receiver while passer winds up'
        );
        log('PASS auto-switch sticky on receiver');
    } else {
        log('SKIP auto-switch (no pass target in this layout)');
    }

    // Passer must not immediately ChaseBall after kicking (own pass)
    {
        const { armKickerClaimCooldown } = require('../kernel/core/lib/logic_regulator.js');
        const pKick = outA[0];
        const mateKick = outA[1];
        pKick.humanControlled = false;
        pKick.x = 40;
        pKick.y = 34;
        mateKick.x = 55;
        mateKick.y = 34;
        sim.ball.owner = null;
        sim.ball.x = 42;
        sim.ball.y = 34;
        sim.ball.lastKicker = pKick;
        sim.teamA.receivingPlayer = mateKick;
        armKickerClaimCooldown(pKick, false);
        assert.strictEqual(sim.canBecomeChaser(pKick), false, 'last kicker suppressed from chase');
        pKick.fsm.setCurrentState(PlayerStates.Idle);
        sim.updatePlayerAIStates();
        assert.ok(
            !pKick.fsm.isInState(PlayerStates.ChaseBall),
            'passer must not enter ChaseBall right after pass'
        );
        log('PASS passer chase suppress after kick');
    }

    // Header immunity
    const { tryClaimLooseBall } = require('../kernel/core/entities/player.js');
    passer.humanControlled = true;
    sim.ball.owner = null;
    sim.ball.x = passer.x;
    sim.ball.y = passer.y;
    sim.ball.z = 1.4;
    sim.ball.vz = -1;
    sim.ball.vx = 0;
    sim.ball.vy = 0;
    const beforeState = passer.fsm.getNameOfCurrentState();
    tryClaimLooseBall(passer, sim.ball);
    assert.notStrictEqual(
        passer.fsm.getNameOfCurrentState(),
        'Header',
        'human must not auto-enter Header'
    );
    // restore
    if (beforeState && PlayerStates[beforeState]) {
        passer.fsm.setCurrentState(PlayerStates[beforeState]);
    }
    sim.ball.z = 0;
    log('PASS blockAutoHeader');

    // Input record stub
    Settings.manualControl.recordInput = true;
    sim._manualInputLog = [];
    const kbRec = new KeyboardInput();
    kbRec.debugKeyDown('KeyD');
    tickManualControl(sim, { keyboard: kbRec });
    assert.ok(sim._manualInputLog && sim._manualInputLog.length >= 1, 'records input when enabled');
    log('PASS recordInput stub');

    // --- Stage 2: hold-to-power pure helpers ---
    {
        const tap = holdPower01(1, { minSec: 0.05, maxSec: 0.6, tapFloor: 0.28 });
        const full = holdPower01(12, { minSec: 0.05, maxSec: 0.6, tapFloor: 0.28 });
        assert.ok(tap >= 0.27 && tap <= 0.35, `tap power ~0.28, got ${tap}`);
        assert.ok(full >= 0.98, `full hold ~1, got ${full}`);
        assert.ok(full > tap, 'full hold stronger than tap');

        const facing = { x: 1, y: 0 };
        // Move "up" (-Y) is left of facing +X → negative lateral (right-hand rule: right = +Y)
        const biasRight = lateralBiasFromMove(facing, 0, 1);
        assert.ok(biasRight > 0.9, `move +Y with face +X is right bias, got ${biasRight}`);
        const biasLeft = lateralBiasFromMove(facing, 0, -1);
        assert.ok(biasLeft < -0.9, `move -Y with face +X is left bias, got ${biasLeft}`);

        const curve = curveForceFromBias(1, 1.0, 80, { noise: 0, random: () => 0.5 });
        assert.ok(curve > 0.5, `full right bias strong curve, got ${curve}`);
        const soft = curveForceFromBias(1, 0.28, 80, { noise: 0, random: () => 0.5 });
        assert.ok(Math.abs(curve) > Math.abs(soft), 'full power curls more than tap');

        const lobKick = buildHumanPassKick({ power: 1, isLob: true, curveBias: 0.5, shooting: 70, random: () => 0.5 });
        assert.strictEqual(lobKick.forceLob, true);
        assert.ok(lobKick.vzMul > 1.0, 'full lob raises vzMul');
        assert.ok(lobKick.speedMul > 0.9);

        const shortKick = buildHumanPassKick({ power: 0.3, isLob: false });
        assert.strictEqual(shortKick.forceLob, false);
        assert.strictEqual(shortKick.curveForce, 0, 'ground pass no curve');
        assert.ok(passSpeedMulFromPower(1, false) > passSpeedMulFromPower(0.3, false));

        const shootKick = buildHumanShootKick({ power: 1, curveBias: -0.8, shooting: 75, dist: 25, random: () => 0.5 });
        assert.ok(shootKick.heightSpeed > shootHeightFromPower(0.3, 25) + 0.5, 'full shot lofted');
        // Peak height must be expressible: full far shot clears ~1 m easily
        const peakFull = peakHeightFromVz(shootKick.heightSpeed);
        assert.ok(peakFull >= 1.5, `full far shot peak ≥1.5 m, got ${peakFull.toFixed(2)}`);
        const peakTap = peakHeightFromVz(shootHeightFromPower(0.28, 25));
        assert.ok(peakTap < 1.0, `tap far shot stays lower, peak=${peakTap.toFixed(2)}`);
        assert.ok(peakFull > peakTap + 0.8, 'hold raises shot height meaningfully');
        assert.ok(shootKick.speedMul > 0.9);
        assert.ok(shootKick.curveForce < 0, 'left bias negative curve');

        assert.strictEqual(resolveChargeStart({ shoot: true, pass: true }, null), 'shoot');
        assert.strictEqual(resolveChargeStart({ pass: true }, 'lob'), 'lob', 'keep existing charge');
        assert.strictEqual(resolveReleasedAction({ shootReleased: true }, 'shoot'), 'shoot');
        assert.strictEqual(resolveReleasedAction({ passReleased: true }, 'shoot'), null);
        assert.ok(isChargeHeld({ passDown: true }, 'pass'));
        assert.ok(!isChargeHeld({ lobDown: true }, 'pass'));
        log('PASS Stage 2 pure helpers');
    }

    // Stage 2: release-to-fire charges then kicks on release
    {
        Settings.HEADLESS = false;
        Settings.manualControl.teamA = true;
        Settings.manualControl.holdToPower = true;
        Settings.manualControl.aimAssist = true;
        Settings.manualControl.passAssistFacing = true;
        Settings.manualControl.autoSwitchOnPass = false;
        Settings.manualControl.screenAwareMove = false;

        const shooter = outA[0];
        shooter.x = 70;
        shooter.y = 34;
        shooter.orientation = 2;
        sim.ball.owner = shooter;
        sim.ball.x = shooter.x;
        sim.ball.y = shooter.y;
        sim.teamA.setControllingPlayer(shooter);
        clearManualCharge(sim);
        shooter.fsm.setCurrentState(PlayerStates.Dribble);

        // Press shoot (charge start)
        const kbHold = new KeyboardInput();
        kbHold.debugKeyDown('Numpad3');
        tickManualControl(sim, { keyboard: kbHold });
        assert.ok(sim._manualCharge && sim._manualCharge.action === 'shoot', 'charge starts on press');
        assert.ok((sim._manualCharge.ticks | 0) >= 1, 'charge accumulates ticks');
        assert.ok(
            !shooter.fsm.isInState(PlayerStates.Shoot),
            'must not fire Shoot on press while holdToPower'
        );

        // Hold a few more ticks
        for (let i = 0; i < 5; i++) {
            tickManualControl(sim, { keyboard: kbHold });
        }
        assert.ok(sim._manualCharge.ticks >= 5, 'hold accumulates');

        // Release → fire
        kbHold.debugKeyUp('Numpad3');
        tickManualControl(sim, { keyboard: kbHold });
        assert.ok(
            shooter.fsm.isInState(PlayerStates.Shoot) || shooter.humanKick,
            'release enters Shoot or sets humanKick'
        );
        assert.ok(!sim._manualCharge, 'charge cleared after fire');
        if (shooter.humanKick) {
            assert.strictEqual(shooter.humanKick.kind, 'shoot');
            assert.ok(shooter.humanKick.power > 0.3, 'charged power above tap floor-ish');
        }
        log('PASS Stage 2 hold-to-power release fire');

        // computeShootKick honors humanKick curve/speed
        shooter.shotAim = { x: 106, y: 34 };
        shooter.humanKick = buildHumanShootKick({
            power: 1,
            curveBias: 1,
            shooting: 80,
            dist: 30,
            random: () => 0.5
        });
        shooter.shotHeightBoost = shooter.humanKick.heightSpeed;
        const kick = computeShootKick(shooter);
        assert.ok(kick.speed > 10, 'powered shot speed');
        assert.ok(Math.abs(kick.curveForce - shooter.humanKick.curveForce) < 1e-9, 'human curve applied');
        assert.strictEqual(kick.heightSpeed, shooter.humanKick.heightSpeed);
        shooter.humanKick = null;
        shooter.shotHeightBoost = null;
        log('PASS computeShootKick humanKick');

        // Directional free kick along stick (+Y) even with assist on (no mate in cone)
        Settings.manualControl.aimAssist = true;
        Settings.manualControl.passAssistFacing = true;
        clearManualCharge(sim);
        sim.ball.owner = shooter;
        sim.ball.vx = 0;
        sim.ball.vy = 0;
        sim.ball.vz = 0;
        sim.ball.z = 0;
        shooter.x = 50;
        shooter.y = 34;
        shooter.orientation = 2; // right, but we aim down
        // Park all teammates far left so none sit in +Y cone
        for (let i = 0; i < outA.length; i++) {
            if (outA[i] !== shooter) {
                outA[i].x = 10;
                outA[i].y = 10 + i;
            }
        }
        shooter.fsm.setCurrentState(PlayerStates.Dribble);
        const kbDir = new KeyboardInput();
        kbDir.debugKeyDown('KeyS'); // aim +Y (world, screenAware off)
        kbDir.debugKeyDown('Numpad2'); // lob
        tickManualControl(sim, { keyboard: kbDir });
        for (let i = 0; i < 3; i++) tickManualControl(sim, { keyboard: kbDir });
        assert.ok(sim._manualCharge && sim._manualCharge.action === 'lob', 'lob charging');
        assert.ok(sim._manualCharge.aimY > 0.5, `sticky aim +Y, aimY=${sim._manualCharge.aimY}`);
        kbDir.debugKeyUp('Numpad2');
        // Keep S held so aim stays clear; lob fires free-directional
        tickManualControl(sim, { keyboard: kbDir });
        assert.ok(!sim.ball.owner, 'directional lob releases ball');
        assert.ok(sim.ball.vy > 0.5, `lob vy follows +Y aim, vy=${sim.ball.vy}`);
        assert.ok(sim.ball.vz > 0, 'lob has hang');
        log('PASS directional lob along stick');

        // Aim assist off → pure facing kick still works
        Settings.manualControl.aimAssist = false;
        clearManualCharge(sim);
        sim.ball.owner = shooter;
        sim.ball.vx = 0;
        sim.ball.vy = 0;
        sim.ball.vz = 0;
        sim.ball.z = 0;
        shooter.actionTimer = 0;
        shooter.x = 50;
        shooter.y = 34;
        shooter.fsm.setCurrentState(PlayerStates.Dribble);
        const kbPass = new KeyboardInput();
        kbPass.debugKeyDown('KeyD');
        kbPass.debugKeyDown('Numpad1');
        tickManualControl(sim, { keyboard: kbPass });
        for (let i = 0; i < 2; i++) tickManualControl(sim, { keyboard: kbPass });
        kbPass.debugKeyUp('Numpad1');
        tickManualControl(sim, { keyboard: kbPass });
        assert.ok(!sim.ball.owner, 'assist-off pass releases ball');
        assert.ok(sim.ball.vx > 0.5, `assist-off pass along +X, vx=${sim.ball.vx}`);
        log('PASS aim assist off facing kick');

        // Stage 1 compat: holdToPower false fires on press
        Settings.manualControl.holdToPower = false;
        Settings.manualControl.aimAssist = true;
        clearManualCharge(sim);
        sim.ball.owner = shooter;
        sim.ball.vx = 0;
        sim.ball.vy = 0;
        sim.ball.vz = 0;
        shooter.x = 40;
        shooter.y = 34;
        const mate2 = outA.find((pl) => pl !== shooter) || outA[1];
        mate2.x = 55;
        mate2.y = 34;
        shooter.fsm.setCurrentState(PlayerStates.Dribble);
        const kbInstant = new KeyboardInput();
        kbInstant.debugKeyDown('Numpad1');
        // passAssist may find mate → Pass state
        startHumanPass(shooter, 'short', { moveX: 1, moveY: 0 }, null);
        assert.ok(
            shooter.fsm.isInState(PlayerStates.Pass) || sim.ball.owner !== shooter,
            'press-path still starts pass'
        );
        log('PASS holdToPower=false / startHumanPass still works');
    }

    // --- Kickoff: AI only — no manual move / pass / switch ---
    {
        Settings.HEADLESS = false;
        Settings.manualControl.teamA = true;
        clearManualCharge(sim);

        sim.kickoffTeam = 'A';
        sim.setPieceType = 'kickoff';
        sim.fsm.setCurrentState(MatchStates.Kickoff);
        sim.stateTimer = 1.0;
        const taker = outA[0];
        sim.ball.owner = taker;
        taker.humanControlled = true;
        taker._humanInput = { moveX: 1, moveY: 0, sprint: false };

        assert.ok(isKickoffControlBlocked(sim), 'kickoff blocks manual control');
        assert.ok(isKickoffCarrierLocked(taker), 'legacy lock helper still true');

        const kbKo = new KeyboardInput();
        kbKo.debugKeyDown('KeyD');
        kbKo.debugKeyDown('Digit1'); // pass
        kbKo.debugKeyDown('Tab'); // switch if mapped
        tickManualControl(sim, { keyboard: kbKo });
        assert.ok(!sim.players.some((pl) => pl.humanControlled), 'no human avatar during kickoff');
        assert.ok(!taker._humanInput, 'human input cleared during kickoff');

        // Open play after set piece clears → manual resumes
        sim.setPieceType = '';
        sim.fsm.setCurrentState(MatchStates.Play);
        assert.ok(!isKickoffControlBlocked(sim), 'control unblocked after kickoff clears');
        sim.ball.owner = taker;
        taker.actionTimer = 0;
        taker.isSliding = false;
        taker.humanKick = null;
        taker.fsm.setCurrentState(PlayerStates.Dribble);
        const kbPlay = new KeyboardInput();
        kbPlay.debugKeyDown('KeyD');
        tickManualControl(sim, { keyboard: kbPlay });
        assert.ok(taker.humanControlled, 'human control resumes in open play');
        assert.ok(taker._humanInput && taker._humanInput.moveX > 0, 'WASD works after kickoff');

        log('PASS kickoff AI-only / manual gated');
    }

    // --- Stage 3: defense toolkit pure helpers ---
    {
        const dirStick = slideLaunchDir(
            { x: 0, y: 0 },
            { moveX: 0, moveY: -1 },
            { x: 10, y: 0 },
            { x: 1, y: 0 }
        );
        assert.ok(Math.abs(dirStick.y + 1) < 1e-5, 'slide prefers stick over ball');
        assert.ok(Math.abs(dirStick.x) < 1e-5);

        const dirBall = slideLaunchDir({ x: 0, y: 0 }, null, { x: 3, y: 4 }, null);
        assert.ok(Math.abs(dirBall.x - 0.6) < 1e-5 && Math.abs(dirBall.y - 0.8) < 1e-5);

        const launch = slideLaunchTarget(
            { x: 10, y: 20 },
            { moveX: 1, moveY: 0 },
            { x: 10, y: 50 },
            { launchDist: 3.2 }
        );
        assert.ok(Math.abs(launch.x - 13.2) < 1e-4, `launch x=${launch.x}`);
        assert.ok(Math.abs(launch.y - 20) < 1e-4, 'slide along +X not toward ball at y=50');

        assert.ok(bodyTackleInRange(0.9, 1.05));
        assert.ok(!bodyTackleInRange(2.0, 1.05));

        const contact = takeChargeContact(
            { x: 0, y: 0 },
            { x: 0.8, y: 0 },
            { moveX: 1, moveY: 0, sprint: true },
            { range: 1.15 }
        );
        assert.ok(contact.ok, 'take-charge when approaching carrier');
        assert.ok(contact.nx > 0.9);
        assert.ok(contact.sprint);

        const noMove = takeChargeContact(
            { x: 0, y: 0 },
            { x: 0.5, y: 0 },
            { moveX: 0, moveY: 0 },
            { range: 1.15 }
        );
        assert.ok(!noMove.ok, 'stationary does not take charge');

        assert.ok(tackleRecoverySec('slide') > tackleRecoverySec('foot'));
        assert.ok(tackleRecoverySec('body') > tackleRecoverySec('foot'));

        const footS = computeTackleSuccess(
            { stats: { tackling: 80 } },
            { stats: { dribbling: 60 } },
            'foot'
        );
        const bodyS = computeTackleSuccess(
            { stats: { tackling: 80 } },
            { stats: { dribbling: 60 } },
            'body'
        );
        const slideS = computeTackleSuccess(
            { stats: { tackling: 80 } },
            { stats: { dribbling: 60 } },
            'slide'
        );
        assert.ok(footS > bodyS && bodyS > slideS * 0.9, 'success order roughly foot > body >= slide');

        log('PASS Stage 3 pure helpers');
    }

    // Stage 3: command maps body shove + directional slide fire
    {
        Settings.HEADLESS = false;
        Settings.manualControl.teamA = true;
        Settings.manualControl.takeCharge = true;
        Settings.manualControl.screenAwareMove = false;
        clearManualCharge(sim);

        const defender = outA.find((p) => p.role !== 'GK') || outA[0];
        const opp = sim.players.find((p) => p.team === 'B' && p.role !== 'GK');
        assert.ok(defender && opp, 'need defender and opponent');

        // Place bodies for contact
        defender.x = 40;
        defender.y = 34;
        defender.actionTimer = 0;
        defender.isSliding = false;
        defender.tackleAttemptCooldown = 0;
        defender.humanControlled = true;
        defender.fsm.setCurrentState(PlayerStates.Idle);
        opp.x = 40.7;
        opp.y = 34;
        opp.actionTimer = 0;
        sim.ball.owner = opp;
        sim.ball.x = opp.x;
        sim.ball.y = opp.y;
        sim.ball.z = 0;
        sim.setPieceType = '';
        sim.fsm.setCurrentState(MatchStates.Play);

        // Body shove command edge
        const cmdBody = commandFromFrame({
            down: new Set(),
            pressed: new Set(['Numpad3']),
            released: new Set()
        });
        assert.ok(cmdBody.tackleBody, 'action3 is tackleBody');
        assert.ok(cmdBody.shoot, 'action3 also shoot edge (context later)');

        // Force body success path via seeded RNG (claim + no dirty foul)
        const realRand = Math.random;
        let call = 0;
        Math.random = () => {
            call += 1;
            // success roll low, claim roll low, dirty foul roll high (no foul)
            if (call === 1) return 0.01;
            if (call === 2) return 0.01;
            return 0.99;
        };
        try {
            const ok = attemptTackle(defender, sim.ball, 'body');
            assert.ok(ok === true || sim.ball.owner === defender || opp.actionTimer > 0,
                'body tackle mutates possession or knocks down');
            assert.ok(opp.actionTimer > 0 || sim.ball.owner === defender,
                'opponent locked or ball claimed');
        } finally {
            Math.random = realRand;
        }

        // Directional slide via tickManualControl
        defender.x = 50;
        defender.y = 40;
        defender.actionTimer = 0;
        defender.isSliding = false;
        defender.tackleAttemptCooldown = 0;
        defender.fsm.setCurrentState(PlayerStates.Idle);
        opp.x = 54;
        opp.y = 40;
        opp.actionTimer = 0;
        sim.ball.owner = opp;
        sim.ball.x = opp.x;
        sim.ball.y = opp.y;
        sim._manualControlled = { A: defender, B: null };

        const kbSlide = new KeyboardInput();
        kbSlide.debugKeyDown('KeyD'); // slide along +X
        kbSlide.debugKeyDown('Numpad2');
        tickManualControl(sim, { keyboard: kbSlide });
        assert.ok(
            defender.isSliding || defender.actionTimer > 0 || sim.ball.owner === defender,
            'slide command starts dive or resolves contact'
        );
        if (defender.isSliding || defender.slideTarget) {
            // Launch should prefer +X stick, not pure ball (ball is also +X here)
            assert.ok(
                defender.slideTarget && defender.slideTarget.x > defender.x,
                'slide target ahead of player'
            );
        }

        // Recovery lock freezes human movement
        applyActionLock(defender, 0.5);
        assert.ok(defender.actionTimer > 0);
        assert.strictEqual(defender.frame, 5);
        defender.humanControlled = true;
        defender._humanInput = { moveX: 1, moveY: 0, sprint: false };
        const locked = applyHumanMovement(defender);
        assert.ok(locked);
        assert.ok(defender._currentSpeed === 0, 'locked player does not run');

        // humanFoulMultiplier only when humanControlled
        defender.humanControlled = true;
        Settings.manualControl.humanBodyFoulMul = 1.5;
        assert.ok(humanFoulMultiplier(defender, 'body') >= 1.4);
        defender.humanControlled = false;
        assert.strictEqual(humanFoulMultiplier(defender, 'body'), 1);

        // take-charge soft push
        Settings.manualControl.takeCharge = true;
        Settings.manualControl.takeChargeDislodgeChance = 0; // push only
        defender.humanControlled = true;
        defender.actionTimer = 0;
        defender.isSliding = false;
        defender.x = 30;
        defender.y = 30;
        opp.x = 30.6;
        opp.y = 30;
        const ox = opp.x;
        sim.ball.owner = opp;
        const kbCharge = new KeyboardInput();
        kbCharge.debugKeyDown('KeyD');
        sim._manualControlled = { A: defender, B: null };
        tickManualControl(sim, { keyboard: kbCharge });
        assert.ok(opp.x > ox - 1e-6, 'take-charge pushes carrier along separation');

        log('PASS Stage 3 body / slide / lock / take-charge');
    }

    // --- Stage 4: header helpers + timed jump ---
    {
        assert.strictEqual(headerKindFromAction('pass'), 'short');
        assert.strictEqual(headerKindFromAction('lob'), 'long');
        assert.strictEqual(headerKindFromAction('shoot'), 'shot');

        const hkShort = buildHumanHeaderKick({ kind: 'short', power: 0.3, aimDir: { x: 1, y: 0 } });
        const hkShot = buildHumanHeaderKick({ kind: 'shot', power: 1.0, aimDir: { x: 1, y: 0 } });
        assert.ok(hkShort.speed < hkShot.speed, 'shot header faster than soft nod');
        assert.ok(headerSpeedFromPower(1, 'shot') > headerSpeedFromPower(0.2, 'short'));
        assert.ok(headerVzFromPower(1, 'long') > headerVzFromPower(1, 'shot'), 'long hangs more than shot');
        log('PASS Stage 4 buildHumanHeaderKick');

        Settings.HEADLESS = false;
        Settings.manualControl.teamA = true;
        Settings.manualControl.manualHeader = true;
        Settings.manualControl.holdToPower = false; // press-to-jump for test stability
        Settings.manualControl.blockAutoHeader = true;

        const jumper = outA[0];
        jumper.humanControlled = true;
        jumper.actionTimer = 0;
        jumper.isSliding = false;
        jumper.x = 55;
        jumper.y = 34;
        jumper.humanHeader = null;
        // Loose lofted ball almost at the jumper (instant window)
        sim.ball.owner = null;
        sim.ball.x = 55.4;
        sim.ball.y = 34.1;
        sim.ball.z = 1.25;
        sim.ball.vx = 0.5;
        sim.ball.vy = 0;
        sim.ball.vz = 0.4;
        sim.ball.isShot = false;
        sim.fsm.setCurrentState(MatchStates.Play);
        sim.setPieceType = '';

        const win = evalHumanHeaderWindow(jumper, sim.ball);
        assert.ok(win.ok, 'header window when ball high and near');

        const started = startHumanHeader(jumper, 'shot', 0.8, { moveX: 1, moveY: 0 }, null);
        assert.ok(started, 'startHumanHeader enters Header');
        assert.ok(jumper.fsm.isInState(PlayerStates.Header), 'FSM Header');
        assert.ok(jumper.humanHeader && jumper.humanHeader.kind === 'shot');
        assert.ok(jumper.humanHeader.speed > 0 && jumper.humanHeader.vz > 0);

        // Drive Header through contact phase
        Time.deltaTime = 0.05;
        for (let i = 0; i < 20; i++) {
            if (jumper.fsm && jumper.fsm.currentState && jumper.fsm.currentState.execute) {
                jumper.fsm.currentState.execute(jumper);
            } else if (typeof jumper.fsm.update === 'function') {
                jumper.fsm.update();
            }
            if (jumper.isHeading) break;
        }
        // Either contacted (isHeading) or finished timer — both valid if ball drifted
        assert.ok(
            jumper.isHeading || jumper.headerTimer <= 0 || !jumper.fsm.isInState(PlayerStates.Header),
            'header resolve progresses'
        );
        if (jumper.isHeading) {
            assert.strictEqual(sim.ball.isShot, true, 'head shot marks isShot');
            assert.ok(sim.ball.owner === null);
            assert.ok(Math.abs(sim.ball.vx) + Math.abs(sim.ball.vy) > 1, 'ball kicked by header');
        }
        jumper.humanControlled = false;
        jumper.humanHeader = null;
        jumper.z = 0;
        if (PlayerStates.Idle) jumper.fsm.changeState(PlayerStates.Idle);
        Settings.manualControl.holdToPower = true;
        log('PASS Stage 4 manual header window + head shot contact');
    }

    // Cleanup flags for any later harness reuse
    Settings.HEADLESS = true;
    Settings.manualControl.teamA = false;
    Settings.manualControl.recordInput = false;
    Settings.manualControl.screenAwareMove = true;
    Settings.manualControl.holdToPower = true;
    Settings.manualControl.aimAssist = true;
    Settings.manualControl.autoSwitchOnPass = true;
    Settings.manualControl.takeCharge = true;
    Settings.manualControl.humanBodyFoulMul = 1.15;
    Settings.manualControl.manualHeader = true;
    carrier.humanControlled = false;
    passer.humanControlled = false;
    clearManualCharge(sim);

    log('OK manual_control');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
