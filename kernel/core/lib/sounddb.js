/**
 * Web Audio SFX + crowd bed for browser matches.
 *
 * - Procedural synths by default (no assets required).
 * - Optional WAV overrides: fetch `/assets/sounds/<name>.wav` when present.
 * - Isolated LCG for noise — never Math.random() (seeded sim RNG must stay clean).
 * - Headless / muted / scrub-forward: no-ops.
 * - Crowd is a continuous low-pass noise bed with intensity driven by match state.
 */
const { Settings } = require('../../settings.js');
const { Utils } = require('./utils.js');

/** Isolated audio RNG — do not touch Utils.pseudoRandomState used by weather/VFX. */
const audioRng = {
    state: 0xA5A5F00D,
    next() {
        this.state = (this.state * 1664525 + 1013904223) >>> 0;
        return this.state / 0x100000000;
    },
    /** Signed noise sample in [-1, 1] */
    sample() {
        return this.next() * 2 - 1;
    }
};

const WAV_BASE = '/assets/sounds/';

/** Default gain per one-shot (master multiplies). */
const SFX_GAIN = {
    whistle: 0.22,
    whistle_long: 0.24,
    whistle_end: 0.26,
    kick: 0.28,
    pass: 0.22,
    shot: 0.34,
    lob: 0.26,
    header: 0.24,
    throwin: 0.2,
    touch: 0.16,
    bounce: 0.12,
    tackle: 0.28,
    slide: 0.3,
    catch: 0.22,
    save: 0.26,
    foul: 0.2,
    card: 0.18,
    offside: 0.2,
    cheer: 0.22,
    roar: 0.28,
    ooh: 0.18,
    boo: 0.14,
    net: 0.2,
    crowd_burst: 0.16
};

/** Min seconds between identical one-shots (spam guard). */
const COOLDOWN = {
    kick: 0.05,
    pass: 0.05,
    shot: 0.08,
    lob: 0.06,
    header: 0.08,
    throwin: 0.15,
    touch: 0.04,
    bounce: 0.12,
    tackle: 0.1,
    slide: 0.15,
    catch: 0.12,
    save: 0.15,
    foul: 0.3,
    card: 0.4,
    whistle: 0.25,
    whistle_long: 0.4,
    whistle_end: 0.5,
    cheer: 0.8,
    roar: 1.0,
    ooh: 0.5,
    boo: 0.6,
    net: 0.4,
    offside: 0.4,
    crowd_burst: 0.35
};

