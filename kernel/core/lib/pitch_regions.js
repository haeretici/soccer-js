/**
 * Pitch regions — coarse home-region grid for attack/defense posture.
 *
 * Coarse grid over the playing field. Players bind a default region from
 * formation bases; Team FSM shifts the home region column on attack/defense
 * while keeping a fine offset (formation detail within the cell).
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');

/** Default grid 6×3; configurable via Settings.AI */
const DEFAULT_COLS = 6;
const DEFAULT_ROWS = 3;

/**
 * @typedef {{ id: number, ix: number, iy: number, left: number, right: number, top: number, bottom: number, centerX: number, centerY: number }} PitchRegion
 */

/**
 * Build a region grid covering the field (world units).
 * @param {{ width: number, height: number }} field
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {PitchRegion[]}
 */
function createPitchRegions(field, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    const c = Math.max(1, cols | 0);
    const r = Math.max(1, rows | 0);
    const cellW = field.width / c;
    const cellH = field.height / r;
    /** @type {PitchRegion[]} */
    const regions = [];

    for (let ix = 0; ix < c; ix++) {
        for (let iy = 0; iy < r; iy++) {
            const left = ix * cellW;
            const right = (ix + 1) * cellW;
            const top = iy * cellH;
            const bottom = (iy + 1) * cellH;
            const id = ix * r + iy;
            regions.push({
                id,
                ix,
                iy,
                left,
                right,
                top,
                bottom,
                centerX: (left + right) * 0.5,
                centerY: (top + bottom) * 0.5
            });
        }
    }
    return regions;
}

/**
 * @param {PitchRegion[]} regions
 * @returns {{ cols: number, rows: number }}
 */
function gridSize(regions) {
    if (!regions || !regions.length) return { cols: 0, rows: 0 };
    let maxIx = 0;
    let maxIy = 0;
    for (let i = 0; i < regions.length; i++) {
        if (regions[i].ix > maxIx) maxIx = regions[i].ix;
        if (regions[i].iy > maxIy) maxIy = regions[i].iy;
    }
    return { cols: maxIx + 1, rows: maxIy + 1 };
}

/**
 * @param {PitchRegion[]} regions
 * @param {number} ix
 * @param {number} iy
 * @returns {PitchRegion|null}
 */
function getRegionAt(regions, ix, iy) {
    const { cols, rows } = gridSize(regions);
    if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return null;
    const id = ix * rows + iy;
    return regions[id] || null;
}

/**
 * Region containing a world point (clamped to field grid).
 * @param {number} x
 * @param {number} y
 * @param {PitchRegion[]} regions
 * @returns {PitchRegion|null}
 */
function regionContaining(x, y, regions) {
    if (!regions || !regions.length) return null;
    const { cols, rows } = gridSize(regions);
    const field = Utils.getFieldBounds();
    const cellW = field.width / cols;
    const cellH = field.height / rows;
    let ix = Math.floor(x / cellW);
    let iy = Math.floor(y / cellH);
    if (ix < 0) ix = 0;
    if (iy < 0) iy = 0;
    if (ix >= cols) ix = cols - 1;
    if (iy >= rows) iy = rows - 1;
    return getRegionAt(regions, ix, iy);
}

/**
 * Nearest region center to a point.
 * @param {number} x
 * @param {number} y
 * @param {PitchRegion[]} regions
 * @returns {PitchRegion|null}
 */
function nearestRegion(x, y, regions) {
    if (!regions || !regions.length) return null;
    let best = regions[0];
    let bestD = Infinity;
    for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const dx = r.centerX - x;
        const dy = r.centerY - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
            bestD = d;
            best = r;
        }
    }
    return best;
}

/**
 * Resolve grid dimensions from Settings.
 * @returns {{ cols: number, rows: number }}
 */
function configuredGrid() {
    const ai = Settings.AI || {};
    return {
        cols: ai.PITCH_REGION_COLS || DEFAULT_COLS,
        rows: ai.PITCH_REGION_ROWS || DEFAULT_ROWS
    };
}

/**
 * Column delta applied to default home region (toward attack when positive).
 * On attack/defend posture we shift region columns rather than full table swaps.
 */
const POSTURE_REGION_COL_DELTA = {
    attacking: 1,
    defending: -1,
    setpiece: 0,
    kickoffprepare: 0
};

