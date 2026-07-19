#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Pitch } = require('../kernel/core/entities/pitch.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');

const SCRATCH = '/tmp/grok-goal-1dd7dd643775/implementer';
fs.mkdirSync(SCRATCH, { recursive: true });

const logs = [];
const origLog = console.log;
console.log = (...args) => {
    logs.push(args.join(' '));
    if (process.env.VERBOSE) origLog(...args);
};

Settings.camera.scale = Settings.BASE_SCALE;
Settings.camera.offsetX = 40;
Settings.camera.offsetY = 80;

function verifyScreenOverlayBounds() {
    Settings.app = { camX: 180, camY: -95, canvas: { width: 720, height: 528 } };
    const sim = new Simulator();
    const b = sim.getScreenOverlayBounds();
    assert.strictEqual(b.x, -180);
    assert.strictEqual(b.y, 95);
    assert.strictEqual(b.width, 720);
    assert.strictEqual(b.height, 528);
    assert.strictEqual(b.centerX, -180 + 360);
    assert.strictEqual(b.centerY, 95 + 264);

    Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };
    const staticBounds = sim.getScreenOverlayBounds();
    assert.ok(staticBounds.x === 0 && staticBounds.y === 0);
    console.log('screen overlay bounds track camX/camY for full canvas cover');
}

function verifyCameraOffsets() {
    Settings.camera.type = 'centered';
    Settings.camera.offsetX = 40;
    Settings.camera.offsetY = 80;
    const centered = Utils.getCameraOffsets();
    assert.strictEqual(centered.offsetX, 0);
    assert.strictEqual(centered.offsetY, 0);
    const centeredScreen = Utils.toScreen(0, 0);
    assert.strictEqual(centeredScreen.x, 0);
    assert.strictEqual(centeredScreen.y, 0);

    Settings.camera.type = 'static';
    const staticOff = Utils.getCameraOffsets();
    assert.strictEqual(staticOff.offsetX, 40);
    assert.strictEqual(staticOff.offsetY, 80);
    const staticScreen = Utils.toScreen(0, 0);
    assert.strictEqual(staticScreen.x, 40);
    assert.strictEqual(staticScreen.y, 80);
    console.log('camera offsets: centered uses 0,0 static uses saved offsetX/offsetY');
    Settings.camera.type = 'centered';
}

function verifyToScreenModes() {
    const scale = Settings.BASE_SCALE;
    const { shear } = Utils.getOrthoScales(scale);

    Settings.projectionMode = 'orthographic';
    const o00 = Utils.toScreen(4, 0);
    const o45 = Utils.toScreen(4, 5);
    const oBase = Utils.toScreen(0, 0);
    const oLx = Utils.toScreen(4, 0);
    const oLy = Utils.toScreen(0, 5);
    assert.notStrictEqual(o45.x, o00.x, 'orthographic: sx varies with ly at fixed lx');
    assert.strictEqual(o45.x - o00.x, 5 * shear, 'orthographic: shear delta matches manifest ratio');
    assert.strictEqual(oLx.x - oBase.x, 4 * scale, 'orthographic: lx maps to horizontal span');
    assert.strictEqual(oLy.x - oBase.x, 5 * shear, 'orthographic: ly shears sx');
    console.log(`orthographic: toScreen(4,0)=(${o00.x},${o00.y}) toScreen(4,5)=(${o45.x},${o45.y}) shearDelta=${o45.x - o00.x}`);

    Settings.projectionMode = 'topdown';
    const t00 = Utils.toScreen(4, 0);
    const t45 = Utils.toScreen(4, 5);
    assert.strictEqual(t45.x, t00.x, 'topdown: sx constant for fixed lx');
    assert.ok(t45.y > t00.y, 'topdown: sy increases with ly');
    console.log(`topdown: toScreen(4,0)=(${t00.x},${t00.y}) toScreen(4,5)=(${t45.x},${t45.y}) sxConstant=true`);

    Settings.projectionMode = 'isometric';
    const i00 = Utils.toScreen(4, 0);
    const i45 = Utils.toScreen(4, 5);
    assert.notStrictEqual(i45.x, i00.x, 'isometric: sx varies with ly');
    assert.notStrictEqual(i45.y, i00.y, 'isometric: sy varies with ly');
    console.log(`isometric: toScreen(4,0)=(${i00.x},${i00.y}) toScreen(4,5)=(${i45.x},${i45.y})`);
}

