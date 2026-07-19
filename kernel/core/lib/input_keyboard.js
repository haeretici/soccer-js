/**
 * Browser keyboard buffer for manual control (Stage 1–4).
 *
 * DOM events fill buffers; logic ticks call pollFrame() to read edges/holds.
 * Never uses Date.now for gameplay — hold duration is counted in logic ticks
 * by manual_control (Stage 2 hold-to-power; Stage 4 header power).
 */

const { Settings } = require('../../settings.js');

/** @type {Set<string>} */
const MOVE_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
]);

/** Action codes: numpad preferred; digit row as laptop fallback */
const ACTION_CODES = {
    action1: ['Numpad1', 'Digit1'],
    action2: ['Numpad2', 'Digit2'],
    action3: ['Numpad3', 'Digit3'],
    action4: ['Numpad4', 'Digit4'],
    action5: ['Numpad5', 'Digit5', 'ShiftLeft', 'ShiftRight']
};

function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    const tag = (target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
}

/**
 * @returns {{ x: number, y: number }} unit vector or zero
 */
function normalize2(x, y) {
    const len = Math.sqrt(x * x + y * y);
    if (len < 1e-6) return { x: 0, y: 0 };
    return { x: x / len, y: y / len };
}

/**
 * Raw key vector: right/left on X, down/up on Y (screen-style: up = −Y).
 * @param {Set<string>|object} downSet
 * @returns {{ x: number, y: number }} unnormalized
 */
function rawMoveAxes(downSet) {
    const has = (code) => {
        if (!downSet) return false;
        if (typeof downSet.has === 'function') return downSet.has(code);
        return !!downSet[code];
    };
    let x = 0;
    let y = 0;
    if (has('KeyD') || has('ArrowRight')) x += 1;
    if (has('KeyA') || has('ArrowLeft')) x -= 1;
    if (has('KeyS') || has('ArrowDown')) y += 1;
    if (has('KeyW') || has('ArrowUp')) y -= 1;
    return { x, y };
}

/**
 * World-space move from WASD / arrows.
 * - worldAxes (default Stage 1): W/Up → −Y, D/Right → +X
 * - screenAware: treat keys as screen directions, map via Utils.worldDeltaFromScreenDelta
 *
 * @param {Set<string>|object} downSet - Set of codes or object map
 * @param {{ screenAware?: boolean }} [opts]
 */
function moveVectorFromDown(downSet, opts = {}) {
    const raw = rawMoveAxes(downSet);
    if (raw.x === 0 && raw.y === 0) return { x: 0, y: 0 };

    const screenAware = opts.screenAware != null
        ? !!opts.screenAware
        : !!(Settings.manualControl && Settings.manualControl.screenAwareMove !== false);

    if (!screenAware) {
        return normalize2(raw.x, raw.y);
    }

    // Lazy require: utils may pull settings; avoid circular issues at load
    let worldDeltaFromScreenDelta;
    try {
        worldDeltaFromScreenDelta = require('./utils.js').Utils.worldDeltaFromScreenDelta;
    } catch (_e) {
        return normalize2(raw.x, raw.y);
    }
    if (typeof worldDeltaFromScreenDelta !== 'function') {
        return normalize2(raw.x, raw.y);
    }

    // Unit screen step is enough; result is re-normalized to world unit vector
    const world = worldDeltaFromScreenDelta(raw.x, raw.y);
    return normalize2(world.ox || 0, world.oy || 0);
}

function anyCode(downOrPressed, codes) {
    for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (typeof downOrPressed.has === 'function') {
            if (downOrPressed.has(c)) return true;
        } else if (downOrPressed[c]) {
            return true;
        }
    }
    return false;
}

/**
 * Build a command snapshot from a polled frame.
 * Stage 2: pass/lob/shoot expose down + released for hold-to-power;
 * press edges remain for off-ball tackles and charge start.
 *
 * @param {{ down: Set<string>, pressed: Set<string>, released?: Set<string> }} frame
 * @param {{ screenAware?: boolean }} [opts]
 */
