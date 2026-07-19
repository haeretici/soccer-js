const ARCHETYPES = require('../../../presets/ai_archetypes.json');

const KNOB_KEYS = [
    'FORMATION_HOLD',
    'ATTACK_SUPPORT_INTENSITY',
    'DEFENSIVE_PRESS_INTENSITY',
    'PASS_AGGRESSION'
];

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
    listArchetypes,
    getArchetype,
    getArchetypeValues,
    matchArchetype
};