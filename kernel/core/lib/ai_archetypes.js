const ARCHETYPES = require('../../../presets/ai_archetypes.json');
const {
    STRATEGY_KNOBS,
    ALL_UI_KNOBS
} = require('./ai_ui_knobs.js');

/** Classic four knobs used by archetypes / dynamic late-game shifts. */
const KNOB_KEYS = STRATEGY_KNOBS.slice();

/** All Engine Tweakings team-split knobs (strategy + attack shape). */
const UI_KNOB_KEYS = ALL_UI_KNOBS.slice();

function listArchetypes() {
    return Object.entries(ARCHETYPES)
        .map(([id, arch]) => ({ id, label: arch.label, description: arch.description }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

function getArchetype(id) {
    if (!id || id === 'custom') return null;
    return ARCHETYPES[id] || null;
}

function getArchetypeValues(id) {
    const arch = getArchetype(id);
    if (!arch) return null;
    return KNOB_KEYS.reduce((out, key) => {
        out[key] = arch[key];
        return out;
    }, {});
}

function matchArchetype(aiBlock) {
    if (!aiBlock) return 'custom';
    for (const [id, arch] of Object.entries(ARCHETYPES)) {
        const matches = KNOB_KEYS.every((key) => Math.abs((aiBlock[key] ?? -1) - arch[key]) < 0.001);
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
    matchArchetype
};