/**
 * TeamStates — squad posture FSM (attack / defend / set piece / kickoff prepare).
 *
 * Singletons with enter/execute/exit; reference equality via Team.fsm.isInState.
 * Match rules stay on Simulator MatchStates; these states only drive squad posture
 * (formation depth / hold bias) and clear support bookkeeping.
 *
 * dynamicStrategyShifting remains a separate modifier on Settings.AI knobs.
 */

/** Reference-field X bias: positive = push toward opponent goal. */
const POSTURE_DEPTH_REF = {
    attacking: 7.5,
    // Mild drop only — deep park-the-bus comes from getDefensiveShapePos danger zone
    defending: -3.5,
    setpiece: 0,
    kickoffprepare: 0
};

/**
 * Additive FORMATION_HOLD bias for this team only (clamped later when applied).
 * Does not mutate Settings.AI — stacks on top of knobs + archetype shifts.
 */
const POSTURE_HOLD_BIAS = {
    attacking: -0.08,
    // Keep some shape when defending; too high freezes a flat deep line
    defending: 0.06,
    setpiece: 0.18,
    kickoffprepare: 0.22
};

const TeamStates = {
    KickoffPrepare: {
        name: 'kickoffprepare',
        enter(team) {
            team.applyPosture('kickoffprepare');
            team.supportingPlayer = null;
            team.receivingPlayer = null;
            team._lastSupportMsgPlayer = null;
            // Hold shape for kickoff whistle (Wait / GoHome messages)
            if (typeof team.broadcastFormationMessage === 'function') {
                team.broadcastFormationMessage('GoHome');
            }
        },
        execute(_team) {
            // Transitions are decided in Team.syncFsmFromMatch (possession + match phase).
        },
        exit(_team) {}
    },

    SetPiece: {
        name: 'setpiece',
        enter(team) {
            team.applyPosture('setpiece');
            team.supportingPlayer = null;
            team.receivingPlayer = null;
            team._lastSupportMsgPlayer = null;
            // Hold shape while Simulator places wall/taker (Msg_Wait — not GoHome, which fights set-piece coords)
            if (typeof team.broadcastFormationMessage === 'function') {
                team.broadcastFormationMessage('Wait');
            }
        },
        execute(_team) {},
        exit(_team) {}
    },

    Attacking: {
        name: 'attacking',
        enter(team) {
            team.applyPosture('attacking');
            // Markers only while defending
            if (typeof team.clearMarking === 'function') {
                team.clearMarking();
            }
            if (typeof team.updatePlayPhase === 'function') {
                team.updatePlayPhase();
            }
            // Force a support-spot pass on first attack tick
            if (team.supportSpots && team.supportSpots.regulator) {
                team.supportSpots.regulator.forceReady();
            }
            if (typeof team.updateSupportSpots === 'function') {
                team.updateSupportSpots({ force: true });
            }
        },
        execute(team) {
            if (typeof team.updatePlayPhase === 'function') {
                team.updatePlayPhase();
            }
            // Refresh sweet spots + primary supporter while attacking
            if (typeof team.updateSupportSpots === 'function') {
                team.updateSupportSpots();
            }
        },
        exit(team) {
            // No dedicated support role while not attacking.
            team.supportingPlayer = null;
            if (team.playPhase != null) team.playPhase = 'none';
        }
    },

    Defending: {
        name: 'defending',
        enter(team) {
            // A.4: if just lost the ball, hold a higher line until counterpress expires
            if (typeof team.isCounterpressing === 'function' && team.isCounterpressing()) {
                team.applyPosture('defending', { delayRegionDrop: true });
            } else {
                team.applyPosture('defending');
            }
            team.supportingPlayer = null;
            team.receivingPlayer = null;
            if (team.markingRegulator) team.markingRegulator.forceReady();
            if (typeof team.updateMarking === 'function') {
                team.updateMarking({ force: true });
            }
        },
        execute(team) {
            // A.2 — reassign markers to free attackers on regulator
            if (typeof team.updateMarking === 'function') {
                team.updateMarking();
            }
        },
        exit(team) {
            if (typeof team.clearMarking === 'function') {
                team.clearMarking();
            }
            // Leaving defend (regain ball / set piece) — stop surge bookkeeping
            if (typeof team.clearCounterpress === 'function' && team.transitionTimer > 0) {
                team.transitionTimer = 0;
                team.counterpressSurge = [];
            }
        }
    }
};

/**
 * Map Simulator matchState string → desired TeamStates singleton.
 * Possession only matters during open play.
 *
 * @param {string} matchState
 * @param {boolean} inControl
 */
function resolveTeamStateFromMatch(matchState, inControl) {
    switch (matchState) {
        case 'play':
            return inControl ? TeamStates.Attacking : TeamStates.Defending;
        case 'kickoff':
        case 'goal':
        case 'halftime':
        case 'fulltime':
            return TeamStates.KickoffPrepare;
        case 'foul':
        case 'card':
        case 'freekick':
        case 'corner':
        case 'goalkick':
        case 'throwin':
        case 'offside':
            return TeamStates.SetPiece;
        default:
            // Unknown / stopped / bootstrapping
            return TeamStates.KickoffPrepare;
    }
}

module.exports = {
    TeamStates,
    POSTURE_DEPTH_REF,
    POSTURE_HOLD_BIAS,
    resolveTeamStateFromMatch
};
