#!/usr/bin/env node
/**
 * Repeatable headless batch benchmark (default: 10 sequential matches, 300s each).
 * Usage:
 *   node scripts/profile_batch.js
 *   node scripts/profile_batch.js '{"iterations":5,"matchDurationSeconds":120}'
 */
require('../tests/mock_env.js');

const { Settings } = require('../kernel/settings.js');
const { mergeConfig, runBatchSlice } = require('../kernel/providers/simulator/headless_runner.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };

const DEFAULT = {
    iterations: 10,
    seed: 42,
    headless: true,
    concurrency: 1,
    matchDurationSeconds: 300
};

async function main() {
    const inline = process.argv[2];
    const config = mergeConfig(inline ? JSON.parse(inline) : DEFAULT);
    const started = Date.now();
    const matches = await runBatchSlice(config, 0, config.iterations);
    const elapsedMs = Date.now() - started;
    const avgFrames = matches.reduce((s, m) => s + m.frames, 0) / matches.length;
    const report = {
        elapsedMs,
        iterations: config.iterations,
        matchDurationSeconds: config.matchDurationSeconds,
        avgFramesPerMatch: avgFrames,
        effectiveUps: (avgFrames * config.iterations) / (elapsedMs / 1000),
        msPerMatch: elapsedMs / config.iterations
    };
    console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});