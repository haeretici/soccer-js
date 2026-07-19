#!/usr/bin/env node
require('./mock_env.js');

const fs = require('fs');
const assert = require('assert');
const path = require('path');
const { Time } = require('../kernel/core/lib/time.js');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { PlayerStates } = require('../kernel/core/entities/player.js');
const { computeCarryOffset } = require('../kernel/core/entities/ball.js');
const { ImageDB } = require('../kernel/core/lib/imagedb.js');
const { SpriteGenerator } = require('../kernel/core/lib/sprite_generator.js');
const spriteManifest = require('../kernel/core/lib/sprite_manifest.js');

const SCRATCH = '/tmp/grok-goal-58367a54abda/implementer';
fs.mkdirSync(SCRATCH, { recursive: true });

const PALETTES = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'presets', 'palettes.json'), 'utf8')
);

const SAMPLE_PRIMARY_X = Math.round(spriteManifest.SPRITE_TILE_W * 32 / 64);
const SAMPLE_PRIMARY_Y = Math.round(spriteManifest.SPRITE_TILE_H * 32 / 64);

const logs = [];
const origLog = console.log;
const origError = console.error;
console.log = (...args) => { logs.push(args.join(' ')); if (process.env.VERBOSE) origLog(...args); };
console.error = (...args) => { logs.push(args.join(' ')); origError(...args); };

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };

function makeRecordingContext() {
    const calls = [];
    const ctx = {
        imageSmoothingEnabled: true,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        shadowBlur: 0,
        font: '',
        textAlign: '',
        save() { calls.push({ type: 'save' }); },
        restore() { calls.push({ type: 'restore' }); },
        clip() { calls.push({ type: 'clip' }); },
        fillRect(x, y, w, h) { calls.push({ type: 'fillRect', x, y, w, h }); },
        beginPath() { calls.push({ type: 'beginPath' }); },
        ellipse(x, y, rx, ry) { calls.push({ type: 'ellipse', x, y, rx, ry }); },
        arc(x, y, r) { calls.push({ type: 'arc', x, y, r }); },
        fill() { calls.push({ type: 'fill' }); },
        stroke() { calls.push({ type: 'stroke' }); },
        drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
            calls.push({ type: 'drawImage', img, sw, sh, sx, sy, dx, dy, dw, dh });
        },
        fillText(text, x, y) { calls.push({ type: 'fillText', text, x, y }); }
    };
    return { ctx, calls };
}

function teamNameForHolder(sim, holder) {
    return holder.team === 'A' ? sim.teamAName : sim.teamBName;
}

function assertRecoloredSheetRegistered(teamName, role, label) {
    const key = `player_${teamName}_${role}`;
    const sheet = ImageDB.images[key];
    assert.ok(sheet, `${label}: ImageDB has ${key}`);
    assert.strictEqual(sheet.width, spriteManifest.SHEET_W, `${label}: sheet width from manifest`);
    assert.strictEqual(sheet.height, spriteManifest.SHEET_H, `${label}: sheet height from manifest`);
    assert.ok(typeof sheet.getContext === 'function', `${label}: sheet is canvas`);
    return sheet;
}

function assertSheetHasTeamPrimary(sheet, teamName, label) {
    const kit = PALETTES[teamName].main;
    const expected = SpriteGenerator.hexToRgb(kit.primary);
    const px = sheet.getContext('2d').getImageData(SAMPLE_PRIMARY_X, SAMPLE_PRIMARY_Y, 1, 1).data;
    assert.ok(
        px[0] === expected[0] && px[1] === expected[1] && px[2] === expected[2],
        `${label}: sheet pixel matches ${teamName} primary ${kit.primary} got rgb(${px[0]},${px[1]},${px[2]})`
    );
    assert.ok(
        !(px[0] === 224 && px[1] === 0 && px[2] === 0),
        `${label}: placeholder primary red replaced on ${teamName} sheet`
    );
}

