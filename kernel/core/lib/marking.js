/**
 * Marking & cover assignments for free attackers while defending.
 *
 * While defending, assign 1–2 markers to dangerous free attackers (not the
 * ball carrier). Markers hold a cover shadow: interpose between the mark and
 * own goal — not a second press on the carrier.
 *
 * Threat score (xG-lite, deterministic):
 *   closer to defending goal + open pass lane from carrier + role bias + far-post Y
 *
 * Assignment is team-owned (`Team.markingMap`) and tick-regulated.
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');
const { TickRegulator } = require('./logic_regulator.js');
const {
    isPassSafeFromAllOpponents,
    estimatePassGroundSpeed,
    dist2d
} = require('./pass_safety.js');
const { interposePoint } = require('./steering.js');

/** Defaults when Settings.AI keys are absent. */
const MARK_DEFAULTS = {
    MARK_MAX_MARKERS: 2,
    MARK_UPDATE_TICKS: 20, // ~1s at 20 UPS
    MARK_COVER_RATIO: 0.42, // fraction of goal→mark distance from goal
    MARK_COVER_MIN_DIST: 2.5,
    MARK_COVER_MAX_DIST: 14,
    MARK_SHAPE_BLEND: 0.28, // residual mid-block when covering
    MARK_STICKINESS_MARGIN: 1.5, // keep pair unless challenger this much better
    MARK_OPEN_LANE_BONUS: 3.5,
    MARK_ROLE_ATTACK_BONUS: 2.0,
    MARK_ROLE_MID_BONUS: 0.8,
    MARK_FAR_POST_BONUS: 1.2,
    MARK_MAX_ASSIGN_DIST: 22 // ignore marks farther than this from marker pool
};

/**
 * @param {object|null} team
 */
function resolveTeamAI(team) {
    const base = Settings.AI || {};
    if (team && team.teamKey && base[team.teamKey]) {
        return base[team.teamKey];
    }
    return base;
}

/**
 * @param {object|null} team
 * @param {string} key
 */
function aiNum(team, key) {
    const a = resolveTeamAI(team);
    if (typeof a[key] === 'number') return a[key];
    if (typeof MARK_DEFAULTS[key] === 'number') return MARK_DEFAULTS[key];
    return 0;
}

/**
 * @param {string} role
 * @returns {number} fitness 0–1 for marking duty
 */
function markerRoleFitness(role) {
    if (!role || role === 'GK') return 0;
    if (/CB|LCB|RCB/i.test(role)) return 1.0;
    if (/LB|RB|LWB|RWB|DM|CDM/i.test(role)) return 0.9;
    if (/CM|LCM|RCM/i.test(role)) return 0.55;
    if (/LM|RM/i.test(role)) return 0.4;
    return 0.15; // attackers rarely mark
}

/**
 * @param {string} role
 */
function threatRoleBonus(role, team) {
    if (/S|ST|CF|SS|F|LW|RW|WF|AM|CAM/i.test(role || '')) {
        return aiNum(team, 'MARK_ROLE_ATTACK_BONUS');
    }
    if (/CM|LCM|RCM|LM|RM|DM|CDM/i.test(role || '')) {
        return aiNum(team, 'MARK_ROLE_MID_BONUS');
    }
    return 0;
}

/**
 * Score free attacker threat vs defending team (higher = more dangerous).
 *
 * @param {object} attacker - opponent outfielder (not carrier)
 * @param {object} carrier - ball owner
 * @param {object} defendingTeam - Team entity
 * @param {number} ownGoalX
 * @param {number} ownGoalY
 * @param {Array} defendingPlayers - for open-lane check (null receiver = no exclusion)
 * @returns {number}
 */
