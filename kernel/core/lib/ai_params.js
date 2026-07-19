/**
 * AI parameter file loader (JSON defaults + named profiles for batch sweeps).
 *
 * Single loadable surface for batch sweeps and CLI:
 *   presets/ai_params.json  → defaults + named profiles
 *   batch config: aiParamsFile, aiProfile, ai / aiA / aiB (any known Settings.AI key)
 *
 * Live browser UI (localStorage knobs) remains the interactive layer and is
 * NOT auto-overwritten by this file. Headless/batch explicitly apply overrides.
 */
const path = require('path');
const { Settings } = require('../../settings.js');

const DEFAULT_AI_PARAMS_PATH = path.join(__dirname, '../../../presets/ai_params.json');

const {
    STRATEGY_KNOBS,
    ALL_UI_KNOBS,
    isValidKnobValue
} = require('./ai_ui_knobs.js');

/**
 * Keys currently defined on Settings.AI (own enumerable, excluding A/B).
 * @returns {string[]}
 */
function listSettingsAiKeys() {
    return Object.keys(Settings.AI).filter((k) => k !== 'A' && k !== 'B');
}

/**
 * Snapshot current Settings.AI base values (not team A/B prototypes).
 * @returns {Record<string, number|boolean|string>}
 */
function snapshotBaseAiParams() {
    const out = {};
    for (const key of listSettingsAiKeys()) {
        const v = Settings.AI[key];
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
            out[key] = v;
        }
    }
    return out;
}

/**
 * Flatten a params file object into a single defaults map.
 * Accepts: { defaults }, or { groups: { a:{}, b:{} } }, or a flat map.
 * @param {object|null} fileObj
 * @returns {Record<string, number|boolean|string>}
 */
function extractDefaultsMap(fileObj) {
    if (!fileObj || typeof fileObj !== 'object') return {};
    if (fileObj.defaults && typeof fileObj.defaults === 'object') {
        return Object.assign({}, fileObj.defaults);
    }
    if (fileObj.groups && typeof fileObj.groups === 'object') {
        const flat = {};
        for (const g of Object.values(fileObj.groups)) {
            if (g && typeof g === 'object') Object.assign(flat, g);
        }
        return flat;
    }
    // Flat map: skip meta/profiles/groups
    const flat = {};
    for (const [k, v] of Object.entries(fileObj)) {
        if (k === 'meta' || k === 'profiles' || k === 'groups' || k === 'defaults') continue;
        if (k.startsWith('_')) continue;
        if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
            flat[k] = v;
        }
    }
    return flat;
}

/**
 * @param {object|null} fileObj
 * @param {string} profileName
 * @returns {Record<string, number|boolean|string>}
 */
function extractProfileMap(fileObj, profileName) {
    if (!fileObj || !profileName || !fileObj.profiles) return {};
    const p = fileObj.profiles[profileName];
    return p && typeof p === 'object' ? Object.assign({}, p) : {};
}

/**
 * Keep only keys that exist on Settings.AI (or STRATEGY_KNOBS) with matching types.
 * @param {object|null} block
 * @returns {Record<string, number|boolean|string>|null}
 */
