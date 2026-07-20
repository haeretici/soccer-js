/**
 * Scenario Test Lab — browser UI for forcing set-pieces / isolated play situations.
 * Layout mirrors Match Simulator but drops the scrubber and adds scenario controls.
 */
const { Settings } = require('../../settings.js');
const { Application } = require('../../engine.js');
const { Simulator, MatchStates } = require('../../providers/simulator/simulator.js');
const { loadPersistedAiStrategy } = require('../../../html/widgets/engine_tweakings/bind.js');
const { createEngineTweakingsParentBridge } = require('../../../html/widgets/engine_tweakings/parent_bridge.js');
const { gameKeyboard } = require('../../core/lib/input_keyboard.js');
const { SoundDB } = require('../../core/lib/sounddb.js');
const { appUrl } = require('../../core/lib/app_paths.js');
const {
    SCENARIO_CATALOG,
    getScenarioDef,
    applyTestScenario
} = require('../../core/lib/test_scenarios.js');

function readScenarioConfigFromDom() {
    const scenarioSelect = document.getElementById('scenarioSelect');
    const kickingTeamSelect = document.getElementById('kickingTeamSelect');
    const opponentOutfieldInput = document.getElementById('opponentOutfieldInput');
    const ownOutfieldInput = document.getElementById('ownOutfieldInput');
    const keepOpponentGk = document.getElementById('keepOpponentGk');
    const throwLineSelect = document.getElementById('throwLineSelect');
    const throwThirdSelect = document.getElementById('throwThirdSelect');
    const cornerFlagSelect = document.getElementById('cornerFlagSelect');
    const attackDepthSelect = document.getElementById('attackDepthSelect');
    const channelSelect = document.getElementById('channelSelect');
    const goalSideSelect = document.getElementById('goalSideSelect');
    const fieldThirdSelect = document.getElementById('fieldThirdSelect');

    return {
        id: scenarioSelect ? scenarioSelect.value : 'kickoff',
        kickingTeam: kickingTeamSelect ? kickingTeamSelect.value : 'A',
        opponentOutfield: opponentOutfieldInput ? opponentOutfieldInput.value : 10,
        ownOutfield: ownOutfieldInput ? ownOutfieldInput.value : 10,
        keepOpponentGk: keepOpponentGk ? keepOpponentGk.checked : true,
        throwLine: throwLineSelect ? throwLineSelect.value : 'top',
        throwThird: throwThirdSelect ? throwThirdSelect.value : 'center',
        cornerFlag: cornerFlagSelect ? cornerFlagSelect.value : 'tr',
        attackDepth: attackDepthSelect ? attackDepthSelect.value : 'edge_box',
        channel: channelSelect ? channelSelect.value : 'center',
        goalSide: goalSideSelect ? goalSideSelect.value : 'right',
        fieldThird: fieldThirdSelect ? fieldThirdSelect.value : 'middle'
    };
}

function syncScenarioOptionPanels() {
    const scenarioSelect = document.getElementById('scenarioSelect');
    const id = scenarioSelect ? scenarioSelect.value : 'kickoff';
    const def = getScenarioDef(id);
    const descEl = document.getElementById('scenarioDescription');
    if (descEl && def) {
        descEl.textContent = def.description || '';
    }

    const show = (elId, visible) => {
        const el = document.getElementById(elId);
        if (el) el.style.display = visible ? '' : 'none';
    };

    const opts = def ? def.options : [];
    show('optThrowGroup', opts.includes('side') || opts.includes('third'));
    show('optCornerGroup', opts.includes('cornerFlag'));
    show('optFreekickGroup', opts.includes('attackDepth') || opts.includes('channel'));
    show('optGoalSideGroup', opts.includes('goalSide'));
    show('optFieldThirdGroup', opts.includes('fieldThird'));

    // Suggest default opponent count when scenario changes (user can still override)
    const oppInput = document.getElementById('opponentOutfieldInput');
    if (oppInput && def && oppInput.dataset.userTouched !== '1') {
        oppInput.value = String(def.defaultOpponentOutfield);
    }
}

