const { GameObject, Orientation } = require('./gameobject.js');
const { Settings } = require('../../settings.js');
const { Time } = require('../lib/time.js');
const { StateMachine } = require('../lib/fsm.js');
const { SoundDB } = require('../lib/sounddb.js');
const { ImageDB } = require('../lib/imagedb.js');
const { Utils } = require('../lib/utils.js');
const {
    estimatePassGroundSpeed,
    isPassSafeFromAllOpponents,
    getBestPassToReceiver
} = require('../lib/pass_safety.js');
const { SoccerMsg } = require('../lib/soccer_messages.js');
const { dispatchSoccerMsg } = require('../lib/message_dispatcher.js');
const {
    composeSteer,
    collectNeighbors,
    pursuitPoint,
    interposePoint,
    arriveSpeedScale
} = require('../lib/steering.js');
const {
    futurePosition,
    applyKickDirectionNoise,
    sampleKickCurveForce,
    longPassVzForDistance,
    isBallAirborne,
    isHeaderHeight,
    findAirIntercept,
    findHeaderOpportunity
} = require('../lib/ball_prediction.js');
const { clearIfkOnTouch } = require('../lib/match_rules.js');
const { PlayerStates, initPlayerStates, isGoalkeeperRole, isOutfieldRole } = require('./player_states.js');
const {
    startKickWindup,
    tickKickWindup,
    armKickerClaimCooldown,
    canClaimAfterKick,
    canEvaluateKickDecision,
    markKickDecision,
    tickPlayerKickGates,
    getKickTimingParams
} = require('../lib/logic_regulator.js');
const {
    PositionLayer,
    POSITION_STACK_DOC,
    layerDepthHold,
    resolveIdleMoveTarget,
    isPositionTraceEnabled,
    attachPositionTrace
} = require('../lib/positioning_policy.js');
const { getPlayPhaseModsForPlayer } = require('../lib/play_phase.js');
const { applyWallHold } = require('../lib/freekick_wall.js');
const { applyFirstTouch } = require('../lib/first_touch.js');

// 1. Define which AI variables represent tactical spatial awareness (must scale with field size)
// Do NOT include absolute physics like FREEKICK_WALL_JUMP_VZ or SLIDE_TACKLE_RANGE
const TACTICAL_DISTANCE_KEYS = new Set([
    'SHORT_PASS_MIN_DIST', 'SHORT_PASS_MAX_DIST',
    'LONG_PASS_MIN_DIST', 'LONG_PASS_MAX_DIST',
    'MARK_MAX_ASSIGN_DIST', 'MARK_COVER_MIN_DIST', 'MARK_COVER_MAX_DIST',
    'ACTIVE_MARKER_MAX_DIST', 'PRESS_SECOND_CHASER_DIST',
    'CHASE_COMMIT_DIST', 'CHASE_INTERCEPT_FAR_DIST', 'CHASE_ABANDON_DIST',
    'COUNTERPRESS_SECONDARY_DIST', 'GK_INTERCEPT_RANGE', 'GK_CATCH_RANGE'
]);

const proxyCache = {
    base: null // Cache for generic Settings.AI
};

function createAIProxy(targetObject) {
    return new Proxy(targetObject, {
        get(target, prop) {
            // Get from target team, fallback to base Settings.AI
            let val = target[prop] !== undefined ? target[prop] : Settings.AI[prop];

            // 2. Dynamically scale tactical distances by the grass size multiplier
            if (typeof val === 'number' && TACTICAL_DISTANCE_KEYS.has(prop)) {
                return val * Utils.getFieldMultiplier();
            }
            return val;
        }
    });
}

function ai(entity) {
    if (entity) {
        const team = typeof entity === 'string' ? entity : entity.team;
        if (team && Settings.AI[team]) {
            if (!proxyCache[team] || proxyCache[team].target !== Settings.AI[team]) {
                proxyCache[team] = {
                    target: Settings.AI[team],
                    proxy: createAIProxy(Settings.AI[team])
                };
            }
            return proxyCache[team].proxy;
        }
    }

    // Always return a proxy even for base lookups so generic AI gets scaled too
    if (!proxyCache.base || proxyCache.base.target !== Settings.AI) {
        proxyCache.base = {
            target: Settings.AI,
            proxy: createAIProxy(Settings.AI)
        };
    }
    return proxyCache.base.proxy;
}

// --- Pure AI helpers (testable without FSM) ---

function attacksRightGoal(level, team) {
    return level.isSecondHalf() ? (team === 'B') : (team === 'A');
}

function getCarrierForwardSign(level, carrierTeam) {
    return attacksRightGoal(level, carrierTeam) ? 1 : -1;
}

function getAheadDelta(defender, carrier, level) {
    const sign = getCarrierForwardSign(level, carrier.team);
    return (defender.x - carrier.x) * sign;
}

function defendingGoalX(level, team) {
    const field = Utils.getFieldBounds();
    const defendsLeft = gkDefendsLeftGoal(level, { team });
    return defendsLeft ? 0 : field.width;
}

function computePressPriority(defender, carrier, level) {
    const dist = dist2d(defender.x, defender.y, carrier.x, carrier.y);
    const aheadDelta = getAheadDelta(defender, carrier, level);
    let priority = dist;

    if (aheadDelta > 0) {
        priority -= Math.min(4.0, aheadDelta * ai(defender).PRESS_PRIORITY_AHEAD_BONUS);
        priority -= Math.max(0, 2.0 - Math.abs(defender.y - carrier.y) * 0.35);
    } else if (aheadDelta < -0.5) {
        priority += Math.min(10.0, -aheadDelta * ai(defender).PRESS_PRIORITY_BEHIND_PENALTY);
    }

    return priority;
}

function canPressCarrier(defender, carrier, level) {
    const dist = dist2d(defender.x, defender.y, carrier.x, carrier.y);
    const aheadDelta = getAheadDelta(defender, carrier, level);

    if (aheadDelta >= -0.5) return true;
    if (dist <= ai(defender).CHASE_COMMIT_DIST) return true;
    if (dist > ai(defender).CHASE_ABANDON_DIST) return false;
    return aheadDelta > -ai(defender).CHASE_BEATEN_AHEAD_DIST * 2;
}

function isCarrierInDangerZone(carrier, defendingTeam, level) {
    const field = Utils.getFieldBounds();
    const goalX = defendingGoalX(level, defendingTeam);
    const distToGoal = Math.abs(carrier.x - goalX);
    return distToGoal <= field.width * ai(defendingTeam).DANGER_ZONE_FIELD_RATIO;
}

function effectiveDefensiveBlend(baseBlend, player) {
    return baseBlend * (1 - ai(player).FORMATION_HOLD) * ai(player).DEFENSIVE_PRESS_INTENSITY;
}

function attackingGoalX(level, team) {
    const field = Utils.getFieldBounds();
    return attacksRightGoal(level, team) ? field.width : 0;
}

function isCarrierInAttackingHalf(carrier, level) {
    const field = Utils.getFieldBounds();
    const sign = getCarrierForwardSign(level, carrier.team);
    const ownGoalX = sign > 0 ? 0 : field.width;
    return Math.abs(carrier.x - ownGoalX) > field.width * 0.5;
}

function isAheadOfFormationLine(player, target, level) {
    const sign = getCarrierForwardSign(level, player.team);
    return (target.x - player.baseX) * sign > Utils.scaleFieldX(3.125);
}

function getAttackLaneOffset(player, field) {
    const role = player.role || '';
    if (/W|LM|RM|LW|RW/.test(role)) {
        const wideSign = player.baseY < field.centerY ? -1 : 1;
        return { xPushRef: 25, yBiasRef: wideSign * 15 };
    }
    if (/S|CF|ST/.test(role)) {
        return { xPushRef: 31.25, yBiasRef: 0 };
    }
    return { xPushRef: 15.625, yBiasRef: (field.centerY - player.baseY) * 0.6 };
}

function computeAttackSupportTarget(player, carrier, level) {
    const field = Utils.getFieldBounds();
    const sign = getCarrierForwardSign(level, carrier.team);
    const lane = getAttackLaneOffset(player, field);
    const phaseMods = getPlayPhaseModsForPlayer(carrier || player);
    const intensity = ai(player).ATTACK_SUPPORT_INTENSITY * (phaseMods.supportDepthMult || 1);
    const push = Utils.scaleFieldX(lane.xPushRef) * intensity;
    const minAhead = Utils.scaleFieldX(6.25 * Math.min(1.15, phaseMods.supportDepthMult || 1));
    const margin = 0.5 * field.multiplier;

    let supportX = carrier.x + sign * push;
    if (sign > 0) supportX = Math.max(supportX, carrier.x + minAhead);
    else supportX = Math.min(supportX, carrier.x - minAhead);

    // Progress phase: stretch wider; build: stay more central/compact
    const widthMult = phaseMods.supportWidthMult || 1;
    const laneY = player.baseY + Utils.scaleFieldY(lane.yBiasRef) * widthMult;
    const carrierYBlend = Math.min(0.34, 0.22 + intensity * 0.15);
    let supportY = laneY * (1 - carrierYBlend) + carrier.y * carrierYBlend;

    if (intensity >= 0.7 * (phaseMods.supportDepthMult || 1)) {
        const minLateral = Utils.scaleFieldY((8 + (1 - Math.min(1, intensity)) * 4) * widthMult);
        const yDelta = supportY - carrier.y;
        if (Math.abs(yDelta) < minLateral) {
            const wideSign = Math.abs(yDelta) < 0.05
                ? (player.baseY <= carrier.y ? -1 : 1)
                : (yDelta >= 0 ? 1 : -1);
            supportY = carrier.y + wideSign * minLateral;
        }
    }

    const teamEnt = getTeamEntity(player);
    const depthX = teamEnt ? teamEnt.getDepthWorldOffset(player) : 0;
    const hold = teamEnt ? teamEnt.getEffectiveFormationHold() : ai(player).FORMATION_HOLD;
    const form = {
        x: player.baseX + depthX + (ballShiftX(level) * (1 - hold * 0.8)),
        y: player.baseY + (ballShiftY(level) * (1 - hold * 0.8))
    };
    const formWeight = hold * 0.45 + (1 - intensity) * 0.35;

    return {
        x: Math.max(margin, Math.min(field.width - margin, form.x * formWeight + supportX * (1 - formWeight))),
        y: Math.max(margin, Math.min(field.height - margin, form.y * formWeight + supportY * (1 - formWeight)))
    };
}

function ballShiftX(level) {
    const ball = level.ball;
    if (!ball) return 0;
    const field = Utils.getFieldBounds();
    return (ball.x - field.centerX) * 0.35;
}

function ballShiftY(level) {
    const ball = level.ball;
    if (!ball) return 0;
    const field = Utils.getFieldBounds();
    return (ball.y - field.centerY) * 0.3;
}

function getTeamEntity(player) {
    if (player && player.parent && typeof player.parent.getOutfieldPlayers === 'function') {
        return player.parent;
    }
    const level = player && player.level;
    if (level && player.team === 'A' && level.teamA) return level.teamA;
    if (level && player.team === 'B' && level.teamB) return level.teamB;
    return null;
}

function countOpenSupportRunners(carrier, level) {
    const sign = getCarrierForwardSign(level, carrier.team);
    const team = getTeamEntity(carrier);
    const teammates = team
        ? team.getOutfieldPlayers().filter(p => p !== carrier)
        : level.players.filter(p => p.team === carrier.team && p !== carrier && p.role !== 'GK');
    let count = 0;
    for (const tm of teammates) {
        const ahead = (tm.x - carrier.x) * sign > Utils.scaleFieldX(6.25);
        if (ahead && isTeammateOpen(level, tm, 3.2)) count++;
    }
    return count;
}

/**
 * Comfort / pressure radii (world units) from Settings.AI (team-split aware).
 * @param {object} player
 * @returns {{ comfort: number, pressure: number }}
 */