function verifyWorldDeltaInverse() {
    const scale = Settings.BASE_SCALE;
    const { scaleX, scaleY, shear } = Utils.getOrthoScales(scale);

    Settings.projectionMode = 'orthographic';
    const world = Utils.worldDeltaFromScreenDelta(shear + scaleX, scaleY);
    assert.ok(Math.abs(world.ox - 1) < 0.001, 'orthographic worldDelta ox');
    assert.ok(Math.abs(world.oy - 1) < 0.001, 'orthographic worldDelta oy');

    Settings.projectionMode = 'topdown';
    const top = Utils.worldDeltaFromScreenDelta(scaleX, scaleY);
    assert.ok(Math.abs(top.ox - 1) < 0.001, 'topdown worldDelta ox');
    assert.ok(Math.abs(top.oy - 1) < 0.001, 'topdown worldDelta oy');
    console.log('worldDeltaFromScreenDelta inverse OK for orthographic and topdown');
}

function verifyPitchTurfGeometry() {
    const paths = [];
    const fills = [];
    const rects = [];
    const ctx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        fillRect(x, y, w, h) { rects.push({ x, y, w, h }); },
        beginPath() { paths.push({ moves: [], lines: [] }); },
        moveTo(x, y) { paths[paths.length - 1].moves.push({ x, y }); },
        lineTo(x, y) { paths[paths.length - 1].lines.push({ x, y }); },
        closePath() {},
        fill() { fills.push(paths[paths.length - 1]); },
        arc() {},
        stroke() {}
    };

    Settings.projectionMode = 'topdown';
    const pitchTop = new Pitch();
    pitchTop.render(ctx);
    const turfRects = rects.filter(r => r.x >= Settings.camera.offsetX);
    assert.ok(turfRects.length > 0, 'topdown pitch emits fillRect turf stripes');
    const topRect = turfRects[0];
    assert.ok(topRect.w > 0 && topRect.h > 0, 'topdown turf stripe is axis-aligned rect');
    console.log(`pitch turf topdown: fillRect x=${topRect.x} w=${topRect.w} h=${topRect.h}`);

    fills.length = 0;
    paths.length = 0;

    Settings.projectionMode = 'orthographic';
    const pitchOrtho = new Pitch();
    pitchOrtho.render(ctx);
    const orthoStripe = fills[0];
    assert.ok(orthoStripe, 'orthographic pitch emits turf fill');
    const orthoXs = [...orthoStripe.moves, ...orthoStripe.lines].map(p => p.x);
    assert.ok(new Set(orthoXs).size > 1, 'orthographic turf uses slanted parallelogram corners');
    console.log(`pitch turf orthographic: uniqueX=${new Set(orthoXs).size} corners=${orthoXs.length}`);
}

function verifyPenaltyArcs() {
    const strokes = [];
    const ctx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        fillRect() {},
        beginPath() { strokes.push({ moves: [], lines: [] }); },
        moveTo(x, y) { strokes[strokes.length - 1].moves.push({ x, y }); },
        lineTo(x, y) { strokes[strokes.length - 1].lines.push({ x, y }); },
        closePath() {},
        fill() {},
        arc() {},
        stroke() {}
    };

    Settings.projectionMode = 'orthographic';
    const pitch = new Pitch();
    pitch.render(ctx);

    const arcStrokes = strokes.filter(s => s.lines.length >= 8);
    assert.ok(arcStrokes.length >= 3, 'pitch draws sampled arcs (center circle + penalty arcs)');
    console.log(`penalty arcs: sampled stroke paths=${arcStrokes.length}`);
}

try {
    verifyScreenOverlayBounds();
    verifyCameraOffsets();
    verifyToScreenModes();
    verifyWorldDeltaInverse();
    verifyPitchTurfGeometry();
    verifyPenaltyArcs();
    fs.writeFileSync(path.join(SCRATCH, 'projection_verify.log'), logs.join('\n') + '\n');
    console.log('\nProjection verification passed');
} catch (err) {
    fs.writeFileSync(path.join(SCRATCH, 'projection_verify.log'), logs.join('\n') + '\n' + String(err) + '\n');
    console.error(err);
    process.exit(1);
}