function normalizeAiParamsBlock(block) {
    if (!block || typeof block !== 'object') return null;
    const known = new Set(listSettingsAiKeys());
    for (const k of STRATEGY_KNOBS) known.add(k);
    for (const k of ALL_UI_KNOBS) known.add(k);

    const out = {};
    for (const [key, val] of Object.entries(block)) {
        if (key.startsWith('_') || key === 'A' || key === 'B') continue;
        if (!known.has(key) && Settings.AI[key] === undefined) continue;

        const current = Settings.AI[key];
        if (typeof val === 'number' && Number.isFinite(val)) {
            // Strategy knobs historically 0–1; UI shape knobs use published min/max
            if (STRATEGY_KNOBS.includes(key)) {
                if (val >= 0 && val <= 1) out[key] = val;
            } else if (ALL_UI_KNOBS.includes(key)) {
                if (isValidKnobValue(key, val)) out[key] = val;
            } else {
                out[key] = val;
            }
        } else if (typeof val === 'boolean') {
            if (current === undefined || typeof current === 'boolean') out[key] = val;
        } else if (typeof val === 'string' && (current === undefined || typeof current === 'string')) {
            out[key] = val;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Apply a flat param block onto Settings.AI base (own properties).
 * Does not recreate A/B unless rebindTeams is true.
 * @param {object|null} block
 * @param {{ rebindTeams?: boolean }} [opts]
 */
function applyAiParamsToBase(block, opts = {}) {
    const normalized = normalizeAiParamsBlock(block);
    if (!normalized) return null;
    for (const [key, val] of Object.entries(normalized)) {
        Settings.AI[key] = val;
    }
    if (opts.rebindTeams) {
        Settings.AI.A = Object.create(Settings.AI);
        Settings.AI.B = Object.create(Settings.AI);
    }
    return normalized;
}

/**
 * Apply per-team overrides onto Settings.AI.A / Settings.AI.B.
 * Ensures A/B exist as Object.create(Settings.AI) children.
 * @param {object|null} blockA
 * @param {object|null} blockB
 */
function applyAiParamsToTeams(blockA, blockB) {
    if (!Settings.AI.A || Object.getPrototypeOf(Settings.AI.A) !== Settings.AI) {
        Settings.AI.A = Object.create(Settings.AI);
    }
    if (!Settings.AI.B || Object.getPrototypeOf(Settings.AI.B) !== Settings.AI) {
        Settings.AI.B = Object.create(Settings.AI);
    }
    const a = normalizeAiParamsBlock(blockA);
    const b = normalizeAiParamsBlock(blockB);
    if (a) Object.assign(Settings.AI.A, a);
    if (b) Object.assign(Settings.AI.B, b);
    return { aiA: a, aiB: b };
}

/**
 * Load JSON params file (Node). Returns parsed object or null.
 * @param {string} [filePath]
 */
function loadAiParamsFile(filePath) {
    const fs = require('fs');
    const abs = path.resolve(filePath || DEFAULT_AI_PARAMS_PATH);
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/**
 * Full apply pipeline for batch / CLI.
 *
 * Order (later wins on base):
 *   1. File defaults (if aiParamsFile / loadDefaults)
 *   2. Named profile (aiProfile)
 *   3. Global `ai` block
 *   4. Rebind team prototypes from base
 *   5. aiA / aiB team overlays
 *
 * @param {{
 *   aiParamsFile?: string|null,
 *   aiParams?: object|null,
 *   aiProfile?: string|null,
 *   ai?: object|null,
 *   aiA?: object|null,
 *   aiB?: object|null,
 *   loadFileDefaults?: boolean
 * }} config
 * @returns {{ appliedBase: object, appliedA: object|null, appliedB: object|null, profile: string|null, sourceFile: string|null }}
 */
function applyAiParamsFromConfig(config = {}) {
    const report = {
        appliedBase: {},
        appliedA: null,
        appliedB: null,
        profile: config.aiProfile || null,
        sourceFile: null
    };

    let fileObj = config.aiParams && typeof config.aiParams === 'object'
        ? config.aiParams
        : null;

    if (!fileObj && config.aiParamsFile) {
        fileObj = loadAiParamsFile(config.aiParamsFile);
        report.sourceFile = path.resolve(config.aiParamsFile);
    } else if (!fileObj && config.loadFileDefaults) {
        fileObj = loadAiParamsFile(DEFAULT_AI_PARAMS_PATH);
        report.sourceFile = DEFAULT_AI_PARAMS_PATH;
    }

    const layers = [];
    if (fileObj) {
        layers.push(extractDefaultsMap(fileObj));
        if (config.aiProfile) {
            layers.push(extractProfileMap(fileObj, config.aiProfile));
        }
    }
    if (config.ai) layers.push(config.ai);

    const mergedBase = {};
    for (const layer of layers) {
        const n = normalizeAiParamsBlock(layer);
        if (n) Object.assign(mergedBase, n);
    }

    if (Object.keys(mergedBase).length) {
        applyAiParamsToBase(mergedBase, { rebindTeams: true });
        report.appliedBase = mergedBase;
    } else {
        // Still ensure clean team prototypes from current base
        Settings.AI.A = Object.create(Settings.AI);
        Settings.AI.B = Object.create(Settings.AI);
    }

    const teams = applyAiParamsToTeams(config.aiA, config.aiB);
    report.appliedA = teams.aiA;
    report.appliedB = teams.aiB;

    return report;
}

/**
 * Resolve batch-friendly AI fields from raw config (expand profiles, normalize).
 * @param {object} cfg - mutable mergeConfig result
 * @returns {object} cfg
 */
function resolveBatchAiConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return cfg;

    // Allow ai: "profileName" shorthand
    if (typeof cfg.ai === 'string') {
        cfg.aiProfile = cfg.aiProfile || cfg.ai;
        cfg.ai = null;
    }

    cfg.ai = normalizeAiParamsBlock(cfg.ai);
    cfg.aiA = normalizeAiParamsBlock(cfg.aiA);
    cfg.aiB = normalizeAiParamsBlock(cfg.aiB);

    if (cfg.aiParamsFile != null && typeof cfg.aiParamsFile !== 'string') {
        cfg.aiParamsFile = null;
    }
    if (cfg.aiProfile != null && typeof cfg.aiProfile !== 'string') {
        cfg.aiProfile = null;
    }

    return cfg;
}

module.exports = {
    DEFAULT_AI_PARAMS_PATH,
    STRATEGY_KNOBS,
    ALL_UI_KNOBS,
    listSettingsAiKeys,
    snapshotBaseAiParams,
    extractDefaultsMap,
    extractProfileMap,
    normalizeAiParamsBlock,
    applyAiParamsToBase,
    applyAiParamsToTeams,
    loadAiParamsFile,
    applyAiParamsFromConfig,
    resolveBatchAiConfig
};