async function initTestsApp() {
    loadPersistedAiStrategy(Settings);
    gameKeyboard.attach(typeof window !== 'undefined' ? window : null);

    const canvas = document.getElementById('gameCanvas');
    if (canvas && typeof canvas.getContext === 'function') {
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => {
            if (Application.gameStatus !== 'running') {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
        };
        img.src = appUrl('assets/images/opening.jpg');
    }

    const teamASelect = document.getElementById('teamASelect');
    const teamBSelect = document.getElementById('teamBSelect');
    const formationASelect = document.getElementById('formationASelect');
    const formationBSelect = document.getElementById('formationBSelect');
    const speedSlider = document.getElementById('speedSlider');
    const speedVal = document.getElementById('speedVal');
    const playBtn = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const cameraViewSelect = document.getElementById('cameraViewSelect');
    const weatherSelect = document.getElementById('weatherSelect');

    let engineTweaksBridge = null;

    const setMatchControlsDisabled = (_disabled) => {
        if (engineTweaksBridge) engineTweaksBridge.notifyMatchRunningChanged();
    };

    if (speedSlider) {
        speedSlider.value = Settings.DEFAULT_PLAY_SPEED;
    }
    if (speedVal) {
        speedVal.innerText = Settings.DEFAULT_PLAY_SPEED.toFixed(2);
    }
    Settings.TIME_SPEED = Settings.DEFAULT_PLAY_SPEED;

    if (cameraViewSelect) {
        cameraViewSelect.value = Settings.projectionMode || 'orthographic';
    }
    if (weatherSelect) {
        weatherSelect.value = Settings.weather || 'fine';
    }

    const savedFormA = localStorage.getItem('sim_formation_a');
    if (savedFormA && formationASelect) formationASelect.value = savedFormA;
    const savedFormB = localStorage.getItem('sim_formation_b');
    if (savedFormB && formationBSelect) formationBSelect.value = savedFormB;

    // --- Scenario picker ---
    const scenarioSelect = document.getElementById('scenarioSelect');
    if (scenarioSelect) {
        scenarioSelect.innerHTML = '';
        for (const sc of SCENARIO_CATALOG) {
            const opt = document.createElement('option');
            opt.value = sc.id;
            opt.textContent = sc.label;
            scenarioSelect.appendChild(opt);
        }
        const savedScenario = localStorage.getItem('test_scenario_id');
        if (savedScenario && getScenarioDef(savedScenario)) {
            scenarioSelect.value = savedScenario;
        }
        scenarioSelect.addEventListener('change', () => {
            try {
                localStorage.setItem('test_scenario_id', scenarioSelect.value);
            } catch (_e) { /* ignore */ }
            const oppInput = document.getElementById('opponentOutfieldInput');
            if (oppInput) oppInput.dataset.userTouched = '';
            syncScenarioOptionPanels();
        });
    }

    const opponentOutfieldInput = document.getElementById('opponentOutfieldInput');
    if (opponentOutfieldInput) {
        opponentOutfieldInput.addEventListener('input', () => {
            opponentOutfieldInput.dataset.userTouched = '1';
        });
        opponentOutfieldInput.addEventListener('change', () => {
            opponentOutfieldInput.dataset.userTouched = '1';
        });
    }
    syncScenarioOptionPanels();

    // --- Manual control ---
    const manualControlA = document.getElementById('manualControlA');
    const manualControlB = document.getElementById('manualControlB');
    const manualAutoSwitch = document.getElementById('manualAutoSwitch');
    const manualPassAssist = document.getElementById('manualPassAssist');
    const manualAimAssist = document.getElementById('manualAimAssist');
    const manualHoldToPower = document.getElementById('manualHoldToPower');
    const manualCameraFollow = document.getElementById('manualCameraFollow');
    const manualScreenAware = document.getElementById('manualScreenAware');
    if (!Settings.manualControl) {
        Settings.manualControl = {
            teamA: false,
            teamB: false,
            clampSpeed: true,
            autoSwitchOnPass: true,
            passAssistFacing: true,
            aimAssist: true,
            shotAimAssist: true,
            holdToPower: true,
            cameraFollow: true,
            screenAwareMove: true
        };
    }

    const applyManualSpeedClamp = () => {
        const mc = Settings.manualControl;
        const manualOn = !!(mc && (mc.teamA || mc.teamB) && mc.clampSpeed !== false);
        if (manualOn && Settings.TIME_SPEED > 1) {
            Settings.TIME_SPEED = 1;
            if (speedSlider) speedSlider.value = '1';
            if (speedVal) speedVal.innerText = '1.00';
        }
        gameKeyboard.setEnabled(!!(mc && mc.teamA));
    };

    const bindManualToggle = (el, key, storageKey) => {
        if (!el) return;
        try {
            const saved = localStorage.getItem(storageKey);
            if (saved !== null) {
                el.checked = saved === 'true';
                Settings.manualControl[key] = el.checked;
            } else {
                el.checked = Settings.manualControl[key] !== false;
                Settings.manualControl[key] = el.checked;
            }
        } catch (_e) {
            el.checked = Settings.manualControl[key] !== false;
            Settings.manualControl[key] = el.checked;
        }
        el.addEventListener('change', () => {
            Settings.manualControl[key] = !!el.checked;
            try {
                localStorage.setItem(storageKey, Settings.manualControl[key] ? 'true' : 'false');
            } catch (_e) { /* ignore */ }
            if (key === 'teamA') applyManualSpeedClamp();
        });
    };

    try {
        const savedManualA = localStorage.getItem('manual_control_a');
        if (savedManualA !== null && manualControlA) {
            manualControlA.checked = savedManualA === 'true';
            Settings.manualControl.teamA = manualControlA.checked;
        }
    } catch (_e) { /* ignore */ }

    if (manualControlA) {
        manualControlA.addEventListener('change', () => {
            Settings.manualControl.teamA = !!manualControlA.checked;
            try {
                localStorage.setItem('manual_control_a', Settings.manualControl.teamA ? 'true' : 'false');
            } catch (_e) { /* ignore */ }
            applyManualSpeedClamp();
        });
    }
    if (manualControlB) {
        manualControlB.checked = false;
        Settings.manualControl.teamB = false;
    }
    bindManualToggle(manualAutoSwitch, 'autoSwitchOnPass', 'manual_auto_switch');
    bindManualToggle(manualPassAssist, 'passAssistFacing', 'manual_pass_assist');
    bindManualToggle(manualAimAssist, 'aimAssist', 'manual_aim_assist');
    bindManualToggle(manualHoldToPower, 'holdToPower', 'manual_hold_to_power');
    bindManualToggle(manualCameraFollow, 'cameraFollow', 'manual_camera_follow');
    bindManualToggle(manualScreenAware, 'screenAwareMove', 'manual_screen_aware');
    if (manualAimAssist) {
        const syncShotAssist = () => {
            Settings.manualControl.shotAimAssist = !!Settings.manualControl.aimAssist;
        };
        manualAimAssist.addEventListener('change', syncShotAssist);
        syncShotAssist();
    }
    applyManualSpeedClamp();

    if (formationASelect) {
        formationASelect.addEventListener('change', (e) => {
            localStorage.setItem('sim_formation_a', e.target.value);
            if (Application.currentLevel && typeof Application.currentLevel.changeFormation === 'function') {
                Application.currentLevel.changeFormation('A', e.target.value);
            }
        });
    }
    if (formationBSelect) {
        formationBSelect.addEventListener('change', (e) => {
            localStorage.setItem('sim_formation_b', e.target.value);
            if (Application.currentLevel && typeof Application.currentLevel.changeFormation === 'function') {
                Application.currentLevel.changeFormation('B', e.target.value);
            }
        });
    }

    if (speedSlider) {
        speedSlider.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            const mc = Settings.manualControl;
            if (mc && (mc.teamA || mc.teamB) && mc.clampSpeed !== false && val > 1) {
                val = 1;
                speedSlider.value = '1';
            }
            Settings.TIME_SPEED = val;
            speedVal.innerText = val.toFixed(2);
            try {
                localStorage.setItem('play_speed_multiplier', val.toString());
            } catch (err) {
                console.warn('Could not save play speed multiplier to localStorage:', err);
            }
        });
    }

    if (cameraViewSelect) {
        cameraViewSelect.addEventListener('change', (e) => {
            Settings.projectionMode = e.target.value;
            try {
                localStorage.setItem('projection_mode', e.target.value);
            } catch (err) {
                console.warn('Could not save projection mode to localStorage:', err);
            }
        });
    }

    if (weatherSelect) {
        weatherSelect.addEventListener('change', (e) => {
            Settings.weather = e.target.value;
            try {
                localStorage.setItem('weather_state', e.target.value);
            } catch (err) {
                console.warn('Could not save weather to localStorage:', err);
            }
        });
    }

    const preventDuplicateTeams = (changedSelect, otherSelect) => {
        if (changedSelect.value === otherSelect.value) {
            const options = Array.from(otherSelect.options).map((opt) => opt.value);
            const fallback = options.find((val) => val !== changedSelect.value);
            otherSelect.value = fallback;
            otherSelect.dispatchEvent(new Event('change'));
        }
    };

    let palettes = {};
    try {
        const res = await fetch(appUrl('presets/palettes.json'));
        palettes = await res.json();
    } catch (e) {
        console.error('Failed to load palettes JSON:', e);
        palettes = { Brazil: { flag: 'br' }, Argentina: { flag: 'ar' } };
    }

    const teamNames = Object.keys(palettes).sort();
    const savedTeamA = localStorage.getItem('sim_team_a');
    const savedTeamB = localStorage.getItem('sim_team_b');

    if (teamASelect && teamBSelect) {
        teamASelect.innerHTML = '';
        teamBSelect.innerHTML = '';
        teamNames.forEach((name) => {
            const optA = document.createElement('option');
            optA.value = name;
            optA.textContent = name;
            if (savedTeamA ? name === savedTeamA : name === 'Brazil') optA.selected = true;
            teamASelect.appendChild(optA);

            const optB = document.createElement('option');
            optB.value = name;
            optB.textContent = name;
            if (savedTeamB ? name === savedTeamB : name === 'Argentina') optB.selected = true;
            teamBSelect.appendChild(optB);
        });

        const displayA = document.getElementById('teamANameDisplay');
        const displayB = document.getElementById('teamBNameDisplay');
        const flagA = document.getElementById('flagA');
        const flagB = document.getElementById('flagB');

        const getFlagUrl = (teamName) => appUrl(`assets/flags/${teamName.toLowerCase().replace(/\s+/g, '_')}.svg`);

        let lastFlagA = null;
        let lastFlagB = null;
        const updateNamesAndFlags = () => {
            if (displayA) displayA.innerText = teamASelect.value;
            if (displayB) displayB.innerText = teamBSelect.value;
            const urlA = getFlagUrl(teamASelect.value);
            const urlB = getFlagUrl(teamBSelect.value);
            if (flagA && lastFlagA !== urlA) {
                lastFlagA = urlA;
                flagA.src = urlA;
            }
            if (flagB && lastFlagB !== urlB) {
                lastFlagB = urlB;
                flagB.src = urlB;
            }
        };

        teamASelect.addEventListener('change', () => {
            preventDuplicateTeams(teamASelect, teamBSelect);
            updateNamesAndFlags();
            try {
                localStorage.setItem('sim_team_a', teamASelect.value);
            } catch (_e) { /* ignore */ }
        });
        teamBSelect.addEventListener('change', () => {
            preventDuplicateTeams(teamBSelect, teamASelect);
            updateNamesAndFlags();
            try {
                localStorage.setItem('sim_team_b', teamBSelect.value);
            } catch (_e) { /* ignore */ }
        });

        updateNamesAndFlags();
    }

    Application.statsFields = {
        fps: document.getElementById('fpsVal'),
        ups: document.getElementById('upsVal'),
        speed: document.getElementById('speedValDisplay'),
        time: document.getElementById('timeVal')
    };

    const setPausedState = (paused) => {
        Application.paused = paused;
        if (pauseBtn) {
            if (paused) {
                pauseBtn.innerText = 'Resume';
                pauseBtn.classList.remove('btn-outline-warning', 'btn-retro-warning');
                pauseBtn.classList.add('btn-warning', 'btn-retro-success');
            } else {
                pauseBtn.innerText = 'Pause';
                pauseBtn.classList.remove('btn-warning', 'btn-retro-success');
                pauseBtn.classList.add('btn-outline-warning', 'btn-retro-warning');
            }
        }
    };

    if (playBtn) {
        playBtn.addEventListener('click', async () => {
            Application.gameStatus = 'running';
            setPausedState(false);
            if (pauseBtn) pauseBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = false;
            setMatchControlsDisabled(true);

            SoundDB.resume();
            SoundDB.preload([
                'whistle', 'whistle_long', 'whistle_end',
                'pass', 'shot', 'lob', 'header', 'throwin', 'touch', 'bounce',
                'tackle', 'slide', 'catch', 'save', 'foul', 'card', 'offside',
                'cheer', 'roar', 'ooh', 'boo', 'net', 'crowd_burst'
            ]);
            SoundDB.startCrowd();

            const seedInput = document.getElementById('seedInput');
            let chosenSeed = null;
            if (seedInput && seedInput.value.trim() !== '') {
                chosenSeed = parseInt(seedInput.value.trim(), 10);
            }
            if (isNaN(chosenSeed) || chosenSeed === null) {
                chosenSeed = Math.floor(Math.random() * 999999) + 1;
            }

            const scenarioCfg = readScenarioConfigFromDom();
            const sim = new Simulator({ seed: chosenSeed });

            try {
                if (Application.canvas) {
                    await Application.loadLevel(sim);
                } else {
                    await Application.run('gameCanvas', sim, 720, 528);
                }
            } catch (err) {
                console.error('Scenario load failed:', err);
                return;
            }

            // Force the selected situation after normal bootstrap (kickoff entities ready)
            const result = applyTestScenario(sim, scenarioCfg, MatchStates);
            if (!result.ok) {
                console.warn('Scenario apply failed:', result.message || result.id);
            }

            const badge = document.getElementById('matchStateBadge');
            if (badge && scenarioCfg.id) {
                const def = getScenarioDef(scenarioCfg.id);
                badge.title = def ? def.label : scenarioCfg.id;
            }

            playBtn.innerText = 'Reset';
            const gc = document.getElementById('gameCanvas');
            if (gc) gc.scrollIntoView({ behavior: 'smooth' });
        });
    }

    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            setPausedState(!Application.paused);
        });
    }

    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            Application.gameStatus = 'stopped';
            setPausedState(true);
            SoundDB.stopCrowd();

            if (Application.currentLevel && typeof Application.currentLevel.destroy === 'function') {
                Application.currentLevel.destroy();
            }
            Application.currentLevel = null;
            Application.levelReady = false;

            if (playBtn) playBtn.innerText = 'Start';
            pauseBtn.innerText = 'Pause';
            pauseBtn.disabled = true;
            stopBtn.disabled = true;
            setMatchControlsDisabled(false);

            const scoreAEl = document.getElementById('scoreA');
            const scoreBEl = document.getElementById('scoreB');
            const matchClockEl = document.getElementById('matchClock');
            const matchStateEl = document.getElementById('matchStateBadge');

            if (scoreAEl) scoreAEl.innerText = '0';
            if (scoreBEl) scoreBEl.innerText = '0';
            if (matchClockEl) matchClockEl.innerText = '00:00';
            if (matchStateEl) {
                matchStateEl.innerText = 'NOT STARTED';
                matchStateEl.className = 'badge-retro';
            }

            if (teamASelect) {
                teamASelect.dispatchEvent(new Event('change'));
            }
        });
    }

    engineTweaksBridge = createEngineTweakingsParentBridge({ Settings, Application });
    const openEngineTweakingsBtn = document.getElementById('openEngineTweakingsBtn');
    if (openEngineTweakingsBtn) {
        openEngineTweakingsBtn.addEventListener('click', () => {
            engineTweaksBridge.open();
        });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('strategy-shifted', (e) => {
            const { team, archetypeId } = e.detail || {};
            if (engineTweaksBridge) {
                engineTweaksBridge.notifyStrategyShift(team, archetypeId);
            }
        });
    }

    // Full-screen toggle (same as Match Simulator)
    const fullscreenToggleBtn = document.getElementById('fullscreenToggleBtn');
    const canvasContainer = document.querySelector('.canvas-container');
    const gameCanvas = document.getElementById('gameCanvas');

    if (fullscreenToggleBtn && canvasContainer) {
        const GAME_CANVAS_W = 720;
        const GAME_CANVAS_H = 528;

        const isNativeFullscreen = () => !!(
            document.fullscreenElement
            || document.webkitFullscreenElement
            || document.mozFullScreenElement
            || document.msFullscreenElement
        );

        const fitCanvasToFullscreen = () => {
            if (!gameCanvas || !canvasContainer.classList.contains('is-fullscreen')) return;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const scale = Math.min(vw / GAME_CANVAS_W, vh / GAME_CANVAS_H);
            const cssW = Math.floor(GAME_CANVAS_W * scale);
            const cssH = Math.floor(GAME_CANVAS_H * scale);
            gameCanvas.style.width = `${cssW}px`;
            gameCanvas.style.height = `${cssH}px`;
            gameCanvas.style.maxWidth = '100vw';
            gameCanvas.style.maxHeight = '100vh';
        };

        const clearCanvasInlineSize = () => {
            if (!gameCanvas) return;
            gameCanvas.style.width = '';
            gameCanvas.style.height = '';
            gameCanvas.style.maxWidth = '';
            gameCanvas.style.maxHeight = '';
        };

        const setFullscreenUi = (active) => {
            const enterIcon = document.getElementById('enterFullscreenIcon');
            const exitIcon = document.getElementById('exitFullscreenIcon');
            canvasContainer.classList.toggle('is-fullscreen', active);
            if (active) {
                if (enterIcon) enterIcon.style.display = 'none';
                if (exitIcon) exitIcon.style.display = 'block';
                fullscreenToggleBtn.setAttribute('title', 'Exit Full Screen');
                fitCanvasToFullscreen();
            } else {
                if (enterIcon) enterIcon.style.display = 'block';
                if (exitIcon) exitIcon.style.display = 'none';
                fullscreenToggleBtn.setAttribute('title', 'Full Screen');
                clearCanvasInlineSize();
            }
        };

        const enterFullscreen = () => {
            const el = canvasContainer;
            const req = el.requestFullscreen
                || el.webkitRequestFullscreen
                || el.mozRequestFullScreen
                || el.msRequestFullscreen;
            if (req) {
                Promise.resolve(req.call(el)).catch(() => {
                    setFullscreenUi(true);
                });
            } else {
                setFullscreenUi(true);
            }
        };

        const exitFullscreen = () => {
            if (isNativeFullscreen()) {
                const exit = document.exitFullscreen
                    || document.webkitExitFullscreen
                    || document.mozCancelFullScreen
                    || document.msExitFullscreen;
                if (exit) exit.call(document);
            }
            setFullscreenUi(false);
        };

        const toggleFullscreen = () => {
            if (isNativeFullscreen() || canvasContainer.classList.contains('is-fullscreen')) {
                exitFullscreen();
            } else {
                enterFullscreen();
            }
        };

        fullscreenToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFullscreen();
        });

        const onFullscreenChange = () => {
            setFullscreenUi(isNativeFullscreen());
        };

        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        document.addEventListener('mozfullscreenchange', onFullscreenChange);
        document.addEventListener('MSFullscreenChange', onFullscreenChange);

        window.addEventListener('resize', () => {
            if (canvasContainer.classList.contains('is-fullscreen')) {
                fitCanvasToFullscreen();
            }
        });
    }

    const saveBtn = document.getElementById('saveBtn');
    const loadBtn = document.getElementById('loadBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            window.Application.save();
        });
    }
    if (loadBtn) {
        loadBtn.addEventListener('click', async () => {
            window.Application.load();
        });
    }
}

module.exports = { initTestsApp, readScenarioConfigFromDom };
