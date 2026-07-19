/**
 * Goal — posts, mouth center, facing, and segment scoring helper.
 *
 * Owns posts, center, facing, crossbar height, and net depth so rules and AI
 * share one definition of the mouth (not scattered scaleFieldY(40/60) literals).
 *
 * Scored(ball): segment oldPos→pos crosses the goal line BETWEEN the posts
 * and under the bar (3D z), coming from the pitch. Entry from outside the
 * cage (wide of posts, over the bar, through the net exterior) is not a goal.
 * Solid posts/crossbar + exterior net keep free balls from phasing in.
 * Soft net settle after a goal uses isInMouthVolume / netBackX.
 */
const { GameObject } = require('./gameobject.js');
const { Utils } = require('../lib/utils.js');

/** Mouth / crossbar / net depth on REFERENCE_FIELD (presets + pitch markings). */
const GOAL_MOUTH_Y_REF_MIN = 40;
const GOAL_MOUTH_Y_REF_MAX = 60;
const GOAL_HEIGHT_REF = 7.0;
/** Physics net box depth (matches existing checkGoalNetCollisions). */
const GOAL_NET_DEPTH_REF = 5.0;
/** Visual net depth used by pitch render (slightly shallower). */
const GOAL_RENDER_DEPTH_REF = 3.125;
/** Post / crossbar radius in world units (m). */
const GOAL_POST_RADIUS = 0.12;
/** Restitution when the ball hits posts / bar / exterior net. */
const GOAL_FRAME_RESTITUTION = 0.55;
const GOAL_FRAME_TANGENT_DAMP = 0.75;

/**
 * @typedef {{ x: number, y: number, z?: number }} GoalPoint3
 */

class Goal extends GameObject {
    /**
     * @param {'left'|'right'} side
     * @param {{
     *   lineX: number,
     *   yMin: number,
     *   yMax: number,
     *   height: number,
     *   netDepth: number,
     *   renderDepth?: number,
     *   facingX: number
     * }} geom
     */
    constructor(side, geom) {
        super(side === 'left' ? 'GoalLeft' : 'GoalRight');
        this.side = side;
        this.lineX = geom.lineX;
        this.yMin = geom.yMin;
        this.yMax = geom.yMax;
        this.height = geom.height;
        this.netDepth = geom.netDepth;
        this.renderDepth = geom.renderDepth != null ? geom.renderDepth : geom.netDepth;
        /** Unit X: +1 opens toward increasing X (left goal), −1 toward decreasing X (right). */
        this.facingX = geom.facingX;

        this.leftPost = { x: this.lineX, y: this.yMin };
        this.rightPost = { x: this.lineX, y: this.yMax };
        this.center = {
            x: this.lineX,
            y: (this.yMin + this.yMax) * 0.5
        };
        this.facing = { x: this.facingX, y: 0 };

        // Anchor GameObject at goal center on the line
        this.x = this.center.x;
        this.y = this.center.y;
        this.z = 0;
    }

    /**
     * Build both goals for current field bounds.
     * @param {{ width: number, height?: number, multiplier?: number }|null} [field]
     * @returns {{ left: Goal, right: Goal }}
     */
    static createPair(field = null) {
        const f = field || Utils.getFieldBounds();
        const yMin = Utils.scaleFieldY(GOAL_MOUTH_Y_REF_MIN);
        const yMax = Utils.scaleFieldY(GOAL_MOUTH_Y_REF_MAX);
        const height = Utils.scaleFieldY(GOAL_HEIGHT_REF);
        const netDepth = Utils.scaleFieldY(GOAL_NET_DEPTH_REF);
        const renderDepth = Utils.scaleFieldX(GOAL_RENDER_DEPTH_REF);

        const left = new Goal('left', {
            lineX: 0,
            yMin,
            yMax,
            height,
            netDepth,
            renderDepth,
            facingX: 1
        });
        const right = new Goal('right', {
            lineX: f.width,
            yMin,
            yMax,
            height,
            netDepth,
            renderDepth,
            facingX: -1
        });
        return { left, right };
    }