function scoreAttackerThreat(attacker, carrier, defendingTeam, ownGoalX, ownGoalY, defendingPlayers) {
    if (!attacker || attacker.isSentOff) return -Infinity;

    const field = Utils.getFieldBounds();
    // Closer to our goal → higher threat (normalize by field width)
    const distGoal = Math.hypot(attacker.x - ownGoalX, attacker.y - ownGoalY);
    const goalThreat = (field.width - Math.min(field.width, distGoal)) / Math.max(1e-6, field.width) * 10;

    let openBonus = 0;
    // Open-lane geometry is expensive (pass-safety vs all defenders). Only run it for
    // attackers already threatening our goal — ranking noise for deep/away players.
    if (carrier && defendingPlayers && defendingPlayers.length && goalThreat >= 4.0) {
        const from = { x: carrier.x, y: carrier.y };
        const to = { x: attacker.x, y: attacker.y };
        const dist = dist2d(from.x, from.y, to.x, to.y);
        if (dist > 1.5 && dist < 28) {
            const speed = estimatePassGroundSpeed(from, to, carrier, dist > 9 ? 'long' : 'short');
            // Receiver is the attacker (opposing); safety tests our defenders as "opponents" of the pass
            if (isPassSafeFromAllOpponents(from, to, attacker, defendingPlayers, speed)) {
                openBonus = aiNum(defendingTeam, 'MARK_OPEN_LANE_BONUS');
            }
        }
    }

    const roleB = threatRoleBonus(attacker.role, defendingTeam);

    // Far-post: attacker on opposite side of goal mouth from ball (classic cutback threat)
    let farPost = 0;
    if (carrier) {
        const goalMidY = ownGoalY;
        const ballSide = Math.sign(carrier.y - goalMidY) || 1;
        const attSide = Math.sign(attacker.y - goalMidY) || 1;
        if (ballSide !== attSide && Math.abs(attacker.y - carrier.y) > Utils.scaleFieldY(8)) {
            farPost = aiNum(defendingTeam, 'MARK_FAR_POST_BONUS');
        }
    }

    // Prefer attackers in advanced zones (our half relative to goal)
    const advanced = distGoal < field.width * 0.55 ? 1.0 : 0;

    return goalThreat + openBonus + roleB + farPost + advanced;
}

/**
 * Stable sort key for determinism (score desc, then name, then team index).
 * @param {{ score: number, player: object }} a
 * @param {{ score: number, player: object }} b
 */
function compareThreat(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    const an = a.player.name || '';
    const bn = b.player.name || '';
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
}

/**
 * Cover point: interpose between mark and own goal along goal→mark.
 *
 * @param {{ x: number, y: number }} markPos
 * @param {number} ownGoalX
 * @param {number} ownGoalY
 * @param {object|null} team
 * @returns {{ x: number, y: number }}
 */
function computeCoverPoint(markPos, ownGoalX, ownGoalY, team) {
    const field = Utils.getFieldBounds();
    const dist = Math.hypot(markPos.x - ownGoalX, markPos.y - ownGoalY);
    const ratio = aiNum(team, 'MARK_COVER_RATIO');
    const minDist = aiNum(team, 'MARK_COVER_MIN_DIST');
    const maxDist = aiNum(team, 'MARK_COVER_MAX_DIST');

    let standOff = dist * ratio;
    standOff = Math.max(minDist, Math.min(maxDist, standOff));
    standOff = Math.min(standOff, Math.max(0.5, dist - 0.8));

    const pt = interposePoint(markPos, { x: ownGoalX, y: ownGoalY }, standOff);
    const margin = 0.5 * (field.multiplier || 1);
    return {
        x: Math.max(margin, Math.min(field.width - margin, pt.x)),
        y: Math.max(margin, Math.min(field.height - margin, pt.y))
    };
}

/**
 * Resolve defending goal mouth center for cover geometry.
 * @param {object} defendingTeam
 * @returns {{ ownGoalX: number, ownGoalY: number }}
 */
function resolveOwnGoal(defendingTeam) {
    const field = Utils.getFieldBounds();
    let ownGoalX = 0;
    let ownGoalY = field.centerY;
    const hg = typeof defendingTeam.getHomeGoal === 'function'
        ? defendingTeam.getHomeGoal()
        : defendingTeam.homeGoal;
    if (hg) {
        if (hg.center && typeof hg.center.x === 'number') {
            return { ownGoalX: hg.center.x, ownGoalY: hg.center.y };
        }
        if (typeof hg.x === 'number') {
            return {
                ownGoalX: hg.x,
                ownGoalY: hg.y != null ? hg.y : field.centerY
            };
        }
    }
    // A attacks right in 1st half → defends left (x=0)
    const level = defendingTeam.level;
    const second = level && typeof level.isSecondHalf === 'function' && level.isSecondHalf();
    if (defendingTeam.teamKey === 'A') {
        ownGoalX = second ? field.width : 0;
    } else {
        ownGoalX = second ? 0 : field.width;
    }
    return { ownGoalX, ownGoalY };
}

