#!/usr/bin/env node
/**
 * Large-batch AI preset tuner (~800 matches by default).
 *
 * Phases:
 *   1. side_swap — each preset vs balanced as Team A and Team B (cancels squad bias)
 *   2. mirror    — same preset both sides
 *   3. classic   — stylistic head-to-heads
 *   4. confirm   — optional second pass after manual JSON edits (pass --phase=confirm)
 *
 * Usage:
 *   node scripts/tune_ai_presets.js
 *   node scripts/tune_ai_presets.js '{"sideSwapIters":32,"mirrorIters":16,"classicIters":20}'
 *   node scripts/tune_ai_presets.js '{"phase":"confirm","confirmIters":16}'
 *
 * Output: simulations/output/preset_tune/tune_<stamp>.json + summary on stderr
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
        if (!arg.startsWith('-') && arg.startsWith('{')) {
            try {
                return JSON.parse(arg);
            } catch (_) { /* ignore */ }
        }
    }
    return {};
}

function log(msg) {
    process.stderr.write(String(msg) + '\n');
}

function num(v, d = 2) {
    if (v == null || !Number.isFinite(v)) return '-';
    return Number(v).toFixed(d);
}

function extractSummary(s) {
    return {
        goalsPerMatch: s.avgGoalsPerMatch,
        goalsA: s.avgGoalsTeamA,
        goalsB: s.avgGoalsTeamB,
        possA: s.possession.teamASharePercent,
        possB: s.possession.teamBSharePercent,
        shots: s.tactical.shootAttemptsPerMatch,
        passAttempts: s.tactical.passAttemptsPerMatch,
        progA: s.tactical.progressivePassesAPerMatch,
        progB: s.tactical.progressivePassesBPerMatch,
        xgA: s.tactical.xgAPerMatch,
        xgB: s.tactical.xgBPerMatch,
        pressA: s.tactical.pressSuccessesAPerMatch,
        pressB: s.tactical.pressSuccessesBPerMatch,
        tackles: s.tactical.tackleAttemptsPerMatch
    };
}

async function batch(label, opts) {
    const cfg = mergeConfig({
        iterations: opts.iterations,
        seed: opts.seed,
        concurrency: opts.concurrency,
        headless: true,
        teamA: opts.teamA || 'Brazil',
        teamB: opts.teamB || 'Argentina',
        formationA: opts.formationA || '4-4-2',
        formationB: opts.formationB || '4-4-2',
        matchDurationSeconds: opts.matchDurationSeconds,
        dynamicStrategyShifting: false,
        aiA: opts.aiA,
        aiB: opts.aiB,
        outputDir: 'simulations/output'
    });
    const t0 = Date.now();
    const { summary } = await runBatch(cfg);
    const row = {
        label,
        iterations: opts.iterations,
        seed: opts.seed,
        elapsedSec: (Date.now() - t0) / 1000,
        ...extractSummary(summary)
    };
    log(
        `  ${label.padEnd(36)} G ${num(row.goalsA)}-${num(row.goalsB)}` +
        ` tot ${num(row.goalsPerMatch)} shots ${num(row.shots, 1)}` +
        ` prog ${num(row.progA, 1)}/${num(row.progB, 1)}` +
        ` (${num(row.elapsedSec, 1)}s)`
    );
    return row;
}

/**
 * Side-swap net metrics for a style vs balanced.
 * styleAsA: style@A vs bal@B
 * styleAsB: bal@A vs style@B
 */
