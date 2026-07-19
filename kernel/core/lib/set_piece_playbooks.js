/**
 * A.5 Set-piece playbooks — data-driven corner / freekick / throw-in / goalkick routines.
 *
 * Picks a weighted playbook (seeded Math.random) and applies positioning + kick prefs.
 * Resume uses sim.activePlaybook for delivery choice (near/far/short/shoot).
 */
const { Utils } = require('./utils.js');

let _cache = null;

function loadSetPiecePlaybooks() {
    if (_cache) return _cache;
    try {
        _cache = require('../../../presets/set_pieces.json');
    } catch (e) {
        _cache = { corner: {}, freekick: {}, throwin: {}, goalkick: {} };
    }
    return _cache;
}

/**
 * @param {string} type - corner | freekick | throwin | goalkick
 * @param {function} [rng] - defaults Math.random
 * @returns {{ id: string, type: string, def: object }|null}
 */
function pickPlaybook(type, rng = Math.random) {
    const data = loadSetPiecePlaybooks();
    const bucket = data[type];
    if (!bucket || typeof bucket !== 'object') return null;

    const entries = Object.keys(bucket).map((id) => {
        const def = bucket[id] || {};
        const w = typeof def.weight === 'number' ? Math.max(0, def.weight) : 1;
        return { id, def, weight: w };
    }).filter((e) => e.weight > 0);

    if (!entries.length) return null;

    let total = 0;
    for (let i = 0; i < entries.length; i++) total += entries[i].weight;
    let r = (typeof rng === 'function' ? rng() : Math.random()) * total;
    for (let i = 0; i < entries.length; i++) {
        r -= entries[i].weight;
        if (r <= 0) {
            return { id: entries[i].id, type, def: entries[i].def };
        }
    }
    const last = entries[entries.length - 1];
    return { id: last.id, type, def: last.def };
}

/**
 * Place corner attackers/defenders from playbook biases.
 *
 * @param {object} ctx
 * @param {object} playbook - { id, def }
 * @param {object[]} attackers - kicking outfield excl. taker
 * @param {object[]} defenders
 * @param {'left'|'right'} side - goal side being attacked (corner side)
 * @param {number} cornerY - world Y of the flag
 */
function applyCornerPositions(ctx, playbook, attackers, defenders, side, cornerY) {
    const field = Utils.getFieldBounds();
    const fcY = field.centerY;
    const fw = field.width;
    const s = (v) => Utils.scaleFieldX(v);
    const def = (playbook && playbook.def) || {};

    const boxAttackers = Math.max(1, Math.min(6, def.boxAttackers != null ? def.boxAttackers | 0 : 4));
    const yBias = typeof def.yBias === 'number' ? def.yBias : 0;
    // yBias < 0 → toward corner flag (near), > 0 → opposite (far)
    // World Y increases downward: near-at-top needs negative shift when yBias < 0.
    const nearIsTop = cornerY < fcY;
    const biasSign = nearIsTop ? 1 : -1;
    const biasY = yBias * biasSign;

    const boxXMin = (side === 'left') ? s(3.125) : fw - s(15.625);
    const boxXMax = (side === 'left') ? s(15.625) : fw - s(3.125);
    const boxH = s(10.9375);
    const boxYMin = fcY - boxH;
    const boxYMax = fcY + boxH;
    const boxMidY = (boxYMin + boxYMax) * 0.5;
    // Shift sampling window toward near/far
    const shift = biasY * boxH * 0.55;
    const sampYMin = Math.max(boxYMin, Math.min(boxYMax - 1, boxMidY + shift - boxH * 0.35));
    const sampYMax = Math.max(sampYMin + 1, Math.min(boxYMax, boxMidY + shift + boxH * 0.35));

    // Short option: one attacker near the corner flag for a short pass
    let shortAtk = null;
    let pool = attackers.slice();
    if (def.shortOption && pool.length > 0) {
        shortAtk = pool.shift();
        const flagX = side === 'left' ? 0 : fw;
        shortAtk.x = flagX + (side === 'left' ? s(4) : -s(4));
        shortAtk.y = cornerY + (nearIsTop ? s(4) : -s(4));
        // Mark short option lightly
        if (defenders[0]) {
            defenders[0].x = shortAtk.x + (side === 'left' ? s(1.2) : -s(1.2));
            defenders[0].y = shortAtk.y;
        }
    }

    const defStart = def.shortOption ? 1 : 0;
    for (let i = 0; i < boxAttackers; i++) {
        const atk = pool[i];
        const defP = defenders[defStart + i];
        if (!atk) continue;
        const px = boxXMin + Math.random() * (boxXMax - boxXMin);
        const py = sampYMin + Math.random() * (sampYMax - sampYMin);
        atk.x = px;
        atk.y = py;
        if (defP) {
            defP.x = px + (Math.random() - 0.5) * 0.8;
            defP.y = py + (Math.random() - 0.5) * 0.8;
        }
    }

    let idxAtk = boxAttackers;
    let idxDef = defStart + boxAttackers;
    const edgeX = (side === 'left') ? s(21.875) : fw - s(21.875);

    while (idxAtk < pool.length) {
        const atk = pool[idxAtk++];
        if (atk) {
            atk.x = edgeX + (Math.random() - 0.5) * 1.5;
            atk.y = fcY + (Math.random() - 0.5) * s(15.625);
        }
    }
    while (idxDef < defenders.length) {
        const defP = defenders[idxDef++];
        if (defP) {
            defP.x = edgeX - (side === 'left' ? s(3.125) : -s(3.125)) + (Math.random() - 0.5) * 1.5;
            defP.y = fcY + (Math.random() - 0.5) * s(15.625);
        }
    }

    return { shortAttacker: shortAtk };
}

