const { GameObject } = require('./gameobject.js');
const { Settings } = require('../../settings.js');
const { Utils } = require('../lib/utils.js');
const { Time } = require('../lib/time.js');
const { Team } = require('./team.js');
const { Goal } = require('./goal.js');
const {
    createPitchRegions,
    configuredGrid
} = require('../lib/pitch_regions.js');

class Pitch extends GameObject {
    constructor() {
        super('Pitch');
        const field = Utils.getFieldBounds();
        this.widthTiles = field.width;
        this.heightTiles = field.height;

        this.leftNetExp = 0;
        this.leftNetExpVel = 0;
        this.rightNetExp = 0;
        this.rightNetExpVel = 0;

        /** @type {Team|null} side A (attacks right in 1st half) */
        this.teamA = null;
        /** @type {Team|null} side B */
        this.teamB = null;

        /** @type {Goal|null} goal at x=0 */
        this.leftGoal = null;
        /** @type {Goal|null} goal at x=width */
        this.rightGoal = null;

        /** @type {import('../lib/pitch_regions.js').PitchRegion[]|null} */
        this.regions = null;
        this._regionKey = null;
        this._goalKey = null;

        // Cache variables
        this.cacheCanvas = null;
        this.cacheCtx = null;
        this.cacheOffsetX = 0;
        this.cacheOffsetY = 0;
        this.cacheParams = {
            projectionMode: null,
            scale: null,
            fieldMultiplier: null,
            offsetX: null,
            offsetY: null,
            weather: null
        };

        this.ensureRegions();
        this.ensureGoals();
    }

    /**
     * Rebuild pitch regions when field size / grid config changes.
     * @returns {import('../lib/pitch_regions.js').PitchRegion[]}
     */
    ensureRegions() {
        const field = Utils.getFieldBounds();
        const { cols, rows } = configuredGrid();
        const key = `${field.width}x${field.height}x${field.multiplier || 1}:${cols}x${rows}`;
        if (this.regions && this._regionKey === key) {
            return this.regions;
        }
        this.regions = createPitchRegions(field, cols, rows);
        this._regionKey = key;
        this.widthTiles = field.width;
        this.heightTiles = field.height;
        return this.regions;
    }

    getRegionFromIndex(id) {
        this.ensureRegions();
        if (!this.regions || id < 0 || id >= this.regions.length) return null;
        return this.regions[id];
    }

    /**
     * Rebuild left/right goals when field size changes.
     * @returns {{ left: Goal, right: Goal }}
     */
    ensureGoals() {
        const field = Utils.getFieldBounds();
        const key = `${field.width}x${field.height}x${field.multiplier || 1}`;
        if (this.leftGoal && this.rightGoal && this._goalKey === key) {
            return { left: this.leftGoal, right: this.rightGoal };
        }

        // Drop previous Goal children
        this.children = this.children.filter(c => !(c instanceof Goal));

        const pair = Goal.createPair(field);
        this.leftGoal = pair.left;
        this.rightGoal = pair.right;
        this._goalKey = key;
        this.widthTiles = field.width;
        this.heightTiles = field.height;

        this.insertChild(this.leftGoal);
        this.insertChild(this.rightGoal);

        // Re-wire team goal pointers if squads already exist
        if (this.teamA) this.teamA.wireGoals(this);
        if (this.teamB) this.teamB.wireGoals(this);

        return { left: this.leftGoal, right: this.rightGoal };
    }

    /**
     * Create both squads as children (Pitch → Team → Player).
     * Idempotent: replaces existing team children if called again.
     * @param {string} teamAName
     * @param {string} teamBName
     * @returns {{ teamA: Team, teamB: Team }}
     */
    createTeams(teamAName, teamBName) {
        this.ensureRegions();
        this.ensureGoals();
        // Drop previous team nodes if any
        this.children = this.children.filter(c => !(c instanceof Team));

        this.teamA = new Team('A', teamAName);
        this.teamB = new Team('B', teamBName);
        this.teamA.opponents = this.teamB;
        this.teamB.opponents = this.teamA;
        this.teamA.wireGoals(this);
        this.teamB.wireGoals(this);

        this.insertChild(this.teamA);
        this.insertChild(this.teamB);

        return { teamA: this.teamA, teamB: this.teamB };
    }

    getTeam(teamKey) {
        return teamKey === 'B' ? this.teamB : this.teamA;
    }

    update() {
        const dt = Time.deltaTime;
        if (dt <= 0) return;

        const k = 140.0;
        const c = 8.0;

        const leftAcc = -k * this.leftNetExp - c * this.leftNetExpVel;
        this.leftNetExpVel += leftAcc * dt;
        this.leftNetExp += this.leftNetExpVel * dt;

        const rightAcc = -k * this.rightNetExp - c * this.rightNetExpVel;
        this.rightNetExpVel += rightAcc * dt;
        this.rightNetExp += this.rightNetExpVel * dt;

        if (this.leftNetExp < -0.3) {
            this.leftNetExp = -0.3;
            this.leftNetExpVel = 0;
        }
        if (this.rightNetExp < -0.3) {
            this.rightNetExp = -0.3;
            this.rightNetExpVel = 0;
        }
    }

    checkCacheValid() {
        if (!this.cacheCanvas) return false;
        
        const scale = Settings.camera ? Settings.camera.scale : Settings.BASE_SCALE;
        const { offsetX, offsetY } = Utils.getCameraOffsets();
        
        return this.cacheParams.projectionMode === Settings.projectionMode &&
               this.cacheParams.scale === scale &&
               this.cacheParams.fieldMultiplier === Settings.FIELD_SIZE_MULTIPLIER &&
               this.cacheParams.offsetX === offsetX &&
               this.cacheParams.offsetY === offsetY &&
               this.cacheParams.weather === Settings.weather;
    }