function combineSideSwap(id, styleAsA, styleAsB) {
    // Goals scored / conceded by the style (average of both sides)
    const goalsFor = 0.5 * (styleAsA.goalsA + styleAsB.goalsB);
    const goalsAgainst = 0.5 * (styleAsA.goalsB + styleAsB.goalsA);
    const gd = goalsFor - goalsAgainst;
    const poss = 0.5 * (styleAsA.possA + styleAsB.possB);
    const prog = 0.5 * (styleAsA.progA + styleAsB.progB);
    const xgFor = 0.5 * (styleAsA.xgA + styleAsB.xgB);
    const xgAgainst = 0.5 * (styleAsA.xgB + styleAsB.xgA);
    const press = 0.5 * (styleAsA.pressA + styleAsB.pressB);
    const shots = 0.5 * (styleAsA.shots + styleAsB.shots);
    const passes = 0.5 * (styleAsA.passAttempts + styleAsB.passAttempts);
    return {
        id,
        goalsFor,
        goalsAgainst,
        gd,
        poss,
        prog,
        xgFor,
        xgAgainst,
        press,
        shots,
        passes,
        styleAsA,
        styleAsB
    };
}

function analyze(sideSwap, mirrors, classic) {
    const notes = [];
    const byId = Object.fromEntries(sideSwap.map((r) => [r.id, r]));
    const bal = byId.balanced;

    for (const r of sideSwap) {
        const n = [];
        if (r.goalsFor + r.goalsAgainst < 0.4) n.push('very low scoring');
        if (r.shots < 8) n.push('few shots');
        if (r.passes < 40) n.push('pass starvation');

        if (r.id === 'catenaccio') {
            if (bal && r.goalsAgainst > bal.goalsAgainst + 0.25) n.push('concedes more than balanced (deep block weak)');
            if (bal && r.prog > bal.prog * 0.85) n.push('prog passes too high for park-the-bus');
            if (r.goalsFor > (bal ? bal.goalsFor : 1) + 0.2) n.push('scores too freely for defensive style');
        }
        if (r.id === 'tiki_taka') {
            if (bal && r.prog < bal.prog) n.push('prog passes below balanced');
            if (bal && r.passes < bal.passes) n.push('pass volume not elevated');
            if (bal && r.gd < bal.gd - 0.55) n.push('underperforms balanced badly');
        }
        if (r.id === 'gegenpressing') {
            if (bal && r.press < bal.press) n.push('press successes not elevated');
            if (bal && r.gd < bal.gd - 0.55) n.push('underperforms balanced badly');
        }
        if (r.id === 'route_one') {
            if (bal && r.prog < bal.prog * 0.9) n.push('not progressive enough for direct style');
            if (bal && r.gd < bal.gd - 0.65) n.push('too open / ineffective');
        }
        if (r.id === 'wing_play') {
            if (bal && r.gd < bal.gd - 0.55) n.push('underperforms balanced badly');
        }
        if (r.id === 'structured_counter') {
            if (bal && r.gd < bal.gd - 0.55) n.push('underperforms balanced badly');
        }

        // All non-balanced: stay within ~0.7 GD of balanced for "viable"
        if (r.id !== 'balanced' && bal) {
            const gap = r.gd - bal.gd;
            if (gap < -0.7) n.push(`GD gap vs bal ${gap.toFixed(2)} (open/weak)`);
            if (gap > 0.7) n.push(`GD gap vs bal +${gap.toFixed(2)} (maybe overtuned)`);
        }

        notes.push({ id: r.id, notes: n, ok: n.length === 0 });
    }

    // Mirror health
    for (const m of mirrors) {
        if (m.goalsPerMatch < 0.3) {
            notes.push({ id: m.label, notes: ['mirror almost scoreless'], ok: false });
        }
    }

    return notes;
}

/**
 * Heuristic knob deltas from side-swap analysis (applied by writer after review).
 * Returns suggested patches { id: { key: newVal } } — only meaningful changes.
 */
