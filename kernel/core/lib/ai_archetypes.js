const ARCHETYPES = require('../../../presets/ai_archetypes.json');
const {
    STRATEGY_KNOBS,
    SHAPE_KNOBS,
    ALL_UI_KNOBS
} = require('./ai_ui_knobs.js');

/** Classic four knobs used by dynamic late-game shifts (strategy only). */
const KNOB_KEYS = STRATEGY_KNOBS.slice();

/** All Engine Tweakings team-split knobs (strategy + attack shape). */
const UI_KNOB_KEYS = ALL_UI_KNOBS.slice();

const MATCH_EPS = 0.001;

function listArchetypes() {
    return Object.entries(ARCHETYPES)
        .map(([id, arch]) => ({ id, label: arch.label, description: arch.description }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

function getArchetype(id) {
    if (!id || id === 'custom') return null;
    return ARCHETYPES[id] || null;
}

/**
 * Strategy knobs only — used by late-game dynamic shifts so attack shape
 * chosen in Engine Tweakings is not wiped mid-match.
 * @param {string} id
 * @returns {Record<string, number>|null}
 */
function getArchetypeValues(id) {
    const arch = getArchetype(id);
    if (!arch) return null;
    const out = {};
    for (const key of STRATEGY_KNOBS) {
        if (typeof arch[key] !== 'number' || !Number.isFinite(arch[key])) return null;
        out[key] = arch[key];
    }
    return out;
}

/**
 * Full preset surface: strategy + any attack-shape knobs defined on the archetype.
 * Used when the user selects a preset (UI / batch) so styles can reshape the attack line.
 * @param {string} id
 * @returns {Record<string, number>|null}
 */
function getArchetypeFullValues(id) {
    const arch = getArchetype(id);
    if (!arch) return null;
    const strategy = getArchetypeValues(id);
    if (!strategy) return null;
    const out = Object.assign({}, strategy);
    for (const key of SHAPE_KNOBS) {
        if (typeof arch[key] === 'number' && Number.isFinite(arch[key])) {
            out[key] = arch[key];
        }
    }
    return out;
}

/**
 * Numeric UI keys defined on an archetype (strategy required; shape optional).
 * @param {object} arch
 * @returns {string[]}
 */
function archetypeDefinedKnobKeys(arch) {
    if (!arch) return [];
    return ALL_UI_KNOBS.filter((key) => typeof arch[key] === 'number' && Number.isFinite(arch[key]));
}

/**
 * Match live AI block to a preset. Strategy keys always compared; shape keys
 * only when the archetype defines them (so partial custom shape still matches
 * older strategy-only comparison when shape is omitted — but full presets
 * require shape agreement).
 * @param {object} aiBlock
 * @returns {string} archetype id or 'custom'
 */
function matchArchetype(aiBlock) {
    if (!aiBlock) return 'custom';
    for (const [id, arch] of Object.entries(ARCHETYPES)) {
        const keys = archetypeDefinedKnobKeys(arch);
        if (keys.length < STRATEGY_KNOBS.length) continue;
        // Must include all strategy knobs
        if (!STRATEGY_KNOBS.every((k) => keys.includes(k))) continue;
        const matches = keys.every(
            (key) => Math.abs((aiBlock[key] ?? Number.NaN) - arch[key]) < MATCH_EPS
        );
        if (matches) return id;
    }
    return 'custom';
}

module.exports = {
    ARCHETYPES,
    KNOB_KEYS,
    UI_KNOB_KEYS,
    listArchetypes,
    getArchetype,
    getArchetypeValues,
    getArchetypeFullValues,
    archetypeDefinedKnobKeys,
    matchArchetype
};
