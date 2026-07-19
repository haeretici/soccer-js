#!/usr/bin/env node
require('./mock_env.js');

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const { SCRATCH } = require('./scratch_dir.js');
const logs = [];
const origLog = console.log;
console.log = (...args) => {
    logs.push(args.join(' '));
    if (process.env.VERBOSE) origLog(...args);
};

const { Settings } = require('../kernel/settings.js');
const spriteManifest = require('../kernel/core/lib/sprite_manifest.js');

const PALETTES = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'presets', 'palettes.json'), 'utf8')
);

const SAMPLE_PRIMARY_X = Math.round(spriteManifest.SPRITE_TILE_W * 32 / 64);
const SAMPLE_PRIMARY_Y = Math.round(spriteManifest.SPRITE_TILE_H * 32 / 64);

const bundlePath = path.join(__dirname, '..', 'build', 'app.bundle.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');

let sandbox = null;
assertNoThrow('bundle eval', () => {
    sandbox = {
        window: null,
        document: global.document,
        performance: global.performance,
        localStorage: { getItem: () => null, setItem: () => {} },
        console,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (fn) => setTimeout(fn, 16),
        cancelAnimationFrame: clearTimeout,
        AudioContext: global.AudioContext,
        webkitAudioContext: global.webkitAudioContext,
        fetch: global.fetch,
        Image: global.Image,
        DecompressionStream: global.DecompressionStream,
        navigator: { userAgent: 'node' },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.Image = global.Image;
    vm.runInNewContext(bundle, sandbox, { filename: 'app.bundle.js', timeout: 5000 });
});



assertNoThrow('sandbox DOMContentLoaded', () => {
    global.document._fireDOMContentLoaded();
});

const exp = sandbox.__SOCCER_TEST_EXPORTS__;
assert.ok(exp, 'sandbox.__SOCCER_TEST_EXPORTS__ must exist after bundle eval');
assert.ok(exp.PlayerStates && exp.Simulator && exp.StateMachine, 'bundle exports core modules');
assert.ok(exp.PlayerStates.ChaseBall && exp.PlayerStates.Goalkeeper && exp.PlayerStates.Pass, 'PlayerStates from bundle');
assert.ok(exp.MatchStates && exp.MatchStates.Kickoff && exp.MatchStates.Play && exp.MatchStates.Goal, 'MatchStates singletons exported from bundle');
assert.strictEqual(typeof exp.MatchStates.Kickoff.name, 'string', 'MatchStates.Kickoff has name');
console.log('PASS bundle MatchStates exported and shaped correctly');
assert.strictEqual(typeof exp.Simulator.prototype.getActiveChasers, 'function', 'Simulator.getActiveChasers from bundle');
assert.strictEqual(typeof exp.Simulator.prototype.shouldPreserveAIState, 'function', 'Simulator.shouldPreserveAIState from bundle');
assert.strictEqual(typeof exp.isGkProtected, 'function', 'isGkProtected from bundle');
assert.strictEqual(typeof exp.grantGkPossession, 'function', 'grantGkPossession from bundle');
assert.ok(exp.ImageDB && exp.SpriteGenerator, 'bundle exports ImageDB and SpriteGenerator');
console.log('PASS sandbox.__SOCCER_TEST_EXPORTS__ has PlayerStates and Simulator');

const sm = new exp.StateMachine({});
sm.setCurrentState(exp.PlayerStates.Idle);
assert.ok(sm.isInState(exp.PlayerStates.Idle));
assert.ok(!sm.isInState(exp.PlayerStates.ChaseBall));
assert.strictEqual(sm.getNameOfCurrentState(), 'Idle');
console.log('PASS bundle StateMachine isInState reference equality');

const sm2 = new exp.StateMachine({});
sm2.setCurrentState(exp.MatchStates.Kickoff);
assert.ok(sm2.isInState(exp.MatchStates.Kickoff));
assert.ok(!sm2.isInState(exp.MatchStates.Play));
assert.strictEqual(sm2.getNameOfCurrentState(), 'kickoff');
console.log('PASS bundle MatchStates singleton ref equality + getName');

const gkStub = { role: 'GK', gkClaimTimer: 0, gkHoldTimer: 0.5 };
assert.ok(exp.isGkProtected(gkStub), 'bundle isGkProtected respects hold timer');
gkStub.gkHoldTimer = 0;
gkStub.gkClaimTimer = 0.3;
assert.ok(exp.isGkProtected(gkStub), 'bundle isGkProtected respects claim timer');
console.log('PASS bundle isGkProtected helper works');

(async () => {
    const sim = new exp.Simulator();
    await sim.start();
    assert.strictEqual(sim.teamAName, 'Brazil', 'bundle sim team A');
    assert.strictEqual(sim.teamBName, 'Argentina', 'bundle sim team B');
    const brazilSheet = exp.ImageDB.get('player_Brazil_main');
    assert.ok(brazilSheet && brazilSheet.width === spriteManifest.SHEET_W, 'bundle sim registered Brazil PNG sheet');
    const argSheet = exp.ImageDB.get('player_Argentina_main');
    assert.ok(argSheet && argSheet.width === spriteManifest.SHEET_W, 'bundle sim registered Argentina PNG sheet');
    const brazilPrimary = PALETTES.Brazil.main.primary;
    const px = brazilSheet.getContext('2d').getImageData(SAMPLE_PRIMARY_X, SAMPLE_PRIMARY_Y, 1, 1).data;
    const expected = exp.SpriteGenerator.hexToRgb(brazilPrimary);
    assert.ok(px[0] === expected[0] && px[1] === expected[1] && px[2] === expected[2],
        `bundle Brazil sheet recolored from PNG (expected primary ${brazilPrimary})`);
    console.log('PASS bundle registerPlayerSheetsFromPng via Simulator.start');

    sim.resetToKickoff();
    const holder = sim.ball.owner;
    assert.ok(holder, 'bundle kickoff assigns ball owner');
    const renderCalls = [];
    const renderCtx = {
        fillStyle: '',
        font: '',
        shadowColor: '',
        shadowBlur: 0,
        textAlign: '',
        beginPath() {},
        ellipse() {},
        fill() {},
        fillText() {},
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
            renderCalls.push({ type: 'drawImage', img, sx, sy, sw, sh, dx, dy, dw, dh });
        }
    };
    holder.render(renderCtx);
    const teamName = holder.team === 'A' ? sim.teamAName : sim.teamBName;
    const role = holder.role === 'GK' ? 'gk' : 'main';
    const jerseyKey = `player_${teamName}_jersey_${holder.jersey}`;
    const fallbackKey = `player_${teamName}_${role}`;
    const sheetKey = exp.ImageDB.images[jerseyKey] ? jerseyKey : fallbackKey;
    const holderSheet = exp.ImageDB.get(sheetKey);
    const draw = renderCalls.find(c => c.type === 'drawImage');
    assert.ok(draw, 'bundle player.render emitted drawImage');
    assert.strictEqual(draw.img, holderSheet, `bundle drawImage uses recolored ${teamName} sheet`);
    assert.strictEqual(draw.sw, spriteManifest.SPRITE_TILE_W, 'bundle drawImage source width');
    assert.strictEqual(draw.sh, spriteManifest.SPRITE_TILE_H, 'bundle drawImage source height');
    assert.strictEqual(draw.dw, spriteManifest.SPRITE_TILE_W, 'bundle drawImage dest width at base scale');
    assert.strictEqual(draw.dh, spriteManifest.SPRITE_TILE_H, 'bundle drawImage dest height at base scale');
    console.log(
        `PASS bundle player.render drawImage key=${sheetKey} sw=${draw.sw} sh=${draw.sh} ` +
        `dw=${draw.dw} dh=${draw.dh} sheetMatch=${draw.img === holderSheet}`
    );

    const simSrc = fs.readFileSync(path.join(__dirname, '..', 'kernel/providers/simulator/simulator.js'), 'utf8');
    assert.ok(simSrc.includes('registerPlayerSheetsFromPng'), 'simulator uses registerPlayerSheetsFromPng');
    assert.ok(!simSrc.includes('SpriteGenerator.generateAll'), 'simulator no longer calls SpriteGenerator.generateAll');

    const playerSrc = fs.readFileSync(path.join(__dirname, '..', 'kernel/core/entities/player.js'), 'utf8');
    const evidenceSnippets = ['isGkProtected', 'grantGkPossession', 'canTackleOwner', 'computeTackleType', 'getActiveChasers'];
    for (const snippet of evidenceSnippets) {
        if (!playerSrc.includes(snippet) && !simSrc.includes(snippet)) {
            throw new Error(`Missing source evidence snippet: ${snippet}`);
        }
    }
    console.log('PASS source text evidence scan');

    console.log('PASS bundle loads without throw');
    console.log(`PASS bundle size: ${bundle.length} bytes`);

    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, 'bundle_check.log'), logs.join('\n'));
})().catch((err) => {
    console.error('FAIL bundle sprite registration:', err.message);
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, 'bundle_check.log'), logs.join('\n') + '\n' + err.stack);
    process.exit(1);
});

function assertNoThrow(label, fn) {
    try {
        fn();
        console.log(`PASS ${label}`);
    } catch (e) {
        console.error(`FAIL ${label}:`, e.message);
        process.exit(1);
    }
}
