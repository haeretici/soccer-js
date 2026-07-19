/**
 * Engine Tweakings / batch UI metadata for team-split AI knobs.
 *
 * Strategy knobs (0–1) feed archetypes + dynamic late-game shifts.
 * Shape knobs control attack line / support runs (defaults match prior hardcodes).
 */
const STRATEGY_KNOBS = [
    'FORMATION_HOLD',
    'ATTACK_SUPPORT_INTENSITY',
    'DEFENSIVE_PRESS_INTENSITY',
    'PASS_AGGRESSION'
];

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   tip: string,
 *   min: number,
 *   max: number,
 *   step: number,
 *   default: number,
 *   decimals: number,
 *   idBase: string,
 *   group: 'strategy'|'attack_shape'
 * }} UiAiKnob
 */

/** @type {UiAiKnob[]} */
const STRATEGY_KNOB_META = [
    {
        key: 'FORMATION_HOLD',
        label: 'Formation Hold',
        tip: 'How rigidly players stick to formation slots. Higher = less ball-following / freer support runs suppressed.',
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.55,
        decimals: 2,
        idBase: 'formationHold',
        group: 'strategy'
    },
    {
        key: 'ATTACK_SUPPORT_INTENSITY',
        label: 'Attack Support',
        tip: 'How aggressively off-ball teammates push for support lanes and width when your team has the ball.',
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.65,
        decimals: 2,
        idBase: 'attackSupport',
        group: 'strategy'
    },
    {
        key: 'DEFENSIVE_PRESS_INTENSITY',
        label: 'Defensive Press',
        tip: 'How high and hard the unit presses when out of possession (mid-block vs deep block).',
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.45,
        decimals: 2,
        idBase: 'defensivePress',
        group: 'strategy'
    },
    {
        key: 'PASS_AGGRESSION',
        label: 'Pass Aggression',
        tip: 'Willingness to attempt progressive / riskier passes vs safe recycling.',
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.55,
        decimals: 2,
        idBase: 'passAggression',
        group: 'strategy'
    }
];

/** @type {UiAiKnob[]} */
const SHAPE_KNOB_META = [
    {
        key: 'ATTACK_DEPTH_BIAS_REF',
        label: 'Attack Line Depth',
        tip: 'Reference-field X push of the whole unit when Attacking (default 7.5 is mild). Raise to push midfield/attack higher.',
        min: 0,
        max: 25,
        step: 0.5,
        default: 7.5,
        decimals: 1,
        idBase: 'attackDepth',
        group: 'attack_shape'
    },
    {
        key: 'ATTACK_REGION_COL_DELTA',
        label: 'Attack Region Shift',
        tip: 'Home-region grid columns toward the opponent goal when Attacking (default 1 of 6). Raise so defenders/mids leave their half.',
        min: 0,
        max: 3,
        step: 1,
        default: 1,
        decimals: 0,
        idBase: 'attackRegionShift',
        group: 'attack_shape'
    },
    {
        key: 'ATTACK_ROLE_REGION_BIAS',
        label: 'Attacker Region Bias',
        tip: 'Extra region columns for strikers/wings when Attacking (default 1). Stacks on Attack Region Shift.',
        min: 0,
        max: 2,
        step: 1,
        default: 1,
        decimals: 0,
        idBase: 'attackRoleBias',
        group: 'attack_shape'
    },
    {
        key: 'ATTACK_SUPPORT_OWN_HALF_BLEND',
        label: 'Own-Half Support',
        tip: 'When the ball is still in your half, secondary support uses intensity × this blend (default 0.35). Raise so teammates join earlier in build-up.',
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.35,
        decimals: 2,
        idBase: 'ownHalfSupport',
        group: 'attack_shape'
    },
    {
        key: 'ATTACK_SUPPORT_FORM_PULL',
        label: 'Support Form Pull',
        tip: 'How hard secondary support targets stay glued to formation (default 1). Lower = freer runs toward the carrier/goal.',
        min: 0,
        max: 1,
        step: 0.05,
        default: 1.0,
        decimals: 2,
        idBase: 'supportFormPull',
        group: 'attack_shape'
    },
    {
        key: 'ATTACK_SUPPORT_PUSH_SCALE',
        label: 'Support Push Scale',
        tip: 'Scales how far ahead of the carrier support lanes sit (default 1). Raise for deeper runs into the box.',
        min: 0,
        max: 2,
        step: 0.05,
        default: 1.0,
        decimals: 2,
        idBase: 'supportPushScale',
        group: 'attack_shape'
    },
    {
        key: 'SUPPORT_WIDTH',
        label: 'Support Width',
        tip: 'Lateral stretch of support spots / lanes (0 = narrow central, 1 = wide flanks). Default 0.55.',
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.55,
        decimals: 2,
        idBase: 'supportWidth',
        group: 'attack_shape'
    }
];

/** @type {UiAiKnob[]} */
const ALL_UI_KNOB_META = STRATEGY_KNOB_META.concat(SHAPE_KNOB_META);

/** Keys exposed in Engine Tweakings / team-split localStorage / replay AI blocks. */
const ALL_UI_KNOBS = ALL_UI_KNOB_META.map((m) => m.key);

/** Shape-only keys (not overridden by archetypes / dynamic strategy shift). */
const SHAPE_KNOBS = SHAPE_KNOB_META.map((m) => m.key);

/** @type {Map<string, UiAiKnob>} */
const KNOB_META_BY_KEY = new Map(ALL_UI_KNOB_META.map((m) => [m.key, m]));

/**
 * @param {string} key
 * @returns {UiAiKnob|null}
 */
function getKnobMeta(key) {
    return KNOB_META_BY_KEY.get(key) || null;
}

/**
 * @param {string} key
 * @param {number} val
 * @returns {boolean}
 */
function isValidKnobValue(key, val) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return false;
    const meta = getKnobMeta(key);
    if (!meta) {
        // Unknown numeric: allow any finite (batch / advanced)
        return true;
    }
    return val >= meta.min && val <= meta.max;
}

/**
 * Clamp a value into the knob's published range (if known).
 * @param {string} key
 * @param {number} val
 * @returns {number}
 */
function clampKnobValue(key, val) {
    const meta = getKnobMeta(key);
    if (!meta || typeof val !== 'number' || !Number.isFinite(val)) return val;
    return Math.max(meta.min, Math.min(meta.max, val));
}

/**
 * Read team AI block for all UI knobs (own props or prototype defaults).
 * @param {object} teamBlock - Settings.AI.A / Settings.AI.B
 * @param {object} [baseAi] - Settings.AI
 */
function readTeamUiKnobs(teamBlock, baseAi = null) {
    const base = baseAi || {};
    const out = {};
    for (const meta of ALL_UI_KNOB_META) {
        const v = teamBlock && teamBlock[meta.key] != null ? teamBlock[meta.key] : base[meta.key];
        out[meta.key] = typeof v === 'number' && Number.isFinite(v) ? v : meta.default;
    }
    return out;
}

/**
 * Format knob value for badge display.
 * @param {string} key
 * @param {number} val
 */
function formatKnobValue(key, val) {
    const meta = getKnobMeta(key);
    const d = meta ? meta.decimals : 2;
    return Number(val).toFixed(d);
}

module.exports = {
    STRATEGY_KNOBS,
    STRATEGY_KNOB_META,
    SHAPE_KNOBS,
    SHAPE_KNOB_META,
    ALL_UI_KNOBS,
    ALL_UI_KNOB_META,
    getKnobMeta,
    isValidKnobValue,
    clampKnobValue,
    readTeamUiKnobs,
    formatKnobValue
};