function suggestPatches(sideSwap) {
    const byId = Object.fromEntries(sideSwap.map((r) => [r.id, r]));
    const bal = byId.balanced;
    const patches = {};

    function patch(id, key, val) {
        if (!patches[id]) patches[id] = {};
        patches[id][key] = val;
    }

    if (!bal) return patches;

    for (const r of sideSwap) {
        if (r.id === 'balanced') continue;
        const arch = getArchetypeFullValues(r.id);
        if (!arch) continue;
        const gap = r.gd - bal.gd;

        // Too open / weak: pull line back slightly, raise hold a touch, cut push
        if (gap < -0.45) {
            if (arch.ATTACK_DEPTH_BIAS_REF > 9) {
                patch(r.id, 'ATTACK_DEPTH_BIAS_REF', Math.max(9, +(arch.ATTACK_DEPTH_BIAS_REF - 1.5).toFixed(1)));
            }
            if (arch.ATTACK_SUPPORT_PUSH_SCALE > 1.05) {
                patch(r.id, 'ATTACK_SUPPORT_PUSH_SCALE', +Math.max(1.05, arch.ATTACK_SUPPORT_PUSH_SCALE - 0.1).toFixed(2));
            }
            if (arch.FORMATION_HOLD < 0.7) {
                patch(r.id, 'FORMATION_HOLD', +Math.min(0.7, arch.FORMATION_HOLD + 0.05).toFixed(2));
            }
            // Help conversion a bit
            if (arch.PASS_AGGRESSION < 0.85 && ['tiki_taka', 'gegenpressing', 'route_one', 'wing_play'].includes(r.id)) {
                patch(r.id, 'PASS_AGGRESSION', +Math.min(0.85, arch.PASS_AGGRESSION + 0.05).toFixed(2));
            }
        }

        // Defensive identity: catenaccio
        if (r.id === 'catenaccio') {
            if (r.goalsAgainst > bal.goalsAgainst + 0.15) {
                // deeper / tighter
                patch(r.id, 'ATTACK_DEPTH_BIAS_REF', Math.min(arch.ATTACK_DEPTH_BIAS_REF, 3.0));
                patch(r.id, 'ATTACK_SUPPORT_INTENSITY', Math.min(arch.ATTACK_SUPPORT_INTENSITY, 0.15));
                patch(r.id, 'DEFENSIVE_PRESS_INTENSITY', Math.min(arch.DEFENSIVE_PRESS_INTENSITY, 0.28));
            }
            if (r.goalsFor > bal.goalsFor + 0.15) {
                patch(r.id, 'PASS_AGGRESSION', Math.min(arch.PASS_AGGRESSION, 0.22));
                patch(r.id, 'ATTACK_SUPPORT_PUSH_SCALE', Math.min(arch.ATTACK_SUPPORT_PUSH_SCALE, 0.5));
            }
            if (r.prog > bal.prog * 0.75) {
                patch(r.id, 'ATTACK_SUPPORT_INTENSITY', Math.min(arch.ATTACK_SUPPORT_INTENSITY, 0.15));
            }
        }

        // Tiki: need more prog / pass volume if missing
        if (r.id === 'tiki_taka') {
            if (r.prog < bal.prog) {
                patch(r.id, 'ATTACK_SUPPORT_INTENSITY', Math.min(0.92, arch.ATTACK_SUPPORT_INTENSITY + 0.04));
                patch(r.id, 'ATTACK_SUPPORT_FORM_PULL', Math.max(0.28, arch.ATTACK_SUPPORT_FORM_PULL - 0.05));
                patch(r.id, 'ATTACK_SUPPORT_OWN_HALF_BLEND', Math.min(0.85, arch.ATTACK_SUPPORT_OWN_HALF_BLEND + 0.05));
            }
            if (r.passes < bal.passes) {
                patch(r.id, 'PASS_AGGRESSION', Math.min(0.78, Math.max(arch.PASS_AGGRESSION, 0.7)));
                patch(r.id, 'FORMATION_HOLD', Math.max(0.22, arch.FORMATION_HOLD - 0.03));
            }
        }

        // Gegenpress: elevate press if flat
        if (r.id === 'gegenpressing') {
            if (r.press <= bal.press + 0.3) {
                patch(r.id, 'DEFENSIVE_PRESS_INTENSITY', Math.min(0.95, arch.DEFENSIVE_PRESS_INTENSITY + 0.03));
            }
            if (gap < -0.35) {
                // slightly less kamikaze line
                patch(r.id, 'ATTACK_DEPTH_BIAS_REF', Math.max(11, +(arch.ATTACK_DEPTH_BIAS_REF - 1).toFixed(1)));
                patch(r.id, 'ATTACK_SUPPORT_FORM_PULL', Math.min(0.55, arch.ATTACK_SUPPORT_FORM_PULL + 0.05));
            }
        }

        // Route one: ensure vertical progressive bias
        if (r.id === 'route_one') {
            if (r.prog < bal.prog) {
                patch(r.id, 'PASS_AGGRESSION', Math.min(0.88, arch.PASS_AGGRESSION + 0.04));
                patch(r.id, 'ATTACK_SUPPORT_PUSH_SCALE', Math.min(1.4, arch.ATTACK_SUPPORT_PUSH_SCALE + 0.08));
                patch(r.id, 'ATTACK_SUPPORT_FORM_PULL', Math.max(0.32, arch.ATTACK_SUPPORT_FORM_PULL - 0.05));
            }
            if (gap < -0.5) {
                patch(r.id, 'ATTACK_DEPTH_BIAS_REF', Math.max(10.5, +(arch.ATTACK_DEPTH_BIAS_REF - 1).toFixed(1)));
                patch(r.id, 'FORMATION_HOLD', Math.min(0.65, arch.FORMATION_HOLD + 0.05));
            }
        }

        // Wing play: keep width, tighten slightly if open
        if (r.id === 'wing_play') {
            patch(r.id, 'SUPPORT_WIDTH', Math.max(arch.SUPPORT_WIDTH, 0.85));
            if (gap < -0.4) {
                patch(r.id, 'ATTACK_DEPTH_BIAS_REF', Math.max(10.5, +(arch.ATTACK_DEPTH_BIAS_REF - 1).toFixed(1)));
                patch(r.id, 'FORMATION_HOLD', Math.min(0.55, arch.FORMATION_HOLD + 0.04));
            }
        }

        // Structured counter: hold high, push on attack
        if (r.id === 'structured_counter') {
            if (gap < -0.4) {
                patch(r.id, 'FORMATION_HOLD', Math.min(0.82, arch.FORMATION_HOLD + 0.04));
                patch(r.id, 'ATTACK_DEPTH_BIAS_REF', Math.max(10.5, +(arch.ATTACK_DEPTH_BIAS_REF - 1).toFixed(1)));
                patch(r.id, 'PASS_AGGRESSION', Math.min(0.78, arch.PASS_AGGRESSION + 0.04));
            }
        }
    }

    return patches;
}

