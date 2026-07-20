const { ImageDB } = require('./imagedb.js');
const { mergePlayerPalette, hexToRgb } = require('./sprite_generator.js');
const { Settings } = require('../../settings.js');
const { appUrl } = require('./app_paths.js');

const RIG_PATH_REL = 'assets/animation_rigs/1.json';
const PARTS_BASE_REL = 'assets/sprites';
const TYPE_INDEX = 1;

/**
 * WebGL Recoloring Engine
 * Replaces the CPU pixel loop. Uploads the master indexed sheet to the GPU
 * and recolors it instantly using a Fragment Shader.
 */
class WebGLPaletteRenderer {
    constructor(baseIndexCanvas) {
        this.width = baseIndexCanvas.width;
        this.height = baseIndexCanvas.height;

        this.webglCanvas = document.createElement('canvas');
        this.webglCanvas.width = this.width;
        this.webglCanvas.height = this.height;

        const gl = this.webglCanvas.getContext('webgl', { preserveDrawingBuffer: true });
        this.gl = gl;

        const vsSource = `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;

        // The Fragment Shader dynamically maps the Red channel (0-15) to the Uniform array
        const fsSource = `
            precision mediump float;
            varying vec2 v_texCoord;
            uniform sampler2D u_image;
            uniform vec3 u_palette[16];

            void main() {
                vec4 color = texture2D(u_image, v_texCoord);
                if (color.a < 0.1) {
                    discard;
                } else {
                    // Convert the Red channel back into the integer index (0-15)
                    int idx = int(color.r * 255.0 + 0.5);
                    vec3 finalColor = vec3(0.0);

                    // Unrolled lookup to support WebGL 1.0 (GLSL ES 1.0)
                    if (idx == 1) finalColor = u_palette[1];
                    else if (idx == 2) finalColor = u_palette[2];
                    else if (idx == 3) finalColor = u_palette[3];
                    else if (idx == 4) finalColor = u_palette[4];
                    else if (idx == 5) finalColor = u_palette[5];
                    else if (idx == 6) finalColor = u_palette[6];
                    else if (idx == 7) finalColor = u_palette[7];
                    else if (idx == 8) finalColor = u_palette[8];
                    else if (idx == 9) finalColor = u_palette[9];
                    else if (idx == 10) finalColor = u_palette[10];
                    else if (idx == 11) finalColor = u_palette[11];
                    else if (idx == 12) finalColor = u_palette[12];
                    else if (idx == 13) finalColor = u_palette[13];
                    else if (idx == 14) finalColor = u_palette[14];
                    else if (idx == 15) finalColor = u_palette[15];

                    gl_FragColor = vec4(finalColor, 1.0);
                }
            }
        `;

        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSource);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSource);
        gl.compileShader(fs);

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.useProgram(program);

        // Geometry Buffer (Full screen quad)
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,  1, -1, -1,  1,
            -1,  1,  1, -1,  1,  1
        ]), gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        // UV Buffer
        const texBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 1,  1, 1,  0, 0,
            0, 0,  1, 1,  1, 0
        ]), gl.STATIC_DRAW);
        const texLoc = gl.getAttribLocation(program, 'a_texCoord');
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

        // Upload Master Indexed Atlas to GPU
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, baseIndexCanvas);

        this.paletteLoc = gl.getUniformLocation(program, 'u_palette');
    }

    renderToCanvas(mergedPalette) {
        // Convert JS Hex object to Float32Array mapping
        const paletteFloat = this._buildPaletteUniform(mergedPalette);
        const gl = this.gl;

        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Pass player colors to the shader
        gl.uniform3fv(this.paletteLoc, paletteFloat);

        // Draw!
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Clone WebGL output to standard Canvas 2D for the game engine / ImageDB
        const outCanvas = document.createElement('canvas');
        outCanvas.width = this.width;
        outCanvas.height = this.height;
        outCanvas.getContext('2d').drawImage(this.webglCanvas, 0, 0);

        return outCanvas;
    }

    _buildPaletteUniform(paletteObj) {
        const arr = new Float32Array(16 * 3);
        const parseHex = (hex) => {
            const h = String(hex || '#FF00FF').replace('#', '');
            const n = parseInt(h.length === 3 ? h.split('').map(c=>c+c).join('') : h, 16);
            return [(n>>16)&255, (n>>8)&255, n&255];
        };

        const map = {
            outline: 1, primary: 2, primaryLight: 3, primaryDark: 4,
            shorts: 5, shortsDark: 6, socks: 7,
            skin: 8, skinShadow: 9, skinHighlight: 10,
            hair: 11, hairDark: 12, shoe: 13, eyeWhite: 14, pupil: 15
        };

        for (const [key, idx] of Object.entries(map)) {
            const rgb = parseHex(paletteObj[key]);
            arr[idx * 3]     = rgb[0] / 255.0;
            arr[idx * 3 + 1] = rgb[1] / 255.0;
            arr[idx * 3 + 2] = rgb[2] / 255.0;
        }
        return arr;
    }
}

/**
 * Decompress zlib
 */
async function zlibDecompress(compressedBuf) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(compressedBuf));
    writer.close();

    const reader = ds.readable.getReader();
    const chunks = [];
    let totalLen = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLen += value.length;
    }

    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) result.set(chunk, offset), offset += chunk.length;
    return result;
}

/**
 * Load a bank of modular parts and return an array of canvas elements.
 */
async function loadPartBank(category) {
    const path = appUrl(`${PARTS_BASE_REL}/${category}/${TYPE_INDEX}.bin`);
    const res = await fetch(path);
    if (!res.ok) return null;

    const buf = await res.arrayBuffer();
    const view = new DataView(buf);

    const w = view.getUint16(0, true);
    const h = view.getUint16(2, true);
    const totalTiles = view.getUint16(4, true);
    const paletteCount = view.getUint16(6, true);
    const headerSize = 8 + paletteCount * 3;

    const palette = [];
    for (let i = 0; i < paletteCount; i++) {
        palette.push([
            i,
            0,
            0,
            i === 0 ? 0 : 255
        ]);
    }

    const packed = await zlibDecompress(buf.slice(headerSize));
    const tiles = [];
    const pixelsPerTile = w * h;
    const bytesPerTile = Math.ceil(pixelsPerTile / 2);

    for (let t = 0; t < totalTiles; t++) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        const imageData = ctx.createImageData(w, h);
        const data = imageData.data;
        const tileOffset = t * bytesPerTile;

        for (let i = 0; i < pixelsPerTile; i++) {
            const byteIdx = tileOffset + (i >>> 1);
            const nibble = (i & 1) === 0 ? (packed[byteIdx] >>> 4) : (packed[byteIdx] & 0x0F);
            const rgba = palette[nibble] || [0, 0, 0, 0];
            const p = i * 4;
            data[p]     = rgba[0];
            data[p + 1] = rgba[1];
            data[p + 2] = rgba[2];
            data[p + 3] = rgba[3];
        }
        ctx.putImageData(imageData, 0, 0);
        tiles.push(canvas);
    }
    return tiles;
}

/**
 * Load the rig and all referenced part banks.
 */
async function loadModularData() {
    const rigPath = appUrl(RIG_PATH_REL);
    const rigRes = await fetch(rigPath);
    if (!rigRes.ok) throw new Error(`Failed to load ${rigPath}`);
    const rig = await rigRes.json();

    const categories = new Set();
    Object.values(rig.animations).forEach(anim => {
        anim.frames.forEach(frame => {
            Object.values(frame.directions).forEach(dir => {
                dir.parts.forEach(p => categories.add(p.part));
            });
        });
    });

    const partBanks = {};
    await Promise.all([...categories].map(async cat => {
        const tiles = await loadPartBank(cat);
        if (tiles) partBanks[cat] = tiles;
    }));

    return { rig, partBanks };
}

/**
 * Compose a complete spritesheet using modular parts.
 */
function composeBaseSheet(rig, partBanks) {
    const TILE = 64;
    const COLS = 14;
    const ROWS = 8;
    const width = TILE * COLS;
    const height = TILE * ROWS;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.imageSmoothingEnabled = false;

    // Helper to calculate pivot coordinates based on alignment string
    const getPivotOffsets = (type, w, h) => {
        let x = 0, y = 0;
        const str = (type || 'top_left').toLowerCase();

        if (str.includes('center')) x = w / 2;
        if (str.includes('right')) x = w;

        if (str.includes('middle')) y = h / 2;
        if (str.includes('bottom')) y = h;

        return { x, y };
    };

    for (const animKey in rig.animations) {
        const anim = rig.animations[animKey];

        for (const frame of anim.frames) {
            const col = frame.frame_index;
            for (let dir = 0; dir < 8; dir++) {

                let baseDir = dir;
                let flip = false;

                if (dir === 5) { baseDir = 3; flip = true; }
                else if (dir === 6) { baseDir = 2; flip = true; }
                else if (dir === 7) { baseDir = 1; flip = true; }

                const dirData = frame.directions[baseDir];
                if (!dirData) continue;

                const parts = [...dirData.parts].sort((a, b) => (a.z || 0) - (b.z || 0));

                const temp = document.createElement('canvas');
                temp.width = TILE;
                temp.height = TILE;
                const tctx = temp.getContext('2d', { alpha: true });
                tctx.imageSmoothingEnabled = false;

                for (const p of parts) {
                    const bank = partBanks[p.part];
                    if (bank && bank[p.tile_index] !== undefined) {
                        const partCanvas = bank[p.tile_index];
                        tctx.save();

                        // 1. Calculate pivots
                        const align = getPivotOffsets(p.canvas_alignment, TILE, TILE);
                        const anchor = getPivotOffsets(p.frame_anchor, partCanvas.width, partCanvas.height);

                        // 2. Move to canvas alignment point + explicit relative offsets
                        let dx = align.x + (p.relative_x || 0);
                        let dy = align.y + (p.relative_y || 0);
                        tctx.translate(dx, dy);

                        // 3. Apply Scale & Flip
                        let sx = (p.scale_x ?? 100) / 100;
                        let sy = (p.scale_y ?? 100) / 100;

                        if (p.flip_horizontal) sx *= -1;
                        if (p.flip_vertical) sy *= -1;

                        tctx.scale(sx, sy);

                        // 4. Apply Rotation (around the anchor pivot)
                        if (p.rotation) {
                            tctx.rotate(p.rotation * Math.PI / 180);
                        }

                        // 5. Draw offset by the anchor point
                        tctx.drawImage(partCanvas, -anchor.x, -anchor.y);
                        tctx.restore();
                    }
                }

                const x = col * TILE;
                const y = dir * TILE;

                if (flip) {
                    ctx.save();
                    ctx.translate(x + TILE, y);
                    ctx.scale(-1, 1);
                    ctx.drawImage(temp, 0, 0);
                    ctx.restore();
                } else {
                    ctx.drawImage(temp, x, y);
                }
            }
        }
    }

    return canvas;
}

const DEFAULT_PLAYER_COLORS = {
    skin:          '#FFC8A0',
    skinShadow:    '#C88C64',
    skinHighlight: '#FFEBC8',
    hair:          '#6E3719',
    hairDark:      '#46230F',
    shoe:          '#323232',
    eyeWhite:      '#FFFFFF',
    pupil:         '#0A0A0A',
};

function cpuRecolorIndexedSheet(baseIndexSheet, mergedPalette) {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = baseIndexSheet.width;
    outCanvas.height = baseIndexSheet.height;
    const ctx = outCanvas.getContext('2d');
    ctx.drawImage(baseIndexSheet, 0, 0);

    const imgData = ctx.getImageData(0, 0, outCanvas.width, outCanvas.height);
    const data = imgData.data;

    const map = {
        outline: 1, primary: 2, primaryLight: 3, primaryDark: 4,
        shorts: 5, shortsDark: 6, socks: 7,
        skin: 8, skinShadow: 9, skinHighlight: 10,
        hair: 11, hairDark: 12, shoe: 13, eyeWhite: 14, pupil: 15
    };
    const lookup = new Array(16).fill(null);
    for (const [key, idx] of Object.entries(map)) {
        lookup[idx] = hexToRgb(mergedPalette[key]);
    }

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const idx = data[i]; // Red channel contains the palette index
        if (idx >= 1 && idx <= 15) {
            const rep = lookup[idx];
            if (rep) {
                data[i]     = rep[0];
                data[i + 1] = rep[1];
                data[i + 2] = rep[2];
            }
        }
    }
    ctx.putImageData(imgData, 0, 0);
    return outCanvas;
}

async function registerPlayerSheetsFromPng(palettes, playerStats, activeTeamNames = null) {
    if (Settings.HEADLESS) return;

    let teamsToProcess = Object.keys(palettes);
    if (activeTeamNames) {
        const list = Array.isArray(activeTeamNames) ? activeTeamNames : [activeTeamNames];
        teamsToProcess = teamsToProcess.filter(name => list.includes(name));
    }

    let needsLoading = false;
    for (const teamName of teamsToProcess) {
        if (!ImageDB.get(`player_${teamName}_main`) || !ImageDB.get(`player_${teamName}_gk`)) {
            needsLoading = true; break;
        }
        const players = playerStats?.teams?.[teamName] || [];
        for (const p of players) {
            if (!ImageDB.get(`player_${teamName}_jersey_${p.jersey}`)) {
                needsLoading = true; break;
            }
        }
        if (needsLoading) break;
    }
    if (!needsLoading) return;

    // Load data and compile the pure indexed master atlas
    const { rig, partBanks } = await loadModularData();
    const baseIndexSheet = composeBaseSheet(rig, partBanks);

    // Initialize WebGL GPU Renderer once if supported
    let gpuRenderer = null;
    let webglSupported = false;
    try {
        const gl = baseIndexSheet.getContext('webgl') || baseIndexSheet.getContext('experimental-webgl');
        if (gl && typeof gl?.createShader === 'function') {
            gpuRenderer = new WebGLPaletteRenderer(baseIndexSheet);
            webglSupported = true;
        }
    } catch (e) {
        console.warn('WebGL not supported or initialization failed, falling back to CPU:', e);
    }

    for (const teamName of teamsToProcess) {
        const kits = palettes[teamName];
        if (!kits) continue;

        const teamPlayers = playerStats?.teams?.[teamName] || [];

        for (const player of teamPlayers) {
            const jersey = player.jersey;
            const key = `player_${teamName}_jersey_${jersey}`;
            if (ImageDB.get(key)) continue;

            const isGK = player.role === 'GK' || jersey === 1;
            const teamKit = isGK ? kits.gk : kits.main;

            const merged = mergePlayerPalette(
                teamKit,
                Object.assign({}, DEFAULT_PLAYER_COLORS, player.colors || {})
            );

            // ⚡ GPU recolors in <1ms and returns final output, or CPU fallback
            const recolored = webglSupported
                ? gpuRenderer.renderToCanvas(merged)
                : cpuRecolorIndexedSheet(baseIndexSheet, merged);
            ImageDB.register(key, recolored);
        }

        const mainKey = `player_${teamName}_main`;
        if (!ImageDB.get(mainKey)) {
            const merged = mergePlayerPalette(kits.main, DEFAULT_PLAYER_COLORS);
            const recolored = webglSupported
                ? gpuRenderer.renderToCanvas(merged)
                : cpuRecolorIndexedSheet(baseIndexSheet, merged);
            ImageDB.register(mainKey, recolored);
        }

        const gkKey = `player_${teamName}_gk`;
        if (!ImageDB.get(gkKey)) {
            const merged = mergePlayerPalette(kits.gk, DEFAULT_PLAYER_COLORS);
            const recolored = webglSupported
                ? gpuRenderer.renderToCanvas(merged)
                : cpuRecolorIndexedSheet(baseIndexSheet, merged);
            ImageDB.register(gkKey, recolored);
        }
    }
}

module.exports = {
    registerPlayerSheetsFromPng,
    DEFAULT_PLAYER_COLORS,
    zlibDecompress
};