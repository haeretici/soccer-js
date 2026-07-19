const { Settings } = require('../../settings.js');

const Utils = {
    distanceMax: function(x1, y1, x2, y2) {
        return Math.max(Math.abs(x1-x2), Math.abs(y1-y2))
    },
    calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    },
    getTime: function() {
        return Math.floor(Date.now() / 1000);
    },

    sleep: function(seconds) {
        return new Promise(r => setTimeout(r, seconds * 1000));
    },

    getRandomInt: function(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    },


    getRandomFloat: function(min, max, decimals = 2) {
        return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
    },

    pseudoRandomState: 0x9e3779b9,
    // Pseudo-only RNG — for cases where we don't call Math.random() (simulation uses a seeded PRNG).
    getPseudoRandom: function() {
        this.pseudoRandomState = (this.pseudoRandomState * 1664525 + 1013904223) >>> 0;
        return this.pseudoRandomState / 0x100000000;
    },


    formatSeconds: function(seconds) {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    },

    getArrayUniquePropertyValues(array, propertyName) {
        return [...new Set(array.map(obj => obj[propertyName]))];
    },


    filterByProperty: function(array, property, value) {
        return array.filter(obj => obj[property] === value);
    },

    getScaleMultiplier: function() {
        const scale = Settings.camera ? Settings.camera.scale : Settings.BASE_SCALE;
        return scale / Settings.BASE_SCALE;
    },

    getFieldMultiplier: function() {
        return Settings.FIELD_SIZE_MULTIPLIER;
    },

    getFieldBounds: function() {
        const multiplier = Settings.FIELD_SIZE_MULTIPLIER;
        const width = Settings.BASE_FIELD_WIDTH * multiplier;
        const height = Settings.BASE_FIELD_HEIGHT * multiplier;
        return {
            multiplier,
            width,
            height,
            centerX: width / 2,
            centerY: height / 2
        };
    },

    _scaleXCache: {},
    _scaleYCache: {},
    _lastCacheKey: '',

    scaleFieldX: function(x) {
        const field = Utils.getFieldBounds();
        const refW = Settings.REFERENCE_FIELD_WIDTH || Settings.BASE_FIELD_WIDTH;
        const cacheKey = `${field.width}_${field.height}_${refW}_${Settings.REFERENCE_FIELD_HEIGHT || Settings.BASE_FIELD_HEIGHT}`;
        if (Utils._lastCacheKey !== cacheKey) {
            Utils._scaleXCache = {};
            Utils._scaleYCache = {};
            Utils._lastCacheKey = cacheKey;
        }
        if (Utils._scaleXCache[x] !== undefined) {
            return Utils._scaleXCache[x];
        }
        const val = x * field.width / refW;
        Utils._scaleXCache[x] = val;
        return val;
    },

    scaleFieldY: function(y) {
        const field = Utils.getFieldBounds();
        const refH = Settings.REFERENCE_FIELD_HEIGHT || Settings.BASE_FIELD_HEIGHT;
        const cacheKey = `${field.width}_${field.height}_${Settings.REFERENCE_FIELD_WIDTH || Settings.BASE_FIELD_WIDTH}_${refH}`;
        if (Utils._lastCacheKey !== cacheKey) {
            Utils._scaleXCache = {};
            Utils._scaleYCache = {};
            Utils._lastCacheKey = cacheKey;
        }
        if (Utils._scaleYCache[y] !== undefined) {
            return Utils._scaleYCache[y];
        }
        const val = y * field.height / refH;
        Utils._scaleYCache[y] = val;
        return val;
    },

    // Screen-pixel offsets from player ground to ball center at BASE_SCALE (scale=20).
    // 0=UP, 1=UP_RIGHT, 2=RIGHT, 3=DOWN_RIGHT, 4=DOWN, 5=DOWN_LEFT, 6=LEFT, 7=UP_LEFT
    BASE_CARRY_SCREEN_OFFSETS: {
        0: { dx: 4, dy: -2 },
        1: { dx: 5, dy: -1 },
        2: { dx: 5, dy: 0 },
        3: { dx: 5, dy: 1 },
        4: { dx: -4, dy: 2 },
        5: { dx: -5, dy: 1 },
        6: { dx: -5, dy: 0 },
        7: { dx: -5, dy: -1 }
    },

    getSpriteDrawMetrics: function() {
        const multiplier = Utils.getScaleMultiplier();
        const tileW = Settings.SPRITE_TILE_W * multiplier;
        const tileH = Settings.SPRITE_TILE_H * multiplier;
        const feetOffset = Settings.SPRITE_FEET_SCREEN_PX * multiplier;
        return {
            multiplier,
            tileW,
            tileH,
            anchorOffsetX: tileW / 2,
            anchorOffsetY: tileH - feetOffset,
            feetScreenYOffset: feetOffset
        };
    },

    getCarryScreenOffset: function(orientation) {
        const base = Utils.BASE_CARRY_SCREEN_OFFSETS[orientation] || { dx: 0, dy: 0 };
        const m = Utils.getScaleMultiplier();
        return { dx: base.dx * m, dy: base.dy * m };
    },

    getOrthoScales: function(scale) {
        return {
            scaleX: scale,
            scaleY: scale * 0.8,
            scaleZ: scale,
            shear: scale * Settings.ORTHO_SHEAR_RATIO
        };
    },

    worldDeltaFromScreenDelta: function(screenDx, screenDy) {
        const scale = Settings.camera ? Settings.camera.scale : Settings.BASE_SCALE;

        if (Settings.projectionMode === 'isometric') {
            const tw = scale * 1.2;
            const th = scale * 1.2;
            const a = tw / 2;
            const b = th / 4;
            const ox = (screenDx / a + screenDy / b) / 2;
            const oy = (screenDy / b - screenDx / a) / 2;
            return { ox, oy };
        }

        const { scaleX, scaleY, shear } = Utils.getOrthoScales(scale);
        const dly = screenDy / scaleY;

        if (Settings.projectionMode === 'topdown') {
            return { ox: screenDx / scaleX, oy: dly };
        }

        // orthographic broadcast: sx = lx*scaleX + ly*shear
        return { ox: (screenDx - dly * shear) / scaleX, oy: dly };
    },

    computeCarryWorldOffset: function(orientation) {
        const screen = Utils.getCarryScreenOffset(orientation);
        return Utils.worldDeltaFromScreenDelta(screen.dx, screen.dy);
    },

    getPlayerFeetScreen: function(player) {
        const ground = Utils.toScreen(player.x, player.y, 0);
        const metrics = Utils.getSpriteDrawMetrics();
        return { x: ground.x, y: ground.y + metrics.feetScreenYOffset };
    },

    getCameraOffsets: function() {
        const isCentered = Settings.camera && Settings.camera.type === 'centered';
        if (isCentered) {
            return { offsetX: 0, offsetY: 0 };
        }
        return {
            offsetX: Settings.camera ? Settings.camera.offsetX : 40,
            offsetY: Settings.camera ? Settings.camera.offsetY : 80
        };
    },

    toScreen: function(lx, ly, lz = 0) {
        const scale = Settings.camera ? Settings.camera.scale : Settings.BASE_SCALE;
        const { offsetX, offsetY } = Utils.getCameraOffsets();

        if (Settings.projectionMode === 'isometric') {
            const tw = scale * 1.2;
            const th = scale * 1.2;
            return {
                x: offsetX + (lx - ly) * (tw / 2),
                y: offsetY + (lx + ly) * (th / 4) - lz * (th / 2)
            };
        }

        const { scaleX, scaleY, scaleZ, shear } = Utils.getOrthoScales(scale);
        const sy = offsetY + ly * scaleY - lz * scaleZ;

        if (Settings.projectionMode === 'topdown') {
            return {
                x: offsetX + lx * scaleX,
                y: sy
            };
        }

        // orthographic broadcast (classic slight incline)
        return {
            x: offsetX + lx * scaleX + ly * shear,
            y: sy
        };
    },
}

module.exports = { Utils };