function applyPatchesToJson(patches) {
    const filePath = path.join(__dirname, '../presets/ai_archetypes.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const applied = [];
    for (const [id, keys] of Object.entries(patches)) {
        if (!data[id]) continue;
        for (const [k, v] of Object.entries(keys)) {
            const before = data[id][k];
            if (before === v) continue;
            data[id][k] = v;
            applied.push({ id, key: k, before, after: v });
        }
    }
    if (applied.length) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        // Clear require cache so getArchetypeFullValues sees new values
        const archPath = require.resolve('../presets/ai_archetypes.json');
        delete require.cache[archPath];
        const modPath = require.resolve('../kernel/core/lib/ai_archetypes.js');
        delete require.cache[modPath];
    }
    return applied;
}

async function runSideSwap(presetIds, balanced, base) {
    const results = [];
    let seed = base.seed;
    for (const id of presetIds) {
        const style = getArchetypeFullValues(id);
        if (!style) continue;
        const asA = await batch(`${id}@A vs bal@B`, {
            ...base,
            seed: seed++,
            iterations: base.sideSwapIters,
            aiA: style,
            aiB: balanced
        });
        const asB = await batch(`bal@A vs ${id}@B`, {
            ...base,
            seed: seed++,
            iterations: base.sideSwapIters,
            aiA: balanced,
            aiB: style
        });
        results.push(combineSideSwap(id, asA, asB));
    }
    return { results, nextSeed: seed };
}

