/**
 * Browser scenario lab helpers: prune squads and force set-piece / open-play setups
 * after a normal Simulator bootstrap. Used by html/tests.html (not headless batch).
 */
const { Utils } = require('./utils.js');
const { PlayerStates } = require('../entities/player.js');
const {
    pickPlaybook,
    applyThrowInReceiverBias
} = require('./set_piece_playbooks.js');
const { getPenaltySpot } = require('./match_rules.js');

/** @typedef {'kickoff'|'throwin'|'corner'|'freekick'|'penalty'|'goalkick'|'pass'|'header'|'open_play'} ScenarioId */

/**
 * Catalog for the scenario picker UI.
 * `defaultOpponentOutfield` hints how many opposing outfielders to keep.
 */
const SCENARIO_CATALOG = [
    {
        id: 'kickoff',
        label: 'Kickoff',
        description: 'Standard match start from the center circle.',
        defaultOpponentOutfield: 10,
        options: []
    },
    {
        id: 'throwin',
        label: 'Throw-in',
        description: 'Touchline restart. Good for testing release aim and receivers.',
        defaultOpponentOutfield: 2,
        options: ['side', 'third']
    },
    {
        id: 'corner',
        label: 'Corner kick',
        description: 'Flag restart with box packing / delivery playbooks.',
        defaultOpponentOutfield: 6,
        options: ['cornerFlag']
    },
    {
        id: 'freekick',
        label: 'Free kick',
        description: 'Dead-ball free kick (wall when in shooting range).',
        defaultOpponentOutfield: 5,
        options: ['attackDepth', 'channel']
    },
    {
        id: 'penalty',
        label: 'Penalty',
        description: 'Spot kick vs GK. Default: no opposing outfielders.',
        defaultOpponentOutfield: 0,
        options: ['goalSide']
    },
    {
        id: 'goalkick',
        label: 'Goal kick',
        description: 'GK restart from the six-yard area.',
        defaultOpponentOutfield: 4,
        options: ['goalSide']
    },
    {
        id: 'pass',
        label: 'Pass / possession',
        description: 'Open play with the ball at a midfielder — practice short/long passes.',
        defaultOpponentOutfield: 1,
        options: ['fieldThird']
    },
    {
        id: 'header',
        label: 'Header',
        description: 'Lofted ball into an attacker for AI or timed human headers.',
        defaultOpponentOutfield: 0,
        options: []
    },
    {
        id: 'open_play',
        label: 'Open play (custom)',
        description: 'Live play from a chosen third; use squad counts to isolate situations.',
        defaultOpponentOutfield: 3,
        options: ['fieldThird']
    }
];

/**
 * @param {string} id
 * @returns {object|null}
 */
function getScenarioDef(id) {
    return SCENARIO_CATALOG.find((s) => s.id === id) || null;
}

/**
 * Remove outfield players beyond `keepCount` (by formation index).
 * Optionally remove the GK.
 *
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 * @param {number} keepOutfield - 0..10
 * @param {{ keepGk?: boolean }} [opts]
 */
function pruneTeamOutfield(sim, teamKey, keepOutfield, opts = {}) {
    const keepGk = opts.keepGk !== false;
    const team = sim.getTeam ? sim.getTeam(teamKey) : null;
    if (!team || !Array.isArray(team.players)) return;

    const outfield = team.players
        .filter((p) => p && p.role !== 'GK')
        .sort((a, b) => (a.formationIndex || 0) - (b.formationIndex || 0));
    const keepN = Math.max(0, Math.min(10, Math.floor(Number(keepOutfield) || 0)));
    const remove = outfield.slice(keepN);

    if (!keepGk) {
        const gk = team.players.find((p) => p && p.role === 'GK');
        if (gk) remove.push(gk);
    }

    if (remove.length === 0) return;

    const removeSet = new Set(remove);
    for (const p of remove) {
        p.parent = null;
        p.active = false;
        p.isSentOff = true;
        p.x = -9999;
        p.y = -9999;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
    }
    team.players = team.players.filter((p) => !removeSet.has(p));
    team.children = (team.children || []).filter((c) => !removeSet.has(c));

    if (typeof sim.syncPlayersList === 'function') {
        sim.syncPlayersList();
    } else {
        sim.players = [
            ...(sim.teamA ? sim.teamA.players : []),
            ...(sim.teamB ? sim.teamB.players : [])
        ];
    }
}

