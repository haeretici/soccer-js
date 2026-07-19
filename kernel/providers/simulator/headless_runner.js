const path = require('path');
const { fork } = require('child_process');
const { Time } = require('../../core/lib/time.js');
const { Settings } = require('../../settings.js');
const { Simulator, MatchStates } = require('./simulator.js');
const {
    STRATEGY_KNOBS,
    snapshotBaseAiParams,
    applyAiParamsFromConfig,
    resolveBatchAiConfig,
    normalizeAiParamsBlock
} = require('../../core/lib/ai_params.js');

const BATCH_WORKER_PATH = path.join(__dirname, '../../../scripts/batch_worker.js');
const FORMATIONS_PRESET_PATH = path.join(__dirname, '../../../presets/formations.json');

const AVAILABLE_FORMATIONS = Object.keys(
    JSON.parse(require('fs').readFileSync(FORMATIONS_PRESET_PATH, 'utf8'))
).sort();

/** Snapshot of Settings.AI at module load (full base, for restore after batches). */
const DEFAULT_BASE_AI = snapshotBaseAiParams();
const DEFAULT_STRATEGY_AI = Object.fromEntries(
    STRATEGY_KNOBS.map((key) => [key, Settings.AI[key]])
);

const DEFAULT_CONFIG = {
    iterations: 1,
    seed: 1,
    headless: true,
    outputDir: 'simulations/output',
    teamA: 'Brazil',
    teamB: 'Argentina',
    formationA: '4-4-2', // see AVAILABLE_FORMATIONS: 4-4-2, 4-3-3, 3-5-2, 4-2-3-1, 4-1-4-1, 5-3-2, 3-4-3, 4-5-1
    formationB: '4-4-2',
    matchDurationSeconds: 600,
    fieldSizeMultiplier: 1.0,
    timeSpeed: 1.0,
    maxFramesPerMatch: 25000,
    concurrency: 5,
    ai: null,
    aiA: null,
    aiB: null,
    /** Optional path to presets/ai_params.json (or custom) */
    aiParamsFile: null,
    /** Named profile inside ai_params.json profiles{} */
    aiProfile: null,
    /** When true, load defaults from presets/ai_params.json even without aiParamsFile */
    loadAiParamsDefaults: false,
    dynamicStrategyShifting: true
};

function resetBaseAIStrategyKnobs() {
    // Restore full AI base snapshot, not only the four strategy knobs
    for (const [key, val] of Object.entries(DEFAULT_BASE_AI)) {
        Settings.AI[key] = val;
    }
    // Ensure strategy knobs present even if snapshot was partial
    for (const key of STRATEGY_KNOBS) {
        if (DEFAULT_STRATEGY_AI[key] !== undefined) {
            Settings.AI[key] = DEFAULT_STRATEGY_AI[key];
        }
    }
}

function resetTeamAISettings() {
    Settings.AI.A = Object.create(Settings.AI);
    Settings.AI.B = Object.create(Settings.AI);
}

function restoreAIStrategySettings() {
    resetBaseAIStrategyKnobs();
    resetTeamAISettings();
}

