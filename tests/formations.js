#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
require('./mock_env.js');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');

const { SCRATCH } = require('./scratch_dir.js');
const FORMATIONS_PATH = path.join(__dirname, '../presets/formations.json');
const MIN_FORMATIONS = 6;

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



async function validateFormation(sim, formationName) {
    sim.players = [];
    sim.formationAName = formationName;
    sim.formationBName = formationName;
    sim.teamAName = 'Brazil';
    sim.teamBName = 'Argentina';
    sim.setupTeam('A', sim.teamAName, formationName);
    sim.setupTeam('B', sim.teamBName, formationName);

    const field = Utils.getFieldBounds();
    const margin = 0.25 * field.multiplier;

    for (const teamKey of ['A', 'B']) {
        const teamPlayers = sim.players.filter(p => p.team === teamKey);
        assert.strictEqual(teamPlayers.length, 11, `${formationName} team ${teamKey} has 11 players`);
        const gkCount = teamPlayers.filter(p => p.role === 'GK').length;
        assert.strictEqual(gkCount, 1, `${formationName} team ${teamKey} has one GK`);

        for (const p of teamPlayers) {
            assert.ok(p.baseX >= margin && p.baseX <= field.width - margin,
                `${formationName} ${p.name} baseX in bounds (${p.baseX})`);
            assert.ok(p.baseY >= margin && p.baseY <= field.height - margin,
                `${formationName} ${p.name} baseY in bounds (${p.baseY})`);
        }
    }
}

async function main() {
    fs.mkdirSync(SCRATCH, { recursive: true });

    const formations = JSON.parse(fs.readFileSync(FORMATIONS_PATH, 'utf8'));
    const keys = Object.keys(formations);
    assert.ok(keys.length >= MIN_FORMATIONS, `expected at least ${MIN_FORMATIONS} formations, got ${keys.length}`);
    log(`PASS formations.json exposes ${keys.length} formations`);

    const sim = new Simulator();
    await sim.start();

    for (const formationName of keys) {
        const slots = formations[formationName];
        assert.strictEqual(slots.length, 11, `${formationName} defines 11 slots`);
        await validateFormation(sim, formationName);
        log(`PASS formation ${formationName} spawns in-bounds teams`);
    }

    assert.throws(
        () => sim.setupTeam('A', 'Brazil', 'not-a-real-formation'),
        /Unknown or invalid formation/,
        'invalid formationName throws instead of silent 4-4-2 fallback'
    );
    log('PASS unknown formation rejects without silent fallback');

    // Dynamic Formation Change verification
    sim.players = [];
    sim.formationAName = '4-4-2';
    sim.setupTeam('A', 'Brazil', '4-4-2');
    const testPlayer = sim.players[5];
    const originalX = testPlayer.baseX;
    
    // Change to 3-5-2
    sim.changeFormation('A', '3-5-2');
    assert.notStrictEqual(testPlayer.baseX, originalX, 'outfield player baseX should change under new formation');
    log('PASS dynamic changeFormation updates player base coordinates');

    // Field multiplier bounds change recalculation verification
    Settings.FIELD_SIZE_MULTIPLIER = 2.0;
    const oldBaseX = testPlayer.baseX;
    sim.recalculateReferencePositions();
    assert.strictEqual(testPlayer.baseX, oldBaseX * 2, 'baseX should double when FIELD_SIZE_MULTIPLIER doubles');
    
    Settings.FIELD_SIZE_MULTIPLIER = 1.0;
    sim.recalculateReferencePositions();
    assert.strictEqual(testPlayer.baseX, oldBaseX, 'baseX should restore when FIELD_SIZE_MULTIPLIER resets');
    log('PASS recalculateReferencePositions handles field multiplier updates');

    // Caching check
    Utils.scaleFieldX(10);
    assert.strictEqual(Utils._scaleXCache[10] !== undefined, true, 'scaleXCache should have cached scaled values');
    log('PASS scaleField caching works');

    fs.writeFileSync(path.join(SCRATCH, 'formations_test.log'), keys.join('\n') + '\n');
    log(`\nAll formation checks passed (${keys.length} formations).`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});