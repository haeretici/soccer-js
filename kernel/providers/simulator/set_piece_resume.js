const { PlayerStates } = require('../../core/entities/player.js');
const { GOAL_HEIGHT_REF } = require('../../core/entities/goal.js');
const { Utils } = require('../../core/lib/utils.js');
const {
    pickCornerTarget,
    freekickShouldShoot
} = require('../../core/lib/set_piece_playbooks.js');
const {
    canShootPastWall,
    snapWallToHold
} = require('../../core/lib/freekick_wall.js');
const {
  biasThrowInAimInfield,
  biasCornerAimInfield
} = require('../../core/entities/player_states_outfield.js');

/** Logic seconds to hold after snap, before Pass/Shoot (human reaction window). */
const SET_PIECE_READY_HOLD = 2.0;

/**
 * Snap every player still walking to a set-piece target (throw-in receivers/markers,
 * freekick shape walk-back, etc.). Clears walk flags so open play does not start mid-jog.
 * Wall bodies use wallHold* when tagged (same anchors as A.6 hold).
 * @param {object} sim
 * @returns {number} how many players were snapped
 */
function snapWalkingSetPiecePlayers(sim) {
  if (!sim || !sim.players) return 0;
  let n = 0;
  for (let i = 0; i < sim.players.length; i++) {
    const p = sim.players[i];
    if (!p || p.isSentOff) continue;
    if (!p.isWalkingToSetPiece || !p.setPieceTarget) continue;

    if (p.isInWall && p.wallHoldX != null && p.wallHoldY != null) {
      p.x = p.wallHoldX;
      p.y = p.wallHoldY;
    } else {
      p.x = p.setPieceTarget.x;
      p.y = p.setPieceTarget.y;
    }
    p.z = 0;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.isWalkingToSetPiece = false;
    p.setPieceTarget = null;
    p.frame = 0;
    n++;
  }
  return n;
}

/**
 * Resolve set-piece taker (same rules as resume). Does not move them.
 * @param {object} sim
 * @param {string} resumeType
 * @returns {object|null}
 */
function resolveSetPieceTaker(sim, resumeType) {
  let taker = sim.ball && sim.ball.owner;
  const kickingTeam = sim.setPieceKickingTeam || (taker && taker.team);
  const isGoalkick = resumeType === 'goalkick';

  if (!taker || taker.isSentOff || (taker.role === 'GK' && !isGoalkick)) {
    taker = sim.findSetPieceTaker
      ? sim.findSetPieceTaker(kickingTeam, sim.ball.x, sim.ball.y)
      : null;
  }

  if (resumeType === 'throwin' && sim.throwInTaker && !sim.throwInTaker.isSentOff) {
    taker = sim.throwInTaker;
  }

  return taker || null;
}

/**
 * Phase 1 of set-piece end: snap walkers/wall, place taker on ball, stand ready.
 * Does **not** enter Pass/Shoot — call executeSetPieceKick after SET_PIECE_READY_HOLD.
 * @param {object} sim
 * @param {string} resumeType
 * @returns {object|null} taker
 */
