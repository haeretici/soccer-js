/**
 * SupportSpotCalculator — attacking-half sweet spots with modern edge model.
 *
 * Grid on the attacking half; each spot scored for pass-safety, can-score,
 * distance from carrier, and soft touchline falloff × tactical SUPPORT_WIDTH.
 *
 * Hard margins only keep spots on the pitch (small). “Don’t hug the line” is a
 * score penalty, not a huge empty lateral dead zone.
 *
 * Owned by Team; updates are tick-regulated.
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');
const {
    estimatePassGroundSpeed,
    isPassSafeFromAllOpponents,
    canShoot,
    getGoalMouthYBounds,
    dist2d
} = require('./pass_safety.js');
const { TickRegulator } = require('./logic_regulator.js');

/** Default grid (overridable via Settings.AI). */
const DEFAULT_GRID_X = 8;
const DEFAULT_GRID_Y = 5;
/** Logic ticks between full rescores (~1.5s at 20 UPS). */
const DEFAULT_UPDATE_TICKS = 30;

/**
 * Resolve AI block for a team (team-split knobs + base Settings.AI).
 * @param {object|null} team
 */
function resolveTeamAI(team) {
    const base = Settings.AI || {};
    if (team && team.teamKey && base[team.teamKey]) {
        return base[team.teamKey];
    }
    return base;
}

/**
 * Distance to nearest touchline (Y = 0 or height).
 * @param {number} y
 * @param {number} fieldHeight
 */
function distToTouchline(y, fieldHeight) {
    return Math.min(y, fieldHeight - y);
}

/**
 * Soft edge factor in [0, 1]: 0 near hard margin, 1 in the interior.
 * Modern games prefer this over deleting flank cells.
 *
 * @param {number} y
 * @param {number} fieldHeight
 * @param {number} hardMin - world units from touchline
 * @param {number} softBand - world units from hardMin to full score
 * @returns {number}
 */
function edgeProximityFactor(y, fieldHeight, hardMin, softBand) {
    const d = distToTouchline(y, fieldHeight);
    if (d <= hardMin) return 0;
    const band = Math.max(1e-6, softBand);
    if (d >= hardMin + band) return 1;
    return (d - hardMin) / band;
}

/**
 * Score multiplier for lateral position under tactical width.
 * @param {number} edgeFactor - from edgeProximityFactor
 * @param {number} supportWidth - 0..1
 * @param {number} minMulNarrow
 * @param {number} minMulWide
 */
function edgeScoreMultiplier(edgeFactor, supportWidth, minMulNarrow, minMulWide) {
    const w = Math.max(0, Math.min(1, supportWidth));
    const minMul = minMulNarrow + (minMulWide - minMulNarrow) * w;
    // Interior → 1; at hard edge → minMul
    return minMul + (1 - minMul) * Math.max(0, Math.min(1, edgeFactor));
}

/**
 * Wing preference bonus when stretching (high SUPPORT_WIDTH, low edgeFactor).
 * @param {number} edgeFactor
 * @param {number} supportWidth
 * @param {number} wingBonusMax
 */
function wingWidthBonus(edgeFactor, supportWidth, wingBonusMax) {
    const w = Math.max(0, Math.min(1, supportWidth));
    const wideNeed = 1 - Math.max(0, Math.min(1, edgeFactor)); // 1 at flank, 0 in centre
    return wingBonusMax * w * wideNeed;
}

/**
 * @param {import('../entities/team.js').Team} team
 */
class SupportSpotCalculator {
    /**
     * @param {object} team - Team instance (opponents, controllingPlayer, goals)
     */
    constructor(team) {
        this.team = team;
        /** @type {Array<{ x: number, y: number, score: number }>} */
        this.spots = [];
        /** @type {{ x: number, y: number, score: number }|null} */
        this.bestSpot = null;
        this._attacksRight = null;
        this._fieldKey = null;
        this.regulator = new TickRegulator(
            (Settings.AI && Settings.AI.SUPPORT_SPOT_UPDATE_TICKS) || DEFAULT_UPDATE_TICKS
        );
    }

    _ai() {
        return resolveTeamAI(this.team);
    }