function getComfortZoneRadii(player) {
    const a = ai(player);
    const comfort = typeof a.PLAYER_COMFORT_ZONE === 'number' ? a.PLAYER_COMFORT_ZONE : 3.0;
    let pressure = typeof a.PLAYER_PRESSURE_ZONE === 'number' ? a.PLAYER_PRESSURE_ZONE : 5.0;
    if (pressure < comfort) pressure = comfort;
    return { comfort, pressure };
}

/**
 * True if nearest opponent is inside comfort zone.
 * @param {object} player
 * @param {number} [radius] - override comfort radius (world units)
 * @returns {boolean}
 */
function isThreatened(player, radius) {
    if (!player) return false;
    const info = getThreatInfo(player);
    const r = typeof radius === 'number' ? radius : info.comfortZone;
    return info.dist < r;
}

/**
 * Shared threat query for Dribble pass bias and debug highlight.
 * @param {object} player
 * @returns {{
 *   nearest: object|null,
 *   dist: number,
 *   comfortZone: number,
 *   pressureZone: number,
 *   threatened: boolean,
 *   underPressure: boolean
 * }}
 */
function getThreatInfo(player) {
    const { comfort, pressure } = getComfortZoneRadii(player);
    const nearest = player ? getNearestOpponent(player) : null;
    const dist = nearest
        ? dist2d(player.x, player.y, nearest.x, nearest.y)
        : Infinity;
    return {
        nearest,
        dist,
        comfortZone: comfort,
        pressureZone: pressure,
        threatened: dist < comfort,
        underPressure: dist < pressure
    };
}

/**
 * Dribble pass probability — elevated when threatened / under pressure.
 * @param {object} carrier
 * @param {number|object|null} [nearestOppDistOrThreat] - distance, threat info, or omit to compute
 */
function computeDribblePassChance(carrier, nearestOppDistOrThreat) {
    const aggression = ai(carrier).PASS_AGGRESSION;
    if (aggression <= 0.02) return 0;

    const level = carrier.level;
    const openSupport = level ? countOpenSupportRunners(carrier, level) : 0;

    let threat;
    if (nearestOppDistOrThreat && typeof nearestOppDistOrThreat === 'object' && typeof nearestOppDistOrThreat.dist === 'number') {
        threat = nearestOppDistOrThreat;
    } else if (typeof nearestOppDistOrThreat === 'number') {
        const radii = getComfortZoneRadii(carrier);
        const dist = nearestOppDistOrThreat;
        threat = {
            dist,
            comfortZone: radii.comfort,
            pressureZone: radii.pressure,
            threatened: dist < radii.comfort,
            underPressure: dist < radii.pressure
        };
    } else {
        threat = getThreatInfo(carrier);
    }

    // Prefer pass when inside comfort zone; soft bias in pressure ring (legacy 3/5 bands)
    let chance;
    if (threat.threatened) {
        chance = 0.08;
        const mult = ai(carrier).THREATENED_PASS_MULT;
        if (typeof mult === 'number' && mult > 0) chance *= mult;
    } else if (threat.underPressure) {
        chance = 0.04;
    } else {
        chance = 0.012;
    }
    chance += openSupport * 0.035 * ai(carrier).ATTACK_SUPPORT_INTENSITY;

    let finalChance = chance * aggression;
    const phaseMods = getPlayPhaseModsForPlayer(carrier);
    finalChance *= phaseMods.passChanceMult || 1;

    // Selfish Finisher trait: reduces pass chance in the shooting box
    if (carrier.traits && carrier.traits.includes('Selfish Finisher')) {
        const field = Utils.getFieldBounds();
        const goalX = attackingGoalX(level, carrier.team);
        const distToGoal = Math.sqrt(Math.pow(goalX - carrier.x, 2) + Math.pow(field.centerY - carrier.y, 2));
        if (distToGoal < getShootRange(carrier)) {
            finalChance *= 0.35; // 65% reduction in passing chance
        }
    }

    // Optional debug highlight hook (canvas overlay can read this)
    if (ai(carrier).DEBUG_HIGHLIGHT_THREATENED) {
        carrier.debugThreatened = !!threat.threatened;
        carrier.debugThreatDist = threat.dist;
    }

    return Math.min(0.22, finalChance);
}

function getShootRange(player) {
    const mods = getPlayPhaseModsForPlayer(player);
    return Utils.scaleFieldX(ai(player).SHOOT_RANGE_REF) * (mods.shootRangeMult || 1);
}

function dist2d(ax, ay, bx, by) {
    return Math.sqrt(Math.pow(bx - ax, 2) + Math.pow(by - ay, 2));
}

function computeTackleType(dist, player) {
    if (dist <= ai(player).FOOT_TACKLE_RANGE) return 'foot';
    if (dist <= ai(player).SLIDE_TACKLE_RANGE) return 'slide';
    return null;
}

function computeTackleSuccess(tackler, opponent, tackleType) {
    const a = ai(tackler);
    let base;
    if (tackleType === 'body') {
        base = typeof a.BODY_TACKLE_SUCCESS_BASE === 'number' ? a.BODY_TACKLE_SUCCESS_BASE : 0.48;
    } else if (tackleType === 'slide') {
        base = typeof a.SLIDE_TACKLE_SUCCESS_BASE === 'number' ? a.SLIDE_TACKLE_SUCCESS_BASE : 0.40;
    } else {
        base = typeof a.FOOT_TACKLE_SUCCESS_BASE === 'number' ? a.FOOT_TACKLE_SUCCESS_BASE : 0.58;
    }
    const tStat = (tackler && tackler.stats && typeof tackler.stats.tackling === 'number')
        ? tackler.stats.tackling
        : 50;
    const dStat = (opponent && opponent.stats && typeof opponent.stats.dribbling === 'number')
        ? opponent.stats.dribbling
        : 50;
    let statEdge = (tStat - dStat) * 0.006;

    // Hard Tackler trait: +15% tackle success rate
    if (tackler.traits && tackler.traits.includes('Hard Tackler')) {
        statEdge += 0.15;
    }

    const chance = base + statEdge;
    // Body shoves are harder to land cleanly — slightly tighter cap
    const maxC = tackleType === 'body' ? 0.78 : 0.85;
    return Math.max(0.15, Math.min(maxC, chance));
}

/**
 * Recovery duration (s) for a tackle type.
 * @param {object} tackler
 * @param {'foot'|'slide'|'body'|string} tackleType
 */
function tackleRecoveryFor(tackler, tackleType) {
    const a = ai(tackler);
    if (tackleType === 'slide') {
        return typeof a.TACKLE_RECOVERY_SLIDE === 'number' ? a.TACKLE_RECOVERY_SLIDE : 0.95;
    }
    if (tackleType === 'body') {
        return typeof a.TACKLE_RECOVERY_BODY === 'number' ? a.TACKLE_RECOVERY_BODY : 0.78;
    }
    return typeof a.TACKLE_RECOVERY_FOOT === 'number' ? a.TACKLE_RECOVERY_FOOT : 0.45;
}

/**
 * Apply recovery animation lock (frames 5/6) used by Idle / global update.
 * @param {object} player
 * @param {number} recoverySec
 */
function applyActionLock(player, recoverySec) {
    if (!player) return;
    const sec = Math.max(0.05, recoverySec || 0.45);
    player.actionTimer = sec;
    player.isSliding = false;
    player.slideTimer = 0;
    player.frame = 5;
    player.frameTimer = 0;
    player.vx = 0;
    player.vy = 0;
    player._currentSpeed = 0;
}

/**
 * Human foul multiplier from Settings.manualControl (Stage 3).
 * @param {object} tackler
 * @param {string} tackleType
 */
function humanFoulMultiplier(tackler, tackleType) {
    if (!tackler || !tackler.humanControlled) return 1;
    const mc = (Settings && Settings.manualControl) || {};
    let mul = typeof mc.humanFoulMul === 'number' ? mc.humanFoulMul : 1;
    if (tackleType === 'body' && typeof mc.humanBodyFoulMul === 'number') {
        mul *= mc.humanBodyFoulMul;
    } else if (tackleType === 'slide' && typeof mc.humanSlideFoulMul === 'number') {
        mul *= mc.humanSlideFoulMul;
    } else if (tackleType === 'foot' && typeof mc.humanFootFoulMul === 'number') {
        mul *= mc.humanFootFoulMul;
    }
    return Math.max(0.1, Math.min(3, mul));
}

function isTeammateOpen(level, teammate, radius) {
    const teamEnt = getTeamEntity(teammate);
    const oppTeam = teamEnt ? teamEnt.opponents : null;
    const opponents = oppTeam
        ? oppTeam.members()
        : level.players.filter(p => p.team !== teammate.team);
    let openScore = 10;
    for (const defender of opponents) {
        const d = dist2d(defender.x, defender.y, teammate.x, teammate.y);
        if (d < radius) openScore -= (radius - d) * 3;
    }
    return openScore > 3;
}

function choosePassType(dist, isOpen, player) {
    const mods = getPlayPhaseModsForPlayer(player);
    const longMin = ai(player).LONG_PASS_MIN_DIST;
    const longMax = ai(player).LONG_PASS_MAX_DIST;
    const shortMax = ai(player).SHORT_PASS_MAX_DIST;
    // Build: stretch short band; Progress: allow long sooner when open
    const shortCap = shortMax * (0.85 + 0.3 * Math.min(1.5, mods.shortPassBias || 1));
    const longFloor = longMin * (mods.longPassBias > 1.05 ? 0.88 : mods.longPassBias < 0.7 ? 1.12 : 1);

    if (dist >= longFloor && dist <= longMax && isOpen && mods.longPassBias >= 0.55) {
        // Prefer short when build bias is high and still in short band
        if (mods.shortPassBias > 1.2 && dist <= shortCap) return 'short';
        return 'long';
    }
    if (dist <= shortCap) return 'short';
    // Progress mid-range open ball: still long
    if (dist > shortCap && dist <= longMax && isOpen && mods.longPassBias >= 1.05) return 'long';
    return null;
}

function getNearestOpponent(player) {
    const team = getTeamEntity(player);
    const opponents = team && team.opponents
        ? team.opponents.getOutfieldPlayers()
        : null;

    let nearest = null;
    let minDist = Infinity;
    const pool = opponents || player.level.players;
    for (const p of pool) {
        if (!opponents && (p.team === player.team || p.role === 'GK')) continue;
        const d = dist2d(player.x, player.y, p.x, p.y);
        if (d < minDist) {
            minDist = d;
            nearest = p;
        }
    }
    return nearest;
}

function computeDribbleTarget(player) {
    const level = player.level;
    const field = Utils.getFieldBounds();
    const attacksRight = attacksRightGoal(level, player.team);
    const forwardSign = attacksRight ? 1 : -1;
    const goalY = field.centerY;
    const inAttackingHalf = isCarrierInAttackingHalf(player, level);

    const forwardStep = Utils.scaleFieldX(inAttackingHalf ? 12.5 : 7.8125) * (0.65 + Math.random() * 0.55);
    let targetX = player.x + forwardSign * forwardStep;
    let targetY = player.y + (goalY - player.y) * (0.25 + Math.random() * 0.3);
    targetY += (Math.random() - 0.5) * Utils.scaleFieldY(12.5);

    const weaveSeed = player.x * 0.5 + player.y * 0.3 + Math.random() * 6.28;
    const weave = Math.sin(weaveSeed) * Utils.scaleFieldY(6);
    targetY += weave;

    const nearestOpp = getNearestOpponent(player);
    if (nearestOpp) {
        const odx = player.x - nearestOpp.x;
        const ody = player.y - nearestOpp.y;
        const odist = Math.sqrt(odx * odx + ody * ody);
        const evadeRadius = Utils.scaleFieldX(14.0625);
        if (odist < evadeRadius && odist > 0.01) {
            const push = (evadeRadius - odist) * 0.55;
            targetX += (odx / odist) * push * 0.4;
            targetY += (ody / odist) * push;
        }
    }

    const form = player.getTargetFormationPos();
    const formWeight = inAttackingHalf ? 0.05 : 0.14;
    targetX = targetX * (1 - formWeight) + form.x * formWeight;
    targetY = targetY * (1 - formWeight * 1.5) + form.y * (formWeight * 1.5);

    const minForward = Utils.scaleFieldX(inAttackingHalf ? 7.8125 : 3.75);
    const minForwardX = player.x + forwardSign * minForward;
    if (attacksRight) targetX = Math.max(targetX, minForwardX);
    else targetX = Math.min(targetX, minForwardX);

    const margin = field.multiplier;
    return {
        x: Math.max(margin, Math.min(field.width - margin, targetX)),
        y: Math.max(margin, Math.min(field.height - margin, targetY))
    };
}