    rebuildCache(fw, fh, fcX, fcY, scale, tw, th, s, surroundMargin) {
        const { offsetX, offsetY } = Utils.getCameraOffsets();
        
        // 1. Calculate bounding box of the projected field (expanded for stadium stands)
        const stadiumMarginX = surroundMargin + s(11.25);
        const stadiumMarginY = surroundMargin + s(11.25);
        // Peak stand z (rows × step height) + headroom so elevated crowd is not clipped
        const standPeakZ = s(9.5);

        const c00 = Utils.toScreen(-stadiumMarginX, -stadiumMarginY);
        const c10 = Utils.toScreen(fw + stadiumMarginX, -stadiumMarginY);
        const c01 = Utils.toScreen(-stadiumMarginX, fh + surroundMargin);
        const c11 = Utils.toScreen(fw + stadiumMarginX, fh + surroundMargin);
        // Elevated back-of-stand corners (z lifts screen Y upward)
        const e00 = Utils.toScreen(-stadiumMarginX, -stadiumMarginY, standPeakZ);
        const e10 = Utils.toScreen(fw + stadiumMarginX, -stadiumMarginY, standPeakZ);

        const minX = Math.min(c00.x, c10.x, c01.x, c11.x, e00.x, e10.x);
        const maxX = Math.max(c00.x, c10.x, c01.x, c11.x, e00.x, e10.x);
        const minY = Math.min(c00.y, c10.y, c01.y, c11.y, e00.y, e10.y);
        const maxY = Math.max(c00.y, c10.y, c01.y, c11.y, e00.y, e10.y);
        
        const cacheWidth = Math.ceil(maxX - minX) + 2;
        const cacheHeight = Math.ceil(maxY - minY) + 2;
        
        this.cacheOffsetX = minX;
        this.cacheOffsetY = minY;
        
        // 2. Create offscreen canvas if needed
        if (!this.cacheCanvas) {
            if (typeof document !== 'undefined') {
                this.cacheCanvas = document.createElement('canvas');
            } else {
                // Mock for headless tests
                this.cacheCanvas = { width: 0, height: 0, getContext: () => null };
            }
        }
        
        this.cacheCanvas.width = cacheWidth;
        this.cacheCanvas.height = cacheHeight;
        this.cacheCtx = this.cacheCanvas.getContext ? this.cacheCanvas.getContext('2d') : null;
        
        if (!this.cacheCtx) return;
        
        // 3. Draw pitch onto cacheCtx, translated by (-minX, -minY)
        const cg = this.cacheCtx;
        cg.save();
        cg.translate(-minX, -minY);
        
        const drawProjectedQuad = (x0, y0, x1, y1) => {
            const tl = Utils.toScreen(x0, y0);
            const tr = Utils.toScreen(x1, y0);
            const br = Utils.toScreen(x1, y1);
            const bl = Utils.toScreen(x0, y1);
            cg.beginPath();
            cg.moveTo(tl.x, tl.y);
            cg.lineTo(tr.x, tr.y);
            cg.lineTo(br.x, br.y);
            cg.lineTo(bl.x, bl.y);
            cg.closePath();
            cg.fill();
        };

        // Darker runoff band hugging the pitch
        cg.fillStyle = '#224d22';
        drawProjectedQuad(
            -surroundMargin,
            -surroundMargin,
            fw + surroundMargin,
            fh + surroundMargin
        );

        // Stadium Stands / Crowd background (Only at the top, behind advertising sponsors)
        const drawStandStep = (x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, stepIndex) => {
            const p0 = Utils.toScreen(x0, y0, z0);
            const p1 = Utils.toScreen(x1, y1, z1);
            const p2 = Utils.toScreen(x2, y2, z2);
            const p3 = Utils.toScreen(x3, y3, z3);
            
            cg.fillStyle = stepIndex % 2 === 0 ? '#4c4e52' : '#383a3d';
            cg.beginPath();
            cg.moveTo(p0.x, p0.y);
            cg.lineTo(p1.x, p1.y);
            cg.lineTo(p2.x, p2.y);
            cg.lineTo(p3.x, p3.y);
            cg.closePath();
            cg.fill();
            
            cg.strokeStyle = '#232526';
            cg.lineWidth = 1.0;
            cg.beginPath();
            cg.moveTo(p3.x, p3.y);
            cg.lineTo(p2.x, p2.y);
            cg.stroke();
        };

        // Crowd dots are intentionally smaller than the 64px player tiles, but large
        // enough to read as people (~1/3 player height) rather than noise.
        const drawSpectators = (xStart, yStart, zStart, xEnd, yEnd, zEnd, count, depthScale) => {
            const shirtColors = ['#ff4444', '#3388ff', '#ffcc00', '#ffffff', '#ff8800', '#22cc88', '#aa44ff', '#ff66b2', '#2244aa', '#cc3333'];
            const skinColors = ['#ffd1a4', '#e0ac69', '#8d5524', '#c68b59', '#ffdbac'];
            const hairColors = ['#111111', '#5e3a24', '#b08d57', '#d6b85c', '#888888'];

            const m = scale / Settings.BASE_SCALE;
            const base = 2.7 * m * depthScale;

            for (let i = 0; i < count; i++) {
                const t = (i + 0.5) / count;
                // Slight lateral pack offset so the row does not look perfectly grid-aligned
                const packOffset = ((i % 3) - 1) * 0.1;
                const x = xStart + t * (xEnd - xStart) + packOffset;
                const y = yStart + t * (yEnd - yStart);
                const z = zStart + t * (zEnd - zStart);

                const pt = Utils.toScreen(x, y, z);

                const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
                const r1 = Math.abs(seed) % 1.0;
                const r2 = Math.abs(seed * 10) % 1.0;
                const r3 = Math.abs(seed * 100) % 1.0;
                const r4 = Math.abs(seed * 1000) % 1.0;

                const shirt = shirtColors[Math.floor(r1 * shirtColors.length)];
                const skin = skinColors[Math.floor(r2 * skinColors.length)];
                const hair = hairColors[Math.floor(r3 * hairColors.length)];

                // Height / width variance keeps a packed terrace from looking stamped
                const person = base * (0.9 + r4 * 0.28);
                const bodyW = 5.4 * person;
                const bodyH = 7.8 * person;
                const headR = 2.7 * person;
                const jx = (r1 - 0.5) * 2.8 * m;
                const jy = (r2 - 0.5) * 1.4 * m;
                const cx = pt.x + jx;
                const bodyTop = pt.y - bodyH * 0.32 + jy;
                const headY = bodyTop - headR * 0.45;

                // Soft silhouette so bright kits pop on the grey steps
                cg.fillStyle = 'rgba(0,0,0,0.28)';
                cg.fillRect(cx - bodyW * 0.5 - 0.6 * m, bodyTop - 0.4 * m, bodyW + 1.2 * m, bodyH + 0.8 * m);

                // Torso
                cg.fillStyle = shirt;
                cg.fillRect(cx - bodyW * 0.5, bodyTop, bodyW, bodyH);

                // Head
                cg.fillStyle = skin;
                cg.beginPath();
                cg.arc(cx, headY, headR, 0, Math.PI * 2);
                cg.fill();

                // Hair cap
                cg.fillStyle = hair;
                cg.beginPath();
                cg.arc(cx, headY - headR * 0.12, headR * 0.92, Math.PI, 0);
                cg.fill();
            }
        };

        const standsRows = 6;
        const rowDepth = s(1.7);
        const rowHeight = s(1.2);

        // Draw top crowd stands (behind upper touchline)
        for (let r = standsRows - 1; r >= 0; r--) {
            const y0 = -surroundMargin - r * rowDepth;
            const y1 = -surroundMargin - (r + 1) * rowDepth;
            const z0 = r * rowHeight;
            const z1 = (r + 1) * rowHeight;

            drawStandStep(
                -stadiumMarginX, y1, z1,
                fw + stadiumMarginX, y1, z1,
                fw + stadiumMarginX, y0, z0,
                -stadiumMarginX, y0, z0,
                r
            );

            // Front rows slightly larger than distant terrace rows
            const depthScale = 0.86 + ((standsRows - 1 - r) / Math.max(1, standsRows - 1)) * 0.22;
            // Spacing tuned for larger bodies: dense pack without becoming a solid smear
            const specCount = Math.floor((fw + 2 * stadiumMarginX) / 1.2);
            drawSpectators(
                -stadiumMarginX, (y0 + y1) / 2, (z0 + z1) / 2 + 0.45,
                fw + stadiumMarginX, (y0 + y1) / 2, (z0 + z1) / 2 + 0.45,
                specCount,
                depthScale
            );
        }

        // Improved Advertising Boards
        const drawAdBoard = (xStart, yStart, xEnd, yEnd, boardColor, textLineColor, sponsorName = "") => {
            const p0 = Utils.toScreen(xStart, yStart, 0);
            const p1 = Utils.toScreen(xStart, yStart, 0.7);
            const p2 = Utils.toScreen(xEnd, yEnd, 0.7);
            const p3 = Utils.toScreen(xEnd, yEnd, 0);

            // Draw back support legs
            cg.strokeStyle = '#1b1b1c';
            cg.lineWidth = 1.5;
            const leg1Bottom = Utils.toScreen(xStart + s(0.625), yStart + s(0.1), 0);
            const leg1Top = Utils.toScreen(xStart + s(0.625), yStart + s(0.1), 0.7);
            cg.beginPath(); cg.moveTo(leg1Bottom.x, leg1Bottom.y); cg.lineTo(leg1Top.x, leg1Top.y); cg.stroke();

            const leg2Bottom = Utils.toScreen(xEnd - s(0.625), yEnd + s(0.1), 0);
            const leg2Top = Utils.toScreen(xEnd - s(0.625), yEnd + s(0.1), 0.7);
            cg.beginPath(); cg.moveTo(leg2Bottom.x, leg2Bottom.y); cg.lineTo(leg2Top.x, leg2Top.y); cg.stroke();

            // Main board face
            cg.fillStyle = boardColor;
            cg.beginPath();
            cg.moveTo(p0.x, p0.y);
            cg.lineTo(p1.x, p1.y);
            cg.lineTo(p2.x, p2.y);
            cg.lineTo(p3.x, p3.y);
            cg.closePath();
            cg.fill();

            // White border
            cg.strokeStyle = '#FFFFFF';
            cg.lineWidth = 1.0;
            cg.beginPath();
            cg.moveTo(p0.x, p0.y);
            cg.lineTo(p1.x, p1.y);
            cg.lineTo(p2.x, p2.y);
            cg.lineTo(p3.x, p3.y);
            cg.closePath();
            cg.stroke();

            // Retro sponsor name
            if (sponsorName) {
                cg.fillStyle = '#FFFFFF';
                const centerX = (p1.x + p2.x) / 2;
                const centerY = (p1.y + p0.y) / 2;
                cg.font = "bold " + Math.round(5.5 * (scale / Settings.BASE_SCALE)) + "px monospace";
                cg.textAlign = "center";
                cg.textBaseline = "middle";
                cg.fillText(sponsorName, centerX, centerY);
            } else {
                cg.strokeStyle = textLineColor;
                cg.lineWidth = 1.5;
                cg.beginPath();
                cg.moveTo((p1.x + p0.x)/2 + 2, (p1.y + p0.y)/2);
                cg.lineTo((p2.x + p3.x)/2 - 2, (p2.y + p3.y)/2);
                cg.stroke();
            }
        };

        const boardWidth = s(7.5);
        const boardGap = s(0.625);
        const adColors = ['#e6194B', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6'];
        const sponsorNames = ["GEMINI", "AGY", "GROK", "PIXEL", "DEEPMIND", "RETRO", "SOCCER", "CHAMP", "PLAY", "GOAL", "KICK", "STADIUM"];

        // 1. Draw top advertising boards
        let adIndex = 0;
        for (let x = -surroundMargin + boardGap; x < fw + surroundMargin - boardWidth; x += boardWidth + boardGap) {
            const bColor = adColors[adIndex % adColors.length];
            const sponsor = sponsorNames[adIndex % sponsorNames.length];
            adIndex++;
            drawAdBoard(x, -surroundMargin + 0.1, x + boardWidth, -surroundMargin + 0.1, bColor, '#FFFFFF', sponsor);
        }

        // Goal parameters in world coordinates
        const gY1 = Utils.scaleFieldY(40);
        const gY2 = Utils.scaleFieldY(60);

        // 2. Draw Left Goal Line Boards (placed away from the goal mouth)
        // Above the goal (from -surroundMargin to gY1 - s(1.5))
        let leftYIndex = 0;
        for (let y = -surroundMargin + boardGap; y < gY1 - s(2.5) - boardWidth; y += boardWidth + boardGap) {
            const bColor = adColors[leftYIndex % adColors.length];
            const sponsor = sponsorNames[(leftYIndex + 3) % sponsorNames.length];
            leftYIndex++;
            drawAdBoard(-surroundMargin + 0.1, y, -surroundMargin + 0.1, y + boardWidth, bColor, '#FFFFFF', sponsor);
        }
        // Below the goal (from gY2 + s(1.5) to fh + surroundMargin)
        for (let y = gY2 + s(2.5); y < fh + surroundMargin - boardWidth; y += boardWidth + boardGap) {
            const bColor = adColors[leftYIndex % adColors.length];
            const sponsor = sponsorNames[(leftYIndex + 5) % sponsorNames.length];
            leftYIndex++;
            drawAdBoard(-surroundMargin + 0.1, y, -surroundMargin + 0.1, y + boardWidth, bColor, '#FFFFFF', sponsor);
        }

        // 3. Draw Right Goal Line Boards (placed away from the goal mouth)
        // Above the goal
        let rightYIndex = 0;
        for (let y = -surroundMargin + boardGap; y < gY1 - s(2.5) - boardWidth; y += boardWidth + boardGap) {
            const bColor = adColors[rightYIndex % adColors.length];
            const sponsor = sponsorNames[(rightYIndex + 7) % sponsorNames.length];
            rightYIndex++;
            drawAdBoard(fw + surroundMargin - 0.1, y, fw + surroundMargin - 0.1, y + boardWidth, bColor, '#FFFFFF', sponsor);
        }
        // Below the goal
        for (let y = gY2 + s(2.5); y < fh + surroundMargin - boardWidth; y += boardWidth + boardGap) {
            const bColor = adColors[rightYIndex % adColors.length];
            const sponsor = sponsorNames[(rightYIndex + 9) % sponsorNames.length];
            rightYIndex++;
            drawAdBoard(fw + surroundMargin - 0.1, y, fw + surroundMargin - 0.1, y + boardWidth, bColor, '#FFFFFF', sponsor);
        }

        // Turf stripes based on projection mode
        if (Settings.projectionMode === 'isometric') {
            for (let x = 0; x < this.widthTiles; x++) {
                for (let y = 0; y < this.heightTiles; y++) {
                    const isLight = Math.floor(x / 4) % 2 === 0;
                    const grassColor = isLight ? '#4c9c4c' : '#418b41';
                    
                    const scr = Utils.toScreen(x, y);

                    cg.fillStyle = grassColor;
                    cg.beginPath();
                    cg.moveTo(scr.x, scr.y - th / 4);
                    cg.lineTo(scr.x + tw / 2, scr.y);
                    cg.lineTo(scr.x, scr.y + th / 4);
                    cg.lineTo(scr.x - tw / 2, scr.y);
                    cg.closePath();
                    cg.fill();
                }
            }
        } else if (Settings.projectionMode === 'topdown') {
            const { scaleX, scaleY } = Utils.getOrthoScales(scale);

            for (let x = 0; x < fw; x += 2) {
                const isLight = (x / 2) % 2 === 0;
                cg.fillStyle = isLight ? '#4c9c4c' : '#418b41';
                cg.fillRect(offsetX + x * scaleX, offsetY, 2 * scaleX, fh * scaleY);
            }
        } else {
            // orthographic broadcast
            for (let x = 0; x < fw; x += 2) {
                const isLight = (x / 2) % 2 === 0;
                cg.fillStyle = isLight ? '#4c9c4c' : '#418b41';
                const tl = Utils.toScreen(x, 0);
                const tr = Utils.toScreen(x + 2, 0);
                const br = Utils.toScreen(x + 2, fh);
                const bl = Utils.toScreen(x, fh);
                cg.beginPath();
                cg.moveTo(tl.x, tl.y);
                cg.lineTo(tr.x, tr.y);
                cg.lineTo(br.x, br.y);
                cg.lineTo(bl.x, bl.y);
                cg.closePath();
                cg.fill();
            }
        }

        // Apply weather-based field alterations
        if (Settings.weather === 'rainy') {
            cg.fillStyle = 'rgba(10, 20, 50, 0.16)';
            drawProjectedQuad(-surroundMargin, -surroundMargin, fw + surroundMargin, fh + surroundMargin);
        } else if (Settings.weather === 'snowy') {
            const snowCfg = Settings.weatherSnow || {};
            // Faint white/cyan tint
            cg.fillStyle = snowCfg.fieldTint || 'rgba(235, 245, 255, 0.28)';
            drawProjectedQuad(-surroundMargin, -surroundMargin, fw + surroundMargin, fh + surroundMargin);

            // Procedurally generate sparse, static pools of snow
            let lcgSeed = 98765;
            const lcgRandom = () => {
                lcgSeed = (lcgSeed * 1664525 + 1013904223) % 4294967296;
                return lcgSeed / 4294967296;
            };

            const numPools = snowCfg.poolCount !== undefined ? snowCfg.poolCount : 25;
            const minSize = snowCfg.poolMinSize !== undefined ? snowCfg.poolMinSize : 0.15;
            const maxSize = snowCfg.poolMaxSize !== undefined ? snowCfg.poolMaxSize : 0.6;
            const opacity = snowCfg.poolOpacity !== undefined ? snowCfg.poolOpacity : 0.85;

            for (let i = 0; i < numPools; i++) {
                const px = lcgRandom() * fw;
                const py = lcgRandom() * fh;
                const baseRadius = (minSize + lcgRandom() * (maxSize - minSize)) * scale;
                const screenPt = Utils.toScreen(px, py);

                cg.fillStyle = 'rgba(255, 255, 255, ' + opacity + ')';
                const drawBlob = (cx, cy, rx, ry) => {
                    cg.beginPath();
                    if (cg.ellipse) {
                        cg.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                    } else {
                        cg.arc(cx, cy, rx, 0, Math.PI * 2);
                    }
                    cg.fill();
                };

                const rx = baseRadius;
                const ry = baseRadius * 0.5; // vertical squish for ground perspective
                drawBlob(screenPt.x, screenPt.y, rx, ry);

                const numSubBlobs = 1 + Math.floor(lcgRandom() * 2);
                for (let j = 0; j < numSubBlobs; j++) {
                    const ox = (lcgRandom() - 0.5) * rx * 0.8;
                    const oy = (lcgRandom() - 0.5) * ry * 0.8;
                    const srx = rx * (0.4 + lcgRandom() * 0.4);
                    const sry = srx * 0.5;
                    drawBlob(screenPt.x + ox, screenPt.y + oy, srx, sry);
                }
            }
        }

        const drawLine = (p1, p2, color = '#FFFFFF', width = 2) => {
            const s1 = Utils.toScreen(p1.x, p1.y, p1.z || 0);
            const s2 = Utils.toScreen(p2.x, p2.y, p2.z || 0);
            cg.strokeStyle = color;
            cg.lineWidth = width;
            cg.beginPath();
            cg.moveTo(s1.x, s1.y);
            cg.lineTo(s2.x, s2.y);
            cg.stroke();
        };

        const drawPenaltyArc = (cx, cy, radius, boxLineX, side) => {
            const dx = Math.abs(boxLineX - cx);
            if (dx >= radius) return;
            const alpha = Math.acos(dx / radius);
            const segments = 16;
            cg.strokeStyle = '#FFFFFF';
            cg.lineWidth = 2;
            cg.beginPath();
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const angle = side === 'left'
                    ? -alpha + 2 * alpha * t
                    : Math.PI - alpha + 2 * alpha * t;
                const lx = cx + radius * Math.cos(angle);
                const ly = cy + radius * Math.sin(angle);
                const pt = Utils.toScreen(lx, ly);
                if (i === 0) cg.moveTo(pt.x, pt.y);
                else cg.lineTo(pt.x, pt.y);
            }
            cg.stroke();
        };

        // Outer border lines
        drawLine({x: 0, y: 0}, {x: fw, y: 0});
        drawLine({x: fw, y: 0}, {x: fw, y: fh});
        drawLine({x: fw, y: fh}, {x: 0, y: fh});
        drawLine({x: 0, y: fh}, {x: 0, y: 0});

        // Halfway line
        drawLine({x: fcX, y: 0}, {x: fcX, y: fh});

        // Center circle
        cg.strokeStyle = '#FFFFFF';
        cg.lineWidth = 2;
        cg.beginPath();
        const center = { x: fcX, y: fcY };
        const radius = s(10.9375);
        for (let i = 0; i <= 24; i++) {
            const angle = (i / 24) * Math.PI * 2;
            const lx = center.x + radius * Math.cos(angle);
            const ly = center.y + radius * Math.sin(angle);
            const scr = Utils.toScreen(lx, ly);
            if (i === 0) cg.moveTo(scr.x, scr.y);
            else cg.lineTo(scr.x, scr.y);
        }
        cg.stroke();

        // Center spot
        cg.fillStyle = '#FFFFFF';
        const spot = Utils.toScreen(fcX, fcY);
        cg.beginPath();
        cg.arc(spot.x, spot.y, 3, 0, Math.PI * 2);
        cg.fill();

        // Penalty boxes
        // Left Box
        drawLine({x: 0, y: s(12.5)}, {x: s(15.625), y: s(12.5)});
        drawLine({x: s(15.625), y: s(12.5)}, {x: s(15.625), y: s(50)});
        drawLine({x: 0, y: s(50)}, {x: s(15.625), y: s(50)});
        // Left goal box
        drawLine({x: 0, y: s(21.875)}, {x: s(6.25), y: s(21.875)});
        drawLine({x: s(6.25), y: s(21.875)}, {x: s(6.25), y: s(40.625)});
        drawLine({x: 0, y: s(40.625)}, {x: s(6.25), y: s(40.625)});
        // Left Penalty spot
        const spotL = Utils.toScreen(s(12.5), fcY);
        cg.beginPath();
        cg.arc(spotL.x, spotL.y, 2, 0, Math.PI * 2);
        cg.fill();
        drawPenaltyArc(s(12.5), fcY, s(10.9375), s(15.625), 'left');

        // Right Box
        drawLine({x: fw, y: s(12.5)}, {x: fw - s(15.625), y: s(12.5)});
        drawLine({x: fw - s(15.625), y: s(12.5)}, {x: fw - s(15.625), y: s(50)});
        drawLine({x: fw, y: s(50)}, {x: fw - s(15.625), y: s(50)});
        // Right goal box
        drawLine({x: fw, y: s(21.875)}, {x: fw - s(6.25), y: s(21.875)});
        drawLine({x: fw - s(6.25), y: s(21.875)}, {x: fw - s(6.25), y: s(40.625)});
        drawLine({x: fw, y: s(40.625)}, {x: fw - s(6.25), y: s(40.625)});
        // Right Penalty spot
        const spotR = Utils.toScreen(fw - s(12.5), fcY);
        cg.beginPath();
        cg.arc(spotR.x, spotR.y, 2, 0, Math.PI * 2);
        cg.fill();
        drawPenaltyArc(fw - s(12.5), fcY, s(10.9375), fw - s(15.625), 'right');

        // Corner Arcs (sampled in 8 segments for curved projection)
        const drawCornerArc = (cx, cy, startAngle, endAngle) => {
            const segments = 8;
            const r = s(1.25);
            cg.strokeStyle = '#FFFFFF';
            cg.lineWidth = 2;
            cg.beginPath();
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const angle = startAngle + t * (endAngle - startAngle);
                const lx = cx + r * Math.cos(angle);
                const ly = cy + r * Math.sin(angle);
                const pt = Utils.toScreen(lx, ly);
                if (i === 0) cg.moveTo(pt.x, pt.y);
                else cg.lineTo(pt.x, pt.y);
            }
            cg.stroke();
        };

