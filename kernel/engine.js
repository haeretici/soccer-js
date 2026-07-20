const { GameObject } = require('./core/entities/gameobject.js');
const { Time } = require('./core/lib/time.js');
const { Settings } = require('./settings');
const { Utils } = require('./core/lib/utils.js');
const { loadState, saveState } = require('./core/lib/db.js');
const { appUrl } = require('./core/lib/app_paths.js');

var CanvasLoop = function (currentTime) {
    const deltaTime = currentTime - Settings.app.lastTime;
    if (deltaTime >= Settings.app.targetFrameTime) {
        // Only clear screen after updates
        Settings.app.clearScreen();
        Settings.app.render();
        Settings.app.onGUI();
        Settings.app.frames++;

        if (Settings.app.currentLevel && Settings.app.currentLevel.active && currentTime - Settings.app.lastFrameFPSUpdate >= 1000) { // Update every 1 second
            Settings.app.FPS = Settings.app.frames / ((currentTime - Settings.app.lastFrameFPSUpdate) / 1000);
            Settings.app.lastFrameFPSUpdate = currentTime;
            Settings.app.frames = 0;
            if (Settings.showFPS) {
                Settings.app.statsFields.fps.innerHTML = Math.round(Settings.app.FPS);
                Settings.app.statsFields.ups.innerHTML = Math.round(Settings.app.UPS);
                Settings.app.statsFields.speed.innerHTML = Settings.TIME_SPEED;
            }
            if (Settings.showTime) {
                Settings.app.statsFields.time.innerHTML = Utils.formatSeconds(Time.timeSinceLevelLoad);
            }

        }
        Settings.app.lastTime = currentTime - (deltaTime % Settings.app.targetFrameTime); // Align to frame boundary
    }
    if (!Settings.app.interrupted) {
        requestAnimationFrame(CanvasLoop);
    }
};

var ApplicationLoop = async function () {
    const start = performance.now();// Update the application
    await Settings.app.update(); // This handles the logic of the app and takes the time

    const end = performance.now();
    const workTime = end - start;

    if (!Settings.app.interrupted) {
        try {
            // Schedule logic ticks: 20 UPS at 1x, 200 UPS at 10x; dt stays fixed in advanceFixedLogicStep()
            const baseFrameTime = 1000 / 20; // 50ms per tick at 1x
            const targetFrameTimeMs = baseFrameTime / Settings.TIME_SPEED;

            // Calculate the next frame time
            const nextFrameTime = Math.max(0, targetFrameTimeMs - workTime);

            Settings.app.lastUpdate = end;

            // Debug: Track updates for FPS calculation
            Settings.app.updateCounter = (Settings.app.updateCounter || 0) + 1;
            Settings.app.totalWorkTime = (Settings.app.totalWorkTime || 0) + workTime; // New: Accumulator
            Settings.app.lastLogTime = Settings.app.lastLogTime || end;

            // Log FPS every 1 second
            if (end - Settings.app.lastLogTime >= 1000) {
                Settings.app.UPS = Settings.app.updateCounter / ((end - Settings.app.lastLogTime) / 1000);
                Settings.app.avgWorkTime = Settings.app.totalWorkTime / Settings.app.updateCounter;
                Settings.app.updateCounter = 0; // Reset counter
                Settings.app.totalWorkTime = 0; // Reset accumulator
                Settings.app.lastLogTime = end; // Reset log time
            }

            // Schedule the next frame
            setTimeout(ApplicationLoop, nextFrameTime);

        } catch (err) {
            console.error(err);
            Settings.app.interrupted = true;
        }
    }
};

