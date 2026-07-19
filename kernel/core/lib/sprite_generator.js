// Fallback RGB values for each palette index
// Index 0 is transparent (skipped). Indices 1-7 are team colors; 8-15 are player colors.
const SLOT_COLORS = [
    null,              // 0 – transparent
    [20,  20,  20],   // 1  outline / black
    [220, 30,  30],   // 2  primary (shirt main)
    [255, 90,  90],   // 3  primary light / highlight
    [160, 20,  20],   // 4  primary dark / shadow
    [40,  70,  200],  // 5  shorts
    [25,  45,  130],  // 6  shorts dark
    [255, 215, 70],   // 7  socks
    [255, 200, 160],  // 8  skin base
    [200, 140, 100],  // 9  skin shadow
    [255, 235, 200],  // 10 skin highlight
    [110, 55,  25],   // 11 hair
    [70,  35,  15],   // 12 hair dark
    [50,  50,  50],   // 13 shoe / boot
    [255, 255, 255],  // 14 eye white
    [10,  10,  10],   // 15 pupil / extra dark detail
];

// Palette key names corresponding to slot indices 1-7 (team) and 8-15 (player)
const TEAM_SLOT_KEYS   = ['outline', 'primary', 'primaryLight', 'primaryDark', 'shorts', 'shortsDark', 'socks'];
const PLAYER_SLOT_KEYS = ['skin', 'skinShadow', 'skinHighlight', 'hair', 'hairDark', 'shoe', 'eyeWhite', 'pupil'];

function hexToRgb(hex) {
    const h = String(hex || '#000000').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build a flat 16-entry replacement table from a merged palette object.
 * @param {Object} palette  Keys from TEAM_SLOT_KEYS and/or PLAYER_SLOT_KEYS, values are hex strings.
 * @returns {Array}         16-element array of [r,g,b] or null for each slot index.
 */
function buildReplacementTable(palette) {
    const table = new Array(16).fill(null);
    // Slots 1-7: team colors
    TEAM_SLOT_KEYS.forEach((key, i) => {
        if (palette[key]) table[i + 1] = hexToRgb(palette[key]);
    });
    // Slots 8-15: player colors
    PLAYER_SLOT_KEYS.forEach((key, i) => {
        if (palette[key]) table[i + 8] = hexToRgb(palette[key]);
    });
    return table;
}

/**
 * Recolor imageData by matching each pixel's RGB against the baked-in SLOT_COLORS and
 * replacing with the corresponding entry from the replacement table.
 * Uses a fast precomputed lookup approach.
 */
function recolorImageData(imageData, palette) {
    const data = imageData.data;
    const table = buildReplacementTable(palette);

    // Build lookup: map "r,g,b" key -> replacement [r,g,b] for all active slots
    const lookup = new Map();
    for (let idx = 1; idx <= 15; idx++) {
        const src = SLOT_COLORS[idx];
        const dst = table[idx];
        if (src && dst) {
            lookup.set((src[0] << 16) | (src[1] << 8) | src[2], dst);
        }
    }

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        const rep = lookup.get(key);
        if (rep) {
            data[i]     = rep[0];
            data[i + 1] = rep[1];
            data[i + 2] = rep[2];
        }
    }
    return imageData;
}

/**
 * Create a recolored copy of baseCanvas using the given merged palette.
 * @param {HTMLCanvasElement} baseCanvas
 * @param {Object} palette  Combined team + player palette keys → hex strings.
 */
function recolorCanvas(baseCanvas, palette) {
    const canvas = document.createElement('canvas');
    canvas.width  = baseCanvas.width;
    canvas.height = baseCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(baseCanvas, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    recolorImageData(imageData, palette);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

/**
 * Merge a team kit palette with per-player colors into a single palette object
 * suitable for recolorCanvas.
 * @param {Object} teamKit    Team palette: {outline, primary, primaryLight, primaryDark, shorts, shortsDark, socks}
 * @param {Object} playerColors  Player colors: {skin, skinShadow, skinHighlight, hair, hairDark, shoe, eyeWhite, pupil}
 * @returns {Object}
 */
function mergePlayerPalette(teamKit, playerColors) {
    return Object.assign({}, teamKit, playerColors);
}

const SpriteGenerator = {
    SLOT_COLORS,
    TEAM_SLOT_KEYS,
    PLAYER_SLOT_KEYS,
    hexToRgb,
    buildReplacementTable,
    recolorImageData,
    recolorCanvas,
    mergePlayerPalette,
};

module.exports = { SpriteGenerator, recolorCanvas, hexToRgb, SLOT_COLORS, mergePlayerPalette };
