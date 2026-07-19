const path = require('path');
const fs = require('fs');

let scratchPath = process.env.GROK_GOAL_SCRATCH;
if (!scratchPath) {
    const defaultPath = '/tmp/grok-goal-059ed50e1208/implementer';
    try {
        fs.mkdirSync(defaultPath, { recursive: true });
        fs.accessSync(defaultPath, fs.constants.W_OK);
        scratchPath = defaultPath;
    } catch (e) {
        scratchPath = path.join(__dirname, 'scratch');
    }
}

const SCRATCH = scratchPath;

module.exports = { SCRATCH };