/**
 * Build ranked free-attacker list for the defending team.
 *
 * @param {object} defendingTeam
 * @param {object} carrier
 * @param {Array} attackers - opponent outfield players
 * @returns {{ ranked: Array<{ player: object, score: number }>, ownGoalX: number, ownGoalY: number }}
 */
function rankThreats(defendingTeam, carrier, attackers) {
    const { ownGoalX, ownGoalY } = resolveOwnGoal(defendingTeam);

    const defenders = typeof defendingTeam.getOutfieldPlayers === 'function'
        ? defendingTeam.getOutfieldPlayers()
        : (defendingTeam.players || []).filter(p => p && p.role !== 'GK');

    const ranked = [];
    for (let i = 0; i < attackers.length; i++) {
        const atk = attackers[i];
        if (!atk || atk.isSentOff || atk === carrier || atk.role === 'GK') continue;
        const score = scoreAttackerThreat(
            atk, carrier, defendingTeam, ownGoalX, ownGoalY, defenders
        );
        if (score > -Infinity) ranked.push({ player: atk, score });
    }
    ranked.sort(compareThreat);
    return { ranked, ownGoalX, ownGoalY };
}

/**
 * Cost for assigning marker → target (lower better). Deterministic.
 * @param {object} marker
 * @param {object} target
 * @param {object|null} team
 */
function assignmentCost(marker, target, team) {
    const dist = dist2d(marker.x, marker.y, target.x, target.y);
    const fitness = markerRoleFitness(marker.role);
    // Prefer fit markers; penalize distance
    return dist * (1.35 - fitness * 0.6) - fitness * 2.0;
}

/**
 * Greedy deterministic assignment: top threats get best available markers.
 *
 * @param {object} defendingTeam
 * @param {Array<{ player: object, score: number }>} threats
 * @param {Array<object>} markerPool - eligible defenders
 * @param {Array<{ marker: object, target: object }>|null} prevPairs
 * @param {number} maxMarkers
 * @returns {Array<{ marker: object, target: object, score: number }>}
 */
function assignMarkers(defendingTeam, threats, markerPool, prevPairs, maxMarkers) {
    const maxN = Math.max(0, Math.min(maxMarkers, threats.length, markerPool.length));
    if (maxN === 0) return [];

    const margin = aiNum(defendingTeam, 'MARK_STICKINESS_MARGIN');
    const maxDist = aiNum(defendingTeam, 'MARK_MAX_ASSIGN_DIST');
    const usedMarkers = new Set();
    const usedTargets = new Set();
    const pairs = [];

    // Sticky: keep previous pairs if both still eligible and not far worse
    if (prevPairs && prevPairs.length) {
        for (let i = 0; i < prevPairs.length && pairs.length < maxN; i++) {
            const prev = prevPairs[i];
            if (!prev || !prev.marker || !prev.target) continue;
            if (usedMarkers.has(prev.marker) || usedTargets.has(prev.target)) continue;
            if (!markerPool.includes(prev.marker)) continue;
            const threatEntry = threats.find(t => t.player === prev.target);
            if (!threatEntry) continue;
            const cost = assignmentCost(prev.marker, prev.target, defendingTeam);
            // Best alternative cost for this target
            let bestAlt = Infinity;
            for (let j = 0; j < markerPool.length; j++) {
                const m = markerPool[j];
                if (m === prev.marker || usedMarkers.has(m)) continue;
                const c = assignmentCost(m, prev.target, defendingTeam);
                if (c < bestAlt) bestAlt = c;
            }
            if (cost <= bestAlt + margin && dist2d(prev.marker.x, prev.marker.y, prev.target.x, prev.target.y) <= maxDist) {
                pairs.push({
                    marker: prev.marker,
                    target: prev.target,
                    score: threatEntry.score
                });
                usedMarkers.add(prev.marker);
                usedTargets.add(prev.target);
            }
        }
    }

    // Greedy fill by threat rank
    for (let t = 0; t < threats.length && pairs.length < maxN; t++) {
        const threat = threats[t];
        if (usedTargets.has(threat.player)) continue;

        let bestM = null;
        let bestCost = Infinity;
        for (let j = 0; j < markerPool.length; j++) {
            const m = markerPool[j];
            if (usedMarkers.has(m) || !m || m.isSentOff) continue;
            const d = dist2d(m.x, m.y, threat.player.x, threat.player.y);
            if (d > maxDist) continue;
            const c = assignmentCost(m, threat.player, defendingTeam);
            if (c < bestCost - 1e-9) {
                bestCost = c;
                bestM = m;
            } else if (Math.abs(c - bestCost) <= 1e-9 && bestM) {
                // Deterministic tie-break by name
                const mn = m.name || '';
                const bn = bestM.name || '';
                if (mn < bn) {
                    bestM = m;
                    bestCost = c;
                }
            }
        }
        if (bestM) {
            pairs.push({ marker: bestM, target: threat.player, score: threat.score });
            usedMarkers.add(bestM);
            usedTargets.add(threat.player);
        }
    }

    return pairs;
}