/**
 * @param {object} sim
 * @param {'A'|'B'} teamKey
 * @returns {object|null}
 */
function pickOutfielder(sim, teamKey) {
    const list = (sim.players || []).filter(
        (p) => p && p.team === teamKey && p.role !== 'GK' && !p.isSentOff
    );
    if (list.length === 0) return null;
    // Prefer MF / ST by role name when available
    const preferred = list.find((p) => p.role === 'MF' || p.role === 'ST' || p.role === 'AM');
    return preferred || list[Math.floor(list.length / 2)] || list[0];
}

/**
 * Give ground possession to a player and enter Dribble.
 * @param {object} sim
 * @param {object} player
 */
function giveBallTo(sim, player) {
    if (!sim || !sim.ball || !player) return;
    const ball = sim.ball;
    ball.owner = player;
    ball.x = player.x;
    ball.y = player.y;
    ball.z = 0;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ball.isThrowInFlight = false;
    ball.curveForce = 0;
    ball.ifkActive = false;
    ball.ifkTaker = null;
    ball.lastKicker = null;
    sim.lastTouchPlayer = player;
    if (player.fsm && PlayerStates.Dribble) {
        player.fsm.changeState(PlayerStates.Dribble);
    }
    const squad = sim.getTeam ? sim.getTeam(player.team) : null;
    if (squad && typeof squad.setControllingPlayer === 'function') {
        squad.setControllingPlayer(player);
    }
}

/**
 * Clear kickoff pins / set-piece leftovers so open-play scenarios start clean.
 * @param {object} sim
 */
function clearSetPieceFlags(sim) {
    sim.setPieceType = '';
    sim.setPieceSide = '';
    sim.setPieceCornerY = 0;
    sim.setPieceX = 0;
    sim.setPieceY = 0;
    sim.setPieceIndirect = false;
    sim.setPieceReadyPhase = false;
    sim.throwInTaker = null;
    sim.throwInReceivers = null;
    sim.activePlaybook = null;
    sim._setPieceBallSpot = null;
    sim._kickoffPins = null;
    if (sim.freekickWallPlayers && sim.freekickWallPlayers.length) {
        for (const p of sim.freekickWallPlayers) {
            if (!p) continue;
            p.isInWall = false;
            p.wallHoldX = null;
            p.wallHoldY = null;
        }
        sim.freekickWallPlayers = [];
    }
    for (const p of sim.players || []) {
        if (!p) continue;
        p.isWalkingToSetPiece = false;
        p.setPieceTarget = null;
    }
}

/**
 * Mirror of OOB throw-in setup so the lab can start mid-restart without a prior out.
 * @param {object} sim
 * @param {'A'|'B'} kickingTeam
 * @param {'top'|'bottom'} line
 * @param {'left'|'center'|'right'} third
 * @param {object} MatchStates
 */