function assertPlayerDrawUsesRecoloredSheet(sim, holder, calls, label) {
    const teamName = teamNameForHolder(sim, holder);
    const role = holder.role === 'GK' ? 'gk' : 'main';
    const jerseyKey = `player_${teamName}_jersey_${holder.jersey}`;
    const fallbackKey = `player_${teamName}_${role}`;
    const key = ImageDB.images[jerseyKey] ? jerseyKey : fallbackKey;
    
    const sheet = ImageDB.images[key];
    assert.ok(sheet, `${label}: ImageDB has key ${key}`);
    assert.strictEqual(sheet.width, spriteManifest.SHEET_W, `${label}: sheet width from manifest`);
    assert.strictEqual(sheet.height, spriteManifest.SHEET_H, `${label}: sheet height from manifest`);
    assert.ok(typeof sheet.getContext === 'function', `${label}: sheet is canvas`);
    
    assertSheetHasTeamPrimary(sheet, teamName, `${label}-pixels`);

    const drawImage = calls.find(c => c.type === 'drawImage');
    assert.ok(drawImage, `${label}: player drawImage recorded`);
    assert.strictEqual(drawImage.img, sheet, `${label}: drawImage source is registered recolored canvas`);
    assert.strictEqual(drawImage.sw, spriteManifest.SPRITE_TILE_W, `${label}: source tile width`);
    assert.strictEqual(drawImage.sh, spriteManifest.SPRITE_TILE_H, `${label}: source tile height`);
    assert.strictEqual(drawImage.dw, spriteManifest.SPRITE_TILE_W, `${label}: dest tile width at base scale`);
    assert.strictEqual(drawImage.dh, spriteManifest.SPRITE_TILE_H, `${label}: dest tile height at base scale`);

    const primary = PALETTES[teamName][role === 'gk' ? 'gk' : 'main'].primary;
    const px = sheet.getContext('2d').getImageData(SAMPLE_PRIMARY_X, SAMPLE_PRIMARY_Y, 1, 1).data;
    console.log(
        `${label}: player.render drawImage key=${key} sheetMatch=true ` +
        `sw=${drawImage.sw} sh=${drawImage.sh} dw=${drawImage.dw} dh=${drawImage.dh} ` +
        `primary=${primary} pixel=rgb(${px[0]},${px[1]},${px[2]})`
    );
}

function assertBallDrawAtBaseScale(calls, label) {
    const arc = calls.find(c => c.type === 'arc');
    assert.ok(arc, `${label}: ball arc recorded`);
    assert.strictEqual(arc.r, Settings.BALL_DRAW_RADIUS, `${label}: ball radius at base scale`);
}

function assertPlayerDrawScaled(calls, multiplier, label) {
    const drawImage = calls.find(c => c.type === 'drawImage');
    assert.strictEqual(drawImage.dw, spriteManifest.SPRITE_TILE_W * multiplier, `${label}: scaled sprite width`);
    assert.strictEqual(drawImage.dh, spriteManifest.SPRITE_TILE_H * multiplier, `${label}: scaled sprite height`);
}

function assertBallDrawScaled(calls, multiplier, label) {
    const arc = calls.find(c => c.type === 'arc');
    assert.strictEqual(arc.r, Settings.BALL_DRAW_RADIUS * multiplier, `${label}: scaled ball radius`);
}

function assertScreenFeetAlignment(holder, ball, label, tolerancePx = 1.5) {
    const m = Utils.getScaleMultiplier();
    const feet = Utils.getPlayerFeetScreen(holder);
    const ground = Utils.toScreen(holder.x, holder.y, 0);
    const ballScreen = Utils.toScreen(ball.x, ball.y, 0);
    const carry = Utils.getCarryScreenOffset(holder.orientation);
    const ballRadius = Settings.BALL_DRAW_RADIUS * m;
    const tol = tolerancePx * m;

    assert.ok(
        Math.abs(ballScreen.x - (ground.x + carry.dx)) <= tol,
        `${label}: ball X offset from ground (${ballScreen.x} vs ${ground.x + carry.dx})`
    );
    const baseCarry = Utils.BASE_CARRY_SCREEN_OFFSETS[holder.orientation] || { dx: 0, dy: 0 };
    const expectedDistance = (Settings.SPRITE_FEET_SCREEN_PX - (baseCarry.dy + Settings.BALL_DRAW_RADIUS)) * m;
    assert.ok(
        Math.abs(feet.y - (ballScreen.y + ballRadius) - expectedDistance) <= tol,
        `${label}: ball bottom at expected feet offset (actual diff: ${feet.y - (ballScreen.y + ballRadius)}, expected: ${expectedDistance})`
    );
}

