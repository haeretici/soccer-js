#!/usr/bin/env node
/**
 * Head-to-head viability check for AI strategy presets (incl. attack shape).
 *
 * Each preset as Team A vs balanced baseline as Team B (or mirror).
 * Writes a summary table + JSON under simulations/output/preset_eval/.
 *
 * Usage:
 *   node scripts/eval_ai_presets.js
 *   node scripts/eval_ai_presets.js '{"iterations":10,"seed":7,"matchDurationSeconds":600}'
 */
const fs = require('fs');
const path = require('path');

require('../tests/mock_env.js');
const { Settings } = require('../kernel/settings.js');
const { mergeConfig, runBatch } = require('../kernel/providers/simulator/headless_runner.js');
const {
    ARCHETYPES,
    getArchetypeFullValues
} = require('../kernel/core/lib/ai_archetypes.js');
const { ALL_UI_KNOBS } = require('../kernel/core/lib/ai_ui_knobs.js');

Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };

function parseInline(argv) {
    for (const arg of argv) {
        if (!arg.startsWith('-')) {
            try {
                return JSON.parse(arg);
            } catch (_) {
                /* ignore */
            }
        }
    }
    return {};
}

function pad(str, width, right) {
    const s = String(str);
    if (s.length >= width) return s;
    const p = ' '.repeat(width - s.length);
    return right ? p + s : s + p;
}

function num(v, d) {
    if (v == null || !Number.isFinite(v)) return '-';
    return v.toFixed(d);
}

