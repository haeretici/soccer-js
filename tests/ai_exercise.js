#!/usr/bin/env node
require('./mock_env.js');

const fs = require('fs');
const assert = require('assert');
const { Time } = require('../kernel/core/lib/time.js');
const { Ball } = require('../kernel/core/entities/ball.js');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    Player,
    PlayerStates,
    computeTackleType,
    computeTackleSuccess,
    choosePassType,
    computeDribbleTarget,
    computeChaseInterceptTarget,
    computeLooseBallInterceptTarget,
    tryClaimLooseBall,
    computePressPriority,
    canPressCarrier,
    getAheadDelta,
    defendingGoalX,
    attacksRightGoal,
    effectiveDefensiveBlend,
    computeAttackSupportTarget,
    isAheadOfFormationLine,
    isCarrierInAttackingHalf,
    getShootRange,
    getPassReceiverPosition,
    isPassReceiverAhead,
    computeShootKick,
    computeDribblePassChance,
    isDefensiveOutfieldRole,
    scorePassTarget,
    canTackleOwner,
    isGkProtected,
    grantGkPossession,
    computeGkClearTarget,
    gkDefendsLeftGoal,
    getGoalkeeperBaseX,
    dist2d
} = require('../kernel/core/entities/player.js');

const { SCRATCH } = require('./scratch_dir.js');
const logs = [];
const origLog = console.log;
const origError = console.error;
console.log = (...args) => { logs.push(args.join(' ')); if (process.env.VERBOSE) origLog(...args); };
console.error = (...args) => { logs.push(args.join(' ')); origError(...args); };

function makeMockLevel(players, ball) {
    return {
        players,
        ball,
        matchState: 'play',
        teamAName: 'Brazil',
        teamBName: 'Argentina',
        isSecondHalf: () => false
    };
}

function makePlayer(name, team, role, x, y, level) {
    const stats = { speed: 70, passing: 75, dribbling: 70, shooting: 65, tackling: 72, goalkeeping: 85 };
    const p = new Player(name, team, role, stats);
    p.x = x;
    p.y = y;
    p.level = level;
    p.start();
    return p;
}

function log(msg) {
    if (process.env.VERBOSE) {
        console.log(msg);
    }
}

