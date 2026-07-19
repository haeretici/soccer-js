#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * set_piece_resume_test.js
 * Exercises the central resume helper with a minimal stub to prove:
 * - walking flags cleared on taker
 * - all set-piece walkers snapped to targets (throw-in receivers/markers)
 * - owner synced to ball pos
 * - player FSM set to Pass/Shoot
 * - (caller does the final match state change + whistle)
 */
const assert = require('assert');
const {
  resumeSetPieceToPlay,
  prepareSetPieceReady,
  executeSetPieceKick,
  snapWalkingSetPiecePlayers,
  SET_PIECE_READY_HOLD
} = require('../kernel/providers/simulator/set_piece_resume.js');
const {
  biasThrowInAimInfield,
  clampThrowInDirection,
  biasCornerAimInfield,
  clampCornerKickDirection
} = require('../kernel/core/entities/player_states_outfield.js');

// Minimal stub that has the surface the helper touches
function makeStub(type) {
  const taker = {
    team: 'A',
    role: 'MF',
    x: 30, y: 40, z: 0,
    isSentOff: false,
    isWalkingToSetPiece: true,
    setPieceTarget: { x: 20, y: 30 },
    passTarget: null,
    passType: null,
    findBestPassTeammate() { return null; },
    fsm: { changeState(s) { this.lastState = s; } }
  };
  const ball = { x: 25, y: 35, z: 0, owner: taker, syncToOwner() { this.synced = true; } };
  const players = [taker];
  return {
    ball,
    players,
    setPieceKickingTeam: 'A',
    setPieceType: type,
    throwInReceivers: null,
    throwInTaker: null,
    freekickWallPlayers: [],
    findSetPieceTaker(team, x, y) {
      // return the taker (or a fake non-GK)
      return taker;
    },
    fsm: { changeState(s) { this.last = s; } }
  };
}

(function testSnapWalkingHelper() {
  const a = {
    isSentOff: false,
    isWalkingToSetPiece: true,
    setPieceTarget: { x: 10, y: 12 },
    x: 1, y: 2, z: 0.5, vx: 1, vy: 1, frame: 2
  };
  const b = {
    isSentOff: false,
    isWalkingToSetPiece: false,
    setPieceTarget: null,
    x: 5, y: 5
  };
  const n = snapWalkingSetPiecePlayers({ players: [a, b] });
  assert.strictEqual(n, 1);
  assert.strictEqual(a.x, 10);
  assert.strictEqual(a.y, 12);
  assert.strictEqual(a.isWalkingToSetPiece, false);
  assert.strictEqual(a.setPieceTarget, null);
  assert.strictEqual(b.x, 5);
  log('testSnapWalkingHelper: PASS');
})();

(function testGoalkickKeepsGKAndClearsFlags() {
  const sim = makeStub('goalkick');
  const gk = { ...sim.players[0], role: 'GK' };
  sim.players[0] = gk;
  sim.ball.owner = gk;
  gk.isWalkingToSetPiece = true;
  gk.setPieceTarget = { x: 1, y: 2 };

  resumeSetPieceToPlay(sim, 'goalkick');

  assert.strictEqual(gk.isWalkingToSetPiece, false, 'cleared walking');
  assert.strictEqual(gk.setPieceTarget, null, 'cleared target');
  assert.strictEqual(sim.ball.owner, gk, 'owner is GK');
  assert.ok(Math.abs(sim.ball.x - gk.x) < 0.01 && Math.abs(sim.ball.y - gk.y) < 0.01, 'snapped to ball');
  assert.ok(sim.ball.synced, 'sync called');
  assert.ok(gk.fsm.lastState && gk.fsm.lastState.name === 'Pass', 'GK put into Pass');
  log('testGoalkickKeepsGKAndClearsFlags: PASS');
})();

(function testThrowinClearsWalkingAndSetsPass() {
  const sim = makeStub('throwin');
  resumeSetPieceToPlay(sim, 'throwin');
  const taker = sim.ball.owner;
  assert.strictEqual(taker.isWalkingToSetPiece, false);
  assert.strictEqual(taker.setPieceTarget, null);
  assert.ok(Math.abs(taker.x - sim.ball.x) < 0.01, 'taker snapped to ball after walker snap');
  assert.ok(taker.fsm.lastState && taker.fsm.lastState.name === 'Pass');
  log('testThrowinClearsWalkingAndSetsPass: PASS');
})();