async function main() {
    const extra = parseInline(process.argv.slice(2));
    const iterations = parseInt(extra.iterations, 10) || 8;
    const seed = parseInt(extra.seed, 10) || 11;
    const matchDurationSeconds = parseInt(extra.matchDurationSeconds, 10) || 600;
    const concurrency = parseInt(extra.concurrency, 10) || 5;
    const formationA = extra.formationA || '4-4-2';
    const formationB = extra.formationB || '4-4-2';

    const balanced = getArchetypeFullValues('balanced');
    if (!balanced) {
        console.error('Missing balanced preset in ai_archetypes.json');
        process.exit(1);
    }

    const presetIds = Object.keys(ARCHETYPES).sort();
    const rows = [];

    console.log(`\nPreset viability eval: ${iterations} matches × ${matchDurationSeconds}s, seed ${seed}`);
    console.log(`Opponent (Team B): balanced  |  formations ${formationA} vs ${formationB}\n`);

    for (const id of presetIds) {
        const aiA = getArchetypeFullValues(id);
        if (!aiA) {
            console.warn(`skip ${id}: incomplete strategy knobs`);
            continue;
        }
        // Mirror match: both sides same preset (internal balance)
        // Head-to-head: preset vs balanced
        const h2hCfg = mergeConfig({
            iterations,
            seed,
            concurrency,
            headless: true,
            teamA: 'Brazil',
            teamB: 'Argentina',
            formationA,
            formationB,
            matchDurationSeconds,
            dynamicStrategyShifting: false,
            aiA,
            aiB: balanced,
            outputDir: 'simulations/output'
        });

        process.stdout.write(`  Running ${id} vs balanced… `);
        const t0 = Date.now();
        const { summary } = await runBatch(h2hCfg);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        const row = {
            id,
            label: ARCHETYPES[id].label,
            goalsPerMatch: summary.avgGoalsPerMatch,
            goalsA: summary.avgGoalsTeamA,
            goalsB: summary.avgGoalsTeamB,
            possA: summary.possession.teamASharePercent,
            possB: summary.possession.teamBSharePercent,
            shotsPerMatch: summary.tactical.shootAttemptsPerMatch,
            progPassA: summary.tactical.progressivePassesAPerMatch,
            progPassB: summary.tactical.progressivePassesBPerMatch,
            xgA: summary.tactical.xgAPerMatch,
            xgB: summary.tactical.xgBPerMatch,
            pressA: summary.tactical.pressSuccessesAPerMatch,
            passAttempts: summary.tactical.passAttemptsPerMatch,
            elapsedSec: +elapsed,
            knobs: aiA
        };
        rows.push(row);
        console.log(
            `G ${num(row.goalsA, 2)}-${num(row.goalsB, 2)}  ` +
            `poss ${num(row.possA, 0)}%  shots ${num(row.shotsPerMatch, 1)}  ` +
            `progA ${num(row.progPassA, 1)}  (${elapsed}s)`
        );
    }

    // Mirror: balanced vs balanced baseline noise floor
    {
        const cfg = mergeConfig({
            iterations,
            seed: seed + 1000,
            concurrency,
            headless: true,
            teamA: 'Brazil',
            teamB: 'Argentina',
            formationA,
            formationB,
            matchDurationSeconds,
            dynamicStrategyShifting: false,
            aiA: balanced,
            aiB: balanced,
            outputDir: 'simulations/output'
        });
        process.stdout.write('  Running balanced vs balanced (control)… ');
        const t0 = Date.now();
        const { summary } = await runBatch(cfg);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        rows.push({
            id: '_control_balanced_mirror',
            label: 'Control (balanced=balanced)',
            goalsPerMatch: summary.avgGoalsPerMatch,
            goalsA: summary.avgGoalsTeamA,
            goalsB: summary.avgGoalsTeamB,
            possA: summary.possession.teamASharePercent,
            possB: summary.possession.teamBSharePercent,
            shotsPerMatch: summary.tactical.shootAttemptsPerMatch,
            progPassA: summary.tactical.progressivePassesAPerMatch,
            progPassB: summary.tactical.progressivePassesBPerMatch,
            xgA: summary.tactical.xgAPerMatch,
            xgB: summary.tactical.xgBPerMatch,
            pressA: summary.tactical.pressSuccessesAPerMatch,
            passAttempts: summary.tactical.passAttemptsPerMatch,
            elapsedSec: +elapsed,
            knobs: balanced
        });
        console.log(
            `G ${num(summary.avgGoalsTeamA, 2)}-${num(summary.avgGoalsTeamB, 2)}  (${elapsed}s)`
        );
    }

    console.log('\n' + pad('Preset', 22) + pad('G A-B', 12, true) + pad('PossA%', 9, true) +
        pad('Shots', 8, true) + pad('ProgA', 8, true) + pad('xG A', 8, true) + pad('PressA', 8, true));
    console.log('-'.repeat(75));
    for (const r of rows) {
        console.log(
            pad(r.id, 22) +
            pad(`${num(r.goalsA, 2)}-${num(r.goalsB, 2)}`, 12, true) +
            pad(num(r.possA, 1), 9, true) +
            pad(num(r.shotsPerMatch, 1), 8, true) +
            pad(num(r.progPassA, 1), 8, true) +
            pad(num(r.xgA, 2), 8, true) +
            pad(num(r.pressA, 1), 8, true)
        );
    }

    // Heuristic viability flags
    const control = rows.find((r) => r.id === '_control_balanced_mirror');
    const controlGoals = control ? control.goalsPerMatch : 1.0;
    console.log('\nViability notes (vs balanced opponent):');
    for (const r of rows) {
        if (r.id.startsWith('_')) continue;
        const notes = [];
        if (r.goalsA + r.goalsB < 0.15) notes.push('very low scoring');
        if (r.goalsA < 0.05 && r.id !== 'catenaccio') notes.push('almost never scores');
        if (r.shotsPerMatch < 2) notes.push('few shots');
        if (r.progPassA < 1 && !['catenaccio'].includes(r.id)) notes.push('low progressive passes');
        if (r.goalsA > controlGoals * 2.5 && r.goalsB < 0.1) notes.push('may be overtuned attack');
        if (r.id === 'catenaccio' && r.goalsB > r.goalsA + 0.5) {
            /* expected to concede more when pure park vs balanced attack */
        }
        if (r.id === 'gegenpressing' || r.id === 'tiki_taka' || r.id === 'route_one') {
            if (r.goalsA + 0.05 < r.goalsB) notes.push('attacking style underperformed control');
        }
        console.log(`  ${r.id}: ${notes.length ? notes.join('; ') : 'OK'}`);
    }

    const outDir = path.resolve('simulations/output/preset_eval');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = Date.now();
    const outPath = path.join(outDir, `eval_${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        iterations,
        seed,
        matchDurationSeconds,
        formationA,
        formationB,
        uiKnobKeys: ALL_UI_KNOBS,
        rows
    }, null, 2));
    console.log(`\nWrote ${outPath}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