async function runMirrors(presetIds, base, seed0) {
    const rows = [];
    let seed = seed0;
    for (const id of presetIds) {
        const style = getArchetypeFullValues(id);
        if (!style) continue;
        rows.push(await batch(`mirror ${id}`, {
            ...base,
            seed: seed++,
            iterations: base.mirrorIters,
            aiA: style,
            aiB: style
        }));
    }
    return { rows, nextSeed: seed };
}

async function runClassic(base, seed0) {
    const pairs = [
        ['gegenpressing', 'catenaccio'],
        ['tiki_taka', 'structured_counter'],
        ['wing_play', 'route_one'],
        ['balanced', 'balanced']
    ];
    const rows = [];
    let seed = seed0;
    for (const [a, b] of pairs) {
        rows.push(await batch(`${a} vs ${b}`, {
            ...base,
            seed: seed++,
            iterations: base.classicIters,
            aiA: getArchetypeFullValues(a),
            aiB: getArchetypeFullValues(b)
        }));
    }
    return { rows, nextSeed: seed };
}

async function main() {
    const extra = parseInline(process.argv.slice(2));
    const phase = extra.phase || 'full'; // full | discover | confirm
    const autoApply = extra.autoApply !== false; // default true for full pipeline

    const base = {
        sideSwapIters: parseInt(extra.sideSwapIters, 10) || 32,
        mirrorIters: parseInt(extra.mirrorIters, 10) || 16,
        classicIters: parseInt(extra.classicIters, 10) || 20,
        confirmIters: parseInt(extra.confirmIters, 10) || 16,
        seed: parseInt(extra.seed, 10) || 101,
        concurrency: parseInt(extra.concurrency, 10) || 5,
        matchDurationSeconds: parseInt(extra.matchDurationSeconds, 10) || 600,
        formationA: extra.formationA || '4-4-2',
        formationB: extra.formationB || '4-4-2'
    };

    // Reload archetypes module fresh
    const presetIds = Object.keys(ARCHETYPES).sort();
    const balanced = getArchetypeFullValues('balanced');
    if (!balanced) {
        log('ERROR: missing balanced preset');
        process.exit(1);
    }

    const planned = {
        discover:
            presetIds.length * 2 * base.sideSwapIters +
            presetIds.length * base.mirrorIters +
            4 * base.classicIters,
        confirm: presetIds.length * 2 * base.confirmIters
    };

    log(`\n=== AI preset tune (${phase}) ===`);
    log(`Presets: ${presetIds.join(', ')}`);
    log(`Planned matches — discover: ${planned.discover}, confirm: ${planned.confirm}`);
    log(`Duration ${base.matchDurationSeconds}s, concurrency ${base.concurrency}\n`);

    const out = {
        generatedAt: new Date().toISOString(),
        phase,
        base,
        planned,
        discover: null,
        patches: null,
        applied: null,
        confirm: null
    };

    let matchCount = 0;

    if (phase === 'full' || phase === 'discover') {
        log('--- Phase 1: side-swap vs balanced ---');
        const ss = await runSideSwap(presetIds, balanced, base);
        matchCount += presetIds.length * 2 * base.sideSwapIters;

        log('\n--- Phase 1b: mirrors ---');
        const mir = await runMirrors(presetIds, base, ss.nextSeed);
        matchCount += presetIds.length * base.mirrorIters;

        log('\n--- Phase 1c: classic H2Hs ---');
        const cl = await runClassic(base, mir.nextSeed);
        matchCount += 4 * base.classicIters;

        const analysis = analyze(ss.results, mir.rows, cl.rows);
        const patches = suggestPatches(ss.results);

        out.discover = {
            sideSwap: ss.results,
            mirrors: mir.rows,
            classic: cl.rows,
            analysis
        };
        out.patches = patches;

        log('\n=== Side-swap summary (net style vs balanced) ===');
        log(
            'id'.padEnd(22) +
            'GF'.padStart(7) +
            'GA'.padStart(7) +
            'GD'.padStart(7) +
            'poss'.padStart(7) +
            'prog'.padStart(7) +
            'xgF'.padStart(7) +
            'press'.padStart(7)
        );
        for (const r of ss.results) {
            log(
                r.id.padEnd(22) +
                num(r.goalsFor).padStart(7) +
                num(r.goalsAgainst).padStart(7) +
                num(r.gd).padStart(7) +
                num(r.poss, 1).padStart(7) +
                num(r.prog, 1).padStart(7) +
                num(r.xgFor).padStart(7) +
                num(r.press, 1).padStart(7)
            );
        }

        log('\n=== Analysis ===');
        for (const a of analysis) {
            log(`  ${a.id}: ${a.ok ? 'OK' : a.notes.join('; ')}`);
        }

        log('\n=== Suggested patches ===');
        log(JSON.stringify(patches, null, 2));

        if ((phase === 'full' || extra.apply) && autoApply) {
            // Need fresh require after write — handle in applyPatchesToJson
            const applied = applyPatchesToJson(patches);
            out.applied = applied;
            log(`\nApplied ${applied.length} knob changes to ai_archetypes.json`);
            for (const a of applied) {
                log(`  ${a.id}.${a.key}: ${a.before} → ${a.after}`);
            }
        }
    }

    if (phase === 'full' || phase === 'confirm') {
        // Re-require archetypes after possible patch
        delete require.cache[require.resolve('../presets/ai_archetypes.json')];
        delete require.cache[require.resolve('../kernel/core/lib/ai_archetypes.js')];
        const { getArchetypeFullValues: getFull } = require('../kernel/core/lib/ai_archetypes.js');
        const bal2 = getFull('balanced');
        const ids2 = Object.keys(require('../presets/ai_archetypes.json')).sort();

        log('\n--- Phase 2: confirm side-swap ---');
        const confBase = {
            ...base,
            sideSwapIters: base.confirmIters,
            seed: base.seed + 5000
        };
        // Inline side-swap with reloaded getter
        const confResults = [];
        let seed = confBase.seed;
        for (const id of ids2) {
            const style = getFull(id);
            if (!style) continue;
            const asA = await batch(`confirm ${id}@A`, {
                ...confBase,
                seed: seed++,
                iterations: confBase.sideSwapIters,
                aiA: style,
                aiB: bal2
            });
            const asB = await batch(`confirm bal vs ${id}@B`, {
                ...confBase,
                seed: seed++,
                iterations: confBase.sideSwapIters,
                aiA: bal2,
                aiB: style
            });
            confResults.push(combineSideSwap(id, asA, asB));
            matchCount += 2 * confBase.sideSwapIters;
        }

        out.confirm = { sideSwap: confResults };
        log('\n=== Confirm side-swap summary ===');
        for (const r of confResults) {
            log(
                r.id.padEnd(22) +
                ` GF ${num(r.goalsFor)} GA ${num(r.goalsAgainst)} GD ${num(r.gd)}` +
                ` prog ${num(r.prog, 1)} press ${num(r.press, 1)}`
            );
        }
        const confAnalysis = analyze(confResults, [], []);
        out.confirm.analysis = confAnalysis;
        log('\n=== Confirm analysis ===');
        for (const a of confAnalysis) {
            log(`  ${a.id}: ${a.ok ? 'OK' : a.notes.join('; ')}`);
        }
    }

    out.matchCount = matchCount;
    const outDir = path.resolve('simulations/output/preset_tune');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = Date.now();
    const outPath = path.join(outDir, `tune_${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    log(`\nMatches run: ${matchCount}`);
    log(`Wrote ${outPath}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
