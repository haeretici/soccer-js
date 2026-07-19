#!/usr/bin/env node
/**
 * Headless batch simulation CLI.
 * Usage:
 *   node scripts/run_batch_sim.js '{"iterations":5,"seed":42,"headless":true}'
 *   node scripts/run_batch_sim.js --config simulations/config.json
 *   npm run sim:batch -- '{"iterations":10,"seed":1}'
 */
const fs = require('fs');
const path = require('path');

require('../tests/mock_env.js');
const { Settings } = require('../kernel/settings.js');
const { mergeConfig, runBatch } = require('../kernel/providers/simulator/headless_runner.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };

function parseArgs(argv) {
    let configPath = null;
    let inlineJson = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--config' || arg === '-c') {
            configPath = argv[i + 1];
            i++;
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else if (!arg.startsWith('-')) {
            inlineJson = arg;
        }
    }

    let raw = {};
    if (configPath) {
        const abs = path.resolve(configPath);
        raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } else if (inlineJson) {
        raw = JSON.parse(inlineJson);
    } else {
        printHelp();
        process.exit(1);
    }

    return mergeConfig(raw);
}

function printHelp() {
    console.log(`Headless batch simulator

Usage:
  node scripts/run_batch_sim.js '<json>'
  node scripts/run_batch_sim.js --config path/to/config.json

JSON fields:
  iterations, seed, headless, outputDir, concurrency, teamA, teamB,
  formationA, formationB (4-4-2, 4-3-3, 3-5-2, 4-2-3-1, 4-1-4-1, 5-3-2, 3-4-3, 4-5-1),
  matchDurationSeconds, fieldSizeMultiplier,
  timeSpeed, maxFramesPerMatch,
  ai { ... } — any Settings.AI keys (strategy knobs, comfort zone, support grid, …) for both teams,
  aiA / aiB { ... } — per-team overlays (same key set),
  aiParamsFile — path to presets/ai_params.json (or custom AI params file),
  aiProfile — named profile inside that file (e.g. high_press, pass_heavy),
  loadAiParamsDefaults — if true, load presets/ai_params.json defaults without setting aiParamsFile

concurrency — parallel worker processes (default 5, capped at iterations)

Example:
  {"iterations":20,"seed":1,"aiProfile":"high_press","aiParamsFile":"presets/ai_params.json"}
  {"iterations":10,"ai":{"PLAYER_COMFORT_ZONE":4,"PASS_AGGRESSION":0.8},"aiA":{"FORMATION_HOLD":0.7}}
`);
}

async function main() {
    const config = parseArgs(process.argv.slice(2));
    const { matches, summary } = await runBatch(config);

    const batchId = `batch_${Date.now()}_seed${config.seed}`;
    const outDir = path.resolve(config.outputDir, batchId);
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'telemetry.json'), JSON.stringify(matches, null, 2));
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(config, null, 2));

    const report = {
        outputDir: outDir,
        concurrency: config.concurrency,
        workerProcessesUsed: summary.config.workerProcessesUsed,
        elapsedSeconds: summary.elapsedSeconds,
        elapsedMs: summary.elapsedMs,
        completedMatches: summary.completedMatches,
        avgGoalsPerMatch: summary.avgGoalsPerMatch,
        possession: summary.possession,
        tactical: summary.tactical
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});