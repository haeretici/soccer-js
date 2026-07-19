#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Pass safety: local-space intercept tests + wiring into Team.findBestPassTarget.
 */
require('./mock_env.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const {
    isPassSafeFromOpponent,
    isPassSafeFromAllOpponents,
    estimatePassGroundSpeed,
    estimatePlayerMaxSpeed,
    timeToCoverDistance,
    pickBestSafePassTarget,
    tryBallShotBlocking
} = require('../kernel/core/lib/pass_safety.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function makePlayer(x, y, team, speed = 60) {
    return {
        x, y, team,
        isSentOff: false,
        stats: { speed, passing: 70 },
        staminaMultiplier: 1,
        role: 'CM'
    };
}

async function main() {
    // --- Pure math ---
    // friction model — longer than constant-speed d/v
    const tFric = timeToCoverDistance(10, 10);
    assert.ok(tFric > 1 && tFric < 3, `friction timeToCoverDistance (${tFric})`);
    assert.strictEqual(timeToCoverDistance(10, 10, { constantSpeed: true }), 1);
    assert.ok(timeToCoverDistance(5, 0) < 0);
    assert.ok(estimatePlayerMaxSpeed(makePlayer(0, 0, 'A', 100)) >
        estimatePlayerMaxSpeed(makePlayer(0, 0, 'A', 40)));
    log('PASS timeToCoverDistance + estimatePlayerMaxSpeed');

    const from = { x: 0, y: 0 };
    const target = { x: 20, y: 0 };
    const speed = estimatePassGroundSpeed(from, target, makePlayer(0, 0, 'A'), 'short');
    assert.ok(speed > 5, `pass speed positive (${speed})`);
    // Soft-arrival when not pinned to MIN; long uses hang-time + air-drag (can be slower on short legs)
    const { maxTravelDistance: maxDFn, speedAfterDistance, longPassInitialSpeed } =
        require('../kernel/core/lib/ball_prediction.js');
    const minShort = (Settings.physics && Settings.physics.PASS_SHORT_MIN_SPEED) || 6;
    for (const dist of [5, 10, 15]) {
        const to = { x: dist, y: 0 };
        const vShort = estimatePassGroundSpeed(from, to, makePlayer(0, 0, 'A'), 'short');
        const vLong = estimatePassGroundSpeed(from, to, makePlayer(0, 0, 'A'), 'long');
        assert.ok(vShort > 0 && vLong > 0, 'short/long speeds positive');
        const residual = speedAfterDistance(vShort, dist);
        const floorPinned = vShort <= minShort * 1.08;
        if (!floorPinned) {
            const rShort = maxDFn(vShort);
            const maxRatio = dist < 7 ? 3.25 : 2.15;
            assert.ok(rShort / dist < maxRatio, `short overshoot d=${dist} ratio=${(rShort / dist).toFixed(2)}`);
            assert.ok(residual < 4.8, `short soft arrival d=${dist} v=${residual.toFixed(2)}`);
            const legacy = 7 + dist * 0.35 + 1.05;
            assert.ok(vShort < legacy * 0.88, `soft ${vShort.toFixed(2)} vs legacy ${legacy.toFixed(2)}`);
        }
        // Long at mid/long range should not be a vacuum cruise: hang model returns finite speed
        if (dist >= 15 && typeof longPassInitialSpeed === 'function') {
            const baseLong = longPassInitialSpeed(dist);
            assert.ok(baseLong < 22, `long base speed bounded (${baseLong})`);
        }
    }
    // 30 m lob: air model reaches ~aim, not 2× ground-friction overshoot
    {
        const d = 30;
        const vL = estimatePassGroundSpeed(from, { x: d, y: 0 }, makePlayer(0, 0, 'A'), 'long');
        const pureCruise = vL * 2.0; // ~hang without drag would be ~v*T; v alone must stay moderate
        assert.ok(vL < 18, `long kick not laser d=30 v=${vL.toFixed(2)}`);
        assert.ok(pureCruise > d * 0.5, 'sanity');
    }
    log('PASS estimatePassGroundSpeed soft arrival / long air model');

    // Opponent well beside lane, far from intercept — safe
    const farSide = makePlayer(10, 20, 'B', 60);
    assert.strictEqual(
        isPassSafeFromOpponent(from, target, makePlayer(20, 0, 'A'), farSide, speed),
        true,
        'far lateral opponent is safe'
    );

    // Opponent sitting on the lane midpoint with high speed — unsafe
    const blocker = makePlayer(10, 0.1, 'B', 100);
    assert.strictEqual(
        isPassSafeFromOpponent(from, target, makePlayer(20, 0, 'A'), blocker, speed),
        false,
        'on-lane opponent intercepts'
    );

    // Opponent behind passer — safe
    const behind = makePlayer(-5, 0, 'B', 100);
    assert.strictEqual(
        isPassSafeFromOpponent(from, target, null, behind, speed),
        true,
        'behind passer is safe'
    );
    log('PASS isPassSafeFromOpponent geometry cases');

    // All opponents
    assert.strictEqual(
        isPassSafeFromAllOpponents(from, target, makePlayer(20, 0, 'A'), [farSide, behind], speed),
        true
    );
    assert.strictEqual(
        isPassSafeFromAllOpponents(from, target, makePlayer(20, 0, 'A'), [farSide, blocker], speed),
        false
    );
    log('PASS isPassSafeFromAllOpponents');

    // Race to target: opp farther from passer than target, closer to landing than receiver
    const shortTarget = { x: 5, y: 0 };
    const recv = makePlayer(5, 0, 'A');
    const nearLanding = makePlayer(12, 0, 'B', 80); // farther from passer than target (5)
    // dist passer->target = 5, dist passer->opp = 12 > 5, dist opp->target = 7, dist recv->target = 0
    // so opp loses race to receiver who is already on spot → safe
    assert.strictEqual(
        isPassSafeFromOpponent(from, shortTarget, recv, nearLanding, 15),
        true,
        'receiver already on spot wins race'
    );
    const steal = makePlayer(12, 0, 'B', 80);
    const slowRecv = makePlayer(5, 8, 'A'); // far from target
    assert.strictEqual(
        isPassSafeFromOpponent(from, shortTarget, slowRecv, steal, 15),
        false,
        'opp closer to landing than slow receiver'
    );
    log('PASS race-to-landing branch');

    // pickBestSafePassTarget prefers safe over closer blocked
    const passer = makePlayer(0, 0, 'A');
    const safeMate = makePlayer(0, 8, 'A');
    const blockedMate = makePlayer(10, 0, 'A');
    const midBlocker = makePlayer(5, 0, 'B', 100);
    const pick = pickBestSafePassTarget(
        passer,
        [blockedMate, safeMate],
        [midBlocker],
        { passType: 'short' }
    );
    assert.strictEqual(pick, safeMate, 'prefers safe lateral over blocked forward');
    log('PASS pickBestSafePassTarget prefers safe lane');

    // --- Live Team wiring ---
    const sim = new Simulator({ seed: 7 });
    await sim.start();
    sim.fsm.setCurrentState(MatchStates.Play);

    const a = sim.teamA;
    const carrier = a.getOutfieldPlayers()[0];
    assert.ok(carrier);
    assert.strictEqual(typeof a.isPassSafeFromAllOpponents, 'function');
    assert.strictEqual(typeof a.isPassSafeFromOpponent, 'function');

    // Clear field: park all B players far from a designed pass lane
    const mate = a.getOutfieldPlayers().find(p => p !== carrier);
    assert.ok(mate);
    carrier.x = 20;
    carrier.y = 25;
    mate.x = 28;
    mate.y = 25;
    for (const d of sim.teamB.players) {
        d.x = 70;
        d.y = 5;
    }
    sim.ball.owner = carrier;
    sim.ball.x = carrier.x;
    sim.ball.y = carrier.y;

    const openDecision = a.findBestPassTarget(carrier);
    // May or may not pick mate depending on ahead/open scoring, but aim must be safe
    if (openDecision) {
        assert.ok(openDecision.aim, 'decision includes lead aim');
        const fromP = { x: carrier.x, y: carrier.y };
        const toP = openDecision.aim;
        const spd = estimatePassGroundSpeed(fromP, toP, carrier, openDecision.type);
        assert.ok(
            a.isPassSafeFromAllOpponents(fromP, toP, openDecision.teammate, spd),
            'chosen pass aim must be safe vs all opponents'
        );
    }
    log('PASS Team.findBestPassTarget only returns safe lanes when available');

    // Block every teammate with a B player on the lane → no safe pass or only safe ones
    for (const tm of a.getOutfieldPlayers()) {
        if (tm === carrier) continue;
        tm.x = carrier.x + 8;
        tm.y = carrier.y;
    }
    // One B marker on each forward lane midpoint
    const bOut = sim.teamB.getOutfieldPlayers();
    for (let i = 0; i < bOut.length; i++) {
        bOut[i].x = carrier.x + 4;
        bOut[i].y = carrier.y + (i - 4) * 0.15;
        bOut[i].stats.speed = 99;
    }
    const blocked = a.findBestPassTarget(carrier);
    // Ahead receivers sit with blockers on lane; any remaining aim must still be safe
    if (blocked) {
        assert.ok(blocked.aim, 'blocked case still returns aim when decision exists');
        const fromP = { x: carrier.x, y: carrier.y };
        const toP = blocked.aim;
        const spd = estimatePassGroundSpeed(fromP, toP, carrier, blocked.type);
        assert.ok(
            a.isPassSafeFromAllOpponents(fromP, toP, blocked.teammate, spd),
            'if a target remains its aim must still pass safety'
        );
    }
    log('PASS dense press: unsafe lanes filtered from findBestPassTarget');

    // Team method uses opponents pool
    const end = { x: carrier.x + 8, y: carrier.y };
    assert.strictEqual(
        a.isPassSafeFromOpponent(
            { x: carrier.x, y: carrier.y },
            end,
            mate,
            bOut[0],
            12
        ),
        false
    );
    log('PASS Team.isPassSafeFromOpponent delegates to pure helper');

    // --- Outfield Shot Blocking test ---
    const mockSim = {
        ball: {
            isShot: true,
            owner: null,
            x: 10, y: 25, z: 0,
            prevX: 5, prevY: 25, prevZ: 0,
            vx: 10, vy: 0, vz: 0,
            radius: 0.25,
            lastKicker: { team: 'A' },
            kick(vx, vy, vz, curve) {
                this.vx = vx; this.vy = vy; this.vz = vz;
                this.isShot = false;
            }
        },
        teamA: {
            getOutfieldPlayers() { return []; }
        },
        teamB: {
            getOutfieldPlayers() {
                return [
                    {
                        x: 8, y: 25.1,
                        role: 'DF',
                        isSentOff: false,
                        stats: { speed: 60 },
                        staminaMultiplier: 1
                    }
                ];
            }
        },
        _telemetry: {
            blocks: 0,
            onBlock() { this.blocks++; }
        }
    };
    
    // Test a blockable shot (ball travels from (5,25) to (10,25), defender is at (8, 25.1))
    const isShotBlocked = tryBallShotBlocking(mockSim, 0.05);
    assert.strictEqual(isShotBlocked, true, "Shot should be blocked by defender along the lane");
    assert.strictEqual(mockSim.ball.isShot, false, "Shot flag should be cleared after block");
    assert.ok(mockSim.ball.vx < 0, "Ball should deflect backward");
    assert.strictEqual(mockSim._telemetry.blocks, 1, "Telemetry blocks should increment");
    log('PASS tryBallShotBlocking outfield deflection');

    log('\nAll pass safety tests passed.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
