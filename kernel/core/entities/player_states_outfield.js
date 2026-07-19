/**
 * Outfield field-player FSM states (Idle, Receive, Support, Wait, GoHome, Chase, Dribble, Pass, Shoot, Header).
 *
 * Composition over inheritance: one Player entity; states registered on shared bag.
 *
 * @param {object} PlayerStates
 * @param {object} d - runtime deps from player.js
 */
const {
    releaseWallOnPass,
    releaseWallOnShotKick
} = require('../lib/freekick_wall.js');
const { applyHumanMovement } = require('../lib/manual_control.js');
const { armIndirectFreeKick } = require('../lib/match_rules.js');

/**
 * Minimum inward depth (world units) a throw-in aim must clear from the taker.
 * Prevents near-parallel lead aims that hug the touchline and re-exit on noise.
 */
function throwInMinInfieldDepth(field) {
    return Math.max(6.0, (field && field.multiplier ? field.multiplier : 1) * 6.0);
}

/**
 * Bias a throw-in aim point into the pitch so the release cannot skim the line.
 * @param {{ x: number, y: number }} aim
 * @param {{ x: number, y: number }} taker
 * @param {{ width: number, height: number, centerY: number, multiplier?: number }} field
 * @returns {{ x: number, y: number }}
 */
function biasThrowInAimInfield(aim, taker, field) {
    if (!aim || !taker || !field) return aim || { x: 0, y: 0 };
    const minIn = throwInMinInfieldDepth(field);
    const margin = Math.max(2.0, (field.multiplier || 1) * 2.0);
    let x = aim.x;
    let y = aim.y;

    // Primary: force enough depth from the nearer touchline
    if (taker.y <= field.centerY) {
        y = Math.max(y, taker.y + minIn, margin);
    } else {
        y = Math.min(y, taker.y - minIn, field.height - margin);
    }

    // Also keep aim off the goal lines (corner throw-ins)
    x = Math.max(margin, Math.min(field.width - margin, x));
    y = Math.max(margin, Math.min(field.height - margin, y));
    return { x, y };
}

/**
 * Bias a corner aim into the pitch so delivery cannot skim the goal line / touchline.
 * @param {{ x: number, y: number }} aim
 * @param {'left'|'right'} side
 * @param {number} cornerY
 * @param {{ width: number, height: number, centerY: number, multiplier?: number }} field
 */
function biasCornerAimInfield(aim, side, cornerY, field) {
    if (!aim || !field) return aim || { x: 0, y: 0 };
    const m = field.multiplier || 1;
    const minIn = Math.max(6.0, m * 6.0);
    const margin = Math.max(2.0, m * 2.0);
    let x = aim.x;
    let y = aim.y;

    if (side === 'left') {
        x = Math.max(x, minIn, margin);
    } else {
        x = Math.min(x, field.width - minIn, field.width - margin);
    }
    if (cornerY < field.centerY) {
        y = Math.max(y, minIn, margin);
    } else {
        y = Math.min(y, field.height - minIn, field.height - margin);
    }

    x = Math.max(margin, Math.min(field.width - margin, x));
    y = Math.max(margin, Math.min(field.height - margin, y));
    return { x, y };
}

/**
 * Unit direction from a corner flag into the pitch (both axes inward).
 * @returns {{ nx: number, ny: number }}
 */
function clampCornerKickDirection(nx, ny, side, cornerY, field) {
    let x = nx;
    let y = ny;
    const len0 = Math.sqrt(x * x + y * y) || 1;
    x /= len0;
    y /= len0;
    if (!field) return { nx: x, ny: y };

    const minInward = 0.45;
    const enforce = (axis /* 'x'|'y' */, positive) => {
        if (axis === 'x') {
            if (positive && x < minInward) {
                x = minInward;
                const ySign = y >= 0 ? 1 : -1;
                y = ySign * Math.sqrt(Math.max(0, 1 - x * x));
            } else if (!positive && x > -minInward) {
                x = -minInward;
                const ySign = y >= 0 ? 1 : -1;
                y = ySign * Math.sqrt(Math.max(0, 1 - x * x));
            }
        } else if (positive && y < minInward) {
            y = minInward;
            const xSign = x >= 0 ? 1 : -1;
            x = xSign * Math.sqrt(Math.max(0, 1 - y * y));
        } else if (!positive && y > -minInward) {
            y = -minInward;
            const xSign = x >= 0 ? 1 : -1;
            x = xSign * Math.sqrt(Math.max(0, 1 - y * y));
        }
    };

    enforce('x', side !== 'right'); // left corner → +X, right → −X
    enforce('y', !(cornerY > (field.centerY || field.height * 0.5))); // top → +Y
    // Re-apply X after Y adjust so both components stay strong enough
    enforce('x', side !== 'right');

    return { nx: x, ny: y };
}

/**
 * Ensure unit direction points sufficiently into the pitch from a touchline throw.
 * Enforces the min inward component on the *unit* vector (not pre-normalize), so
 * lateral-heavy aims cannot renorm back down to a skim along the line.
 * @returns {{ nx: number, ny: number }}
 */