    _gridConfig() {
        const ai = this._ai();
        const base = Settings.AI || {};
        const num = (key, fallback) => {
            const v = ai[key] != null ? ai[key] : base[key];
            return v != null ? v : fallback;
        };
        return {
            numX: num('SUPPORT_SPOT_GRID_X', DEFAULT_GRID_X) | 0,
            numY: num('SUPPORT_SPOT_GRID_Y', DEFAULT_GRID_Y) | 0,
            updateTicks: num('SUPPORT_SPOT_UPDATE_TICKS', DEFAULT_UPDATE_TICKS) | 0,
            passSafeScore: num('SPOT_PASS_SAFE_SCORE', 2.0),
            canScoreScore: num('SPOT_CAN_SCORE_SCORE', 1.0),
            distScore: num('SPOT_DIST_FROM_CONTROLLER_SCORE', 2.0),
            optimalDistRef: num('SPOT_OPTIMAL_DIST_REF', 25),
            marginXFrac: num('SUPPORT_SPOT_MARGIN_X_FRAC', 0.03),
            marginYFrac: num('SUPPORT_SPOT_MARGIN_Y_FRAC', 0.03),
            edgeSoftFrac: num('SUPPORT_SPOT_EDGE_SOFT_FRAC', 0.14),
            supportWidth: num('SUPPORT_WIDTH', 0.55),
            edgeMinNarrow: num('SUPPORT_EDGE_MIN_MUL_NARROW', 0.28),
            edgeMinWide: num('SUPPORT_EDGE_MIN_MUL_WIDE', 0.92),
            wingBonus: num('SUPPORT_WING_BONUS', 0.85)
        };
    }

    /**
     * Apply A.3 phase multipliers onto a base grid config (non-mutating clone).
     * @param {ReturnType<SupportSpotCalculator['_gridConfig']>} cfg
     * @param {object|null|undefined} phaseMods
     */
    _applyPhaseMods(cfg, phaseMods) {
        if (!phaseMods) return cfg;
        const out = Object.assign({}, cfg);
        if (typeof phaseMods.supportWidthMult === 'number') {
            out.supportWidth = Math.max(0.05, Math.min(1.2, cfg.supportWidth * phaseMods.supportWidthMult));
        }
        if (typeof phaseMods.supportCanScoreMult === 'number') {
            out.canScoreScore = cfg.canScoreScore * phaseMods.supportCanScoreMult;
        }
        if (typeof phaseMods.supportWingMult === 'number') {
            out.wingBonus = cfg.wingBonus * phaseMods.supportWingMult;
        }
        // Finish: slightly shorter optimal support distance (cutbacks / near box)
        if (typeof phaseMods.supportDepthMult === 'number' && phaseMods.supportDepthMult > 1.05) {
            out.optimalDistRef = cfg.optimalDistRef * 0.88;
        } else if (typeof phaseMods.supportDepthMult === 'number' && phaseMods.supportDepthMult < 0.85) {
            // Build: deeper/safer support pocket
            out.optimalDistRef = cfg.optimalDistRef * 0.75;
        }
        return out;
    }

    /**
     * Rebuild grid when attack direction, field size, or margin config changes.
     * @param {boolean} attacksRight
     * @param {{ width: number, height: number, centerX: number, centerY: number, multiplier?: number }} field
     */
    ensureSpots(attacksRight, field) {
        const cfg = this._gridConfig();
        this.regulator.setInterval(Math.max(1, cfg.updateTicks));
        const key = [
            field.width, field.height, field.multiplier || 1,
            attacksRight ? 1 : 0,
            cfg.numX, cfg.numY,
            cfg.marginXFrac, cfg.marginYFrac
        ].join(':');
        if (this._fieldKey === key && this.spots.length > 0) return;

        this._fieldKey = key;
        this._attacksRight = attacksRight;
        this.spots = [];
        this.bestSpot = null;

        const numX = Math.max(1, cfg.numX);
        const numY = Math.max(1, cfg.numY);
        // Hard clamp only — small fractions so flanks remain available as cells
        const marginX = field.width * Math.max(0.005, Math.min(0.2, cfg.marginXFrac));
        const marginY = field.height * Math.max(0.005, Math.min(0.2, cfg.marginYFrac));

        // Attacking half only; soft edge handles lateral preference
        let x0;
        let x1;
        if (attacksRight) {
            x0 = field.centerX + marginX * 0.5;
            x1 = field.width - marginX;
        } else {
            x0 = marginX;
            x1 = field.centerX - marginX * 0.5;
        }
        const y0 = marginY;
        const y1 = field.height - marginY;
        if (x1 <= x0 || y1 <= y0) return;

        for (let ix = 0; ix < numX; ix++) {
            for (let iy = 0; iy < numY; iy++) {
                this.spots.push({
                    x: x0 + (ix + 0.5) * (x1 - x0) / numX,
                    y: y0 + (iy + 0.5) * (y1 - y0) / numY,
                    score: 1
                });
            }
        }
        this.regulator.forceReady();
    }