/**
 * Formation-support blend used as a lead-pass candidate / ahead check.
 * Actual kick aims come from Team.getBestPassToReceiver (tangents + safety).
 */
function getPassReceiverPosition(teammate, carrier, level) {
    const support = computeAttackSupportTarget(teammate, carrier, level);
    return {
        x: teammate.x * 0.25 + support.x * 0.75,
        y: teammate.y * 0.25 + support.y * 0.75
    };
}

function isDefensiveOutfieldRole(role) {
    return /CB|LB|RB|DM|LCB|RCB|CDM|LWB|RWB/i.test(role || '');
}

function isAttackingOutfieldRole(role) {
    return /S|CF|ST|LW|RW|LS|RS|AM|CAM|SS|WF/i.test(role || '');
}

function isMidfieldRole(role) {
    return /CM|LCM|RCM|LM|RM|DM|CDM/i.test(role || '');
}

function isPassReceiverAhead(carrier, teammate, level) {
    const sign = getCarrierForwardSign(level, carrier.team);
    const recv = getPassReceiverPosition(teammate, carrier, level);
    const gainNow = (teammate.x - carrier.x) * sign;
    const gainRecv = (recv.x - carrier.x) * sign;
    const forwardGain = Math.max(gainNow, gainRecv);
    const mods = getPlayPhaseModsForPlayer(carrier);
    const minGain = Utils.scaleFieldX(
        typeof mods.minForwardGainRef === 'number' ? mods.minForwardGainRef : 4.6875
    );

    // Build phase: allow short square/back outlets (CB recycle) within a soft band
    if (forwardGain < minGain) {
        if (mods.allowBackPass) {
            const backLimit = Utils.scaleFieldX(8);
            if (forwardGain < -backLimit) return false;
            // Prefer mid/def receivers for recycle, not strikers dropping deep only
            if (isAttackingOutfieldRole(teammate.role) && forwardGain < 0) return false;
        } else {
            return false;
        }
    }
    if (isDefensiveOutfieldRole(carrier.role) && isDefensiveOutfieldRole(teammate.role)) {
        // Build: CB-to-CB / CB-to-FB is legal recycling
        if (!mods.allowBackPass) return false;
    }

    if (!isCarrierInAttackingHalf(carrier, level)) {
        if (isDefensiveOutfieldRole(teammate.role) && !isMidfieldRole(teammate.role) && !isAttackingOutfieldRole(teammate.role)) {
            // Build invites defensive involvement; finish/progress keep the old filter soft
            if (!mods.allowBackPass && mods.defReceiverWeight < 1.5) return false;
        }
    }

    return true;
}

function scorePassTarget(carrier, teammate, dist, open) {
    const mods = getPlayPhaseModsForPlayer(carrier);
    let score = (open ? 8 : 2) + (10 - Math.abs(dist - 6));
    if (isAttackingOutfieldRole(teammate.role)) score += 7;
    else if (isMidfieldRole(teammate.role)) score += 3;
    else if (isDefensiveOutfieldRole(teammate.role)) {
        // Base penalty scaled by phase (build re-enables CBs/DMs as outlets)
        score -= 14 / Math.max(0.35, mods.defReceiverWeight);
    }

    const sign = getCarrierForwardSign(carrier.level, carrier.team);
    const recv = getPassReceiverPosition(teammate, carrier, carrier.level);
    const forwardGain = (recv.x - carrier.x) * sign;
    score += Math.min(6, forwardGain * 0.25 * mods.forwardGainWeight);

    // Prefer shorter connections in build; cutbacks still short in finish
    if (mods.shortDistBonus && dist <= (ai(carrier).SHORT_PASS_MAX_DIST || 8)) {
        score += mods.shortDistBonus;
    }
    // Finish: penalize clear backwards
    if (!mods.allowBackPass && forwardGain < 0) {
        score += forwardGain * 0.35 * mods.forwardGainWeight;
    }
    return score;
}

function computeShootKick(carrier) {
    const field = Utils.getFieldBounds();
    const attacksRight = attacksRightGoal(carrier.level, carrier.team);
    let targetGoalX = attacksRight ? field.width : 0;
    let targetGoalY;

    // Prefer CanShoot sample (safe goal-mouth point) when set on the player
    if (carrier.shotAim && typeof carrier.shotAim.x === 'number' && typeof carrier.shotAim.y === 'number') {
        targetGoalX = carrier.shotAim.x;
        targetGoalY = carrier.shotAim.y;
    } else {
        // Better shooters aim closer to the corners
        const shootQuality = ((carrier.effectiveShooting || 65) + (carrier.effectiveAccuracy || 70)) / 200.0;
        const sideFactor = Math.random() < 0.5 ? -1 : 1;
        targetGoalY = field.centerY + sideFactor * Utils.scaleFieldY(shootQuality * 6.75 + (1.0 - shootQuality) * (Math.random() * 2.5));
    }

    const dx = targetGoalX - carrier.x;
    const dy = targetGoalY - carrier.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;

    // Shot ground speed from Settings.physics (m/s)
    const phys = (Settings && Settings.physics) || {};
    const shootBase = typeof phys.SHOOT_SPEED_BASE === 'number' ? phys.SHOOT_SPEED_BASE : 11.0;
    const shootScale = typeof phys.SHOOT_SPEED_STAT_SCALE === 'number' ? phys.SHOOT_SPEED_STAT_SCALE : 6.0;
    const shooting = carrier.effectiveShooting || 65;
    let speed = shootBase + (shooting / 100.0) * shootScale;
    const closeRange = Utils.scaleFieldX(18.75);
    // A.6: freekick chip-over wall uses heightSpeed from canShootPastWall
    const hNearMin = typeof phys.SHOOT_HEIGHT_NEAR_MIN === 'number' ? phys.SHOOT_HEIGHT_NEAR_MIN : 0.5;
    const hNearSpan = typeof phys.SHOOT_HEIGHT_NEAR_SPAN === 'number' ? phys.SHOOT_HEIGHT_NEAR_SPAN : 0.9;
    const hFarMin = typeof phys.SHOOT_HEIGHT_FAR_MIN === 'number' ? phys.SHOOT_HEIGHT_FAR_MIN : 1.2;
    const hFarSpan = typeof phys.SHOOT_HEIGHT_FAR_SPAN === 'number' ? phys.SHOOT_HEIGHT_FAR_SPAN : 1.6;
    let heightSpeed = dist < closeRange
        ? hNearMin + Math.random() * hNearSpan
        : hFarMin + Math.random() * hFarSpan;
    if (typeof carrier.shotHeightBoost === 'number' && carrier.shotHeightBoost > 0) {
        heightSpeed = carrier.shotHeightBoost;
    }

    // Stage 2 human hold-to-power / curl (opt-in via humanKick payload)
    const hk = carrier.humanKick;
    if (hk && hk.kind === 'shoot') {
        if (typeof hk.speedMul === 'number') {
            speed *= hk.speedMul;
        }
        if (typeof hk.heightSpeed === 'number') {
            heightSpeed = hk.heightSpeed;
        }
    }

    const nx = dx / dist;
    const ny = dy / dist;
    // Shared kick-noise helper — tighter cone on shots so more stay on frame (arcade)
    const shotAngleScale = (Settings.AI && typeof Settings.AI.SHOOT_ANGLE_NOISE_SCALE === 'number')
        ? Settings.AI.SHOOT_ANGLE_NOISE_SCALE
        : 0.0055;
    const noisy = applyKickDirectionNoise(nx, ny, carrier.effectiveAccuracy || 70, {
        angleScale: shotAngleScale
    });
    let curveForce = sampleKickCurveForce(carrier.effectiveShooting || 65);
    // Soften random Magnus on AI shots so aim isn't washed out (human curl unchanged)
    if (!(hk && hk.kind === 'shoot' && typeof hk.curveForce === 'number')) {
        const curveScale = (Settings.AI && typeof Settings.AI.SHOOT_CURVE_SCALE === 'number')
            ? Settings.AI.SHOOT_CURVE_SCALE
            : 0.55;
        curveForce *= curveScale;
    }
    if (hk && hk.kind === 'shoot' && typeof hk.curveForce === 'number') {
        // Human bias + noise already baked into humanKick.curveForce
        curveForce = hk.curveForce;
    }

    return {
        nx: noisy.nx,
        ny: noisy.ny,
        speed,
        heightSpeed,
        curveForce,
        dist
    };
}

function estimateChaserSpeed(chaser) {
    return estimatePlayerTopSpeed(chaser);
}

/**
 * Player top speed (m/s) from Settings.physics — shared by moveTo, chasers, pass safety.
 * @param {{ stats?: { speed?: number }, staminaMultiplier?: number, currentStamina?: number }|null} player
 * @returns {number}
 */
function estimatePlayerTopSpeed(player) {
    const p = (Settings && Settings.physics) || {};
    const base = typeof p.PLAYER_BASE_SPEED === 'number' ? p.PLAYER_BASE_SPEED : 4.6;
    const bonusMax = typeof p.PLAYER_SPEED_STAT_BONUS === 'number' ? p.PLAYER_SPEED_STAT_BONUS : 3.4;
    if (!player) return (base + bonusMax * 0.6) * (Settings.SPRITE_SPEED || 1);

    const baseStats = (player.stats && player.stats.speed) || 60;
    const stam = player.staminaMultiplier != null
        ? player.staminaMultiplier
        : (player.currentStamina != null ? player.currentStamina : 1);
    const speedBonus = (baseStats / 100.0) * bonusMax * stam;
    return (base + speedBonus) * (Settings.SPRITE_SPEED || 1);
}

function computeLooseBallInterceptTarget(chaser, ball) {
    const dist = dist2d(chaser.x, chaser.y, ball.x, ball.y);

    if (dist <= ai(chaser).BALL_CLAIM_RANGE * 2) {
        return { x: ball.x, y: ball.y };
    }

    const ballSpeed = Math.sqrt((ball.vx || 0) * (ball.vx || 0) + (ball.vy || 0) * (ball.vy || 0));
    if (ballSpeed < 0.25 && !isBallAirborne(ball)) {
        return { x: ball.x, y: ball.y };
    }

    const chaserSpeed = estimateChaserSpeed(chaser);
    const maxT = ai(chaser).LOOSE_BALL_INTERCEPT_MAX_T;

    // Stage 4: airborne loose balls — shared 3D intercept (landing / catch band)
    if (isBallAirborne(ball)) {
        const air = findAirIntercept(
            ball,
            { x: chaser.x, y: chaser.y, speed: chaserSpeed },
            {
                maxTime: Math.min(maxT, 1.6),
                dt: 0.05,
                // Prefer claimable height (ground through header band)
                zMin: 0,
                zMax: 2.0,
                reachSlack: ai(chaser).BALL_CLAIM_RANGE * 1.2,
                preferT: 0.35,
                tWeight: 0.9
            }
        );
        if (air && air.canReach) {
            const field = Utils.getFieldBounds();
            const margin = 0.5 * field.multiplier;
            return {
                x: Math.max(margin, Math.min(field.width - margin, air.x)),
                y: Math.max(margin, Math.min(field.height - margin, air.y))
            };
        }
    }

    let t = dist / Math.max(chaserSpeed, 0.5);
    t = Math.min(t, maxT);

    // shared friction FuturePosition (not constant-velocity vx*t)
    let pred = futurePosition(ball, t);
    // One refinement toward meeting point
    const dPred = dist2d(chaser.x, chaser.y, pred.x, pred.y);
    let t2 = dPred / Math.max(chaserSpeed, 0.5);
    t2 = Math.min(t2, maxT);
    pred = futurePosition(ball, t2);

    const field = Utils.getFieldBounds();
    const margin = 0.5 * field.multiplier;
    let predX = Math.max(margin, Math.min(field.width - margin, pred.x));
    let predY = Math.max(margin, Math.min(field.height - margin, pred.y));

    const farDist = ai(chaser).CHASE_INTERCEPT_FAR_DIST;
    const closeDist = ai(chaser).BALL_CLAIM_RANGE * 2;
    const span = Math.max(0.001, farDist - closeDist);
    const blend = Math.max(0, Math.min(0.65, (dist - closeDist) / span));

    return {
        x: ball.x + (predX - ball.x) * blend,
        y: ball.y + (predY - ball.y) * blend
    };
}

