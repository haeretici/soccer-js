/**
 * Positioning layer policy (idle/shape target stack)
 *
 * Single stack order for idle / shape targets. Lower layers are foundations;
 * higher layers may replace or blend on top. Region re-home is applied to
 * player.baseX/Y before idle resolution (Team.applyHomeRegions).
 *
 * Stack (idle / shape):
 *   L1  FORMATION_BASE   — authored formation / custom slot (formationBase*)
 *   L2  REGION_HOME      — posture region center + fine offset → baseX/baseY
 *   L3  DEPTH_HOLD       — team depth bias + effective FORMATION_HOLD ball shift
 *   L4  BALL_SHAPE       — defensive mid-block / attack support lanes
 *   L5  ROLE_OVERRIDE    — support spot, mark cover, loose intercept, cut-off, GK tend
 *
 * Chase / Pass / Shoot / Receive states own L5 (or leave idle). This module
 * resolves the Idle path and documents the stack for other consumers.
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');

/** Stable layer ids (debug + tests). */
const PositionLayer = {
    FORMATION_BASE: 'L1_formationBase',
    REGION_HOME: 'L2_regionHome',
    DEPTH_HOLD: 'L3_depthHold',
    BALL_SHAPE: 'L4_ballShape',
    ROLE_OVERRIDE: 'L5_roleOverride'
};

/** Human-readable stack documentation (export for UI/docs). */
const POSITION_STACK_DOC = [
    { id: PositionLayer.FORMATION_BASE, name: 'Formation base', desc: 'Authored formationBaseX/Y (custom slots allowed)' },
    { id: PositionLayer.REGION_HOME, name: 'Region home', desc: 'Posture column shift + fine offset → baseX/Y' },
    { id: PositionLayer.DEPTH_HOLD, name: 'Depth + hold', desc: 'Team depthBiasRef × role + FORMATION_HOLD ball shift' },
    { id: PositionLayer.BALL_SHAPE, name: 'Ball-relative shape', desc: 'Defensive mid-block or attack support lanes' },
    { id: PositionLayer.ROLE_OVERRIDE, name: 'Role override', desc: 'Support spot, mark cover, loose intercept, chase cut-off, GK tend' }
];

/**
 * @param {number} x
 * @param {number} y
 * @param {{ width: number, height: number, multiplier?: number }} field
 */
function clampToField(x, y, field) {
    const margin = 0.5 * (field.multiplier || 1);
    return {
        x: Math.max(margin, Math.min(field.width - margin, x)),
        y: Math.max(margin, Math.min(field.height - margin, y))
    };
}

/**
 * L1 snapshot from player.
 * @param {object} player
 */
function layerFormationBase(player) {
    return {
        id: PositionLayer.FORMATION_BASE,
        x: player.formationBaseX != null ? player.formationBaseX : player.baseX,
        y: player.formationBaseY != null ? player.formationBaseY : player.baseY
    };
}

/**
 * L2: base after region re-home (already written by Team.applyHomeRegions).
 * @param {object} player
 */
function layerRegionHome(player) {
    return {
        id: PositionLayer.REGION_HOME,
        x: player.baseX,
        y: player.baseY,
        homeRegionId: player.homeRegionId != null ? player.homeRegionId : null
    };
}

/**
 * L3: depth bias + formation-hold ball shift (canonical formation target).
 * Pure geometry — same math as Player.getTargetFormationPos.
 *
 * @param {object} player
 * @param {object|null} team
 * @param {object|null} ball
 */
function layerDepthHold(player, team, ball) {
    const field = Utils.getFieldBounds();
    const depthX = team && typeof team.getDepthWorldOffset === 'function'
        ? team.getDepthWorldOffset(player)
        : 0;
    let x = player.baseX + depthX;
    let y = player.baseY;

    if (ball && !(ball.owner && ball.owner.role === 'GK')) {
        // Protected GK possession freezes shift (caller may pass null ball shift)
        const hold = team && typeof team.getEffectiveFormationHold === 'function'
            ? team.getEffectiveFormationHold()
            : (Settings.AI && Settings.AI.FORMATION_HOLD) || 0.55;
        const shiftScale = Math.max(0.05, 1 - hold * 0.95);
        x += (ball.x - field.centerX) * 0.35 * shiftScale;
        y += (ball.y - field.centerY) * 0.3 * shiftScale;
    }

    const clamped = clampToField(x, y, field);
    return {
        id: PositionLayer.DEPTH_HOLD,
        x: clamped.x,
        y: clamped.y,
        depthX
    };
}