/** @deprecated use normalizeAiParamsBlock — kept for strategy-only callers */
function normalizeAIStrategyBlock(block) {
    if (!block || typeof block !== 'object') return null;
    const normalized = {};
    for (const key of STRATEGY_KNOBS) {
        const val = block[key];
        if (typeof val === 'number' && val >= 0 && val <= 1) {
            normalized[key] = val;
        }
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function createEmptyMatchTelemetry() {
    return {
        frames: 0,
        scoreA: 0,
        scoreB: 0,
        totalGoals: 0,
        possessionFrames: { A: 0, B: 0, loose: 0 },
        possessionShare: { teamA: 0, teamB: 0, loose: 0 },
        tactical: {
            passAttempts: 0,
            shootAttempts: 0,
            tackleAttempts: 0,
            tackleSuccesses: 0,
            tackleSuccessRate: 0,
            blocks: 0,
            cornerKicks: 0,
            goalKicks: 0,
            fouls: 0,
            freeKicks: 0,
            penalties: 0,
            advantages: 0,
            yellowCards: 0,
            redCards: 0,
            strategyShiftsA: 0,
            strategyShiftsB: 0,
            xgA: 0,
            xgB: 0,
            progressivePassesA: 0,
            progressivePassesB: 0,
            pressSuccessesA: 0,
            pressSuccessesB: 0,
            transitionGoalsA: 0,
            transitionGoalsB: 0,
            substitutionsA: 0,
            substitutionsB: 0
        },
        matchState: 'unknown'
    };
}

function createMatchTelemetryHooks(telemetry) {
    return {
        onTackleAttempt({ success }) {
            telemetry.tactical.tackleAttempts++;
            if (success) telemetry.tactical.tackleSuccesses++;
        },
        onBlock() {
            telemetry.tactical.blocks++;
        },
        onShotKicked({ team, xg }) {
            if (team === 'A') telemetry.tactical.xgA += xg;
            else telemetry.tactical.xgB += xg;
        },
        onProgressivePass({ team }) {
            if (team === 'A') telemetry.tactical.progressivePassesA++;
            else telemetry.tactical.progressivePassesB++;
        },
        onPressSuccess({ team }) {
            if (team === 'A') telemetry.tactical.pressSuccessesA++;
            else telemetry.tactical.pressSuccessesB++;
        },
        onTransitionGoal({ team }) {
            if (team === 'A') telemetry.tactical.transitionGoalsA++;
            else telemetry.tactical.transitionGoalsB++;
        },
        onSubstitution({ team }) {
            if (team === 'A') telemetry.tactical.substitutionsA++;
            else telemetry.tactical.substitutionsB++;
        }
    };
}

function mergeConfig(input) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, input || {});
    // accept full Settings.AI keys (not only four strategy knobs)
    resolveBatchAiConfig(cfg);
    // Also accept legacy strategy-only normalization if resolve left nulls empty
    if (!cfg.ai && input && input.ai && typeof input.ai === 'object') {
        cfg.ai = normalizeAiParamsBlock(input.ai) || normalizeAIStrategyBlock(input.ai);
    }
    return cfg;
}

function normalizeConcurrency(value, iterations) {
    const parsed = parseInt(value, 10);
    const requested = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.concurrency;
    const total = Math.max(1, parseInt(iterations, 10) || 1);
    return Math.min(requested, total);
}

function planWorkerChunks(iterations, concurrency) {
    const workers = normalizeConcurrency(concurrency, iterations);
    const baseSize = Math.floor(iterations / workers);
    const remainder = iterations % workers;
    const chunks = [];
    let startIndex = 0;

    for (let worker = 0; worker < workers; worker++) {
        const count = baseSize + (worker < remainder ? 1 : 0);
        if (count > 0) {
            chunks.push({ startIndex, count });
            startIndex += count;
        }
    }

    return chunks;
}

function applySettingsFromConfig(config) {
    Settings.HEADLESS = config.headless !== false;
    Settings.soundsMuted = true;
    Settings.TIME_SPEED = config.timeSpeed || 1.0;
    Settings.MATCH_DURATION = config.matchDurationSeconds || Settings.MATCH_DURATION;
    Settings.FIELD_SIZE_MULTIPLIER = config.fieldSizeMultiplier || Settings.FIELD_SIZE_MULTIPLIER;
    Settings.batchConfig = {
        teamA: config.teamA,
        teamB: config.teamB,
        formationA: config.formationA,
        formationB: config.formationB
    };

    resetBaseAIStrategyKnobs();

    // file defaults / profile / ai / aiA / aiB (any known Settings.AI key)
    const aiReport = applyAiParamsFromConfig({
        aiParamsFile: config.aiParamsFile || null,
        aiProfile: config.aiProfile || null,
        ai: config.ai,
        aiA: config.aiA,
        aiB: config.aiB,
        loadFileDefaults: !!config.loadAiParamsDefaults
    });
    config._aiParamsApplied = aiReport;

    // Explicit batch flag still wins for dynamic strategy (after profile merge)
    if (config.dynamicStrategyShifting !== undefined) {
        Settings.AI.dynamicStrategyShifting = config.dynamicStrategyShifting !== false;
    }
}