function tryClaimLooseBall(player, ball) {
    if (!ball || ball.owner !== null) return false;
    if (!canClaimAfterKick(player)) return false;

    // Players cannot claim a loose ball that is out of bounds
    const field = Utils.getFieldBounds();
    if (ball.x < 0 || ball.x > field.width || ball.y < 0 || ball.y > field.height) {
        return false;
    }
    const dist = dist2d(player.x, player.y, ball.x, ball.y);

    // Outfield players defer to a GK who is within catch range (prevents Receive/Idle steals)
    if (player.role !== 'GK' && player.level && player.level.players) {
        for (const other of player.level.players) {
            if (other.role !== 'GK' || other.isSentOff) continue;
            const gd = dist2d(other.x, other.y, ball.x, ball.y);
            if (gd <= ai(other).GK_CATCH_RANGE * 1.35) {
                return false;
            }
        }
    }

    // B.4 Offside delayed whistle check
    if (ball.offsideReceiver) {
        const isGroundClaim = ball.z < 0.9 && dist < ai(player).BALL_CLAIM_RANGE;
        let isHeaderClaim = false;
        if ((ball.z >= 0.9 || isBallAirborne(ball)) && player.role !== 'GK') {
            const opp = findHeaderOpportunity(ball, {
                x: player.x,
                y: player.y,
                speed: estimatePlayerTopSpeed(player)
            }, {
                contactRadius: ai(player).BALL_CLAIM_RANGE * 1.4,
                maxTime: 0.7
            });
            isHeaderClaim = !!(opp && opp.ok);
        }

        if (isGroundClaim || isHeaderClaim) {
            if (ball.offsideReceiver === player) {
                if (player.level && typeof player.level.triggerOffside === 'function') {
                    player.level.triggerOffside(player);
                }
                ball.offsideReceiver = null;
                ball.offsideLineX = null;
                return true;
            } else {
                // Another player claimed it, offside is washed/cleared
                ball.offsideReceiver = null;
                ball.offsideLineX = null;
            }
        }
    }

    if (ball.z >= 0.9 || isBallAirborne(ball)) {
        // Stage 1.5: human keeps agency — no auto Header FSM (steals run/dribble control)
        // Stage 4: human times headers via manual_control; AI uses shared opportunity search.
        const blockHeader = player.humanControlled
            && !(Settings.manualControl && Settings.manualControl.blockAutoHeader === false);
        if (player.role !== 'GK' && !blockHeader) {
            if (player.fsm.currentState !== PlayerStates.Header) {
                const opp = findHeaderOpportunity(ball, {
                    x: player.x,
                    y: player.y,
                    speed: estimatePlayerTopSpeed(player)
                }, {
                    contactRadius: Math.max(1.6, ai(player).BALL_CLAIM_RANGE * 1.6),
                    maxTime: 0.85,
                    jumpLead: 0.45
                });
                // Enter when a reachable header sample is near contact timing
                if (opp && opp.ok && opp.t <= 0.55) {
                    player.fsm.changeState(PlayerStates.Header);
                    return true;
                }
            }
        }
        // High ball: only Header path (or human manual); no ground claim
        if (isHeaderHeight(ball.z || 0) || (ball.z || 0) >= 0.9) {
            return false;
        }
        // Low bounce still airborne but under header band — fall through to ground claim
    }

    if (dist >= ai(player).BALL_CLAIM_RANGE) return false;

    // A.8 First touch: heavy touch may leave ball free with residual velocity.
    // Own-pass reclaim (same player as lastKicker) is always clean — avoids
    // post-pass fumble loops where the passer re-pops the ball for seconds.
    const ownPass = !!(ball.lastKicker && ball.lastKicker === player);
    const touch = applyFirstTouch(player, ball, { forceClean: ownPass });
    if (touch.fumbled) {
        SoundDB.play('touch');
        // Stay in current FSM (Receive continues hunt after claim lock; Idle re-evaluates)
        return true;
    }

    // Check progressive pass
    if (ball.passFromX != null && ball.lastKicker) {
        if (player.team === ball.lastKicker.team) {
            const attacksRight = attacksRightGoal(player.level, player.team);
            const attackSign = attacksRight ? 1.0 : -1.0;
            if ((player.x - ball.passFromX) * attackSign >= 8.0) {
                if (player.team === 'A') {
                    if (player.level) player.level.progressivePassesA++;
                } else {
                    if (player.level) player.level.progressivePassesB++;
                }
                if (player.level && player.level._telemetry && typeof player.level._telemetry.onProgressivePass === 'function') {
                    player.level._telemetry.onProgressivePass({ team: player.team });
                }
            }
        }
        ball.passFromX = null;
        ball.passFromY = null;
    }

    ball.owner = player;
    ball.lastKicker = null;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    // IFK second touch: any player other than the taker clears the gate
    clearIfkOnTouch(ball, player);
    SoundDB.play('touch');
    player.fsm.changeState(PlayerStates.Dribble);
    return true;
}

function computeChaseInterceptTarget(chaser, ball) {
    if (ball.owner && ball.owner.team !== chaser.team) {
        const carrier = ball.owner;
        const dist = dist2d(chaser.x, chaser.y, carrier.x, carrier.y);

        const field = Utils.getFieldBounds();
        const goalX = attacksRightGoal(chaser.level, carrier.team) ? field.width : 0;
        const cutX = carrier.x + (goalX - carrier.x) * ai(chaser).CHASE_CUT_OFF_RATIO;
        const cutY = carrier.y + (field.centerY - carrier.y) * 0.35;
        const aheadDelta = getAheadDelta(chaser, carrier, chaser.level);

        if (dist <= ai(chaser).CHASE_COMMIT_DIST) {
            return { x: carrier.x, y: carrier.y };
        }

        if (aheadDelta < -ai(chaser).CHASE_BEATEN_AHEAD_DIST) {
            const sign = getCarrierForwardSign(chaser.level, carrier.team);
            const recoverX = carrier.x + sign * Utils.scaleFieldX(15.625);
            return {
                x: recoverX + (cutX - recoverX) * 0.35,
                y: cutY + (carrier.y - cutY) * 0.2
            };
        }

        const farDist = ai(chaser).CHASE_INTERCEPT_FAR_DIST;
        const closeDist = ai(chaser).CHASE_COMMIT_DIST;
        const span = Math.max(0.001, farDist - closeDist);
        const blend = Math.max(0, Math.min(1, (farDist - dist) / span));

        return {
            x: cutX + (carrier.x - cutX) * blend,
            y: cutY + (carrier.y - cutY) * blend
        };
    }
    return computeLooseBallInterceptTarget(chaser, ball);
}

function isGkProtected(gk) {
    return !!(gk && gk.role === 'GK' && (gk.gkClaimTimer > 0 || gk.gkHoldTimer > 0));
}

function gkFacesIntoField(gk) {
    const secondHalf = gk.level && typeof gk.level.isSecondHalf === 'function' && gk.level.isSecondHalf();
    const facesRight = secondHalf ? (gk.team === 'B') : (gk.team === 'A');
    return facesRight ? 2 : 6;
}

function gkDefendsLeftGoal(level, gk) {
    if (!level || typeof level.isSecondHalf !== 'function') return gk.team === 'A';
    return level.isSecondHalf() ? (gk.team === 'B') : (gk.team === 'A');
}

function getGoalkeeperBaseX(level, team) {
    const defendsLeft = gkDefendsLeftGoal(level, { team });
    return defendsLeft ? Utils.scaleFieldX(3.125) : Utils.scaleFieldX(96.875);
}

function computeGkClearTarget(gk, level) {
    const team = gk.getTeam();
    const teammates = team ? team.getOutfieldPlayers() : [];
    const opponents = team ? team.getOpponentPool() : [];
    const from = { x: gk.x, y: gk.y };

    // 1. Choose distribution style: 40% short build, 60% long kick
    const rand = Math.random();
    const tryShort = rand < 0.4;

    if (tryShort && teammates.length > 0) {
        // Find close teammates (defenders) within 15 world units
        const closeTeammates = teammates.filter(p => {
            const d = dist2d(gk.x, gk.y, p.x, p.y);
            return d > 3.6 && d <= 15.0 && !p.isSentOff;
        });

        // Sort by distance (nearest first) to prioritize safe close passes
        closeTeammates.sort((a, b) => {
            const da = dist2d(gk.x, gk.y, a.x, a.y);
            const db = dist2d(gk.x, gk.y, b.x, b.y);
            return da - db;
        });

        for (const tm of closeTeammates) {
            const target = { x: tm.x, y: tm.y };
            const speed = estimatePassGroundSpeed(from, target, gk, 'short');
            // Check if ground pass is safe from all opponents
            if (isPassSafeFromAllOpponents(from, target, tm, opponents, speed)) {
                return {
                    target,
                    speed,
                    vz: 0,
                    teammate: tm
                };
            }
        }
    }

    // 2. Long kick / clear (either chosen or fallback)
    // Find teammates further downfield (distance > 12)
    const farTeammates = teammates.filter(p => {
        const d = dist2d(gk.x, gk.y, p.x, p.y);
        return d > 12.0 && !p.isSentOff;
    });

    if (farTeammates.length > 0) {
        // Sort by downfield progress (further towards opponent's goal is better)
        const defendsLeft = gkDefendsLeftGoal(level, gk);
        farTeammates.sort((a, b) => {
            return defendsLeft ? (b.x - a.x) : (a.x - b.x);
        });

        // Find a safe/open one, or just pick the best downfield one
        for (const tm of farTeammates) {
            const target = { x: tm.x, y: tm.y };
            const speed = estimatePassGroundSpeed(from, target, gk, 'long');
            // Since it's in the air, we can use a slightly higher tolerance for safety
            if (isPassSafeFromAllOpponents(from, target, tm, opponents, speed)) {
                const phys = (Settings && Settings.physics) || {};
                const vzMin = typeof phys.GK_CLEAR_VZ_MIN === 'number' ? phys.GK_CLEAR_VZ_MIN : 6.5;
                const vzSpread = typeof phys.GK_CLEAR_VZ_SPREAD === 'number' ? phys.GK_CLEAR_VZ_SPREAD : 2.5;
                const vz = vzMin + Math.random() * vzSpread;
                return {
                    target,
                    speed,
                    vz,
                    teammate: tm
                };
            }
        }

        // Fallback: pick the first far teammate even if not perfectly safe on the ground plane (since it is kicked high)
        const tm = farTeammates[0];
        const target = { x: tm.x, y: tm.y };
        const speed = 12.0 + ((gk.stats.goalkeeping || 65) / 100) * 4.0;
        const phys = (Settings && Settings.physics) || {};
        const vzMin = typeof phys.GK_CLEAR_VZ_MIN === 'number' ? phys.GK_CLEAR_VZ_MIN : 6.5;
        const vzSpread = typeof phys.GK_CLEAR_VZ_SPREAD === 'number' ? phys.GK_CLEAR_VZ_SPREAD : 2.5;
        const vz = vzMin + Math.random() * vzSpread;
        return {
            target,
            speed,
            vz,
            teammate: tm
        };
    }

    // 3. Absolute Fallback: random midfield area clearance
    const defendsLeft = gkDefendsLeftGoal(level, gk);
    const target = defendsLeft ? {
        x: Utils.scaleFieldX(43.75 + Math.random() * 31.25),
        y: Utils.scaleFieldY(20 + Math.random() * 60)
    } : {
        x: Utils.scaleFieldX(25 + Math.random() * 31.25),
        y: Utils.scaleFieldY(20 + Math.random() * 60)
    };
    const speed = 11.0 + ((gk.stats.goalkeeping || 65) / 100) * 3;
    const vz = 1.2 + Math.random() * 1.2;
    return {
        target,
        speed,
        vz,
        teammate: null
    };
}