    /** Mouth center on the goal line. */
    Center() {
        return { x: this.center.x, y: this.center.y };
    }

    /** Facing into the pitch (unit). */
    Facing() {
        return { x: this.facing.x, y: this.facing.y };
    }

    LeftPost() {
        return { x: this.leftPost.x, y: this.leftPost.y };
    }

    RightPost() {
        return { x: this.rightPost.x, y: this.rightPost.y };
    }

    /**
     * 2D distance from a world point to the goal mouth center.
     * @param {number} x
     * @param {number} y
     */
    distanceTo(x, y) {
        const dx = this.center.x - x;
        const dy = this.center.y - y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Y bounds for AI shot samples (optional ball-radius inset).
     * @param {number} [inset=0]
     */
    getMouthYBounds(inset = 0) {
        return {
            yMin: this.yMin + inset,
            yMax: this.yMax - inset
        };
    }

    /**
     * Sample aim points along the mouth for CanShoot (world coords on goal line).
     * @param {number} [count=5]
     * @param {function(): number} [random=Math.random]
     * @param {number} [inset=0]
     * @returns {{ x: number, y: number }[]}
     */
    sampleMouthTargets(count = 5, random = Math.random, inset = 0) {
        const { yMin, yMax } = this.getMouthYBounds(inset);
        const mid = (yMin + yMax) * 0.5;
        const targets = [
            { x: this.lineX, y: mid },
            { x: this.lineX, y: yMin + (yMax - yMin) * 0.2 },
            { x: this.lineX, y: yMin + (yMax - yMin) * 0.8 }
        ];
        const n = Math.max(0, count | 0);
        for (let i = 0; i < n; i++) {
            targets.push({
                x: this.lineX,
                y: yMin + random() * (yMax - yMin)
            });
        }
        return targets;
    }

    /**
     * Back of the net in world X (outside the pitch).
     */
    netBackX() {
        // Left goal: net extends to −depth; right: width + depth
        return this.lineX - this.facingX * this.netDepth;
    }

    /**
     * True if (x,y,z) is inside the goal mouth volume (between posts, under bar,
     * on the net side of the goal line including the line itself).
     * @param {number} x
     * @param {number} y
     * @param {number} [z=0]
     * @param {number} [eps=0]
     */
    isInMouthVolume(x, y, z = 0, eps = 0) {
        if (y < this.yMin - eps || y > this.yMax + eps) return false;
        if (z > this.height + eps) return false;
        // On goal / net side of the line: (lineX - x) * facingX >= 0
        // Left (facing+1): x <= lineX; right (facing-1): x >= lineX
        const side = (this.lineX - x) * this.facingX;
        if (side < -eps) return false; // still on pitch interior
        const back = this.netBackX();
        // Not past the back net plane
        if (this.facingX > 0) {
            // left: back is more negative
            if (x < back - eps) return false;
        } else if (x > back + eps) {
            return false;
        }
        return true;
    }

    /**
     * True if the ball counts as a goal this tick: the free-flight segment
     * must cross the goal-line plane from the pitch, between the posts and
     * under the crossbar. Ending up in the net after a wide / exterior path
     * is NOT a goal (that used to be a volume fallback bug).
     *
     * @param {{ x: number, y: number, z?: number, prevX?: number, prevY?: number, prevZ?: number }} ball
     * @returns {boolean}
     */
    isGoalEvent(ball) {
        return this.scored(ball);
    }

    /**
     * True if ball path from previous to current position
     * crosses the goal line between the posts and under the crossbar,
     * approaching from the pitch (not from inside/behind the net).
     *
     * @param {{ x: number, y: number, z?: number, prevX?: number, prevY?: number, prevZ?: number }} ball
     * @param {GoalPoint3|null} [prevOverride] - optional explicit previous position
     * @returns {boolean}
     */
    scored(ball, prevOverride = null) {
        if (!ball) return false;

        const oldX = prevOverride
            ? prevOverride.x
            : (ball.prevX != null ? ball.prevX : ball.x);
        const oldY = prevOverride
            ? prevOverride.y
            : (ball.prevY != null ? ball.prevY : ball.y);
        const oldZ = prevOverride
            ? (prevOverride.z != null ? prevOverride.z : 0)
            : (ball.prevZ != null ? ball.prevZ : (ball.z || 0));

        const newX = ball.x;
        const newY = ball.y;
        const newZ = ball.z != null ? ball.z : 0;

        // Side of goal line: positive = pitch interior (facing into pitch from line).
        // left facing+1: side = (x - 0) * 1 = x → pitch when x > 0
        // right facing-1: side = (x - W) * -1 = W - x → pitch when x < W
        const oldSide = (oldX - this.lineX) * this.facingX;
        const newSide = (newX - this.lineX) * this.facingX;

        // Must finish on/ past the goal line plane (newSide <= 0) and start on
        // the pitch or exactly on the line (oldSide >= 0). Motion that stays in
        // the net, or leaves the net toward the pitch, is never a goal.
        if (newSide > 0) return false;
        if (oldSide < 0) return false;

        // Interpolate crossing on the goal line plane x = lineX
        let t;
        if (Math.abs(oldSide - newSide) < 1e-12) {
            // Stationary on the plane — whole ball not newly crossed
            if (oldSide > 0 && newSide > 0) return false;
            t = 0;
        } else {
            t = oldSide / (oldSide - newSide);
        }
        if (t < 0) t = 0;
        if (t > 1) t = 1;

        const crossY = oldY + t * (newY - oldY);
        const crossZ = oldZ + t * (newZ - oldZ);
        return this._pointInMouthAtLine(crossY, crossZ);
    }

    /**
     * @param {number} y
     * @param {number} z
     * @private
     */
    _pointInMouthAtLine(y, z) {
        if (y < this.yMin || y > this.yMax) return false;
        if (z > this.height) return false;
        return true;
    }

    /**
     * Solid goal frame + exterior net for free balls.
     * Open mouth (pitch → net between posts under bar) stays free so valid
     * shots still score. Balls that strike posts/bar or hit the cage from
     * outside bounce and cannot phase into the mouth volume.
     *
     * @param {{ x:number,y:number,z?:number,vx:number,vy:number,vz:number,radius?:number,owner?:object|null,prevX?:number,prevY?:number,prevZ?:number }} ball
     * @returns {boolean} true if any contact was resolved
     */
    resolveBallCollisions(ball) {
        if (!ball || ball.owner) return false;

        const r = typeof ball.radius === 'number' ? ball.radius : 0.11;
        let hit = false;

        hit = this._collidePost(ball, this.yMin, r) || hit;
        hit = this._collidePost(ball, this.yMax, r) || hit;
        hit = this._collideCrossbar(ball, r) || hit;
        hit = this._collideExteriorCage(ball, r) || hit;
        // Do NOT eject balls already past the line without scored(): OOB / set-piece
        // handling in Simulator.checkBallCollisions owns those (wide of posts →
        // corner/goalkick). Ejecting would wrongly put them back in play.
        return hit;
    }

    /**
     * @param {object} ball
     * @param {number} postY
     * @param {number} ballR
     * @private
     */
    _collidePost(ball, postY, ballR) {
        const z = ball.z || 0;
        if (z > this.height + ballR) return false;

        const dx = ball.x - this.lineX;
        const dy = ball.y - postY;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minD = GOAL_POST_RADIUS + ballR;
        if (d >= minD || d < 1e-8) return false;

        const nx = dx / d;
        const ny = dy / d;
        ball.x = this.lineX + nx * minD;
        ball.y = postY + ny * minD;
        this._bounceHorizontal(ball, nx, ny);
        return true;
    }

    /**
     * Crossbar along y at (lineX, z=height).
     * @param {object} ball
     * @param {number} ballR
     * @private
     */
    _collideCrossbar(ball, ballR) {
        const z = ball.z || 0;
        const barR = GOAL_POST_RADIUS;
        const minD = barR + ballR;

        // Closest point on bar segment y ∈ [yMin, yMax] at (lineX, height)
        let cy = ball.y;
        if (cy < this.yMin) cy = this.yMin;
        if (cy > this.yMax) cy = this.yMax;

        const dx = ball.x - this.lineX;
        const dy = ball.y - cy;
        const dz = z - this.height;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= minD || d < 1e-8) return false;

        const nx = dx / d;
        const ny = dy / d;
        const nz = dz / d;
        ball.x = this.lineX + nx * minD;
        ball.y = cy + ny * minD;
        ball.z = this.height + nz * minD;
        if (ball.z < 0) ball.z = 0;

        const vn = ball.vx * nx + ball.vy * ny + (ball.vz || 0) * nz;
        if (vn < 0) {
            ball.vx -= (1 + GOAL_FRAME_RESTITUTION) * vn * nx;
            ball.vy -= (1 + GOAL_FRAME_RESTITUTION) * vn * ny;
            ball.vz = (ball.vz || 0) - (1 + GOAL_FRAME_RESTITUTION) * vn * nz;
        }
        ball.vx *= GOAL_FRAME_TANGENT_DAMP;
        ball.vy *= GOAL_FRAME_TANGENT_DAMP;
        ball.vz = (ball.vz || 0) * GOAL_FRAME_TANGENT_DAMP;
        return true;
    }