function finalizePossessionShares(telemetry) {
    const total = telemetry.possessionFrames.A + telemetry.possessionFrames.B + telemetry.possessionFrames.loose;
    if (total <= 0) {
        telemetry.possessionShare = { teamA: 0, teamB: 0, loose: 0 };
        return;
    }
    telemetry.possessionShare = {
        teamA: (telemetry.possessionFrames.A / total) * 100,
        teamB: (telemetry.possessionFrames.B / total) * 100,
        loose: (telemetry.possessionFrames.loose / total) * 100
    };
}

function finalizeTacticalRates(telemetry) {
    const t = telemetry.tactical;
    t.tackleSuccessRate = t.tackleAttempts > 0 ? t.tackleSuccesses / t.tackleAttempts : 0;
}

function sampleTacticalStateEdges(sim, telemetry, prevStates) {
    for (const p of sim.players) {
        const prevState = prevStates.get(p) || '';
        const stateName = p.fsm.getNameOfCurrentState();
        if (stateName === 'Pass' && prevState !== 'Pass') telemetry.tactical.passAttempts++;
        if (stateName === 'Shoot' && prevState !== 'Shoot') telemetry.tactical.shootAttempts++;
        prevStates.set(p, stateName);
    }
}

function sampleInterruptionStates(sim, telemetry, prevStates) {
    const prevMatchState = prevStates.get(sim) || 'kickoff';
    const currentState = sim.fsm ? sim.fsm.getNameOfCurrentState() : sim.matchState;
    
    if (currentState !== prevMatchState) {
        if (currentState === 'corner') {
            telemetry.tactical.cornerKicks++;
        } else if (currentState === 'goalkick') {
            telemetry.tactical.goalKicks++;
        } else if (currentState === 'foul') {
            telemetry.tactical.fouls++;
        } else if (currentState === 'freekick') {
            // Only count freekick enters (card → freekick must not double-count)
            telemetry.tactical.freeKicks++;
        } else if (currentState === 'penalty') {
            telemetry.tactical.penalties++;
        } else if (currentState === 'card') {
            if (sim.cardType === 'yellow') {
                telemetry.tactical.yellowCards++;
            } else if (sim.cardType === 'red' || sim.cardType === 'doubleyellow') {
                telemetry.tactical.redCards++;
            }
        }
        prevStates.set(sim, currentState);
    }

    // Edge-count advantage windows started (pending flag appears while still in play)
    const hadAdv = !!prevStates.get('__advantage');
    const hasAdv = !!(sim && sim._pendingAdvantage);
    if (hasAdv && !hadAdv) {
        telemetry.tactical.advantages++;
    }
    prevStates.set('__advantage', hasAdv);
}

function samplePossession(sim, telemetry) {
    const owner = sim.ball.owner;
    if (owner) telemetry.possessionFrames[owner.team]++;
    else telemetry.possessionFrames.loose++;
}