/**
 * Create a TickRegulator for marking updates.
 * @param {object|null} team
 */
function createMarkingRegulator(team) {
    const ticks = Math.max(1, aiNum(team, 'MARK_UPDATE_TICKS') | 0);
    return new TickRegulator(ticks);
}

/**
 * High-level recompute for a defending team.
 *
 * @param {object} team - defending Team
 * @param {{
 *   force?: boolean,
 *   excludePlayers?: object[],
 *   prevPairs?: Array
 * }} [opts]
 * @returns {{ pairs: Array, ownGoalX: number, ownGoalY: number }}
 */
function computeMarkingAssignments(team, opts = {}) {
    const empty = { pairs: [], ownGoalX: 0, ownGoalY: Utils.getFieldBounds().centerY };
    if (!team || !team.level) return empty;

    const level = team.level;
    const ball = level.ball;
    if (!ball || !ball.owner || ball.owner.team === team.teamKey) {
        return empty;
    }
    if (ball.owner.role === 'GK') return empty;

    const carrier = ball.owner;
    const opp = team.opponents;
    const attackers = opp
        ? (typeof opp.getOutfieldPlayers === 'function' ? opp.getOutfieldPlayers() : opp.players || [])
        : (level.players || []).filter(p => p.team !== team.teamKey && p.role !== 'GK');

    const { ranked, ownGoalX, ownGoalY } = rankThreats(team, carrier, attackers);
    if (!ranked.length) return { pairs: [], ownGoalX, ownGoalY };

    const exclude = new Set(opts.excludePlayers || []);
    // Never mark with primary presser / listed chasers
    if (team.stickyPrimaryChaser) exclude.add(team.stickyPrimaryChaser);

    const maxMarkers = Math.max(0, aiNum(team, 'MARK_MAX_MARKERS') | 0);
    const markerPool = (typeof team.getOutfieldPlayers === 'function'
        ? team.getOutfieldPlayers()
        : (team.players || []).filter(p => p && p.role !== 'GK')
    ).filter(p => p && !p.isSentOff && !exclude.has(p) && markerRoleFitness(p.role) >= 0.35);

    const pairs = assignMarkers(
        team,
        ranked,
        markerPool,
        opts.prevPairs || null,
        maxMarkers
    );
    return { pairs, ownGoalX, ownGoalY };
}

module.exports = {
    MARK_DEFAULTS,
    resolveTeamAI,
    markerRoleFitness,
    scoreAttackerThreat,
    compareThreat,
    resolveOwnGoal,
    computeCoverPoint,
    rankThreats,
    assignmentCost,
    assignMarkers,
    createMarkingRegulator,
    computeMarkingAssignments,
    dist2d
};
