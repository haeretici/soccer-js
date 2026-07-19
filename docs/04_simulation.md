# 04. Headless Simulation & Tooling

## Headless Mode (`Settings.HEADLESS = true`)
Skips canvas render loop and DOM updates. Runs logic synchronously in Node.js for batch balancing.
* **Run inline:** `npm run sim:batch -- '{"iterations":10,"seed":42,"headless":true}'`
* **Concurrency:** Forks via `scripts/batch_worker.js` (default 5 workers).
* **Etiquette:** For >900 iterations, agents MUST update `SIMULATION.sh` and ask the user to run it locally.

> [!IMPORTANT]
> **TELEMETRY INTEGRATION RULE**: If adding new game events (fouls, corners, etc.), you MUST update:
> 1. `createEmptyMatchTelemetry()`, `sampleInterruptionStates()`, and `buildSummary()` in `headless_runner.js`.
> 2. Assertions in `tests/headless_batch.js`.
> 3. Chart/UI datasets in `html/simulation-analysis.html`.

Interruption counters include `fouls`, `freeKicks`, **`penalties`** (`MatchStates.Penalty` enters), and **`advantages`** (edge when `_pendingAdvantage` appears).

## Parameter Sweep (C.5)
Varies one `Settings.AI` knob to test balance.
* `npm run sim:sweep -- '{"knob":"PASS_AGGRESSION","min":0.1,"max":0.9,"steps":5}'`
* Outputs table and `.tsv` spreadsheet inside `simulations/output/sweeps/`.

## AI Preset Viability Eval
Head-to-head each `presets/ai_archetypes.json` style (full knobs incl. attack shape) vs `balanced`.
* `node scripts/eval_ai_presets.js '{"iterations":16,"seed":42,"matchDurationSeconds":600}'`
* Writes JSON under `simulations/output/preset_eval/`. Use after changing preset numbers.

## AI Preset Tune (side-swap bulk)
Large batch with **side-swap** (preset as Team A and B vs `balanced`), mirrors, classic H2Hs, optional auto-patches + confirm.
* `npm run sim:tune-presets` — default ~864 matches (32×2 side-swap + mirrors + classic + confirm)
* `node scripts/tune_ai_presets.js '{"sideSwapIters":32,"mirrorIters":16,"classicIters":20,"confirmIters":16}'`
* Output: `simulations/output/preset_tune/tune_*.json`

## AI Debug Overlays
Toggled via `Settings.debugAI`. Skipped in headless.
* Includes: `supportSpots`, `roles`, `states`, `passLanes`, `predictedPath` (3D ball trajectory), `goalMouth` (shot block samples), `offsideLine`.

## Scenario Lab (browser)
Interactive situation tester at `html/tests.html` (`body#tests-app` → `kernel/apps/tests/app.js`).
* Same shell as Match Simulator (teams, formations, camera, manual control, minimap) but **no scrubber**.
* Scenario catalog + apply helpers: `kernel/core/lib/test_scenarios.js` (throw-in, corner, free kick, penalty, goal kick, pass/open play, header, kickoff).
* After bootstrap, prunes opponent (and optional own) outfield counts, then forces the set-piece / open-play state.
* **Seed is deterministic:** `applyTestScenario` rebinds the sim's seeded LCG (bootstrap restores native `Math.random` when it exits). Same seed + scenario options → same playbook pick and placement. Manual control / human input still diverge after that by design.
* Nav link **Scenario Lab** sits after Asset Manager on all `html/*.html` pages.

## Autonomous Testing Rules

1. **Quiet Mode:** By default, all test runs output absolutely nothing to the terminal on a 100% successful run. This minimizes token consumption during autonomous sweeps.
2. **Verbose Mode (Debugging):** To see the full output (e.g., individual assertion success messages), run the test with the `VERBOSE` environment variable:
   - Run all tests: `VERBOSE=1 npm test`
   - Run single test: `VERBOSE=1 npm run test:pass-safety` or `VERBOSE=1 node tests/pass_safety.js`
3. **Execution Safety:** Test assertion logic and error catch blocks remain fully active. Any test failures will still print detailed stack traces and exit with code 1.

## Autonomous Testing Rules

1. **Quiet Mode & Execution Safety:** By default, all test runs output absolutely nothing to the terminal on a 100% successful run to minimize token consumption during autonomous sweeps. However, test assertion logic and error catch blocks remain fully active. Any test failures will still print detailed stack traces and exit with code 1.
2. **Targeted Runs (CRITICAL FOR AGENTS):** Do NOT run the global `npm run test` command as the cascaded execution exceeds token limits. You MUST only run the specific test script related to your current task (e.g., `npm run test:offside` or `node tests/offside_delayed.js`).
3. **Verbose Mode (Human Debugging):** To see the full output (e.g., individual assertion success messages), run the test with the `VERBOSE` environment variable:
   - Run all tests: `VERBOSE=1 npm test`
   - Run single test: `VERBOSE=1 npm run test:pass-safety` or `VERBOSE=1 node tests/pass_safety.js`