async function runHeadlessMatch(config, matchSeed) {
    applySettingsFromConfig(config);

    const prevRandom = Math.random;
    try {
        // Seed lives on Simulator; bootstrapMatch always bindSeededRandom(this.seed).
        const sim = new Simulator({ seed: matchSeed >>> 0 || 1 });
        await sim.start();
        sim.active = true;

        const telemetry = createEmptyMatchTelemetry();
        sim._telemetry = createMatchTelemetryHooks(telemetry);
        const prevStates = new Map();
        const dt = 0.05;
        const maxFrames = config.maxFramesPerMatch || 25000;
        let frame = 0;

        while (sim.matchState !== 'fulltime' && frame < maxFrames) {
            Time.deltaTime = dt;
            sim.updateAll();
            sampleTacticalStateEdges(sim, telemetry, prevStates);
            sampleInterruptionStates(sim, telemetry, prevStates);
            samplePossession(sim, telemetry);
            frame++;
        }

        delete sim._telemetry;

        telemetry.frames = frame;
        telemetry.scoreA = sim.scoreA;
        telemetry.scoreB = sim.scoreB;
        telemetry.totalGoals = sim.scoreA + sim.scoreB;
        telemetry.matchState = sim.matchState;
        telemetry.tactical.strategyShiftsA = sim.strategyShiftsA;
        telemetry.tactical.strategyShiftsB = sim.strategyShiftsB;
        finalizePossessionShares(telemetry);
        finalizeTacticalRates(telemetry);

        return { sim, telemetry };
    } finally {
        Math.random = prevRandom;
    }
}