const SoundDB = {
    ctx: null,
    masterGain: null,
    sfxBus: null,
    crowdBus: null,
    /** @type {Record<string, AudioBuffer|null>} null = missing / failed */
    wavCache: {},
    /** @type {Record<string, boolean>} in-flight fetches */
    wavLoading: {},
    /** Last wall-clock play time per name (rate limit) */
    lastPlayAt: {},
    /** Crowd continuous sources */
    crowd: {
        running: false,
        noiseSrc: null,
        filter: null,
        gain: null,
        /** Target intensity 0..1 */
        target: 0.12,
        /** Smoothed intensity */
        current: 0.12,
        /** Brief spike residual */
        spike: 0,
        /** Last sim match state name for transitions */
        lastState: ''
    },
    /** Optional external volume 0..1 (UI can set later) */
    masterVolume: 1.0,

    /**
     * True when audio must not run (Node headless, mute, no window).
     */
    isSilent() {
        if (Settings.HEADLESS) return true;
        if (Settings.soundsMuted) return true;
        if (typeof window === 'undefined') return true;
        return false;
    },

    _setGainValue(node, value) {
        if (!node || !node.gain) return;
        if (typeof node.gain.value === 'number' || 'value' in node.gain) {
            try { node.gain.value = value; } catch (_) { /* param-only fakes */ }
        }
        if (typeof node.gain.setValueAtTime === 'function' && this.ctx) {
            try { node.gain.setValueAtTime(value, this.ctx.currentTime); } catch (_) { /* */ }
        }
    },

    init() {
        if (this.isSilent()) return false;
        if (this.ctx) return true;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try {
            this.ctx = new AC();
            this.masterGain = this.ctx.createGain();
            this._setGainValue(this.masterGain, this.masterVolume);
            this.masterGain.connect(this.ctx.destination);

            this.sfxBus = this.ctx.createGain();
            this._setGainValue(this.sfxBus, 1.0);
            this.sfxBus.connect(this.masterGain);

            this.crowdBus = this.ctx.createGain();
            this._setGainValue(this.crowdBus, 1.0);
            this.crowdBus.connect(this.masterGain);
            return true;
        } catch (e) {
            console.warn('AudioContext init failed:', e);
            this.ctx = null;
            return false;
        }
    },

    resume() {
        if (!this.init()) return;
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
    },

    setMasterVolume(v) {
        this.masterVolume = Math.max(0, Math.min(1, Number(v) || 0));
        if (this.masterGain && this.ctx) {
            this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
        }
    },

    /**
     * Preload optional WAV bank (non-blocking). Safe to call multiple times.
     * @param {string[]} [names]
     */
    preload(names) {
        if (this.isSilent()) return;
        const list = names || Object.keys(SFX_GAIN);
        for (const n of list) {
            this._ensureWav(n);
        }
    },

    /**
     * Play a named one-shot. Falls back to synth if no WAV.
     * @param {string} soundName
     * @param {{ volume?: number, playbackRate?: number }} [opts]
     */
    play(soundName, opts) {
        if (this.isSilent()) return;
        if (!soundName) return;
        try {
            if (!this.init()) return;
            this.resume();

            const nowWall = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() / 1000
                : Date.now() / 1000;
            const cd = COOLDOWN[soundName] != null ? COOLDOWN[soundName] : 0.08;
            const last = this.lastPlayAt[soundName] || 0;
            if (nowWall - last < cd) return;
            this.lastPlayAt[soundName] = nowWall;

            const volMul = opts && typeof opts.volume === 'number' ? opts.volume : 1;
            const rate = opts && typeof opts.playbackRate === 'number' ? opts.playbackRate : 1;
            const baseGain = SFX_GAIN[soundName] != null ? SFX_GAIN[soundName] : 0.2;
            const gain = Math.max(0.001, baseGain * volMul);

            const buf = this.wavCache[soundName];
            if (buf) {
                this._playBuffer(buf, gain, rate);
                return;
            }
            // Kick off async load for next time (if not already tried)
            if (this.wavCache[soundName] === undefined) {
                this._ensureWav(soundName);
            }

            const t0 = this.ctx.currentTime;
            this._synth(soundName, t0, gain, rate);
        } catch (e) {
            console.warn('Audio play failed:', e);
        }
    },

    /**
     * Match-driven crowd bed. Call from Play (and state enters) each logic tick or render.
     * @param {{
     *   matchState?: string,
     *   ballX?: number,
     *   fieldWidth?: number,
     *   isShot?: boolean,
     *   excitement?: number
     * }} ctx
     */
    updateCrowd(ctx) {
        if (this.isSilent()) {
            this.stopCrowd();
            return;
        }
        if (!this.init()) return;
        this.resume();

        const state = (ctx && ctx.matchState) || 'play';
        let target = 0.1;

        switch (state) {
            case 'kickoff':
                target = 0.14;
                break;
            case 'play': {
                target = 0.18;
                const fw = ctx.fieldWidth || 106;
                const bx = typeof ctx.ballX === 'number' ? ctx.ballX : fw * 0.5;
                // Higher energy when ball is in final thirds
                const edge = Math.min(bx, fw - bx) / (fw * 0.5); // 0 at goal, 1 at center
                const finalThirdBoost = (1 - Math.min(1, edge * 1.15)) * 0.22;
                target += finalThirdBoost;
                if (ctx.isShot) target += 0.2;
                if (typeof ctx.excitement === 'number') target += ctx.excitement * 0.25;
                break;
            }
            case 'goal':
                target = 0.72;
                break;
            case 'corner':
            case 'freekick':
                target = 0.32;
                break;
            case 'throwin':
            case 'goalkick':
                target = 0.16;
                break;
            case 'foul':
            case 'offside':
            case 'card':
                target = 0.12;
                break;
            case 'halftime':
                target = 0.22;
                break;
            case 'fulltime':
                target = 0.55;
                break;
            default:
                target = 0.12;
        }

        // State transition one-shots / spikes
        if (state !== this.crowd.lastState) {
            if (state === 'goal') {
                this.crowd.spike = Math.max(this.crowd.spike, 0.55);
            } else if (state === 'corner' || state === 'freekick') {
                this.crowd.spike = Math.max(this.crowd.spike, 0.18);
            } else if (state === 'fulltime') {
                this.crowd.spike = Math.max(this.crowd.spike, 0.4);
            } else if (state === 'kickoff' && this.crowd.lastState === '') {
                this.crowd.spike = Math.max(this.crowd.spike, 0.12);
            }
            this.crowd.lastState = state;
        }

        this.crowd.target = Math.max(0.04, Math.min(0.95, target));
        this._ensureCrowdRunning();
        this._tickCrowdGains();
    },

    /**
     * Brief crowd reaction without changing base state target.
     * @param {'ooh'|'cheer'|'boo'|'roar'|'burst'} kind
     * @param {number} [amount]
     */
    crowdReact(kind, amount) {
        if (this.isSilent()) return;
        const a = typeof amount === 'number' ? amount : 0.35;
        if (kind === 'ooh') {
            this.crowd.spike = Math.max(this.crowd.spike, a * 0.6);
            this.play('ooh', { volume: 0.85 });
        } else if (kind === 'cheer' || kind === 'roar') {
            this.crowd.spike = Math.max(this.crowd.spike, a);
            this.play(kind === 'roar' ? 'roar' : 'cheer');
        } else if (kind === 'boo') {
            this.play('boo', { volume: 0.7 });
        } else {
            this.crowd.spike = Math.max(this.crowd.spike, a * 0.5);
            this.play('crowd_burst', { volume: 0.8 });
        }
        this._ensureCrowdRunning();
    },

    startCrowd() {
        if (this.isSilent()) return;
        if (!this.init()) return;
        this.crowd.target = Math.max(this.crowd.target, 0.12);
        this.crowd.lastState = this.crowd.lastState || 'kickoff';
        this._ensureCrowdRunning();
        this._tickCrowdGains();
    },

    stopCrowd() {
        const c = this.crowd;
        if (c.noiseSrc) {
            try { c.noiseSrc.stop(); } catch (_) { /* already stopped */ }
            try { c.noiseSrc.disconnect(); } catch (_) { /* */ }
        }
        c.noiseSrc = null;
        c.filter = null;
        c.gain = null;
        c.running = false;
        c.spike = 0;
        c.current = 0.08;
        c.target = 0.08;
    },

    // ── internals ──────────────────────────────────────────────

    _ensureWav(name) {
        if (this.wavCache[name] !== undefined || this.wavLoading[name]) return;
        if (typeof fetch !== 'function') {
            this.wavCache[name] = null;
            return;
        }
        this.wavLoading[name] = true;
        const url = WAV_BASE + encodeURIComponent(name) + '.wav';
        fetch(url)
            .then((res) => {
                if (!res.ok) throw new Error('no wav');
                return res.arrayBuffer();
            })
            .then((ab) => {
                if (!this.ctx) {
                    // Decode after next init
                    return null;
                }
                return this.ctx.decodeAudioData(ab.slice(0));
            })
            .then((buf) => {
                this.wavCache[name] = buf || null;
            })
            .catch(() => {
                this.wavCache[name] = null;
            })
            .finally(() => {
                this.wavLoading[name] = false;
            });
    },

    _playBuffer(buffer, gainVal, rate) {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate || 1;
        const g = this.ctx.createGain();
        g.gain.value = gainVal;
        src.connect(g);
        g.connect(this.sfxBus || this.masterGain);
        src.start();
    },

    _connectSfx(node) {
        node.connect(this.sfxBus || this.masterGain);
    },

    _osc(type, freq, t0, duration, peakGain, freqEnd) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (freqEnd != null) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
        }
        g.gain.setValueAtTime(Math.max(0.0001, peakGain), t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        osc.connect(g);
        this._connectSfx(g);
        osc.start(t0);
        osc.stop(t0 + duration + 0.02);
        return { osc, g };
    },

    _noiseBuffer(seconds) {
        const sr = this.ctx.sampleRate;
        const len = Math.max(1, Math.floor(sr * seconds));
        const buffer = this.ctx.createBuffer(1, len, sr);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) {
            data[i] = audioRng.sample();
        }
        return buffer;
    },

    _playNoise(t0, duration, peakGain, filterFreq, filterType, filterEnd) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._noiseBuffer(duration + 0.05);
        const filter = this.ctx.createBiquadFilter();
        filter.type = filterType || 'lowpass';
        if (filter.frequency && typeof filter.frequency.setValueAtTime === 'function') {
            filter.frequency.setValueAtTime(filterFreq, t0);
            if (filterEnd != null) {
                if (typeof filter.frequency.linearRampToValueAtTime === 'function') {
                    filter.frequency.linearRampToValueAtTime(filterEnd, t0 + duration * 0.4);
                }
                if (typeof filter.frequency.exponentialRampToValueAtTime === 'function') {
                    filter.frequency.exponentialRampToValueAtTime(
                        Math.max(80, filterFreq * 0.5),
                        t0 + duration
                    );
                }
            }
        }
        const g = this.ctx.createGain();
        if (g.gain && typeof g.gain.setValueAtTime === 'function') {
            g.gain.setValueAtTime(0.0001, t0);
            if (typeof g.gain.linearRampToValueAtTime === 'function') {
                g.gain.linearRampToValueAtTime(peakGain, t0 + Math.min(0.05, duration * 0.15));
            }
            if (typeof g.gain.exponentialRampToValueAtTime === 'function') {
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
            }
        }
        src.connect(filter);
        filter.connect(g);
        this._connectSfx(g);
        if (typeof src.start === 'function') src.start(t0);
        if (typeof src.stop === 'function') src.stop(t0 + duration + 0.02);
    },

    /**
     * Procedural one-shots.
     */
    _synth(name, t0, gain, rate) {
        const r = rate || 1;
        const g = gain;

        switch (name) {
            case 'whistle':
                // Single short peep (kickoff / set-piece resume / foul)
                this._osc('sine', 880 * r, t0, 0.14, g, 900 * r);
                break;

            case 'whistle_long':
                this._osc('sine', 900 * r, t0, 0.55, g, 860 * r);
                this._osc('triangle', 1800 * r, t0, 0.55, g * 0.15, 1700 * r);
                break;

            case 'whistle_end':
                // Three short peeps — full time
                this._osc('sine', 920 * r, t0, 0.1, g);
                this._osc('sine', 920 * r, t0 + 0.16, 0.1, g);
                this._osc('sine', 780 * r, t0 + 0.32, 0.28, g * 1.05, 700 * r);
                break;

            case 'kick':
                this._osc('triangle', 140 * r, t0, 0.07, g, 28 * r);
                this._playNoise(t0, 0.05, g * 0.45, 900, 'lowpass', 200);
                break;

            case 'pass':
                this._osc('triangle', 160 * r, t0, 0.055, g * 0.9, 40 * r);
                this._playNoise(t0, 0.035, g * 0.3, 1200, 'lowpass', 300);
                break;

            case 'shot':
                this._osc('sawtooth', 100 * r, t0, 0.1, g, 22 * r);
                this._osc('triangle', 70 * r, t0, 0.12, g * 0.7, 18 * r);
                this._playNoise(t0, 0.08, g * 0.55, 1400, 'lowpass', 180);
                break;

            case 'lob':
                this._osc('triangle', 180 * r, t0, 0.09, g, 50 * r);
                this._playNoise(t0, 0.06, g * 0.35, 1600, 'bandpass', 400);
                break;

            case 'header':
                this._osc('sine', 220 * r, t0, 0.05, g * 0.8, 90 * r);
                this._playNoise(t0, 0.04, g * 0.5, 600, 'lowpass', 150);
                break;

            case 'throwin':
                this._playNoise(t0, 0.08, g, 400, 'lowpass', 120);
                this._osc('triangle', 90 * r, t0 + 0.02, 0.06, g * 0.5, 40 * r);
                break;

            case 'touch':
                this._osc('sine', 200 * r, t0, 0.04, g, 60 * r);
                this._playNoise(t0, 0.03, g * 0.35, 800, 'lowpass', 200);
                break;

            case 'bounce':
                this._osc('sine', 180 * r, t0, 0.035, g * 0.7, 70 * r);
                this._playNoise(t0, 0.025, g * 0.25, 1000, 'highpass', 400);
                break;

            case 'tackle':
                this._osc('sine', 90 * r, t0, 0.07, g, 12 * r);
                this._playNoise(t0, 0.06, g * 0.55, 500, 'lowpass', 100);
                break;

            case 'slide':
                this._playNoise(t0, 0.18, g * 0.7, 2200, 'highpass', 600);
                this._osc('sawtooth', 60 * r, t0 + 0.02, 0.1, g * 0.4, 20 * r);
                break;

            case 'catch':
                this._playNoise(t0, 0.05, g * 0.6, 700, 'lowpass', 200);
                this._osc('triangle', 140 * r, t0, 0.06, g * 0.5, 50 * r);
                break;

            case 'save':
                this._playNoise(t0, 0.07, g * 0.7, 900, 'lowpass', 250);
                this._osc('triangle', 110 * r, t0, 0.08, g * 0.6, 30 * r);
                this.crowd.spike = Math.max(this.crowd.spike, 0.2);
                break;

            case 'foul':
                this._playNoise(t0, 0.1, g * 0.5, 350, 'lowpass', 100);
                this._osc('sine', 70 * r, t0, 0.12, g * 0.6, 25 * r);
                break;

            case 'card':
                // Sharp plastic-ish flick
                this._osc('square', 1400 * r, t0, 0.04, g * 0.35, 900 * r);
                this._playNoise(t0, 0.03, g * 0.4, 3000, 'highpass', 1200);
                break;

            case 'offside':
                this._osc('sine', 760 * r, t0, 0.1, g);
                this._osc('sine', 640 * r, t0 + 0.12, 0.14, g * 0.9);
                break;

            case 'net':
                this._playNoise(t0, 0.2, g * 0.45, 1800, 'bandpass', 400);
                this._osc('triangle', 200 * r, t0, 0.15, g * 0.3, 80 * r);
                break;

            case 'cheer':
            case 'roar': {
                const dur = name === 'roar' ? 2.2 : 1.5;
                const peak = name === 'roar' ? g * 1.15 : g;
                this._playNoise(t0, dur, peak, 350, 'lowpass', 900);
                // Second band for “voices”
                this._playNoise(t0 + 0.05, dur * 0.9, peak * 0.55, 1200, 'bandpass', 600);
                this.crowd.spike = Math.max(this.crowd.spike, name === 'roar' ? 0.65 : 0.5);
                this._ensureCrowdRunning();
                break;
            }

            case 'ooh':
                this._playNoise(t0, 0.7, g, 500, 'bandpass', 900);
                this._osc('sine', 320 * r, t0, 0.45, g * 0.25, 280 * r);
                this.crowd.spike = Math.max(this.crowd.spike, 0.28);
                this._ensureCrowdRunning();
                break;

            case 'boo':
                this._playNoise(t0, 0.9, g * 0.7, 200, 'lowpass', 120);
                this._osc('sawtooth', 90 * r, t0, 0.6, g * 0.15, 70 * r);
                break;

            case 'crowd_burst':
                this._playNoise(t0, 0.55, g, 400, 'lowpass', 700);
                this.crowd.spike = Math.max(this.crowd.spike, 0.22);
                this._ensureCrowdRunning();
                break;

            default:
                // Unknown name — soft click so wiring is audible during dev
                this._osc('sine', 440 * r, t0, 0.05, g * 0.3, 220 * r);
                break;
        }
    },

    _ensureCrowdRunning() {
        if (this.crowd.running || !this.ctx) return;
        try {
            // Long seamless noise buffer looped as stadium bed
            const seconds = 2.5;
            const buffer = this._noiseBuffer(seconds);
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = true;

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            if (filter.frequency) {
                if ('value' in filter.frequency) filter.frequency.value = 450;
                if (typeof filter.frequency.setValueAtTime === 'function') {
                    filter.frequency.setValueAtTime(450, this.ctx.currentTime);
                }
            }
            if (filter.Q && 'value' in filter.Q) filter.Q.value = 0.7;

            const gain = this.ctx.createGain();
            this._setGainValue(gain, 0.0001);

            src.connect(filter);
            filter.connect(gain);
            gain.connect(this.crowdBus || this.masterGain);
            if (typeof src.start === 'function') src.start();

            this.crowd.noiseSrc = src;
            this.crowd.filter = filter;
            this.crowd.gain = gain;
            this.crowd.running = true;
        } catch (e) {
            console.warn('Crowd start failed:', e);
            this.crowd.running = false;
        }
    },

    _tickCrowdGains() {
        if (!this.crowd.running || !this.ctx || !this.crowd.gain) return;
        const now = this.ctx.currentTime;
        // Smooth toward target + decay spike
        const c = this.crowd;
        c.spike *= 0.92;
        if (c.spike < 0.01) c.spike = 0;
        const desired = Math.min(0.95, c.target + c.spike);
        // One-pole toward desired (frame-rate independent-ish)
        c.current += (desired - c.current) * 0.12;

        const level = Math.max(0.0001, c.current * 0.22 * this.masterVolume);
        if (c.gain.gain) {
            if (typeof c.gain.gain.setTargetAtTime === 'function') {
                c.gain.gain.setTargetAtTime(level, now, 0.08);
            } else if ('value' in c.gain.gain) {
                c.gain.gain.value = level;
            }
        }

        // Brighter filter when louder (more “excited” crowd)
        if (c.filter && c.filter.frequency) {
            const freq = 280 + c.current * 720;
            if (typeof c.filter.frequency.setTargetAtTime === 'function') {
                c.filter.frequency.setTargetAtTime(freq, now, 0.12);
            } else if ('value' in c.filter.frequency) {
                c.filter.frequency.value = freq;
            }
        }
    },

    /** Legacy helper used by older call sites / tests */
    beep(freq, duration, time) {
        if (!this.ctx) return;
        this._osc('sine', freq, time, duration, 0.1);
    }
};

module.exports = { SoundDB, SFX_GAIN };