    /**
     * Rescore spots (throttled). Returns best spot position or null.
     * @param {{
     *   controller: { x: number, y: number, stats?: object, effectivePassing?: number, effectiveShooting?: number, role?: string },
     *   opponents: Array,
     *   oppGoalX: number,
     *   attacksRight: boolean,
     *   force?: boolean,
     *   phaseMods?: object|null
     * }} ctx
     * @returns {{ x: number, y: number, score: number }|null}
     */
    determineBestSupportingPosition(ctx) {
        const field = Utils.getFieldBounds();
        this.ensureSpots(!!ctx.attacksRight, field);

        if (!ctx.force && !this.regulator.isReady() && this.bestSpot) {
            return this.bestSpot;
        }

        const controller = ctx.controller;
        if (!controller || this.spots.length === 0) {
            this.bestSpot = null;
            return null;
        }

        const phaseMods = ctx.phaseMods
            || (this.team && typeof this.team.getPlayPhaseMods === 'function'
                ? this.team.getPlayPhaseMods()
                : null);
        const cfg = this._applyPhaseMods(this._gridConfig(), phaseMods);
        const opponents = ctx.opponents || [];
        const oppGoalX = ctx.oppGoalX;
        const from = { x: controller.x, y: controller.y };
        const optimalDist = Utils.scaleFieldX(cfg.optimalDistRef);

        const hardMinY = field.height * Math.max(0.005, Math.min(0.2, cfg.marginYFrac));
        const softBand = field.height * Math.max(0.02, cfg.edgeSoftFrac);

        // Wide roles slightly prefer flanks (half-space / wing channels)
        const role = controller.role || '';
        const controllerIsWide = /LM|RM|LW|RW|LWB|RWB|WF|W/i.test(role);

        let best = null;
        let bestScore = -Infinity;

        // Full pass-safety on spots; canShoot only if pass-safe (1 mouth sample — enough for ranking)
        const mouth = getGoalMouthYBounds(field);
        const midY = (mouth.yMin + mouth.yMax) * 0.5;

        for (let i = 0; i < this.spots.length; i++) {
            const spot = this.spots[i];
            // Base 1.0 so debug viewers still see unoccupied spots
            let score = 1.0;

            // 1) Safe pass from carrier to spot (null receiver — space)
            const passSpeed = estimatePassGroundSpeed(from, spot, controller, 'short');
            const passSafe = isPassSafeFromAllOpponents(from, spot, null, opponents, passSpeed);
            if (passSafe) {
                score += cfg.passSafeScore;
            }

            // 2) Can-score only when pass-safe; single mouth sample
            if (passSafe && cfg.canScoreScore > 0) {
                // Deterministic score signal: no contested RNG (open-play decisions use RNG)
                const shot = canShoot(spot, controller, opponents, {
                    oppGoalX,
                    sampleYs: [midY],
                    allowContested: false
                });
                if (shot.ok) {
                    score += cfg.canScoreScore;
                }
            }

            // 3) Prefer spots near optimal support distance from carrier
            const dist = dist2d(controller.x, controller.y, spot.x, spot.y);
            const temp = Math.abs(optimalDist - dist);
            if (temp < optimalDist) {
                score += cfg.distScore * (optimalDist - temp) / optimalDist;
            }

            // 4) Modern edge model: soft touchline falloff × SUPPORT_WIDTH (+ wing bonus)
            const eFac = edgeProximityFactor(spot.y, field.height, hardMinY, softBand);
            const edgeMul = edgeScoreMultiplier(
                eFac,
                cfg.supportWidth,
                cfg.edgeMinNarrow,
                cfg.edgeMinWide
            );
            score *= edgeMul;
            score += wingWidthBonus(eFac, cfg.supportWidth, cfg.wingBonus);

            // Mild half-space preference when controller is a wide player (stretch)
            if (controllerIsWide && cfg.supportWidth > 0.45) {
                const wingSide = spot.y < field.centerY ? -1 : 1;
                // Prefer same half as controller's y
                const sameFlank = (controller.y - field.centerY) * wingSide > 0;
                if (sameFlank && eFac < 0.65) {
                    score += 0.25 * cfg.supportWidth;
                }
            }

            spot.score = score;
            if (score > bestScore) {
                bestScore = score;
                best = spot;
            }
        }

        this.bestSpot = best;
        return this.bestSpot;
    }

    /** Cached best spot without forcing a rescore. */
    getBestSupportingSpot() {
        if (this.bestSpot) return this.bestSpot;
        return null;
    }

    /** All spots (for tests / debug). */
    getSpots() {
        return this.spots;
    }
}

module.exports = {
    SupportSpotCalculator,
    TickRegulator,
    DEFAULT_GRID_X,
    DEFAULT_GRID_Y,
    DEFAULT_UPDATE_TICKS,
    resolveTeamAI,
    distToTouchline,
    edgeProximityFactor,
    edgeScoreMultiplier,
    wingWidthBonus
};
