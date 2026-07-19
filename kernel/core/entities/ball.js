const { GameObject } = require('./gameobject.js');
const { Settings } = require('../../settings.js');
const { Time } = require('../lib/time.js');
const { Utils } = require('../lib/utils.js');
const {
    GROUND_FRICTION_BASE,
    BALL_STOP_SPEED,
    getGravity,
    getGroundFrictionBase,
    getBallStopSpeed,
    timeToCoverDistance: timeToCoverDistancePure,
    futurePositionFromVelocity,
    futurePosition: futurePositionPure,
    maxTravelDistance,
    distanceCoveredInTime
} = require('../lib/ball_prediction.js');
const { armKickerClaimCooldown } = require('../lib/logic_regulator.js');
const { SoundDB } = require('../lib/sounddb.js');

function ballPhysics() {
    return (Settings && Settings.physics) || {};
}

function computeCarryOffset(orientation) {
    return Utils.computeCarryWorldOffset(orientation);
}

class Ball extends GameObject {
    constructor() {
        super('Ball');
        this.z = 0; // Height off ground
        this.vx = 0;
        this.vy = 0;
        this.vz = 0; // Vertical velocity
        const br = ballPhysics().BALL_RADIUS;
        this.radius = typeof br === 'number' ? br : 0.11; // Logical radius (m)
        this.owner = null;  // Player currently holding the ball
        /** @type {object|null} Last kicker (own-pass reclaim skips first-touch fumble). */
        this.lastKicker = null;
        this.curveForce = 0; // Curving spin force (Magnus effect)
        this.isThrowInFlight = false;
        this.isShot = false; // Outfield shot block flag
        /** Indirect free kick: goal only after a second player touches the ball. */
        this.ifkActive = false;
        /** @type {object|null} Taker who struck the IFK (own reclaim does not clear). */
        this.ifkTaker = null;
        /** Previous logic-tick position (Goal.scored segment test). */
        this.prevX = 0;
        this.prevY = 0;
        this.prevZ = 0;
        this.rotationAngle = 0; // Current rotation angle for rendering animation

        this.refreshFieldBounds();
    }

    refreshFieldBounds() {
        const field = Utils.getFieldBounds();
        this.minX = 0;
        this.maxX = field.width;
        this.minY = 0;
        this.maxY = field.height;
    }

    start() {
        this.z = 0;
        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        this.owner = null;
        this.lastKicker = null;
        this.curveForce = 0;
        this.isThrowInFlight = false;
        this.isShot = false;
        this.ifkActive = false;
        this.ifkTaker = null;
        this.prevX = this.x;
        this.prevY = this.y;
        this.prevZ = this.z;
        this.rotationAngle = 0;
        this.refreshFieldBounds();
    }

    /** Snapshot current pose as previous (call before integrating free motion). */
    capturePrevPosition() {
        this.prevX = this.x;
        this.prevY = this.y;
        this.prevZ = this.z;
    }

    kick(vx, vy, vz, curveForce = 0) {
        if (this.owner) {
            // Logic-time claim lockout — set-piece vs open play durations from Settings.AI
            const isSetPiece = !!(this.owner.level && this.owner.level.setPieceType);
            armKickerClaimCooldown(this.owner, isSetPiece);
            /** Last player who kicked — own-pass reclaim uses clean first touch (no fumble loop). */
            this.lastKicker = this.owner;
        }
        this.owner = null;
        this.vx = vx;
        this.vy = vy;
        this.vz = vz;
        this.curveForce = curveForce;
        this.isThrowInFlight = false;
        this.isShot = false;
    }

    syncToOwner() {
        if (!this.owner) return;

        // Boundary set-pieces (throw-in / corner): pin ball to fixed in-field spot.
        // Carry offset near the paint / corner flag pushes the ball OOB and restarts.
        const level = this.owner.level;
        const spot = level && level._setPieceBallSpot;
        const pinTypes = level && (level.setPieceType === 'throwin' || level.setPieceType === 'corner');
        if (pinTypes && spot && typeof spot.x === 'number' && typeof spot.y === 'number') {
            this.x = spot.x;
            this.y = spot.y;
            this.z = 0;
            this.vx = 0;
            this.vy = 0;
            this.vz = 0;
            this.curveForce = 0;
            return;
        }

        // Kickoff: ball rests on the center mark (not at feet). Alternating
        // carry-offset vs pinKickoffSpots was accumulating fake rotation every tick.
        if (level && level.setPieceType === 'kickoff' && level._kickoffPins) {
            const pin = level._kickoffPins;
            if (typeof pin.ballX === 'number' && typeof pin.ballY === 'number') {
                this.x = pin.ballX;
                this.y = pin.ballY;
                this.z = 0;
                this.vx = 0;
                this.vy = 0;
                this.vz = 0;
                this.curveForce = 0;
                return;
            }
        }

        const { ox, oy } = computeCarryOffset(this.owner.orientation);
        this.x = this.owner.x + ox;
        this.y = this.owner.y + oy;
        this.z = 0;
        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        this.curveForce = 0;
    }

