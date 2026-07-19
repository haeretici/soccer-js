#!/usr/bin/env node
/**
 * Adds a `colors` field to each player in player_stats.json.
 * Colors are derived from the `skin` and `hair` values from the old palettes.json
 * (which are being removed from there). Generates plausible skin/hair variations per player.
 *
 * Usage: node presets/add_player_colors.js
 */

const fs = require('fs');
const path = require('path');

// Original skin/hair from old palettes.json (team-level defaults)
const TEAM_SKIN_HAIR = {
  "Algeria":               { skin: "#E0A96D", hair: "#222222" },
  "Argentina":             { skin: "#F5C3B2", hair: "#331100" },
  "Australia":             { skin: "#FFDAB9", hair: "#C2B280" },
  "Austria":               { skin: "#FFE0D0", hair: "#C29B38" },
  "Belgium":               { skin: "#FFDAB9", hair: "#C29B38" },
  "Bosnia and Herzegovina":{ skin: "#FFE0D0", hair: "#111111" },
  "Brazil":                { skin: "#D2B48C", hair: "#111111" },
  "Cabo Verde":            { skin: "#5C4033", hair: "#111111" },
  "Canada":                { skin: "#FFDAB9", hair: "#C29B38" },
  "Colombia":              { skin: "#D2B48C", hair: "#222222" },
  "Congo DR":              { skin: "#4A2F13", hair: "#111111" },
  "Croatia":               { skin: "#FFE0D0", hair: "#C29B38" },
  "Curaçao":               { skin: "#8D5524", hair: "#111111" },
  "Czechia":               { skin: "#FFE0D0", hair: "#D2B48C" },
  "Côte d'Ivoire":         { skin: "#4A2F13", hair: "#111111" },
  "Ecuador":               { skin: "#C68B59", hair: "#111111" },
  "Egypt":                 { skin: "#C68B59", hair: "#111111" },
  "England":               { skin: "#FFDAB9", hair: "#C2B280" },
  "France":                { skin: "#FFE0D0", hair: "#4E2A11" },
  "Germany":               { skin: "#FFE0D0", hair: "#C29B38" },
  "Ghana":                 { skin: "#3D2314", hair: "#111111" },
  "Haiti":                 { skin: "#4A2F13", hair: "#111111" },
  "IR Iran":               { skin: "#C68B59", hair: "#111111" },
  "Iraq":                  { skin: "#C68B59", hair: "#222222" },
  "Japan":                 { skin: "#FFDAB9", hair: "#111111" },
  "Jordan":                { skin: "#C68B59", hair: "#111111" },
  "Korea Republic":        { skin: "#FFDAB9", hair: "#222222" },
  "Mexico":                { skin: "#C68B59", hair: "#111111" },
  "Morocco":               { skin: "#D2B48C", hair: "#111111" },
  "Netherlands":           { skin: "#FFE0D0", hair: "#C29B38" },
  "New Zealand":           { skin: "#FFDAB9", hair: "#D2B48C" },
  "Norway":                { skin: "#FFE0D0", hair: "#C2B280" },
  "Panama":                { skin: "#C68B59", hair: "#111111" },
  "Paraguay":              { skin: "#C68B59", hair: "#222222" },
  "Portugal":              { skin: "#FFDAB9", hair: "#331100" },
  "Qatar":                 { skin: "#C68B59", hair: "#111111" },
  "Saudi Arabia":          { skin: "#C68B59", hair: "#111111" },
  "Scotland":              { skin: "#FFE0D0", hair: "#D2B48C" },
  "Senegal":               { skin: "#3D2314", hair: "#111111" },
  "South Africa":          { skin: "#3D2314", hair: "#111111" },
  "Spain":                 { skin: "#FFE0D0", hair: "#2E1A11" },
  "Sweden":                { skin: "#FFE0D0", hair: "#FFE080" },
  "Switzerland":           { skin: "#FFE0D0", hair: "#D2B48C" },
  "Tunisia":               { skin: "#E0A96D", hair: "#222222" },
  "Türkiye":               { skin: "#FFE0D0", hair: "#222222" },
  "United States":         { skin: "#FFDAB9", hair: "#C29B38" },
  "Uruguay":               { skin: "#FFE0D0", hair: "#4E2A11" },
  "Uzbekistan":            { skin: "#E0A96D", hair: "#222222" },
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function lighten(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amount, g + amount, b + amount);
}

function darken(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r - amount, g - amount, b - amount);
}

// Hair variation pool for players within a team (slight variation to add diversity)
const HAIR_VARIATIONS = [
  (h) => h,                    // same
  (h) => lighten(h, 15),       // slightly lighter
  (h) => darken(h, 10),        // slightly darker
  (h) => h,
  (h) => lighten(h, 25),
  (h) => h,
  (h) => darken(h, 5),
  (h) => h,
  (h) => lighten(h, 10),
  (h) => h,
  (h) => darken(h, 15),
];

// Skin tone variation pool for players within a team
const SKIN_VARIATIONS = [
  (s) => s,
  (s) => lighten(s, 10),
  (s) => darken(s, 10),
  (s) => lighten(s, 5),
  (s) => darken(s, 5),
  (s) => s,
  (s) => lighten(s, 15),
  (s) => darken(s, 8),
  (s) => s,
  (s) => lighten(s, 7),
  (s) => darken(s, 12),
];

function buildPlayerColors(skin, hair, playerIndex) {
  const idx = playerIndex % SKIN_VARIATIONS.length;
  const hairIdx = playerIndex % HAIR_VARIATIONS.length;
  const playerSkin = SKIN_VARIATIONS[idx](skin);
  const playerHair = HAIR_VARIATIONS[hairIdx](hair);

  return {
    skin:          playerSkin,
    skinShadow:    darken(playerSkin, 55),
    skinHighlight: lighten(playerSkin, 35),
    hair:          playerHair,
    hairDark:      darken(playerHair, 40),
    shoe:          "#323232",
    eyeWhite:      "#FFFFFF",
    pupil:         "#0A0A0A"
  };
}

// Load player_stats.json
const statsPath = path.join(__dirname, 'player_stats.json');
const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

// Add colors to each player
for (const [teamName, players] of Object.entries(stats.teams)) {
  const defaults = TEAM_SKIN_HAIR[teamName] || { skin: "#FFDAB9", hair: "#333333" };
  players.forEach((player, idx) => {
    player.colors = buildPlayerColors(defaults.skin, defaults.hair, idx);
  });
}

fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
console.log('Done! Added colors to all players in player_stats.json');
