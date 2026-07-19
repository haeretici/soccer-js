// Minimal browser-like globals for Node harness tests
if (!process.env.VERBOSE) {
    console.log = () => {};
}
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

if (typeof global.performance === 'undefined') {
    global.performance = { now: () => Date.now() };
}

if (typeof global.window === 'undefined') {
    global.window = global;
}

function readFileBuffer(url) {
    const filePath = path.join(root, String(url).replace(/^\//, ''));
    return fs.readFileSync(filePath);
}

global.fetch = async (url) => {
    const filePath = path.join(root, String(url).replace(/^\//, ''));
    if (String(url).endsWith('.bin')) {
        const buffer = fs.readFileSync(filePath);
        return {
            ok: true,
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        };
    }
    const body = fs.readFileSync(filePath, 'utf8');
    return {
        ok: true,
        json: async () => JSON.parse(body)
    };
};

function createPixelCanvas(initialWidth = 96, initialHeight = 96) {
    let width = initialWidth;
    let height = initialHeight;
    let data = new Uint8ClampedArray(width * height * 4);

    const resizeBuffer = () => {
        const next = new Uint8ClampedArray(width * height * 4);
        next.set(data.subarray(0, Math.min(data.length, next.length)));
        data = next;
        ctx._data = data;
        ctx._width = width;
        ctx._height = height;
    };

    const ctx = {
        imageSmoothingEnabled: true,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        _data: data,
        _width: width,
        _height: height,
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        arc() {},
        ellipse() {},
        fill() {},
        stroke() {},
        _tx: 0,
        _ty: 0,
        _states: [],
        save() {
            this._states.push({ tx: this._tx, ty: this._ty });
        },
        restore() {
            const state = this._states.pop();
            if (state) {
                this._tx = state.tx;
                this._ty = state.ty;
            }
        },
        translate(x, y) {
            this._tx += x;
            this._ty += y;
        },
        scale() {},
        rotate() {},
        setTransform() {},
        drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
            let img = src;
            let sdx = 0;
            let sdy = 0;
            let srcW = img.width || 0;
            let srcH = img.height || 0;
            let destX = 0;
            let destY = 0;
            let destW = srcW;
            let destH = srcH;

            if (arguments.length === 3) {
                destX = sx + (this._tx || 0);
                destY = sy + (this._ty || 0);
            } else if (arguments.length === 5) {
                sdx = sx;
                sdy = sy;
                destW = sw;
                destH = sh;
            } else if (arguments.length === 9) {
                sdx = sx;
                sdy = sy;
                srcW = sw;
                srcH = sh;
                destX = dx + (this._tx || 0);
                destY = dy + (this._ty || 0);
                destW = dw;
                destH = dh;
            }

            const getSrcPixel = (x, y) => {
                if (img.getContext) {
                    const sctx = img.getContext('2d');
                    const sdata = sctx._data;
                    const sw = sctx._width;
                    if (x < 0 || y < 0 || x >= sw || y >= sctx._height) return [0, 0, 0, 0];
                    const idx = (sw * y + x) << 2;
                    return [sdata[idx], sdata[idx + 1], sdata[idx + 2], sdata[idx + 3]];
                }
                return [0, 0, 0, 0];
            };

            for (let y = 0; y < destH; y++) {
                for (let x = 0; x < destW; x++) {
                    const srcX = Math.floor(sdx + (x / Math.max(1, destW)) * srcW);
                    const srcY = Math.floor(sdy + (y / Math.max(1, destH)) * srcH);
                    const dstX = Math.floor(destX + x);
                    const dstY = Math.floor(destY + y);
                    if (dstX < 0 || dstY < 0 || dstX >= width || dstY >= height) continue;
                    const px = getSrcPixel(srcX, srcY);
                    if (px[3] === 0) continue;
                    const dstIdx = (width * dstY + dstX) << 2;
                    data[dstIdx] = px[0];
                    data[dstIdx + 1] = px[1];
                    data[dstIdx + 2] = px[2];
                    data[dstIdx + 3] = px[3];
                }
            }
        },
        createImageData(w, h) {
            return {
                data: new Uint8ClampedArray(w * h * 4),
                width: w,
                height: h
            };
        },
        getImageData(x, y, w, h) {
            const out = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++) {
                for (let col = 0; col < w; col++) {
                    const srcIdx = ((y + row) * width + (x + col)) * 4;
                    const dstIdx = (row * w + col) * 4;
                    out[dstIdx] = data[srcIdx];
                    out[dstIdx + 1] = data[srcIdx + 1];
                    out[dstIdx + 2] = data[srcIdx + 2];
                    out[dstIdx + 3] = data[srcIdx + 3];
                }
            }
            return { data: out, width: w, height: h };
        },
        putImageData(imageData, dx, dy) {
            const w = imageData.width;
            const h = imageData.height;
            for (let row = 0; row < h; row++) {
                for (let col = 0; col < w; col++) {
                    const srcIdx = (row * w + col) * 4;
                    const dstIdx = ((dy + row) * width + (dx + col)) * 4;
                    data[dstIdx] = imageData.data[srcIdx];
                    data[dstIdx + 1] = imageData.data[srcIdx + 1];
                    data[dstIdx + 2] = imageData.data[srcIdx + 2];
                    data[dstIdx + 3] = imageData.data[srcIdx + 3];
                }
            }
        }
    };
    const canvas = {
        get width() { return width; },
        set width(v) { width = v; resizeBuffer(); },
        get height() { return height; },
        set height(v) { height = v; resizeBuffer(); },
        getContext: () => ctx
    };
    return canvas;
}

function makeCanvas() {
    return createPixelCanvas(96, 96);
}

function makeInputStub(value = '1') {
    return {
        value,
        innerText: value,
        addEventListener() {},
        disabled: false,
        options: [{ value: 'Brazil' }, { value: 'Argentina' }],
        classList: {
            add() {},
            remove() {},
            contains() { return false; },
            toggle() {}
        }
    };
}

const domListeners = {};
const selectDefaults = {
    teamASelect: 'Brazil',
    teamBSelect: 'Argentina',
    formationASelect: '4-4-2',
    formationBSelect: '4-4-2'
};

const documentStub = {
    getElementById: (id) => {
        if (id === 'gameCanvas') return { scrollIntoView() {} };
        if (selectDefaults[id]) return makeInputStub(selectDefaults[id]);
        if (id.startsWith('formationHold') || id.startsWith('attackSupport') || id.startsWith('defensivePress') || id.startsWith('passAggression')) {
            return null;
        }
        return makeInputStub();
    },
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}),
    addEventListener: (type, fn) => { domListeners[type] = fn; },
    removeEventListener: () => {},
    querySelector: () => ({
        appendChild() {},
        style: {},
        addEventListener() {},
        classList: {
            add() {},
            remove() {},
            toggle() {},
            contains() { return false; }
        }
    }),
    querySelectorAll: () => [],
    _fireDOMContentLoaded: () => { if (domListeners.DOMContentLoaded) domListeners.DOMContentLoaded(); }
};

