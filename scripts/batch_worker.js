#!/usr/bin/env node
/**
 * Forked worker process for parallel headless batch slices.
 * Receives { config, startIndex, count } via IPC and returns match telemetry.
 */
require('../tests/mock_env.js');

const { Settings } = require('../kernel/settings.js');
const { runBatchSlice } = require('../kernel/providers/simulator/headless_runner.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };

process.on('message', async (msg) => {
    try {
        const { config, startIndex, count } = msg;
        const matches = await runBatchSlice(config, startIndex, count);
        if (typeof process.send === 'function') {
            process.send({ matches });
        }
        process.exit(0);
    } catch (err) {
        if (typeof process.send === 'function') {
            process.send({ error: String(err && err.stack ? err.stack : err) });
        }
        process.exit(1);
    }
});