function assertRenderedFeetAlignment(playerCalls, ballCalls, orientation, label, tolerancePx = 1.5) {
    const m = Utils.getScaleMultiplier();
    const drawImage = playerCalls.find(c => c.type === 'drawImage');
    const arc = ballCalls.find(c => c.type === 'arc');
    const carry = Utils.getCarryScreenOffset(orientation);
    const tol = tolerancePx * m;

    assert.ok(drawImage, `${label}: player drawImage`);
    assert.ok(arc, `${label}: ball arc`);

    const spriteCenterX = drawImage.dx + drawImage.dw / 2;
    const spriteFeetY = drawImage.dy + drawImage.dh;
    const ballBottomY = arc.y + arc.r;

    assert.ok(
        Math.abs(arc.x - (spriteCenterX + carry.dx)) <= tol,
        `${label}: rendered ball X vs sprite feet column (${arc.x} vs ${spriteCenterX + carry.dx})`
    );
    const baseCarry = Utils.BASE_CARRY_SCREEN_OFFSETS[orientation] || { dx: 0, dy: 0 };
    const expectedDistance = (Settings.SPRITE_FEET_SCREEN_PX - (baseCarry.dy + Settings.BALL_DRAW_RADIUS)) * m;
    assert.ok(
        Math.abs(spriteFeetY - ballBottomY - expectedDistance) <= tol,
        `${label}: rendered ball bottom at expected sprite feet offset (actual diff: ${spriteFeetY - ballBottomY}, expected: ${expectedDistance})`
    );
}

/**
 * Leave kickoff dead-ball bookkeeping so possession uses normal carry-offset sync.
 * (setPieceType 'kickoff' + _kickoffPins pins the ball on the center mark.)
 */
function enterOpenPlayPossession(sim, holder) {
    sim.fsm.setCurrentState(MatchStates.Play);
    sim.setPieceType = '';
    sim._kickoffPins = null;
    if (holder) {
        holder.fsm.changeState(PlayerStates.Dribble);
        sim.ball.owner = holder;
        sim.ball.syncToOwner();
    }
}

async function assertNoCarryLag(sim, label) {
    const holder = sim.ball.owner;
    assert.ok(holder, `${label}: kickoff holder present`);

    enterOpenPlayPossession(sim, holder);
    const startX = holder.x;
    Time.deltaTime = 0.05;
    holder.dribbleTarget = { x: startX + 3.0, y: holder.y };
    await sim.updateAll();

    assert.ok(holder.x !== startX, `${label}: player moved during updateAll`);

    const { ox, oy } = computeCarryOffset(holder.orientation);
    assert.ok(
        Math.abs(sim.ball.x - (holder.x + ox)) < 0.001,
        `${label}: ball synced to owner after updateAll (${sim.ball.x} vs ${holder.x + ox})`
    );
    assert.ok(
        Math.abs(sim.ball.y - (holder.y + oy)) < 0.001,
        `${label}: ball Y synced after updateAll`
    );
}

