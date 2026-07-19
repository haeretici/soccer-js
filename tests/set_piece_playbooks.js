#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * A.5 Set-piece playbooks — weighted pick, corner layout, freekick shoot prefs, throw-in bias.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { resumeSetPieceToPlay } = require('../kernel/providers/simulator/set_piece_resume.js');
const {
    loadSetPiecePlaybooks,
    pickPlaybook,
    applyCornerPositions,
    pickCornerTarget,
    resolveWallSize,
    freekickShouldShoot,
    applyThrowInReceiverBias
} = require('../kernel/core/lib/set_piece_playbooks.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function fixedRng(values) {
    let i = 0;
    return () => {
        const v = values[i % values.length];
        i++;
        return v;
    };
}

function testLoadAndPick() {
    const data = loadSetPiecePlaybooks();
    assert.ok(data.corner && data.corner.near_post, 'corner playbooks loaded');
    assert.ok(data.freekick && data.freekick.wall_and_shoot, 'freekick playbooks loaded');
    assert.ok(data.throwin && data.throwin.quick_near, 'throwin playbooks loaded');
    assert.ok(data.goalkick && data.goalkick.long_clear, 'goalkick playbooks loaded');

    // Deterministic: r=0 → first entry by weight order (near_post is first with weight 30)
    const pb0 = pickPlaybook('corner', () => 0);
    assert.ok(pb0 && pb0.id, 'pick returns id');
    assert.strictEqual(pb0.type, 'corner');

    // High r near end of total weight
    const pb1 = pickPlaybook('corner', () => 0.99);
    assert.ok(pb1 && pb1.id);

    // All types pick something
    for (const t of ['corner', 'freekick', 'throwin', 'goalkick']) {
        const p = pickPlaybook(t, Math.random);
        assert.ok(p && p.def, `pick ${t}`);
    }
    log('PASS load + weighted pick');
}

function testResolveWallAndShoot() {
    const s = (v) => Utils.scaleFieldX(v);
    const autoClose = resolveWallSize({ def: { wallSize: 'auto' } }, s(20), s);
    assert.strictEqual(autoClose, 3, 'close freekick wall 3');
    const autoFar = resolveWallSize({ def: { wallSize: 'auto' } }, s(50), s);
    assert.strictEqual(autoFar, 2, 'far freekick wall 2');
    assert.strictEqual(resolveWallSize({ def: { wallSize: 0 } }, s(20), s), 0);
    assert.strictEqual(resolveWallSize({ def: { wallSize: 4 } }, s(20), s), 4);

    // prefer pass + low chance → rarely shoot
    let shoots = 0;
    const passPb = { def: { kick: { prefer: 'pass', shootChance: 0 } } };
    for (let i = 0; i < 20; i++) {
        if (freekickShouldShoot(passPb, true, s(20), s(37.5))) shoots++;
    }
    assert.strictEqual(shoots, 0, 'shootChance 0 never shoots');

    // prefer shoot + chance 1 → always when canShoot
    shoots = 0;
    const shootPb = { def: { kick: { prefer: 'shoot', shootChance: 1 } } };
    for (let i = 0; i < 10; i++) {
        if (freekickShouldShoot(shootPb, true, s(20), s(37.5))) shoots++;
    }
    assert.strictEqual(shoots, 10, 'shootChance 1 always shoots when ok');

    assert.strictEqual(
        freekickShouldShoot(shootPb, true, s(50), s(37.5)),
        false,
        'out of range never shoots'
    );
    log('PASS wall size + freekickShouldShoot');
}