async function runExercise(runId) {
    log(`\n=== AI Exercise Run ${runId} ===`);
    Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };

    const gkUnit = makePlayer('BRA 1', 'A', 'GK', 1, 10, null);
    gkUnit.level = { isSecondHalf: () => false };
    const unitBall = new Ball();
    assert.strictEqual(isGkProtected(gkUnit), false);
    grantGkPossession(gkUnit, unitBall, { holdDuration: 1.2 });
    assert.ok(isGkProtected(gkUnit), 'grantGkPossession activates protection');
    assert.strictEqual(canTackleOwner(gkUnit), false);
    assert.ok(gkUnit.fsm.isInState(PlayerStates.Goalkeeper));
    assert.strictEqual(unitBall.owner, gkUnit);
    const holdYs = [];
    for (let i = 0; i < 20; i++) {
        Time.deltaTime = 0.05;
        gkUnit.fsm.update();
        unitBall.update();
        holdYs.push(gkUnit.y);
    }
    const ySpread = Math.max(...holdYs) - Math.min(...holdYs);
    assert.ok(ySpread < 0.05, `GK hold Y must stay stable, spread=${ySpread.toFixed(3)}`);
    log('PASS isGkProtected + grantGkPossession unit helpers');

    const clearBall = new Ball();
    const clearLevel = { isSecondHalf: () => false, ball: clearBall };
    const clearGk = makePlayer('BRA 1', 'A', 'GK', 1, 10, clearLevel);
    clearGk.level = clearLevel;
    grantGkPossession(clearGk, clearBall);
    assert.ok(gkDefendsLeftGoal(clearLevel, clearGk));
    const firstHalfLevel = { isSecondHalf: () => false };
    const secondHalfLevel = { isSecondHalf: () => true };
    assert.strictEqual(getGoalkeeperBaseX(firstHalfLevel, 'A'), Utils.scaleFieldX(3.125));
    assert.strictEqual(getGoalkeeperBaseX(firstHalfLevel, 'B'), Utils.scaleFieldX(96.875));
    assert.strictEqual(getGoalkeeperBaseX(secondHalfLevel, 'A'), Utils.scaleFieldX(96.875));
    assert.strictEqual(getGoalkeeperBaseX(secondHalfLevel, 'B'), Utils.scaleFieldX(3.125));
    log('PASS getGoalkeeperBaseX respects half-time side swap');

    Settings.HEADLESS = true;
    const goalkickSim = new Simulator();
    await goalkickSim.start();
    goalkickSim.matchTimer = 2700;
    goalkickSim.setupSetPiecePositions('goalkick', 'left', 'B');
    const gkA = goalkickSim.players.find(p => p.team === 'A' && p.role === 'GK');
    const gkB = goalkickSim.players.find(p => p.team === 'B' && p.role === 'GK');
    assert.ok(gkB.x < Utils.getFieldBounds().centerX, 'defending GK takes left goalkick in 2nd half');
    assert.strictEqual(gkA.x, getGoalkeeperBaseX(goalkickSim, 'A'), 'non-kicking GK stays at home goal');
    Settings.HEADLESS = false;
    log('PASS goalkick assigns defending-team GK in second half');

    Settings.HEADLESS = true;
    const cardSim = new Simulator();
    await cardSim.start();
    const fouled = cardSim.players.find(p => p.team === 'B' && p.role !== 'GK');
    const sentOffTackler = cardSim.players.find(p => p.team === 'A' && p.role !== 'GK');
    const foulX = fouled.x;
    const foulY = fouled.y;
    cardSim.setPieceX = foulX;
    cardSim.setPieceY = foulY;
    cardSim.setPieceSide = foulX < Utils.getFieldBounds().centerX ? 'left' : 'right';
    cardSim.sendOffPlayer(sentOffTackler);
    sentOffTackler.x = foulX;
    sentOffTackler.y = foulY;
    cardSim.ball.x = foulX;
    cardSim.ball.y = foulY;
    cardSim.ball.owner = sentOffTackler;
    cardSim.fsm.setCurrentState(MatchStates.Freekick);
    cardSim.setPieceType = 'freekick';
    cardSim.setPieceKickingTeam = 'B';
    cardSim.stateTimer = 0.05;
    // Freekick end: prepare snap + SET_PIECE_READY_HOLD (2s) + kick windup
    let kicked = false;
    for (let i = 0; i < 80; i++) {
        Time.deltaTime = 0.05;
        cardSim.update();
        for (const p of cardSim.players) p.update();
        cardSim.ball.update();
        if (cardSim.ball.vx !== 0 || cardSim.ball.vy !== 0) kicked = true;
    }
    assert.strictEqual(cardSim.matchState, 'play', 'freekick resumes play after red card');
    assert.notStrictEqual(cardSim.ball.owner, sentOffTackler, 'sent-off player must not keep the ball');
    assert.ok(kicked, 'ball must be kicked after freekick');
    Settings.HEADLESS = false;
    log('PASS red-card freekick does not stick with sent-off ball owner');

    Settings.HEADLESS = true;
    const kickoffSim = new Simulator();
    await kickoffSim.start();
    const sentOffStriker = kickoffSim.players.find(p => p.team === 'A' && p.role.includes('S'));
    kickoffSim.sendOffPlayer(sentOffStriker);
    kickoffSim.kickoffTeam = 'A';
    kickoffSim.resetToKickoff();
    assert.ok(kickoffSim.ball.owner, 'kickoff must assign ball when a striker is sent off');
    assert.notStrictEqual(kickoffSim.ball.owner, sentOffStriker, 'sent-off striker must not take kickoff');
    assert.ok(!kickoffSim.ball.owner.isSentOff, 'kickoff taker must be an active player');
    Settings.HEADLESS = false;
    log('PASS kickoff skips sent-off players');

    const clearTarget = computeGkClearTarget(clearGk, clearLevel);
    assert.ok((clearTarget.target ? clearTarget.target.x : clearTarget.x) >= 14, 'clear must target midfield not own box');
    clearGk.gkHoldTimer = 0.01;
    Time.deltaTime = 0.05;
    clearGk.fsm.update();
    assert.strictEqual(clearBall.owner, null, 'GK releases ball on clear');
    assert.ok(clearGk.gkReleaseCooldown > 0, 'release cooldown starts after clear');
    clearBall.x = 3;
    clearBall.y = 10;
    clearBall.z = 0;
    clearBall.vx = 0;
    clearBall.vy = 0;
    const origRand = Math.random;
    try {
        Math.random = () => 0.01;
        for (let i = 0; i < 40; i++) {
            Time.deltaTime = 0.05;
            clearGk.fsm.update();
            clearBall.update();
        }
    } finally {
        Math.random = origRand;
    }
    assert.notStrictEqual(clearBall.owner, clearGk, 'GK must not boomerang-catch during release cooldown');
    log('PASS GK clear does not boomerang back');

    // Goalkeeper clear safety and short/long selection unit test
    const testGk = makePlayer('BRA 1', 'A', 'GK', 5, 15, clearLevel);
    testGk.level = clearLevel;
    const testDefender = makePlayer('BRA 2', 'A', 'DF', 10, 15, clearLevel);
    const testMidfielder = makePlayer('BRA 3', 'A', 'MF', 25, 15, clearLevel);
    const testOpponent = makePlayer('ARG 9', 'B', 'FW', 9, 15, clearLevel); // blocks defender
    
    let teammatesList = [testDefender, testMidfielder];
    let opponentsList = [testOpponent];
    testGk.parent = {
        teamKey: 'A',
        getOutfieldPlayers: () => teammatesList,
        getOpponentPool: () => opponentsList
    };
    
    // Force Math.random to return 0.1 so that it prefers a short pass (0.1 < 0.4)
    const testRand = Math.random;
    try {
        Math.random = () => 0.1;
        
        // Since opponent blocks testDefender (dist 1.0 from pass path), the short pass to defender is unsafe.
        // So it should fallback to long pass to testMidfielder (dist 20, vz >= 4.0)
        let res = computeGkClearTarget(testGk, clearLevel);
        assert.strictEqual(res.teammate, testMidfielder, 'GK clear falls back to long pass when defender is blocked');
        assert.ok(res.vz >= 4.0, 'long pass has high vz');
        
        // Move opponent away to make defender open
        testOpponent.x = 90;
        testOpponent.y = 90;
        res = computeGkClearTarget(testGk, clearLevel);
        assert.strictEqual(res.teammate, testDefender, 'GK clear chooses short pass when defender is open');
        assert.strictEqual(res.vz, 0, 'short pass has vz = 0');
    } finally {
        Math.random = testRand;
    }
    log('PASS GK clear safety and short/long selection');

    assert.strictEqual(computeTackleType(0.5), 'foot');
    assert.strictEqual(computeTackleType(1.5), 'slide');
    assert.strictEqual(computeTackleType(3.5), null);
    log('PASS computeTackleType');

    const tackler = { stats: { tackling: 80 } };
    const dribbler = { stats: { dribbling: 60 } };
    const footChance = computeTackleSuccess(tackler, dribbler, 'foot');
    const slideChance = computeTackleSuccess(tackler, dribbler, 'slide');
    assert.ok(footChance > slideChance);
    log(`PASS computeTackleSuccess foot=${footChance.toFixed(2)} slide=${slideChance.toFixed(2)}`);

    assert.strictEqual(choosePassType(5, true), 'short');
    assert.strictEqual(choosePassType(25, true), 'long');
    assert.strictEqual(choosePassType(25, false), null);
    log('PASS choosePassType');

    const simStick = new Simulator();
    await simStick.start();
    // Leave kickoff so Wait players can become pressers (canBecomeChaser gates set-piece Wait).
    simStick.fsm.setCurrentState(MatchStates.Play);
    simStick.setPieceType = '';
    const bOut = simStick.players.filter(p => p.team === 'B' && p.role !== 'GK');
    const chaserA = bOut[0];
    const chaserB = bOut[1];
    // Stickiness lives on Team; Simulator.pickPrimaryChaser is a facade
    const teamB = simStick.teamB;
    assert.ok(teamB, 'teamB exists');
    teamB.stickyPrimaryChaser = null;
    let pick = simStick.pickPrimaryChaser('B', [
        { player: chaserA, dist: 5.0 },
        { player: chaserB, dist: 6.0 }
    ]);
    assert.strictEqual(pick, chaserA, 'initial primary is closest');
    assert.strictEqual(teamB.stickyPrimaryChaser, chaserA, 'Team stores sticky primary');
    pick = simStick.pickPrimaryChaser('B', [
        { player: chaserB, dist: 5.5 },
        { player: chaserA, dist: 6.0 }
    ]);
    assert.strictEqual(pick, chaserA, 'sticky keeps incumbent within margin');
    pick = simStick.pickPrimaryChaser('B', [
        { player: chaserB, dist: 3.0 },
        { player: chaserA, dist: 6.0 }
    ]);
    assert.strictEqual(pick, chaserB, 'switches when challenger exceeds margin');
    log('PASS pickPrimaryChaser stickiness hysteresis');

    teamB.stickyPrimaryChaser = null;
    simStick._stickyPrimaryChasers = { A: null, B: null };
    const carrierPress = simStick.players.find(p => p.team === 'A' && p.role !== 'GK');
    for (const p of bOut) {
        if (p !== chaserA && p !== chaserB) {
            p.x = 2;
            p.y = 2;
        }
    }
    simStick.ball.owner = carrierPress;
    carrierPress.x = 16;
    carrierPress.y = 10;
    chaserA.x = 14.5;
    chaserA.y = 10;
    chaserB.x = 14.6;
    chaserB.y = 10.1;
    let pressFlips = 0;
    simStick.getActiveChasers();
    let lastPress = teamB.stickyPrimaryChaser;
    for (let i = 0; i < 40; i++) {
        chaserA.x = 14.4 + (i % 2) * 0.2;
        chaserB.x = 14.5 + ((i + 1) % 2) * 0.2;
        simStick.getActiveChasers();
        const primary = teamB.stickyPrimaryChaser;
        assert.ok(primary === chaserA || primary === chaserB, 'pressing primary is one of the two rivals');
        if (lastPress && primary !== lastPress) pressFlips++;
        lastPress = primary;
    }
    assert.strictEqual(pressFlips, 0, `press primary bounced ${pressFlips} times`);
    log('PASS getActiveChasers stable under rival distance oscillation');

    const field = Utils.getFieldBounds();
    const carrierBeat = makePlayer('BRA 10', 'A', 'LS', Utils.scaleFieldX(68.75), field.centerY, null);
    const beatenDef = makePlayer('ARG 4', 'B', 'RCB', Utils.scaleFieldX(31.25), field.centerY, null);
    const aheadDef = makePlayer('ARG 5', 'B', 'LCM', Utils.scaleFieldX(75), field.centerY + 1, null);
    const beatLevel = makeMockLevel([carrierBeat, beatenDef, aheadDef], new Ball());
    carrierBeat.level = beatLevel;
    beatenDef.level = beatLevel;
    aheadDef.level = beatLevel;
    assert.ok(getAheadDelta(beatenDef, carrierBeat, beatLevel) < -Settings.AI.CHASE_BEATEN_AHEAD_DIST, 'beaten defender is behind carrier');
    assert.ok(getAheadDelta(aheadDef, carrierBeat, beatLevel) > 0, 'ahead defender is in front of carrier');
    assert.ok(!canPressCarrier(beatenDef, carrierBeat, beatLevel), 'beaten defender far behind cannot press');
    assert.ok(canPressCarrier(aheadDef, carrierBeat, beatLevel), 'ahead defender can press');
    assert.ok(
        computePressPriority(aheadDef, carrierBeat, beatLevel) < computePressPriority(beatenDef, carrierBeat, beatLevel),
        'ahead defender has better press priority'
    );

    const carrierSim = simStick.players.find(p => p.team === 'A' && p.role !== 'GK');
    const bOutfield = simStick.players.filter(p => p.team === 'B' && p.role !== 'GK');
    const beatenSim = bOutfield[0];
    const aheadSim = bOutfield[1];
    for (const p of bOutfield.slice(2)) {
        p.x = 2;
        p.y = 2;
    }
    simStick.teamB.stickyPrimaryChaser = beatenSim;
    simStick._stickyPrimaryChasers = { A: null, B: beatenSim };
    simStick.ball.owner = carrierSim;
    carrierSim.x = Utils.scaleFieldX(68.75);
    beatenSim.x = Utils.scaleFieldX(31.25);
    aheadSim.x = Utils.scaleFieldX(75);
    aheadSim.y = field.centerY;
    const pressers = simStick.getActiveChasers();
    assert.ok(pressers.has(aheadSim), 'ahead defender takes press when beaten defender was sticky');
    assert.ok(!pressers.has(beatenSim), 'beaten defender released from chase duty');
    log('PASS beaten defender released; ahead defender presses');

    const savedHold = Settings.AI.FORMATION_HOLD;
    const savedPress = Settings.AI.DEFENSIVE_PRESS_INTENSITY;
    Settings.AI.FORMATION_HOLD = 1.0;
    Settings.AI.DEFENSIVE_PRESS_INTENSITY = 1.0;
    assert.strictEqual(effectiveDefensiveBlend(0.5), 0, 'full formation hold removes defensive collapse blend');
    Settings.AI.FORMATION_HOLD = 0;
    Settings.AI.DEFENSIVE_PRESS_INTENSITY = 0;
    assert.strictEqual(effectiveDefensiveBlend(0.4), 0, 'zero press intensity removes defensive collapse blend');
    Settings.AI.FORMATION_HOLD = savedHold;
    Settings.AI.DEFENSIVE_PRESS_INTENSITY = savedPress;
    log('PASS formation retention blend respects knobs');

    const supportSim = new Simulator();
    await supportSim.start();
    const carrierSup = supportSim.players.find(p => p.team === 'A' && p.role !== 'GK');
    const mates = supportSim.players.filter(p => p.team === 'A' && p !== carrierSup && p.role !== 'GK');
    supportSim.ball.owner = carrierSup;
    carrierSup.x = Utils.scaleFieldX(68.75);
    carrierSup.y = field.centerY;
    carrierSup.fsm.changeState(PlayerStates.Dribble);
    assert.ok(isCarrierInAttackingHalf(carrierSup, supportSim), 'carrier in attacking half');
    let supportAdvancers = 0;
    for (const m of mates) {
        const target = computeAttackSupportTarget(m, carrierSup, supportSim);
        if (isAheadOfFormationLine(m, target, supportSim)) supportAdvancers++;
    }
    assert.ok(supportAdvancers >= 2, `at least two attack support runners ahead of base (${supportAdvancers})`);
    log(`PASS attack support positioning (${supportAdvancers} runners ahead)`);

    const savedSupportIntensity = Settings.AI.ATTACK_SUPPORT_INTENSITY;
    Settings.AI.ATTACK_SUPPORT_INTENSITY = 0.8;
    carrierSup.y = field.centerY;
    const highIntensityTargets = mates.map(m => computeAttackSupportTarget(m, carrierSup, supportSim));
    const supportYSpread = Math.max(...highIntensityTargets.map(t => t.y)) - Math.min(...highIntensityTargets.map(t => t.y));
    assert.ok(supportYSpread >= Utils.scaleFieldY(25),
        `high-intensity support preserves lateral spread (${supportYSpread.toFixed(2)} >= ${Utils.scaleFieldY(25).toFixed(2)})`);
    let supportMinPairDist = Infinity;
    for (let i = 0; i < highIntensityTargets.length; i++) {
        for (let j = i + 1; j < highIntensityTargets.length; j++) {
            const a = highIntensityTargets[i];
            const b = highIntensityTargets[j];
            const d = Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
            if (d < supportMinPairDist) supportMinPairDist = d;
        }
    }
    assert.ok(supportMinPairDist >= Utils.scaleFieldY(9),
        `high-intensity support avoids tight clustering (min pair ${supportMinPairDist.toFixed(2)})`);
    Settings.AI.ATTACK_SUPPORT_INTENSITY = savedSupportIntensity;
    log(`PASS attack support spacing at high intensity (spread ${supportYSpread.toFixed(2)}, min pair ${supportMinPairDist.toFixed(2)})`);

    const passMate = mates.find(m => !isDefensiveOutfieldRole(m.role) && m.baseX >= carrierSup.baseX) || mates.find(m => !isDefensiveOutfieldRole(m.role));
    assert.ok(passMate, 'forward pass mate exists');
    passMate.x = carrierSup.x + Utils.scaleFieldX(15.625);
    passMate.y = field.centerY;
    assert.ok(isPassReceiverAhead(carrierSup, passMate, supportSim), 'support runner qualifies as pass receiver');
    const cbMate = mates.find(m => isDefensiveOutfieldRole(m.role));
    if (cbMate) {
        assert.ok(!isPassReceiverAhead(carrierSup, cbMate, supportSim) || !isDefensiveOutfieldRole(carrierSup.role),
            'defenders do not pass sideways to fellow defenders');
    }
    const savedPassAgg = Settings.AI.PASS_AGGRESSION;
    Settings.AI.PASS_AGGRESSION = 0;
    assert.strictEqual(computeDribblePassChance(carrierSup, 10), 0, 'zero pass aggression blocks passing');
    Settings.AI.PASS_AGGRESSION = savedPassAgg;
    carrierSup.x = Utils.getFieldBounds().width - Utils.scaleFieldX(9.375);
    const kick = computeShootKick(carrierSup);
    const nearMax = ((Settings.physics && Settings.physics.SHOOT_HEIGHT_NEAR_MIN) || 0.35)
        + ((Settings.physics && Settings.physics.SHOOT_HEIGHT_NEAR_SPAN) || 0.75);
    assert.ok(kick.heightSpeed <= nearMax + 1e-6, 'close-range shoot uses driven trajectory');
    carrierSup.x = Utils.scaleFieldX(68.75);
    log('PASS pass receiver projection and shoot kick height');

    let dynamicAdvancers = 0;
    for (let step = 0; step < 40; step++) {
        Time.deltaTime = 0.05;
        supportSim.update();
        for (const p of supportSim.players) p.update();
        supportSim.ball.update();
        carrierSup.x += Utils.scaleFieldX(0.46875);
        for (const m of mates) {
            const moveTarget = m.getIdleMoveTarget();
            if (isAheadOfFormationLine(m, moveTarget, supportSim)) dynamicAdvancers++;
        }
    }
    assert.ok(dynamicAdvancers >= 20, `dynamic support runs while carrier advances (${dynamicAdvancers} ahead-target frames)`);
    log(`PASS dynamic attack support while dribbling (${dynamicAdvancers} ahead-target frames)`);

    assert.ok(getShootRange() > 10, 'shoot range scales with field width');
    log('PASS scaled shoot range');

    const ball = new Ball();
    ball.x = 16;
    ball.y = 10;
    const carrier = makePlayer('BRA 10', 'A', 'LS', 18, 10, null);
    const chaser = makePlayer('ARG 5', 'B', 'LCM', 14, 9, null);
    const level = makeMockLevel([carrier, chaser], ball);
    carrier.level = level;
    chaser.level = level;
    ball.owner = carrier;

    const intercept = computeChaseInterceptTarget(chaser, ball);
    assert.notStrictEqual(intercept.x, ball.x);
    log(`PASS computeChaseInterceptTarget -> (${intercept.x.toFixed(2)}, ${intercept.y.toFixed(2)})`);

    const closeCommit = computeChaseInterceptTarget(chaser, ball);
    assert.strictEqual(closeCommit.x, carrier.x);
    assert.strictEqual(closeCommit.y, carrier.y);
    chaser.x = 6;
    chaser.y = 10;
    const farCut = computeChaseInterceptTarget(chaser, ball);
    assert.ok(farCut.x > carrier.x && farCut.x < Utils.getFieldBounds().width, 'far chaser aims at cut-off lane');
    chaser.x = 14;
    chaser.y = 10;
    log('PASS computeChaseInterceptTarget commits when close, cuts off when far');

    ball.owner = null;
    ball.x = 20;
    ball.y = 10;
    ball.vx = 6;
    ball.vy = 0;
    ball.vz = 0;
    chaser.x = 12;
    chaser.y = 10;
    const looseIntercept = computeLooseBallInterceptTarget(chaser, ball);
    assert.ok(looseIntercept.x > ball.x, 'loose-ball intercept leads moving ball');
    const stoppedIntercept = computeLooseBallInterceptTarget(chaser, { x: ball.x, y: ball.y, vx: 0, vy: 0 });
    assert.strictEqual(stoppedIntercept.x, ball.x);
    log(`PASS computeLooseBallInterceptTarget leads ball -> (${looseIntercept.x.toFixed(2)}, ${looseIntercept.y.toFixed(2)})`);

    ball.owner = null;
    ball.x = chaser.x + Settings.AI.BALL_CLAIM_RANGE * 0.5;
    ball.y = chaser.y;
    ball.z = 0;
    // Slow ball → clean first touch (A.8); claim lock cleared for deterministic unit check
    ball.vx = 0;
    ball.vy = 0;
    chaser.kickerClaimCooldown = 0;
    assert.ok(tryClaimLooseBall(chaser, ball), 'tryClaimLooseBall within BALL_CLAIM_RANGE');
    assert.strictEqual(ball.owner, chaser, 'clean claim assigns owner');
    ball.owner = null;
    ball.x = chaser.x + Settings.AI.BALL_CLAIM_RANGE + 0.5;
    assert.ok(!tryClaimLooseBall(chaser, ball), 'tryClaimLooseBall rejects out of range');
    log('PASS tryClaimLooseBall uses BALL_CLAIM_RANGE');

    const idleMate = makePlayer('BRA 8', 'A', 'LCM', 15, 10, null);
    const idleBall = new Ball();
    idleBall.x = idleMate.x + Settings.AI.LOOSE_BALL_PROXIMITY_RANGE * 0.6;
    idleBall.y = idleMate.y;
    idleBall.z = 0;
    idleBall.owner = null;
    const idleLevel = makeMockLevel([idleMate], idleBall);
    idleMate.level = idleLevel;
    const idleTarget = idleMate.getIdleMoveTarget();
    const idleForm = idleMate.getTargetFormationPos();
    const toBallFromTarget = dist2d(idleTarget.x, idleTarget.y, idleBall.x, idleBall.y);
    const toBallFromForm = dist2d(idleForm.x, idleForm.y, idleBall.x, idleBall.y);
    assert.ok(toBallFromTarget < toBallFromForm,
        `idle player near loose ball moves toward ball (targetDist=${toBallFromTarget.toFixed(2)} formDist=${toBallFromForm.toFixed(2)})`);
    log('PASS idle proximity pickup targets loose ball instead of fleeing to formation');

    const targets = [];
    for (let i = 0; i < 8; i++) {
        targets.push(computeDribbleTarget(carrier));
    }
    const uniqueY = new Set(targets.map(t => t.y.toFixed(1)));
    assert.ok(uniqueY.size > 1, 'dribble targets should vary');
    log(`PASS computeDribbleTarget varied Y values: ${[...uniqueY].join(', ')}`);

    const startX = carrier.x;
    // Dribble FSM requires possession
    ball.owner = carrier;
    ball.x = carrier.x;
    ball.y = carrier.y;
    ball.vx = 0;
    ball.vy = 0;
    carrier.fsm.changeState(PlayerStates.Dribble);
    const path = [];
    for (let step = 0; step < 30; step++) {
        Time.deltaTime = 0.05;
        carrier.fsm.update();
        ball.update();
        path.push({ x: carrier.x, y: carrier.y });
    }
    const end = path[path.length - 1];
    assert.ok(end.x > startX, 'carrier should advance toward goal');
    assert.ok(path.some((p, i) => i > 0 && Math.abs(p.y - path[i - 1].y) > 0.02), 'non-linear y movement');
    log(`PASS dribble path advance x=${startX.toFixed(1)}->${end.x.toFixed(1)} y drift present`);

    const passer = makePlayer('BRA 8', 'A', 'LCM', 14, 8, level);
    const receiverNear = makePlayer('BRA 9', 'A', 'RCM', 18, 8, level);
    const receiverFar = makePlayer('BRA 11', 'A', 'RS', 24, 12, level);
    level.players = [passer, receiverNear, receiverFar, chaser];
    passer.level = level;
    receiverNear.level = level;
    receiverFar.level = level;

    passer.passType = 'long';
    passer.passTarget = receiverFar;
    passer.fsm.changeState(PlayerStates.Pass);
    ball.owner = passer;
    ball.x = passer.x;
    ball.y = passer.y;
    Time.deltaTime = 0.25;
    passer.fsm.update();
    assert.strictEqual(ball.owner, null);
    assert.ok(ball.vz > 0, 'long pass must have vz > 0');
    log(`PASS long pass vz=${ball.vz.toFixed(2)} vx=${ball.vx.toFixed(2)}`);

    ball.owner = passer;
    passer.passType = 'short';
    passer.passTarget = receiverNear;
    passer.fsm.changeState(PlayerStates.Pass);
    Time.deltaTime = 0.25;
    passer.fsm.update();
    assert.strictEqual(ball.vz, 0, 'short pass vz should be 0');
    log('PASS short pass vz=0');

    carrier.x = 18;
    carrier.y = 10;
    carrier.orientation = 2;
    ball.owner = carrier;
    ball.x = carrier.x + 0.45;
    ball.y = carrier.y + 0.45;
    ball.z = 0;
    chaser.x = carrier.x + 0.35;
    chaser.y = carrier.y + 0.35;
    chaser.fsm.changeState(PlayerStates.ChaseBall);
    const origRandom = Math.random;
    try {
        Math.random = () => 0.01;
        Time.deltaTime = 0.05;
        chaser.fsm.update();
    } finally {
        Math.random = origRandom;
    }
    assert.ok(chaser.actionTimer > 0 || ball.owner === chaser, 'foot tackle attempted');
    log(`PASS foot tackle state actionTimer=${chaser.actionTimer.toFixed(2)} owner=${ball.owner?.name}`);

    chaser.actionTimer = 0;
    chaser.tackleAttemptCooldown = 0;
    chaser.x = carrier.x + 1.8;
    chaser.y = carrier.y + 0.3;
    ball.owner = carrier;
    ball.x = carrier.x + 0.45;
    ball.y = carrier.y + 0.45;
    chaser.isSliding = false;
    chaser.slideTimer = 0;
    chaser.fsm.changeState(PlayerStates.ChaseBall);
    Time.deltaTime = 0.05;
    chaser.fsm.update();
    assert.ok(chaser.isSliding, 'slide tackle initiated at medium range');
    for (let i = 0; i < 30 && chaser.isSliding; i++) {
        Time.deltaTime = 0.05;
        chaser.fsm.update();
    }
    assert.ok(!chaser.isSliding, 'slide tackle must resolve (not stuck)');
    log('PASS sliding tackle initiated and resolves');

    Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
    const sim = new Simulator();
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const simGk = sim.players.find(p => p.role === 'GK' && p.team === 'A');
    const simAttacker = sim.players.find(p => p.team === 'B' && p.role !== 'GK');
    simGk.stats.goalkeeping = 95;
    sim.ball.owner = null;
    sim.ball.x = simGk.x + 0.15;
    sim.ball.y = simGk.y;
    sim.ball.z = 0;
    sim.ball.vx = 0;
    sim.ball.vy = 0;

    let caughtNaturally = false;
    for (let i = 0; i < 80; i++) {
        Time.deltaTime = 0.05;
        sim.update();
        for (const p of sim.players) p.update();
        sim.ball.update();
        if (sim.ball.owner === simGk && isGkProtected(simGk)) {
            caughtNaturally = true;
            break;
        }
    }
    assert.ok(caughtNaturally, 'GK catch via natural sim update loop');
    assert.ok(isGkProtected(simGk), 'GK protected after natural catch');
    assert.strictEqual(canTackleOwner(simGk), false);
    log(`PASS natural GK catch hold=${simGk.gkHoldTimer.toFixed(2)} claim=${simGk.gkClaimTimer.toFixed(2)}`);

    simAttacker.x = simGk.x + 0.25;
    simAttacker.y = simGk.y;
    sim.updatePlayerAIStates();
    sim.update();
    await simAttacker.update();
    assert.strictEqual(sim.ball.owner, simGk, 'GK retains ball via simulator updatePlayerAIStates path');
    log('PASS GK claim blocks loss via simulator loop');

    // === Offside Rule Verification ===
    const originalStateObj = sim.fsm.currentState;
    const originalMatchTimer = sim.matchTimer;
    const originalSetPiece = sim.setPieceType;
    
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    
    const pA = sim.players.find(p => p.team === 'A' && p.role !== 'GK');
    const pA2 = sim.players.find(p => p.team === 'A' && p !== pA && p.role !== 'GK');
    const defendersB = sim.players.filter(p => p.team === 'B' && p.role !== 'GK');
    
    let offsideTriggered = false;
    sim.triggerOffside = function() {
        offsideTriggered = true;
    };
    
    // 1st Half: Team A attacks RIGHT
    sim.matchTimer = 1000; // 1st half
    offsideTriggered = false;
    pA.x = 60; pA.y = 25;
    pA2.x = 80; pA2.y = 25; // in opponent half (x > 50) and past ball (80 > 60)
    sim.ball.owner = pA;
    sim.ball.x = pA.x; sim.ball.y = pA.y;
    defendersB[0].x = 75; defendersB[0].y = 25;
    defendersB[1].x = 70; defendersB[1].y = 25; // second defender is at 70 (receiver 80 is past it)
    for (let i = 2; i < defendersB.length; i++) defendersB[i].x = 10;
    
    pA.passTarget = pA2;
    pA.passType = 'short';
    pA.kickTimer = 0.0;
    
    sim.cacheOffsideLines();
    PlayerStates.Pass.execute(pA);
    assert.strictEqual(offsideTriggered, false, 'Offside should not trigger immediately (delayed whistle)');
    assert.strictEqual(sim.ball.offsideReceiver, pA2, 'Ball should record offsideReceiver');
    
    // Trigger it by claiming the ball
    sim.ball.x = pA2.x; sim.ball.y = pA2.y;
    tryClaimLooseBall(pA2, sim.ball);
    assert.ok(offsideTriggered, 'Offside triggers for Team A attacking right in 1st half');
    
    // 2nd Half: Team A attacks LEFT
    sim.matchTimer = 3000; // 2nd half
    offsideTriggered = false;
    pA.x = 40; pA.y = 25;
    pA2.x = 20; pA2.y = 25; // in opponent half (x < 50) and past ball (20 < 40)
    sim.ball.owner = pA;
    sim.ball.x = pA.x; sim.ball.y = pA.y;
    defendersB[0].x = 25; defendersB[0].y = 25;
    defendersB[1].x = 30; defendersB[1].y = 25; // second defender is at 30 (receiver 20 is past it)
    for (let i = 2; i < defendersB.length; i++) defendersB[i].x = 90;
    
    pA.passTarget = pA2;
    pA.passType = 'short';
    pA.kickTimer = 0.0;
    
    sim.cacheOffsideLines();
    PlayerStates.Pass.execute(pA);
    assert.strictEqual(offsideTriggered, false, 'Offside should not trigger immediately (delayed whistle)');
    assert.strictEqual(sim.ball.offsideReceiver, pA2, 'Ball should record offsideReceiver');
    
    // Trigger it by claiming the ball
    sim.ball.x = pA2.x; sim.ball.y = pA2.y;
    tryClaimLooseBall(pA2, sim.ball);
    assert.ok(offsideTriggered, 'Offside triggers for Team A attacking left in 2nd half');
    
    // Clean up
    sim.matchTimer = originalMatchTimer;
    sim.setPieceType = originalSetPiece;
    sim.fsm.setCurrentState(originalStateObj);
    delete sim.triggerOffside;
    log('PASS offside rule check for first and second halves');

    log(`=== Run ${runId} ALL PASSED ===`);
    return true;
}

(async () => {
    let failed = false;
    for (const runId of [1, 2]) {
        try {
            await runExercise(runId);
        } catch (err) {
            failed = true;
            console.error(`Run ${runId} FAILED:`, err.message);
            console.error(err.stack);
        }
    }
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(`${SCRATCH}/ai_exercise.log`, logs.join('\n'));
    if (failed) process.exit(1);
    console.log('\nAI exercise: 2/2 runs passed');
})();