async function runScaleLaunch(runId) {
    console.log(`\n=== Scale Launch ${runId} ===`);

    Settings.camera.scale = Settings.BASE_SCALE;
    Settings.projectionMode = 'orthographic';
    Settings.FIELD_SIZE_MULTIPLIER = 1;
    assert.strictEqual(Utils.getScaleMultiplier(), 1, 'base multiplier is 1');

    const sim = new Simulator();
    await sim.start();

    assert.strictEqual(sim.teamAName, 'Brazil', `run${runId}: team A from config`);
    assert.strictEqual(sim.teamBName, 'Argentina', `run${runId}: team B from config`);

    sim.resetToKickoff();

    assert.ok(sim.ball.owner, 'kickoff assigns ball owner');
    const holder = sim.ball.owner;
    const field = Utils.getFieldBounds();
    // Taker stands slightly on own half; ball stays on the center mark (pinKickoffSpots).
    const secondHalf = typeof sim.isSecondHalf === 'function' && sim.isSecondHalf();
    const kickOffLeft = secondHalf ? (sim.kickoffTeam === 'B') : (sim.kickoffTeam === 'A');
    const expectedTakerX = field.centerX + (kickOffLeft ? -Utils.scaleFieldX(0.55) : Utils.scaleFieldX(0.55));
    assert.ok(
        Math.abs(holder.x - expectedTakerX) < 0.001,
        `run${runId}: kickoff striker slightly on own half (got ${holder.x}, expected ${expectedTakerX})`
    );
    assert.ok(
        Math.abs(sim.ball.x - field.centerX) < 0.001 && Math.abs(sim.ball.y - field.centerY) < 0.001,
        `run${runId}: kickoff ball on center mark`
    );

    // Carry-offset + sprite feet alignment apply in open play (not kickoff center pin).
    enterOpenPlayPossession(sim, holder);
    const { ox, oy } = computeCarryOffset(holder.orientation);
    assert.ok(Math.abs(sim.ball.x - (holder.x + ox)) < 0.001, 'ball x synced to carry offset');
    assert.ok(Math.abs(sim.ball.y - (holder.y + oy)) < 0.001, 'ball y synced to carry offset');

    assertScreenFeetAlignment(holder, sim.ball, `run${runId}-logical-base`);

    const playerRec = makeRecordingContext();
    holder.render(playerRec.ctx);
    assertPlayerDrawUsesRecoloredSheet(sim, holder, playerRec.calls, `run${runId}-base-player`);

    const ballRec = makeRecordingContext();
    sim.ball.render(ballRec.ctx);
    assertBallDrawAtBaseScale(ballRec.calls, `run${runId}-base-ball`);
    assertRenderedFeetAlignment(playerRec.calls, ballRec.calls, holder.orientation, `run${runId}-render-base`);

    await assertNoCarryLag(sim, `run${runId}-lag`);
    sim.resetToKickoff();
    // Re-acquire holder after reset and use open-play carry for scaled feet checks.
    const holder2 = sim.ball.owner;
    assert.ok(holder2, `run${runId}: kickoff holder after reset`);
    enterOpenPlayPossession(sim, holder2);

    Settings.camera.scale = 40;
    assert.strictEqual(Utils.getScaleMultiplier(), 2, 'doubled scale multiplier');

    assertScreenFeetAlignment(holder2, sim.ball, `run${runId}-logical-scaled`, 1.5);

    const playerScaled = makeRecordingContext();
    holder2.render(playerScaled.ctx);
    assertPlayerDrawScaled(playerScaled.calls, 2, `run${runId}-scaled-player`);
    const teamName = teamNameForHolder(sim, holder2);
    const role = holder2.role === 'GK' ? 'gk' : 'main';
    const jerseyKey = `player_${teamName}_jersey_${holder2.jersey}`;
    const fallbackKey = `player_${teamName}_${role}`;
    const expectedKey = ImageDB.images[jerseyKey] ? jerseyKey : fallbackKey;

    assert.strictEqual(
        playerScaled.calls.find(c => c.type === 'drawImage').img,
        ImageDB.images[expectedKey],
        `run${runId}-scaled-player uses same recolored sheet`
    );

    const ballScaled = makeRecordingContext();
    sim.ball.render(ballScaled.ctx);
    assertBallDrawScaled(ballScaled.calls, 2, `run${runId}-scaled-ball`);
    assertRenderedFeetAlignment(playerScaled.calls, ballScaled.calls, holder2.orientation, `run${runId}-render-scaled`, 1.5);

    Settings.camera.scale = Settings.BASE_SCALE;
    console.log(`Scale launch ${runId} OK`);
}