/**
 * @typedef {object} PositionLayerSample
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {string} [note]
 */

/**
 * @typedef {object} PositionResolveResult
 * @property {number} x
 * @property {number} y
 * @property {string} winningLayer
 * @property {string} mode - short reason key
 * @property {PositionLayerSample[]} layers
 */

/**
 * Resolve idle move target with explicit layer stack + optional debug trace.
 *
 * Hot path (match Idle every tick): pass `trace: false` (default) to skip layer
 * sample allocations — only `{x,y,winningLayer,mode}` is required for movement.
 *
 * @param {object} player
 * @param {{
 *   getTeam?: function,
 *   isGkProtected?: function,
 *   isCarrierInAttackingHalf?: function,
 *   computeAttackSupportTarget?: function,
 *   computeLooseBallInterceptTarget?: function,
 *   getDefensiveShapePos?: function,
 *   ai?: function,
 *   dist2d?: function,
 *   trace?: boolean
 * }} api
 * @returns {PositionResolveResult}
 */
function resolveIdleMoveTarget(player, api = {}) {
    const trace = !!api.trace;
    /** @type {PositionLayerSample[]|null} */
    const layers = trace ? [] : null;
    const team = api.getTeam ? api.getTeam(player) : (player.getTeam ? player.getTeam() : null);
    const level = player.level;
    const ball = level && level.ball;
    const field = Utils.getFieldBounds();

    if (layers) {
        layers.push(layerFormationBase(player));
        layers.push(layerRegionHome(player));
    }

    // Protected GK: freeze at depth-hold without ball pull
    let skipBallShift = false;
    if (ball && ball.owner && ball.owner.role === 'GK' && api.isGkProtected && api.isGkProtected(ball.owner)) {
        skipBallShift = true;
    }

    const l3 = layerDepthHold(player, team, skipBallShift ? null : ball);
    if (layers) {
        layers.push({
            id: l3.id,
            x: l3.x,
            y: l3.y,
            note: skipBallShift ? 'gk_protected_no_ball_shift' : undefined
        });
    }

    /** @type {PositionResolveResult} */
    const result = {
        x: l3.x,
        y: l3.y,
        winningLayer: PositionLayer.DEPTH_HOLD,
        mode: 'formation',
        layers: layers || []
    };

    const finish = (x, y, winningLayer, mode, note) => {
        const c = clampToField(x, y, field);
        result.x = c.x;
        result.y = c.y;
        result.winningLayer = winningLayer;
        result.mode = mode;
        if (layers) {
            layers.push({ id: winningLayer, x: c.x, y: c.y, note });
        }
        return result;
    };

    if (!ball) {
        return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'no_ball');
    }

    // L5: loose-ball opportunistic intercept (nearby only)
    if (ball.owner === null && ball.z < 0.9 && api.computeLooseBallInterceptTarget && api.dist2d && api.ai) {
        const dist = api.dist2d(player.x, player.y, ball.x, ball.y);
        const range = api.ai(player).LOOSE_BALL_PROXIMITY_RANGE;
        if (dist <= range) {
            const t = api.computeLooseBallInterceptTarget(player, ball);
            return finish(t.x, t.y, PositionLayer.ROLE_OVERRIDE, 'loose_intercept', 'near_loose_ball');
        }
        return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'loose_shape');
    }

    if (!ball.owner || ball.owner.role === 'GK') {
        return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'no_open_owner');
    }
    if (skipBallShift) {
        return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'gk_protected');
    }

    // Own possession
    if (ball.owner.team === player.team) {
        if (ball.owner === player || player.role === 'GK') {
            return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'carrier_or_gk');
        }

        // L5: primary supporting player → scored support spot (SupportAttacker uses same target)
        if (team && team.supportingPlayer === player) {
            const spot = player.supportTarget
                || (typeof team.getBestSupportSpot === 'function' ? team.getBestSupportSpot() : null);
            if (spot && spot.x != null && spot.y != null) {
                return finish(spot.x, spot.y, PositionLayer.ROLE_OVERRIDE, 'support_spot', 'primary_supporter');
            }
        }

        // L4: other teammates — attack support lanes (full in final half, light otherwise)
        if (api.computeAttackSupportTarget) {
            if (api.isCarrierInAttackingHalf && api.isCarrierInAttackingHalf(ball.owner, level)) {
                const t = api.computeAttackSupportTarget(player, ball.owner, level);
                return finish(t.x, t.y, PositionLayer.BALL_SHAPE, 'attack_support_full');
            }
            const light = api.computeAttackSupportTarget(player, ball.owner, level);
            const intensity = api.ai ? api.ai(player).ATTACK_SUPPORT_INTENSITY : 0.65;
            const blend = intensity * 0.35;
            return finish(
                l3.x * (1 - blend) + light.x * blend,
                l3.y * (1 - blend) + light.y * blend,
                PositionLayer.BALL_SHAPE,
                'attack_support_light'
            );
        }
        return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'attack_no_support_fn');
    }

    // Opponent possession
    // L5: assigned marker → cover shadow (interpose mark ↔ own goal)
    // Prefer cached cover point first (avoids defensive-shape work every tick for markers)
    if (team && typeof team.isMarkingPlayer === 'function' && team.isMarkingPlayer(player)) {
        if (player.markCoverPoint) {
            return finish(
                player.markCoverPoint.x,
                player.markCoverPoint.y,
                PositionLayer.ROLE_OVERRIDE,
                'mark_cover',
                'cached_cover'
            );
        }
        let shapeBase = null;
        if (api.getDefensiveShapePos) {
            shapeBase = api.getDefensiveShapePos.call
                ? api.getDefensiveShapePos.call(player)
                : api.getDefensiveShapePos(player);
        }
        if (typeof team.getMarkCoverPoint === 'function') {
            const cover = team.getMarkCoverPoint(player, shapeBase);
            if (cover) {
                return finish(cover.x, cover.y, PositionLayer.ROLE_OVERRIDE, 'mark_cover', 'assigned_marker');
            }
        }
    }

    // L4 defensive mid-block shape
    // Far from the ball: keep L3 depth/hold (mid-block compress is wasted work)
    if (api.getDefensiveShapePos) {
        if (api.dist2d) {
            const dBall = api.dist2d(player.x, player.y, ball.x, ball.y);
            // ~ half-pitch in world units at default field scale
            if (dBall > field.width * 0.42) {
                return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'defend_far_hold');
            }
        }
        const t = api.getDefensiveShapePos.call
            ? api.getDefensiveShapePos.call(player)
            : api.getDefensiveShapePos(player);
        return finish(t.x, t.y, PositionLayer.BALL_SHAPE, 'defend_mid_block');
    }

    return finish(l3.x, l3.y, PositionLayer.DEPTH_HOLD, 'defend_fallback');
}

/**
 * Whether debug traces should be stored on players.
 */
function isPositionTraceEnabled() {
    const d = Settings.debugAI;
    return !!(d && d.enabled && d.positionTrace);
}

/**
 * Store last resolve on player for overlays / inspection.
 * @param {object} player
 * @param {PositionResolveResult} result
 */
function attachPositionTrace(player, result) {
    if (!player || !result) return;
    player._positionTrace = {
        winningLayer: result.winningLayer,
        mode: result.mode,
        x: result.x,
        y: result.y,
        layers: result.layers
    };
    player.debugPositionLayer = result.winningLayer;
    player.debugPositionMode = result.mode;
}

module.exports = {
    PositionLayer,
    POSITION_STACK_DOC,
    clampToField,
    layerFormationBase,
    layerRegionHome,
    layerDepthHold,
    resolveIdleMoveTarget,
    isPositionTraceEnabled,
    attachPositionTrace
};