/**
 * Role-based extra column bias within a posture (lines push differently).
 * Positive = toward opponent goal (in attack direction).
 * @param {string} role
 * @param {string} postureName
 * @param {{ attackRoleBias?: number, defendRoleBias?: number }} [opts]
 * @returns {number}
 */
function roleRegionColumnBias(role, postureName, opts = {}) {
    if (!role || role === 'GK') return 0;
    const isDef = /CB|LB|RB|LCB|RCB|LWB|RWB|DM|CDM/i.test(role);
    const isAtt = /S|CF|ST|LW|RW|AM|CAM|SS|F|W|WF/i.test(role);
    const attBias = typeof opts.attackRoleBias === 'number' ? opts.attackRoleBias : 1;
    const defBias = typeof opts.defendRoleBias === 'number' ? opts.defendRoleBias : 1;
    if (postureName === 'attacking') {
        if (isAtt) return attBias;
        if (isDef) return 0;
        return 0; // mid
    }
    if (postureName === 'defending') {
        if (isDef) return -defBias;
        if (isAtt) return 0;
        return 0;
    }
    return 0;
}

/**
 * Compute effective home region for a player under posture.
 *
 * @param {object} player - needs defaultRegionId / regionFineOffset / formationBase*
 * @param {PitchRegion[]} regions
 * @param {string} postureName
 * @param {boolean} attacksRight - true if this team attacks +X this half
 * @param {{
 *   postureColDelta?: number,
 *   attackRoleBias?: number,
 *   defendRoleBias?: number
 * }} [opts] - when postureColDelta set, overrides POSTURE_REGION_COL_DELTA table
 * @returns {{ region: PitchRegion, baseX: number, baseY: number, homeRegionId: number }|null}
 */
function computeHomeFromRegion(player, regions, postureName, attacksRight, opts = {}) {
    if (!regions || !regions.length || !player) return null;
    const { cols, rows } = gridSize(regions);
    let def = (player.defaultRegionId != null && regions[player.defaultRegionId])
        ? regions[player.defaultRegionId]
        : null;
    if (!def) {
        const fx = player.formationBaseX != null ? player.formationBaseX : player.baseX;
        const fy = player.formationBaseY != null ? player.formationBaseY : player.baseY;
        def = regionContaining(fx, fy, regions) || nearestRegion(fx, fy, regions);
    }
    if (!def) return null;

    const postureDelta = opts.postureColDelta != null
        ? opts.postureColDelta
        : (POSTURE_REGION_COL_DELTA[postureName] != null
            ? POSTURE_REGION_COL_DELTA[postureName]
            : 0);
    const roleBias = roleRegionColumnBias(player.role, postureName, opts);
    // Positive delta = toward attack direction in world +X if attacksRight
    const colShift = Math.round(postureDelta + roleBias) * (attacksRight ? 1 : -1);
    let ix = def.ix + colShift;
    if (ix < 0) ix = 0;
    if (ix >= cols) ix = cols - 1;
    const iy = def.iy;
    const region = getRegionAt(regions, ix, iy) || def;

    const fineX = player.regionFineOffsetX != null ? player.regionFineOffsetX : 0;
    const fineY = player.regionFineOffsetY != null ? player.regionFineOffsetY : 0;

    return {
        region,
        homeRegionId: region.id,
        baseX: region.centerX + fineX,
        baseY: region.centerY + fineY
    };
}

/**
 * Bind default region + fine offset from current formation base.
 * @param {object} player
 * @param {PitchRegion[]} regions
 */
function bindPlayerHomeRegion(player, regions) {
    if (!player || !regions || !regions.length) return;
    const fx = player.formationBaseX != null ? player.formationBaseX : player.baseX;
    const fy = player.formationBaseY != null ? player.formationBaseY : player.baseY;
    const r = regionContaining(fx, fy, regions) || nearestRegion(fx, fy, regions);
    if (!r) return;
    player.defaultRegionId = r.id;
    player.homeRegionId = r.id;
    player.regionFineOffsetX = fx - r.centerX;
    player.regionFineOffsetY = fy - r.centerY;
}

module.exports = {
    DEFAULT_COLS,
    DEFAULT_ROWS,
    POSTURE_REGION_COL_DELTA,
    createPitchRegions,
    gridSize,
    getRegionAt,
    regionContaining,
    nearestRegion,
    configuredGrid,
    roleRegionColumnBias,
    computeHomeFromRegion,
    bindPlayerHomeRegion
};