function prepareSetPieceReady(sim, resumeType) {
  if (resumeType === 'freekick') {
    snapWallToHold(sim);
  }
  snapWalkingSetPiecePlayers(sim);

  const taker = resolveSetPieceTaker(sim, resumeType);
  if (!taker || !sim.ball) return null;

  taker.isWalkingToSetPiece = false;
  taker.setPieceTarget = null;

  // Boundary set-pieces: pin ball to recorded in-field spot (never carry-offset OOB).
  if ((resumeType === 'throwin' || resumeType === 'corner') && sim.ball) {
    const field = Utils.getFieldBounds();
    const margin = field.multiplier || 1;
    const inset = Math.max(margin * 0.45, 0.55);
    let sx = sim._setPieceBallSpot ? sim._setPieceBallSpot.x : sim.ball.x;
    let sy = sim._setPieceBallSpot ? sim._setPieceBallSpot.y : sim.ball.y;
    const oob = sx < 0 || sx > field.width || sy < 0 || sy > field.height
      || sx < inset * 0.5 || sx > field.width - inset * 0.5
      || sy < inset * 0.5 || sy > field.height - inset * 0.5;
    if (oob) {
      if (resumeType === 'corner') {
        const side = sim.setPieceSide;
        const cornerY = sim.setPieceCornerY != null ? sim.setPieceCornerY : 0;
        sx = (side === 'left') ? inset : field.width - inset;
        sy = (cornerY < field.centerY) ? inset : field.height - inset;
      } else {
        const preferTop = sy <= field.centerY;
        sx = Math.max(inset, Math.min(field.width - inset, sx));
        sy = preferTop ? inset : (field.height - inset);
      }
    }
    sim._setPieceBallSpot = { x: sx, y: sy };
    sim.ball.x = sx;
    sim.ball.y = sy;
    sim.ball.vx = 0;
    sim.ball.vy = 0;
    sim.ball.vz = 0;
    sim.ball.z = 0;
    sim.ball.isThrowInFlight = false;
    // Taker: throw-in on the spot; corner stays just outside the flag for look
    if (resumeType === 'throwin') {
      taker.x = sx;
      taker.y = sy;
    } else {
      const side = sim.setPieceSide;
      const cornerY = sim.setPieceCornerY != null ? sim.setPieceCornerY : 0;
      const offset = 0.35;
      taker.x = (side === 'left') ? -offset : field.width + offset;
      taker.y = (cornerY < field.centerY) ? -offset : field.height + offset;
    }
  } else {
    taker.x = sim.ball.x;
    taker.y = sim.ball.y;
  }

  taker.z = 0;
  taker.vx = 0;
  taker.vy = 0;
  taker.vz = 0;
  // Ready pose: throw arms up / kick plant (held during setPieceReadyPhase freeze)
  taker.frame = resumeType === 'throwin' ? 12 : 3;
  sim.ball.owner = taker;
  // Open-field set pieces use carry offset; boundary ones stay on the fixed spot.
  if (resumeType !== 'throwin' && resumeType !== 'corner' && typeof sim.ball.syncToOwner === 'function') {
    sim.ball.syncToOwner();
  }

  // Stay in Idle so FSM does not start windup until execute
  if (taker.fsm && PlayerStates.Idle) {
    taker.fsm.changeState(PlayerStates.Idle);
  }

  return taker;
}

/**
 * Phase 2: choose Pass/Shoot and arm kick (after ready hold).
 * Assumes prepareSetPieceReady already ran (or call resumeSetPieceToPlay for both).
 * @param {object} sim
 * @param {string} resumeType
 */