function buildSummary(config, matches, elapsedMs, workerProcessesUsed) {
    const n = matches.length;
    const totals = {
        goals: 0,
        goalsA: 0,
        goalsB: 0,
        possessionTeamA: 0,
        possessionTeamB: 0,
        possessionLoose: 0,
        passAttempts: 0,
        shootAttempts: 0,
        tackleAttempts: 0,
        tackleSuccesses: 0,
        blocks: 0,
        cornerKicks: 0,
        goalKicks: 0,
        fouls: 0,
        freeKicks: 0,
        penalties: 0,
        advantages: 0,
        yellowCards: 0,
        redCards: 0,
        strategyShiftsA: 0,
        strategyShiftsB: 0,
        xgA: 0,
        xgB: 0,
        progressivePassesA: 0,
        progressivePassesB: 0,
        pressSuccessesA: 0,
        pressSuccessesB: 0,
        transitionGoalsA: 0,
        transitionGoalsB: 0,
        substitutionsA: 0,
        substitutionsB: 0,
        frames: 0
    };

    for (const m of matches) {
        totals.goals += m.totalGoals;
        totals.goalsA += m.scoreA;
        totals.goalsB += m.scoreB;
        totals.possessionTeamA += m.possessionShare.teamA;
        totals.possessionTeamB += m.possessionShare.teamB;
        totals.possessionLoose += m.possessionShare.loose;
        totals.passAttempts += m.tactical.passAttempts;
        totals.shootAttempts += m.tactical.shootAttempts;
        totals.tackleAttempts += m.tactical.tackleAttempts;
        totals.tackleSuccesses += m.tactical.tackleSuccesses;
        totals.blocks += m.tactical.blocks || 0;
        totals.cornerKicks += m.tactical.cornerKicks;
        totals.goalKicks += m.tactical.goalKicks;
        totals.fouls += m.tactical.fouls;
        totals.freeKicks += m.tactical.freeKicks;
        totals.penalties += m.tactical.penalties || 0;
        totals.advantages += m.tactical.advantages || 0;
        totals.yellowCards += m.tactical.yellowCards;
        totals.redCards += m.tactical.redCards;
        totals.strategyShiftsA += m.tactical.strategyShiftsA || 0;
        totals.strategyShiftsB += m.tactical.strategyShiftsB || 0;
        totals.xgA += m.tactical.xgA || 0;
        totals.xgB += m.tactical.xgB || 0;
        totals.progressivePassesA += m.tactical.progressivePassesA || 0;
        totals.progressivePassesB += m.tactical.progressivePassesB || 0;
        totals.pressSuccessesA += m.tactical.pressSuccessesA || 0;
        totals.pressSuccessesB += m.tactical.pressSuccessesB || 0;
        totals.transitionGoalsA += m.tactical.transitionGoalsA || 0;
        totals.transitionGoalsB += m.tactical.transitionGoalsB || 0;
        totals.substitutionsA += m.tactical.substitutionsA || 0;
        totals.substitutionsB += m.tactical.substitutionsB || 0;
        totals.frames += m.frames;
    }

    const tackleSuccessRate = totals.tackleAttempts > 0
        ? totals.tackleSuccesses / totals.tackleAttempts
        : 0;

    const summary = {
        generatedAt: new Date().toISOString(),
        config: {
            iterations: config.iterations,
            seed: config.seed,
            concurrency: config.concurrency,
            workerProcessesUsed: typeof workerProcessesUsed === 'number' ? workerProcessesUsed : null,
            teamA: config.teamA,
            teamB: config.teamB,
            formationA: config.formationA,
            formationB: config.formationB,
            matchDurationSeconds: config.matchDurationSeconds,
            fieldSizeMultiplier: config.fieldSizeMultiplier,
            ai: config.ai ? { ...config.ai } : null,
            aiA: config.aiA ? { ...config.aiA } : null,
            aiB: config.aiB ? { ...config.aiB } : null,
            aiParamsFile: config.aiParamsFile || null,
            aiProfile: config.aiProfile || null,
            loadAiParamsDefaults: !!config.loadAiParamsDefaults,
            aiParamsApplied: config._aiParamsApplied
                ? {
                    profile: config._aiParamsApplied.profile,
                    sourceFile: config._aiParamsApplied.sourceFile,
                    appliedBase: config._aiParamsApplied.appliedBase,
                    appliedA: config._aiParamsApplied.appliedA,
                    appliedB: config._aiParamsApplied.appliedB
                }
                : null,
            dynamicStrategyShifting: config.dynamicStrategyShifting
        },
        completedMatches: n,
        avgGoalsPerMatch: n > 0 ? totals.goals / n : 0,
        avgGoalsTeamA: n > 0 ? totals.goalsA / n : 0,
        avgGoalsTeamB: n > 0 ? totals.goalsB / n : 0,
        possession: {
            teamASharePercent: n > 0 ? totals.possessionTeamA / n : 0,
            teamBSharePercent: n > 0 ? totals.possessionTeamB / n : 0,
            looseSharePercent: n > 0 ? totals.possessionLoose / n : 0
        },
        tactical: {
            passAttemptsPerMatch: n > 0 ? totals.passAttempts / n : 0,
            shootAttemptsPerMatch: n > 0 ? totals.shootAttempts / n : 0,
            tackleAttemptsPerMatch: n > 0 ? totals.tackleAttempts / n : 0,
            tackleSuccessesPerMatch: n > 0 ? totals.tackleSuccesses / n : 0,
            tackleSuccessRate,
            blocksPerMatch: n > 0 ? totals.blocks / n : 0,
            passToShotRatio: totals.shootAttempts > 0 ? totals.passAttempts / totals.shootAttempts : null,
            cornerKicksPerMatch: n > 0 ? totals.cornerKicks / n : 0,
            goalKicksPerMatch: n > 0 ? totals.goalKicks / n : 0,
            foulsPerMatch: n > 0 ? totals.fouls / n : 0,
            freeKicksPerMatch: n > 0 ? totals.freeKicks / n : 0,
            penaltiesPerMatch: n > 0 ? totals.penalties / n : 0,
            advantagesPerMatch: n > 0 ? totals.advantages / n : 0,
            yellowCardsPerMatch: n > 0 ? totals.yellowCards / n : 0,
            redCardsPerMatch: n > 0 ? totals.redCards / n : 0,
            strategyShiftsAPerMatch: n > 0 ? totals.strategyShiftsA / n : 0,
            strategyShiftsBPerMatch: n > 0 ? totals.strategyShiftsB / n : 0,
            xgAPerMatch: n > 0 ? totals.xgA / n : 0,
            xgBPerMatch: n > 0 ? totals.xgB / n : 0,
            progressivePassesAPerMatch: n > 0 ? totals.progressivePassesA / n : 0,
            progressivePassesBPerMatch: n > 0 ? totals.progressivePassesB / n : 0,
            pressSuccessesAPerMatch: n > 0 ? totals.pressSuccessesA / n : 0,
            pressSuccessesBPerMatch: n > 0 ? totals.pressSuccessesB / n : 0,
            transitionGoalsAPerMatch: n > 0 ? totals.transitionGoalsA / n : 0,
            transitionGoalsBPerMatch: n > 0 ? totals.transitionGoalsB / n : 0,
            substitutionsAPerMatch: n > 0 ? totals.substitutionsA / n : 0,
            substitutionsBPerMatch: n > 0 ? totals.substitutionsB / n : 0
        },
        avgFramesPerMatch: n > 0 ? totals.frames / n : 0
    };

    if (typeof elapsedMs === 'number' && elapsedMs >= 0) {
        summary.elapsedMs = elapsedMs;
        summary.elapsedSeconds = elapsedMs / 1000;
    }

    return summary;
}

