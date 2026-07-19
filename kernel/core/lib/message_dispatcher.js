/**
 * Logic-tick message dispatcher (fixed-step safe; no wall-clock delays).
 *
 * Delayed delivery uses logic ticks only — never wall-clock / setTimeout —
 * so seeded replay stays deterministic.
 */
const { createTelegram, isSoccerMessage } = require('./soccer_messages.js');

/** delayTicks === 0 means deliver on next dispatchDelayed (end of this step) or immediately */
const SEND_IMMEDIATELY = 0;

class MessageDispatcher {
    constructor() {
        /** Monotonic logic tick (advanced by Simulator each updateAll). */
        this.logicTick = 0;
        /**
         * Pending delayed telegrams, sorted by deliverAtTick.
         * @type {Array<{ deliverAtTick: number, telegram: object }>}
         */
        this.queue = [];
    }

    clear() {
        this.queue.length = 0;
        this.logicTick = 0;
    }

    /**
     * Call once per logic update (before or after AI — we flush at end of updateAll).
     */
    advanceTick() {
        this.logicTick++;
        this.dispatchDelayed();
    }

    /**
     * @param {number} delayTicks - 0 = immediate discharge
     * @param {object|null} sender
     * @param {object|null} receiver - must implement handleSoccerMessage or onMessage
     * @param {string} msgType
     * @param {object|null} [extra]
     */
    dispatch(delayTicks, sender, receiver, msgType, extra = null) {
        if (!receiver) return;
        const telegram = createTelegram(msgType, sender, receiver, extra);
        const delay = Math.max(0, Math.floor(Number(delayTicks) || 0));

        if (delay === SEND_IMMEDIATELY) {
            this.discharge(receiver, telegram);
            return;
        }

        this.queue.push({
            deliverAtTick: this.logicTick + delay,
            telegram
        });
        // Keep queue ordered by delivery time (stable for equal ticks)
        this.queue.sort((a, b) => a.deliverAtTick - b.deliverAtTick);
    }

    /**
     * Immediate convenience (same as delay 0).
     */
    dispatchImmediate(sender, receiver, msgType, extra = null) {
        this.dispatch(SEND_IMMEDIATELY, sender, receiver, msgType, extra);
    }

    /**
     * Deliver any messages whose deliverAtTick <= logicTick.
     */
    dispatchDelayed() {
        while (this.queue.length > 0 && this.queue[0].deliverAtTick <= this.logicTick) {
            const item = this.queue.shift();
            const r = item.telegram.receiver;
            if (r) {
                this.discharge(r, item.telegram);
            }
        }
    }

    /**
     * @param {object} receiver
     * @param {object} telegram
     */
    discharge(receiver, telegram) {
        if (!receiver) return;
        if (typeof receiver.handleSoccerMessage === 'function') {
            receiver.handleSoccerMessage(telegram);
            return;
        }
        // Fallback: GameObject.onMessage (async ignored for AI path)
        if (typeof receiver.onMessage === 'function') {
            const ret = receiver.onMessage(telegram);
            if (ret && typeof ret.catch === 'function') {
                ret.catch(() => {});
            }
        }
    }
}

/**
 * Resolve dispatcher from a level/root, or null.
 * @param {object|null} level
 * @returns {MessageDispatcher|null}
 */
function getDispatcher(level) {
    if (!level) return null;
    return level.msgDispatcher || null;
}

/**
 * Dispatch via level dispatcher, or discharge immediately if none (unit tests).
 */
function dispatchSoccerMsg(level, delayTicks, sender, receiver, msgType, extra = null) {
    const d = getDispatcher(level);
    if (d) {
        d.dispatch(delayTicks, sender, receiver, msgType, extra);
        return;
    }
    if (receiver && typeof receiver.handleSoccerMessage === 'function') {
        receiver.handleSoccerMessage(createTelegram(msgType, sender, receiver, extra));
    }
}

module.exports = {
    MessageDispatcher,
    SEND_IMMEDIATELY,
    getDispatcher,
    dispatchSoccerMsg,
    isSoccerMessage
};
