/**
 * Player FSM state bag — outfield + goalkeeper states (composition style).
 *
 * Single Player entity; outfield and GK states live in separate modules and are
 * registered once via initPlayerStates(deps) from player.js.
 */
const { registerOutfieldStates } = require('./player_states_outfield.js');
const { registerGkStates } = require('./player_states_gk.js');

/** @type {Record<string, { name: string, enter?: Function, execute?: Function, exit?: Function }>} */
const PlayerStates = {};

let _initialized = false;

/**
 * Register all player states onto PlayerStates (idempotent).
 * @param {object} deps - helpers and libs from player.js
 * @returns {typeof PlayerStates}
 */
function initPlayerStates(deps) {
    if (_initialized) return PlayerStates;
    registerOutfieldStates(PlayerStates, deps);
    registerGkStates(PlayerStates, deps);
    // Alias for ReturnToHomeRegion / GoHome
    PlayerStates.ReturnHome = PlayerStates.GoHome;
    _initialized = true;
    return PlayerStates;
}

/**
 * Role helpers (composition — not subclasses).
 * @param {object} player
 */
function isGoalkeeperRole(player) {
    return !!(player && player.role === 'GK');
}

function isOutfieldRole(player) {
    return !!(player && player.role && player.role !== 'GK');
}

module.exports = {
    PlayerStates,
    initPlayerStates,
    isGoalkeeperRole,
    isOutfieldRole
};