function executeSetPieceKick(sim, resumeType) {
  const isGoalkick = resumeType === 'goalkick';
  const playbook = sim.activePlaybook || null;
  const kickPrefs = (playbook && playbook.def && playbook.def.kick) || {};

  let taker = resolveSetPieceTaker(sim, resumeType);
  if (!taker || !sim.ball) {
    if (sim) sim.activePlaybook = null;
    return;
  }

  // Ensure still on the ball after ready hold
  taker.isWalkingToSetPiece = false;
  taker.setPieceTarget = null;
  if ((resumeType === 'throwin' || resumeType === 'corner') && sim._setPieceBallSpot) {
    const spot = sim._setPieceBallSpot;
    sim.ball.x = spot.x;
    sim.ball.y = spot.y;
    sim.ball.z = 0;
    sim.ball.vx = 0;
    sim.ball.vy = 0;
    sim.ball.vz = 0;
    if (resumeType === 'throwin') {
      taker.x = spot.x;
      taker.y = spot.y;
    }
  } else {
    taker.x = sim.ball.x;
    taker.y = sim.ball.y;
  }
  taker.z = 0;
  sim.ball.owner = taker;
  if (resumeType !== 'throwin' && resumeType !== 'corner' && typeof sim.ball.syncToOwner === 'function') {
    sim.ball.syncToOwner();
  }

  const squad = sim.getTeam ? sim.getTeam(taker.team) : null;
  const teammates = squad
    ? squad.getOutfieldPlayers().filter(p => p !== taker)
    : (sim.players || []).filter(p =>
      p.team === taker.team && p !== taker && p.role !== 'GK' && !p.isSentOff
    );

  if (resumeType === 'corner') {
    const side = sim.setPieceSide;
    const field = Utils.getFieldBounds();
    const fcY = field.centerY;
    const boxXMin = (side === 'left')
      ? Utils.scaleFieldX(3.125)
      : field.width - Utils.scaleFieldX(15.625);
    const boxXMax = (side === 'left')
      ? Utils.scaleFieldX(15.625)
      : field.width - Utils.scaleFieldX(3.125);
    const boxYMin = fcY - Utils.scaleFieldY(17.5);
    const boxYMax = fcY + Utils.scaleFieldY(17.5);

    const targetsInBox = teammates.filter(p =>
      p.x >= boxXMin && p.x <= boxXMax && p.y >= boxYMin && p.y <= boxYMax
    );
    const pool = targetsInBox.length > 0 ? targetsInBox : teammates;
    const passType = kickPrefs.passType === 'short' ? 'short' : 'long';
    const cornerY = sim.setPieceCornerY != null ? sim.setPieceCornerY : 0;

    let target = pickCornerTarget(pool, playbook, side, cornerY, field);
    if (squad && typeof squad.pickBestSafePassTarget === 'function' && pool.length > 0) {
      const biasPool = target && pool.indexOf(target) >= 0
        ? (kickPrefs.targetBias === 'near' || kickPrefs.targetBias === 'far'
            ? pool.filter((p) => {
                const nearIsTop = cornerY < fcY;
                const wantTop = kickPrefs.targetBias === 'near' ? nearIsTop : !nearIsTop;
                return wantTop ? p.y < fcY : p.y >= fcY;
              })
            : pool)
        : pool;
      const safePool = biasPool.length ? biasPool : pool;
      const safe = squad.pickBestSafePassTarget(taker, safePool, {
        passType,
        scoreFn: () => Math.random()
      });
      if (safe) target = safe;
    }
    if (!target) {
      target = pool[Math.floor(Math.random() * pool.length)] || teammates[0];
    }

    taker.passTarget = target;
    taker.passType = passType;
    let aim = (squad && target && typeof squad.getBestPassToReceiver === 'function')
      ? squad.getBestPassToReceiver(taker, target, { passType })
      : null;
    aim = aim || (target ? { x: target.x, y: target.y } : null);
    if (aim) {
      aim = biasCornerAimInfield(aim, sim.setPieceSide, cornerY, field);
    }
    taker.passAim = aim;
    taker.fsm.changeState(PlayerStates.Pass);
  } else if (resumeType === 'goalkick') {
    const preferType = kickPrefs.passType === 'short' ? 'short' : 'long';
    const decision = (typeof taker.findBestPassTarget === 'function')
      ? taker.findBestPassTarget({ passType: preferType })
      : null;
    let target = decision ? decision.teammate : null;
    let aim = decision ? decision.aim : null;
    let passType = decision ? decision.type : preferType;
    if (!target) {
      target = (squad && squad.pickBestSafePassTarget(taker, teammates, { passType }))
        || teammates[0];
      aim = (squad && target && typeof squad.getBestPassToReceiver === 'function')
        ? squad.getBestPassToReceiver(taker, target, { passType })
        : null;
    }
    taker.passTarget = target;
    taker.passType = passType;
    taker.passAim = aim;
    taker.fsm.changeState(PlayerStates.Pass);
  } else if (resumeType === 'penalty') {
    // Spot kick: always shoot at goal with modest aim noise
    const field = Utils.getFieldBounds();
    const fcY = field.centerY;
    const defendingTeam = (taker.team === 'A') ? 'B' : 'A';
    const gx = (defendingTeam === 'A') ? 0 : field.width;
    const goalH = Utils.scaleFieldY(GOAL_HEIGHT_REF || 7.0);
    // Prefer corners of the goal slightly
    const yBias = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.35) * goalH;
    taker.shotAim = { x: gx, y: fcY + yBias };
    // Driven pen — not a sky chip
    taker.shotHeightBoost = 0.6 + Math.random() * 1.2;
    taker.fsm.changeState(PlayerStates.Shoot);
  } else if (resumeType === 'freekick') {
    const field = Utils.getFieldBounds();
    const fcY = field.centerY;
    const defendingTeam = (taker.team === 'A') ? 'B' : 'A';
    const gx = (defendingTeam === 'A') ? 0 : field.width;
    const gy = fcY;
    const distToGoal = Math.sqrt(Math.pow(gx - taker.x, 2) + Math.pow(gy - taker.y, 2));
    const shootRange = Utils.scaleFieldX(37.5);
    // True IFK: never shoot first — must be touched by another player before a goal counts
    const isIndirect = !!(sim && sim.setPieceIndirect);

    const wallPlayers = (sim && sim.freekickWallPlayers) || [];
    let willShoot = false;
    let shotResult = null;
    if (!isIndirect && distToGoal < shootRange) {
      if (squad && typeof squad.canShoot === 'function') {
        if (wallPlayers.length > 0) {
          const otherOpps = squad.getOpponentPool
            ? squad.getOpponentPool().filter(p => !p.isInWall)
            : [];
          shotResult = canShootPastWall(
            { x: taker.x, y: taker.y },
            taker,
            wallPlayers,
            otherOpps,
            { oppGoalX: gx, field }
          );
        } else {
          shotResult = squad.canShoot({ x: taker.x, y: taker.y }, taker);
        }
        willShoot = freekickShouldShoot(playbook, !!(shotResult && shotResult.ok), distToGoal, shootRange);
      } else {
        willShoot = freekickShouldShoot(playbook, true, distToGoal, shootRange);
      }
    }

    if (willShoot) {
      taker.shotAim = shotResult && shotResult.target ? shotResult.target : null;
      taker.shotHeightBoost = (shotResult && shotResult.heightSpeed != null)
        ? shotResult.heightSpeed
        : null;
      taker.fsm.changeState(PlayerStates.Shoot);
    } else {
      const teammatesList = squad
        ? squad.getOutfieldPlayers().filter(p => p !== taker)
        : (sim.players || []).filter(p =>
          p.team === taker.team && p !== taker && p.role !== 'GK' && !p.isSentOff
        );
      let passType = kickPrefs.passType === 'long' ? 'long' : 'short';
      let target = null;
      if (squad && typeof squad.pickBestSafePassTarget === 'function') {
        target = squad.pickBestSafePassTarget(taker, teammatesList, { passType });
        if (!target && passType === 'short') {
          // Fallback to long pass if short pass is unsafe
          target = squad.pickBestSafePassTarget(taker, teammatesList, { passType: 'long' });
          if (target) {
            passType = 'long';
          }
        }
      }
      
      if (target) {
        taker.passTarget = target;
        taker.passType = passType;
        taker.passAim = (squad && typeof squad.getBestPassToReceiver === 'function')
          ? squad.getBestPassToReceiver(taker, target, { passType })
          : null;
        taker.fsm.changeState(PlayerStates.Pass);
      } else if (isIndirect) {
        // IFK with no safe receiver: short lay-off toward nearest teammate or clear sideways
        const nearest = teammatesList.slice().sort((a, b) => {
          const da = Math.pow(a.x - taker.x, 2) + Math.pow(a.y - taker.y, 2);
          const db = Math.pow(b.x - taker.x, 2) + Math.pow(b.y - taker.y, 2);
          return da - db;
        })[0];
        if (nearest) {
          taker.passTarget = nearest;
          taker.passType = 'short';
          taker.passAim = { x: nearest.x, y: nearest.y };
          taker.fsm.changeState(PlayerStates.Pass);
        } else {
          // No teammate: push ball infield (still arms IFK; goal without touch won't count)
          const inNx = (field.centerX - taker.x) >= 0 ? 1 : -1;
          taker.shotAim = { x: taker.x + inNx * 8, y: gy + (Math.random() - 0.5) * 6 };
          taker.shotHeightBoost = 0.5;
          taker.fsm.changeState(PlayerStates.Shoot);
        }
      } else {
        // If no safe pass exists, shoot/clear towards opponent's goal
        const goalH = Utils.scaleFieldY(GOAL_HEIGHT_REF || 7.0);
        taker.shotAim = {
          x: gx,
          y: gy + (Math.random() - 0.5) * goalH * 0.5
        };
        taker.shotHeightBoost = 1.5 + Math.random() * 2.0;
        taker.fsm.changeState(PlayerStates.Shoot);
      }
    }
  } else if (resumeType === 'throwin') {
    let target = null;
    const passType = kickPrefs.passType === 'long' ? 'long' : 'short';
    const throwPool = (sim.throwInReceivers && sim.throwInReceivers.length > 0)
      ? sim.throwInReceivers.filter(p => !p.isSentOff)
      : teammates;
    if (squad && typeof squad.pickBestSafePassTarget === 'function' && throwPool.length > 0) {
      target = squad.pickBestSafePassTarget(taker, throwPool, { passType });
    }
    if (!target && throwPool.length > 0) {
      target = throwPool[Math.floor(Math.random() * throwPool.length)];
    }
    if (!target) {
      target = (typeof taker.findBestPassTeammate === 'function' ? taker.findBestPassTeammate() : null)
        || teammates[0];
    }
    taker.passTarget = target;
    taker.passType = passType;
    // Prefer feet over progressive lead aims — lead points near the touchline
    // + kick noise re-exit and restart the throw-in (especially when receivers
    // were walked/snapped close to the sideline from a long setup).
    if (target) {
      let aim = null;
      if (squad && typeof squad.getBestPassToReceiver === 'function') {
        aim = squad.getBestPassToReceiver(taker, target, { passType, preferFeet: true });
      }
      aim = aim || { x: target.x, y: target.y };
      // Bias here as well as on release so windup and kick share one infield aim.
      aim = biasThrowInAimInfield(aim, taker, Utils.getFieldBounds());
      taker.passAim = aim;
    } else {
      taker.passAim = null;
    }
    taker.fsm.changeState(PlayerStates.Pass);
  }

  if (resumeType === 'throwin' && sim) {
    sim.throwInTaker = null;
  }

  if (sim) {
    // Arm IFK second-touch gate when the set piece was marked indirect (offside etc.)
    // Actual arm happens on ball.kick from Pass/Shoot — flag stays until then.
    // Clear bookkeeping so open play doesn't re-pick freekick wall on next frame.
    sim.activePlaybook = null;
    sim.setPieceReadyPhase = false;
  }
}

/**
 * Full snap + kick in one call (tests / headless helpers). Match FSM uses
 * prepareSetPieceReady → SET_PIECE_READY_HOLD → executeSetPieceKick instead.
 *
 * @param {object} sim
 * @param {string} resumeType - 'corner' | 'goalkick' | 'freekick' | 'penalty' | 'throwin'
 */
function resumeSetPieceToPlay(sim, resumeType) {
  prepareSetPieceReady(sim, resumeType);
  executeSetPieceKick(sim, resumeType);
}

module.exports = {
  SET_PIECE_READY_HOLD,
  resumeSetPieceToPlay,
  prepareSetPieceReady,
  executeSetPieceKick,
  snapWalkingSetPiecePlayers,
  resolveSetPieceTaker
};
