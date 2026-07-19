/**
 * Parent-side helpers for Engine Tweakings (no DOM binding — popup uses postMessage).
 */

/**
 * Load persisted AI strategy into Settings (no DOM required).
 * @param {object} Settings
 */
function loadPersistedAiStrategy(Settings) {
    Settings.AI.A = Settings.AI.A || Object.create(Settings.AI);
    Settings.AI.B = Settings.AI.B || Object.create(Settings.AI);
    const savedAISettings = localStorage.getItem('ai_strategy_settings_team_split')
        || localStorage.getItem('ai_strategy_settings');
    if (!savedAISettings) return;
    try {
        const saved = JSON.parse(savedAISettings);
        if (saved.A && saved.B) {
            Settings.AI.A = Object.assign(Settings.AI.A, saved.A);
            Settings.AI.B = Object.assign(Settings.AI.B, saved.B);
        } else {
            Settings.AI.A = Object.assign(Settings.AI.A, saved);
            Settings.AI.B = Object.assign(Settings.AI.B, saved);
        }
    } catch (e) {
        console.error('Error loading saved AI settings:', e);
    }
}

module.exports = {
    loadPersistedAiStrategy
};
