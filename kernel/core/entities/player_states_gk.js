const { futurePosition } = require('../lib/ball_prediction.js');

/**
 * Goalkeeper FSM states (Goalkeeper, GkDive). Keep separate from outfield for readability.
 *
 * Composition over inheritance: one Player entity; states registered on shared bag.
 *
 * Save model (tuned for SHOOT_SPEED_BASE ~20 m/s):
 *  - Adaptive prediction horizon (not fixed 0.3 s)
 *  - Dive commits on most shots / firm balls
 *  - Segment catch so fast balls cannot tunnel through GK_CATCH_RANGE in one tick
 *
 * @param {object} PlayerStates
 * @param {object} d - runtime deps from player.js
 */

function registerGkStates(PlayerStates, d) {
    const {
        Time,
        Settings,
        Utils,
        SoundDB,
        ai,
        dist2d,
        getTeamEntity,
        tryClaimLooseBall,
        computeChaseInterceptTarget,
        computeDribbleTarget,
        computeDribblePassChance,
        getShootRange,
        getNearestOpponent,
        attacksRightGoal,
        defendingGoalX,
        computeTackleType,
        attemptTackle,
        canTackleOwner,
        isTeammateOpen,
        computeShootKick,
        applyKickDirectionNoise,
        pursuitPoint,
        interposePoint,
        dispatchSoccerMsg,
        SoccerMsg,
        getGoalkeeperBaseX,
        grantGkPossession,
        computeGkClearTarget,
        gkFacesIntoField
    } = d;

    function aiNum(p, key, fallback) {
        const v = ai(p)[key];
        if (typeof v === 'number') return v;
        const s = Settings.AI && Settings.AI[key];
        return typeof s === 'number' ? s : fallback;
    }

    function ballGroundSpeed(ball) {
        if (!ball) return 0;
        return Math.sqrt((ball.vx || 0) * (ball.vx || 0) + (ball.vy || 0) * (ball.vy || 0));
    }

    /**
     * Distance from point C to segment AB (2D).
     * Used so high-speed shots that pass near the GK in one logic tick still count as contact.
     */
    function distPointToSegment2d(cx, cy, ax, ay, bx, by) {
        const abx = bx - ax;
        const aby = by - ay;
        const apx = cx - ax;
        const apy = cy - ay;
        const ab2 = abx * abx + aby * aby;
        if (ab2 < 1e-12) {
            return Math.sqrt(apx * apx + apy * apy);
        }
        let t = (apx * abx + apy * aby) / ab2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const px = ax + abx * t;
        const py = ay + aby * t;
        const dx = cx - px;
        const dy = cy - py;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Minimum distance from GK to ball this frame: current feet, or the path
     * swept by the ball from prev → current (anti-tunnel for fast shots).
     */
    function gkBallContactDist(p, ball) {
        const dNow = dist2d(p.x, p.y, ball.x, ball.y);
        const prevX = typeof ball.prevX === 'number' ? ball.prevX : ball.x;
        const prevY = typeof ball.prevY === 'number' ? ball.prevY : ball.y;
        const dSeg = distPointToSegment2d(p.x, p.y, prevX, prevY, ball.x, ball.y);
        return Math.min(dNow, dSeg);
    }

    /** Catch radius grows with ball speed so ~20 m/s shots remain savable. */
    function gkEffectiveCatchRange(p, ball, mul = 1) {
        const base = aiNum(p, 'GK_CATCH_RANGE', 1.55);
        const bonus = aiNum(p, 'GK_CATCH_SPEED_BONUS', 0.035);
        const maxR = aiNum(p, 'GK_CATCH_RANGE_MAX', 2.6);
        const speed = ballGroundSpeed(ball);
        const r = (base + speed * bonus) * mul;
        return Math.min(maxR * Math.max(1, mul), r);
    }

    /**
     * Look-ahead for dive / close targets.
     * Faster balls → shorter absolute horizon; also scale with distance so GK meets the ball.
     */
    function gkPredictHorizon(p, ball) {
        const tMin = aiNum(p, 'GK_PRED_HORIZON_MIN', 0.18);
        const tMax = aiNum(p, 'GK_PRED_HORIZON_MAX', 0.85);
        if (!ball) return tMin;
        const speed = ballGroundSpeed(ball);
        if (speed < 0.8) return 0.35;
        const dist = dist2d(p.x, p.y, ball.x, ball.y);
        // Time for ball to cover ~55% of current separation (meet in front)
        let t = (dist * 0.55) / speed;
        // Shots: also consider time to GK's x-plane (goal approach)
        if (Math.abs(ball.vx || 0) > 1.0) {
            const dx = p.x - ball.x;
            const tPlane = dx / ball.vx;
            if (tPlane > 0.08 && tPlane < 1.4) {
                t = Math.min(t, tPlane * 0.92);
            }
        }
        if (ball.isShot) {
            t = Math.min(t, 0.55);
        }
        return Math.max(tMin, Math.min(tMax, t));
    }

    function gkPredictBall(p, ball) {
        const isMoving = ball && (ball.vx || ball.vy || ball.vz);
        if (!ball || !isMoving) {
            return ball ? { x: ball.x, y: ball.y, z: ball.z || 0 } : { x: 0, y: 0, z: 0 };
        }
        return futurePosition(ball, gkPredictHorizon(p, ball));
    }

    /**
     * Attempt a catch/save. Returns true if possession granted.
     * @param {object} p
     * @param {object} ball
     * @param {{ dive?: boolean }} [opts]
     */
    function tryGkCatch(p, ball, opts = {}) {
        if (!ball || ball.owner === p) return false;
        if (ball.owner && ball.owner.team !== p.team) {
            // Contested at feet — only claim if opponent is not stacked on the ball
            if (dist2d(p.x, p.y, ball.owner.x, ball.owner.y) < 1.2) return false;
        }

        const z = ball.z || 0;
        // Reachable height: standing ~2.5 m, dive stretch a bit higher mid-lunge
        const maxZ = opts.dive ? 2.85 : 2.5;
        if (z > maxZ) return false;

        const range = gkEffectiveCatchRange(p, ball, opts.dive ? 0.95 : 1);
        const contact = gkBallContactDist(p, ball);
        if (contact > range) return false;

        const gkStat = (p.stats && p.stats.goalkeeping) || 65;
        const speed = ballGroundSpeed(ball);
        // Base skill window (arcade ISS: beatable keepers, not brick walls)
        let chance = opts.dive
            ? 0.30 + (gkStat / 100) * 0.34
            : 0.42 + (gkStat / 100) * 0.28;

        // Shots: reward committed dive; standing saves harder on rockets
        if (ball.isShot) {
            if (opts.dive) {
                chance += 0.05;
            } else if (speed > 16) {
                chance -= 0.30;
            } else if (speed > 12) {
                chance -= 0.16;
            } else {
                chance -= 0.08;
            }
        }

        // Extreme rockets still beat even good GKs sometimes
        if (speed > 22) {
            chance -= 0.18;
        } else if (speed > 18) {
            chance -= 0.12;
        }

        // Clean contact (well inside radius) is more reliable
        if (contact < range * 0.45) {
            chance += 0.05;
        }

        // Global arcade multiplier on shot saves (ISS: keepers are beatable)
        if (ball.isShot) {
            const saveMul = aiNum(p, 'GK_SHOT_SAVE_MULT', 0.72);
            chance *= saveMul;
        }

        chance = Math.max(0.06, Math.min(0.78, chance));
        if (Math.random() >= chance) return false;

        grantGkPossession(p, ball);
        SoundDB.play(ball.isShot ? 'save' : 'catch');
        if (ball.isShot) SoundDB.crowdReact('ooh', opts.dive ? 0.4 : 0.35);
        return true;
    }

    /** Whether GK should commit to GkDive this tick. */
    function shouldGkDive(p, ball, approachDist, predZ) {
        if (!ball || ball.owner !== null) return false;
        if (predZ > 2.6) return false;
        const catchR = gkEffectiveCatchRange(p, ball);
        // Already smotherable at feet — do not dive
        if (approachDist <= catchR * 1.05) return false;

        const speed = ballGroundSpeed(ball);
        const diveThresh = aiNum(p, 'GK_DIVE_SPEED_THRESHOLD', 11.0);
        if (speed < diveThresh && !ball.isShot) return false;

        const gkStat = (p.stats && p.stats.goalkeeping) || 65;
        let pDive = ball.isShot
            ? aiNum(p, 'GK_DIVE_CHANCE_SHOT', 0.90)
            : aiNum(p, 'GK_DIVE_CHANCE_FIRM', 0.62);
        // Better GKs dive slightly more on hard balls; worse less
        pDive += (gkStat - 70) / 100 * 0.08;
        if (speed > 18) pDive += 0.06;
        pDive = Math.max(0.2, Math.min(0.97, pDive));
        return Math.random() < pDive;
    }

    Object.assign(PlayerStates, {
        Goalkeeper: {
            name: 'Goalkeeper',
            enter(p) {
                p.frame = 0;
                p.isSliding = false;
            },
            execute(p) {
                if (p.actionTimer > 0) {
                    p.actionTimer -= Time.deltaTime;
                    p.frameTimer += Time.deltaTime;
                    if (p.frameTimer > 0.15) {
                        p.frameTimer = 0;
                        p.frame = (p.frame === 5) ? 6 : 5;
                    }
                    p.vx = 0;
                    p.vy = 0;
                    return;
                }

                const ball = p.level.ball;
                if (!ball) return;

                const gkBaseX = getGoalkeeperBaseX(p.level, p.team);
                const fieldBounds = Utils.getFieldBounds();
                const m = fieldBounds.multiplier;

                // Goal mouth is an absolute physical object (~7.32m wide) - DO NOT SCALE
                const goalMouthRadius = 4.0;
                const targetY = Math.max(fieldBounds.centerY - goalMouthRadius,
                                Math.min(fieldBounds.centerY + goalMouthRadius, ball.y));

                // Penalty box depth scales with the field size!
                // Slightly deeper box sense so GK reacts earlier to ~20 m/s shots
                const boxDepth = 22.0 * m;
                const nearRight = fieldBounds.width - boxDepth;
                const nearLeft = boxDepth;

                const isBallNearGoal = p.level.isSecondHalf()
                    ? (p.team === 'A' ? (ball.x > nearRight) : (ball.x < nearLeft))
                    : (p.team === 'A' ? (ball.x < nearLeft) : (ball.x > nearRight));

                // Also treat active shots aimed at our goal as "near" once inside final third
                const speed = ballGroundSpeed(ball);
                const finalThird = p.level.isSecondHalf()
                    ? (p.team === 'A' ? ball.x > fieldBounds.width * 0.62 : ball.x < fieldBounds.width * 0.38)
                    : (p.team === 'A' ? ball.x < fieldBounds.width * 0.38 : ball.x > fieldBounds.width * 0.62);
                const shotThreat = !!(ball.isShot && ball.owner === null && speed > 8 && finalThird);

                if (ball.owner === p) {
                    p.gkHoldTimer -= Time.deltaTime;
                    p.frame = 0;
                    p.orientation = gkFacesIntoField(p);
                    const holdY = typeof p.gkHoldY === 'number' ? p.gkHoldY : Utils.getFieldBounds().centerY;
                    const holdDist = dist2d(p.x, p.y, gkBaseX, holdY);
                    if (holdDist > 0.25) { // 25 centimeters tolerance
                        p.moveTo({ x: gkBaseX, y: holdY });
                    } else {
                        p.x = gkBaseX;
                        p.y = holdY;
                        p.vx = 0;
                        p.vy = 0;
                    }
                    if (p.gkHoldTimer <= 0) {
                        const clear = computeGkClearTarget(p, p.level);
                        const target = clear.target;
                        const dx = target.x - p.x;
                        const dy = target.y - p.y;
                        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

                        SoundDB.play('lob');
                        ball.kick((dx / dist) * clear.speed, (dy / dist) * clear.speed, clear.vz);

                        if (clear.teammate) {
                            const team = p.getTeam();
                            if (team) team.receivingPlayer = clear.teammate;
                            dispatchSoccerMsg(p.level, 0, p, clear.teammate, SoccerMsg.ReceiveBall, {
                                target: { x: target.x, y: target.y }
                            });
                        }

                        p.gkClaimTimer = 0;
                        p.gkHoldY = null;
                        p.gkReleaseCooldown = ai(p).GK_RELEASE_COOLDOWN;
                    }
                    return;
                }

                const interposeDist = (ai(p).STEER_GK_INTERPOSE_DIST != null)
                    ? ai(p).STEER_GK_INTERPOSE_DIST
                    : (Settings.AI.STEER_GK_INTERPOSE_DIST || 2.0);

                if (p.gkReleaseCooldown > 0) {
                    p.gkReleaseCooldown -= Time.deltaTime;
                    // Interpose between goal line and ball while recovering
                    const tend = interposePoint(ball, { x: gkBaseX, y: targetY }, interposeDist);
                    p.moveTo(tend, 1, { arrive: true, separate: false });
                    return;
                }

                if (isBallNearGoal || shotThreat) {
                    const pred = gkPredictBall(p, ball);
                    const approachDist = dist2d(p.x, p.y, pred.x, pred.y);
                    const interceptR = aiNum(p, 'GK_INTERCEPT_RANGE', 6.5);
                    // Hot shots: expand intercept envelope so dive decision fires earlier
                    const inRange = approachDist < interceptR
                        || (ball.isShot && approachDist < interceptR * 1.35);

                    if (inRange) {
                        const predZ = (pred && typeof pred.z === 'number') ? pred.z : (ball.z || 0);

                        if (shouldGkDive(p, ball, approachDist, predZ)) {
                            p.fsm.changeState(PlayerStates.GkDive);
                            return;
                        }

                        // Close in: pursuit of ball when loose, else direct
                        let closeTarget = { x: ball.x, y: ball.y };
                        if (ball.owner === null && speed > 0.5) {
                            closeTarget = { x: pred.x, y: pred.y };
                            // Blend pursuit for slow balls
                            if (speed < 12) {
                                const purs = pursuitPoint(p, ball, (p._currentSpeed || 2.5) * 1.2);
                                closeTarget = {
                                    x: pred.x * 0.55 + purs.x * 0.45,
                                    y: pred.y * 0.55 + purs.y * 0.45
                                };
                            }
                        }
                        p.moveTo(closeTarget, ball.isShot ? 1.35 : 1.15, { arrive: false, separate: false });
                        tryGkCatch(p, ball, { dive: false });
                        return;
                    }
                }

                // Tend goal: interpose between goal mouth anchor and ball
                const tendPt = interposePoint(ball, { x: gkBaseX, y: targetY }, interposeDist);
                p.moveTo(tendPt, 1, { arrive: true, separate: false, deceleration: 2 });
                // Last-ditch standing grab if ball skims the line while still "tending"
                if (ball.owner === null && speed > 1) {
                    tryGkCatch(p, ball, { dive: false });
                }
            },
            exit(p) {}
        },

        GkDive: {
            name: 'GkDive',
            enter(p) {
                const dur = aiNum(p, 'GK_DIVE_DURATION', 0.55);
                p.gkDiveTimer = dur;
                p.frame = 7;
                p.vx = 0;
                p.vy = 0;
                p.z = 0;
                const ball = p.level.ball;
                if (ball) {
                    const pred = gkPredictBall(p, ball);
                    // Clamp dive target to stay near goal mouth (do not chase midfield)
                    const field = Utils.getFieldBounds();
                    const gkBaseX = getGoalkeeperBaseX(p.level, p.team);
                    const mouth = 5.0;
                    let ty = pred.y;
                    ty = Math.max(field.centerY - mouth, Math.min(field.centerY + mouth, ty));
                    // Prefer meeting the ball slightly in front of the line
                    const intoField = p.level && typeof p.level.isSecondHalf === 'function'
                        ? (p.level.isSecondHalf()
                            ? (p.team === 'A' ? -1 : 1)
                            : (p.team === 'A' ? 1 : -1))
                        : (p.team === 'A' ? 1 : -1);
                    let tx = pred.x;
                    // Soft clamp: do not dive more than ~6 m off the line into the box
                    const maxOut = 6.0;
                    if (intoField > 0) {
                        tx = Math.min(gkBaseX + maxOut, Math.max(gkBaseX - 0.5, tx));
                    } else {
                        tx = Math.max(gkBaseX - maxOut, Math.min(gkBaseX + 0.5, tx));
                    }
                    p.gkDiveTarget = { x: tx, y: ty };
                } else {
                    p.gkDiveTarget = { x: p.x, y: p.y };
                }
            },
            execute(p) {
                p.gkDiveTimer -= Time.deltaTime;
                const ball = p.level.ball;
                if (!ball) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }

                const dur = aiNum(p, 'GK_DIVE_DURATION', 0.55);
                const prepEnd = dur * 0.70; // first ~30% of dive is prep pose
                if (p.gkDiveTimer > prepEnd) {
                    p.frame = 7;
                    p.z = 0;
                } else {
                    p.frame = 8;
                    const progress = Math.max(0, Math.min(1, (prepEnd - p.gkDiveTimer) / Math.max(0.05, prepEnd)));
                    p.z = Math.sin(progress * Math.PI) * 0.9;
                    // Refresh dive target mid-lunge for moving shots (once)
                    if (progress > 0.15 && progress < 0.45 && ball.owner === null) {
                        const pred = gkPredictBall(p, ball);
                        if (p.gkDiveTarget) {
                            p.gkDiveTarget.x = p.gkDiveTarget.x * 0.65 + pred.x * 0.35;
                            p.gkDiveTarget.y = p.gkDiveTarget.y * 0.55 + pred.y * 0.45;
                        }
                    }
                }

                const diveMul = aiNum(p, 'GK_DIVE_SPEED_MUL', 1.85);
                p.moveTo(p.gkDiveTarget, diveMul);

                if (tryGkCatch(p, ball, { dive: true })) {
                    p.z = 0;
                    p.gkDiveTimer = 0;
                    return;
                }

                if (p.gkDiveTimer <= 0) {
                    p.z = 0;
                    p.actionTimer = 0.55;
                    p.fsm.changeState(PlayerStates.Goalkeeper);
                }
            },
            exit(p) {
                p.z = 0;
                p.isSliding = false;
            }
        },

    });
}

module.exports = { registerGkStates };
