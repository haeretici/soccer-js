#!/usr/bin/env node
require('./mock_env.js');

const fs = require('fs');
const assert = require('assert');
const path = require('path');
const { Settings } = require('../kernel/settings.js');
const { ImageDB } = require('../kernel/core/lib/imagedb.js');
const {
    runBatch,
    runHeadlessMatch,
    recomputeSummaryFromMatches,
    mergeConfig,
    planWorkerChunks,
    normalizeConcurrency,
    applySettingsFromConfig,
    restoreAIStrategySettings,
    DEFAULT_BASE_AI
} = require('../kernel/providers/simulator/headless_runner.js');

const SCRATCH = '/tmp/grok-goal-cc92a68fff48/implementer';
Settings.app = { camX: 0, camY: 0, canvas: { width: 720, height: 528 } };

function pickTelemetryFields(m) {
    return {
        iteration: m.iteration,
        seed: m.seed,
        frames: m.frames,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        totalGoals: m.totalGoals,
        possessionShare: m.possessionShare,
        tactical: m.tactical,
        matchState: m.matchState
    };
}

function recomputeFromTelemetry(matches) {
    const totals = {
        goals: 0,
        possessionTeamA: 0,
        possessionTeamB: 0,
        passAttempts: 0,
        shootAttempts: 0,
        tackleAttempts: 0,
        tackleSuccesses: 0,
        cornerKicks: 0,
        goalKicks: 0,
        fouls: 0,
        freeKicks: 0,
        yellowCards: 0,
        redCards: 0,
        strategyShiftsA: 0,
        strategyShiftsB: 0,
        substitutionsA: 0,
        substitutionsB: 0
    };
    for (const m of matches) {
        totals.goals += m.totalGoals;
        totals.possessionTeamA += m.possessionShare.teamA;
        totals.possessionTeamB += m.possessionShare.teamB;
        totals.passAttempts += m.tactical.passAttempts;
        totals.shootAttempts += m.tactical.shootAttempts;
        totals.tackleAttempts += m.tactical.tackleAttempts;
        totals.tackleSuccesses += m.tactical.tackleSuccesses;
        totals.cornerKicks += m.tactical.cornerKicks;
        totals.goalKicks += m.tactical.goalKicks;
        totals.fouls += m.tactical.fouls;
        totals.freeKicks += m.tactical.freeKicks;
        totals.yellowCards += m.tactical.yellowCards;
        totals.redCards += m.tactical.redCards;
        totals.strategyShiftsA += m.tactical.strategyShiftsA || 0;
        totals.strategyShiftsB += m.tactical.strategyShiftsB || 0;
        totals.substitutionsA += m.tactical.substitutionsA || 0;
        totals.substitutionsB += m.tactical.substitutionsB || 0;
    }
    const n = matches.length;
    return {
        avgGoalsPerMatch: totals.goals / n,
        possessionTeamA: totals.possessionTeamA / n,
        possessionTeamB: totals.possessionTeamB / n,
        passAttemptsPerMatch: totals.passAttempts / n,
        shootAttemptsPerMatch: totals.shootAttempts / n,
        tackleAttemptsPerMatch: totals.tackleAttempts / n,
        tackleSuccessRate: totals.tackleAttempts > 0 ? totals.tackleSuccesses / totals.tackleAttempts : 0,
        cornerKicksPerMatch: totals.cornerKicks / n,
        goalKicksPerMatch: totals.goalKicks / n,
        foulsPerMatch: totals.fouls / n,
        freeKicksPerMatch: totals.freeKicks / n,
        yellowCardsPerMatch: totals.yellowCards / n,
        redCardsPerMatch: totals.redCards / n,
        strategyShiftsAPerMatch: totals.strategyShiftsA / n,
        strategyShiftsBPerMatch: totals.strategyShiftsB / n,
        substitutionsAPerMatch: totals.substitutionsA / n,
        substitutionsBPerMatch: totals.substitutionsB / n
    };
}