        drawCornerArc(0, 0, 0, Math.PI / 2);                   // Top-Left
        drawCornerArc(0, fh, -Math.PI / 2, 0);                 // Bottom-Left
        drawCornerArc(fw, 0, Math.PI / 2, Math.PI);             // Top-Right
        drawCornerArc(fw, fh, Math.PI, 3 * Math.PI / 2);        // Bottom-Right

        cg.restore();

        // 4. Record cache params
        this.cacheParams.projectionMode = Settings.projectionMode;
        this.cacheParams.scale = scale;
        this.cacheParams.fieldMultiplier = Settings.FIELD_SIZE_MULTIPLIER;
        this.cacheParams.offsetX = offsetX;
        this.cacheParams.offsetY = offsetY;
        this.cacheParams.weather = Settings.weather;
    }

    render(g) {
        const field = Utils.getFieldBounds();
        const fw = field.width;
        const fh = field.height;
        const fcX = field.centerX;
        const fcY = field.centerY;
        const s = (v) => Utils.scaleFieldX(v);

        const scale = Settings.camera ? Settings.camera.scale : Settings.BASE_SCALE;
        const tw = scale * 1.2;
        const th = scale * 1.2;
        const surroundMargin = s(3.75);

        // Check if this is a real browser canvas context
        const isRealContext = typeof g.drawImage === 'function' && g.canvas;

        if (isRealContext) {
            // 1. Rebuild the offscreen cache if parameters changed
            if (!this.checkCacheValid()) {
                this.rebuildCache(fw, fh, fcX, fcY, scale, tw, th, s, surroundMargin);
            }

            // 2. Draw cached field turf and markings
            if (this.cacheCanvas && this.cacheCanvas.width > 0) {
                g.drawImage(this.cacheCanvas, this.cacheOffsetX, this.cacheOffsetY);
            }
        } else {
            // Bypass cache: draw directly to g (e.g. for mock tests)
            const { offsetX, offsetY } = Utils.getCameraOffsets();
            
            const drawProjectedQuad = (x0, y0, x1, y1) => {
                const tl = Utils.toScreen(x0, y0);
                const tr = Utils.toScreen(x1, y0);
                const br = Utils.toScreen(x1, y1);
                const bl = Utils.toScreen(x0, y1);
                g.beginPath();
                g.moveTo(tl.x, tl.y);
                g.lineTo(tr.x, tr.y);
                g.lineTo(br.x, br.y);
                g.lineTo(bl.x, bl.y);
                g.closePath();
                g.fill();
            };

            g.fillStyle = '#224d22';
            drawProjectedQuad(-surroundMargin, -surroundMargin, fw + surroundMargin, fh + surroundMargin);

            if (Settings.projectionMode === 'isometric') {
                for (let x = 0; x < this.widthTiles; x++) {
                    for (let y = 0; y < this.heightTiles; y++) {
                        const isLight = Math.floor(x / 4) % 2 === 0;
                        const grassColor = isLight ? '#4c9c4c' : '#418b41';
                        const scr = Utils.toScreen(x, y);
                        g.fillStyle = grassColor;
                        g.beginPath();
                        g.moveTo(scr.x, scr.y - th / 4);
                        g.lineTo(scr.x + tw / 2, scr.y);
                        g.lineTo(scr.x, scr.y + th / 4);
                        g.lineTo(scr.x - tw / 2, scr.y);
                        g.closePath();
                        g.fill();
                    }
                }
            } else if (Settings.projectionMode === 'topdown') {
                const { scaleX, scaleY } = Utils.getOrthoScales(scale);
                for (let x = 0; x < fw; x += 2) {
                    const isLight = (x / 2) % 2 === 0;
                    g.fillStyle = isLight ? '#4c9c4c' : '#418b41';
                    g.fillRect(offsetX + x * scaleX, offsetY, 2 * scaleX, fh * scaleY);
                }
            } else {
                for (let x = 0; x < fw; x += 2) {
                    const isLight = (x / 2) % 2 === 0;
                    g.fillStyle = isLight ? '#4c9c4c' : '#418b41';
                    const tl = Utils.toScreen(x, 0);
                    const tr = Utils.toScreen(x + 2, 0);
                    const br = Utils.toScreen(x + 2, fh);
                    const bl = Utils.toScreen(x, fh);
                    g.beginPath();
                    g.moveTo(tl.x, tl.y);
                    g.lineTo(tr.x, tr.y);
                    g.lineTo(br.x, br.y);
                    g.lineTo(bl.x, bl.y);
                    g.closePath();
                    g.fill();
                }
            }

            const drawLine = (p1, p2, color = '#FFFFFF', width = 2) => {
                const s1 = Utils.toScreen(p1.x, p1.y, p1.z || 0);
                const s2 = Utils.toScreen(p2.x, p2.y, p2.z || 0);
                g.strokeStyle = color;
                g.lineWidth = width;
                g.beginPath();
                g.moveTo(s1.x, s1.y);
                g.lineTo(s2.x, s2.y);
                g.stroke();
            };

            const drawPenaltyArc = (cx, cy, radius, boxLineX, side) => {
                const dx = Math.abs(boxLineX - cx);
                if (dx >= radius) return;
                const alpha = Math.acos(dx / radius);
                const segments = 16;
                g.strokeStyle = '#FFFFFF';
                g.lineWidth = 2;
                g.beginPath();
                for (let i = 0; i <= segments; i++) {
                    const t = i / segments;
                    const angle = side === 'left'
                        ? -alpha + 2 * alpha * t
                        : Math.PI - alpha + 2 * alpha * t;
                    const lx = cx + radius * Math.cos(angle);
                    const ly = cy + radius * Math.sin(angle);
                    const pt = Utils.toScreen(lx, ly);
                    if (i === 0) g.moveTo(pt.x, pt.y);
                    else g.lineTo(pt.x, pt.y);
                }
                g.stroke();
            };

            drawLine({x: 0, y: 0}, {x: fw, y: 0});
            drawLine({x: fw, y: 0}, {x: fw, y: fh});
            drawLine({x: fw, y: fh}, {x: 0, y: fh});
            drawLine({x: 0, y: fh}, {x: 0, y: 0});
            drawLine({x: fcX, y: 0}, {x: fcX, y: fh});

            g.strokeStyle = '#FFFFFF';
            g.lineWidth = 2;
            g.beginPath();
            const center = { x: fcX, y: fcY };
            const radius = s(10.9375);
            for (let i = 0; i <= 24; i++) {
                const angle = (i / 24) * Math.PI * 2;
                const lx = center.x + radius * Math.cos(angle);
                const ly = center.y + radius * Math.sin(angle);
                const scr = Utils.toScreen(lx, ly);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();

            g.fillStyle = '#FFFFFF';
            const spot = Utils.toScreen(fcX, fcY);
            g.beginPath();
            g.arc(spot.x, spot.y, 3, 0, Math.PI * 2);
            g.fill();

            drawLine({x: 0, y: s(12.5)}, {x: s(15.625), y: s(12.5)});
            drawLine({x: s(15.625), y: s(12.5)}, {x: s(15.625), y: s(50)});
            drawLine({x: 0, y: s(50)}, {x: s(15.625), y: s(50)});
            drawLine({x: 0, y: s(21.875)}, {x: s(6.25), y: s(21.875)});
            drawLine({x: s(6.25), y: s(21.875)}, {x: s(6.25), y: s(40.625)});
            drawLine({x: 0, y: s(40.625)}, {x: s(6.25), y: s(40.625)});
            const spotL = Utils.toScreen(s(12.5), fcY);
            g.beginPath();
            g.arc(spotL.x, spotL.y, 2, 0, Math.PI * 2);
            g.fill();
            drawPenaltyArc(s(12.5), fcY, s(10.9375), s(15.625), 'left');

            drawLine({x: fw, y: s(12.5)}, {x: fw - s(15.625), y: s(12.5)});
            drawLine({x: fw - s(15.625), y: s(12.5)}, {x: fw - s(15.625), y: s(50)});
            drawLine({x: fw, y: s(50)}, {x: fw - s(15.625), y: s(50)});
            drawLine({x: fw, y: s(21.875)}, {x: fw - s(6.25), y: s(21.875)});
            drawLine({x: fw - s(6.25), y: s(21.875)}, {x: fw - s(6.25), y: s(40.625)});
            drawLine({x: fw, y: s(40.625)}, {x: fw - s(6.25), y: s(40.625)});
            const spotR = Utils.toScreen(fw - s(12.5), fcY);
            g.beginPath();
            g.arc(spotR.x, spotR.y, 2, 0, Math.PI * 2);
            g.fill();
            drawPenaltyArc(fw - s(12.5), fcY, s(10.9375), fw - s(15.625), 'right');

            const drawCornerArc = (cx, cy, startAngle, endAngle) => {
                const segments = 8;
                const r = s(1.25);
                g.strokeStyle = '#FFFFFF';
                g.lineWidth = 2;
                g.beginPath();
                for (let i = 0; i <= segments; i++) {
                    const t = i / segments;
                    const angle = startAngle + t * (endAngle - startAngle);
                    const lx = cx + r * Math.cos(angle);
                    const ly = cy + r * Math.sin(angle);
                    const pt = Utils.toScreen(lx, ly);
                    if (i === 0) g.moveTo(pt.x, pt.y);
                    else g.lineTo(pt.x, pt.y);
                }
                g.stroke();
            };
            drawCornerArc(0, 0, 0, Math.PI / 2);
            drawCornerArc(0, fh, -Math.PI / 2, 0);
            drawCornerArc(fw, 0, Math.PI / 2, Math.PI);
            drawCornerArc(fw, fh, Math.PI, 3 * Math.PI / 2);
        }

        // 3. Draw 3D Goals dynamically on the main canvas (to preserve physical expansion)
        const drawLine = (p1, p2, color = '#FFFFFF', width = 2) => {
            const s1 = Utils.toScreen(p1.x, p1.y, p1.z || 0);
            const s2 = Utils.toScreen(p2.x, p2.y, p2.z || 0);
            g.strokeStyle = color;
            g.lineWidth = width;
            g.beginPath();
            g.moveTo(s1.x, s1.y);
            g.lineTo(s2.x, s2.y);
            g.stroke();
        };

        // 6. Draw 3D Goals (A & B) using projection (geometry from Goal entities)
        this.ensureGoals();
        const goalHeight = this.leftGoal.height;
        const goalDepth = this.leftGoal.renderDepth;
        const goalY1 = this.leftGoal.yMin;
        const goalY2 = this.leftGoal.yMax;

        // --- Left Goal Net Helper Functions ---
        const getLeftBackNetPos = (y, z) => {
            const factorY = Math.sin(Math.PI * (y - goalY1) / (goalY2 - goalY1));
            const factorZ = Math.sin(Math.PI * 0.5 * z / goalHeight);
            const disp = this.leftNetExp * factorY * factorZ;
            return { x: -goalDepth - disp, y: y, z: z };
        };

        const getLeftTopNetPos = (lx, ly) => {
            const ratio = lx / -goalDepth;
            const factorY = Math.sin(Math.PI * (ly - goalY1) / (goalY2 - goalY1));
            const dispX = this.leftNetExp * factorY * ratio;
            return { x: lx - dispX, y: ly, z: goalHeight };
        };

        // --- Right Goal Net Helper Functions ---
        const getRightBackNetPos = (y, z) => {
            const factorY = Math.sin(Math.PI * (y - goalY1) / (goalY2 - goalY1));
            const factorZ = Math.sin(Math.PI * 0.5 * z / goalHeight);
            const disp = this.rightNetExp * factorY * factorZ;
            return { x: fw + goalDepth + disp, y: y, z: z };
        };

        const getRightTopNetPos = (lx, ly) => {
            const ratio = (lx - fw) / goalDepth;
            const factorY = Math.sin(Math.PI * (ly - goalY1) / (goalY2 - goalY1));
            const dispX = this.rightNetExp * factorY * ratio;
            return { x: lx + dispX, y: ly, z: goalHeight };
        };

        const steps = 8;

        // Left Goal (Goal A)
        // 1. Rigid frames
        drawLine({x: 0, y: goalY1, z: 0}, {x: 0, y: goalY1, z: goalHeight}, '#FFFFFF', 3);
        drawLine({x: 0, y: goalY2, z: 0}, {x: 0, y: goalY2, z: goalHeight}, '#FFFFFF', 3);
        drawLine({x: 0, y: goalY1, z: goalHeight}, {x: 0, y: goalY2, z: goalHeight}, '#FFFFFF', 3);

        // 2. Anchor poles at the back (rigid, but net attaches to them)
        drawLine({x: -goalDepth, y: goalY1, z: 0}, {x: -goalDepth, y: goalY1, z: goalHeight}, '#888888', 1);
        drawLine({x: -goalDepth, y: goalY2, z: 0}, {x: -goalDepth, y: goalY2, z: goalHeight}, '#888888', 1);
        drawLine({x: -goalDepth, y: goalY1, z: 0}, {x: -goalDepth, y: goalY2, z: 0}, '#888888', 1);

        // 3. Side nets (flat, since they are on the boundaries)
        g.strokeStyle = 'rgba(210, 210, 210, 0.25)';
        g.lineWidth = 1;
        // Left side net
        for (let lx = 0; lx >= -goalDepth; lx -= s(0.625)) {
            drawLine({x: lx, y: goalY1, z: 0}, {x: lx, y: goalY1, z: goalHeight}, g.strokeStyle, 1);
        }
        for (let hz = Utils.scaleFieldY(1.0); hz <= goalHeight; hz += Utils.scaleFieldY(1.0)) {
            drawLine({x: 0, y: goalY1, z: hz}, {x: -goalDepth, y: goalY1, z: hz}, g.strokeStyle, 1);
        }
        // Right side net
        for (let lx = 0; lx >= -goalDepth; lx -= s(0.625)) {
            drawLine({x: lx, y: goalY2, z: 0}, {x: lx, y: goalY2, z: goalHeight}, g.strokeStyle, 1);
        }
        for (let hz = Utils.scaleFieldY(1.0); hz <= goalHeight; hz += Utils.scaleFieldY(1.0)) {
            drawLine({x: 0, y: goalY2, z: hz}, {x: -goalDepth, y: goalY2, z: hz}, g.strokeStyle, 1);
        }

        // 4. Back net mesh (curved)
        g.strokeStyle = 'rgba(210, 210, 210, 0.35)';
        g.lineWidth = 1;
        // Back net horizontal mesh lines
        for (let hz = Utils.scaleFieldY(0.75); hz <= goalHeight; hz += Utils.scaleFieldY(0.9)) {
            g.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const ly = goalY1 + t * (goalY2 - goalY1);
                const pt = getLeftBackNetPos(ly, hz);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }
        // Back net vertical mesh lines
        for (let ly = goalY1 + Utils.scaleFieldY(1.0); ly < goalY2; ly += Utils.scaleFieldY(1.25)) {
            g.beginPath();
            for (let hz = 0; hz <= goalHeight; hz += Utils.scaleFieldY(0.9)) {
                const pt = getLeftBackNetPos(ly, hz);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (hz === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }

        // 5. Top net mesh (curved)
        // Top net lines parallel to crossbar
        for (let lx = -s(0.46875); lx >= -goalDepth; lx -= s(0.46875)) {
            g.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const ly = goalY1 + t * (goalY2 - goalY1);
                const pt = getLeftTopNetPos(lx, ly);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }
        // Top net lines running front to back
        for (let ly = goalY1 + Utils.scaleFieldY(1.0); ly < goalY2; ly += Utils.scaleFieldY(1.25)) {
            g.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const lx = -t * goalDepth;
                const pt = getLeftTopNetPos(lx, ly);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }


        // Right Goal (Goal B)
        // 1. Rigid frames
        drawLine({x: fw, y: goalY1, z: 0}, {x: fw, y: goalY1, z: goalHeight}, '#FFFFFF', 3);
        drawLine({x: fw, y: goalY2, z: 0}, {x: fw, y: goalY2, z: goalHeight}, '#FFFFFF', 3);
        drawLine({x: fw, y: goalY1, z: goalHeight}, {x: fw, y: goalY2, z: goalHeight}, '#FFFFFF', 3);

        // 2. Anchor poles at the back (rigid, but net attaches to them)
        drawLine({x: fw + goalDepth, y: goalY1, z: 0}, {x: fw + goalDepth, y: goalY1, z: goalHeight}, '#888888', 1);
        drawLine({x: fw + goalDepth, y: goalY2, z: 0}, {x: fw + goalDepth, y: goalY2, z: goalHeight}, '#888888', 1);
        drawLine({x: fw + goalDepth, y: goalY1, z: 0}, {x: fw + goalDepth, y: goalY2, z: 0}, '#888888', 1);

        // 3. Side nets (flat, since they are on the boundaries)
        g.strokeStyle = 'rgba(210, 210, 210, 0.25)';
        g.lineWidth = 1;
        // Left side net
        for (let lx = fw; lx <= fw + goalDepth; lx += s(0.625)) {
            drawLine({x: lx, y: goalY1, z: 0}, {x: lx, y: goalY1, z: goalHeight}, g.strokeStyle, 1);
        }
        for (let hz = Utils.scaleFieldY(1.0); hz <= goalHeight; hz += Utils.scaleFieldY(1.0)) {
            drawLine({x: fw, y: goalY1, z: hz}, {x: fw + goalDepth, y: goalY1, z: hz}, g.strokeStyle, 1);
        }
        // Right side net
        for (let lx = fw; lx <= fw + goalDepth; lx += s(0.625)) {
            drawLine({x: lx, y: goalY2, z: 0}, {x: lx, y: goalY2, z: goalHeight}, g.strokeStyle, 1);
        }
        for (let hz = Utils.scaleFieldY(1.0); hz <= goalHeight; hz += Utils.scaleFieldY(1.0)) {
            drawLine({x: fw, y: goalY2, z: hz}, {x: fw + goalDepth, y: goalY2, z: hz}, g.strokeStyle, 1);
        }

        // 4. Back net mesh (curved)
        g.strokeStyle = 'rgba(210, 210, 210, 0.35)';
        g.lineWidth = 1;
        // Back net horizontal mesh lines
        for (let hz = Utils.scaleFieldY(0.75); hz <= goalHeight; hz += Utils.scaleFieldY(0.9)) {
            g.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const ly = goalY1 + t * (goalY2 - goalY1);
                const pt = getRightBackNetPos(ly, hz);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }
        // Back net vertical mesh lines
        for (let ly = goalY1 + Utils.scaleFieldY(1.0); ly < goalY2; ly += Utils.scaleFieldY(1.25)) {
            g.beginPath();
            for (let hz = 0; hz <= goalHeight; hz += Utils.scaleFieldY(0.9)) {
                const pt = getRightBackNetPos(ly, hz);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (hz === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }

        // 5. Top net mesh (curved)
        // Top net lines parallel to crossbar
        for (let lx = fw + s(0.46875); lx <= fw + goalDepth; lx += s(0.46875)) {
            g.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const ly = goalY1 + t * (goalY2 - goalY1);
                const pt = getRightTopNetPos(lx, ly);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }
        // Top net lines running front to back
        for (let ly = goalY1 + Utils.scaleFieldY(1.0); ly < goalY2; ly += Utils.scaleFieldY(1.25)) {
            g.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const lx = fw + t * goalDepth;
                const pt = getRightTopNetPos(lx, ly);
                const scr = Utils.toScreen(pt.x, pt.y, pt.z);
                if (i === 0) g.moveTo(scr.x, scr.y);
                else g.lineTo(scr.x, scr.y);
            }
            g.stroke();
        }
    }
}

module.exports = { Pitch };