/**
 * Pick corner delivery target from playbook bias.
 * @param {object[]} pool
 * @param {object} playbook
 * @param {'left'|'right'} side
 * @param {number} cornerY
 * @param {object} field
 */
function pickCornerTarget(pool, playbook, side, cornerY, field) {
    if (!pool || !pool.length) return null;
    const def = (playbook && playbook.def) || {};
    const kick = def.kick || {};
    const bias = kick.targetBias || 'any';
    const fcY = field.centerY;
    const nearIsTop = cornerY < fcY;

    if (bias === 'short' && playbook._shortAttacker && !playbook._shortAttacker.isSentOff) {
        return playbook._shortAttacker;
    }

    if (bias === 'near' || bias === 'far') {
        const wantTop = bias === 'near' ? nearIsTop : !nearIsTop;
        const filtered = pool.filter((p) => (wantTop ? p.y < fcY : p.y >= fcY));
        if (filtered.length) {
            return filtered[Math.floor(Math.random() * filtered.length)];
        }
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Resolve freekick wall size from playbook.
 * @param {object} playbook
 * @param {number} distToGoal
 * @param {function} s - scaleFieldX
 */
function resolveWallSize(playbook, distToGoal, s) {
    const def = (playbook && playbook.def) || {};
    if (def.wallSize === 0 || def.wall === false) return 0;
    if (typeof def.wallSize === 'number') return Math.max(0, Math.min(5, def.wallSize | 0));
    // auto
    return distToGoal < s(37.5) ? 3 : 2;
}

/**
 * Should freekick taker shoot given playbook + CanShoot result.
 * @param {object} playbook
 * @param {boolean} canShootOk
 * @param {number} distToGoal
 * @param {number} shootRange
 */
function freekickShouldShoot(playbook, canShootOk, distToGoal, shootRange) {
    const kick = (playbook && playbook.def && playbook.def.kick) || {};
    if (distToGoal >= shootRange) return false;
    const prefer = kick.prefer || 'auto';
    const chance = typeof kick.shootChance === 'number' ? kick.shootChance : 0.75;
    if (prefer === 'pass') {
        return canShootOk && Math.random() < chance;
    }
    if (prefer === 'shoot') {
        return canShootOk ? Math.random() < chance : Math.random() < chance * 0.35;
    }
    return canShootOk && Math.random() < chance;
}

/**
 * Adjust throw-in receiver targets from playbook lateral/forward bias.
 * Mutates setPieceTarget on receivers if present.
 *
 * @param {object} sim
 * @param {object} playbook
 * @param {number} outX
 * @param {number} outY
 */
function applyThrowInReceiverBias(sim, playbook, outX, outY) {
    if (!playbook || !sim.throwInReceivers || !sim.throwInReceivers.length) return;
    const field = Utils.getFieldBounds();
    const def = playbook.def || {};
    const forwardBias = typeof def.forwardBias === 'number' ? def.forwardBias : 0.3;
    const lateral = def.lateral || 'balanced';
    const isTopLine = outY < field.centerY;
    // Attacking direction for throwing team (toward opp goal)
    const throwTeam = sim.throwInTaker && sim.throwInTaker.team;
    const secondHalf = sim.isSecondHalf && sim.isSecondHalf();
    const attacksRight = secondHalf ? throwTeam === 'B' : throwTeam === 'A';
    const fwd = attacksRight ? 1 : -1;

    const clampX = (val) => Math.max(Utils.scaleFieldX(3), Math.min(field.width - Utils.scaleFieldX(3), val));
    const clampY = (val) => Math.max(Utils.scaleFieldY(3), Math.min(field.height - Utils.scaleFieldY(3), val));

    for (let i = 0; i < sim.throwInReceivers.length; i++) {
        const r = sim.throwInReceivers[i];
        if (!r || !r.setPieceTarget) continue;
        const base = r.setPieceTarget;
        // Scale the percentage against a realistic maximum throw distance (e.g., 25 meters)
        let x = base.x + fwd * Utils.scaleFieldX(25.0 * forwardBias);
        let y = base.y;
        if (lateral === 'line') {
            // Channel down the line but keep a safe depth so the throw is not a
            // near-parallel skim that exits again for another throw-in.
            const minDepth = Utils.scaleFieldY(8);
            const maxDepth = Utils.scaleFieldY(14);
            if (isTopLine) {
                y = Math.max(minDepth, Math.min(maxDepth, y));
            } else {
                y = Math.min(field.height - minDepth, Math.max(field.height - maxDepth, y));
            }
        } else if (lateral === 'infield') {
            y = field.centerY * 0.55 + base.y * 0.45;
        }
        r.setPieceTarget = { x: clampX(x), y: clampY(y) };
    }
}

module.exports = {
    loadSetPiecePlaybooks,
    pickPlaybook,
    applyCornerPositions,
    pickCornerTarget,
    resolveWallSize,
    freekickShouldShoot,
    applyThrowInReceiverBias
};
