#!/usr/bin/env node
/**
 * C.5 — Param sweep harness.
 *
 * Vary one AI knob across a value range; for each step run N iterations
 * over a seed range via the existing runBatch infrastructure.
 * Outputs a console summary table (goals, possession, tackles) and
 * writes detailed JSON under simulations/output/sweeps/.
 *
 * Usage:
 *   node scripts/run_param_sweep.js '<json>'
 *   node scripts/run_param_sweep.js --config path/to/sweep.json
 *
 * Minimal example:
 *   node scripts/run_param_sweep.js '{"knob":"PASS_AGGRESSION","values":[0.2,0.4,0.6,0.8]}'
 *
 * Full config fields:
 *   knob           — Settings.AI key to vary (required)
 *   values         — explicit array of values to sweep (mutually exclusive with min/max/steps)
 *   min / max      — range endpoints (used with steps; inclusive)
 *   steps          — number of evenly-spaced steps between min..max (default 5)
 *   team           — which team(s) the knob applies to: "both" (default), "A", or "B"
 *   iterations     — matches per sweep step (default 10)
 *   seed           — base seed (default 1)
 *   concurrency    — parallel workers per step (default 5)
 *   outputDir      — sweep output root (default "simulations/output/sweeps")
 *
 *   Plus any standard batch config keys forwarded to runBatch:
 *     teamA, teamB, formationA, formationB, matchDurationSeconds,
 *     fieldSizeMultiplier, ai, aiA, aiB, aiParamsFile, aiProfile, etc.
 *
 * npm script:
 *   npm run sim:sweep -- '<json>'
 */
const fs = require('fs');
const path = require('path');

require('../tests/mock_env.js');
const { Settings } = require('../kernel/settings.js');
const { mergeConfig, runBatch } = require('../kernel/providers/simulator/headless_runner.js');
const { listSettingsAiKeys, STRATEGY_KNOBS } = require('../kernel/core/lib/ai_params.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };

// ── helpers ──────────────────────────────────────────────────────────────────

function printHelp() {
    const knobs = listSettingsAiKeys().sort().join(', ');
    console.log(`C.5 — Param sweep harness

Usage:
  node scripts/run_param_sweep.js '<json>'
  node scripts/run_param_sweep.js --config path/to/sweep.json
  npm run sim:sweep -- '<json>'

Required:
  knob         AI knob to sweep (Settings.AI key).

Value range (pick one):
  values       Explicit array, e.g. [0.2, 0.5, 0.8]
  min/max      Range endpoints (inclusive), combined with steps (default 5).

Optional:
  steps        Number of evenly-spaced steps for min/max (default 5)
  team         Apply knob to: "both" (default), "A", or "B"
  iterations   Matches per sweep step (default 10)
  seed         Base seed (default 1)
  concurrency  Parallel workers per step (default 5)
  outputDir    Output root (default "simulations/output/sweeps")

  ...plus any standard batch config keys (teamA, teamB, formationA,
  formationB, matchDurationSeconds, ai, aiA, aiB, aiProfile, etc.)

Example:
  {"knob":"PASS_AGGRESSION","min":0.1,"max":0.9,"steps":5,"iterations":20}
  {"knob":"PLAYER_COMFORT_ZONE","values":[2,3,4,5,6],"iterations":10}

Available AI knobs:
  ${knobs}
`);
}

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

    if (configPath) {
        return JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
    }
    if (inlineJson) {
        return JSON.parse(inlineJson);
    }
    printHelp();
    process.exit(1);
}

/**
 * Build the list of values to sweep.
 * Accepts either an explicit `values` array or `min`/`max`/`steps`.
 */
function buildSweepValues(raw) {
    if (Array.isArray(raw.values) && raw.values.length > 0) {
        return raw.values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    }
    const min = parseFloat(raw.min);
    const max = parseFloat(raw.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        console.error('Error: provide either "values" array or "min"/"max" range.');
        process.exit(1);
    }
    const steps = Math.max(2, parseInt(raw.steps, 10) || 5);
    const vals = [];
    for (let i = 0; i < steps; i++) {
        const t = steps === 1 ? 0 : i / (steps - 1);
        vals.push(+(min + t * (max - min)).toPrecision(10));
    }
    return vals;
}

