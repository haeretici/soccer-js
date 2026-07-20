const { appUrl } = require('../core/lib/app_paths.js');

async function initBatchBuilderApp() {
    /** Strategy knobs exposed as batch-builder sliders. */
    const STRATEGY_KNOBS = [
        'FORMATION_HOLD',
        'ATTACK_SUPPORT_INTENSITY',
        'DEFENSIVE_PRESS_INTENSITY',
        'PASS_AGGRESSION'
    ];
    /** Attack-shape knobs carried from full presets into batch JSON (no sliders in this UI). */
    const SHAPE_KNOBS = [
        'ATTACK_DEPTH_BIAS_REF',
        'ATTACK_REGION_COL_DELTA',
        'ATTACK_ROLE_REGION_BIAS',
        'ATTACK_SUPPORT_OWN_HALF_BLEND',
        'ATTACK_SUPPORT_FORM_PULL',
        'ATTACK_SUPPORT_PUSH_SCALE',
        'SUPPORT_WIDTH'
    ];
    const ALL_UI_KNOBS = STRATEGY_KNOBS.concat(SHAPE_KNOBS);

    const STRATEGY_DEFAULTS = {
        FORMATION_HOLD: 0.55,
        ATTACK_SUPPORT_INTENSITY: 0.65,
        DEFENSIVE_PRESS_INTENSITY: 0.45,
        PASS_AGGRESSION: 0.55
    };
    const SHAPE_DEFAULTS = {
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
            FORMATION_HOLD: 'formationHoldA',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportA',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressA',
            PASS_AGGRESSION: 'passAggressionA'
        },
        B: {
            FORMATION_HOLD: 'formationHoldB',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportB',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressB',
            PASS_AGGRESSION: 'passAggressionB'
        }
    };
    const AI_LABEL_IDS = {
        A: {
            FORMATION_HOLD: 'formationHoldLblA',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportLblA',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressLblA',
            PASS_AGGRESSION: 'passAggressionLblA'
        },
        B: {
            FORMATION_HOLD: 'formationHoldLblB',
            ATTACK_SUPPORT_INTENSITY: 'attackSupportLblB',
            DEFENSIVE_PRESS_INTENSITY: 'defensivePressLblB',
            PASS_AGGRESSION: 'passAggressionLblB'
        }
    };

    const fields = [
        'iterations', 'seed', 'concurrency', 'teamA', 'teamB', 'formationA', 'formationB',
        'matchDurationSeconds', 'fieldSizeMultiplier', 'outputDir',
        'formationHoldA', 'attackSupportA', 'defensivePressA', 'passAggressionA',
        'formationHoldB', 'attackSupportB', 'defensivePressB', 'passAggressionB'
    ];

    /** Full AI blocks for batch export (strategy sliders + shape from last preset). */
    const teamAiFull = {
        A: Object.assign({}, STRATEGY_DEFAULTS, SHAPE_DEFAULTS),
        B: Object.assign({}, STRATEGY_DEFAULTS, SHAPE_DEFAULTS)
    };

    let aiArchetypes = {};
    try {
        const archRes = await fetch(appUrl('presets/ai_archetypes.json'));
        aiArchetypes = await archRes.json();
    } catch (e) {
        console.error('Failed to load AI archetypes:', e);
    }

    const archetypeSelectA = document.getElementById('aiArchetypeA');
    const archetypeSelectB = document.getElementById('aiArchetypeB');

    function populateArchetypeSelect(select) {
        if (!select) return;
        Object.entries(aiArchetypes)
            .sort((a, b) => a[1].label.localeCompare(b[1].label))
            .forEach(([id, arch]) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = arch.label;
                select.appendChild(opt);
            });
    }

    populateArchetypeSelect(archetypeSelectA);
    populateArchetypeSelect(archetypeSelectB);

    function readStrategyFromSliders(team) {
        return STRATEGY_KNOBS.reduce((out, key) => {
            const sliderId = AI_SLIDER_IDS[team][key];
            const el = document.getElementById(sliderId);
            out[key] = el ? parseFloat(el.value) : STRATEGY_DEFAULTS[key];
            return out;
        }, {});
    }

    /** Sync strategy slider values into the full AI block (keeps shape). */
    function pullStrategySlidersIntoFull(team) {
        Object.assign(teamAiFull[team], readStrategyFromSliders(team));
    }

    function matchArchetype(aiBlock) {
        for (const [id, arch] of Object.entries(aiArchetypes)) {
            const keys = ALL_UI_KNOBS.filter(
                (key) => typeof arch[key] === 'number' && Number.isFinite(arch[key])
            );
            if (!STRATEGY_KNOBS.every((k) => keys.includes(k))) continue;
            const matches = keys.every(
                (key) => Math.abs((aiBlock[key] ?? Number.NaN) - arch[key]) < 0.001
            );
            if (matches) return id;
        }
        return 'custom';
    }

    function updateArchetypeDescription(team, archId) {
        const row = document.getElementById(`aiArchetypeDescRow${team}`);
        const textarea = document.getElementById(`aiArchetypeDesc${team}`);
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
        const select = team === 'A' ? archetypeSelectA : archetypeSelectB;
        if (!select) return;
        pullStrategySlidersIntoFull(team);
        const archId = matchArchetype(teamAiFull[team]);
        select.value = archId;
        updateArchetypeDescription(team, archId);
    }

    function applyArchetype(team, archetypeId) {
        const arch = aiArchetypes[archetypeId];
        if (!arch) return;
        for (const key of ALL_UI_KNOBS) {
            if (typeof arch[key] !== 'number' || !Number.isFinite(arch[key])) continue;
            teamAiFull[team][key] = arch[key];
            if (STRATEGY_KNOBS.includes(key)) {
                const slider = document.getElementById(AI_SLIDER_IDS[team][key]);
                const label = document.getElementById(AI_LABEL_IDS[team][key]);
                if (slider) slider.value = arch[key];
                if (label) label.textContent = Number(arch[key]).toFixed(2);
            }
        }
        updateArchetypeDescription(team, archetypeId);
        updatePreview();
        saveBatchAiPrefs();
    }

    function saveBatchAiPrefs() {
        try {
            pullStrategySlidersIntoFull('A');
            pullStrategySlidersIntoFull('B');
            localStorage.setItem('sim_batch_ai_prefs', JSON.stringify({
                aiA: Object.assign({}, teamAiFull.A),
                aiB: Object.assign({}, teamAiFull.B),
                archetypeA: archetypeSelectA ? archetypeSelectA.value : 'custom',
                archetypeB: archetypeSelectB ? archetypeSelectB.value : 'custom'
            }));
        } catch (e) {
            console.warn('Could not save batch AI prefs:', e);
        }
    }

    function loadBatchAiPrefs() {
        try {
            const raw = localStorage.getItem('sim_batch_ai_prefs');
            if (!raw) return;
            const prefs = JSON.parse(raw);
            for (const team of ['A', 'B']) {
                const block = team === 'A' ? prefs.aiA : prefs.aiB;
                if (!block) continue;
                for (const key of ALL_UI_KNOBS) {
                    if (typeof block[key] === 'number' && Number.isFinite(block[key])) {
                        teamAiFull[team][key] = block[key];
                    }
                }
                for (const key of STRATEGY_KNOBS) {
                    if (typeof teamAiFull[team][key] !== 'number') continue;
                    const slider = document.getElementById(AI_SLIDER_IDS[team][key]);
                    const label = document.getElementById(AI_LABEL_IDS[team][key]);
                    if (slider) slider.value = teamAiFull[team][key];
                    if (label) label.textContent = Number(teamAiFull[team][key]).toFixed(2);
                }
            }
            if (archetypeSelectA && prefs.archetypeA) archetypeSelectA.value = prefs.archetypeA;
            if (archetypeSelectB && prefs.archetypeB) archetypeSelectB.value = prefs.archetypeB;
            // Re-apply full preset if select points at a known id (restores shape knobs)
            for (const team of ['A', 'B']) {
                const select = team === 'A' ? archetypeSelectA : archetypeSelectB;
                if (select && select.value && select.value !== 'custom' && aiArchetypes[select.value]) {
                    applyArchetype(team, select.value);
                } else {
                    syncArchetypeSelect(team);
                }
            }
        } catch (e) {
            console.warn('Could not load batch AI prefs:', e);
        }
    }

    const teamASelect = document.getElementById('teamA');
    const teamBSelect = document.getElementById('teamB');

    let palettes = {};
    try {
        const res = await fetch(appUrl('presets/palettes.json'));
        palettes = await res.json();
    } catch (e) {
        console.error('Failed to load palettes JSON:', e);
        palettes = {
            Brazil: { flag: 'br' },
            Argentina: { flag: 'ar' }
        };
    }

    const teamNames = Object.keys(palettes).sort();

    if (teamASelect && teamBSelect) {
        teamNames.forEach((name) => {
            const optA = document.createElement('option');
            optA.value = name;
            optA.textContent = name;
            if (name === 'Brazil') optA.selected = true;
            teamASelect.appendChild(optA);

            const optB = document.createElement('option');
            optB.value = name;
            optB.textContent = name;
            if (name === 'Argentina') optB.selected = true;
            teamBSelect.appendChild(optB);
        });

        const preventDuplicateTeams = (changedSelect, otherSelect) => {
            if (changedSelect.value === otherSelect.value) {
                const options = Array.from(otherSelect.options).map((opt) => opt.value);
                const fallback = options.find((val) => val !== changedSelect.value);
                otherSelect.value = fallback;
            }
        };

        teamASelect.addEventListener('change', () => {
            preventDuplicateTeams(teamASelect, teamBSelect);
            updatePreview();
        });
        teamBSelect.addEventListener('change', () => {
            preventDuplicateTeams(teamBSelect, teamASelect);
            updatePreview();
        });
    }

    function buildConfig() {
        pullStrategySlidersIntoFull('A');
        pullStrategySlidersIntoFull('B');
        return {
            iterations: parseInt(document.getElementById('iterations').value, 10),
            seed: parseInt(document.getElementById('seed').value, 10),
            concurrency: parseInt(document.getElementById('concurrency').value, 10),
            headless: true,
            outputDir: document.getElementById('outputDir').value,
            teamA: document.getElementById('teamA').value,
            teamB: document.getElementById('teamB').value,
            formationA: document.getElementById('formationA').value,
            formationB: document.getElementById('formationB').value,
            matchDurationSeconds: parseInt(document.getElementById('matchDurationSeconds').value, 10),
            fieldSizeMultiplier: parseFloat(document.getElementById('fieldSizeMultiplier').value),
            aiA: Object.assign({}, teamAiFull.A),
            aiB: Object.assign({}, teamAiFull.B)
        };
    }

    function updatePreview() {
        const cfg = buildConfig();
        const json = JSON.stringify(cfg, null, 2);
        document.getElementById('jsonPreview').textContent = json;
        const compact = JSON.stringify(cfg);
        document.getElementById('cliCommand').textContent =
            `npm run sim:batch -- '${compact}'`;

        document.getElementById('formationHoldLblA').textContent = cfg.aiA.FORMATION_HOLD.toFixed(2);
        document.getElementById('attackSupportLblA').textContent = cfg.aiA.ATTACK_SUPPORT_INTENSITY.toFixed(2);
        document.getElementById('defensivePressLblA').textContent = cfg.aiA.DEFENSIVE_PRESS_INTENSITY.toFixed(2);
        document.getElementById('passAggressionLblA').textContent = cfg.aiA.PASS_AGGRESSION.toFixed(2);

        document.getElementById('formationHoldLblB').textContent = cfg.aiB.FORMATION_HOLD.toFixed(2);
        document.getElementById('attackSupportLblB').textContent = cfg.aiB.ATTACK_SUPPORT_INTENSITY.toFixed(2);
        document.getElementById('defensivePressLblB').textContent = cfg.aiB.DEFENSIVE_PRESS_INTENSITY.toFixed(2);
        document.getElementById('passAggressionLblB').textContent = cfg.aiB.PASS_AGGRESSION.toFixed(2);
    }

    function copyText(text) {
        navigator.clipboard.writeText(text).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
    }

    fields.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            if (id.startsWith('formationHold') || id.startsWith('attackSupport')
                || id.startsWith('defensivePress') || id.startsWith('passAggression')) {
                const team = id.endsWith('A') ? 'A' : 'B';
                pullStrategySlidersIntoFull(team);
                syncArchetypeSelect(team);
                saveBatchAiPrefs();
            }
            updatePreview();
        });
        el.addEventListener('change', updatePreview);
    });

    if (archetypeSelectA) {
        archetypeSelectA.addEventListener('change', (e) => {
            if (e.target.value !== 'custom') applyArchetype('A', e.target.value);
            else {
                updateArchetypeDescription('A', 'custom');
                saveBatchAiPrefs();
            }
        });
    }
    if (archetypeSelectB) {
        archetypeSelectB.addEventListener('change', (e) => {
            if (e.target.value !== 'custom') applyArchetype('B', e.target.value);
            else {
                updateArchetypeDescription('B', 'custom');
                saveBatchAiPrefs();
            }
        });
    }

    loadBatchAiPrefs();

    document.getElementById('copyJsonBtn').addEventListener('click', () => {
        copyText(document.getElementById('jsonPreview').textContent);
    });
    document.getElementById('copyCliBtn').addEventListener('click', () => {
        copyText(document.getElementById('cliCommand').textContent);
    });
    document.getElementById('copySimShBtn').addEventListener('click', () => {
        const cfg = buildConfig();
        const snippet = `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nnode scripts/run_batch_sim.js --config simulations/custom_batch.json\n# Save JSON to simulations/custom_batch.json:\n# ${JSON.stringify(cfg)}`;
        copyText(snippet);
    });
    document.getElementById('downloadConfigBtn').addEventListener('click', () => {
        const blob = new Blob([document.getElementById('jsonPreview').textContent], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'batch_config.json';
        a.click();
        URL.revokeObjectURL(a.href);
    });

    updatePreview();
}

module.exports = { initBatchBuilderApp };
