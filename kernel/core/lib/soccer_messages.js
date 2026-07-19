/**
 * AI message type constants (team/player coordination telegrams).
 * Extra payload is a plain object (no void* casting).
 */

const SoccerMsg = {
    ReceiveBall: 'ReceiveBall',
    PassToMe: 'PassToMe',
    SupportAttacker: 'SupportAttacker',
    GoHome: 'GoHome',
    Wait: 'Wait'
};

/**
 * @param {string} type - SoccerMsg value
 * @param {object|null} sender
 * @param {object|null} receiver
 * @param {object|null} [extra]
 */
function createTelegram(type, sender, receiver, extra = null) {
    return {
        type,
        msg: type, // alias for type-based switch handlers
        sender,
        receiver,
        extra: extra || null
    };
}

function isSoccerMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const t = message.type || message.msg;
    return typeof t === 'string' && Object.values(SoccerMsg).includes(t);
}

module.exports = {
    SoccerMsg,
    createTelegram,
    isSoccerMessage
};