var Application = {
    openingImage: null,
    gameStatus: null,
    lastFrameFPSUpdate: 0,
    targetFrameTime: 1000 / Settings.FRAME_RATE,
    interrupted: false,
    paused: false,
    lastTime: performance.now(),
    lastUpdate: performance.now(),
    cycleTime: null,
    currentLevel: null,
    levelReady: false,
    playerMap: {},
    frames: 1,
    updates: 1,
    FPS: 0,
    UPS: 0,
    PING: 0,
    canvas: null,
    g: null,
    width: 0,
    height: 0,
    camX: 0,
    camY: 0,

    loadLevel: async function (currentLevel) {
        this.levelReady = false;
        Time.resetTimeSinceLevelLoad();
        this.clearScreen();
        if (this.currentLevel !== null && this.currentLevel.destroy !== undefined) {
            this.currentLevel.destroy();
        }
        this.currentLevel = currentLevel;
        if (this.currentLevel != null) {
            await this.currentLevel.start();
        }
        this.levelReady = this.currentLevel != null;
    },

    getCurrentLevel: function () {
        return this.currentLevel;
    },

    clearScreen: function () {
        this.g.clearRect(0, 0, Settings.app.canvas.width, Settings.app.canvas.height);
        if (Settings.screenColor) { // Only fill if a background color is needed
            this.g.fillStyle = Settings.screenColor;
            this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    },
    save: function() {
        saveState();
    },

    load: function() {
        loadState();
    },

    run: async function (canvasID, level, width = 720, height = 528) {
        if (!canvasID) throw new Error("canvasID is required");
        if (!level) throw new Error("level is required");
        this.width = width;
        this.height = height;

        this.canvas = document.getElementById(canvasID);
        if (!this.canvas) throw new Error(`Canvas with ID '${canvasID}' not found`);
        this.g = this.canvas.getContext('2d');

        if (typeof Image !== 'undefined' && !this.openingImage) {
            this.openingImage = new Image();
            this.openingImage.src = appUrl('assets/images/opening.jpg');
        }

        this.canvas.setAttribute('width', this.width);
        this.canvas.setAttribute('height', this.height);

        Time.resetTimeSinceLevelLoad();

        this.cycleTime = performance.now();
        await this.loadLevel(level);

        requestAnimationFrame(CanvasLoop);
        ApplicationLoop();
    },

    update: async function () {
        if (this.paused || !this.levelReady || !this.currentLevel || this.currentLevel._seekInProgress) {
            Time.base = performance.now();
            return;
        }
        Time.advanceFixedLogicStep();
        this.currentLevel.updateAll();
    },

    render: function () {
        if (this.gameStatus === 'stopped') {
            if (this.openingImage && this.openingImage.complete) {
                this.g.drawImage(this.openingImage, 0, 0, this.canvas.width, this.canvas.height);
            }
            return;
        }
        if (!this.levelReady || !this.currentLevel || !this.g) {
            return;
        }
        this.g.save();
        this.g.translate(this.camX, this.camY);
        this.currentLevel.renderAll(this.g);

        // Update and render weather particles in world space before restoring translation
        this.updateAndRenderWeather();

        this.g.restore();
    },

    updateAndRenderWeather: function() {
        if (Settings.HEADLESS) return;
        const weather = Settings.weather || 'fine';
        if (weather === 'fine') {
            return;
        }

        const canvas = this.canvas;
        if (!canvas) return;
        const w = canvas.width;
        const h = canvas.height;

        // Viewport boundaries in world space
        const minX = -this.camX;
        const maxX = -this.camX + w;
        const minY = -this.camY;
        const maxY = -this.camY + h;

        const snowCfg = Settings.weatherSnow || {};

        if (!this.weatherParticles || this.lastWeatherType !== weather) {
            this.weatherParticles = [];
            this.lastWeatherType = weather;

            const count = weather === 'rainy' ? 120 : (snowCfg.particleCount !== undefined ? snowCfg.particleCount : 80);
            for (let i = 0; i < count; i++) {
                if (weather === 'rainy') {
                    const px = minX + Utils.getPseudoRandom() * w;
                    const py = minY + Utils.getPseudoRandom() * h;
                    this.weatherParticles.push({
                        x: px,
                        y: py,
                        vx: -2 - Utils.getPseudoRandom() * 2,
                        vy: 10 + Utils.getPseudoRandom() * 5,
                        yThreshold: py + 40 + Utils.getPseudoRandom() * (h - 40),
                        state: 'falling',
                        splashFrame: 0
                    });
                } else if (weather === 'snowy') {
                    const minSz = snowCfg.particleMinSize !== undefined ? snowCfg.particleMinSize : 1.0;
                    const maxSz = snowCfg.particleMaxSize !== undefined ? snowCfg.particleMaxSize : 2.2;
                    const speedMult = snowCfg.particleSpeed !== undefined ? snowCfg.particleSpeed : 1.0;
                    this.weatherParticles.push({
                        x: minX + Utils.getPseudoRandom() * w,
                        y: minY + Utils.getPseudoRandom() * h,
                        vy: (1.0 + Utils.getPseudoRandom() * 1.5) * speedMult,
                        vx: (Utils.getPseudoRandom() - 0.5) * 0.5,
                        swaySpeed: 0.02 + Utils.getPseudoRandom() * 0.03,
                        swayWidth: 5 + Utils.getPseudoRandom() * 10,
                        swayOffset: Utils.getPseudoRandom() * Math.PI * 2,
                        size: minSz + Utils.getPseudoRandom() * (maxSz - minSz)
                    });
                }
            }
        }

        const g = this.g;
        if (weather === 'rainy') {
            for (let p of this.weatherParticles) {
                // If camera moved fast, wrap particles back into view
                if (p.x < minX - 40 || p.x > maxX + 40 || p.y < minY - 40 || p.y > maxY + 40) {
                    p.x = minX + Utils.getPseudoRandom() * w;
                    p.y = minY - 10 - Utils.getPseudoRandom() * 20;
                    p.yThreshold = p.y + 40 + Utils.getPseudoRandom() * h;
                    p.state = 'falling';
                    p.splashFrame = 0;
                }

                if (p.state === 'falling') {
                    p.x += p.vx;
                    p.y += p.vy;

                    g.strokeStyle = 'rgba(220, 235, 255, 0.45)';
                    g.lineWidth = 1;
                    g.beginPath();
                    g.moveTo(p.x, p.y);
                    g.lineTo(p.x + p.vx * 0.8, p.y + p.vy * 0.8);
                    g.stroke();

                    if (p.y >= p.yThreshold) {
                        p.state = 'splashing';
                        p.splashFrame = 0;
                    }
                } else {
                    if (p.splashFrame === 0) {
                        g.strokeStyle = 'rgba(220, 235, 255, 0.5)';
                        g.beginPath();
                        g.arc(p.x, p.yThreshold, 2, 0, Math.PI * 2);
                        g.stroke();
                        p.splashFrame = 1;
                    } else {
                        g.strokeStyle = 'rgba(220, 235, 255, 0.25)';
                        g.beginPath();
                        g.arc(p.x, p.yThreshold, 4, 0, Math.PI * 2);
                        g.stroke();

                        p.x = minX + Utils.getPseudoRandom() * w;
                        p.y = minY - 10 - Utils.getPseudoRandom() * 20;
                        p.vx = -2 - Utils.getPseudoRandom() * 2;
                        p.vy = 10 + Utils.getPseudoRandom() * 5;
                        p.yThreshold = p.y + 40 + Utils.getPseudoRandom() * h;
                        p.state = 'falling';
                        p.splashFrame = 0;
                    }
                }
            }
        } else if (weather === 'snowy') {
            g.fillStyle = 'rgba(255, 255, 255, 0.85)';
            const minSz = snowCfg.particleMinSize !== undefined ? snowCfg.particleMinSize : 1.0;
            const maxSz = snowCfg.particleMaxSize !== undefined ? snowCfg.particleMaxSize : 2.2;
            const speedMult = snowCfg.particleSpeed !== undefined ? snowCfg.particleSpeed : 1.0;

            for (let p of this.weatherParticles) {
                // If camera moved fast, wrap particles back into view
                if (p.x < minX - 40 || p.x > maxX + 40 || p.y < minY - 40 || p.y > maxY + 40) {
                    p.x = minX + Utils.getPseudoRandom() * (w + 80) - 40;
                    p.y = minY - 10 - Utils.getPseudoRandom() * 20;
                    p.vy = (1.0 + Utils.getPseudoRandom() * 1.5) * speedMult;
                    p.size = minSz + Utils.getPseudoRandom() * (maxSz - minSz);
                    p.swayOffset = Utils.getPseudoRandom() * Math.PI * 2;
                }

                p.y += p.vy;
                p.swayOffset += p.swaySpeed;
                const swayX = Math.sin(p.swayOffset) * p.swayWidth * 0.05;
                const drawX = p.x + swayX;

                g.fillRect(drawX, p.y, p.size, p.size);

                if (p.y > maxY + 10) {
                    p.x = minX + Utils.getPseudoRandom() * (w + 80) - 40;
                    p.y = minY - 5;
                    p.vy = (1.0 + Utils.getPseudoRandom() * 1.5) * speedMult;
                    p.size = minSz + Utils.getPseudoRandom() * (maxSz - minSz);
                    p.swayOffset = Utils.getPseudoRandom() * Math.PI * 2;
                }
            }
        }
    },

    quit: function () {
        this.interrupted = true;
    },

    onGUI: function () {
        if (!this.levelReady || !this.currentLevel || !this.g) {
            return;
        }
        this.g.save();
        this.g.translate(this.camX, this.camY);
        this.currentLevel.onGUIAll(this.g);
        this.g.restore();
    }
};

Settings.app = Application;
if(typeof window !== 'undefined') {
    window.Application = Application;
    window.Settings = Settings;
}

module.exports = { Application };