function clampThrowInDirection(nx, ny, taker, field) {
    let x = nx;
    let y = ny;
    const len0 = Math.sqrt(x * x + y * y) || 1;
    x /= len0;
    y /= len0;
    if (!taker || !field) {
        return { nx: x, ny: y };
    }

    // Min inward component on unit direction. 0.35 allowed |vy|≈4 at speed 11
    // (skims the strip → intercept → ball back out). 0.55 keeps |vy|≳6.
    const minInward = 0.55;
    const enforceInward = (inwardPositive) => {
        if (inwardPositive) {
            if (y < minInward) {
                y = minInward;
                const xSign = x >= 0 ? 1 : -1;
                x = xSign * Math.sqrt(Math.max(0, 1 - y * y));
            }
        } else if (y > -minInward) {
            y = -minInward;
            const xSign = x >= 0 ? 1 : -1;
            x = xSign * Math.sqrt(Math.max(0, 1 - y * y));
        }
    };

    if (taker.y <= field.centerY) {
        enforceInward(true); // top: +Y into pitch
    } else {
        enforceInward(false); // bottom: -Y into pitch
    }

    // If nearly on a goal line, also bias slightly toward center X
    const edgeX = Math.max(field.multiplier || 1, 2.0) * 2;
    if (taker.x < edgeX && x < 0.1) {
        x = 0.15;
        const ySign = y >= 0 ? 1 : -1;
        y = ySign * Math.sqrt(Math.max(0, 1 - x * x));
        // Re-apply inward after X nudge
        if (taker.y <= field.centerY) enforceInward(true);
        else enforceInward(false);
    }
    if (taker.x > field.width - edgeX && x > -0.1) {
        x = -0.15;
        const ySign = y >= 0 ? 1 : -1;
        y = ySign * Math.sqrt(Math.max(0, 1 - x * x));
        if (taker.y <= field.centerY) enforceInward(true);
        else enforceInward(false);
    }

    return { nx: x, ny: y };
}

