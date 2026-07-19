/**
 * Engine Tweakings popup page script (runs in the child window).
 * Talks to opener via postMessage; does not import the game engine.
 */
(function () {
    const CHANNEL = 'soccer-js-engine-tweaks';
    const KNOB_KEYS = [
        'FORMATION_HOLD',
        'ATTACK_SUPPORT_INTENSITY',
        'DEFENSIVE_PRESS_INTENSITY',
        'PASS_AGGRESSION'
    ];

    const parent = window.opener;
    if (!parent || parent.closed) {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.innerHTML =
                '<div class="p-4 text-warning">Open Engine Tweakings from the main Match Simulator page.</div>';
        });
        return;
    }

    let state = null;
    let suppress = false;

    function post(msg) {
        try {
            parent.postMessage({ channel: CHANNEL, ...msg }, window.location.origin);
        } catch (err) {
            console.warn('postMessage to parent failed', err);
        }
    }

    function byId(id) {
        return document.getElementById(id);
    }

    function applyStateToForm(s) {
        if (!s) return;
        suppress = true;
        state = s;

        const cam = s.camera || {};
        const scaleSlider = byId('scaleSlider');
        const scaleVal = byId('scaleVal');
        if (scaleSlider && scaleVal) {
            scaleSlider.value = cam.scale ?? 20;
            scaleVal.innerText = String(cam.scale ?? 20);
        }
        const ox = byId('offsetXSlider');
        const oxv = byId('offsetXVal');
        if (ox && oxv) {
            ox.value = cam.offsetX ?? 40;
            oxv.innerText = String(cam.offsetX ?? 40);
        }
        const oy = byId('offsetYSlider');
        const oyv = byId('offsetYVal');
        if (oy && oyv) {
            oy.value = cam.offsetY ?? 80;
            oyv.innerText = String(cam.offsetY ?? 80);
        }
        const camType = byId('cameraTypeSelect');
        if (camType) camType.value = cam.type || 'centered';
        const centered = (cam.type || 'centered') === 'centered';
        if (ox) ox.disabled = centered;
        if (oy) oy.disabled = centered;

        const matchDurationSlider = byId('matchDurationSlider');
        const matchDurationVal = byId('matchDurationVal');
        if (matchDurationSlider && matchDurationVal) {
            const mins = Math.round((s.MATCH_DURATION || 600) / 60);
            matchDurationSlider.value = mins;
            matchDurationVal.innerText = String(mins);
            matchDurationSlider.disabled = !!s.matchRunning;
        }

        const fieldSizeSlider = byId('fieldSizeSlider');
        const fieldSizeVal = byId('fieldSizeVal');
        if (fieldSizeSlider && fieldSizeVal) {
            const fs = s.FIELD_SIZE_MULTIPLIER || 1;
            fieldSizeSlider.value = fs;
            fieldSizeVal.innerText = Number(fs).toFixed(2);
            fieldSizeSlider.disabled = !!s.matchRunning;
        }

        const mute = byId('muteSoundToggle');
        if (mute) mute.checked = !!s.soundsMuted;

        const dyn = byId('dynamicStrategyToggle');
        if (dyn) dyn.checked = !!s.dynamicStrategyShifting;

        const ai = s.AI || {};
        for (const team of ['A', 'B']) {
            const block = ai[team] || {};
            const map = {
                FORMATION_HOLD: ['formationHoldSlider' + team, 'formationHoldVal' + team],
                ATTACK_SUPPORT_INTENSITY: ['attackSupportSlider' + team, 'attackSupportVal' + team],
                DEFENSIVE_PRESS_INTENSITY: ['defensivePressSlider' + team, 'defensivePressVal' + team],
                PASS_AGGRESSION: ['passAggressionSlider' + team, 'passAggressionVal' + team]
            };
            for (const key of KNOB_KEYS) {
                const ids = map[key];
                if (!ids) continue;
                const slider = byId(ids[0]);
                const valEl = byId(ids[1]);
                const v = typeof block[key] === 'number' ? block[key] : 0.5;
                if (slider) slider.value = v;
                if (valEl) valEl.innerText = v.toFixed(2);
            }
        }

        const dbg = s.debugAI || {};
        const master = byId('aiDebugEnabled');
        if (master) master.checked = !!dbg.enabled;
        document.querySelectorAll('.ai-debug-flag').forEach((el) => {
            const flag = el.getAttribute('data-flag');
            if (flag) el.checked = !!dbg[flag];
        });

        suppress = false;
    }

    function collectPatchFromEvent(target) {
        if (!target || !target.id) return null;
        const id = target.id;
        const patch = {};

        if (id === 'scaleSlider' || id === 'offsetXSlider' || id === 'offsetYSlider' || id === 'cameraTypeSelect') {
            patch.camera = {
                scale: parseInt(byId('scaleSlider')?.value, 10),
                offsetX: parseInt(byId('offsetXSlider')?.value, 10),
                offsetY: parseInt(byId('offsetYSlider')?.value, 10),
                type: byId('cameraTypeSelect')?.value || 'centered'
            };
            if (id === 'scaleSlider' && byId('scaleVal')) byId('scaleVal').innerText = byId('scaleSlider').value;
            if (id === 'offsetXSlider' && byId('offsetXVal')) byId('offsetXVal').innerText = byId('offsetXSlider').value;
            if (id === 'offsetYSlider' && byId('offsetYVal')) byId('offsetYVal').innerText = byId('offsetYSlider').value;
            if (id === 'cameraTypeSelect') {
                const centered = byId('cameraTypeSelect').value === 'centered';
                if (byId('offsetXSlider')) byId('offsetXSlider').disabled = centered;
                if (byId('offsetYSlider')) byId('offsetYSlider').disabled = centered;
            }
            return patch;
        }

        if (id === 'matchDurationSlider') {
            const mins = parseInt(byId('matchDurationSlider').value, 10);
            if (byId('matchDurationVal')) byId('matchDurationVal').innerText = String(mins);
            patch.MATCH_DURATION = mins * 60;
            return patch;
        }

        if (id === 'fieldSizeSlider') {
            const val = parseFloat(byId('fieldSizeSlider').value);
            if (byId('fieldSizeVal')) byId('fieldSizeVal').innerText = val.toFixed(2);
            patch.FIELD_SIZE_MULTIPLIER = val;
            return patch;
        }

        if (id === 'muteSoundToggle') {
            patch.soundsMuted = !!byId('muteSoundToggle').checked;
            return patch;
        }

        if (id === 'dynamicStrategyToggle') {
            patch.dynamicStrategyShifting = !!byId('dynamicStrategyToggle').checked;
            return patch;
        }

        if (id === 'aiDebugEnabled' || target.classList.contains('ai-debug-flag')) {
            const debugAI = {
                enabled: !!byId('aiDebugEnabled')?.checked,
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
            document.querySelectorAll('.ai-debug-flag').forEach((el) => {
                const flag = el.getAttribute('data-flag');
                if (flag) debugAI[flag] = !!el.checked;
            });
            if (target.classList.contains('ai-debug-flag') && target.checked) {
                debugAI.enabled = true;
                if (byId('aiDebugEnabled')) byId('aiDebugEnabled').checked = true;
            }
            patch.debugAI = debugAI;
            return patch;
        }

        // AI knobs
        const team = id.endsWith('A') ? 'A' : id.endsWith('B') ? 'B' : null;
        if (team) {
            const map = {
                ['formationHoldSlider' + team]: 'FORMATION_HOLD',
                ['attackSupportSlider' + team]: 'ATTACK_SUPPORT_INTENSITY',
                ['defensivePressSlider' + team]: 'DEFENSIVE_PRESS_INTENSITY',
                ['passAggressionSlider' + team]: 'PASS_AGGRESSION'
            };
            const key = map[id];
            if (key) {
                const val = parseFloat(target.value);
                const valId = id.replace('Slider', 'Val');
                if (byId(valId)) byId(valId).innerText = val.toFixed(2);
                patch.AI = { A: {}, B: {} };
                // send full current team knobs for simplicity
                for (const t of ['A', 'B']) {
                    patch.AI[t] = {
                        FORMATION_HOLD: parseFloat(byId('formationHoldSlider' + t)?.value || 0.55),
                        ATTACK_SUPPORT_INTENSITY: parseFloat(byId('attackSupportSlider' + t)?.value || 0.65),
                        DEFENSIVE_PRESS_INTENSITY: parseFloat(byId('defensivePressSlider' + t)?.value || 0.45),
                        PASS_AGGRESSION: parseFloat(byId('passAggressionSlider' + t)?.value || 0.55)
                    };
                }
                return patch;
            }
        }

        return null;
    }

    function emitFromEvent(e) {
        if (suppress) return;
        const patch = collectPatchFromEvent(e.target);
        if (patch) post({ type: 'patch', patch });
    }

    function initForm() {
        // Hide redundant page title inside card when already in popup chrome
        const title = document.querySelector('.engine-tweakings .card-title');
        if (title) title.classList.add('d-none');

        document.body.addEventListener('input', emitFromEvent);
        document.body.addEventListener('change', emitFromEvent);

        // Tooltips if bootstrap present
        if (typeof bootstrap !== 'undefined') {
            document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
                bootstrap.Tooltip.getOrCreateInstance(el, {
                    customClass: 'tweak-tooltip',
                    html: el.getAttribute('data-bs-html') === 'true',
                    trigger: 'hover focus'
                });
            });
        }

        // Ask parent for live Settings (source of truth) — do not trust HTML defaults
        post({ type: 'ready' });
    }

    // Parent may re-send state when focusing an already-open popup
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            post({ type: 'ready' });
        }
    });

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.channel !== CHANNEL) return;
        if (data.type === 'state' && data.state) {
            applyStateToForm(data.state);
        }
        if (data.type === 'strategy-shifted' && data.state) {
            applyStateToForm(data.state);
            const team = data.team;
            const badge = byId('team' + team + 'ShiftBadge');
            if (badge && data.archetypeId) {
                badge.innerText = String(data.archetypeId).toUpperCase().replace('_', ' ');
                badge.classList.remove('d-none');
            }
        }
    });

    window.addEventListener('beforeunload', () => {
        post({ type: 'closing' });
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initForm);
    } else {
        initForm();
    }
})();
