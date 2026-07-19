#!/usr/bin/env node
/**
 * Penalty box geometry, advantage, true IFK second-touch, box foul → penalty.
 */
function log(...args) {
    if (process.env.VERBOSE) console.log(...args);
}

require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const {
    isInPenaltyArea,
    isPenaltyFoul,
    getPenaltySpot,
    defendingGoalSide,
    shouldPlayAdvantage,
    advantageStillHolds,
    armIndirectFreeKick,
    clearIfkOnTouch,
    ADVANTAGE_WINDOW_SEC
} = require('../kernel/core/lib/match_rules.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    prepareSetPieceReady,
    executeSetPieceKick
} = require('../kernel/providers/simulator/set_piece_resume.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;

(function testPenaltyGeometry() {
    const field = Utils.getFieldBounds();
    const spotL = getPenaltySpot('left', field);
    const spotR = getPenaltySpot('right', field);
    assert.ok(spotL.x > 0 && spotL.x < field.centerX, 'left spot in left half');
    assert.ok(spotR.x > field.centerX && spotR.x < field.width, 'right spot in right half');
    assert.ok(Math.abs(spotL.y - field.centerY) < 1e-6);

    assert.strictEqual(isInPenaltyArea(spotL.x, spotL.y, 'left', field), true);
    assert.strictEqual(isInPenaltyArea(spotR.x, spotR.y, 'right', field), true);
    assert.strictEqual(isInPenaltyArea(field.centerX, field.centerY, 'left', field), false);

    const sim = { isSecondHalf: () => false };
    assert.strictEqual(defendingGoalSide(sim, 'A'), 'left');
    assert.strictEqual(defendingGoalSide(sim, 'B'), 'right');
    // Team B fouling in left box (A's box) is NOT a penalty for B's foul
    // Team A fouling in left box IS a penalty
    assert.strictEqual(isPenaltyFoul(sim, 'A', spotL.x, spotL.y), true);
    assert.strictEqual(isPenaltyFoul(sim, 'B', spotL.x, spotL.y), false);
    assert.strictEqual(isPenaltyFoul(sim, 'B', spotR.x, spotR.y), true);
    log('testPenaltyGeometry: PASS');
})();

(function testIfkSecondTouch() {
    const taker = { id: 1 };
    const mate = { id: 2 };
    const ball = { ifkActive: false, ifkTaker: null };
    armIndirectFreeKick(ball, taker);
    assert.strictEqual(ball.ifkActive, true);
    clearIfkOnTouch(ball, taker); // own reclaim does not clear
    assert.strictEqual(ball.ifkActive, true);
    clearIfkOnTouch(ball, mate);
    assert.strictEqual(ball.ifkActive, false);
    log('testIfkSecondTouch: PASS');
})();

(function testAdvantageHelpers() {
    const field = Utils.getFieldBounds();
    const fouled = { team: 'A', x: field.centerX + 10, y: field.centerY, isSentOff: false };
    const tackler = { team: 'B', x: fouled.x, y: fouled.y };
    const ball = { owner: fouled, x: fouled.x, y: fouled.y };
    const sim = {
        ball,
        matchState: 'play',
        isSecondHalf: () => false,
        lastTouchPlayer: fouled
    };
    assert.strictEqual(shouldPlayAdvantage(sim, tackler, fouled, { isPenalty: false, cardType: null }), true);
    assert.strictEqual(shouldPlayAdvantage(sim, tackler, fouled, { isPenalty: true }), false);
    assert.strictEqual(shouldPlayAdvantage(sim, tackler, fouled, { cardType: 'red' }), false);

    // Defending half → no advantage
    ball.x = 5;
    fouled.x = 5;
    assert.strictEqual(shouldPlayAdvantage(sim, tackler, fouled, {}), false);
    ball.x = fouled.x = field.centerX + 10;

    assert.ok(ADVANTAGE_WINDOW_SEC > 1);
    assert.strictEqual(advantageStillHolds(sim, { kickingTeam: 'A' }), true);
    ball.owner = tackler;
    assert.strictEqual(advantageStillHolds(sim, { kickingTeam: 'A' }), false);
    log('testAdvantageHelpers: PASS');
})();

async function integration() {
    const sim = new Simulator({ seed: 99 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    sim.matchTimer = 100; // first half

    const field = Utils.getFieldBounds();
    const spot = getPenaltySpot('left', field);

    // --- Box foul by team A defender → penalty for B ---
    const tackler = sim.players.find(p => p.team === 'A' && p.role !== 'GK' && !p.isSentOff);
    const victim = sim.players.find(p => p.team === 'B' && p.role !== 'GK' && !p.isSentOff);
    assert.ok(tackler && victim, 'need outfield pair');

    sim.ball.x = spot.x;
    sim.ball.y = spot.y;
    sim.ball.z = 0;
    sim.ball.owner = victim;
    sim.ball.vx = 0;
    sim.ball.vy = 0;

    // Force no card / no advantage noise: put victim without clear attack possession edge
    // by using a box foul (isPenalty blocks advantage) and mock card roll
    const origRoll = sim.rollFoulCard.bind(sim);
    sim.rollFoulCard = () => ({ showCard: false, cardType: null, tackleType: 'slide' });

    sim.triggerFoul(tackler, victim, { tackleType: 'slide' });
    assert.strictEqual(sim.matchState, 'foul', 'box foul stops play');
    assert.ok(sim._pendingFoulOutcome && sim._pendingFoulOutcome.isPenalty, 'pending marks penalty');

    // Drain foul react
    const { Time } = require('../kernel/core/lib/time.js');
    Time.deltaTime = 0.05;
    for (let i = 0; i < 20; i++) {
        sim.fsm.update();
        if (sim.matchState === 'penalty') break;
    }
    assert.strictEqual(sim.matchState, 'penalty', 'resolves to penalty state');
    assert.strictEqual(sim.setPieceType, 'penalty');
    assert.ok(Math.abs(sim.ball.x - spot.x) < 0.5, 'ball on spot');

    // Setup already ran in resolvePendingFoul; ready + kick path
    prepareSetPieceReady(sim, 'penalty');
    executeSetPieceKick(sim, 'penalty');
    const penTaker = sim.ball.owner;
    assert.ok(penTaker, 'penalty taker owns ball');
    assert.strictEqual(penTaker.fsm.getNameOfCurrentState(), 'Shoot', 'penalty → Shoot');

    // --- Advantage: foul outside box with possession in attack half ---
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    sim._pendingFoulOutcome = null;
    sim._pendingAdvantage = null;
    const atkX = field.centerX + 15;
    const atkY = field.centerY;
    sim.ball.x = atkX;
    sim.ball.y = atkY;
    sim.ball.owner = victim; // team B attacks left in 1H — wait, B defends right, attacks left
    // Team B attacks left → attack half is x < centerX
    const bAtkX = field.centerX - 15;
    sim.ball.x = bAtkX;
    sim.ball.owner = victim;
    victim.x = bAtkX;
    victim.y = atkY;
    const foulB = sim.players.find(p => p.team === 'A' && p.role !== 'GK' && p !== tackler);
    // Victim B has ball in B's attack half → advantage for B if A fouls
    sim.triggerFoul(foulB || tackler, victim, { tackleType: 'foot' });
    assert.ok(sim._pendingAdvantage, 'advantage window started');
    assert.strictEqual(sim.matchState, 'play', 'play continues on advantage');

    // Expire with possession held → wash
    sim._pendingAdvantage.timer = 0.01;
    sim.tickAdvantage(0.05);
    assert.strictEqual(sim._pendingAdvantage, null, 'advantage expires cleanly');
    assert.strictEqual(sim.matchState, 'play');

    // Restart advantage then lose ball → freekick
    sim.ball.owner = victim;
    sim.ball.x = bAtkX;
    sim.triggerFoul(foulB || tackler, victim, { tackleType: 'foot' });
    assert.ok(sim._pendingAdvantage);
    sim.ball.owner = tackler; // A steals
    sim.tickAdvantage(0.05);
    assert.strictEqual(sim.matchState, 'foul', 'advantage fizzle → foul stoppage');

    // Drain to freekick
    for (let i = 0; i < 30; i++) {
        sim.fsm.update();
        if (sim.matchState === 'freekick' || sim.matchState === 'card') break;
    }
    assert.ok(
        sim.matchState === 'freekick' || sim.matchState === 'card' || sim.matchState === 'foul',
        'advantage fizzle leads toward freekick path'
    );

    // --- True IFK: arm + invalid goal path ---
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceIndirect = true;
    sim.setPieceType = 'freekick';
    const ifkTaker = sim.players.find(p => p.team === 'B' && p.role !== 'GK');
    sim.ball.owner = ifkTaker;
    sim.ball.x = field.centerX;
    sim.ball.y = field.centerY;
    armIndirectFreeKick(sim.ball, ifkTaker);
    assert.strictEqual(sim.ball.ifkActive, true);

    // Simulate illegal goal → goalkick helper
    const scoreA0 = sim.scoreA;
    const scoreB0 = sim.scoreB;
    sim._resolveInvalidIfkGoal('left', false, field);
    assert.strictEqual(sim.scoreA, scoreA0, 'no score on invalid IFK');
    assert.strictEqual(sim.scoreB, scoreB0);
    assert.strictEqual(sim.matchState, 'goalkick');
    assert.strictEqual(sim.ball.ifkActive, false);

    // Offside awards indirect flag
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.ball.x = 40;
    sim.ball.y = field.centerY;
    sim.ball.owner = null;
    const offP = sim.players.find(p => p.team === 'A' && p.role === 'CF') || ifkTaker;
    sim.triggerOffside(offP);
    assert.strictEqual(sim.setPieceIndirect, true, 'offside → IFK flag');
    assert.strictEqual(sim.matchState, 'offside');

    sim.rollFoulCard = origRoll;
    log('integration: PASS');
}

integration()
    .then(() => {
        log('ALL_OK match_rules_events');
    })
    .catch((err) => {
        console.error('match_rules_events FAILED:', err);
        process.exit(1);
    });