function registerOutfieldStates(PlayerStates, d) {
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
        getThreatInfo,
        isThreatened,
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
        estimatePassGroundSpeed,
        longPassVzForDistance,
        pursuitPoint,
        interposePoint,
        dispatchSoccerMsg,
        SoccerMsg,
        getGoalkeeperBaseX,
        grantGkPossession,
        computeGkClearTarget,
        gkFacesIntoField,
        startKickWindup,
        tickKickWindup,
        canEvaluateKickDecision,
        markKickDecision
    } = d;

    /**
     * Apply header contact impulse (AI pass pick or Stage 4 humanHeader).
     * @param {object} p
     * @param {object} ball
     */
    function applyHeaderContact(p, ball) {
        const hh = p.humanHeader;
        const field = Utils.getFieldBounds();
        const attacksRight = attacksRightGoal(p.level, p.team);
        const goalX = attacksRight ? field.width : 0;

        let nx;
        let ny;
        let speed;
        let vz;
        let curve = 0;
        let asShot = false;

        if (hh && hh.aimDir && (Math.abs(hh.aimDir.x) > 1e-4 || Math.abs(hh.aimDir.y) > 1e-4)) {
            // Stage 4 human: directional header with power-shaped speed / loft
            const alen = Math.sqrt(hh.aimDir.x * hh.aimDir.x + hh.aimDir.y * hh.aimDir.y) || 1;
            nx = hh.aimDir.x / alen;
            ny = hh.aimDir.y / alen;
            // Face the header
            if (typeof p.orientation === 'number') {
                const deg = (Math.atan2(nx, -ny) * 180) / Math.PI;
                p.orientation = ((Math.round(deg / 45) % 8) + 8) % 8;
            }
            speed = typeof hh.speed === 'number' ? hh.speed : 7.0;
            vz = typeof hh.vz === 'number' ? hh.vz : 2.0;
            curve = typeof hh.curveForce === 'number' ? hh.curveForce : 0;
            asShot = hh.kind === 'shot';

            // Soft goal soft-lock for head shots when aimAssist requested
            if (asShot && hh.aimAssist !== false) {
                const dxG = goalX - p.x;
                const dyG = field.centerY - p.y;
                const gLen = Math.sqrt(dxG * dxG + dyG * dyG) || 1;
                const gDot = (dxG / gLen) * nx + (dyG / gLen) * ny;
                if (gDot > 0.35) {
                    // Blend toward goal mouth while keeping stick near/far post
                    const blend = 0.4;
                    let bx = nx * (1 - blend) + (dxG / gLen) * blend;
                    let by = ny * (1 - blend) + (dyG / gLen) * blend;
                    const bl = Math.sqrt(bx * bx + by * by) || 1;
                    nx = bx / bl;
                    ny = by / bl;
                }
            }
        } else {
            // AI default: best pass or clear toward goal
            const decision = typeof p.findBestPassTarget === 'function' ? p.findBestPassTarget() : null;
            const teammate = decision ? decision.teammate : null;
            let targetX = decision && decision.aim ? decision.aim.x : (teammate ? teammate.x : p.x);
            let targetY = decision && decision.aim ? decision.aim.y : (teammate ? teammate.y : p.y);

            if (!teammate) {
                targetX = goalX;
                targetY = field.centerY + (Math.random() - 0.5) * 10;
            }

            const dx = targetX - p.x;
            const dy = targetY - p.y;
            const dist = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
            nx = dx / dist;
            ny = dy / dist;
            speed = 6.0 + dist * 0.2;
            vz = 2.0 + Math.random() * 1.5;
        }

        ball.kick(nx * speed, ny * speed, vz, curve);
        if (asShot) ball.isShot = true;
        SoundDB.play('header');
        p.humanHeader = null;
    }

    function computeXG(shooter, ball) {
        const level = shooter.level;
        if (!level) return 0.1;
        const field = Utils.getFieldBounds();
        const attacksRight = attacksRightGoal(level, shooter.team);
        const goalX = attacksRight ? field.width : 0;
        const goalY = field.height / 2;

        const dist = dist2d(ball.x, ball.y, goalX, goalY);
        const dx = goalX - ball.x;
        const dy = goalY - ball.y;
        const angle = Math.abs(Math.atan2(dy, dx));

        const distFactor = Math.exp(-dist * 0.05);
        const angleFactor = Math.max(0.15, Math.cos(angle));

        let xG = distFactor * angleFactor;

        const oppTeam = shooter.team === 'A' ? level.teamB : level.teamA;
        if (oppTeam) {
            const opponents = oppTeam.members();
            // Match computeShootKick / Settings.physics shot speeds
            const { estimateShotGroundSpeed } = require('../lib/pass_safety.js');
            const speed = estimateShotGroundSpeed(shooter);

            const goalTarget = shooter.shotAim || { x: goalX, y: goalY };
            const { isPassSafeFromAllOpponents } = require('../lib/pass_safety.js');
            const pathClear = isPassSafeFromAllOpponents(
                { x: ball.x, y: ball.y },
                goalTarget,
                null,
                opponents,
                speed
            );
            if (!pathClear) {
                xG *= 0.5;
            }
        }

        const shooting = shooter.stats ? (shooter.stats.shooting || 60) : 60;
        xG *= (0.8 + (shooting / 100) * 0.4);

        return Math.max(0.01, Math.min(0.99, xG));
    }

    Object.assign(PlayerStates, {
        Idle: {
            name: 'Idle',
            enter(p) {
                // GKs must not linger in Idle (set-piece resets / AI assign edge cases)
                if (p.role === 'GK') {
                    p.fsm.setCurrentState(PlayerStates.Goalkeeper);
                    PlayerStates.Goalkeeper.enter(p);
                    return;
                }
                if (p.actionTimer <= 0) {
                    p.frame = 0;
                } else {
                    p.frame = 5;
                    p.frameTimer = 0;
                }
                p.vx = 0;
                p.vy = 0;
                p.isSliding = false;
                p.receiveTarget = null;
                p.receiveTimer = 0;
            },
            execute(p) {
                if (p.role === 'GK') {
                    p.fsm.changeState(PlayerStates.Goalkeeper);
                    return;
                }
                if (p.actionTimer > 0) {
                    p.actionTimer -= Time.deltaTime;
                    p.frameTimer += Time.deltaTime;
                    if (p.frameTimer > 0.15) {
                        p.frameTimer = 0;
                        p.frame = (p.frame === 5) ? 6 : 5;
                    }
                    return;
                }
                // Stage 1: human avatar — free movement / claim, no formation idle
                if (p.humanControlled && applyHumanMovement(p)) {
                    return;
                }
                const ball = p.level && p.level.ball;
                if (ball && ball.owner === null && tryClaimLooseBall(p, ball)) {
                    return;
                }

                // Promote designated supporter into SupportAttacker (Idle is formation-only)
                const team = getTeamEntity(p);
                if (
                    team
                    && team.supportingPlayer === p
                    && ball
                    && ball.owner
                    && ball.owner.team === p.team
                    && ball.owner !== p
                ) {
                    p.fsm.changeState(PlayerStates.SupportAttacker);
                    return;
                }

                // Idle = formation / light secondary support / defensive shape only
                p.moveTo(p.getIdleMoveTarget(), 1, { arrive: true, separate: true });
            },
            exit(p) {}
        },

        /**
         * ReceiveBall — run onto pass aim / feet and claim.
         * Enter data: { target: {x,y} } from Msg_ReceiveBall.
         */
        Receive: {
            name: 'Receive',
            enter(p, data) {
                p.frame = 1;
                p.isSliding = false;
                const t = (data && data.target) || (data && data.extra && data.extra.target) || null;
                p.receiveTarget = t ? { x: t.x, y: t.y } : null;
                p.receiveTimer = 2.2;
                const team = getTeamEntity(p);
                if (team) team.receivingPlayer = p;
            },
            execute(p) {
                p.receiveTimer -= Time.deltaTime;
                const ball = p.level && p.level.ball;
                if (!ball || p.receiveTimer <= 0) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }
                // Ball claimed by someone else (not a loose ball we can still hunt)
                if (ball.owner && ball.owner !== p && ball.owner.team !== p.team) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }
                if (ball.owner === p) {
                    p.fsm.changeState(PlayerStates.Dribble);
                    return;
                }
                if (ball.owner === null && tryClaimLooseBall(p, ball)) {
                    return;
                }
                const aim = p.receiveTarget || { x: ball.x, y: ball.y };
                // Blend toward live ball when close so we track bounces
                const toBall = dist2d(p.x, p.y, ball.x, ball.y);
                let target = toBall < 4
                    ? { x: ball.x, y: ball.y }
                    : { x: aim.x * 0.65 + ball.x * 0.35, y: aim.y * 0.65 + ball.y * 0.35 };
                // Phase 2: pursuit when ball is loose and moving
                if (ball.owner === null && (Math.abs(ball.vx) + Math.abs(ball.vy) > 0.4)) {
                    target = pursuitPoint(p, ball, p._currentSpeed || 2.5);
                }
                p.moveTo(target, 1.05, { arrive: true, separate: true });
            },
            exit(p) {
                const team = getTeamEntity(p);
                if (team && team.receivingPlayer === p) {
                    team.receivingPlayer = null;
                }
                p.receiveTarget = null;
                p.receiveTimer = 0;
            }
        },

        /**
         * SupportAttacker — hold/run to team sweet spot; may request a pass.
         */
        SupportAttacker: {
            name: 'SupportAttacker',
            enter(p, data) {
                p.frame = 1;
                p.isSliding = false;
                const t = (data && data.target) || (data && data.extra && data.extra.target) || null;
                if (t) {
                    p.supportTarget = { x: t.x, y: t.y };
                } else {
                    const team = getTeamEntity(p);
                    const spot = team && team.getBestSupportSpot ? team.getBestSupportSpot() : null;
                    p.supportTarget = spot ? { x: spot.x, y: spot.y } : null;
                }
                p.passRequestCooldown = 0;
            },
            execute(p) {
                const ball = p.level && p.level.ball;
                const team = getTeamEntity(p);
                // Drop support if team lost ball or we are no longer designated supporter
                if (!ball || !ball.owner || ball.owner.team !== p.team) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }
                if (team && team.supportingPlayer && team.supportingPlayer !== p) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }
                if (ball.owner === p) {
                    p.fsm.changeState(PlayerStates.Dribble);
                    return;
                }

                // Refresh target from team spot
                if (team && typeof team.getBestSupportSpot === 'function') {
                    const spot = team.getBestSupportSpot();
                    if (spot) p.supportTarget = { x: spot.x, y: spot.y };
                }
                const target = p.supportTarget || p.getIdleMoveTarget();
                p.moveTo(target, 1, { arrive: true, separate: true, deceleration: 2 });

                // RequestPass: ask controller for ball when open + lane safe (team rate-limit)
                if (p.passRequestCooldown > 0) {
                    p.passRequestCooldown -= Time.deltaTime;
                } else if (team && typeof team.requestPass === 'function' && ball.owner && ball.owner !== p) {
                    const aggression = ai(p).PASS_AGGRESSION || 0.5;
                    const chance = (typeof ai(p).REQUEST_PASS_CHANCE === 'number'
                        ? ai(p).REQUEST_PASS_CHANCE
                        : 0.04) * aggression;
                    if (chance > 0 && Math.random() < chance) {
                        const sent = team.requestPass(p);
                        const playerCd = typeof ai(p).REQUEST_PASS_PLAYER_COOLDOWN === 'number'
                            ? ai(p).REQUEST_PASS_PLAYER_COOLDOWN
                            : 1.2;
                        const busyCd = typeof ai(p).REQUEST_PASS_BUSY_BACKOFF === 'number'
                            ? ai(p).REQUEST_PASS_BUSY_BACKOFF
                            : 0.3;
                        // Full cooldown after send; short backoff if team gate/safety rejected
                        p.passRequestCooldown = sent ? playerCd : busyCd;
                    }
                }
            },
            exit(p) {
                p.supportTarget = null;
            }
        },

        /** Wait — hold position (set pieces / kickoff). */
        Wait: {
            name: 'Wait',
            enter(p) {
                p.frame = 0;
                p.vx = 0;
                p.vy = 0;
                p.isSliding = false;
                p._currentSpeed = 0;
            },
            execute(p) {
                p.vx = 0;
                p.vy = 0;
                p._currentSpeed = 0;
                // Face the ball
                const ball = p.level && p.level.ball;
                if (ball) {
                    const dx = ball.x - p.x;
                    const dy = ball.y - p.y;
                    if (Math.abs(dx) + Math.abs(dy) > 0.15) {
                        const angle = Math.atan2(dy, dx);
                        const sector = Math.round(angle / (Math.PI / 4));
                        const DIR_FROM_SECTOR = { 0: 2, 1: 3, 2: 4, 3: 5, 4: 6, '-1': 1, '-2': 0, '-3': 7, '-4': 6 };
                        if (DIR_FROM_SECTOR[sector] !== undefined) {
                            p.orientation = DIR_FROM_SECTOR[sector];
                        }
                    }
                }
                // Leave Wait when open play resumes and no dead-ball set piece remains
                // (kickoff keeps setPieceType until the AI opening pass is kicked).
                if (
                    p.level
                    && p.level.matchState === 'play'
                    && !p.level.setPieceType
                ) {
                    p.fsm.changeState(PlayerStates.Idle);
                }
            },
            exit(p) {}
        },

        /**
         * ReturnToHomeRegion / GoHome — run to formation base, then Wait/Idle.
         * (GoHome message uses this state; ReturnHome is an alias.)
         */
        GoHome: {
            name: 'GoHome',
            enter(p, data) {
                p.frame = 1;
                p.isSliding = false;
                const t = (data && data.target) || (data && data.extra && data.extra.target);
                if (t) {
                    p.homeTarget = { x: t.x, y: t.y };
                } else {
                    p.homeTarget = { x: p.baseX, y: p.baseY };
                }
            },
            execute(p) {
                const target = p.homeTarget || { x: p.baseX, y: p.baseY };
                const d = dist2d(p.x, p.y, target.x, target.y);
                if (d < 0.6) {
                    p.x = target.x;
                    p.y = target.y;
                    p.vx = 0;
                    p.vy = 0;
                    p._currentSpeed = 0;
                    // Prefer Wait during dead-ball, Idle in open play
                    if (p.level && p.level.matchState === 'play') {
                        p.fsm.changeState(PlayerStates.Idle);
                    } else {
                        p.fsm.changeState(PlayerStates.Wait);
                    }
                    return;
                }
                p.moveTo(target, 0.9, { arrive: true, separate: true, deceleration: 2 });
            },
            exit(p) {
                p.homeTarget = null;
            }
        },

        ChaseBall: {
            name: 'ChaseBall',
            enter(p) {
                p.frame = 1;
                p.isSliding = false;
            },
            execute(p) {
                const ball = p.level.ball;
                if (!ball) return;

                if (p.actionTimer > 0) {
                    p.actionTimer -= Time.deltaTime;
                    p.frameTimer += Time.deltaTime;
                    if (p.frameTimer > 0.15) {
                        p.frameTimer = 0;
                        p.frame = (p.frame === 5) ? 6 : 5;
                    }
                    return;
                }

                // Human should not run AI chase/auto-tackle; Idle path owns movement
                if (p.humanControlled && applyHumanMovement(p)) {
                    return;
                }

                if (ball.owner === null) {
                    if (tryClaimLooseBall(p, ball)) return;
                    // Phase 2 pursuit: predict ball flight (compose with intercept helper)
                    const intercept = computeChaseInterceptTarget(p, ball);
                    const pursue = pursuitPoint(p, ball, p._currentSpeed || 2.5);
                    const target = {
                        x: intercept.x * 0.55 + pursue.x * 0.45,
                        y: intercept.y * 0.55 + pursue.y * 0.45
                    };
                    const distToTarget = dist2d(p.x, p.y, target.x, target.y);
                    const separate = distToTarget > 2.0;
                    p.moveTo(target, 1.05, { arrive: false, separate });
                    return;
                }

                const dist = dist2d(p.x, p.y, ball.x, ball.y);

                if (ball.owner.team !== p.team) {
                    if (!canTackleOwner(ball.owner)) {
                        // Interpose cut-off between carrier and our goal + pursuit of carrier
                        const goalX = defendingGoalX(p.level, p.team);
                        const cut = interposePoint(
                            { x: ball.owner.x, y: ball.owner.y },
                            { x: goalX, y: Utils.getFieldBounds().centerY },
                            Utils.scaleFieldX(12)
                        );
                        const pursue = pursuitPoint(p, {
                            x: ball.owner.x,
                            y: ball.owner.y,
                            vx: ball.owner.vx || 0,
                            vy: ball.owner.vy || 0
                        }, p._currentSpeed || 2.5);
                        p.moveTo({
                            x: cut.x * 0.4 + pursue.x * 0.6,
                            y: cut.y * 0.4 + pursue.y * 0.6
                        }, 1, { separate: true });
                        return;
                    }

                    const tackleType = computeTackleType(dist, p);
                    const footRange = ai(p).FOOT_TACKLE_RANGE;

                    // Prefer standing foot tackle when close enough; only slide from outside foot range
                    if (
                        tackleType === 'slide'
                        && !p.isSliding
                        && ball.z < 0.6
                        && dist > footRange + 0.35
                        && (!p.tackleAttemptCooldown || p.tackleAttemptCooldown <= 0)
                    ) {
                        p.isSliding = true;
                        p.slideTimer = 0.65;
                        p.slideTarget = { x: ball.x, y: ball.y };
                        p.frame = 4;
                        SoundDB.play('slide');
                    }

                    if (p.isSliding) {
                        p.slideTimer -= Time.deltaTime;
                        p.slideTarget = { x: ball.x, y: ball.y };
                        p.moveTo(p.slideTarget, 1.6);
                        const slideDist = dist2d(p.x, p.y, ball.x, ball.y);
                        if (slideDist < footRange + 0.25 || p.slideTimer <= 0) {
                            if (slideDist < ai(p).SLIDE_TACKLE_RANGE + 0.3) {
                                attemptTackle(p, ball, 'slide');
                            } else {
                                p.actionTimer = ai(p).TACKLE_RECOVERY_SLIDE * 0.5;
                            }
                            p.isSliding = false;
                            p.slideTimer = 0;
                        }
                        return;
                    }

                    if (tackleType === 'foot' && ball.z < 0.9) {
                        p.moveTo({ x: ball.x, y: ball.y });
                        attemptTackle(p, ball, 'foot');
                        return;
                    }

                    if (tackleType === 'slide' && ball.z < 0.6) {
                        // Close the gap standing; do not auto-slide every frame
                        p.moveTo({ x: ball.x, y: ball.y }, 1.15);
                        return;
                    }
                }

                const separate = dist > 2.0;
                p.moveTo(computeChaseInterceptTarget(p, ball), 1.05, { separate });
            },
            exit(p) {
                p.isSliding = false;
            }
        },

        Dribble: {
            name: 'Dribble',
            enter(p) {
                p.frame = 1;
                p.dribbleTarget = computeDribbleTarget(p);
                p.dribbleTargetTimer = 0.5 + Math.random() * 0.6;
                // Allow an immediate kick decision on first dribble tick
                p.kickDecisionCooldown = 0;
            },
            execute(p) {
                const ball = p.level.ball;
                if (!ball || ball.owner !== p) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }

                // Stage 1: human carrier — WASD only; no AI pass/shoot rolls
                if (p.humanControlled) {
                    if (p.passLinkCooldown > 0) {
                        p.passLinkCooldown -= Time.deltaTime;
                    }
                    applyHumanMovement(p);
                    return;
                }

                p.dribbleTargetTimer -= Time.deltaTime;
                if (p.dribbleTargetTimer <= 0) {
                    p.dribbleTarget = computeDribbleTarget(p);
                    p.dribbleTargetTimer = 0.4 + Math.random() * 0.9;
                }

                // Light separation while dribbling so carriers don't glue to teammates
                p.moveTo(p.dribbleTarget, 1, { arrive: false, separate: true, sepMult: 1.2 });

                if (p.passLinkCooldown > 0) {
                    p.passLinkCooldown -= Time.deltaTime;
                }

                // comfort zone — always refresh for debug; used when deciding pass
                const threat = getThreatInfo(p);
                p.debugThreatened = threat.threatened;
                p.debugThreatDist = threat.dist;

                // pass/shoot *decisions* throttled in logic time (not wall clock / TIME_SPEED).
                // Motion still runs every tick; only re-rolls of kick intent are gated.
                if (!canEvaluateKickDecision(p)) {
                    return;
                }
                markKickDecision(p);

                const field = Utils.getFieldBounds();
                const attacksRight = attacksRightGoal(p.level, p.team);
                const targetGoalX = attacksRight ? field.width : 0;
                const distToGoal = Math.abs(p.x - targetGoalX);
                if (distToGoal < getShootRange(p)) {
                    // A.3: phase shoot willingness (build rarely pulls the trigger)
                    const team = getTeamEntity(p);
                    const phaseMods = team && typeof team.getPlayPhaseMods === 'function'
                        ? team.getPlayPhaseMods()
                        : null;
                    const willingness = phaseMods && typeof phaseMods.shootWillingness === 'number'
                        ? phaseMods.shootWillingness
                        : 1;
                    const tryShoot = willingness >= 1 || Math.random() < willingness;

                    if (tryShoot) {
                        // CanShoot: clear / soft / contested mouth samples (ISS-leaning)
                        if (team && typeof team.canShoot === 'function') {
                            const shot = team.canShoot({ x: p.x, y: p.y }, p);
                            if (shot.ok) {
                                p.shotAim = shot.target;
                                p.fsm.changeState(PlayerStates.Shoot);
                                return;
                            }
                            // Still blocked: sometimes force a speculative aim (arcade)
                            const forceP = typeof ai(p).SHOOT_FORCE_BLOCKED_CHANCE === 'number'
                                ? ai(p).SHOOT_FORCE_BLOCKED_CHANCE
                                : 0.28;
                            if (forceP > 0 && Math.random() < forceP) {
                                const mouthY = field.centerY != null
                                    ? field.centerY
                                    : (field.height || 68) * 0.5;
                                p.shotAim = { x: targetGoalX, y: mouthY };
                                p.fsm.changeState(PlayerStates.Shoot);
                                return;
                            }
                            // Otherwise recycle: safe pass or keep dribbling
                            const passDecision = p.findBestPassTarget();
                            if (passDecision) {
                                p.passTarget = passDecision.teammate;
                                p.passType = passDecision.type;
                                p.passAim = passDecision.aim || null;
                                p.fsm.changeState(PlayerStates.Pass);
                                return;
                            }
                        } else {
                            p.fsm.changeState(PlayerStates.Shoot);
                            return;
                        }
                    }
                }

                // Threatened carriers: higher pass chance (comfort zone + THREATENED_PASS_MULT)
                const passChance = computeDribblePassChance(p, threat);
                if (passChance > 0 && Math.random() < passChance) {
                    const passDecision = p.findBestPassTarget();
                    if (passDecision) {
                        p.passTarget = passDecision.teammate;
                        p.passType = passDecision.type;
                        p.passAim = passDecision.aim || null;
                        p.fsm.changeState(PlayerStates.Pass);
                    }
                }
            },
            exit(p) {}
        },

        Pass: {
            name: 'Pass',
            enter(p) {
                const isThrowIn = p.level && p.level.setPieceType === 'throwin';
                p.frame = isThrowIn ? 12 : 3;
                startKickWindup(p);
                if (p.level && p.level.setPieceType !== '') {
                    p.vx = 0;
                    p.vy = 0;
                }
                SoundDB.play(isThrowIn ? 'throwin' : (p.passType === 'long' ? 'lob' : 'pass'));
            },
            execute(p) {
                if (p.level && p.level.setPieceType !== '') {
                    p.vx = 0;
                    p.vy = 0;
                }
                if (tickKickWindup(p, Time.deltaTime)) {
                    const ball = p.level.ball;
                    if (ball && ball.owner === p) {
                        const isThrowIn = p.level && p.level.setPieceType === 'throwin';
                        const isFreekick = p.level && p.level.setPieceType === 'freekick';
                        let target = p.passTarget;

                        if (isThrowIn) {
                            // Ensure we have a target or fallback
                            if (!target && p.level.throwInReceivers && p.level.throwInReceivers.length > 0) {
                                target = p.level.throwInReceivers.find(r => !r.isSentOff);
                            }
                            if (!target) {
                                const team = getTeamEntity(p);
                                const teammates = team
                                    ? team.members().filter(tp => tp !== p)
                                    : p.level.players.filter(tp => tp.team === p.team && tp !== p && !tp.isSentOff);
                                target = teammates[0];
                            }
                        }

                        if (target) {
                            // Lead-pass aim (space) if set; otherwise receiver feet
                            let aim = (p.passAim && typeof p.passAim.x === 'number')
                                ? { x: p.passAim.x, y: p.passAim.y }
                                : { x: target.x, y: target.y };

                            // Check Offside (receiver position — FIFA-style, not ball landing)
                            const level = p.level;
                            const field = Utils.getFieldBounds();
                            const attacksRight = attacksRightGoal(level, p.team);
                            const isSetPiece = level.setPieceType !== '';

                            // Boundary set-pieces: shallow aims + kick noise can send the ball
                            // back out and re-trigger the set piece in a loop.
                            const isCorner = level.setPieceType === 'corner';
                            if (isThrowIn) {
                                aim = biasThrowInAimInfield(aim, p, field);
                            } else if (isCorner) {
                                aim = biasCornerAimInfield(
                                    aim,
                                    level.setPieceSide,
                                    level.setPieceCornerY != null ? level.setPieceCornerY : 0,
                                    field
                                );
                            }

                            const origin = (isThrowIn || isCorner) && level._setPieceBallSpot
                                ? level._setPieceBallSpot
                                : { x: p.x, y: p.y };
                            const dx = aim.x - origin.x;
                            const dy = aim.y - origin.y;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            let nx = dx / (dist || 0.001);
                            let ny = dy / (dist || 0.001);
                            if (isThrowIn) {
                                const dir = clampThrowInDirection(nx, ny, p, field);
                                nx = dir.nx;
                                ny = dir.ny;
                            } else if (isCorner) {
                                const dir = clampCornerKickDirection(
                                    nx,
                                    ny,
                                    level.setPieceSide,
                                    level.setPieceCornerY != null ? level.setPieceCornerY : 0,
                                    field
                                );
                                nx = dir.nx;
                                ny = dir.ny;
                            }

                            ball.offsideReceiver = null;
                            ball.offsideLineX = null;

                            if (!isSetPiece && level.matchState === 'play') {
                                const isOpponentHalf = attacksRight ? (p.passTarget.x > field.centerX) : (p.passTarget.x < field.centerX);
                                const isPastBall = attacksRight ? (p.passTarget.x > ball.x) : (p.passTarget.x < ball.x);

                                if (isOpponentHalf && isPastBall) {
                                    let limitX = p.team === 'A' ? level.offsideLineA : level.offsideLineB;
                                    if (limitX == null) {
                                        const team = getTeamEntity(p);
                                        const defenders = (team && team.opponents)
                                            ? team.opponents.members()
                                            : level.players.filter(d => d.team !== p.team && !d.isSentOff);
                                        if (defenders.length >= 2) {
                                            if (attacksRight) {
                                                defenders.sort((a, b) => b.x - a.x);
                                            } else {
                                                defenders.sort((a, b) => a.x - b.x);
                                            }
                                            limitX = defenders[1].x;
                                        }
                                    }

                                    if (limitX != null) {
                                        const isOffside = attacksRight ? (p.passTarget.x > limitX) : (p.passTarget.x < limitX);
                                        if (isOffside) {
                                            ball.offsideReceiver = p.passTarget;
                                            ball.offsideLineX = limitX;
                                        }
                                    }
                                }
                            }

                            // Accuracy cone (shared kick-noise helper). Boundary set-pieces use a
                            // tighter cone — large angle error near the line re-triggers OOB.
                            const noisyPass = applyKickDirectionNoise(nx, ny, p.effectiveAccuracy || 70, {
                                angleScale: (isThrowIn || isCorner) ? 0.0035 : 0.0075,
                                playmaker: !!(p.traits && p.traits.includes('Playmaker'))
                            });
                            let devNx = noisyPass.nx;
                            let devNy = noisyPass.ny;
                            if (isThrowIn) {
                                const dir = clampThrowInDirection(devNx, devNy, p, field);
                                devNx = dir.nx;
                                devNy = dir.ny;
                            } else if (isCorner) {
                                const dir = clampCornerKickDirection(
                                    devNx,
                                    devNy,
                                    level.setPieceSide,
                                    level.setPieceCornerY != null ? level.setPieceCornerY : 0,
                                    field
                                );
                                devNx = dir.nx;
                                devNy = dir.ny;
                            }

                            ball.passFromX = origin.x;
                            ball.passFromY = origin.y;

                            if (isThrowIn) {
                                // Launch from fixed throw spot (not carry-offset feet) so the
                                // release origin cannot sit outside / on the paint.
                                const spot = origin;
                                ball.x = spot.x;
                                ball.y = spot.y;
                                ball.z = 2.0;
                                const speed = estimatePassGroundSpeed(
                                    { x: spot.x, y: spot.y },
                                    aim,
                                    p,
                                    'short'
                                );
                                ball.kick(devNx * speed, devNy * speed, 2.5, 0);
                                ball.isThrowInFlight = true;
                                if (level) level._setPieceBallSpot = null;
                            } else {
                                const passType = p.passType === 'long' ? 'long' : 'short';
                                // Corners: launch from fixed corner spot (taker is outside the flag).
                                if (isCorner) {
                                    ball.x = origin.x;
                                    ball.y = origin.y;
                                    ball.z = 0;
                                }
                                let speed = estimatePassGroundSpeed(
                                    { x: origin.x, y: origin.y },
                                    aim,
                                    p,
                                    passType
                                );
                                // Stage 2: human hold-to-power / lob identity / curl
                                const hk = p.humanKick;
                                if (hk && (hk.kind === 'pass' || hk.kind === 'lob')) {
                                    if (typeof hk.speedMul === 'number') {
                                        speed *= hk.speedMul;
                                    }
                                }
                                if (passType === 'long' || (hk && hk.forceLob) || isCorner) {
                                    // Settings.physics loft: ~3–8 m peak depending on distance
                                    // Corners always loft into the box (ground skim restarts OOB).
                                    const vzFn = typeof longPassVzForDistance === 'function'
                                        ? longPassVzForDistance
                                        : (d) => 5.5 + Math.min(d * 0.16, 7.5);
                                    let vz = vzFn(dist);
                                    if (hk && typeof hk.vzMul === 'number') {
                                        vz *= hk.vzMul;
                                    }
                                    // Lob identity: always airborne when human forced a lob
                                    if (hk && hk.forceLob && vz < 1.5) vz = 1.5;
                                    if (isCorner && vz < 4.0) vz = 4.0;
                                    const curve = (hk && typeof hk.curveForce === 'number')
                                        ? hk.curveForce
                                        : 0;
                                    ball.kick(devNx * speed, devNy * speed, vz, curve);
                                } else {
                                    ball.kick(devNx * speed, devNy * speed, 0, 0);
                                }
                                // Boundary grace for corners (same flag as throw-in flight)
                                if (isCorner) {
                                    ball.isThrowInFlight = true;
                                    if (level) level._setPieceBallSpot = null;
                                }
                            }
                            // True IFK: arm second-touch gate before clearing the flag
                            if (isFreekick && level.setPieceIndirect) {
                                armIndirectFreeKick(ball, p);
                            }
                            level.setPieceType = ''; // Clear setpiece type after kick!
                            if (level.setPieceIndirect) level.setPieceIndirect = false;
                            // A.6: freekick lay-off dissolves wall on pass release
                            if (isFreekick) {
                                releaseWallOnPass(level);
                            }
                            target.lastPassFrom = p;
                            target.passLinkCooldown = 1.4 + Math.random() * 0.6;
                            p.passLinkCooldown = 1.0;
                            p.passAim = null;
                            // Tell receiver a pass is coming (Msg_ReceiveBall)
                            const team = getTeamEntity(p);
                            if (team) team.receivingPlayer = target;
                            dispatchSoccerMsg(level, 0, p, target, SoccerMsg.ReceiveBall, {
                                target: { x: aim.x, y: aim.y }
                            });
                        } else {
                            // Fallback throw/kick forward in case no target exists at all
                            // Never use player orientation for kick direction!
                            const field = Utils.getFieldBounds();
                            const attacksRight = attacksRightGoal(p.level, p.team);
                            let fx = attacksRight ? 1.0 : -1.0;
                            let fy = 0.0;

                            if (isThrowIn) {
                                // Pure attack-axis throw hugs the touchline; bias into the pitch.
                                const dir = clampThrowInDirection(fx, fy, p, field);
                                fx = dir.nx;
                                fy = dir.ny;
                                const spot = (p.level && p.level._setPieceBallSpot)
                                    ? p.level._setPieceBallSpot
                                    : { x: p.x, y: p.y };
                                ball.x = spot.x;
                                ball.y = spot.y;
                                ball.z = 2.0; // Release height
                                ball.kick(fx * 12.0, fy * 12.0, 2.5, 0);
                                ball.isThrowInFlight = true;
                                if (p.level) p.level._setPieceBallSpot = null;
                            } else {
                                ball.kick(fx * 15.0, fy * 15.0, 0, 0);
                            }

                            if (isFreekick) {
                                if (p.level.setPieceIndirect) {
                                    armIndirectFreeKick(ball, p);
                                }
                                releaseWallOnPass(p.level);
                            }
                            p.level.setPieceType = '';
                            if (p.level.setPieceIndirect) p.level.setPieceIndirect = false;
                        }

                        ball.owner = null;
                    }
                    p.fsm.changeState(PlayerStates.Idle);
                }
            },
            exit(p) {
                p.passTarget = null;
                p.passType = 'short';
                p.humanKick = null;
            }
        },

        Shoot: {
            name: 'Shoot',
            enter(p) {
                p.frame = 3;
                startKickWindup(p);
                if (p.level && p.level.setPieceType !== '') {
                    p.vx = 0;
                    p.vy = 0;
                }
                SoundDB.play('shot');
                SoundDB.crowdReact('burst', 0.22);
            },
            execute(p) {
                if (p.level && p.level.setPieceType !== '') {
                    p.vx = 0;
                    p.vy = 0;
                }
                if (tickKickWindup(p, Time.deltaTime)) {
                    const ball = p.level.ball;
                    if (ball && ball.owner === p) {
                        const isFreekick = p.level && p.level.setPieceType === 'freekick';
                        const kick = computeShootKick(p);

                        // Compute and record xG-lite
                        const xg = computeXG(p, ball);
                        if (p.team === 'A') {
                            p.level.xgA += xg;
                        } else {
                            p.level.xgB += xg;
                        }
                        if (p.level._telemetry && typeof p.level._telemetry.onShotKicked === 'function') {
                            p.level._telemetry.onShotKicked({ team: p.team, xg });
                        }

                        ball.kick(kick.nx * kick.speed, kick.ny * kick.speed, kick.heightSpeed, kick.curveForce);
                        ball.isShot = true;
                        // A.6: wall jumps on kick release (not on Shoot enter)
                        if (isFreekick) {
                            if (p.level.setPieceIndirect) {
                                armIndirectFreeKick(ball, p);
                            }
                            releaseWallOnShotKick(p.level);
                        }
                        p.level.setPieceType = ''; // Clear setpiece type after kick!
                        if (p.level.setPieceIndirect) p.level.setPieceIndirect = false;
                        p.shotAim = null;
                        p.shotHeightBoost = null;
                        p.humanKick = null;
                    }
                    p.fsm.changeState(PlayerStates.Idle);
                }
            },
            exit(p) {
                p.shotAim = null;
                p.shotHeightBoost = null;
                p.humanKick = null;
            }
        },

        Header: {
            name: 'Header',
            enter(p) {
                p.headerTimer = 0.6;
                p.frame = 9;
                p.vx = 0;
                p.vy = 0;
                p.isHeading = false;
            },
            execute(p) {
                p.headerTimer -= Time.deltaTime;
                const ball = p.level.ball;
                if (!ball) {
                    p.fsm.changeState(PlayerStates.Idle);
                    return;
                }

                if (p.headerTimer > 0.45) {
                    p.frame = 9;
                    p.z = 0;
                } else if (p.headerTimer > 0.15) {
                    p.frame = 10;
                    const progress = (0.45 - p.headerTimer) / 0.3;
                    p.z = Math.sin(progress * Math.PI) * 0.8; // Nerfed from 1.2
                } else {
                    p.frame = 11;
                    const progress = (0.15 - p.headerTimer) / 0.15;
                    p.z = (1.0 - progress) * 0.4; // Scaled down exit animation

                    // Contact: XY close + ball still in header band (timing window)
                    const xyOk = dist2d(p.x, p.y, ball.x, ball.y) < 1.9;
                    const bz = ball.z || 0;
                    const zOk = bz >= 0.55 && bz < 2.15;
                    if (!p.isHeading && ball.owner === null && xyOk && zOk) {
                        p.isHeading = true;
                        applyHeaderContact(p, ball);
                    }
                }

                if (p.headerTimer <= 0) {
                    p.z = 0;
                    p.fsm.changeState(PlayerStates.Idle);
                }
            },
            exit(p) {
                p.z = 0;
                p.humanHeader = null;
            }
        }

    });
}

module.exports = {
    registerOutfieldStates,
    biasThrowInAimInfield,
    clampThrowInDirection,
    biasCornerAimInfield,
    clampCornerKickDirection
};