function grantGkPossession(gk, ball, options = {}) {
    const hold = options.holdDuration ?? ai(gk).GK_HOLD_DURATION;
    const claim = options.claimDuration ?? ai(gk).GK_CLAIM_DURATION;
    gk.gkHoldTimer = hold;
    gk.gkClaimTimer = claim;
    gk.gkHoldY = Math.max(Utils.scaleFieldY(40), Math.min(Utils.scaleFieldY(60), gk.y));
    gk.orientation = gkFacesIntoField(gk);
    gk.fsm.changeState(PlayerStates.Goalkeeper);
    if (ball) {
        ball.owner = gk;
        ball.vx = 0;
        ball.vy = 0;
        ball.vz = 0;
        ball.z = 0;
        ball.offsideReceiver = null;
        ball.offsideLineX = null;
        clearIfkOnTouch(ball, gk);
    }
}

function canTackleOwner(owner) {
    if (!owner) return true;
    if (isGkProtected(owner)) return false;
    if (owner.level && owner.level.setPieceType) return false;
    return true;
}

/**
 * Possession speed: slower with the ball, full speed without.
 * Combined with stamina via Player.moveTo / effectiveSpeed path.
 * @param {object} player
 * @returns {number} multiplier on top speed (typically ~0.78–1.0)
 */
function globalPossessionSpeedMul(player) {
    const ball = player && player.level && player.level.ball;
    const hasBall = !!(ball && ball.owner === player);
    const phys = (Settings && Settings.physics) || {};
    if (hasBall) {
        const fromAi = ai(player).PLAYER_SPEED_WITH_BALL;
        if (typeof fromAi === 'number') return fromAi;
        if (typeof phys.PLAYER_SPEED_WITH_BALL === 'number') return phys.PLAYER_SPEED_WITH_BALL;
        return Settings.AI.PLAYER_SPEED_WITH_BALL || 0.74;
    }
    const fromAi = ai(player).PLAYER_SPEED_WITHOUT_BALL;
    if (typeof fromAi === 'number') return fromAi;
    if (typeof phys.PLAYER_SPEED_WITHOUT_BALL === 'number') return phys.PLAYER_SPEED_WITHOUT_BALL;
    return Settings.AI.PLAYER_SPEED_WITHOUT_BALL || 1.0;
}

/**
 * Global per-tick player bookkeeping (possession speed mul, kick gates, etc.).
 * Caches possession speed mul for moveTo; does not replace state execute.
 * @param {object} player
 */
function applyGlobalPlayerState(player) {
    if (!player || player.isSentOff) return;
    player._possessionSpeedMul = globalPossessionSpeedMul(player);
}

/**
 * Roll foul chance for a tackle outcome (fail or dirty body success).
 * @returns {boolean} true if foul was triggered
 */
function maybeTriggerTackleFoul(tackler, opponent, tackleType, a, opts = {}) {
    const level = tackler && tackler.level;
    if (!level || typeof level.triggerFoul !== 'function') return false;

    let foulChance = 0;
    if (opts.forceChance != null) {
        foulChance = opts.forceChance;
    } else if (tackleType === 'slide') {
        foulChance = typeof a.SLIDE_FOUL_CHANCE === 'number' ? a.SLIDE_FOUL_CHANCE : 0.14;
    } else if (tackleType === 'body') {
        foulChance = typeof a.BODY_FOUL_CHANCE === 'number' ? a.BODY_FOUL_CHANCE : 0.40;
    } else if (tackleType === 'foot') {
        foulChance = typeof a.FOOT_FOUL_CHANCE === 'number' ? a.FOOT_FOUL_CHANCE : 0.03;
    }

    if (tackler.traits && tackler.traits.includes('Hard Tackler')) {
        foulChance = Math.min(0.55, foulChance * 1.35);
    }

    const strictness = (typeof Settings.REFEREE_STRICTNESS === 'number')
        ? Settings.REFEREE_STRICTNESS
        : 0.5;
    foulChance *= 0.6 + strictness * 0.8;
    foulChance *= humanFoulMultiplier(tackler, tackleType);

    // Body shoves may sit above the old 0.4 cap — still clamped
    const maxFoul = tackleType === 'body' ? 0.55 : 0.4;
    foulChance = Math.max(0.01, Math.min(maxFoul, foulChance));

    if (Math.random() < foulChance) {
        level.triggerFoul(tackler, opponent, { tackleType });
        return true;
    }
    return false;
}

function attemptTackle(tackler, ball, tackleType) {
    const opponent = ball.owner;
    if (!opponent || opponent.team === tackler.team) return false;
    if (!canTackleOwner(opponent)) return false;

    // Prevent tackle spam: only one roll per cooldown window
    if (tackler.tackleAttemptCooldown > 0) return false;

    const type = tackleType || 'foot';
    const a = ai(tackler);
    const cooldown = typeof a.TACKLE_ATTEMPT_COOLDOWN === 'number' ? a.TACKLE_ATTEMPT_COOLDOWN : 0.55;
    tackler.tackleAttemptCooldown = Math.max(0.2, cooldown);
    // Slightly longer cooldown after body (dirty challenge wind-down)
    if (type === 'body') {
        tackler.tackleAttemptCooldown = Math.max(tackler.tackleAttemptCooldown, cooldown * 1.15);
    }

    const success = Math.random() < computeTackleSuccess(tackler, opponent, type);
    const recovery = tackleRecoveryFor(tackler, type);
    const level = tackler.level;
    if (level && level._telemetry && typeof level._telemetry.onTackleAttempt === 'function') {
        level._telemetry.onTackleAttempt({ tackler, opponent, tackleType: type, success });
    }

    if (success) {
        // C.3 Press success check: successful tackle in the opponent's half
        const field = Utils.getFieldBounds();
        const attacksRight = attacksRightGoal(tackler.level, tackler.team);
        const inOpponentHalf = attacksRight ? (tackler.x > field.centerX) : (tackler.x < field.centerX);
        if (inOpponentHalf) {
            if (tackler.team === 'A') {
                if (tackler.level) tackler.level.pressSuccessesA++;
            } else {
                if (tackler.level) tackler.level.pressSuccessesB++;
            }
            if (tackler.level && tackler.level._telemetry && typeof tackler.level._telemetry.onPressSuccess === 'function') {
                tackler.level._telemetry.onPressSuccess({ team: tackler.team });
            }
        }

        // Body shove: knockdown always; claim is probabilistic (else loose ball)
        if (type === 'body') {
            const claimP = typeof a.BODY_CLAIM_ON_SUCCESS === 'number' ? a.BODY_CLAIM_ON_SUCCESS : 0.55;
            const claim = Math.random() < claimP;
            applyActionLock(opponent, recovery * 1.15);
            opponent.fsm.changeState(PlayerStates.Idle);

            // Separation nudge so bodies do not stack
            const dx = opponent.x - tackler.x;
            const dy = opponent.y - tackler.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            opponent.x += (dx / d) * 0.35;
            opponent.y += (dy / d) * 0.35;

            if (claim) {
                ball.owner = tackler;
                SoundDB.play('tackle');
                tackler.fsm.changeState(PlayerStates.Dribble);
            } else {
                ball.owner = null;
                // Soft spill along contact normal
                ball.vx = (dx / d) * 2.2 + (tackler.vx || 0) * 0.15;
                ball.vy = (dy / d) * 2.2 + (tackler.vy || 0) * 0.15;
                ball.vz = 0.4;
                ball.z = Math.max(ball.z || 0, 0.05);
                SoundDB.play('tackle');
                applyActionLock(tackler, recovery * 0.55);
                tackler.fsm.changeState(PlayerStates.Idle);
            }

            // Dirty win still risks a foul (body identity)
            const dirtyP = typeof a.BODY_SUCCESS_FOUL_CHANCE === 'number'
                ? a.BODY_SUCCESS_FOUL_CHANCE
                : 0.14;
            if (maybeTriggerTackleFoul(tackler, opponent, type, a, { forceChance: dirtyP })) {
                return false;
            }
            return true;
        }

        ball.owner = tackler;
        SoundDB.play('tackle');
        tackler.fsm.changeState(PlayerStates.Dribble);
        applyActionLock(opponent, recovery);
        opponent.fsm.changeState(PlayerStates.Idle);
        return true;
    }

    // Failed tackle → possible foul (slides / body much more likely than feet)
    if (maybeTriggerTackleFoul(tackler, opponent, type, a)) {
        return false;
    }

    applyActionLock(tackler, recovery);
    tackler.fsm.changeState(PlayerStates.Idle);
    return false;
}

// Player AI States for FSM — outfield + GK modules (composition)
initPlayerStates({
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
    getComfortZoneRadii,
    isThreatened,
    getThreatInfo,
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
});


class Player extends GameObject {
    constructor(name, team, role, stats) {
        super(name);
        this.team = team;
        this.role = role;
        this.stats = stats;
        this.traits = stats.traits || [];
        this.baseX = 0;
        this.baseY = 0;
        /** Authored formation home (world); region shifts adjust baseX/Y only */
        this.formationBaseX = 0;
        this.formationBaseY = 0;
        this.defaultRegionId = null;
        this.homeRegionId = null;
        this.regionFineOffsetX = 0;
        this.regionFineOffsetY = 0;
        this.currentStamina = 1.0;

        this.frame = 0;
        this.frameTimer = 0;
        this.isActivePlayer = false;
        /** Set each logic tick by manual_control when this avatar is human-driven */
        this.humanControlled = false;
        /** @type {{ moveX: number, moveY: number, sprint?: boolean }|null} */
        this._humanInput = null;
        /**
         * Stage 4 manual header payload (short/long/shot). Consumed on Header contact.
         * @type {{ kind?: string, power?: number, speed?: number, vz?: number, aimDir?: object, curveForce?: number }|null}
         */
        this.humanHeader = null;

        this.passTarget = null;
        this.passType = 'short';
        /** @type {{ x: number, y: number }|null} lead-pass aim (space); null → aim at passTarget feet */
        this.passAim = null;
        /** @type {{ x: number, y: number }|null} CanShoot sample on goal mouth */
        this.shotAim = null;
        /** @type {{ x: number, y: number }|null} Msg_ReceiveBall aim */
        this.receiveTarget = null;
        this.receiveTimer = 0;
        /** @type {{ x: number, y: number }|null} SupportAttacker / GoHome targets */
        this.supportTarget = null;
        this.homeTarget = null;
        /** @type {object|null} A.2 free-attacker mark target (player ref) */
        this.markTarget = null;
        /** @type {{ x: number, y: number }|null} A.2 cover interpose point */
        this.markCoverPoint = null;
        this.passRequestCooldown = 0;
        this.gkHoldTimer = 0;
        this.gkClaimTimer = 0;
        this.kickerClaimCooldown = 0;
        this.passFollowSuppress = 0;
        this.gkHoldY = null;
        this.gkReleaseCooldown = 0;
        this.actionTimer = 0;
        this.kickTimer = 0;
        this.kickDecisionCooldown = 0;
        this.dribbleTarget = { x: 0, y: 0 };
        this.dribbleTargetTimer = 0;
        this.isSliding = false;
        this.slideTarget = { x: 0, y: 0 };
        /** Fixed launch direction for Stage 3 directional slides (unit or null) */
        this.slideDir = null;
        this.slideTimer = 0;
        /** Logic seconds until next tackle roll allowed */
        this.tackleAttemptCooldown = 0;
        this.lastPassFrom = null;
        this.passLinkCooldown = 0;
        this.yellowCards = 0;
        this.isSentOff = false;

        this.headerTimer = 0;
        this.isHeading = false;
        this.gkDiveTimer = 0;
        this.gkDiveTarget = null;

        this.isWalkingToSetPiece = false;
        this.setPieceTarget = null;

        this.fsm = new StateMachine(this);
    }