    update() {
        // Always record pre-integration pose for Goal.scored / OOB segment tests
        this.capturePrevPosition();

        if (this.owner) {
            this.syncToOwner();
            // Held / pinned balls do not roll from snap-to-feet (or dead-ball pins)
            this.prevX = this.x;
            this.prevY = this.y;
            this.prevZ = this.z;
        } else {
            // Apply physics in smaller sub-steps to ensure Magnus and friction stability at high speeds
            let dtRemaining = Time.deltaTime;
            const maxStep = 0.05;

            const p = ballPhysics();
            const magnusScale = typeof p.MAGNUS_ACC_SCALE === 'number' ? p.MAGNUS_ACC_SCALE : 0.15;
            const magnusCap = typeof p.MAGNUS_VEL_CAP === 'number' ? p.MAGNUS_VEL_CAP : 10.0;
            const curveDecay = typeof p.CURVE_DECAY_BASE === 'number' ? p.CURVE_DECAY_BASE : 0.80;
            const curveStop = typeof p.CURVE_FORCE_STOP === 'number' ? p.CURVE_FORCE_STOP : 0.05;
            const bounceMinVz = typeof p.BOUNCE_MIN_VZ === 'number' ? p.BOUNCE_MIN_VZ : 1.5;
            const bounceRest = typeof p.BOUNCE_RESTITUTION === 'number' ? p.BOUNCE_RESTITUTION : 0.6;
            const bounceDamp = typeof p.BOUNCE_HORIZONTAL_DAMP === 'number' ? p.BOUNCE_HORIZONTAL_DAMP : 0.85;
            const g = getGravity();
            const frictionBase = getGroundFrictionBase();
            const stopSpeed = getBallStopSpeed();

            while (dtRemaining > 0.0001) {
                const dt = Math.min(maxStep, dtRemaining);
                dtRemaining -= dt;

                // Magnus / Curve effect (spin force) — Settings.physics
                if (this.curveForce && (this.vx !== 0 || this.vy !== 0)) {
                    const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
                    if (vel > 0.1) {
                        const px = -this.vy / vel;
                        const py = this.vx / vel;

                        // Cap velocity influence so hot shots do not hook unrealistically
                        const magnusVel = Math.min(vel, magnusCap);
                        const accX = px * this.curveForce * magnusVel * magnusScale;
                        const accY = py * this.curveForce * magnusVel * magnusScale;

                        this.vx += accX * dt;
                        this.vy += accY * dt;

                        this.curveForce *= Math.pow(curveDecay, dt);
                        if (Math.abs(this.curveForce) < curveStop) this.curveForce = 0;
                    }
                }

                if (this.z > 0) {
                    this.vz -= g * dt;
                    // Horizontal air drag — lofted balls must slow (not cruise like vacuum)
                    const airBase = typeof p.AIR_DRAG_BASE === 'number' ? p.AIR_DRAG_BASE : 0.88;
                    const airF = Math.pow(airBase, dt);
                    this.vx *= airF;
                    this.vy *= airF;
                }

                // Move
                this.x += this.vx * dt;
                this.y += this.vy * dt;
                this.z += this.vz * dt;

                // Bounce on ground
                if (this.z <= 0) {
                    this.z = 0;
                    if (Math.abs(this.vz) > bounceMinVz) {
                        // Audible bounce only for firm impacts (volume from impact speed)
                        const impact = Math.min(1, Math.abs(this.vz) / 8);
                        if (impact > 0.35) {
                            SoundDB.play('bounce', { volume: 0.35 + impact * 0.65 });
                        }
                        this.vz = -this.vz * bounceRest;
                        this.vx *= bounceDamp;
                        this.vy *= bounceDamp;
                    } else {
                        this.vz = 0;
                    }
                }

                // Ground friction (shared model with ball_prediction.js)
                if (this.z === 0) {
                    const friction = Math.pow(frictionBase, dt);
                    this.vx *= friction;
                    this.vy *= friction;

                    if (Math.sqrt(this.vx * this.vx + this.vy * this.vy) < stopSpeed) {
                        this.vx = 0;
                        this.vy = 0;
                        this.isShot = false;
                    }
                }
            }
        }

        // Update rotation from free-flight displacement only (not while held/pinned)
        if (!this.owner) {
            const dx = this.x - this.prevX;
            const dy = this.y - this.prevY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // A ball moving > 1 meter per frame (60Hz) is going 200+ km/h (teleportation/glitch)
            if (dist > 0.0001 && dist < 1.0) {
                // Physically perfect rotation: Angle = Distance / Radius
                this.rotationAngle += dist / this.radius;
            }

            if (this.curveForce) {
                // Curve spin is also normalized
                this.rotationAngle += this.curveForce * Time.deltaTime * 1.5;
            }
        }

        // IMPORTANT: Do NOT modulo (% Math.PI * 2) the rotationAngle anymore!
        // Because the render function uses multipliers like 0.5 and 0.8 on this angle,
        // wrapping the base angle causes the scaled 3D axes to violently snap mid-tumble.
        // Math.sin and Math.cos handle infinitely growing numbers perfectly.
    }