(function testThrowinSnapsReceiversAndMarkers() {
  const sim = makeStub('throwin');
  const taker = sim.players[0];
  // Taker walks to sideline; resume later snaps them onto the ball
  taker.setPieceTarget = { x: 25, y: 35 };
  taker.x = 40;
  taker.y = 10;
  const recv = {
    team: 'A',
    role: 'MF',
    isSentOff: false,
    isWalkingToSetPiece: true,
    setPieceTarget: { x: 28, y: 12 },
    x: 50, y: 40, z: 0, vx: 0, vy: 0,
    fsm: { changeState() {} }
  };
  const marker = {
    team: 'B',
    role: 'DF',
    isSentOff: false,
    isWalkingToSetPiece: true,
    setPieceTarget: { x: 30, y: 12 },
    x: 60, y: 40, z: 0, vx: 0, vy: 0,
    fsm: { changeState() {} }
  };
  sim.players.push(recv, marker);
  sim.throwInReceivers = [recv];
  sim.throwInTaker = taker;

  resumeSetPieceToPlay(sim, 'throwin');

  assert.strictEqual(recv.isWalkingToSetPiece, false);
  assert.strictEqual(recv.setPieceTarget, null);
  assert.strictEqual(recv.x, 28);
  assert.strictEqual(recv.y, 12);
  assert.strictEqual(marker.isWalkingToSetPiece, false);
  assert.strictEqual(marker.x, 30);
  assert.strictEqual(marker.y, 12);
  // Taker ends on ball (resume override after walker snap to sideline target)
  assert.ok(Math.abs(taker.x - sim.ball.x) < 0.01);
  assert.ok(Math.abs(taker.y - sim.ball.y) < 0.01);
  log('testThrowinSnapsReceiversAndMarkers: PASS');
})();

(function testCornerNoWalkersNoOp() {
  // Corner teleports in setup; resume walker snap is a no-op
  const sim = makeStub('corner');
  const taker = sim.players[0];
  taker.isWalkingToSetPiece = false;
  taker.setPieceTarget = null;
  taker.x = 0;
  taker.y = 0;
  sim.ball.x = 0;
  sim.ball.y = 0;
  sim.setPieceSide = 'left';
  sim.setPieceCornerY = 0;
  resumeSetPieceToPlay(sim, 'corner');
  assert.strictEqual(taker.isWalkingToSetPiece, false);
  assert.ok(taker.fsm.lastState && taker.fsm.lastState.name === 'Pass');
  log('testCornerNoWalkersNoOp: PASS');
})();

(function testReadyHoldThenKick() {
  assert.ok(SET_PIECE_READY_HOLD >= 1.5 && SET_PIECE_READY_HOLD <= 3.0, 'ready hold ~2s');
  const sim = makeStub('throwin');
  const taker = sim.players[0];
  taker.x = 40;
  taker.y = 10;
  taker.setPieceTarget = { x: 25, y: 35 };
  sim.ball.x = 25;
  sim.ball.y = 35;

  // Phase 1: snap + ready, no Pass yet
  prepareSetPieceReady(sim, 'throwin');
  assert.strictEqual(taker.x, 25);
  assert.strictEqual(taker.y, 35);
  assert.strictEqual(sim.ball.owner, taker);
  assert.strictEqual(taker.frame, 12, 'throw ready pose');
  // Idle during hold (fsm stub records last changeState)
  assert.ok(
    !taker.fsm.lastState || taker.fsm.lastState.name === 'Idle',
    'not in Pass during ready'
  );

  // Phase 2: kick
  executeSetPieceKick(sim, 'throwin');
  assert.ok(taker.fsm.lastState && taker.fsm.lastState.name === 'Pass');
  log('testReadyHoldThenKick: PASS');
})();

(function testThrowInAimBiasedInfield() {
  const field = { width: 106, height: 68, centerY: 34, multiplier: 1 };
  // Shallow lead aim near top touchline (classic re-exit case)
  const taker = { x: 18, y: 0.55 };
  const shallow = { x: 5.5, y: 2.4 };
  const biased = biasThrowInAimInfield(shallow, taker, field);
  assert.ok(biased.y >= taker.y + 6.0 - 1e-6, 'aim pushed deep into pitch from top line');
  assert.ok(biased.y >= 2.0, 'aim clear of touchline strip');

  const bottomTaker = { x: 50, y: 67.4 };
  const bottomAim = biasThrowInAimInfield({ x: 40, y: 66 }, bottomTaker, field);
  assert.ok(bottomAim.y <= bottomTaker.y - 6.0 + 1e-6, 'aim pushed in from bottom line');

  // Near-parallel noise that would skim the line must be clamped hard inward
  const outDir = clampThrowInDirection(-0.99, -0.05, taker, field);
  assert.ok(outDir.ny >= 0.55 - 1e-6, 'throw direction forced deep into pitch (top)');
  const len = Math.sqrt(outDir.nx * outDir.nx + outDir.ny * outDir.ny);
  assert.ok(Math.abs(len - 1) < 1e-6, 'direction remains unit length');

  const botDir = clampThrowInDirection(0.5, 0.2, bottomTaker, field);
  assert.ok(botDir.ny <= -0.55 + 1e-6, 'throw direction forced deep into pitch (bottom)');
  // |vy| at typical short-throw speed must not be a skim
  const speed = 11;
  assert.ok(Math.abs(botDir.ny * speed) >= 6.0, 'inward speed component keeps ball off the strip');
  log('testThrowInAimBiasedInfield: PASS');
})();

