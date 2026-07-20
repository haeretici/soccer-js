const { Settings } = require('../../settings.js');
const { Application } = require('../../engine.js');
const { Simulator } = require('../../providers/simulator/simulator.js');
const { loadPersistedAiStrategy } = require('../../../html/widgets/engine_tweakings/bind.js');
const { createEngineTweakingsParentBridge } = require('../../../html/widgets/engine_tweakings/parent_bridge.js');
const { gameKeyboard } = require('../../core/lib/input_keyboard.js');
const { SoundDB } = require('../../core/lib/sounddb.js');
const { appUrl } = require('../../core/lib/app_paths.js');

async function initGameApp() {
    // Persist AI knobs into Settings even before the floating panel opens
    loadPersistedAiStrategy(Settings);

    // Stage 1 manual control keyboard (browser only)
    gameKeyboard.attach(typeof window !== 'undefined' ? window : null);

    // 0. Draw opening image on canvas
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

    // 1. Initialize UI Controls
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

    // Notify Engine Tweakings popup when match start/stop locks field/duration
    const setMatchControlsDisabled = (_disabled) => {
        if (engineTweaksBridge) engineTweaksBridge.notifyMatchRunningChanged();
    };

    // Load defaults from Settings
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

    // Load saved formations
    const savedFormA = localStorage.getItem('sim_formation_a');
    if (savedFormA && formationASelect) {
        formationASelect.value = savedFormA;
    }
    const savedFormB = localStorage.getItem('sim_formation_b');
    if (savedFormB && formationBSelect) {
        formationBSelect.value = savedFormB;
    }

    // Manual control checkboxes (Team B disabled until second device)
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
    // Keep shot assist in sync with master aimAssist checkbox
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

    // 2. Play Speed controls
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
                console.warn("Could not save play speed multiplier to localStorage:", err);
            }
        });
    }

    // Camera view controls
    if (cameraViewSelect) {
        cameraViewSelect.addEventListener('change', (e) => {
            Settings.projectionMode = e.target.value;
            try {
                localStorage.setItem('projection_mode', e.target.value);
            } catch (err) {
                console.warn("Could not save projection mode to localStorage:", err);
            }
        });
    }

    if (weatherSelect) {
        weatherSelect.addEventListener('change', (e) => {
            Settings.weather = e.target.value;
            try {
                localStorage.setItem('weather_state', e.target.value);
            } catch (err) {
                console.warn("Could not save weather to localStorage:", err);
            }
        });
    }

    // 3. Prevent duplicate select
    const preventDuplicateTeams = (changedSelect, otherSelect) => {
        if (changedSelect.value === otherSelect.value) {
            // Pick a different one
            const options = Array.from(otherSelect.options).map(opt => opt.value);
            const fallback = options.find(val => val !== changedSelect.value);
            otherSelect.value = fallback;
            otherSelect.dispatchEvent(new Event('change'));
        }
    };

    // Load presets and populate select dropdowns
    let palettes = {};
    try {
        const res = await fetch(appUrl('presets/palettes.json'));
        palettes = await res.json();
    } catch (e) {
        console.error("Failed to load palettes JSON:", e);
        palettes = {
            "Brazil": {"flag": "br"},
            "Argentina": {"flag": "ar"}
        };
    }

    const teamNames = Object.keys(palettes).sort();
    const savedTeamA = localStorage.getItem('sim_team_a');
    const savedTeamB = localStorage.getItem('sim_team_b');

    if (teamASelect && teamBSelect) {
        teamASelect.innerHTML = '';
        teamBSelect.innerHTML = '';
        teamNames.forEach(name => {
            const optA = document.createElement('option');
            optA.value = name;
            optA.textContent = name;
            if (savedTeamA ? (name === savedTeamA) : (name === "Brazil"))
                optA.selected = true;
            teamASelect.appendChild(optA);

            const optB = document.createElement('option');
            optB.value = name;
            optB.textContent = name;
            if (savedTeamB ? (name === savedTeamB) : (name === "Argentina"))
                optB.selected = true;
            teamBSelect.appendChild(optB);
        });

        const displayA = document.getElementById('teamANameDisplay');
        const displayB = document.getElementById('teamBNameDisplay');
        const flagA = document.getElementById('flagA');
        const flagB = document.getElementById('flagB');

        const getFlagUrl = (teamName) => {
            return appUrl(`assets/flags/${teamName.toLowerCase().replace(/\s+/g, '_')}.svg`);
        };

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
            } catch (e) {}
        });
        teamBSelect.addEventListener('change', () => {
            preventDuplicateTeams(teamBSelect, teamASelect);
            updateNamesAndFlags();
            try {
                localStorage.setItem('sim_team_b', teamBSelect.value);
            } catch (e) {}
        });

        updateNamesAndFlags();
    }

    // 4. Initialize engine stats fields to map to GUI elements
    Application.statsFields = {
        fps: document.getElementById('fpsVal'),
        ups: document.getElementById('upsVal'),
        speed: document.getElementById('speedValDisplay'),
        time: document.getElementById('timeVal')
    };

    // Helper to sync pause/resume and playback-related controls
    const syncPlaybackControls = () => {
        const sim = Application.currentLevel;
        const matchRunning = Application.gameStatus === 'running';
        const seeking = !!(sim && sim._seekInProgress);

        if (speedSlider) {
            speedSlider.disabled = seeking;
        }
        if (pauseBtn && matchRunning) {
            pauseBtn.disabled = seeking;
        }
    };

    const setPausedState = (paused) => {
        const sim = Application.currentLevel;
        if (!paused && sim && sim._seekInProgress) {
            return;
        }

        Application.paused = paused;
        if (pauseBtn) {
            if (paused) {
                pauseBtn.innerText = "Resume";
                // Prefer compact retro classes; keep Bootstrap fallbacks for older markup
                pauseBtn.classList.remove('btn-outline-warning', 'btn-retro-warning');
                pauseBtn.classList.add('btn-warning', 'btn-retro-success');
            } else {
                pauseBtn.innerText = "Pause";
                pauseBtn.classList.remove('btn-warning', 'btn-retro-success');
                pauseBtn.classList.add('btn-outline-warning', 'btn-retro-warning');
            }
        }
        syncPlaybackControls();
    };

    const playbackContainer = document.getElementById('playbackContainer');
    const playbackSlider = document.getElementById('playbackSlider');

    // 5. Start / Reset button click
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            Application.gameStatus = 'running';
            setPausedState(false);
            if (pauseBtn) pauseBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = false;
            setMatchControlsDisabled(true);

            // Unlock Web Audio on user gesture; optional WAV overrides load async
            SoundDB.resume();
            SoundDB.preload([
                'whistle', 'whistle_long', 'whistle_end',
                'pass', 'shot', 'lob', 'header', 'throwin', 'touch', 'bounce',
                'tackle', 'slide', 'catch', 'save', 'foul', 'card', 'offside',
                'cheer', 'roar', 'ooh', 'boo', 'net', 'crowd_burst'
            ]);
            SoundDB.startCrowd();

            // Parse seed input
            const seedInput = document.getElementById('seedInput');
            let chosenSeed = null;
            if (seedInput && seedInput.value.trim() !== '') {
                chosenSeed = parseInt(seedInput.value.trim(), 10);
            }
            if (isNaN(chosenSeed) || chosenSeed === null) {
                chosenSeed = Math.floor(Math.random() * 999999) + 1;
            }

            const sim = new Simulator({ seed: chosenSeed });

            if (Application.canvas) {
                void Application.loadLevel(sim).catch((err) => console.error('loadLevel failed:', err));
            } else {
                void Application.run('gameCanvas', sim, 720, 528).catch((err) => console.error('run failed:', err));
            }

            if (playbackContainer) {
                playbackContainer.style.display = 'block';
            }
            if (playbackSlider) {
                playbackSlider.disabled = true;
                playbackSlider.value = 0;
                playbackSlider.max = 0;
            }

            playBtn.innerText = "Reset";
            const gc = document.getElementById('gameCanvas');
            if (gc) gc.scrollIntoView({ behavior: 'smooth' });
        });
    }

    // 6. Pause / Resume button click
    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            const sim = Application.currentLevel;
            if (sim && sim._seekInProgress) {
                return;
            }
            setPausedState(!Application.paused);
        });
    }

    // 7. Stop button click
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
            
            if (playBtn) playBtn.innerText = "Start";
            pauseBtn.innerText = "Pause";
            pauseBtn.disabled = true;
            stopBtn.disabled = true;
            setMatchControlsDisabled(false);

            if (playbackContainer) {
                playbackContainer.style.display = 'none';
            }

            // Reset scoreboard UI elements to initial values
            const scoreAEl = document.getElementById('scoreA');
            const scoreBEl = document.getElementById('scoreB');
            const matchClockEl = document.getElementById('matchClock');
            const matchStateEl = document.getElementById('matchStateBadge');
            
            if (scoreAEl) scoreAEl.innerText = "0";
            if (scoreBEl) scoreBEl.innerText = "0";
            if (matchClockEl) matchClockEl.innerText = "00:00";
            if (matchStateEl) {
                matchStateEl.innerText = "NOT STARTED";
                matchStateEl.className = "badge bg-secondary";
            }

            // Restore scoreboard flags and names back to their unswapped positions
            if (teamASelect) {
                teamASelect.dispatchEvent(new Event('change'));
            }
        });
    }

    // 8. Playback scrubber — replays from seed to the selected logic tick
    if (playbackSlider) {
        let seekDebounceTimer = null;
        let pendingSeekTarget = null;

        const runPlaybackSeek = async (sim, targetTicks) => {
            if (!sim || typeof sim.seekPlayback !== 'function' || !sim.replayConfig) return;

            if (sim._seekInProgress) {
                pendingSeekTarget = targetTicks;
                return;
            }

            if (pauseBtn) pauseBtn.disabled = true;
            if (speedSlider) speedSlider.disabled = true;
            await sim.seekPlayback(targetTicks);
            syncPlaybackControls();

            if (pendingSeekTarget !== null && pendingSeekTarget !== targetTicks) {
                const nextTarget = pendingSeekTarget;
                pendingSeekTarget = null;
                await runPlaybackSeek(sim, nextTarget);
            }
        };

        const queuePlaybackSeek = (targetTicks, immediate = false) => {
            const sim = Application.currentLevel;
            if (!sim || typeof sim.seekPlayback !== 'function' || !sim.replayConfig) return;

            setPausedState(true);
            clearTimeout(seekDebounceTimer);

            if (immediate) {
                void runPlaybackSeek(sim, targetTicks);
                return;
            }

            seekDebounceTimer = setTimeout(() => {
                void runPlaybackSeek(sim, targetTicks);
            }, 200);
        };

        playbackSlider.addEventListener('input', (e) => {
            queuePlaybackSeek(parseInt(e.target.value, 10), false);
        });

        playbackSlider.addEventListener('change', (e) => {
            queuePlaybackSeek(parseInt(e.target.value, 10), true);
        });
    }

    // 7. Engine Tweakings — real browser popup (window.open) + postMessage bridge
    engineTweaksBridge = createEngineTweakingsParentBridge({ Settings, Application });
    const openEngineTweakingsBtn = document.getElementById('openEngineTweakingsBtn');
    if (openEngineTweakingsBtn) {
        openEngineTweakingsBtn.addEventListener('click', () => {
            engineTweaksBridge.open();
        });
    }

    // Strategy-shift: push snapshot into open popup (badges / sliders there)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('strategy-shifted', (e) => {
            const { team, archetypeId } = e.detail || {};
            if (engineTweaksBridge) {
                engineTweaksBridge.notifyStrategyShift(team, archetypeId);
            }
        });
    }

    // Full-screen toggle
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

module.exports = { initGameApp };