    /**
     * Predicted position under friction (shared AI model, 3D selective).
     * @param {number} time - seconds ahead
     * @returns {{ x: number, y: number, z: number, vx: number, vy: number, vz: number }}
     */
    futurePosition(time) {
        return futurePositionPure(this, time);
    }

    /**
     * Time for a kick with given initial speed to cover a ground distance.
     * @param {number} distance
     * @param {number} initialSpeed
     * @returns {number} seconds, or -1 if unreachable
     */
    timeToCoverDistance(distance, initialSpeed) {
        return timeToCoverDistancePure(distance, initialSpeed);
    }

    render(g) {
        const m = Utils.getScaleMultiplier();

        // Project positions dynamically using Utils.toScreen
        const shadow = Utils.toScreen(this.x, this.y, 0);
        const ball = Utils.toScreen(this.x, this.y, this.z);

        const shadowX = shadow.x;
        const shadowY = shadow.y;
        const ballX = ball.x;
        const ballY = ball.y;

        const ballRadius = Settings.BALL_DRAW_RADIUS * m;
        const maxShadowSize = 13 * m;
        const minShadowSize = 5 * m;

        // Draw shadow on the ground
        const shadowSize = Math.max(minShadowSize, maxShadowSize / (1 + this.z * 0.6));
        g.fillStyle = 'rgba(0, 0, 0, 0.3)';
        g.beginPath();
        g.ellipse(shadowX, shadowY, shadowSize, shadowSize / 2, 0, 0, Math.PI * 2);
        g.fill();

        // Draw ball background
        g.fillStyle = '#FFFFFF';
        g.strokeStyle = '#000000';
        g.lineWidth = Math.max(1, m);
        g.beginPath();
        g.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
        g.fill();

        // --- Fake 3D Tumbling Logic ---
        const angle = this.rotationAngle || 0;

        // Tumbling rotation components (using varying multipliers for a chaotic 3D tumble)
        const cosX = Math.cos(angle * 0.8);
        const sinX = Math.sin(angle * 0.8);
        const cosY = Math.cos(angle);
        const sinY = Math.sin(angle);
        const cosZ = Math.cos(angle * 0.5);
        const sinZ = Math.sin(angle * 0.5);

        // 12 vertices of an icosahedron (these map perfectly to the black pentagons on a soccer ball)
        const a = 0.5257, b = 0.8506;
        const patches = [
            [-a, 0, b], [a, 0, b], [-a, 0, -b], [a, 0, -b],
            [0, b, a], [0, b, -a], [0, -b, a], [0, -b, -a],
            [b, a, 0], [-b, a, 0], [b, -a, 0], [-b, -a, 0]
        ];

        g.save();

        // Restrict all drawing to within the ball's radius (handles horizon wrapping)
        g.beginPath();
        g.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
        g.clip();

        g.fillStyle = '#000000';

        // Project and draw each black patch
        for (let i = 0; i < patches.length; i++) {
            let px = patches[i][0];
            let py = patches[i][1];
            let pz = patches[i][2];

            // 3D Matrix Rotation
            let y1 = py * cosX - pz * sinX;
            let z1 = py * sinX + pz * cosX;

            let x2 = px * cosY + z1 * sinY;
            let z2 = -px * sinY + z1 * cosY;

            let x3 = x2 * cosZ - y1 * sinZ;
            let y3 = x2 * sinZ + y1 * cosZ;
            let z3 = z2; // Final depth

            // Only draw if facing forward (z > -0.2 allows them to curve slightly over the edge before clipping)
            if (z3 > -0.2) {
                // Foreshortening: scale size based on depth so patches look flatter near the edges
                let patchRadius = 2.5 * m * (0.4 + 0.6 * Math.max(0, z3));

                g.beginPath();
                g.arc(ballX + x3 * ballRadius, ballY + y3 * ballRadius, patchRadius, 0, Math.PI * 2);
                g.fill();
            }
        }

        g.restore();

        // Draw the black outline AFTER the patches so the edges remain perfectly crisp
        g.beginPath();
        g.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
        g.stroke();
    }
}

module.exports = {
    Ball,
    computeCarryOffset,
    // Re-export prediction API (SoccerBall helpers)
    GROUND_FRICTION_BASE,
    BALL_STOP_SPEED,
    timeToCoverDistance: timeToCoverDistancePure,
    futurePositionFromVelocity,
    futurePosition: futurePositionPure,
    maxTravelDistance,
    distanceCoveredInTime
};