(function testThrowinPrepareClampsOobBall() {
  // Residual OOB velocity used to leave the ball outside the pitch after setup;
  // prepare must pull it back onto the touchline before the ready snap.
  const sim = makeStub('throwin');
  const taker = sim.players[0];
  sim.ball.x = 40;
  sim.ball.y = -0.8;
  sim.ball.vx = 5;
  sim.ball.vy = -12;
  sim.ball.z = 0.4;
  sim.ball.isThrowInFlight = true;
  taker.x = 10;
  taker.y = 10;
  taker.isWalkingToSetPiece = true;
  taker.setPieceTarget = { x: 40, y: 0.55 };

  prepareSetPieceReady(sim, 'throwin');

  assert.ok(sim.ball.y >= 0.55 - 1e-6, 'ball pulled onto top touchline inset');
  assert.ok(sim.ball.y < 2, 'still on touchline strip');
  assert.strictEqual(sim.ball.vx, 0);
  assert.strictEqual(sim.ball.vy, 0);
  assert.strictEqual(sim.ball.z, 0);
  assert.strictEqual(sim.ball.isThrowInFlight, false);
  assert.ok(Math.abs(taker.x - sim.ball.x) < 0.01);
  assert.ok(Math.abs(taker.y - sim.ball.y) < 0.01 || Math.abs(taker.y - 0.55) < 0.5);
  assert.ok(sim._setPieceBallSpot, 'records set-piece ball spot');
  assert.ok(Math.abs(sim._setPieceBallSpot.y - sim.ball.y) < 1e-6);
  log('testThrowinPrepareClampsOobBall: PASS');
})();

(function testThrowinPreparePinsToSpotNoCarry() {
  const sim = makeStub('throwin');
  const taker = sim.players[0];
  sim._setPieceBallSpot = { x: 40, y: 0.55 };
  sim.ball.x = 99;
  sim.ball.y = 99;
  taker.x = 10;
  taker.y = 20;
  prepareSetPieceReady(sim, 'throwin');
  assert.strictEqual(sim.ball.x, 40);
  assert.strictEqual(sim.ball.y, 0.55);
  assert.strictEqual(taker.x, 40);
  assert.strictEqual(taker.y, 0.55);
  // Must not use carry-offset sync (ball stays on spot)
  assert.ok(!sim.ball.synced, 'throw-in ready does not carry-sync');
  log('testThrowinPreparePinsToSpotNoCarry: PASS');
})();

(function testCornerPreparePinsInfieldSpot() {
  const sim = makeStub('corner');
  const taker = sim.players[0];
  sim.setPieceSide = 'left';
  sim.setPieceCornerY = 0;
  // Classic bug: ball/taker outside after carry-style placement
  sim.ball.x = -0.2;
  sim.ball.y = -0.2;
  taker.x = -0.2;
  taker.y = -0.2;
  prepareSetPieceReady(sim, 'corner');
  assert.ok(sim.ball.x >= 0.55 - 1e-6, 'corner ball inset into pitch X');
  assert.ok(sim.ball.y >= 0.55 - 1e-6, 'corner ball inset into pitch Y');
  assert.ok(sim.ball.x < 2 && sim.ball.y < 2, 'still near the flag');
  assert.ok(!sim.ball.synced, 'corner ready does not carry-sync');
  assert.ok(sim._setPieceBallSpot, 'records corner spot');
  log('testCornerPreparePinsInfieldSpot: PASS');
})();

(function testCornerAimBiasedInfield() {
  const field = { width: 106, height: 68, centerY: 34, multiplier: 1 };
  const shallow = { x: 1, y: 1 };
  const biased = biasCornerAimInfield(shallow, 'left', 0, field);
  assert.ok(biased.x >= 6 - 1e-6, 'corner aim pushed off left goal line');
  assert.ok(biased.y >= 6 - 1e-6, 'corner aim pushed off top touchline');

  const dir = clampCornerKickDirection(-0.9, -0.1, 'left', 0, field);
  assert.ok(dir.nx >= 0.45 - 1e-6, 'corner kick +X into pitch');
  assert.ok(dir.ny >= 0.4 - 1e-6, 'corner kick +Y into pitch');
  log('testCornerAimBiasedInfield: PASS');
})();

log('set_piece_resume_test: ALL PASS');