    get staminaMultiplier() {
        return this.currentStamina || 1.0;
    }

    get jersey() {
        if (this.stats && this.stats.jersey !== undefined) {
            return this.stats.jersey;
        }
        const parts = this.name.split(' ');
        const num = parseInt(parts[parts.length - 1], 10);
        return isNaN(num) ? 1 : num;
    }

    getSpriteSheet() {
        if (this._cachedSpriteSheet) return this._cachedSpriteSheet;
        if (!this.level) return null;
        const teamName = this.team === 'A' ? this.level.teamAName : this.level.teamBName;
        const jerseyKey = `player_${teamName}_jersey_${this.jersey}`;
        const fallbackKey = `player_${teamName}_${this.role === 'GK' ? 'gk' : 'main'}`;
        const sheet = ImageDB.get(jerseyKey) || ImageDB.get(fallbackKey);
        if (sheet) {
            this._cachedSpriteSheet = sheet;
        }
        return sheet;
    }

    get effectiveSpeed() {
        return (this.stats.speed || 60) * this.staminaMultiplier;
    }

    get effectivePassing() {
        return (this.stats.passing || 70) * this.staminaMultiplier;
    }

    get effectiveShooting() {
        return (this.stats.shooting || 65) * this.staminaMultiplier;
    }

    get effectiveAccuracy() {
        return (this.stats.accuracy || 70) * this.staminaMultiplier;
    }

    start() {
        this.frame = 0;
        this.frameTimer = 0;
        this.isActivePlayer = false;
        this.humanControlled = false;
        this._humanInput = null;
        this.passTarget = null;
        this.passType = 'short';
        this.passAim = null;
        this.shotAim = null;
        this.receiveTarget = null;
        this.receiveTimer = 0;
        this.supportTarget = null;
        this.homeTarget = null;
        this.passRequestCooldown = 0;
        this.gkHoldTimer = 0;
        this.gkClaimTimer = 0;
        this.kickerClaimCooldown = 0;
        this.passFollowSuppress = 0;
        this.gkHoldY = null;
        this.gkReleaseCooldown = 0;
        this.actionTimer = 0;
        this.kickTimer = 0;
        this.kickDecisionCooldown = 0;
        this.isSliding = false;
        this.slideTimer = 0;
        this.slideDir = null;
        this.tackleAttemptCooldown = 0;
        this.lastPassFrom = null;
        this.passLinkCooldown = 0;
        this.yellowCards = 0;
        this.isSentOff = false;
        this.currentStamina = 1.0;
        this.traits = this.stats.traits || [];
        this.level = this.getRoot();

        if (this.role === 'GK') {
            this.fsm.setCurrentState(PlayerStates.Goalkeeper);
        } else {
            this.fsm.setCurrentState(PlayerStates.Idle);
        }
    }

    /**
     * Handle SoccerMsg telegrams (ReceiveBall, PassToMe, Support, Wait, GoHome).
     * @param {object} telegram - { type|msg, sender, extra }
     */
    handleSoccerMessage(telegram) {
        if (!telegram || this.isSentOff) return false;
        const type = telegram.type || telegram.msg;
        const extra = telegram.extra || {};

        switch (type) {
            case SoccerMsg.ReceiveBall: {
                if (this.role === 'GK') return false;
                const target = extra.target || null;
                this.fsm.changeState(PlayerStates.Receive, { target, extra });
                return true;
            }
            case SoccerMsg.SupportAttacker: {
                if (this.role === 'GK') return false;
                if (this.fsm.isInState(PlayerStates.SupportAttacker)) {
                    if (extra.target) {
                        this.supportTarget = { x: extra.target.x, y: extra.target.y };
                    }
                    return true;
                }
                // Don't interrupt Pass/Shoot/Receive
                const name = this.fsm.getNameOfCurrentState();
                if (name === 'Pass' || name === 'Shoot' || name === 'Receive') return false;
                this.fsm.changeState(PlayerStates.SupportAttacker, { target: extra.target, extra });
                return true;
            }
            case SoccerMsg.Wait: {
                if (this.role === 'GK') return false;
                const name = this.fsm.getNameOfCurrentState();
                if (name === 'Pass' || name === 'Shoot') return false;
                this.fsm.changeState(PlayerStates.Wait);
                return true;
            }
            case SoccerMsg.GoHome: {
                if (this.role === 'GK') return false;
                const target = extra.target || { x: this.baseX, y: this.baseY };
                const name = this.fsm.getNameOfCurrentState();
                if (name === 'Pass' || name === 'Shoot') return false;
                // During dead-ball, reuse set-piece walk path (fsm does not run while matchState !== play)
                if (this.level && this.level.matchState && this.level.matchState !== 'play') {
                    this.homeTarget = { x: target.x, y: target.y };
                    this.setPieceTarget = { x: target.x, y: target.y };
                    this.isWalkingToSetPiece = true;
                    this.fsm.setCurrentState(PlayerStates.GoHome);
                    return true;
                }
                this.fsm.changeState(PlayerStates.GoHome, { target, extra });
                return true;
            }
            case SoccerMsg.PassToMe: {
                // Controller honors RequestPass only with ball + safe aim
                const ball = this.level && this.level.ball;
                if (!ball || ball.owner !== this) return true;
                // Manual Stage 1: human carrier never auto-passes on teammate call
                if (this.humanControlled) return true;
                const requester = extra.requester;
                if (!requester || requester.isSentOff || requester === this) return true;
                if (requester.team !== this.team) return true;
                const team = getTeamEntity(this);
                if (team && team.receivingPlayer) return true; // pass already in flight
                // Must be free to pass (not mid-kick animation)
                const name = this.fsm.getNameOfCurrentState();
                if (name === 'Pass' || name === 'Shoot' || name === 'Header') return true;

                const d = dist2d(this.x, this.y, requester.x, requester.y);
                const maxDist = ai(this).LONG_PASS_MAX_DIST || 22;
                const minDist = ai(this).SHORT_PASS_MIN_DIST !== undefined
                    ? ai(this).SHORT_PASS_MIN_DIST
                    : 3.6;
                if (d > maxDist || d < minDist) return true;

                const passType = extra.passType
                    || (d > (ai(this).LONG_PASS_MIN_DIST || 9) ? 'long' : 'short');

                // Prefer Team lead+safety aim; reject if no safe aim exists
                let aim = null;
                if (team && typeof team.getBestPassToReceiver === 'function') {
                    aim = team.getBestPassToReceiver(this, requester, { passType });
                }
                if (!aim) {
                    // Fallback: feet only if lane still safe
                    const from = { x: this.x, y: this.y };
                    const to = { x: requester.x, y: requester.y };
                    const speed = estimatePassGroundSpeed(from, to, this, passType);
                    if (isPassSafeFromAllOpponents(from, to, requester, team
                        ? team.getOpponentPool()
                        : (this.level.players || []).filter(o => o.team !== this.team), speed)) {
                        aim = extra.aimHint || to;
                    }
                }
                if (!aim) return true;

                this.passTarget = requester;
                this.passType = passType;
                this.passAim = aim;
                this.fsm.changeState(PlayerStates.Pass);
                return true;
            }
            default:
                return false;
        }
    }

    async onMessage(message) {
        if (message && (message.type || message.msg)) {
            this.handleSoccerMessage(message);
        }
    }

    /**
     * L1–L3 formation target (A.1 stack): region home (base*) + depth + FORMATION_HOLD ball shift.
     * Region re-home is already applied to baseX/Y by Team.applyHomeRegions.
     */
    getTargetFormationPos() {
        const ball = this.level && this.level.ball;
        const team = this.getTeam();
        // Protected GK possession: L3 without ball pull
        const skipBall = ball && ball.owner && ball.owner.role === 'GK' && isGkProtected(ball.owner);
        const layer = layerDepthHold(this, team, skipBall ? null : ball);
        return { x: layer.x, y: layer.y };
    }

    /**
     * Out-of-possession idle target: mid-block / role line relative to the ball.
     * Avoids every non-chaser collapsing onto a flat deep line at the own end
     * (formation hold + old 50% goal compress stacked too hard).
     */
    getDefensiveShapePos() {
        const form = this.getTargetFormationPos();
        const ball = this.level.ball;
        if (!ball || !ball.owner || ball.owner.team === this.team) return form;

        const carrier = ball.owner;
        const level = this.level;
        const field = Utils.getFieldBounds();
        const ownGoalX = defendingGoalX(level, this.team);
        const inDanger = isCarrierInDangerZone(carrier, this.team, level);
        const press = ai(this).DEFENSIVE_PRESS_INTENSITY;

        // How far between ball and own goal this role sits (0 ≈ level with ball, 1 ≈ goal line)
        let retreatFrac = 0.18;
        const role = this.role || '';
        if (/CB|LCB|RCB/i.test(role)) retreatFrac = 0.34;
        else if (/LB|RB|LWB|RWB|DM|CDM/i.test(role)) retreatFrac = 0.28;
        else if (/CM|LCM|RCM|LM|RM/i.test(role)) retreatFrac = 0.18;
        else if (/AM|CAM|LW|RW|WF|W/i.test(role)) retreatFrac = 0.11;
        else if (/S|ST|CF|SS|F/i.test(role)) retreatFrac = 0.08;

        // Higher line when ball is not in our defensive danger zone; high press reduces retreat
        if (!inDanger) retreatFrac *= 0.5;
        retreatFrac *= 1.15 - Math.min(0.55, press * 0.7);
        // A.4: non-surge during counterpress — delay deep drop (hold higher mid-block)
        const teamEnt = getTeamEntity(this);
        if (
            teamEnt
            && typeof teamEnt.isCounterpressing === 'function'
            && teamEnt.isCounterpressing()
            && typeof teamEnt.isCounterpressSurge === 'function'
            && !teamEnt.isCounterpressSurge(this)
        ) {
            const rScale = typeof ai(this).COUNTERPRESS_DELAY_RETREAT_SCALE === 'number'
                ? ai(this).COUNTERPRESS_DELAY_RETREAT_SCALE
                : 0.45;
            retreatFrac *= rScale;
        }
        retreatFrac = Math.max(0.05, Math.min(0.48, retreatFrac));

        // Role line: between carrier and own goal (keeps a staggered unit, not one flat deep bar)
        const lineX = carrier.x + (ownGoalX - carrier.x) * retreatFrac;
        // Keep lateral structure from formation; only mild ball pull (prevents all packing one Y)
        const lineY = form.y * 0.72 + carrier.y * 0.18 + field.centerY * 0.10;

        const aheadDelta = getAheadDelta(this, carrier, level);
        let baseBlend = aheadDelta > 0
            ? ai(this).DEFENSIVE_COMPRESS_BLEND
            : ai(this).DEFENSIVE_RECOVERY_BLEND;
        let blend = effectiveDefensiveBlend(baseBlend, this);
        // Outside danger: hold shape more; inside: compress but leave room for mid-block
        blend *= inDanger ? 0.95 : 0.55;
        blend = Math.max(0.08, Math.min(0.72, blend));

        let targetX = form.x * (1 - blend) + lineX * blend;
        let targetY = form.y * (1 - blend) + lineY * blend;

        // Beaten (behind play): recover toward the line, not a single point behind the carrier
        if (aheadDelta <= 0) {
            const recoverBlend = Math.min(0.55, effectiveDefensiveBlend(ai(this).DEFENSIVE_RECOVERY_BLEND, this) * 0.85);
            targetX = form.x * (1 - recoverBlend) + lineX * recoverBlend;
            targetY = form.y * (1 - recoverBlend) + lineY * recoverBlend;
        }

        // Depth cap: don't sit deeper than a soft "box line" unless the ball is in danger
        // Own goal on the left (x≈0): floor on X; own goal on the right: ceiling on X
        const boxRef = Utils.scaleFieldX(inDanger ? 14 : 22);
        if (ownGoalX < field.centerX) {
            targetX = Math.max(targetX, boxRef);
        } else {
            targetX = Math.min(targetX, field.width - boxRef);
        }

        // Never deeper than own goal side of the ball by more than a role max (stops bus parking
        // while the ball is still in midfield)
        const maxBehindBall = Utils.scaleFieldX(
            /CB|LCB|RCB|LB|RB|DM|CDM/i.test(role) ? (inDanger ? 16 : 12) : (inDanger ? 12 : 8)
        );
        if (ownGoalX < field.centerX) {
            // own goal left: deeper = smaller x; min X is ball.x - maxBehind toward goal
            const floorX = Math.max(boxRef, carrier.x - maxBehindBall);
            // only apply floor when it is still on our half of the ball→goal segment
            if (floorX < carrier.x) targetX = Math.max(targetX, floorX);
        } else {
            const ceilX = Math.min(field.width - boxRef, carrier.x + maxBehindBall);
            if (ceilX > carrier.x) targetX = Math.min(targetX, ceilX);
        }

        const margin = 0.5 * field.multiplier;
        return {
            x: Math.max(margin, Math.min(field.width - margin, targetX)),
            y: Math.max(margin, Math.min(field.height - margin, targetY))
        };
    }

