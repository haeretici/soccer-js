/**
 * Engine-integrated Asset Manager (viewer only).
 * Full part editor + animation rig customizer live in the standalone asset-manager/ package.
 */
const {
    SPRITE_TILE_W,
    SPRITE_TILE_H,
    SPRITE_FRAMES,
    SPRITE_DIRS,
    SPRITE_FEET_SCREEN_PX,
    ANIMATION_RIGS_IDS
} = require('../../core/lib/sprite_manifest.js');

const { hexToRgb } = require('../../core/lib/sprite_generator.js');

const {
    DEFAULT_PLAYER_COLORS,
    zlibDecompress
} = require('../../core/lib/sprite_sheets.js');
const { appUrl } = require('../../core/lib/app_paths.js');

async function initAssetManagerApp() {
    const LOGICAL_W = SPRITE_TILE_W;
    const LOGICAL_H = SPRITE_TILE_H;
    const TOTAL_DIRS = SPRITE_DIRS;
    const FEET_X = LOGICAL_W / 2;
    // SPRITE_FEET_SCREEN_PX is inset from the bottom of the tile (e.g. 6 → Y = H - 6)
    const FEET_Y = LOGICAL_H - SPRITE_FEET_SCREEN_PX;
    const TYPE_INDEX = 1;

    const TEAM_SLOTS = [
        { key: 'outline', index: 1, label: 'Outline' },
        { key: 'primary', index: 2, label: 'Primary Shirt' },
        { key: 'primaryLight', index: 3, label: 'Shirt Highlight' },
        { key: 'primaryDark', index: 4, label: 'Shirt Shadow' },
        { key: 'shorts', index: 5, label: 'Shorts' },
        { key: 'shortsDark', index: 6, label: 'Shorts Shadow' },
        { key: 'socks', index: 7, label: 'Socks' }
    ];

    const PLAYER_SLOTS = [
        { key: 'skin', index: 8, label: 'Skin Tone' },
        { key: 'skinShadow', index: 9, label: 'Skin Shadow' },
        { key: 'skinHighlight', index: 10, label: 'Skin Highlight' },
        { key: 'hair', index: 11, label: 'Hair Base' },
        { key: 'hairDark', index: 12, label: 'Hair Shadow' },
        { key: 'shoe', index: 13, label: 'Shoes / Boots' },
        { key: 'eyeWhite', index: 14, label: 'Eye White' },
        { key: 'pupil', index: 15, label: 'Pupil / Detail' }
    ];

    let animRig = null;
    let rigIds = [...(ANIMATION_RIGS_IDS || [1])];
    let activeRigId = rigIds[0] || 1;
    let loadedRigs = {};
    let rawPartCache = {};
    let recoloredPartCache = {};

    let activeAnimKey = '0';
    let activeFrameArr = [];
    let activeFrameIdx = 0;
    let activeDirection = 4;

    let palettes = null;
    let selectedTeam = 'Brazil';
    let selectedKit = 'main';
    let customPalette = {};

    let isPlaying = true;
    let animSpeedFps = 8;
    let previewScale = 6;
    let lastFrameTime = 0;

    let previewDirty = true;
    // Sheet content is stale until renderSheetGrid() runs (palette / rig load).
    let sheetDirty = true;
    let prevHighlight = { f: -1, d: -1 };
    let paletteFlushRaf = 0;
    let uiBound = false;

    const previewCanvas = document.getElementById('previewCanvas');
    const previewCtx = previewCanvas.getContext('2d');
    const sheetCanvas = document.getElementById('sheetCanvas');
    const sheetCtx = sheetCanvas.getContext('2d');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const animationBtnGroup = document.getElementById('animationBtnGroup');
    const playPauseBtn = document.getElementById('playPauseBtn');

    const composeCanvas = document.createElement('canvas');
    composeCanvas.width = LOGICAL_W;
    composeCanvas.height = LOGICAL_H;
    const composeCtx = composeCanvas.getContext('2d');

    const sheetBuffer = document.createElement('canvas');
    const sheetBufferCtx = sheetBuffer.getContext('2d');

    /** Dense sheet column count from current rig (max frame_index + 1). */
    function getSheetFrameCount() {
        let max = -1;
        if (animRig) {
            for (const anim of Object.values(animRig.animations)) {
                for (const fr of anim.frames) {
                    if (typeof fr.frame_index === 'number' && fr.frame_index > max) {
                        max = fr.frame_index;
                    }
                }
            }
        }
        if (max < 0) return Math.max(1, SPRITE_FRAMES || 1);
        return max + 1;
    }

    function markContentDirty() {
        previewDirty = true;
        sheetDirty = true;
        updateSheetButtonUI();
    }

    function updateSheetButtonUI() {
        const btn = document.getElementById('updateSheetBtn');
        if (!btn) return;
        if (sheetDirty) {
            btn.textContent = 'Update Sheet *';
            btn.classList.remove('btn-info');
            btn.classList.add('btn-warning');
            btn.title = 'Sheet is out of date — click to recompose';
        } else {
            btn.textContent = 'Update Sheet';
            btn.classList.remove('btn-warning');
            btn.classList.add('btn-info');
            btn.title = 'Recompose full spritesheet from parts + rig';
        }
    }

    async function loadPartBin(category) {
        try {
            const response = await fetch(appUrl(`assets/sprites/${category}/${TYPE_INDEX}.bin`));
            if (!response.ok) return null;

            const buf = await response.arrayBuffer();
            const view = new DataView(buf);

            const w = view.getUint16(0, true);
            const h = view.getUint16(2, true);
            const totalTiles = view.getUint16(4, true);
            const paletteCount = view.getUint16(6, true);
            const headerSize = 8 + paletteCount * 3;

            const palette = new Array(paletteCount);
            for (let i = 0; i < paletteCount; i++) {
                palette[i] = [i, 0, 0, i === 0 ? 0 : 255];
            }

            const compressedData = buf.slice(headerSize);
            const packed = await zlibDecompress(compressedData);

            const tiles = [];
            const pixelsPerTile = w * h;
            const bytesPerTile = Math.ceil(pixelsPerTile / 2);

            for (let tileIdx = 0; tileIdx < totalTiles; tileIdx++) {
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                const imgData = ctx.createImageData(w, h);
                const data = imgData.data;
                const tileOffset = tileIdx * bytesPerTile;

                for (let i = 0; i < pixelsPerTile; i++) {
                    const byteIdx = tileOffset + (i >>> 1);
                    const nibble = (i & 1) === 0
                        ? (packed[byteIdx] >>> 4)
                        : (packed[byteIdx] & 0x0F);

                    const rgba = palette[nibble] || [0, 0, 0, 0];
                    const p = i * 4;
                    data[p] = rgba[0];
                    data[p + 1] = rgba[1];
                    data[p + 2] = rgba[2];
                    data[p + 3] = rgba[3];
                }

                ctx.putImageData(imgData, 0, 0);
                tiles.push(canvas);
            }

            return tiles;
        } catch (e) {
            console.warn(`Error Loading Category: ${category}`, e);
            return null;
        }
    }

    async function loadActiveRig(rigId) {
        activeRigId = rigId;
        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
            loadingOverlay.innerText = `Loading Rig ${rigId}...`;
        }
        try {
            if (!loadedRigs[rigId]) {
                const response = await fetch(appUrl(`assets/animation_rigs/${rigId}.json`));
                if (response.ok) {
                    loadedRigs[rigId] = await response.json();
                } else {
                    if (animRig) {
                        loadedRigs[rigId] = JSON.parse(JSON.stringify(animRig));
                    } else {
                        throw new Error(`Could not load animation rig JSON for ID ${rigId}`);
                    }
                }
            }
            animRig = loadedRigs[rigId];

            const requiredParts = new Set();
            for (const anim of Object.values(animRig.animations)) {
                for (const frame of anim.frames) {
                    for (const dirData of Object.values(frame.directions)) {
                        for (const part of dirData.parts) {
                            requiredParts.add(part.part);
                        }
                    }
                }
            }

            if (loadingOverlay) loadingOverlay.innerText = `Loading ${requiredParts.size} modular parts...`;

            await Promise.all(Array.from(requiredParts).map(async (part) => {
                if (!rawPartCache[part]) {
                    const tiles = await loadPartBin(part);
                    if (tiles) rawPartCache[part] = tiles;
                }
            }));

            if (animRig.animations[activeAnimKey]) {
                activeFrameArr = animRig.animations[activeAnimKey].frames;
            } else {
                activeAnimKey = Object.keys(animRig.animations)[0];
                activeFrameArr = animRig.animations[activeAnimKey].frames;
            }
            if (activeFrameIdx >= activeFrameArr.length) {
                activeFrameIdx = 0;
            }

            buildUI();
            applyPresetColors();
            renderSheetGrid();
        } catch (err) {
            console.error(`Error loading rig ${rigId}:`, err);
            if (loadingOverlay) loadingOverlay.innerText = 'Failed to load rig data.';
        } finally {
            if (loadingOverlay) {
                setTimeout(() => { loadingOverlay.style.display = 'none'; }, 500);
            }
        }
    }

    async function init() {
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        try {
            const resPal = await fetch(appUrl('presets/palettes.json'));
            if (resPal.ok) palettes = await resPal.json();

            await loadActiveRig(activeRigId);
            resizePreviewCanvas();
            requestAnimationFrame(tick);
        } catch (e) {
            console.error('Initialization failed:', e);
            if (loadingOverlay) loadingOverlay.innerText = 'Failed to load rig data.';
        }
    }

    function buildUI() {
        if (!palettes) {
            palettes = { Brazil: { main: {}, gk: {} } };
        }

        const teamSelect = document.getElementById('teamSelect');
        if (teamSelect) {
            teamSelect.innerHTML = '';
            Object.keys(palettes).forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.innerText = name;
                teamSelect.appendChild(opt);
            });
            teamSelect.value = selectedTeam;
        }

        rebuildAnimationButtons();

        if (uiBound) {
            activeFrameArr = animRig.animations[activeAnimKey].frames;
            updateDirectionUI();
            return;
        }
        uiBound = true;

        const kitSelect = document.getElementById('kitSelect');
        if (kitSelect) {
            kitSelect.addEventListener('change', (e) => {
                selectedKit = e.target.value;
                applyPresetColors();
            });
        }
        if (teamSelect) {
            teamSelect.addEventListener('change', (e) => {
                selectedTeam = e.target.value;
                applyPresetColors();
            });
        }

        document.querySelectorAll('.radial-dir-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeDirection = parseInt(btn.getAttribute('data-dir'), 10);
                updateDirectionUI();
                previewDirty = true;
            });
        });

        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', () => {
                isPlaying = !isPlaying;
                playPauseBtn.innerText = isPlaying ? 'Pause' : 'Play';
                playPauseBtn.className = isPlaying
                    ? 'btn btn-custom-play text-white px-4'
                    : 'btn btn-success text-white px-4';
                previewDirty = true;
            });
        }

        const prevFrameBtn = document.getElementById('prevFrameBtn');
        if (prevFrameBtn) {
            prevFrameBtn.addEventListener('click', () => {
                isPlaying = false;
                if (playPauseBtn) {
                    playPauseBtn.innerText = 'Play';
                    playPauseBtn.className = 'btn btn-success text-white px-4';
                }
                activeFrameIdx = (activeFrameIdx - 1 + activeFrameArr.length) % activeFrameArr.length;
                previewDirty = true;
            });
        }

        const nextFrameBtn = document.getElementById('nextFrameBtn');
        if (nextFrameBtn) {
            nextFrameBtn.addEventListener('click', () => {
                isPlaying = false;
                if (playPauseBtn) {
                    playPauseBtn.innerText = 'Play';
                    playPauseBtn.className = 'btn btn-success text-white px-4';
                }
                activeFrameIdx = (activeFrameIdx + 1) % activeFrameArr.length;
                previewDirty = true;
            });
        }

        const fpsSlider = document.getElementById('fpsSlider');
        if (fpsSlider) {
            fpsSlider.addEventListener('input', e => {
                animSpeedFps = parseInt(e.target.value, 10);
                const valEl = document.getElementById('fpsVal');
                if (valEl) valEl.innerText = `${animSpeedFps} FPS`;
            });
        }

        const zoomSlider = document.getElementById('zoomSlider');
        if (zoomSlider) {
            zoomSlider.addEventListener('input', e => {
                previewScale = parseInt(e.target.value, 10);
                const valEl = document.getElementById('zoomVal');
                if (valEl) valEl.innerText = `${previewScale}x`;
                resizePreviewCanvas();
                previewDirty = true;
            });
        }

        const checkAnchor = document.getElementById('checkAnchor');
        if (checkAnchor) {
            checkAnchor.addEventListener('change', () => {
                previewDirty = true;
            });
        }

        if (sheetCanvas) {
            sheetCanvas.addEventListener('click', handleSheetClick);
        }

        const updateSheetBtn = document.getElementById('updateSheetBtn');
        if (updateSheetBtn) {
            updateSheetBtn.addEventListener('click', renderSheetGrid);
        }

        activeFrameArr = animRig.animations[activeAnimKey].frames;
        updateDirectionUI();
    }

    function sortAnimKeys(keys) {
        return keys.slice().sort((a, b) => {
            const na = parseInt(a, 10);
            const nb = parseInt(b, 10);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a).localeCompare(String(b));
        });
    }

    function rebuildAnimationButtons() {
        if (!animationBtnGroup || !animRig) return;
        animationBtnGroup.innerHTML = '';
        sortAnimKeys(Object.keys(animRig.animations)).forEach(animKey => {
            const anim = animRig.animations[animKey];
            const col = document.createElement('div');
            col.className = 'col-6 col-md-4';
            const btn = document.createElement('button');
            btn.className = `btn btn-sm w-100 ${animKey === activeAnimKey ? 'btn-custom-play text-white' : 'btn-outline-secondary text-white-50'}`;
            btn.innerText = anim.name;
            btn.addEventListener('click', () => {
                activeAnimKey = animKey;
                activeFrameArr = anim.frames;
                activeFrameIdx = 0;
                updateAnimationUI();
                previewDirty = true;
            });
            col.appendChild(btn);
            animationBtnGroup.appendChild(col);
        });
    }

    function applyPresetColors() {
        const kit = palettes[selectedTeam]?.[selectedKit] || {};
        customPalette = Object.assign({}, kit, DEFAULT_PLAYER_COLORS);
        buildColorSliders();
        recolorAllParts();
        markContentDirty();
    }

    function buildColorSliders() {
        const createSlider = (slot, containerId) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'col-6 col-md-4 d-flex align-items-center gap-2 mb-2';

            const input = document.createElement('input');
            input.type = 'color';
            input.className = 'form-control form-control-color bg-transparent border-0 p-0';
            input.style.width = '32px';
            input.style.height = '32px';
            input.value = customPalette[slot.key] || '#ffffff';
            input.addEventListener('input', (e) => {
                customPalette[slot.key] = e.target.value.toUpperCase();
                schedulePaletteRecolor();
            });

            const label = document.createElement('span');
            label.className = 'small text-muted font-monospace';
            label.innerText = slot.label;

            wrapper.appendChild(input);
            wrapper.appendChild(label);
            container.appendChild(wrapper);
        };

        const teamContainer = document.getElementById('teamColorsContainer');
        if (teamContainer) teamContainer.innerHTML = '';
        TEAM_SLOTS.forEach(slot => createSlider(slot, 'teamColorsContainer'));

        const playerContainer = document.getElementById('playerColorsContainer');
        if (playerContainer) playerContainer.innerHTML = '';
        PLAYER_SLOTS.forEach(slot => createSlider(slot, 'playerColorsContainer'));
    }

    function recolorCanvas(sourceCanvas, paletteUniform) {
        const recolored = document.createElement('canvas');
        recolored.width = sourceCanvas.width;
        recolored.height = sourceCanvas.height;
        const ctx = recolored.getContext('2d');
        ctx.drawImage(sourceCanvas, 0, 0);

        const imgData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        const data = imgData.data;

        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue;
            const r = data[i];
            if (r >= 1 && r <= 15) {
                const col = paletteUniform[r] || [0, 0, 0];
                data[i] = col[0];
                data[i + 1] = col[1];
                data[i + 2] = col[2];
            }
        }

        ctx.putImageData(imgData, 0, 0);
        return recolored;
    }

    function recolorAllParts() {
        const categories = Object.keys(rawPartCache);
        if (categories.length === 0) return;
        const paletteUniform = buildPaletteArray(customPalette);
        categories.forEach(category => {
            const list = rawPartCache[category];
            recoloredPartCache[category] = list.map(canvas => recolorCanvas(canvas, paletteUniform));
        });
    }

    function schedulePaletteRecolor() {
        if (paletteFlushRaf) return;
        paletteFlushRaf = requestAnimationFrame(() => {
            paletteFlushRaf = 0;
            recolorAllParts();
            markContentDirty();
        });
    }

    function buildPaletteArray(paletteObj) {
        const arr = new Array(16).fill(null);
        const map = {
            outline: 1, primary: 2, primaryLight: 3, primaryDark: 4,
            shorts: 5, shortsDark: 6, socks: 7,
            skin: 8, skinShadow: 9, skinHighlight: 10,
            hair: 11, hairDark: 12, shoe: 13, eyeWhite: 14, pupil: 15
        };

        for (const [key, idx] of Object.entries(map)) {
            arr[idx] = hexToRgb(paletteObj[key] || '#FFFFFF');
        }
        return arr;
    }

    const getPivotOffsets = (type, w, h) => {
        let x = 0, y = 0;
        const str = (type || 'top_left').toLowerCase();

        if (str.includes('center')) x = w / 2;
        if (str.includes('right')) x = w;
        if (str.includes('middle')) y = h / 2;
        if (str.includes('bottom')) y = h;

        return { x, y };
    };

    function drawComposedFrame(targetCtx, destX, destY, animKey, frameIndex, direction) {
        const anim = animRig?.animations?.[animKey];
        if (!anim) return;
        const frameData = anim.frames.find(f => f.frame_index === frameIndex);
        if (!frameData) return;

        let baseDir = direction;
        let flip = false;
        if (direction === 5) { baseDir = 3; flip = true; }
        if (direction === 6) { baseDir = 2; flip = true; }
        if (direction === 7) { baseDir = 1; flip = true; }

        const dirData = frameData.directions[baseDir];
        if (!dirData) return;

        const parts = [...dirData.parts].sort((a, b) => (a.z || 0) - (b.z || 0));

        composeCtx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

        parts.forEach(pData => {
            const partTiles = recoloredPartCache[pData.part];
            if (!partTiles) return;
            const partCanvas = partTiles[pData.tile_index];
            if (!partCanvas) return;

            composeCtx.save();

            const align = getPivotOffsets(pData.canvas_alignment, LOGICAL_W, LOGICAL_H);
            const anchor = getPivotOffsets(pData.frame_anchor, partCanvas.width, partCanvas.height);

            let dx = align.x + (pData.relative_x || 0);
            let dy = align.y + (pData.relative_y || 0);
            composeCtx.translate(dx, dy);

            let sx = (pData.scale_x ?? 100) / 100;
            let sy = (pData.scale_y ?? 100) / 100;
            if (pData.flip_horizontal) sx *= -1;
            if (pData.flip_vertical) sy *= -1;
            composeCtx.scale(sx, sy);

            if (pData.rotation) {
                composeCtx.rotate(pData.rotation * Math.PI / 180);
            }

            composeCtx.drawImage(partCanvas, -anchor.x, -anchor.y);
            composeCtx.restore();
        });

        targetCtx.save();
        targetCtx.translate(destX, destY);
        if (flip) {
            targetCtx.translate(LOGICAL_W, 0);
            targetCtx.scale(-1, 1);
        }
        targetCtx.drawImage(composeCanvas, 0, 0);
        targetCtx.restore();
    }

    function ensureDisplaySheetSize() {
        if (!sheetCanvas) return;
        const frameCount = getSheetFrameCount();
        const w = LOGICAL_W * frameCount;
        const h = LOGICAL_H * TOTAL_DIRS;
        if (sheetCanvas.width !== w || sheetCanvas.height !== h) {
            sheetCanvas.width = w;
            sheetCanvas.height = h;
        }
    }

    function ensureSheetBufferSize() {
        const frameCount = getSheetFrameCount();
        const w = LOGICAL_W * frameCount;
        const h = LOGICAL_H * TOTAL_DIRS;
        if (sheetBuffer.width !== w || sheetBuffer.height !== h) {
            sheetBuffer.width = w;
            sheetBuffer.height = h;
        }
    }

    function blitSheetWithHighlight() {
        if (!sheetCanvas || !sheetCtx) return;
        ensureDisplaySheetSize();
        sheetCtx.imageSmoothingEnabled = false;
        sheetCtx.clearRect(0, 0, sheetCanvas.width, sheetCanvas.height);

        if (sheetBuffer.width > 0 && sheetBuffer.height > 0) {
            sheetCtx.drawImage(sheetBuffer, 0, 0);
        }

        const { f, d } = prevHighlight;
        if (f >= 0 && d >= 0) {
            sheetCtx.strokeStyle = '#ff0077';
            sheetCtx.lineWidth = 2;
            sheetCtx.shadowColor = '#ff0077';
            sheetCtx.shadowBlur = 8;
            sheetCtx.strokeRect(f * LOGICAL_W, d * LOGICAL_H, LOGICAL_W, LOGICAL_H);
            sheetCtx.shadowBlur = 0;
        }
    }

    function renderSheetGrid() {
        if (!sheetCanvas || !animRig) return;
        ensureSheetBufferSize();
        ensureDisplaySheetSize();

        sheetBufferCtx.imageSmoothingEnabled = false;
        sheetBufferCtx.clearRect(0, 0, sheetBuffer.width, sheetBuffer.height);

        const frameToAnim = new Map();
        for (const key of Object.keys(animRig.animations)) {
            for (const fr of animRig.animations[key].frames) {
                if (!frameToAnim.has(fr.frame_index)) {
                    frameToAnim.set(fr.frame_index, key);
                }
            }
        }

        const frameCount = getSheetFrameCount();
        for (let d = 0; d < TOTAL_DIRS; d++) {
            for (let f = 0; f < frameCount; f++) {
                const foundAnimKey = frameToAnim.get(f);
                if (foundAnimKey !== undefined) {
                    drawComposedFrame(sheetBufferCtx, f * LOGICAL_W, d * LOGICAL_H, foundAnimKey, f, d);
                }
            }
        }

        sheetDirty = false;
        updateSheetButtonUI();
        blitSheetWithHighlight();
    }

    function tick(timestamp) {
        if (!lastFrameTime) lastFrameTime = timestamp;
        const elapsed = timestamp - lastFrameTime;

        let frameChanged = false;
        if (isPlaying && activeFrameArr && activeFrameArr.length > 0 && elapsed > (1000 / animSpeedFps)) {
            activeFrameIdx = (activeFrameIdx + 1) % activeFrameArr.length;
            lastFrameTime = timestamp;
            frameChanged = true;
        }

        if (frameChanged || previewDirty) {
            renderPreview();
            previewDirty = false;
        }
        requestAnimationFrame(tick);
    }

    function renderPreview() {
        if (!previewCanvas || !previewCtx) return;
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

        if (!activeFrameArr || activeFrameArr.length === 0) return;

        const currentFrameConfig = activeFrameArr[activeFrameIdx];
        const counterEl = document.getElementById('frameCounter');
        if (counterEl) {
            counterEl.innerText = `Frame: ${currentFrameConfig.frame_index}`;
        }

        previewCtx.save();
        previewCtx.scale(previewScale, previewScale);
        drawComposedFrame(previewCtx, 0, 0, activeAnimKey, currentFrameConfig.frame_index, activeDirection);
        previewCtx.restore();

        const checkAnchor = document.getElementById('checkAnchor');
        if (checkAnchor && checkAnchor.checked) {
            previewCtx.strokeStyle = '#00f2fe';
            previewCtx.lineWidth = 1;
            previewCtx.beginPath();
            previewCtx.moveTo(0, FEET_Y * previewScale);
            previewCtx.lineTo(previewCanvas.width, FEET_Y * previewScale);
            previewCtx.stroke();
            previewCtx.beginPath();
            previewCtx.moveTo(FEET_X * previewScale, 0);
            previewCtx.lineTo(FEET_X * previewScale, previewCanvas.height);
            previewCtx.stroke();
            previewCtx.fillStyle = '#ff0077';
            previewCtx.beginPath();
            previewCtx.arc(FEET_X * previewScale, FEET_Y * previewScale, 3, 0, Math.PI * 2);
            previewCtx.fill();
        }

        drawGridHighlight(currentFrameConfig.frame_index, activeDirection);
    }

    function drawGridHighlight(frame, dir) {
        if (!sheetCanvas) return;
        if (prevHighlight.f === frame && prevHighlight.d === dir) return;
        prevHighlight = { f: frame, d: dir };
        blitSheetWithHighlight();
    }

    function handleSheetClick(e) {
        if (!sheetCanvas) return;
        const rect = sheetCanvas.getBoundingClientRect();
        const frame = Math.floor((e.clientX - rect.left) * (sheetCanvas.width / rect.width) / LOGICAL_W);
        const dir = Math.floor((e.clientY - rect.top) * (sheetCanvas.height / rect.height) / LOGICAL_H);

        if (frame >= 0 && frame < getSheetFrameCount() && dir >= 0 && dir < TOTAL_DIRS) {
            isPlaying = false;
            if (playPauseBtn) {
                playPauseBtn.innerText = 'Play';
                playPauseBtn.className = 'btn btn-success text-white px-4';
            }
            activeDirection = dir;
            updateDirectionUI();

            for (const key of Object.keys(animRig.animations)) {
                const fIdx = animRig.animations[key].frames.findIndex(fr => fr.frame_index === frame);
                if (fIdx !== -1) {
                    activeAnimKey = key;
                    activeFrameArr = animRig.animations[key].frames;
                    activeFrameIdx = fIdx;
                    updateAnimationUI();
                    break;
                }
            }
            previewDirty = true;
        }
    }

    function resizePreviewCanvas() {
        if (!previewCanvas) return;
        previewCanvas.width = LOGICAL_W * previewScale;
        previewCanvas.height = LOGICAL_H * previewScale;
        previewCtx.imageSmoothingEnabled = false;
    }

    function updateAnimationUI() {
        if (!animRig || !animRig.animations[activeAnimKey]) return;
        document.querySelectorAll('#animationBtnGroup button').forEach(btn => {
            const isActive = btn.innerText === animRig.animations[activeAnimKey].name;
            btn.className = isActive
                ? 'btn btn-custom-play btn-sm w-100 text-white'
                : 'btn btn-outline-secondary btn-sm w-100 text-white-50';
        });
    }

    function updateDirectionUI() {
        document.querySelectorAll('.radial-dir-btn').forEach(btn => {
            const isActive = parseInt(btn.getAttribute('data-dir'), 10) === activeDirection;
            btn.className = isActive
                ? 'btn btn-info position-absolute radial-dir-btn text-dark font-monospace fw-bold'
                : 'btn btn-outline-secondary position-absolute radial-dir-btn text-white-50';
        });
    }

    await init();
}

module.exports = { initAssetManagerApp };
