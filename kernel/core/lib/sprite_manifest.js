const manifest = require('../../../presets/sprite_manifest.json');

const SPRITE_TILE_W = manifest.SPRITE_TILE_W;
const SPRITE_TILE_H = manifest.SPRITE_TILE_H;
const SPRITE_FRAMES = manifest.SPRITE_FRAMES;
const SPRITE_DIRS = manifest.SPRITE_DIRS;
const SPRITE_FEET_SCREEN_PX = manifest.SPRITE_FEET_SCREEN_PX;
const ANIMATION_RIGS_IDS = manifest.ANIMATION_RIGS_IDS || [1];
const SHEET_W = SPRITE_TILE_W * SPRITE_FRAMES;
const SHEET_H = SPRITE_TILE_H * SPRITE_DIRS;

module.exports = {
    SPRITE_TILE_W,
    SPRITE_TILE_H,
    SPRITE_FRAMES,
    SPRITE_DIRS,
    SPRITE_FEET_SCREEN_PX,
    ANIMATION_RIGS_IDS,
    SHEET_W,
    SHEET_H
};