function commandFromFrame(frame, opts = {}) {
    const down = frame.down || new Set();
    const pressed = frame.pressed || new Set();
    const released = frame.released || new Set();
    const move = moveVectorFromDown(down, opts);
    return {
        moveX: move.x,
        moveY: move.y,
        // Press edges (charge start + off-ball tackles)
        pass: anyCode(pressed, ACTION_CODES.action1),
        lob: anyCode(pressed, ACTION_CODES.action2),
        shoot: anyCode(pressed, ACTION_CODES.action3),
        // Held this tick
        passDown: anyCode(down, ACTION_CODES.action1),
        lobDown: anyCode(down, ACTION_CODES.action2),
        shootDown: anyCode(down, ACTION_CODES.action3),
        // Release edges (Stage 2 fire with hold power)
        passReleased: anyCode(released, ACTION_CODES.action1),
        lobReleased: anyCode(released, ACTION_CODES.action2),
        shootReleased: anyCode(released, ACTION_CODES.action3),
        switchPlayer: anyCode(pressed, ACTION_CODES.action4),
        sprint: anyCode(down, ACTION_CODES.action5),
        // Context resolved later: same edges used for tackle when off-ball
        // 1=foot, 2=slide, 3=body shove (Stage 3; with ball 3=shoot)
        tackleFoot: anyCode(pressed, ACTION_CODES.action1),
        tackleSlide: anyCode(pressed, ACTION_CODES.action2),
        tackleBody: anyCode(pressed, ACTION_CODES.action3)
    };
}

class KeyboardInput {
    constructor() {
        /** @type {Set<string>} */
        this._down = new Set();
        /** @type {Set<string>} */
        this._pressed = new Set();
        /** @type {Set<string>} */
        this._released = new Set();
        this._attached = false;
        this._onDown = null;
        this._onUp = null;
        this._enabled = true;
    }

    get enabled() {
        return this._enabled;
    }

    setEnabled(on) {
        this._enabled = !!on;
        if (!on) {
            this._down.clear();
            this._pressed.clear();
            this._released.clear();
        }
    }

    /**
     * Attach to window (browser). Safe no-op if no window.
     * @param {Window|null} [win]
     */
    attach(win) {
        if (this._attached) return;
        const w = win || (typeof window !== 'undefined' ? window : null);
        if (!w || typeof w.addEventListener !== 'function') return;

        this._onDown = (e) => {
            if (!this._enabled) return;
            if (isEditableTarget(e.target)) return;
            const code = e.code;
            if (!code) return;
            const isGameKey = MOVE_CODES.has(code)
                || code.startsWith('Numpad')
                || code === 'Digit1' || code === 'Digit2' || code === 'Digit3'
                || code === 'Digit4' || code === 'Digit5'
                || code === 'ShiftLeft' || code === 'ShiftRight';
            if (isGameKey && typeof e.preventDefault === 'function') {
                e.preventDefault();
            }
            if (!this._down.has(code)) {
                this._pressed.add(code);
            }
            this._down.add(code);
        };

        this._onUp = (e) => {
            if (!this._enabled) return;
            const code = e.code;
            if (!code) return;
            if (this._down.has(code)) {
                this._released.add(code);
            }
            this._down.delete(code);
        };

        w.addEventListener('keydown', this._onDown);
        w.addEventListener('keyup', this._onUp);
        this._attached = true;
        this._window = w;
    }

    detach() {
        if (!this._attached || !this._window) return;
        if (this._onDown) this._window.removeEventListener('keydown', this._onDown);
        if (this._onUp) this._window.removeEventListener('keyup', this._onUp);
        this._attached = false;
        this._window = null;
        this._down.clear();
        this._pressed.clear();
        this._released.clear();
    }

    /**
     * Snapshot for one logic tick, then clear edge buffers.
     * @returns {{ down: Set<string>, pressed: Set<string>, released: Set<string>, command: object }}
     */
    pollFrame() {
        const down = new Set(this._down);
        const pressed = new Set(this._pressed);
        const released = new Set(this._released);
        this._pressed.clear();
        this._released.clear();
        return {
            down,
            pressed,
            released,
            command: commandFromFrame({ down, pressed, released })
        };
    }

    /** Test helper: simulate key down */
    debugKeyDown(code) {
        if (!this._down.has(code)) this._pressed.add(code);
        this._down.add(code);
    }

    /** Test helper: simulate key up */
    debugKeyUp(code) {
        if (this._down.has(code)) this._released.add(code);
        this._down.delete(code);
    }

    /** Test helper: clear all */
    debugReset() {
        this._down.clear();
        this._pressed.clear();
        this._released.clear();
    }
}

/** Shared singleton used by the game app + simulator */
const gameKeyboard = new KeyboardInput();

module.exports = {
    KeyboardInput,
    gameKeyboard,
    moveVectorFromDown,
    commandFromFrame,
    normalize2,
    isEditableTarget,
    ACTION_CODES,
    MOVE_CODES,
    rawMoveAxes
};