if (typeof global.document === 'undefined') {
    global.document = documentStub;
} else {
    for (const [k, v] of Object.entries(documentStub)) {
        if (typeof global.document[k] !== 'function') global.document[k] = v;
    }
}

function fakeAudioParam(initial = 0) {
    return {
        value: initial,
        setValueAtTime() {},
        setTargetAtTime() {},
        exponentialRampToValueAtTime() {},
        linearRampToValueAtTime() {}
    };
}

class FakeAudioContext {
    constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.sampleRate = 44100;
        this.destination = {};
    }
    resume() { return Promise.resolve(); }
    createOscillator() {
        return {
            type: 'sine',
            frequency: fakeAudioParam(440),
            connect() {},
            start() {},
            stop() {}
        };
    }
    createGain() {
        return {
            gain: fakeAudioParam(1),
            connect() {}
        };
    }
    createBuffer(_channels, length) {
        const n = Math.max(1, length | 0);
        const data = new Float32Array(n);
        return {
            length: n,
            sampleRate: this.sampleRate,
            getChannelData: () => data
        };
    }
    createBufferSource() {
        return {
            buffer: null,
            loop: false,
            playbackRate: fakeAudioParam(1),
            connect() {},
            start() {},
            stop() {}
        };
    }
    createBiquadFilter() {
        return {
            type: 'lowpass',
            Q: fakeAudioParam(1),
            frequency: fakeAudioParam(350),
            connect() {}
        };
    }
    decodeAudioData(ab) {
        return Promise.resolve(this.createBuffer(1, 8));
    }
}

global.AudioContext = FakeAudioContext;
global.webkitAudioContext = FakeAudioContext;

global.Image = class Image {
    constructor() {
        this.onload = null;
        this.onerror = null;
        this.src = '';
        this.width = 0;
        this.height = 0;
    }

    set src(url) {
        this._url = url;
        try {
            readFileBuffer(url);
            if (this.onload) setTimeout(() => this.onload(), 0);
        } catch (err) {
            if (this.onerror) setTimeout(() => this.onerror(err), 0);
        }
    }

    get src() {
        return this._url || '';
    }
};

module.exports = {};