    /**
     * One-way exterior of the net box: back, sides, top. Balls already inside
     * (valid goal path) are left alone; soft settle runs in Goal state.
     * @param {object} ball
     * @param {number} ballR
     * @private
     */
    _collideExteriorCage(ball, ballR) {
        const z = ball.z || 0;
        const back = this.netBackX();
        const yMin = this.yMin;
        const yMax = this.yMax;
        const h = this.height;

        // Expanded AABB of the cage (including ball radius)
        const xLo = this.facingX > 0 ? back - ballR : this.lineX - ballR;
        const xHi = this.facingX > 0 ? this.lineX + ballR : back + ballR;
        if (ball.x < xLo || ball.x > xHi) return false;
        if (ball.y < yMin - ballR || ball.y > yMax + ballR) return false;
        if (z < -ballR || z > h + ballR) return false;

        // Inside open mouth corridor on the pitch side of the line: free entry
        const onPitchSide = (ball.x - this.lineX) * this.facingX >= -ballR * 0.5;
        if (
            onPitchSide
            && ball.y >= yMin
            && ball.y <= yMax
            && z <= h
        ) {
            return false;
        }

        // Already fully inside mouth volume → celebration / soft net owns it
        if (this.isInMouthVolume(ball.x, ball.y, z, 0)) {
            return false;
        }

        let hit = false;

        // Back plane exterior (world-outside face)
        if (this.facingX > 0) {
            // left: exterior is x <= back
            if (ball.x <= back + ballR && ball.y >= yMin && ball.y <= yMax && z <= h) {
                if (ball.x > back - ballR * 2) {
                    ball.x = back - ballR;
                    if (ball.vx > 0) ball.vx = -Math.abs(ball.vx) * GOAL_FRAME_RESTITUTION;
                    ball.vy *= GOAL_FRAME_TANGENT_DAMP;
                    ball.vz = (ball.vz || 0) * GOAL_FRAME_TANGENT_DAMP;
                    hit = true;
                }
            }
        } else if (ball.x >= back - ballR && ball.y >= yMin && ball.y <= yMax && z <= h) {
            if (ball.x < back + ballR * 2) {
                ball.x = back + ballR;
                if (ball.vx < 0) ball.vx = Math.abs(ball.vx) * GOAL_FRAME_RESTITUTION;
                ball.vy *= GOAL_FRAME_TANGENT_DAMP;
                ball.vz = (ball.vz || 0) * GOAL_FRAME_TANGENT_DAMP;
                hit = true;
            }
        }

        // Side planes (only when ball is on the net-x slab past the goal line)
        const pastLine = (ball.x - this.lineX) * this.facingX < ballR;
        const inNetX = this.facingX > 0
            ? (ball.x <= this.lineX + ballR && ball.x >= back - ballR)
            : (ball.x >= this.lineX - ballR && ball.x <= back + ballR);

        if (pastLine && inNetX && z <= h + ballR) {
            if (ball.y < yMin + ballR && ball.y > yMin - ballR * 2) {
                ball.y = yMin - ballR;
                if (ball.vy > 0) ball.vy = -Math.abs(ball.vy) * GOAL_FRAME_RESTITUTION;
                ball.vx *= GOAL_FRAME_TANGENT_DAMP;
                hit = true;
            } else if (ball.y > yMax - ballR && ball.y < yMax + ballR * 2) {
                ball.y = yMax + ballR;
                if (ball.vy < 0) ball.vy = Math.abs(ball.vy) * GOAL_FRAME_RESTITUTION;
                ball.vx *= GOAL_FRAME_TANGENT_DAMP;
                hit = true;
            }
        }

        // Top net exterior (above cage, over net depth)
        if (inNetX && ball.y >= yMin && ball.y <= yMax && z > h - ballR && z < h + ballR * 2) {
            // Only from above when not a clean mouth cross this tick
            if (!this.scored(ball)) {
                ball.z = h + ballR;
                if ((ball.vz || 0) < 0) ball.vz = Math.abs(ball.vz || 0) * GOAL_FRAME_RESTITUTION;
                ball.vx *= GOAL_FRAME_TANGENT_DAMP;
                ball.vy *= GOAL_FRAME_TANGENT_DAMP;
                hit = true;
            }
        }

        return hit;
    }

