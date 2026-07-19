/**
 * SoundDB unit smoke — Node has no AudioContext; verify silent paths and API shape.
 */
require('./mock_env.js');
const { Settings } = require('../kernel/settings.js');
const { SoundDB, SFX_GAIN } = require('../kernel/core/lib/sounddb.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assert failed');
}

// Headless must never throw and must stay silent
Settings.HEADLESS = true;
Settings.soundsMuted = false;
assert(SoundDB.isSilent() === true, 'HEADLESS is silent');
SoundDB.play('whistle');
SoundDB.play('shot');
SoundDB.updateCrowd({ matchState: 'play', ballX: 90, fieldWidth: 106, isShot: true });
SoundDB.crowdReact('ooh', 0.5);
SoundDB.startCrowd();
SoundDB.stopCrowd();

// Known SFX table covers gameplay events we wire in match code
const required = [
    'whistle', 'whistle_long', 'whistle_end',
    'kick', 'pass', 'shot', 'lob', 'header', 'throwin', 'touch', 'bounce',
    'tackle', 'slide', 'catch', 'save',
    'foul', 'card', 'offside',
    'cheer', 'roar', 'ooh', 'boo', 'net', 'crowd_burst'
];
for (const name of required) {
    assert(SFX_GAIN[name] != null, `missing SFX_GAIN.${name}`);
}

// Mute flag also silent when not headless (still no AudioContext in Node)
Settings.HEADLESS = false;
Settings.soundsMuted = true;
assert(SoundDB.isSilent() === true, 'muted is silent');
SoundDB.play('pass');
SoundDB.stopCrowd();

// Unmuted without AudioContext: init fails gracefully
Settings.soundsMuted = false;
// Node: window exists (mock) but no AudioContext — play must not throw
const hadAC = typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined';
if (!hadAC) {
    SoundDB.play('kick');
    SoundDB.play('unknown_event_name');
    SoundDB.updateCrowd({ matchState: 'goal' });
}

// Restore defaults for other tests in cascade (if any)
Settings.HEADLESS = false;
Settings.soundsMuted = false;

if (process.env.VERBOSE) {
    console.log('sounddb: ok');
}