    /**
     * Idle / shape target via A.1 positioning stack (see positioning_policy.js).
     * Optional debug: Settings.debugAI.positionTrace → player._positionTrace.
     * Always recomputes (no cadence cache); hot path skips layer samples unless tracing.
     */
    getIdleMoveTarget() {
        const wantTrace = isPositionTraceEnabled();
        const result = resolveIdleMoveTarget(this, {
            getTeam: (p) => (p.getTeam ? p.getTeam() : getTeamEntity(p)),
            isGkProtected,
            isCarrierInAttackingHalf,
            computeAttackSupportTarget,
            computeLooseBallInterceptTarget,
            getDefensiveShapePos: () => this.getDefensiveShapePos(),
            ai,
            dist2d,
            // Hot path: skip layer sample allocations unless debug overlay is on
            trace: wantTrace
        });
        if (wantTrace) {
            attachPositionTrace(this, result);
        }
        return { x: result.x, y: result.y };
    }

    /**
     * Full idle resolve with layer trace (for tests / debug UI).
     * @returns {import('../lib/positioning_policy.js').PositionResolveResult}
     */
    resolveIdlePosition() {
        const result = resolveIdleMoveTarget(this, {
            getTeam: (p) => (p.getTeam ? p.getTeam() : getTeamEntity(p)),
            isGkProtected,
            isCarrierInAttackingHalf,
            computeAttackSupportTarget,
            computeLooseBallInterceptTarget,
            getDefensiveShapePos: () => this.getDefensiveShapePos(),
            ai,
            dist2d,
            trace: true
        });
        attachPositionTrace(this, result);
        return result;
    }