(async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); if (process.env.VERBOSE) origLog(...args); };

    try {
        const config = mergeConfig({
            iterations: 2,
            seed: 99,
            headless: true,
            matchDurationSeconds: 120,
            maxFramesPerMatch: 8000,
            outputDir: 'simulations/output'
        });

        const run1 = await runBatch(config);
        const run2 = await runBatch(config);

        assert.strictEqual(run1.matches.length, 2);
        assert.strictEqual(run2.matches.length, 2);

        for (const run of [run1, run2]) {
            const s = run.summary;
            assert.ok(typeof s.avgGoalsPerMatch === 'number' && !Number.isNaN(s.avgGoalsPerMatch));
            assert.ok(typeof s.possession.teamASharePercent === 'number');
            assert.ok(typeof s.possession.teamBSharePercent === 'number');
            const possSum = s.possession.teamASharePercent + s.possession.teamBSharePercent + s.possession.looseSharePercent;
            assert.ok(Math.abs(possSum - 100) < 0.5, `possession shares sum to ~100 (got ${possSum})`);
            assert.ok(typeof s.tactical.passAttemptsPerMatch === 'number');
            assert.ok(typeof s.tactical.shootAttemptsPerMatch === 'number');
            assert.ok(s.tactical.tackleAttemptsPerMatch > 0, 'tackle attempts recorded via attemptTackle hook');
            assert.ok(s.tactical.tackleSuccessRate > 0 && s.tactical.tackleSuccessRate <= 1,
                `tackle success rate in (0,1] (got ${s.tactical.tackleSuccessRate})`);
            assert.ok(s.tactical.tackleSuccessesPerMatch <= s.tactical.tackleAttemptsPerMatch,
                'tackle successes cannot exceed attempts');
            assert.ok(typeof s.elapsedSeconds === 'number' && s.elapsedSeconds > 0,
                'summary logs simulation duration in seconds');
            assert.ok(typeof s.elapsedMs === 'number' && s.elapsedMs > 0,
                'summary logs simulation duration in milliseconds');

            for (const m of run.matches) {
                assert.ok(m.tactical.tackleAttempts > 0, `match ${m.iteration} has tackle attempts`);
                assert.ok(m.tactical.tackleSuccesses <= m.tactical.tackleAttempts,
                    `match ${m.iteration} successes <= attempts`);
                assert.ok(m.tactical.tackleSuccessRate > 0 && m.tactical.tackleSuccessRate <= 1,
                    `match ${m.iteration} tackle rate meaningful`);
            }

            console.log(
                `tackle telemetry: attempts/match=${s.tactical.tackleAttemptsPerMatch.toFixed(1)} `
                + `successes/match=${s.tactical.tackleSuccessesPerMatch.toFixed(1)} `
                + `rate=${s.tactical.tackleSuccessRate.toFixed(3)}`
            );
        }

        const recomputed1 = recomputeFromTelemetry(run1.matches);
        assert.ok(Math.abs(recomputed1.avgGoalsPerMatch - run1.summary.avgGoalsPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.possessionTeamA - run1.summary.possession.teamASharePercent) < 1e-9);
        assert.ok(Math.abs(recomputed1.tackleSuccessRate - run1.summary.tactical.tackleSuccessRate) < 1e-9);
        assert.ok(Math.abs(recomputed1.cornerKicksPerMatch - run1.summary.tactical.cornerKicksPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.goalKicksPerMatch - run1.summary.tactical.goalKicksPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.foulsPerMatch - run1.summary.tactical.foulsPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.freeKicksPerMatch - run1.summary.tactical.freeKicksPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.yellowCardsPerMatch - run1.summary.tactical.yellowCardsPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.redCardsPerMatch - run1.summary.tactical.redCardsPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.strategyShiftsAPerMatch - run1.summary.tactical.strategyShiftsAPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.strategyShiftsBPerMatch - run1.summary.tactical.strategyShiftsBPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.substitutionsAPerMatch - run1.summary.tactical.substitutionsAPerMatch) < 1e-9);
        assert.ok(Math.abs(recomputed1.substitutionsBPerMatch - run1.summary.tactical.substitutionsBPerMatch) < 1e-9);

        const resummary = recomputeSummaryFromMatches(config, run1.matches);
        assert.ok(Math.abs(resummary.avgGoalsPerMatch - run1.summary.avgGoalsPerMatch) < 1e-9);

        assert.deepStrictEqual(
            run1.summary.avgGoalsPerMatch,
            run2.summary.avgGoalsPerMatch,
            'same seed/config yields deterministic avgGoalsPerMatch'
        );
        assert.deepStrictEqual(
            run1.summary.possession.teamASharePercent,
            run2.summary.possession.teamASharePercent,
            'same seed/config yields deterministic possession'
        );
        assert.deepStrictEqual(
            run1.matches.map(pickTelemetryFields),
            run2.matches.map(pickTelemetryFields),
            'per-match telemetry identical across consecutive runs'
        );

        ImageDB.images = {};
        const noSpriteConfig = mergeConfig({
            headless: true,
            matchDurationSeconds: 30,
            maxFramesPerMatch: 500,
            teamA: 'Brazil',
            teamB: 'Argentina'
        });
        await runHeadlessMatch(noSpriteConfig, 4242);
        const playerSheets = Object.keys(ImageDB.images).filter((k) => k.startsWith('player_'));
        assert.strictEqual(playerSheets.length, 0, 'headless match must not register player sprite sheets');
        console.log('PASS headless startup skips player sprite registration');

        restoreAIStrategySettings();

        applySettingsFromConfig(mergeConfig({
            headless: true,
            ai: { FORMATION_HOLD: 0.33, PASS_AGGRESSION: 0.33 }
        }));
        assert.strictEqual(Settings.AI.FORMATION_HOLD, 0.33, 'global ai mutates base knob');
        assert.strictEqual(Settings.AI.A.FORMATION_HOLD, 0.33, 'Team A inherits global ai via prototype');
        assert.strictEqual(Settings.AI.B.PASS_AGGRESSION, 0.33, 'Team B inherits global ai via prototype');
        console.log('PASS legacy global ai applies to both teams');

        applySettingsFromConfig(mergeConfig({
            headless: true,
            ai: { FORMATION_HOLD: 0.5, PASS_AGGRESSION: 0.5 },
            aiA: { FORMATION_HOLD: 0.9 }
        }));
        assert.strictEqual(Settings.AI.A.FORMATION_HOLD, 0.9, 'partial aiA overrides one knob on Team A');
        assert.strictEqual(Settings.AI.A.PASS_AGGRESSION, 0.5, 'partial aiA leaves other knobs inherited from global ai');
        assert.strictEqual(Settings.AI.B.FORMATION_HOLD, 0.5, 'Team B inherits global ai when only aiA partial');
        console.log('PASS partial aiA with global ai base');

        applySettingsFromConfig(mergeConfig({
            headless: true,
            aiA: { FORMATION_HOLD: 0.15 }
        }));
        assert.strictEqual(Settings.AI.A.FORMATION_HOLD, 0.15, 'aiA override applied to Team A');
        assert.strictEqual(Settings.AI.B.FORMATION_HOLD, DEFAULT_BASE_AI.FORMATION_HOLD,
            'Team B inherits restored base when only aiA set');

        applySettingsFromConfig(mergeConfig({ headless: true }));
        assert.strictEqual(Settings.AI.FORMATION_HOLD, DEFAULT_BASE_AI.FORMATION_HOLD,
            'default config restores polluted base knobs');
        assert.strictEqual(Settings.AI.A.FORMATION_HOLD, DEFAULT_BASE_AI.FORMATION_HOLD,
            'per-match reset clears leaked aiA own-properties');
        assert.strictEqual(Settings.AI.B.FORMATION_HOLD, DEFAULT_BASE_AI.FORMATION_HOLD,
            'per-match reset clears leaked aiB own-properties');
        console.log('PASS per-team AI settings reset between headless matches');

        const seqBase = {
            iterations: 2,
            seed: 88,
            headless: true,
            matchDurationSeconds: 30,
            maxFramesPerMatch: 300,
            concurrency: 1
        };
        const baselineBatch = await runBatch(mergeConfig({ ...seqBase }));
        await runBatch(mergeConfig({
            ...seqBase,
            ai: { FORMATION_HOLD: 0.99, PASS_AGGRESSION: 0.11 }
        }));
        assert.strictEqual(Settings.AI.FORMATION_HOLD, DEFAULT_BASE_AI.FORMATION_HOLD,
            'runBatch restores base knobs after global ai batch');
        assert.strictEqual(Settings.AI.A.FORMATION_HOLD, DEFAULT_BASE_AI.FORMATION_HOLD,
            'runBatch restores team A after global ai batch');

        const afterPollutionBatch = await runBatch(mergeConfig({ ...seqBase }));
        assert.deepStrictEqual(
            afterPollutionBatch.matches.map(pickTelemetryFields),
            baselineBatch.matches.map(pickTelemetryFields),
            'default batch after polluted-ai batch reproduces baseline telemetry (no leakage)'
        );
        console.log('PASS sequential runBatch global-ai pollution does not leak into next config');

        const perTeamBase = {
            iterations: 8,
            seed: 77,
            headless: true,
            matchDurationSeconds: 120,
            maxFramesPerMatch: 4000,
            concurrency: 1
        };
        const knobDefaults = {
            FORMATION_HOLD: 0.55,
            ATTACK_SUPPORT_INTENSITY: 0.65,
            DEFENSIVE_PRESS_INTENSITY: 0.45,
            PASS_AGGRESSION: 0.55
        };
        const sameAI = await runBatch(mergeConfig({
            ...perTeamBase,
            aiA: { ...knobDefaults },
            aiB: { ...knobDefaults }
        }));
        const splitAI = await runBatch(mergeConfig({
            ...perTeamBase,
            aiA: {
                FORMATION_HOLD: 0.85,
                ATTACK_SUPPORT_INTENSITY: 0.2,
                DEFENSIVE_PRESS_INTENSITY: 0.8,
                PASS_AGGRESSION: 0.55
            },
            aiB: {
                FORMATION_HOLD: 0.2,
                ATTACK_SUPPORT_INTENSITY: 0.8,
                DEFENSIVE_PRESS_INTENSITY: 0.2,
                PASS_AGGRESSION: 0.8
            }
        }));

        assert.ok(sameAI.summary.config.aiA && sameAI.summary.config.aiB, 'summary records aiA and aiB');
        assert.notStrictEqual(
            sameAI.summary.possession.teamASharePercent,
            splitAI.summary.possession.teamASharePercent,
            'contrasting aiA/aiB changes possession balance vs identical team AI'
        );
        console.log(
            `per-team AI batch: same possession A=${sameAI.summary.possession.teamASharePercent.toFixed(1)}% `
            + `split possession A=${splitAI.summary.possession.teamASharePercent.toFixed(1)}%`
        );

        restoreAIStrategySettings();

        assert.deepStrictEqual(planWorkerChunks(10, 5), [
            { startIndex: 0, count: 2 },
            { startIndex: 2, count: 2 },
            { startIndex: 4, count: 2 },
            { startIndex: 6, count: 2 },
            { startIndex: 8, count: 2 }
        ], 'worker chunks divide iterations evenly');
        assert.deepStrictEqual(planWorkerChunks(4, 5), [
            { startIndex: 0, count: 1 },
            { startIndex: 1, count: 1 },
            { startIndex: 2, count: 1 },
            { startIndex: 3, count: 1 }
        ], 'concurrency is capped at iterations');
        assert.strictEqual(normalizeConcurrency(8, 3), 3);
        assert.strictEqual(normalizeConcurrency(undefined, 10), 5, 'default concurrency is 5');

        const fourMatchBase = {
            iterations: 4,
            seed: 99,
            headless: true,
            matchDurationSeconds: 120,
            maxFramesPerMatch: 8000
        };
        const sequentialFour = await runBatch(mergeConfig({ ...fourMatchBase, concurrency: 1 }));
        const parallelFour = await runBatch(mergeConfig({ ...fourMatchBase, concurrency: 2 }));

        assert.strictEqual(sequentialFour.matches.length, 4);
        assert.strictEqual(parallelFour.matches.length, 4);
        assert.strictEqual(parallelFour.summary.config.concurrency, 2);
        assert.strictEqual(parallelFour.summary.config.workerProcessesUsed, 2);
        assert.deepStrictEqual(
            parallelFour.summary.avgGoalsPerMatch,
            sequentialFour.summary.avgGoalsPerMatch,
            'parallel batch matches sequential aggregates'
        );
        assert.deepStrictEqual(
            parallelFour.summary.possession.teamASharePercent,
            sequentialFour.summary.possession.teamASharePercent,
            'parallel batch matches sequential possession'
        );
        assert.deepStrictEqual(
            parallelFour.summary.tactical.tackleSuccessRate,
            sequentialFour.summary.tactical.tackleSuccessRate,
            'parallel batch matches sequential tackle rate'
        );
        for (let i = 0; i < 4; i++) {
            assert.deepStrictEqual(
                parallelFour.matches[i].totalGoals,
                sequentialFour.matches[i].totalGoals,
                `match ${i + 1} goals match between parallel and sequential`
            );
        }

        fs.mkdirSync(SCRATCH, { recursive: true });
        fs.writeFileSync(path.join(SCRATCH, 'headless-batch-test.log'), logs.join('\n') + '\n');
        console.log('\nHeadless batch tests passed');
    } catch (err) {
        fs.mkdirSync(SCRATCH, { recursive: true });
        fs.writeFileSync(path.join(SCRATCH, 'headless-batch-test.log'), logs.join('\n') + '\n' + String(err) + '\n');
        console.error(err);
        process.exit(1);
    }
})();