function setupThrowInScenario(sim, kickingTeam, line, third, MatchStates) {
    const field = Utils.getFieldBounds();
    const margin = field.multiplier || 1;
    const touchInset = Math.max(margin * 0.45, 0.55);

    let fracX = 0.5;
    if (third === 'left') fracX = 0.22;
    else if (third === 'right') fracX = 0.78;

    const outX = Math.max(margin, Math.min(field.width - margin, field.width * fracX));
    const outY = line === 'bottom' ? (field.height - touchInset) : touchInset;

    // Reset everyone to base so nearest-taker / receiver picks are stable
    for (const p of sim.players || []) {
        if (!p || p.isSentOff) continue;
        p.x = p.baseX;
        p.y = p.baseY;
        p.z = 0;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.isWalkingToSetPiece = false;
        p.setPieceTarget = null;
    }

    let nearestTaker = null;
    let minDist = Infinity;
    for (const p of sim.players || []) {
        if (p.team === kickingTeam && p.role !== 'GK' && !p.isSentOff) {
            const d = Math.hypot(p.x - outX, p.y - outY);
            if (d < minDist) {
                minDist = d;
                nearestTaker = p;
            }
        }
    }
    if (!nearestTaker) return;

    sim.ball.owner = null;
    sim.ball.vx = 0;
    sim.ball.vy = 0;
    sim.ball.vz = 0;
    sim.ball.z = 0;
    sim.ball.isThrowInFlight = false;
    sim.ball.curveForce = 0;
    sim.ball.x = outX;
    sim.ball.y = outY;
    sim._setPieceBallSpot = { x: outX, y: outY };
    sim._throwInExtraWait = 0;

    nearestTaker.setPieceTarget = { x: outX, y: outY };
    nearestTaker.isWalkingToSetPiece = true;
    sim.throwInTaker = nearestTaker;

    const teammates = (sim.players || []).filter(
        (p) => p.team === kickingTeam && p !== nearestTaker && p.role !== 'GK' && !p.isSentOff
    );
    teammates.sort((a, b) => {
        const da = Math.hypot(a.x - outX, a.y - outY);
        const db = Math.hypot(b.x - outX, b.y - outY);
        return da - db;
    });

    const teammate1 = teammates[0];
    const teammate2 = teammates[1];
    sim.throwInReceivers = [];

    const secondHalf = typeof sim.isSecondHalf === 'function' ? sim.isSecondHalf() : false;
    const isTeamLeft = (team) => (secondHalf ? team === 'B' : team === 'A');
    const isTopLine = outY < field.centerY;
    const shiftY = isTopLine ? Utils.scaleFieldY(8) : -Utils.scaleFieldY(8);
    const shiftY2 = isTopLine ? Utils.scaleFieldY(10) : -Utils.scaleFieldY(10);
    const clampX = (val) => Math.max(Utils.scaleFieldX(3), Math.min(field.width - Utils.scaleFieldX(3), val));
    const clampY = (val) => Math.max(Utils.scaleFieldY(3), Math.min(field.height - Utils.scaleFieldY(3), val));

    if (teammate1) {
        teammate1.setPieceTarget = {
            x: clampX(outX - Utils.scaleFieldX(5)),
            y: clampY(outY + shiftY)
        };
        teammate1.isWalkingToSetPiece = true;
        sim.throwInReceivers.push(teammate1);
    }
    if (teammate2) {
        teammate2.setPieceTarget = {
            x: clampX(outX + Utils.scaleFieldX(5)),
            y: clampY(outY + shiftY2)
        };
        teammate2.isWalkingToSetPiece = true;
        sim.throwInReceivers.push(teammate2);
    }

    const opponents = (sim.players || []).filter(
        (p) => p.team !== kickingTeam && p.role !== 'GK' && !p.isSentOff
    );
    opponents.sort((a, b) => {
        const da = Math.hypot(a.x - outX, a.y - outY);
        const db = Math.hypot(b.x - outX, b.y - outY);
        return da - db;
    });

    if (teammate1 && opponents[0]) {
        opponents[0].setPieceTarget = {
            x: clampX(teammate1.setPieceTarget.x + (isTeamLeft(opponents[0].team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
            y: teammate1.setPieceTarget.y
        };
        opponents[0].isWalkingToSetPiece = true;
    }
    if (teammate2 && opponents[1]) {
        opponents[1].setPieceTarget = {
            x: clampX(teammate2.setPieceTarget.x + (isTeamLeft(opponents[1].team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
            y: teammate2.setPieceTarget.y
        };
        opponents[1].isWalkingToSetPiece = true;
    }

    const throwPb = pickPlaybook('throwin');
    sim.activePlaybook = throwPb;
    applyThrowInReceiverBias(sim, throwPb, outX, outY);

    if (teammate1 && opponents[0] && teammate1.setPieceTarget) {
        opponents[0].setPieceTarget = {
            x: clampX(teammate1.setPieceTarget.x + (isTeamLeft(opponents[0].team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
            y: teammate1.setPieceTarget.y
        };
    }
    if (teammate2 && opponents[1] && teammate2.setPieceTarget) {
        opponents[1].setPieceTarget = {
            x: clampX(teammate2.setPieceTarget.x + (isTeamLeft(opponents[1].team) ? -Utils.scaleFieldX(1.5) : Utils.scaleFieldX(1.5))),
            y: teammate2.setPieceTarget.y
        };
    }

    sim.setPieceType = 'throwin';
    sim.setPieceKickingTeam = kickingTeam;
    if (MatchStates && MatchStates.Throwin && sim.fsm) {
        sim.fsm.changeState(MatchStates.Throwin);
    }
}

/**
 * Place squad near a field third and give ball to kicking team midfielder.
 * @param {object} sim
 * @param {'A'|'B'} kickingTeam
 * @param {'own'|'middle'|'attack'} third
 */
function setupOpenPossession(sim, kickingTeam, third) {
    const field = Utils.getFieldBounds();
    const defTeam = kickingTeam === 'A' ? 'B' : 'A';
    // Team A attacks right in first half
    let targetX;
    if (third === 'own') targetX = field.width * 0.28;
    else if (third === 'attack') targetX = field.width * 0.72;
    else targetX = field.centerX;

    // Mirror for team B (attacks left)
    if (kickingTeam === 'B') {
        targetX = field.width - targetX;
    }

    for (const p of sim.players || []) {
        if (!p || p.isSentOff) continue;
        // Soft bias toward scenario zone while keeping shape offsets
        const bias = 0.45;
        p.x = p.baseX * (1 - bias) + targetX * bias;
        p.y = p.baseY;
        p.z = 0;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        if (p.role === 'GK' && p.fsm && PlayerStates.Goalkeeper) {
            p.fsm.changeState(PlayerStates.Goalkeeper);
        } else if (p.fsm && PlayerStates.Idle) {
            p.fsm.changeState(PlayerStates.Idle);
        }
    }

    const carrier = pickOutfielder(sim, kickingTeam);
    if (carrier) {
        carrier.x = targetX;
        carrier.y = field.centerY + Utils.scaleFieldY(2);
        giveBallTo(sim, carrier);
    }

    // Nudge opposing GK back to their line
    const defGk = (sim.players || []).find((p) => p.team === defTeam && p.role === 'GK' && !p.isSentOff);
    if (defGk) {
        defGk.x = defTeam === 'A' ? Utils.scaleFieldX(0.625) : field.width - Utils.scaleFieldX(0.625);
        defGk.y = field.centerY;
    }
}

/**
 * Loft a ball toward an attacker so header FSM / human header window can fire.
 * @param {object} sim
 * @param {'A'|'B'} kickingTeam
 */
function setupHeaderScenario(sim, kickingTeam) {
    const field = Utils.getFieldBounds();
    const attacksRight = kickingTeam === 'A';
    const receiver = pickOutfielder(sim, kickingTeam);
    if (!receiver) return;

    const rx = attacksRight ? field.width * 0.62 : field.width * 0.38;
    const ry = field.centerY;
    receiver.x = rx;
    receiver.y = ry;
    receiver.z = 0;
    receiver.vx = 0;
    receiver.vy = 0;
    if (receiver.fsm && PlayerStates.Idle) {
        receiver.fsm.changeState(PlayerStates.Idle);
    }

    // Teammates nearby for knock-down options
    const mates = (sim.players || []).filter(
        (p) => p.team === kickingTeam && p !== receiver && p.role !== 'GK' && !p.isSentOff
    );
    for (let i = 0; i < mates.length; i++) {
        const m = mates[i];
        m.x = rx + (attacksRight ? -6 : 6) + (i % 3) * 2;
        m.y = ry + ((i % 2 === 0) ? -4 : 4);
        m.z = 0;
        if (m.fsm && PlayerStates.Idle) m.fsm.changeState(PlayerStates.Idle);
    }

    // Ball approaches from behind receiver, hang time ~0.7s into header band
    const approach = attacksRight ? -8 : 8;
    sim.ball.owner = null;
    sim.ball.x = rx + approach;
    sim.ball.y = ry;
    sim.ball.z = 1.6;
    // ~0.55s to cover 8u → ~14.5 m/s horizontal; vz for hang near 1.2m peak
    const g = 9.81;
    const t = 0.55;
    sim.ball.vx = -approach / t;
    sim.ball.vy = 0;
    sim.ball.vz = 1.2; // mild hang; gravity brings it through 0.9–2.0 band
    sim.ball.isThrowInFlight = false;
    sim.ball.curveForce = 0;
    sim.ball.lastKicker = mates[0] || null;
    sim.lastTouchPlayer = sim.ball.lastKicker;

    // Opposing GK on line if present
    const defTeam = kickingTeam === 'A' ? 'B' : 'A';
    const defGk = (sim.players || []).find((p) => p.team === defTeam && p.role === 'GK' && !p.isSentOff);
    if (defGk) {
        defGk.x = attacksRight ? field.width - Utils.scaleFieldX(0.625) : Utils.scaleFieldX(0.625);
        defGk.y = field.centerY;
        if (defGk.fsm && PlayerStates.Goalkeeper) {
            defGk.fsm.changeState(PlayerStates.Goalkeeper);
        }
    }

    // Silence unused g (kept for future hang math)
    void g;
}

/**
 * Read-normalized config from UI / callers.
 * @param {object} raw
 */
function normalizeScenarioConfig(raw = {}) {
    const id = raw.id || raw.scenario || 'kickoff';
    const def = getScenarioDef(id);
    return {
        id,
        kickingTeam: raw.kickingTeam === 'B' ? 'B' : 'A',
        opponentOutfield: raw.opponentOutfield != null
            ? Math.max(0, Math.min(10, parseInt(raw.opponentOutfield, 10) || 0))
            : (def ? def.defaultOpponentOutfield : 10),
        ownOutfield: raw.ownOutfield != null
            ? Math.max(1, Math.min(10, parseInt(raw.ownOutfield, 10) || 10))
            : 10,
        keepOpponentGk: raw.keepOpponentGk !== false && raw.keepOpponentGk !== 'false',
        // throw-in
        throwLine: raw.throwLine === 'bottom' ? 'bottom' : 'top',
        throwThird: ['left', 'center', 'right'].includes(raw.throwThird) ? raw.throwThird : 'center',
        // corner: tl | tr | bl | br
        cornerFlag: ['tl', 'tr', 'bl', 'br'].includes(raw.cornerFlag) ? raw.cornerFlag : 'tr',
        // freekick depth: edge_box | mid | deep
        attackDepth: ['edge_box', 'mid', 'deep'].includes(raw.attackDepth) ? raw.attackDepth : 'edge_box',
        channel: ['center', 'left', 'right'].includes(raw.channel) ? raw.channel : 'center',
        // goal side for penalty / goalkick (goal being attacked / defended)
        goalSide: raw.goalSide === 'left' ? 'left' : 'right',
        // open play third
        fieldThird: ['own', 'middle', 'attack'].includes(raw.fieldThird) ? raw.fieldThird : 'middle'
    };
}

/**
 * Run scenario body under the sim's seeded LCG (same contract as bootstrapMatch / updateAll).
 * bootstrapMatch restores native Math.random when it finishes; apply must re-bind so
 * playbook picks and placement jitter stay seed-deterministic.
 * @param {object} sim
 * @param {() => any} fn
 */
function withSimSeededRandom(sim, fn) {
    const prevRandom = Math.random;
    try {
        if (typeof sim.seededRandom === 'function') {
            Math.random = sim.seededRandom;
        } else if (typeof sim.bindSeededRandom === 'function') {
            sim.bindSeededRandom();
        }
        return fn();
    } finally {
        Math.random = prevRandom;
    }
}

/**
 * Apply a scenario to a fully bootstrapped Simulator (after start/bootstrapMatch).
 * Uses the sim's seeded RNG so the same seed + config yields the same setup.
 *
 * @param {object} sim
 * @param {object} rawConfig
 * @param {object} MatchStates - from simulator.js
 * @returns {{ ok: boolean, id: string, message?: string }}
 */
function applyTestScenario(sim, rawConfig, MatchStates) {
    if (!sim || !sim.ball || !sim.players) {
        return { ok: false, id: 'unknown', message: 'Simulator not ready' };
    }

    return withSimSeededRandom(sim, () => {
        const cfg = normalizeScenarioConfig(rawConfig);
        const kickingTeam = cfg.kickingTeam;
        const defendingTeam = kickingTeam === 'A' ? 'B' : 'A';
        const field = Utils.getFieldBounds();

        // Prune squads first so set-piece taker / wall selection sees the reduced roster
        pruneTeamOutfield(sim, kickingTeam, cfg.ownOutfield, { keepGk: true });
        pruneTeamOutfield(sim, defendingTeam, cfg.opponentOutfield, { keepGk: cfg.keepOpponentGk });

        // Leave default kickoff alone (bootstrap already set Kickoff)
        if (cfg.id === 'kickoff') {
            return { ok: true, id: cfg.id };
        }

        clearSetPieceFlags(sim);

        if (cfg.id === 'throwin') {
            setupThrowInScenario(sim, kickingTeam, cfg.throwLine, cfg.throwThird, MatchStates);
            return { ok: true, id: cfg.id };
        }

        if (cfg.id === 'corner') {
            const flag = cfg.cornerFlag;
            const side = (flag === 'tl' || flag === 'bl') ? 'left' : 'right';
            const cornerY = (flag === 'tl' || flag === 'tr') ? 0 : field.height;
            sim.setPieceType = 'corner';
            sim.setPieceSide = side;
            sim.setPieceKickingTeam = kickingTeam;
            sim.setPieceCornerY = cornerY;
            sim.setupSetPiecePositions('corner', side, kickingTeam, cornerY);
            if (MatchStates && MatchStates.Corner && sim.fsm) {
                sim.fsm.changeState(MatchStates.Corner);
            }
            return { ok: true, id: cfg.id };
        }

        if (cfg.id === 'freekick') {
            // Team A attacks right: place FK in that direction's attacking half for a wall
            const attacksRight = kickingTeam === 'A';
            let depthFrac = 0.72; // edge of box-ish
            if (cfg.attackDepth === 'mid') depthFrac = 0.58;
            if (cfg.attackDepth === 'deep') depthFrac = 0.42;

            let bx = attacksRight ? field.width * depthFrac : field.width * (1 - depthFrac);
            let by = field.centerY;
            if (cfg.channel === 'left') by = field.height * 0.28;
            if (cfg.channel === 'right') by = field.height * 0.72;

            sim.setPieceX = bx;
            sim.setPieceY = by;
            sim.setPieceSide = attacksRight ? 'right' : 'left';
            sim.setPieceType = 'freekick';
            sim.setPieceKickingTeam = kickingTeam;
            sim.setPieceIndirect = false;
            sim.setupSetPiecePositions('freekick', sim.setPieceSide, kickingTeam);
            if (MatchStates && MatchStates.Freekick && sim.fsm) {
                sim.fsm.changeState(MatchStates.Freekick);
            }
            return { ok: true, id: cfg.id };
        }

        if (cfg.id === 'penalty') {
            // goalSide = goal being attacked (defending goal of opponent)
            let side = cfg.goalSide;
            // Default: kick toward opponent's goal for first half
            if (rawConfig.goalSide == null || rawConfig.goalSide === '') {
                side = kickingTeam === 'A' ? 'right' : 'left';
            }
            sim.setPieceType = 'penalty';
            sim.setPieceSide = side;
            sim.setPieceKickingTeam = kickingTeam;
            sim.setPieceIndirect = false;
            const spot = getPenaltySpot(side, field);
            sim.setPieceX = spot.x;
            sim.setPieceY = spot.y;
            sim.setupSetPiecePositions('penalty', side, kickingTeam);
            if (MatchStates && MatchStates.Penalty && sim.fsm) {
                sim.fsm.changeState(MatchStates.Penalty);
            }
            return { ok: true, id: cfg.id };
        }

        if (cfg.id === 'goalkick') {
            // Goalkick is taken by the defending team at their goal — use kickingTeam as the restart team
            const side = cfg.goalSide === 'left' ? 'left' : 'right';
            // If user picked "kicking team A" and goal right, A takes from right (unusual first half) — honor explicit goalSide
            sim.setPieceType = 'goalkick';
            sim.setPieceSide = side;
            sim.setPieceKickingTeam = kickingTeam;
            sim.setupSetPiecePositions('goalkick', side, kickingTeam);
            if (MatchStates && MatchStates.Goalkick && sim.fsm) {
                sim.fsm.changeState(MatchStates.Goalkick);
            }
            return { ok: true, id: cfg.id };
        }

        if (cfg.id === 'pass' || cfg.id === 'open_play') {
            setupOpenPossession(sim, kickingTeam, cfg.fieldThird);
            if (MatchStates && MatchStates.Play && sim.fsm) {
                sim.fsm.changeState(MatchStates.Play);
            }
            return { ok: true, id: cfg.id };
        }

        if (cfg.id === 'header') {
            setupHeaderScenario(sim, kickingTeam);
            if (MatchStates && MatchStates.Play && sim.fsm) {
                sim.fsm.changeState(MatchStates.Play);
            }
            return { ok: true, id: cfg.id };
        }

        return { ok: false, id: cfg.id, message: `Unknown scenario: ${cfg.id}` };
    });
}

module.exports = {
    SCENARIO_CATALOG,
    getScenarioDef,
    normalizeScenarioConfig,
    pruneTeamOutfield,
    applyTestScenario,
    giveBallTo,
    pickOutfielder
};
