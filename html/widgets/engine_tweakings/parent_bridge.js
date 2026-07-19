/**
 * Parent-side bridge: open Engine Tweakings as a real browser popup and apply
 * settings received via postMessage (same Settings object as the running match).
 */
const {
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME,
    ENGINE_TWEAKS_URL
} = require('./protocol.js');
const {
    ALL_UI_KNOBS,
    isValidKnobValue,
    readTeamUiKnobs
} = require('../../../kernel/core/lib/ai_ui_knobs.js');

/**
 * @param {{ Settings: object, Application: object }} ctx
 */
function createEngineTweakingsParentBridge(ctx) {
    const { Settings, Application } = ctx;
    let popup = null;
    let bound = false;

    function isMatchRunning() {
        return Application.gameStatus === 'running' || Application.gameStatus === 'paused';
    }

    function snapshotState() {
        Settings.AI.A = Settings.AI.A || Object.create(Settings.AI);
        Settings.AI.B = Settings.AI.B || Object.create(Settings.AI);
        if (!Settings.debugAI) {
            Settings.debugAI = {
                enabled: false,
                supportSpots: false,
                regions: false,
                homeTargets: false,
                roles: false,
                states: false,
                threatened: false,
                passLanes: false,
                positionTrace: false,
                marking: false,
                playPhase: false,
                freekickWall: false,
                offsideLine: false,
                predictedPath: false,
                goalMouth: false
            };
        }
        // Read live AI values (strategy + attack shape; own props on A/B, else base)
        const readTeam = (team) => readTeamUiKnobs(Settings.AI[team] || Settings.AI, Settings.AI);
        return {
            camera: {
                scale: Settings.camera?.scale ?? Settings.BASE_SCALE,
                offsetX: Settings.camera?.offsetX ?? 40,
                offsetY: Settings.camera?.offsetY ?? 80,
                type: Settings.camera?.type ?? 'centered'
            },
            MATCH_DURATION: Settings.MATCH_DURATION,
            FIELD_SIZE_MULTIPLIER: Settings.FIELD_SIZE_MULTIPLIER,
            soundsMuted: !!Settings.soundsMuted,
            dynamicStrategyShifting: !!Settings.AI.dynamicStrategyShifting,
            debugAI: { ...Settings.debugAI },
            AI: {
                A: readTeam('A'),
                B: readTeam('B')
            },
            matchRunning: isMatchRunning()
        };
    }

    function postToPopup(msg) {
        if (!popup || popup.closed) return;
        try {
            popup.postMessage(
                { channel: ENGINE_TWEAKS_CHANNEL, ...msg },
                window.location.origin
            );
        } catch (err) {
            console.warn('Engine tweakings postMessage failed:', err);
        }
    }

    function sendState() {
        postToPopup({ type: 'state', state: snapshotState() });
    }

    function applyMessage(data, source) {
        if (!data || data.channel !== ENGINE_TWEAKS_CHANNEL) return;
        switch (data.type) {
            case 'ready':
                // Always re-bind popup to the message source (handles reloads / second open)
                if (source && source === popup) {
                    sendState();
                } else if (source && (!popup || popup.closed)) {
                    popup = source;
                    sendState();
                } else if (source) {
                    popup = source;
                    sendState();
                }
                break;
            case 'patch':
                applyPatch(data.patch || {});
                // Echo only when not mid-reload noise — parent is source of truth
                sendState();
                break;
            case 'closing':
                // Do NOT null popup here if the window is still open (location reload
                // fires beforeunload → closing, which used to drop the ref and break
                // the next ready → state handshake).
                if (!popup || popup.closed || (source && source !== popup)) {
                    if (popup && popup.closed) popup = null;
                } else {
                    // Defer: if still closed after navigation settles, clear ref
                    const ref = popup;
                    setTimeout(() => {
                        if (popup === ref && popup.closed) popup = null;
                    }, 250);
                }
                break;
            default:
                break;
        }
    }

    function applyPatch(patch) {
        if (!Settings.camera) Settings.camera = {};

        if (patch.camera && typeof patch.camera === 'object') {
            if (typeof patch.camera.scale === 'number' && !Number.isNaN(patch.camera.scale)) {
                Settings.camera.scale = patch.camera.scale;
            }
            if (typeof patch.camera.offsetX === 'number' && !Number.isNaN(patch.camera.offsetX)) {
                Settings.camera.offsetX = patch.camera.offsetX;
            }
            if (typeof patch.camera.offsetY === 'number' && !Number.isNaN(patch.camera.offsetY)) {
                Settings.camera.offsetY = patch.camera.offsetY;
            }
            if (typeof patch.camera.type === 'string') Settings.camera.type = patch.camera.type;
            try {
                localStorage.setItem('camera_settings', JSON.stringify(Settings.camera));
            } catch (_) { /* ignore */ }
        }

        if (typeof patch.MATCH_DURATION === 'number' && !isMatchRunning()) {
            Settings.MATCH_DURATION = patch.MATCH_DURATION;
            try {
                localStorage.setItem('match_duration', String(Settings.MATCH_DURATION));
            } catch (_) { /* ignore */ }
            if (Application.currentLevel && typeof Application.currentLevel.readConfig === 'function') {
                Application.currentLevel.readConfig();
            }
        }

        if (typeof patch.FIELD_SIZE_MULTIPLIER === 'number' && !isMatchRunning()) {
            Settings.FIELD_SIZE_MULTIPLIER = patch.FIELD_SIZE_MULTIPLIER;
            try {
                localStorage.setItem('field_size_multiplier', String(Settings.FIELD_SIZE_MULTIPLIER));
            } catch (_) { /* ignore */ }
            if (Application.currentLevel && typeof Application.currentLevel.recalculateReferencePositions === 'function') {
                Application.currentLevel.recalculateReferencePositions();
            }
        }

        if (typeof patch.soundsMuted === 'boolean') {
            Settings.soundsMuted = patch.soundsMuted;
            try {
                localStorage.setItem('sounds_muted', Settings.soundsMuted ? 'true' : 'false');
            } catch (_) { /* ignore */ }
            try {
                const { SoundDB } = require('../../../kernel/core/lib/sounddb.js');
                if (Settings.soundsMuted) {
                    SoundDB.stopCrowd();
                } else if (Application.gameStatus === 'running') {
                    SoundDB.resume();
                    SoundDB.startCrowd();
                }
            } catch (_) { /* ignore audio errors */ }
        }

        if (typeof patch.dynamicStrategyShifting === 'boolean') {
            Settings.AI.dynamicStrategyShifting = patch.dynamicStrategyShifting;
            try {
                localStorage.setItem(
                    'dynamic_strategy_shifting',
                    Settings.AI.dynamicStrategyShifting ? 'true' : 'false'
                );
            } catch (_) { /* ignore */ }
        }

        if (patch.debugAI && typeof patch.debugAI === 'object') {
            Settings.debugAI = Settings.debugAI || {};
            Object.assign(Settings.debugAI, patch.debugAI);
            try {
                localStorage.setItem('ai_debug_overlays', JSON.stringify(Settings.debugAI));
            } catch (_) { /* ignore */ }
        }

        if (patch.AI && typeof patch.AI === 'object') {
            for (const team of ['A', 'B']) {
                if (!patch.AI[team]) continue;
                Settings.AI[team] = Settings.AI[team] || Object.create(Settings.AI);
                for (const key of ALL_UI_KNOBS) {
                    const val = patch.AI[team][key];
                    if (!isValidKnobValue(key, val)) continue;
                    if (Application.currentLevel && typeof Application.currentLevel.updateBaseStrategyValue === 'function') {
                        Application.currentLevel.updateBaseStrategyValue(team, key, val);
                    } else {
                        Settings.AI[team][key] = val;
                    }
                }
            }
            try {
                const payload = {
                    A: readTeamUiKnobs(Settings.AI.A, Settings.AI),
                    B: readTeamUiKnobs(Settings.AI.B, Settings.AI)
                };
                localStorage.setItem('ai_strategy_settings_team_split', JSON.stringify(payload));
            } catch (_) { /* ignore */ }
        }
    }

    function onMessage(event) {
        if (event.origin !== window.location.origin) return;
        // If we know the popup, ignore other windows; if popup was cleared mid-reload, still accept ready
        if (popup && !popup.closed && event.source && event.source !== popup) return;
        applyMessage(event.data, event.source);
    }

    function bindListeners() {
        if (bound) return;
        bound = true;
        window.addEventListener('message', onMessage);
        const closePopup = () => {
            if (popup && !popup.closed) {
                try { popup.close(); } catch (_) { /* ignore */ }
            }
            popup = null;
        };
        window.addEventListener('beforeunload', closePopup);
        window.addEventListener('pagehide', closePopup);
    }

    /**
     * Open popup, or if already open: focus + re-send live Settings (no full reload).
     * Full reload used to fire "closing" and drop the parent ref → wrong defaults on 2nd open.
     */
    function open() {
        bindListeners();

        if (popup && !popup.closed) {
            try {
                popup.focus();
            } catch (_) { /* ignore */ }
            // Re-sync from live Settings (source of truth) without navigating away
            sendState();
            return popup;
        }

        const features = [
            'width=860',
            'height=920',
            'menubar=no',
            'toolbar=no',
            'location=no',
            'status=no',
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');

        popup = window.open(ENGINE_TWEAKS_URL, ENGINE_TWEAKS_WINDOW_NAME, features);
        if (!popup) {
            console.warn('Engine Tweakings popup blocked — allow popups for this site.');
            return null;
        }
        try { popup.focus(); } catch (_) { /* ignore */ }
        return popup;
    }

    function notifyMatchRunningChanged() {
        sendState();
    }

    function notifyStrategyShift(team, archetypeId) {
        postToPopup({
            type: 'strategy-shifted',
            team,
            archetypeId,
            state: snapshotState()
        });
    }

    return {
        open,
        sendState,
        notifyMatchRunningChanged,
        notifyStrategyShift,
        get popup() { return popup; }
    };
}

module.exports = {
    createEngineTweakingsParentBridge,
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME,
    ENGINE_TWEAKS_URL
};