function testCornerPositionsAndTarget() {
    const field = Utils.getFieldBounds();
    const attackers = [];
    const defenders = [];
    for (let i = 0; i < 6; i++) {
        attackers.push({ x: 0, y: 0, team: 'A', role: 'MF', isSentOff: false });
        defenders.push({ x: 0, y: 0, team: 'B', role: 'DF', isSentOff: false });
    }

    const nearPb = { id: 'near_post', def: loadSetPiecePlaybooks().corner.near_post };
    // Deterministic RNG for placement (avoid flaky random window samples)
    const realRandom = Math.random;
    let n = 0;
    Math.random = () => {
        n += 1;
        return (n * 0.17) % 1;
    };
    try {
        applyCornerPositions({}, nearPb, attackers, defenders, 'left', 0);
        // Most box attackers should sit toward top (near post when cornerY=0)
        const inBox = attackers.filter((p) => p.x > 0 && p.y < field.centerY);
        assert.ok(inBox.length >= 2, `near-post bias top half, got ${inBox.length}`);
        // Mean Y of placed attackers should be above center (near-post at top)
        const placed = attackers.filter((p) => p.x > 0);
        const meanY = placed.reduce((s, p) => s + p.y, 0) / placed.length;
        assert.ok(meanY < field.centerY, `near-post mean Y ${meanY} should be < center ${field.centerY}`);
    } finally {
        Math.random = realRandom;
    }

    const shortPb = { id: 'short_corner', def: loadSetPiecePlaybooks().corner.short_corner };
    const atk2 = attackers.map(() => ({ x: 0, y: 0, team: 'A', role: 'MF', isSentOff: false }));
    const def2 = defenders.map(() => ({ x: 0, y: 0, team: 'B', role: 'DF', isSentOff: false }));
    const res = applyCornerPositions({}, shortPb, atk2, def2, 'left', 0);
    assert.ok(res.shortAttacker, 'short option places short attacker');
    shortPb._shortAttacker = res.shortAttacker;

    const pool = atk2.filter((p) => p.x !== 0 || p.y !== 0);
    const t = pickCornerTarget(pool, shortPb, 'left', 0, field);
    assert.strictEqual(t, res.shortAttacker, 'short bias picks short attacker');
    log('PASS corner positions + target bias');
}

function testThrowInBias() {
    const field = Utils.getFieldBounds();
    const r1 = {
        setPieceTarget: { x: field.centerX, y: Utils.scaleFieldY(8) },
        team: 'A'
    };
    const sim = {
        throwInReceivers: [r1],
        throwInTaker: { team: 'A' },
        isSecondHalf: () => false
    };
    const linePb = { id: 'down_the_line', def: loadSetPiecePlaybooks().throwin.down_the_line };
    const beforeY = r1.setPieceTarget.y;
    applyThrowInReceiverBias(sim, linePb, field.centerX, Utils.scaleFieldY(2));
    assert.ok(r1.setPieceTarget.y <= beforeY + 0.01, 'line bias keeps receiver near top line');
    // Forward bias should push toward team A attack (right)
    assert.ok(r1.setPieceTarget.x >= field.centerX, 'forward bias toward opp goal');
    log('PASS throw-in receiver bias');
}

async function testSimulatorWiresPlaybook() {
    const sim = new Simulator({ seed: 55 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const field = Utils.getFieldBounds();
    sim.setupSetPiecePositions('corner', 'left', 'A', 0);
    assert.ok(sim.activePlaybook, 'setup corner sets activePlaybook');
    assert.strictEqual(sim.activePlaybook.type, 'corner');
    assert.ok(sim.activePlaybook.id, 'playbook has id');
    assert.ok(sim.ball.owner, 'corner has taker owner');

    // Resume consumes playbook and puts taker in Pass
    const taker = sim.ball.owner;
    resumeSetPieceToPlay(sim, 'corner');
    assert.strictEqual(sim.activePlaybook, null, 'resume clears playbook');
    assert.ok(taker.passTarget || taker.passType, 'corner resume sets pass');
    assert.ok(taker.fsm && taker.fsm.getNameOfCurrentState
        ? taker.fsm.getNameOfCurrentState() === 'Pass'
        : true);

    // Goalkick playbook
    sim.setupSetPiecePositions('goalkick', 'left', 'A');
    assert.ok(sim.activePlaybook && sim.activePlaybook.type === 'goalkick');
    const prefer = sim.activePlaybook.def.kick.passType;
    resumeSetPieceToPlay(sim, 'goalkick');
    assert.strictEqual(sim.ball.owner.passType, prefer, 'goalkick uses playbook passType');
    assert.strictEqual(sim.activePlaybook, null);

    // Freekick
    sim.setPieceX = field.width * 0.75;
    sim.setPieceY = field.centerY;
    sim.setPieceSide = 'right';
    sim.setupSetPiecePositions('freekick', 'right', 'A');
    assert.ok(sim.activePlaybook && sim.activePlaybook.type === 'freekick');
    log('PASS simulator setup/resume wires playbooks');
}

async function main() {
    testLoadAndPick();
    testResolveWallAndShoot();
    testCornerPositionsAndTarget();
    testThrowInBias();
    await testSimulatorWiresPlaybook();
    log('set_piece_playbooks: ALL PASS');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