(async () => {
    try {
        assert.strictEqual(Settings.SPRITE_TILE_W, spriteManifest.SPRITE_TILE_W);
        assert.strictEqual(Settings.SPRITE_TILE_H, spriteManifest.SPRITE_TILE_H);
        assert.strictEqual(Settings.SPRITE_FEET_SCREEN_PX, spriteManifest.SPRITE_FEET_SCREEN_PX);

        const metrics = Utils.getSpriteDrawMetrics();
        assert.strictEqual(metrics.tileW, spriteManifest.SPRITE_TILE_W);
        assert.strictEqual(metrics.tileH, spriteManifest.SPRITE_TILE_H);
        assert.strictEqual(metrics.anchorOffsetX, spriteManifest.SPRITE_TILE_W / 2);
        assert.strictEqual(
            metrics.anchorOffsetY,
            spriteManifest.SPRITE_TILE_H - spriteManifest.SPRITE_FEET_SCREEN_PX
        );

        const leftCarry = Utils.computeCarryWorldOffset(6);
        assert.ok(Math.abs(leftCarry.ox + 0.25) < 0.001, 'orientation 6 uses -5px screen carry');
        assert.ok(Math.abs(leftCarry.oy) < 0.001, 'orientation 6 has zero vertical world carry');

        await runScaleLaunch(1);
        await runScaleLaunch(2);

        const savedBaseW = Settings.BASE_FIELD_WIDTH;
        const savedBaseH = Settings.BASE_FIELD_HEIGHT;
        Settings.BASE_FIELD_WIDTH = 32;
        Settings.BASE_FIELD_HEIGHT = 20;
        Settings.FIELD_SIZE_MULTIPLIER = 2;
        const simLarge = new Simulator();
        await simLarge.start();
        const largeField = Utils.getFieldBounds();
        assert.strictEqual(largeField.width, 64, 'field width scales to 64 at 2x');
        assert.strictEqual(largeField.centerX, 32, 'field center scales to 32 at 2x');
        simLarge.resetToKickoff();
        assert.ok(simLarge.ball.owner, 'kickoff owner on scaled field');
        assert.ok(
            Math.abs(simLarge.ball.x - largeField.centerX) < 0.001,
            'kickoff ball at scaled center mark'
        );
        const largeSecondHalf = typeof simLarge.isSecondHalf === 'function' && simLarge.isSecondHalf();
        const largeKickOffLeft = largeSecondHalf
            ? (simLarge.kickoffTeam === 'B')
            : (simLarge.kickoffTeam === 'A');
        const largeTakerX = largeField.centerX
            + (largeKickOffLeft ? -Utils.scaleFieldX(0.55) : Utils.scaleFieldX(0.55));
        assert.ok(
            Math.abs(simLarge.ball.owner.x - largeTakerX) < 0.001,
            'kickoff striker slightly on own half of scaled field'
        );
        Settings.FIELD_SIZE_MULTIPLIER = 1;

        // BASE_FIELD 80×50 @ 1× must match 32×20 @ 2.5× for formation placement.
        Settings.BASE_FIELD_WIDTH = 80;
        Settings.BASE_FIELD_HEIGHT = 50;
        Settings.FIELD_SIZE_MULTIPLIER = 1;
        const simBaseLarge = new Simulator();
        await simBaseLarge.start();
        const baseLargeField = Utils.getFieldBounds();
        assert.strictEqual(baseLargeField.width, 80, '80×50 base field width');
        assert.strictEqual(baseLargeField.centerX, 40, '80×50 base field centerX');
        simBaseLarge.resetToKickoff();
        const gkA = simBaseLarge.players.find(p => p.team === 'A' && p.role === 'GK');
        const gkB = simBaseLarge.players.find(p => p.team === 'B' && p.role === 'GK');
        assert.ok(Math.abs(gkA.baseX - Utils.scaleFieldX(4.6875)) < 0.001, 'team A GK maps from reference grid');
        assert.ok(Math.abs(gkB.baseX - Utils.scaleFieldX(95.3125)) < 0.001, 'team B GK mirrors on reference grid');

        // Minimap penalty arc/box landmarks must use reference scaling, not multiplier alone.
        const miniField = Utils.getFieldBounds();
        const penSpotLeftX = Utils.scaleFieldX(12.5);
        const penBoxLineLeftX = Utils.scaleFieldX(15.625);
        const arcRadius = Utils.scaleFieldX(10.9375);
        assert.strictEqual(penSpotLeftX, miniField.width * 12.5 / Settings.REFERENCE_FIELD_WIDTH, 'minimap left pen spot');
        assert.strictEqual(penBoxLineLeftX, miniField.width * 15.625 / Settings.REFERENCE_FIELD_WIDTH, 'minimap left box line');
        assert.strictEqual(arcRadius, miniField.width * 10.9375 / Settings.REFERENCE_FIELD_WIDTH, 'minimap arc radius');
        assert.notStrictEqual(penSpotLeftX, 12.5, 'minimap must not use raw reference coords at 80x50 base');

        Settings.BASE_FIELD_WIDTH = savedBaseW;
        Settings.BASE_FIELD_HEIGHT = savedBaseH;
        Settings.FIELD_SIZE_MULTIPLIER = 1;

        const logPath = path.join(SCRATCH, 'sprite_png_launch.log');
        fs.writeFileSync(logPath, logs.join('\n') + '\n');
        fs.writeFileSync(path.join(SCRATCH, 'scale_launch.log'), logs.join('\n') + '\n');
        console.log('\nScale render tests passed');
    } catch (err) {
        const logPath = path.join(SCRATCH, 'sprite_png_launch.log');
        fs.writeFileSync(logPath, logs.join('\n') + '\n' + String(err) + '\n');
        console.error(err);
        process.exit(1);
    }
})();