/**
 * Validate that `knob` exists on Settings.AI.
 */
function validateKnob(knob) {
    const known = new Set(listSettingsAiKeys());
    for (const k of STRATEGY_KNOBS) known.add(k);
    if (!known.has(knob)) {
        console.error(`Error: unknown AI knob "${knob}".`);
        console.error(`Available: ${[...known].sort().join(', ')}`);
        process.exit(1);
    }
}

/**
 * Build a batch config from sweep config + knob value.
 * Spreads the knob into ai / aiA / aiB depending on `team`.
 */
function buildBatchConfig(sweepCfg, knob, value, team) {
    // Clone base fields forwarded to runBatch (exclude sweep-only keys)
    const SWEEP_ONLY = new Set([
        'knob', 'values', 'min', 'max', 'steps', 'team', 'outputDir'
    ]);
    const batchInput = {};
    for (const [k, v] of Object.entries(sweepCfg)) {
        if (!SWEEP_ONLY.has(k)) batchInput[k] = v;
    }

    // Layer the swept knob value into the appropriate team slot
    const patch = { [knob]: value };
    if (team === 'A') {
        batchInput.aiA = Object.assign({}, batchInput.aiA || {}, patch);
    } else if (team === 'B') {
        batchInput.aiB = Object.assign({}, batchInput.aiB || {}, patch);
    } else {
        // "both" — set on global ai (base for both teams)
        batchInput.ai = Object.assign({}, batchInput.ai || {}, patch);
    }

    batchInput.headless = true;
    return batchInput;
}

// ── formatting helpers ───────────────────────────────────────────────────────

function pad(str, width, alignRight) {
    const s = String(str);
    if (s.length >= width) return s;
    const padding = ' '.repeat(width - s.length);
    return alignRight ? padding + s : s + padding;
}

function num(v, decimals) {
    if (v == null || !Number.isFinite(v)) return '-';
    return v.toFixed(decimals);
}

function pct(v) { return num(v, 1) + '%'; }

/**
 * Print a formatted table to stdout.
 */
