#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Defensive mid-block: non-chasers should not all sit on a deep flat line.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { TeamStates } = require('../kernel/core/entities/team_states.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function main() {
    const sim = new Simulator({ seed: 77 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);
    const field = Utils.getFieldBounds();

    // A attacks right with ball in midfield (not deep in B box)
    const carrier = sim.teamA.getOutfieldPlayers().find(p => /S|ST|CF|CM|AM/i.test(p.role || ''))
        || sim.teamA.getOutfieldPlayers()[0];
    carrier.x = field.width * 0.52;
    carrier.y = field.centerY;
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;
    sim.teamA.setControllingPlayer(carrier);
    sim.teamA.syncFsmFromMatch();
    sim.teamB.syncFsmFromMatch();
    assert.ok(sim.teamB.fsm.isInState(TeamStates.Defending));

    // Sample B outfield defensive targets
    const defs = sim.teamB.getOutfieldPlayers();
    const targets = defs.map(p => {
        p.level = sim;
        return { p, t: p.getDefensiveShapePos() };
    });

    const xs = targets.map(o => o.t.x);
    const ys = targets.map(o => o.t.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // B defends right goal in 1st half — should not all sit at the right touchline/goal
    // Mid-block: most targets left of deep box when ball is midfield
    const deepBox = field.width - Utils.scaleFieldX(14);
    const deepCount = xs.filter(x => x > deepBox).length;
    assert.ok(
        deepCount < defs.length * 0.55,
        `not majority parked in deep box (deep=${deepCount}/${defs.length}, deepBox=${deepBox.toFixed(1)})`
    );

    // Staggered line: CBs deeper (higher X for B) than strikers on average
    const cbs = targets.filter(o => /CB|LCB|RCB/i.test(o.p.role || ''));
    const ats = targets.filter(o => /S|ST|CF|AM|CAM/i.test(o.p.role || ''));
    if (cbs.length && ats.length) {
        const avgCb = cbs.reduce((s, o) => s + o.t.x, 0) / cbs.length;
        const avgAt = ats.reduce((s, o) => s + o.t.x, 0) / ats.length;
        assert.ok(
            avgCb > avgAt - 1.0,
            `CBs should sit deeper than attackers (CB=${avgCb.toFixed(1)} AT=${avgAt.toFixed(1)})`
        );
    }
    log('PASS role-staggered mid-block depth');

    // Lateral spread: not a single-file line on one Y
    const ySpan = maxY - minY;
    assert.ok(ySpan > field.height * 0.2, `keep width in defensive shape (ySpan=${ySpan.toFixed(1)})`);
    log('PASS defensive shape keeps lateral spread');

    // When ball is midfield, average defensive X should be near ball / mid, not glued to goal
    const avgX = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(
        avgX < field.width * 0.88,
        `avg defensive line not on endline (avgX=${avgX.toFixed(1)} w=${field.width})`
    );
    log('PASS midfield attack does not force bus at endline');

    log('\nAll defensive shape tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