    /**
     * @param {object} ball
     * @param {number} nx
     * @param {number} ny
     * @private
     */
    _bounceHorizontal(ball, nx, ny) {
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
            ball.vx -= (1 + GOAL_FRAME_RESTITUTION) * vn * nx;
            ball.vy -= (1 + GOAL_FRAME_RESTITUTION) * vn * ny;
        }
        ball.vx *= GOAL_FRAME_TANGENT_DAMP;
        ball.vy *= GOAL_FRAME_TANGENT_DAMP;
    }

    /**
     * Which team scores when this goal is entered (depends on half).
     * Left goal conceded by the side defending left this half.
     * @param {boolean} isSecondHalf
     * @returns {'A'|'B'}
     */
    scoringTeam(isSecondHalf) {
        // 1st half: A defends left? No — A attacks right, so A defends left... wait:
        // 1st half: A attacks +X (right goal is opp), B attacks left.
        // Ball into left goal → B scores in 1st half; A scores in 2nd half.
        if (this.side === 'left') {
            return isSecondHalf ? 'A' : 'B';
        }
        return isSecondHalf ? 'B' : 'A';
    }

    /**
     * Defending team for this goal this half.
     * @param {boolean} isSecondHalf
     * @returns {'A'|'B'}
     */
    defendingTeam(isSecondHalf) {
        return this.scoringTeam(isSecondHalf) === 'A' ? 'B' : 'A';
    }
}

module.exports = {
    Goal,
    GOAL_MOUTH_Y_REF_MIN,
    GOAL_MOUTH_Y_REF_MAX,
    GOAL_HEIGHT_REF,
    GOAL_NET_DEPTH_REF,
    GOAL_RENDER_DEPTH_REF,
    GOAL_POST_RADIUS
};