function printTable(knob, team, rows) {
    const teamLabel = team === 'both' ? 'both' : `team ${team}`;
    console.log(`\n  Param sweep: ${knob} (${teamLabel})\n`);

    const headers = [
        { key: 'value', label: knob, width: 16, right: true },
        { key: 'goalsPerMatch', label: 'Goals/Match', width: 12, right: true },
        { key: 'goalsA', label: 'Goals A', width: 9, right: true },
        { key: 'goalsB', label: 'Goals B', width: 9, right: true },
        { key: 'possA', label: 'Poss A', width: 9, right: true },
        { key: 'possB', label: 'Poss B', width: 9, right: true },
        { key: 'passes', label: 'Pass/M', width: 9, right: true },
        { key: 'shots', label: 'Shot/M', width: 9, right: true },
        { key: 'tackles', label: 'Tackle/M', width: 10, right: true },
        { key: 'tackleRate', label: 'TackleRate', width: 11, right: true },
        { key: 'fouls', label: 'Foul/M', width: 9, right: true },
        { key: 'elapsed', label: 'Time (s)', width: 10, right: true }
    ];

    const headerLine = headers.map((h) => pad(h.label, h.width, h.right)).join('  ');
    const separator = headers.map((h) => '-'.repeat(h.width)).join('  ');

    console.log('  ' + headerLine);
    console.log('  ' + separator);

    for (const r of rows) {
        const cells = [
            pad(num(r.value, 4), 16, true),
            pad(num(r.goalsPerMatch, 2), 12, true),
            pad(num(r.goalsA, 2), 9, true),
            pad(num(r.goalsB, 2), 9, true),
            pad(pct(r.possA), 9, true),
            pad(pct(r.possB), 9, true),
            pad(num(r.passes, 1), 9, true),
            pad(num(r.shots, 1), 9, true),
            pad(num(r.tackles, 1), 10, true),
            pad(pct(r.tackleRate * 100), 11, true),
            pad(num(r.fouls, 1), 9, true),
            pad(num(r.elapsed, 1), 10, true)
        ];
        console.log('  ' + cells.join('  '));
    }

    console.log('');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const raw = parseArgs(process.argv.slice(2));

    const knob = raw.knob;
    if (!knob || typeof knob !== 'string') {
        console.error('Error: "knob" is required (e.g. "PASS_AGGRESSION").');
        process.exit(1);
    }
    validateKnob(knob);

    const values = buildSweepValues(raw);
    if (values.length === 0) {
        console.error('Error: sweep produced zero values.');
        process.exit(1);
    }

    const team = ['A', 'B', 'both'].includes(raw.team) ? raw.team : 'both';
    const outputDir = raw.outputDir || 'simulations/output/sweeps';

    console.log(`C.5 Param Sweep: ${knob} → [${values.join(', ')}]  (team=${team})`);
    console.log(`  ${raw.iterations || 10} iterations/step, seed=${raw.seed || 1}, concurrency=${raw.concurrency || 5}`);

    const sweepStarted = Date.now();
    const stepResults = [];

    for (let si = 0; si < values.length; si++) {
        const val = values[si];
        const label = `[${si + 1}/${values.length}] ${knob}=${val}`;
        process.stdout.write(`  ${label} … `);

        const batchInput = buildBatchConfig(raw, knob, val, team);
        const { summary } = await runBatch(batchInput);

        const row = {
            value: val,
            goalsPerMatch: summary.avgGoalsPerMatch,
            goalsA: summary.avgGoalsTeamA,
            goalsB: summary.avgGoalsTeamB,
            possA: summary.possession.teamASharePercent,
            possB: summary.possession.teamBSharePercent,
            passes: summary.tactical.passAttemptsPerMatch,
            shots: summary.tactical.shootAttemptsPerMatch,
            tackles: summary.tactical.tackleAttemptsPerMatch,
            tackleRate: summary.tactical.tackleSuccessRate,
            fouls: summary.tactical.foulsPerMatch,
            elapsed: (summary.elapsedMs || 0) / 1000
        };
        stepResults.push({ value: val, summary, row });

        console.log(`done (${num(row.elapsed, 1)}s)`);
    }

    const sweepElapsedMs = Date.now() - sweepStarted;

    // ── print table ──
    printTable(knob, team, stepResults.map((s) => s.row));
    console.log(`  Total elapsed: ${(sweepElapsedMs / 1000).toFixed(1)}s\n`);

    // ── write JSON output ──
    const sweepId = `sweep_${knob}_${Date.now()}_seed${raw.seed || 1}`;
    const outDir = path.resolve(outputDir, sweepId);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o775 });

    const output = {
        generatedAt: new Date().toISOString(),
        elapsedMs: sweepElapsedMs,
        knob,
        team,
        values,
        config: { ...raw },
        steps: stepResults.map((s) => ({
            value: s.value,
            row: s.row,
            summary: s.summary
        }))
    };

    fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify(output, null, 2));
    fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(raw, null, 2));

    // Write a compact TSV for easy spreadsheet import
    const tsvHeaders = ['value', 'goals/match', 'goalsA', 'goalsB', 'possA%', 'possB%',
        'passes/m', 'shots/m', 'tackles/m', 'tackleRate', 'fouls/m', 'elapsed_s'];
    const tsvRows = stepResults.map((s) => {
        const r = s.row;
        return [r.value, num(r.goalsPerMatch, 2), num(r.goalsA, 2), num(r.goalsB, 2),
            num(r.possA, 1), num(r.possB, 1), num(r.passes, 1), num(r.shots, 1),
            num(r.tackles, 1), num(r.tackleRate * 100, 1), num(r.fouls, 1),
            num(r.elapsed, 1)].join('\t');
    });
    fs.writeFileSync(
        path.join(outDir, 'sweep.tsv'),
        tsvHeaders.join('\t') + '\n' + tsvRows.join('\n') + '\n'
    );

    console.log(`  Output: ${outDir}/`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