function recomputeSummaryFromMatches(config, matches) {
    return buildSummary(config, matches);
}

async function runBatchSlice(config, startIndex, count) {
    const baseSeed = (config.seed >>> 0) || 1;
    const matches = [];

    for (let i = 0; i < count; i++) {
        const globalIndex = startIndex + i;
        const matchSeed = (baseSeed + globalIndex) >>> 0;
        const { telemetry } = await runHeadlessMatch(config, matchSeed);
        matches.push({
            iteration: globalIndex + 1,
            seed: matchSeed,
            ...telemetry
        });
    }

    return matches;
}

function runWorkerChunk(config, chunk) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = fork(BATCH_WORKER_PATH, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });

        const finish = (err, matches) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve(matches);
        };

        child.on('message', (msg) => {
            if (msg && msg.error) {
                finish(new Error(msg.error));
                return;
            }
            finish(null, msg.matches || []);
        });
        child.on('error', (err) => finish(err));
        child.on('exit', (code) => {
            if (!settled) {
                finish(new Error(`Batch worker exited with code ${code} before sending results`));
            }
        });
        child.send({
            config,
            startIndex: chunk.startIndex,
            count: chunk.count
        });
    });
}

async function runBatchParallel(config, iterations, concurrency) {
    const chunks = planWorkerChunks(iterations, concurrency);
    const chunkResults = await Promise.all(chunks.map((chunk) => runWorkerChunk(config, chunk)));
    const matches = chunkResults.flat().sort((a, b) => a.iteration - b.iteration);
    return { matches, workerProcessesUsed: chunks.length };
}

async function runBatch(rawConfig) {
    const config = mergeConfig(rawConfig);
    const iterations = Math.max(1, parseInt(config.iterations, 10) || 1);
    const concurrency = normalizeConcurrency(config.concurrency, iterations);
    config.iterations = iterations;
    config.concurrency = concurrency;

    const started = Date.now();
    let matches;
    let workerProcessesUsed;

    if (concurrency <= 1) {
        matches = await runBatchSlice(config, 0, iterations);
        workerProcessesUsed = 1;
    } else {
        const parallel = await runBatchParallel(config, iterations, concurrency);
        matches = parallel.matches;
        workerProcessesUsed = parallel.workerProcessesUsed;
    }

    Settings.HEADLESS = false;
    Settings.batchConfig = null;
    restoreAIStrategySettings();

    const elapsedMs = Date.now() - started;
    const summary = buildSummary(config, matches, elapsedMs, workerProcessesUsed);

    return { config, matches, summary };
}

module.exports = {
    AVAILABLE_FORMATIONS,
    DEFAULT_CONFIG,
    DEFAULT_BASE_AI,
    STRATEGY_KNOBS,
    createEmptyMatchTelemetry,
    createMatchTelemetryHooks,
    mergeConfig,
    normalizeConcurrency,
    planWorkerChunks,
    resetBaseAIStrategyKnobs,
    resetTeamAISettings,
    restoreAIStrategySettings,
    normalizeAIStrategyBlock,
    applySettingsFromConfig,
    runHeadlessMatch,
    runBatchSlice,
    runBatch,
    buildSummary,
    recomputeSummaryFromMatches,
    finalizePossessionShares,
    finalizeTacticalRates,
    sampleTacticalStateEdges,
    samplePossession
};