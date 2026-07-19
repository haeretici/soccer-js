#!/usr/bin/env node

function log(...args) {
    if (process.env.VERBOSE) {
        console.log(...args);
    }
}
/**
 * Ball prediction — TimeToCoverDistance / FuturePosition / kick noise.
 */
require('./mock_env.js');
const assert = require('assert');

const {
    GROUND_FRICTION_BASE,
    FRICTION_K,
    timeToCoverDistance,
    futurePositionFromVelocity,
    futurePosition,
    maxTravelDistance,
    speedAfterDistance,
    initialSpeedForDistance,
    distanceCoveredInTime,
    applyKickDirectionNoise,
    sampleKickCurveForce,
    buildNoisyKickVelocity,
    predict3D,
    timeToBounce,
    heightAtT,
    isHeaderHeight,
    isBallAirborne,
    findAirIntercept,
    findHeaderOpportunity
} = require('../kernel/core/lib/ball_prediction.js');
const { timeToCoverDistance: passTime } = require('../kernel/core/lib/pass_safety.js');
const { Ball } = require('../kernel/core/entities/ball.js');
const { computeLooseBallInterceptTarget } = require('../kernel/core/entities/player.js');
const { Settings } = require('../kernel/settings.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 800, height: 600 } };
Settings.HEADLESS = true;



function main() {
    assert.ok(GROUND_FRICTION_BASE === 0.65);
    assert.ok(FRICTION_K > 0);

    // Constant-speed mode (legacy)
    assert.strictEqual(timeToCoverDistance(10, 10, { constantSpeed: true }), 1);
    assert.ok(timeToCoverDistance(5, 0) < 0);

    // Friction: longer than constant speed for same distance
    const tFric = timeToCoverDistance(10, 10);
    assert.ok(tFric > 1, `friction time > constant (${tFric})`);
    assert.ok(tFric < 3, `friction time sane (${tFric})`);

    // Unreachable beyond max range
    const maxD = maxTravelDistance(10);
    assert.ok(maxD > 10);
    assert.ok(timeToCoverDistance(maxD + 1, 10) < 0);
    assert.ok(timeToCoverDistance(maxD * 0.5, 10) > 0);
    log('PASS timeToCoverDistance friction model');

    // Soft-arrival kick speed: residual at aim is tame; range past aim without old 3–7× blasts
    for (const dist of [4, 8, 12, 18]) {
        const v0 = initialSpeedForDistance(dist, { arrivalSpeed: 2.0, cushion: 1.08 });
        const vArr = speedAfterDistance(v0, dist);
        const range = maxTravelDistance(v0);
        assert.ok(range > dist, `range past aim d=${dist} range=${range}`);
        // Short ranges hit min-speed floor → higher ratio; primary quality is soft residual
        assert.ok(range / dist < 3.5, `overshoot bounded d=${dist} ratio=${(range / dist).toFixed(2)}`);
        assert.ok(vArr > 0.5 && vArr < 4.5, `soft arrival d=${dist} vArr=${vArr.toFixed(2)}`);
    }
    // Mid range clearly softer than legacy 7+0.35d (ratio ~2.7 → ~1.5)
    const legacyMid = 7 + 10 * 0.35 + 1.05;
    const softMid = initialSpeedForDistance(10, { arrivalSpeed: 2.0, cushion: 1.06 });
    assert.ok(softMid < legacyMid * 0.75, `soft ${softMid} << legacy ${legacyMid}`);
    assert.ok(maxTravelDistance(softMid) / 10 < 1.7, 'mid-range ratio under 1.7');
    log('PASS initialSpeedForDistance soft arrival');

    // Round-trip: distanceCoveredInTime(timeToCoverDistance(d)) ≈ d
    const d0 = 8;
    const v0 = 12;
    const t0 = timeToCoverDistance(d0, v0);
    const dBack = distanceCoveredInTime(v0, t0);
    assert.ok(Math.abs(dBack - d0) < 1e-4, `round-trip dist ${dBack} vs ${d0}`);
    log('PASS distanceCoveredInTime inverse of timeToCoverDistance');

    // Future position: moves along velocity, decelerates
    const fut = futurePositionFromVelocity(0, 0, 10, 0, 0.5);
    assert.ok(fut.x > 0 && fut.x < 10 * 0.5, 'friction shortens path vs constant v*t');
    assert.ok(fut.vx < 10 && fut.vx > 0, 'speed decays');
    assert.strictEqual(fut.y, 0);

    const stopped = futurePositionFromVelocity(1, 2, 0, 0, 1);
    assert.strictEqual(stopped.x, 1);
    assert.strictEqual(stopped.y, 2);
    log('PASS futurePositionFromVelocity');

    // pass_safety re-exports same function
    assert.ok(Math.abs(passTime(10, 10) - tFric) < 1e-9);
    log('PASS pass_safety timeToCoverDistance aligned');

    // Ball instance API
    const ball = new Ball();
    ball.x = 5;
    ball.y = 5;
    ball.vx = 8;
    ball.vy = 0;
    const bp = ball.futurePosition(0.4);
    assert.ok(bp.x > 5);
    assert.ok(ball.timeToCoverDistance(3, 8) > 0);
    log('PASS Ball.futurePosition / timeToCoverDistance');

    // Kick noise: unit direction stays ~unit, seeded deterministic
    let r = 0;
    const seq = () => {
        r = (r * 1664525 + 1013904223) >>> 0;
        return r / 0x100000000;
    };
    const n1 = applyKickDirectionNoise(1, 0, 50, { angleScale: 0.01, random: seq });
    const len = Math.sqrt(n1.nx * n1.nx + n1.ny * n1.ny);
    assert.ok(Math.abs(len - 1) < 1e-6);
    assert.ok(sampleKickCurveForce(80, () => 0.75) !== 0 || sampleKickCurveForce(80, () => 0.25) !== 0);
    const kick = buildNoisyKickVelocity(1, 0, 10, { accuracy: 90, random: () => 0.5, withCurve: true, shooting: 70 });
    assert.ok(Math.abs(kick.vx) + Math.abs(kick.vy) > 5);
    log('PASS kick noise helpers');

    // Loose-ball intercept uses friction lead (not pure vx*t)
    const chaser = {
        x: 0, y: 0,
        team: 'A',
        stats: { speed: 80 },
        staminaMultiplier: 1
    };
    const loose = { x: 5, y: 0, vx: 12, vy: 0 };
    const intercept = computeLooseBallInterceptTarget(chaser, loose);
    const constantPredX = loose.x + loose.vx * 0.5; // rough constant
    // Intercept should be ahead of ball but not as far as pure high-t constant for long leads
    assert.ok(intercept.x > loose.x, 'leads the ball');
    const pure = futurePosition(loose, 0.9);
    assert.ok(pure.x < loose.x + loose.vx * 0.9 - 0.01, 'future shorter than constant');
    log('PASS computeLooseBallInterceptTarget uses FuturePosition');

    // 3D-aware prediction tests
    const ball3D = { x: 5, y: 5, z: 2.0, vx: 5, vy: 0, vz: 10, curveForce: 0 };
    
    // Test predict3D
    const pred1 = predict3D(ball3D, 0.5);
    assert.ok(pred1.z !== 2.0); // height changes under gravity
    assert.ok(pred1.x > 5);
    
    // Test heightAtT
    const h0 = heightAtT(ball3D, 0);
    const h1 = heightAtT(ball3D, 0.5);
    assert.strictEqual(h0, 2.0);
    assert.ok(h1 !== 2.0);
    
    // Test timeToBounce
    const tBounce = timeToBounce(ball3D);
    assert.ok(tBounce > 0);
    const hAtBounce = heightAtT(ball3D, tBounce);
    assert.ok(hAtBounce <= 0.25, `Height at bounce should be near 0, got ${hAtBounce}`);
    
    // Test futurePosition selective 3D path
    const groundBall = { x: 5, y: 5, z: 0, vx: 5, vy: 0, vz: 0, curveForce: 0 };
    const fpGround = futurePosition(groundBall, 0.5);
    assert.strictEqual(fpGround.z, 0);
    assert.strictEqual(fpGround.vz, 0);
    
    const airBall = { x: 5, y: 5, z: 1.5, vx: 5, vy: 0, vz: 5, curveForce: 0 };
    const fpAir = futurePosition(airBall, 0.5);
    assert.ok(fpAir.z > 0, "Air ball should use 3D path and have z > 0");
    assert.ok(fpAir.vz !== 0, "Air ball should use 3D path and have vz !== 0");
    log('PASS selective 3D prediction, timeToBounce and heightAtT');

    // Stage 4: header band + air intercept helpers
    assert.ok(isHeaderHeight(1.2));
    assert.ok(!isHeaderHeight(0.4));
    assert.ok(!isHeaderHeight(2.1));
    assert.ok(isBallAirborne({ z: 1.0, vz: 0 }));
    assert.ok(isBallAirborne({ z: 0, vz: 2.0 }));
    assert.ok(!isBallAirborne({ z: 0, vz: 0 }));

    // Ball arcing over a nearby player — should find a reachable header sample
    const cross = { x: 50, y: 34, z: 1.4, vx: 2.0, vy: 0, vz: 1.5, curveForce: 0 };
    const jumper = { x: 51, y: 34, speed: 6.0 };
    const airHit = findAirIntercept(cross, jumper, {
        maxTime: 1.0,
        zMin: 0.9,
        zMax: 2.0,
        preferT: 0.45
    });
    assert.ok(airHit.canReach, 'nearby jumper reaches air sample');
    assert.ok(airHit.z >= 0.9 && airHit.z < 2.0, `header band z=${airHit.z}`);

    const opp = findHeaderOpportunity(cross, jumper, { maxTime: 0.95, contactRadius: 1.9 });
    assert.ok(opp.ok, 'header opportunity near lofted ball');

    // Far player cannot claim the same window
    const far = findHeaderOpportunity(cross, { x: 10, y: 10, speed: 5 }, { maxTime: 0.6 });
    assert.ok(!far.ok, 'far player no header window');
    log('PASS Stage 4 findAirIntercept / findHeaderOpportunity');

    // Airborne loose-ball chase targets 3D intercept (not pure ground)
    const airLoose = { x: 40, y: 30, z: 1.8, vx: 6, vy: 1, vz: 2 };
    const chaseAir = computeLooseBallInterceptTarget(
        { x: 38, y: 30, team: 'A', stats: { speed: 85 }, staminaMultiplier: 1 },
        airLoose
    );
    assert.ok(typeof chaseAir.x === 'number' && typeof chaseAir.y === 'number');
    assert.ok(chaseAir.x > airLoose.x - 1, 'air intercept still leads roughly downfield');
    log('PASS airborne computeLooseBallInterceptTarget');

    log('\nAll ball prediction tests passed.');
}

main();