    /**
     * Move toward a world point using optional steering behaviors.
     *
     * @param {{ x: number, y: number }} target
     * @param {number} [speedMultiplier=1]
     * @param {{
     *   arrive?: boolean,
     *   separate?: boolean,
     *   neighbors?: Array,
     *   deceleration?: number,
     *   arriveRadius?: number
     * }} [steerOpts] - when omitted: seek at full speed (backward compatible)
     */
    moveTo(target, speedMultiplier = 1, steerOpts = null) {
        if (!target) return;

        let aimX = target.x;
        let aimY = target.y;
        let speedScale = 1;

        // Compose arrive / separation when requested (Idle, support, set-piece, GK tend)
        if (steerOpts && (steerOpts.arrive || steerOpts.separate)) {
            let neighbors = steerOpts.neighbors;
            if (steerOpts.separate && !neighbors && this.level && this.level.players) {
                neighbors = collectNeighbors(this, this.level.players);
            }
            const steered = composeSteer(this, target, {
                arrive: !!steerOpts.arrive,
                separate: !!steerOpts.separate,
                neighbors: neighbors || [],
                deceleration: steerOpts.deceleration,
                arriveRadius: steerOpts.arriveRadius,
                viewDistance: steerOpts.viewDistance,
                sepMult: steerOpts.sepMult
            });
            aimX = steered.aim.x;
            aimY = steered.aim.y;
            speedScale = steered.speedScale;
            // Snap to true target when very close (arrive complete)
            if (steered.dist < 0.12 && steerOpts.arrive) {
                this.x = target.x;
                this.y = target.y;
                this._currentSpeed = 0;
                if (!this.isSliding) this.frame = 0;
                return;
            }
        }

        const dx = aimX - this.x;
        const dy = aimY - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 0.1) {
            // Settings.physics locomotion (m/s). Stamina only scales the stat bonus.
            const baseStats = this.stats.speed || 60;
            const phys = (Settings && Settings.physics) || {};
            const pBase = typeof phys.PLAYER_BASE_SPEED === 'number' ? phys.PLAYER_BASE_SPEED : 4.6;
            const pBonus = typeof phys.PLAYER_SPEED_STAT_BONUS === 'number' ? phys.PLAYER_SPEED_STAT_BONUS : 3.4;
            const aBase = typeof phys.PLAYER_ACCEL_BASE === 'number' ? phys.PLAYER_ACCEL_BASE : 10.0;
            const aBonus = typeof phys.PLAYER_ACCEL_STAT_BONUS === 'number' ? phys.PLAYER_ACCEL_STAT_BONUS : 8.0;
            const speedBonus = (baseStats / 100.0) * pBonus * this.staminaMultiplier;
            // GlobalPlayerState: with-ball slower than without
            const possessionMul = (typeof this._possessionSpeedMul === 'number')
                ? this._possessionSpeedMul
                : globalPossessionSpeedMul(this);
            const topSpeed = (pBase + speedBonus) * Settings.SPRITE_SPEED
                * speedMultiplier * speedScale * possessionMul;
            let acceleration = (aBase + (baseStats / 100.0) * aBonus * this.staminaMultiplier) * Settings.SPRITE_SPEED;

            // Goalkeepers have explosive reflex acceleration
            if (this.role === 'GK') {
                acceleration *= 3.0;
            }

            // Speed Demon trait: +10% acceleration
            if (this.traits && this.traits.includes('Speed Demon')) {
                acceleration *= 1.1;
            }

            if (!this._currentSpeed) this._currentSpeed = 0;
            this._currentSpeed = Math.min(topSpeed, this._currentSpeed + acceleration * Time.deltaTime);

            // Drain stamina over time based on movement velocity and stamina rating.
            // Minimum clamped to 0.25 so effectiveSpeed always stays meaningful.
            const drainRate = Math.max(0.00002, 0.00016 - (this.stats.stamina || 80) * 0.0000014);
            const staminaDrain = drainRate * speedMultiplier * speedMultiplier * Time.deltaTime;
            this.currentStamina = Math.max(0.25, this.currentStamina - staminaDrain);

            const speed = this._currentSpeed;
            const moveStep = speed * Time.deltaTime;
            // Distance to *true* target for snap (not steered aim)
            const trueDx = target.x - this.x;
            const trueDy = target.y - this.y;
            const trueDist = Math.sqrt(trueDx * trueDx + trueDy * trueDy);
            if (moveStep >= trueDist && speedScale < 0.5) {
                this.x = target.x;
                this.y = target.y;
                this.frame = this.isSliding ? 4 : 0;
                this._currentSpeed = 0;
            } else if (moveStep >= dist) {
                this.x = aimX;
                this.y = aimY;
                this.frame = this.isSliding ? 4 : 0;
                this._currentSpeed = Math.max(0, this._currentSpeed * 0.5);
            } else {
                this.x += (dx / dist) * moveStep;
                this.y += (dy / dist) * moveStep;

                this.frameTimer += Time.deltaTime;
                if (this.isSliding) {
                    this.frame = 4;
                } else if (this.frameTimer > 0.15) {
                    this.frameTimer = 0;
                    this.frame = this.frame === 1 ? 2 : 1;
                }
            }

            // 8-direction orientation from movement angle
            const angle = Math.atan2(dy, dx); // -PI to PI
            // Map angle to 8 sectors: 0=UP, 1=UP_RIGHT, 2=RIGHT, ..., 7=UP_LEFT
            // atan2 returns: 0=right, PI/2=down, -PI/2=up, +-PI=left
            // Convert to 0-7 index with RIGHT=2 at angle 0
            const sector = Math.round(angle / (Math.PI / 4));
            // sector: 0=RIGHT, 1=DOWN_RIGHT, 2=DOWN, 3=DOWN_LEFT, -1=UP_RIGHT, -2=UP, -3=UP_LEFT, +-4=LEFT
            const DIR_FROM_SECTOR = { 0: 2, 1: 3, 2: 4, 3: 5, 4: 6, '-1': 1, '-2': 0, '-3': 7, '-4': 6 };
            this.orientation = DIR_FROM_SECTOR[sector];
        } else {
            this._currentSpeed = 0;
            if (!this.isSliding) this.frame = 0;

            // Stand still: recover stamina very slowly
            const recoveryRate = 0.00002 + (this.stats.stamina || 80) * 0.0000004;
            this.currentStamina = Math.min(1.0, this.currentStamina + recoveryRate * Time.deltaTime);
        }
    }

    /** Squad Team parent when hierarchy is wired (Pitch → Team → Player). */
    getTeam() {
        return getTeamEntity(this);
    }

    findBestPassTeammate() {
        const result = this.findBestPassTarget();
        return result ? result.teammate : null;
    }

    /** Delegates to Team.findBestPassTarget when parented under a Team. */
    findBestPassTarget(opts = {}) {
        const team = this.getTeam();
        if (team && typeof team.findBestPassTarget === 'function') {
            return team.findBestPassTarget(this, opts);
        }
        // Fallback for unit tests that construct bare Players without a Team
        const teammates = this.level.players.filter(p => p !== this && p.team === this.team && p.role !== 'GK' && !p.isSentOff);
        const opponents = this.level.players.filter(p => p.team !== this.team && !p.isSentOff);
        const from = { x: this.x, y: this.y };
        const field = Utils.getFieldBounds();
        const oppGoalX = attacksRightGoal(this.level, this.team) ? field.width : 0;
        let bestShort = null;
        let bestLong = null;
        let bestShortScore = -Infinity;
        let bestLongScore = -Infinity;

        const passTypeOverride = opts.passType;
        for (const teammate of teammates) {
            if (teammate === this.lastPassFrom && this.passLinkCooldown > 0) continue;
            if (!isPassReceiverAhead(this, teammate, this.level)) continue;

            const support = getPassReceiverPosition(teammate, this, this.level);
            const dx = support.x - this.x;
            const dy = support.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > ai(this).LONG_PASS_MAX_DIST) continue;

            const open = isTeammateOpen(this.level, teammate, 3.2);
            let passType = passTypeOverride;
            if (passType) {
                if (passType === 'short' && dist > ai(this).LONG_PASS_MAX_DIST * 0.45) continue;
                if (passType === 'long' && dist < (ai(this).SHORT_PASS_MIN_DIST || 3.6) * 1.5) continue;
            } else {
                passType = choosePassType(dist, open, this);
            }
            if (!passType) continue;

            const aim = getBestPassToReceiver(from, teammate, this, opponents, {
                passType,
                oppGoalX,
                supportPoint: support
            });
            if (!aim) continue;

            const aimDist = Math.sqrt(Math.pow(aim.x - this.x, 2) + Math.pow(aim.y - this.y, 2));
            const score = scorePassTarget(this, teammate, aimDist, open);
            if (score < 5) continue;

            const decision = { teammate, type: passType, aim };
            if (passType === 'short' && score > bestShortScore) {
                bestShortScore = score;
                bestShort = decision;
            }
            if (passType === 'long' && score > bestLongScore) {
                bestLongScore = score;
                bestLong = decision;
            }
        }

        if (bestLongScore > 6) return bestLong;
        if (bestShortScore > 4) return bestShort;
        return null;
    }

    update() {
        if (this.isSentOff) return;
        if (this.tackleAttemptCooldown > 0) {
            this.tackleAttemptCooldown -= Time.deltaTime;
            if (this.tackleAttemptCooldown < 0) this.tackleAttemptCooldown = 0;
        }
        if (this.gkClaimTimer > 0) {
            this.gkClaimTimer -= Time.deltaTime;
        }
        // Kick claim + decision cooldowns (logic seconds; independent of TIME_SPEED)
        tickPlayerKickGates(this, Time.deltaTime);

        // Global possession speed mul, etc. every logic tick
        applyGlobalPlayerState(this);

        if (this.level && this.level.matchState && this.level.matchState !== 'play') {
            if (this.level.matchState === 'goal' && this.team === this.level.goalScoredTeam) {
                const bounce = Math.abs(Math.sin(this.level.currentFrameCount * 0.75)) * 0.8;
                this.z = bounce;

                // Deterministic rotation (no Math.random to avoid advancing the seeded PRNG state during celebration)
                const nameHash = (this.name || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
                const interval = 15 + (nameHash % 10);
                if (this.level.currentFrameCount % interval === 0) {
                    this.orientation = (nameHash + Math.floor(this.level.currentFrameCount / interval)) % 8;
                }

                this.frameTimer += Time.deltaTime;
                if (this.frameTimer > 0.1) {
                    this.frameTimer = 0;
                    this.frame = (this.frame === 12) ? 13 : 12;
                }

                this.vx = 0;
                this.vy = 0;
                this.vz = 0;
                return;
            } else if (this.level.matchState === 'fulltime') {
                let winningTeam = null;
                if (this.level.scoreA > this.level.scoreB) {
                    winningTeam = 'A';
                } else if (this.level.scoreB > this.level.scoreA) {
                    winningTeam = 'B';
                }

                if (winningTeam && this.team === winningTeam) {
                    const bounce = Math.abs(Math.sin(this.level.currentFrameCount * 0.75)) * 0.8;
                    this.z = bounce;

                    // Deterministic rotation (no Math.random to avoid advancing the seeded PRNG state during celebration)
                    const nameHash = (this.name || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
                    const interval = 15 + (nameHash % 10);
                    if (this.level.currentFrameCount % interval === 0) {
                        this.orientation = (nameHash + Math.floor(this.level.currentFrameCount / interval)) % 8;
                    }

                    this.frameTimer += Time.deltaTime;
                    if (this.frameTimer > 0.1) {
                        this.frameTimer = 0;
                        this.frame = (this.frame === 12) ? 13 : 12;
                    }

                    this.vx = 0;
                    this.vy = 0;
                    this.vz = 0;
                    return;
                } else {
                    this.frame = 0;
                    this.vx = 0;
                    this.vy = 0;
                    this.vz = 0;
                    this.z = 0;
                    return;
                }
            } else if (this.actionTimer > 0) {
                this.actionTimer -= Time.deltaTime;
                this.frameTimer += Time.deltaTime;
                if (this.frameTimer > 0.15) {
                    this.frameTimer = 0;
                    this.frame = (this.frame === 5) ? 6 : 5;
                }
                this.vx = 0;
                this.vy = 0;
                this.vz = 0;
                this.z = 0;
                return;
            } else if (this.isWalkingToSetPiece && this.setPieceTarget) {
                const dx = this.setPieceTarget.x - this.x;
                const dy = this.setPieceTarget.y - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 0.15) {
                    // Set-piece walk: arrive + separation so wall/formation doesn't clump
                    this.moveTo(this.setPieceTarget, 0.85, { arrive: true, separate: true, deceleration: 2 });
                } else {
                    this.x = this.setPieceTarget.x;
                    this.y = this.setPieceTarget.y;
                    this.vx = 0;
                    this.vy = 0;
                    this.frame = 0;
                    this.isWalkingToSetPiece = false;
                    this.setPieceTarget = null;
                    // A.6: snap wall hold anchor after walk-back arrives
                    if (this.isInWall) {
                        this.wallHoldX = this.x;
                        this.wallHoldY = this.y;
                    }
                }
                return;
            } else if (this.isInWall) {
                // A.6: freeze on wall line during freekick setup (non-play states)
                applyWallHold(this, { forceGround: true });
                return;
            } else if (this.gkDiveTimer > 0) {
                this.gkDiveTimer -= Time.deltaTime;
                if (this.gkDiveTimer > 0.35) {
                    this.frame = 7;
                    this.z = 0;
                } else {
                    this.frame = 8;
                    const progress = (0.35 - this.gkDiveTimer) / 0.35;
                    this.z = Math.sin(progress * Math.PI) * 0.8;
                }
                this.vx = 0;
                this.vy = 0;
                this.vz = 0;
                return;
            } else if (this.headerTimer > 0) {
                this.headerTimer -= Time.deltaTime;
                if (this.headerTimer > 0.45) {
                    this.frame = 9;
                    this.z = 0;
                } else if (this.headerTimer > 0.15) {
                    this.frame = 10;
                    const progress = (0.45 - this.headerTimer) / 0.3;
                    this.z = Math.sin(progress * Math.PI) * 1.2;
                } else {
                    this.frame = 11;
                    const progress = (0.15 - this.headerTimer) / 0.15;
                    this.z = (1.0 - progress) * 0.6;
                }
                this.vx = 0;
                this.vy = 0;
                this.vz = 0;
                return;
            } else {
                // Set-piece ready hold: taker shows throw/kick plant pose for reaction time
                if (
                    this.level
                    && this.level.setPieceReadyPhase
                    && this.level.ball
                    && this.level.ball.owner === this
                ) {
                    this.frame = this.level.setPieceType === 'throwin' ? 12 : 3;
                } else {
                    this.frame = 0;
                }
                this.vx = 0;
                this.vy = 0;
                this.vz = 0;
                this.z = 0;
                return;
            }
        }

        // A.6: wall holders stay on the line after freekick resumes into play
        // until Pass release or jump lands (updateWallJumps clears isInWall).
        if (applyWallHold(this)) {
            return;
        }

        this.fsm.update();

        // Clamp player to field boundaries to prevent walking freely along/outside the sidelines
        const field = Utils.getFieldBounds();
        const margin = 0.2 * field.multiplier;
        // Allow the throw-in taker to reach the sideline spot even if ball.owner is not yet assigned (ball stays put during walk).
        const isThrowInTaker = this.level && this.level.matchState === 'throwin' &&
          ( (this.level.ball && this.level.ball.owner === this) || this.isWalkingToSetPiece );

        if (this.role !== 'GK' && !isThrowInTaker) {
            this.x = Math.max(margin, Math.min(field.width - margin, this.x));
            this.y = Math.max(margin, Math.min(field.height - margin, this.y));
        }
    }

    preRender(g) {
        if (this.isActivePlayer || this.humanControlled) {
            const metrics = Utils.getSpriteDrawMetrics();
            const ground = Utils.toScreen(this.x, this.y, 0);
            const groundX = ground.x;
            const groundY = ground.y;

            const pulse = 0.6 + 0.2 * Math.sin((this.level && this.level.currentFrameCount || 0) * 0.5);
            // Human-controlled: stronger cyan/magenta ring; AI active marker stays team-coloured
            if (this.humanControlled) {
                g.strokeStyle = `rgba(255, 80, 220, ${0.75 + 0.25 * Math.sin((this.level && this.level.currentFrameCount || 0) * 0.35)})`;
                g.lineWidth = 8;
            } else {
                g.strokeStyle = this.team === 'A' ? `rgba(255, 255, 0, ${pulse})` : `rgba(0, 255, 255, ${pulse})`;
                g.lineWidth = 6;
            }

            const scale = this.humanControlled ? 1.15 : 1;

            g.beginPath();
            g.ellipse(
                groundX,
                groundY,
                (metrics.tileW * 0.5) * scale,
                (metrics.tileH * 0.1875) * scale,
                0, 0, Math.PI * 2
            );

            g.stroke();
        }
    }

    render(g) {
        if (this.isSentOff) return;
        const metrics = Utils.getSpriteDrawMetrics();
        const m = metrics.multiplier;
        const srcW = Settings.SPRITE_TILE_W;
        const srcH = Settings.SPRITE_TILE_H;

        const zVal = typeof this.z === 'number' ? this.z : 0;

        const screen = Utils.toScreen(this.x, this.y, zVal);


        const screenX = screen.x;
        const screenY = screen.y;

        const spriteSheet = this.getSpriteSheet();

        if (spriteSheet) {
            const sx = this.frame * srcW;
            const sy = this.orientation * srcH;
            g.drawImage(
                spriteSheet,
                sx, sy, srcW, srcH,
                Math.floor(screenX - metrics.anchorOffsetX),
                Math.floor(screenY - metrics.anchorOffsetY),
                metrics.tileW,
                metrics.tileH
            );
        }

        if (Settings.showFPS) {
            g.font = `bold ${Math.max(7, Math.round(7 * m))}px Monospace`;
            g.fillStyle = '#FFFFFF';
            g.shadowColor = '#000000';
            g.shadowBlur = 2 * m;
            g.textAlign = 'center';
            g.fillText(this.name, screenX, screenY - metrics.anchorOffsetY - 2 * m);
            g.shadowBlur = 0;
        }
    }
}

module.exports = {
    Player,
    ai,
    PlayerStates,
    isGoalkeeperRole,
    isOutfieldRole,
    getTeamEntity,
    globalPossessionSpeedMul,
    applyGlobalPlayerState,
    // Steering helpers re-exported for tests
    composeSteer,
    collectNeighbors,
    pursuitPoint,
    interposePoint,
    arriveSpeedScale,
    attacksRightGoal,
    getCarrierForwardSign,
    getAheadDelta,
    computePressPriority,
    canPressCarrier,
    isCarrierInDangerZone,
    defendingGoalX,
    effectiveDefensiveBlend,
    attackingGoalX,
    isCarrierInAttackingHalf,
    isAheadOfFormationLine,
    computeAttackSupportTarget,
    countOpenSupportRunners,
    computeDribblePassChance,
    getComfortZoneRadii,
    isThreatened,
    getThreatInfo,
    PositionLayer,
    POSITION_STACK_DOC,
    getShootRange,
    getPassReceiverPosition,
    isPassReceiverAhead,
    isDefensiveOutfieldRole,
    scorePassTarget,
    computeShootKick,
    estimatePlayerTopSpeed,
    longPassVzForDistance,
    computeTackleType,
    computeTackleSuccess,
    choosePassType,
    computeDribbleTarget,
    computeChaseInterceptTarget,
    computeLooseBallInterceptTarget,
    tryClaimLooseBall,
    getNearestOpponent,
    isTeammateOpen,
    canTackleOwner,
    attemptTackle,
    tackleRecoveryFor,
    applyActionLock,
    humanFoulMultiplier,
    isGkProtected,
    grantGkPossession,
    gkFacesIntoField,
    gkDefendsLeftGoal,
    getGoalkeeperBaseX,
    computeGkClearTarget,
    dist2d
};
