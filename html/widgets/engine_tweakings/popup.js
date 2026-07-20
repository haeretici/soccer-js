/**
 * Engine Tweakings popup page script (runs in the child window).
 * Talks to opener via postMessage; does not import the game engine.
 */
(function () {
    const CHANNEL = 'soccer-js-engine-tweaks';
    /** Strategy knobs (also used by late-game dynamic shifts). */
    const STRATEGY_KNOB_KEYS = [
        'FORMATION_HOLD',
        'ATTACK_SUPPORT_INTENSITY',
        'DEFENSIVE_PRESS_INTENSITY',
        'PASS_AGGRESSION'
    ];
    /** All team-split knobs sent to parent (strategy + attack shape). Presets apply both. */
    const KNOB_KEYS = [
        'FORMATION_HOLD',
        'ATTACK_SUPPORT_INTENSITY',
        'DEFENSIVE_PRESS_INTENSITY',
        'PASS_AGGRESSION',
        'ATTACK_DEPTH_BIAS_REF',
        'ATTACK_REGION_COL_DELTA',
        'ATTACK_ROLE_REGION_BIAS',
        'ATTACK_SUPPORT_OWN_HALF_BLEND',
        'ATTACK_SUPPORT_FORM_PULL',
        'ATTACK_SUPPORT_PUSH_SCALE',
        'SUPPORT_WIDTH'
    ];
    const KNOB_DECIMALS = {
        FORMATION_HOLD: 2,
        ATTACK_SUPPORT_INTENSITY: 2,
        DEFENSIVE_PRESS_INTENSITY: 2,
        PASS_AGGRESSION: 2,
        ATTACK_DEPTH_BIAS_REF: 1,
        ATTACK_REGION_COL_DELTA: 0,
        ATTACK_ROLE_REGION_BIAS: 0,
        ATTACK_SUPPORT_OWN_HALF_BLEND: 2,
        ATTACK_SUPPORT_FORM_PULL: 2,
        ATTACK_SUPPORT_PUSH_SCALE: 2,
        SUPPORT_WIDTH: 2
    };
    const KNOB_DEFAULTS = {
        FORMATION_HOLD: 0.55,
        ATTACK_SUPPORT_INTENSITY: 0.65,
        DEFENSIVE_PRESS_INTENSITY: 0.45,
        PASS_AGGRESSION: 0.55,
        ATTACK_DEPTH_BIAS_REF: 7.5,
        ATTACK_REGION_COL_DELTA: 1,
        ATTACK_ROLE_REGION_BIAS: 1,
        ATTACK_SUPPORT_OWN_HALF_BLEND: 0.35,
        ATTACK_SUPPORT_FORM_PULL: 1.0,
        ATTACK_SUPPORT_PUSH_SCALE: 1.0,
        SUPPORT_WIDTH: 0.55
    };
    const AI_SLIDER_IDS = {
        A: {
            FORMATION_HOLD: 'formationHoldSliderA',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportSliderA',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressSliderA',
            PASS_AGGRESSION: 'passAggressionSliderA',
            ATTACK_DEPTH_BIAS_REF: 'attackDepthSliderA',
            ATTACK_REGION_COL_DELTA: 'attackRegionShiftSliderA',
            ATTACK_ROLE_REGION_BIAS: 'attackRoleBiasSliderA',
            ATTACK_SUPPORT_OWN_HALF_BLEND: 'ownHalfSupportSliderA',
            ATTACK_SUPPORT_FORM_PULL: 'supportFormPullSliderA',
            ATTACK_SUPPORT_PUSH_SCALE: 'supportPushScaleSliderA',
            SUPPORT_WIDTH: 'supportWidthSliderA'
        },
        B: {
            FORMATION_HOLD: 'formationHoldSliderB',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportSliderB',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressSliderB',
            PASS_AGGRESSION: 'passAggressionSliderB',
            ATTACK_DEPTH_BIAS_REF: 'attackDepthSliderB',
            ATTACK_REGION_COL_DELTA: 'attackRegionShiftSliderB',
            ATTACK_ROLE_REGION_BIAS: 'attackRoleBiasSliderB',
            ATTACK_SUPPORT_OWN_HALF_BLEND: 'ownHalfSupportSliderB',
            ATTACK_SUPPORT_FORM_PULL: 'supportFormPullSliderB',
            ATTACK_SUPPORT_PUSH_SCALE: 'supportPushScaleSliderB',
            SUPPORT_WIDTH: 'supportWidthSliderB'
        }
    };
    const AI_VAL_IDS = {
        A: {
            FORMATION_HOLD: 'formationHoldValA',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportValA',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressValA',
            PASS_AGGRESSION: 'passAggressionValA',
            ATTACK_DEPTH_BIAS_REF: 'attackDepthValA',
            ATTACK_REGION_COL_DELTA: 'attackRegionShiftValA',
            ATTACK_ROLE_REGION_BIAS: 'attackRoleBiasValA',
            ATTACK_SUPPORT_OWN_HALF_BLEND: 'ownHalfSupportValA',
            ATTACK_SUPPORT_FORM_PULL: 'supportFormPullValA',
            ATTACK_SUPPORT_PUSH_SCALE: 'supportPushScaleValA',
            SUPPORT_WIDTH: 'supportWidthValA'
        },
        B: {
            FORMATION_HOLD: 'formationHoldValB',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportValB',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressValB',
            PASS_AGGRESSION: 'passAggressionValB',
            ATTACK_DEPTH_BIAS_REF: 'attackDepthValB',
            ATTACK_REGION_COL_DELTA: 'attackRegionShiftValB',
            ATTACK_ROLE_REGION_BIAS: 'attackRoleBiasValB',
            ATTACK_SUPPORT_OWN_HALF_BLEND: 'ownHalfSupportValB',
            ATTACK_SUPPORT_FORM_PULL: 'supportFormPullValB',
            ATTACK_SUPPORT_PUSH_SCALE: 'supportPushScaleValB',
            SUPPORT_WIDTH: 'supportWidthValB'
        }
    };

    function formatKnob(key, val) {
        const d = KNOB_DECIMALS[key] != null ? KNOB_DECIMALS[key] : 2;
        return Number(val).toFixed(d);
    }

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
    let aiArchetypes = {};
    let archetypesReady = false;

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

    function readTeamAI(team) {
        const out = {};
        for (const key of KNOB_KEYS) {
            const slider = byId(AI_SLIDER_IDS[team][key]);
            out[key] = slider
                ? parseFloat(slider.value)
                : (KNOB_DEFAULTS[key] != null ? KNOB_DEFAULTS[key] : 0.5);
        }
        return out;
    }

    function collectBothTeamsAI() {
        return { A: readTeamAI('A'), B: readTeamAI('B') };
    }

    function matchArchetype(aiBlock) {
        for (const [id, arch] of Object.entries(aiArchetypes)) {
            // Strategy required; shape only when the preset defines it
            const keys = KNOB_KEYS.filter(
                (key) => typeof arch[key] === 'number' && Number.isFinite(arch[key])
            );
            if (!STRATEGY_KNOB_KEYS.every((k) => keys.includes(k))) continue;
            const matches = keys.every(
                (key) => Math.abs((aiBlock[key] ?? Number.NaN) - arch[key]) < 0.001
            );
            if (matches) return id;
        }
        return 'custom';
    }

    function updateArchetypeDescription(team, archId) {
        const row = byId('aiArchetypeDescRow' + team);
        const textarea = byId('aiArchetypeDesc' + team);
        if (!row || !textarea) return;

        if (archId && archId !== 'custom') {
            const arch = aiArchetypes[archId];
            textarea.value = arch ? arch.description : '';
            row.classList.remove('d-none');
        } else {
            textarea.value = '';
            row.classList.add('d-none');
        }
    }

    function syncArchetypeSelect(team) {
        const select = byId('aiArchetypeSelect' + team);
        if (!select) return;
        const archId = matchArchetype(readTeamAI(team));
        select.value = archId;
        updateArchetypeDescription(team, archId);
    }

    function populateArchetypeSelect(select) {
        if (!select) return;
        // Keep the existing "Custom" option; append presets once
        const existing = new Set(Array.from(select.options).map((o) => o.value));
        Object.entries(aiArchetypes)
            .sort((a, b) => a[1].label.localeCompare(b[1].label))
            .forEach(([id, arch]) => {
                if (existing.has(id)) return;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = arch.label;
                select.appendChild(opt);
            });
    }

    function applyArchetypeToSliders(team, archetypeId) {
        const arch = aiArchetypes[archetypeId];
        if (!arch) return false;
        // Full preset: strategy + attack shape (any numeric knob defined on the archetype)
        for (const key of KNOB_KEYS) {
            if (typeof arch[key] !== 'number' || !Number.isFinite(arch[key])) continue;
            const slider = byId(AI_SLIDER_IDS[team][key]);
            const valEl = byId(AI_VAL_IDS[team][key]);
            if (slider) slider.value = arch[key];
            if (valEl) valEl.innerText = formatKnob(key, arch[key]);
        }
        updateArchetypeDescription(team, archetypeId);
        return true;
    }

    async function loadArchetypes() {
        try {
            // Relative to this page (html/widgets/engine_tweakings/) → repo root
            const res = await fetch('../../../presets/ai_archetypes.json', { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            aiArchetypes = await res.json();
        } catch (err) {
            console.error('Failed to load AI archetypes:', err);
            aiArchetypes = {};
        }
        populateArchetypeSelect(byId('aiArchetypeSelectA'));
        populateArchetypeSelect(byId('aiArchetypeSelectB'));
        archetypesReady = true;
        // Re-sync selects if parent already pushed state
        if (state && state.AI) {
            suppress = true;
            syncArchetypeSelect('A');
            syncArchetypeSelect('B');
            suppress = false;
        }
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
            for (const key of KNOB_KEYS) {
                const slider = byId(AI_SLIDER_IDS[team][key]);
                const valEl = byId(AI_VAL_IDS[team][key]);
                const v = typeof block[key] === 'number'
                    ? block[key]
                    : (KNOB_DEFAULTS[key] != null ? KNOB_DEFAULTS[key] : 0.5);
                if (slider) slider.value = v;
                if (valEl) valEl.innerText = formatKnob(key, v);
            }
            if (archetypesReady) syncArchetypeSelect(team);
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

        // AI archetype preset select
        if (id === 'aiArchetypeSelectA' || id === 'aiArchetypeSelectB') {
            const team = id.endsWith('A') ? 'A' : 'B';
            const archId = target.value;
            if (archId && archId !== 'custom') {
                if (!applyArchetypeToSliders(team, archId)) return null;
            } else {
                updateArchetypeDescription(team, 'custom');
            }
            patch.AI = collectBothTeamsAI();
            return patch;
        }

        // AI knobs (strategy + attack shape)
        const team = id.endsWith('A') ? 'A' : id.endsWith('B') ? 'B' : null;
        if (team) {
            const map = {
                ['formationHoldSlider' + team]: 'FORMATION_HOLD',
                ['attackSupportSlider' + team]: 'ATTACK_SUPPORT_INTENSITY',
                ['defensivePressSlider' + team]: 'DEFENSIVE_PRESS_INTENSITY',
                ['passAggressionSlider' + team]: 'PASS_AGGRESSION',
                ['attackDepthSlider' + team]: 'ATTACK_DEPTH_BIAS_REF',
                ['attackRegionShiftSlider' + team]: 'ATTACK_REGION_COL_DELTA',
                ['attackRoleBiasSlider' + team]: 'ATTACK_ROLE_REGION_BIAS',
                ['ownHalfSupportSlider' + team]: 'ATTACK_SUPPORT_OWN_HALF_BLEND',
                ['supportFormPullSlider' + team]: 'ATTACK_SUPPORT_FORM_PULL',
                ['supportPushScaleSlider' + team]: 'ATTACK_SUPPORT_PUSH_SCALE',
                ['supportWidthSlider' + team]: 'SUPPORT_WIDTH'
            };
            const key = map[id];
            if (key) {
                const val = parseFloat(target.value);
                const valEl = byId(AI_VAL_IDS[team][key]);
                if (valEl) valEl.innerText = formatKnob(key, val);
                // Any UI knob can break / restore a full preset match (incl. shape)
                if (archetypesReady) syncArchetypeSelect(team);
                patch.AI = collectBothTeamsAI();
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

        // Preset list from same JSON as batch builder
        loadArchetypes();

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
