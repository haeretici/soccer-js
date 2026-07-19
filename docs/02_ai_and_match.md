# 02. AI, State Machines & Match Rules

## Team Entity (`team.js`) Responsibilities
* **Squad Management:** Max 11 players. Handles substitutions (substitutes players with < 0.55 stamina late in game).
* **Pass Target Selection:** Evaluates intercept safety, lead aims, and progressive scoring. Passes must exceed `SHORT_PASS_MIN_DIST`. Kick speed is friction-aware.
* **Shooting (ISS-leaning):** `canShoot` samples goal mouth (Y 40–60) in three tiers: (1) fully clear lane, (2) soft lane with defender close-speed scaled by `SHOOT_LANE_OPP_SPEED_SCALE`, (3) contested sample accepted via distance/blocker-weighted RNG (`SHOOT_CONTESTED_*`). Support-spot scoring uses `allowContested: false` (deterministic). Dribble may still force a mouth aim when blocked (`SHOOT_FORCE_BLOCKED_CHANCE`). Range: `SHOOT_RANGE_REF` (phase mult). Outfield blocks (`tryBallShotBlocking`) use thinner bodies / lower max-z (`SHOT_BLOCK_*`). GK save chance on `ball.isShot` is scaled by `GK_SHOT_SAVE_MULT`.
* **Regions & Posture:** Shifts `baseX/baseY` based on `Attacking/Defending` states. Attack/defend line depth and region column deltas are live knobs (`ATTACK_DEPTH_BIAS_REF`, `ATTACK_REGION_COL_DELTA`, `ATTACK_ROLE_REGION_BIAS`, defend counterparts).
* **Attack support shape:** Secondary Idle support uses `computeAttackSupportTarget` (push scale, form pull, `SUPPORT_WIDTH`). Own-half possession light-blends with `ATTACK_SUPPORT_OWN_HALF_BLEND` × intensity (default 0.35). Only one primary `supportingPlayer` runs full support spots.
* **Engine Tweakings:** Strategy presets plus **Attack shape** sliders per team. Selecting a preset from `presets/ai_archetypes.json` applies **strategy + attack shape** (full style). Defaults match prior hardcodes so balance is unchanged until you raise depth/region/own-half support.
* **Presets (revamp):** `balanced`, `tiki_taka`, `catenaccio`, `gegenpressing`, `structured_counter`, `wing_play`, `route_one` — each carries formation hold / support / press / pass aggression **and** attack line depth, region shift, role bias, own-half support blend, form pull, push scale, support width. Tuned with side-swap headless batches (`scripts/tune_ai_presets.js`, ~800+ matches): catenaccio = lowest prog / best GA; tiki / gegen = highest prog; route_one / wing ≈ even GD vs balanced; gegenpressing uses a compact mid-high press (not a kamikaze line).
* **Dynamic Strategy:** Teams shift to `gegenpressing` (losing late) or `catenaccio` (winning late) if `dynamicStrategyShifting` is enabled — **strategy knobs only** (attack shape chosen at kickoff is preserved).

## Player FSM (`fsm.js` -> `player_states.js`)
1. **Idle:** Resolves position via 5-layer stack (Formation -> Region -> Depth/Hold -> Shape -> Mark/Cover).
2. **ChaseBall:** Primary chaser uses sticky logic. Beaten chasers drop back. Avoids opponent repulsion steering near ball.
3. **Dribble:** Moves to goal. Evaluates pass chance (boosted if threatened). Inside shoot range: phase willingness → `canShoot` (clear/soft/contested) → optional force-blocked speculative shot → else pass recycle.
4. **Pass/Shoot:** Swaps to kick pose, applies velocity. AI shots use tighter aim noise (`SHOOT_ANGLE_NOISE_SCALE`) and reduced random Magnus (`SHOOT_CURVE_SCALE`). Set-piece kicks apply `kickerClaimCooldown` (1.0s) to prevent illegal double-touch.
5. **Goalkeeper / GkDive:** Stays in goal mouth. Distributes (40% short, 60% long punt). Dives use distinct prep/lunge/roll animations. Saves use **adaptive ball look-ahead**, **speed-scaled catch radius** (`GK_CATCH_SPEED_BONUS` — stops ~20 m/s shot tunnelling through one logic tick), segment contact tests, dive commit on `ball.isShot` (`GK_DIVE_CHANCE_SHOT`), and arcade save mult (`GK_SHOT_SAVE_MULT` so keepers stay beatable). Tunables live under `Settings.AI` / `Settings.physics.SHOOT_SPEED_*`.
6. **Header:** Shared `findHeaderOpportunity` (ball path sample in z 0.9–2.0 near jump lead ~0.45s). Jump arc + contact needs XY close and ball still in band. AI auto-enters; human uses timed keys (Stage 4).

## Match FSM (`simulator.js` & `MatchStates`)
* **Strict Singleton FSM:** Transitions handled via `fsm.changeState()`. No direct string mutation.
* **Set Pieces (`set_piece_resume.js`):** Two phases: (1) Setup (snap walkers, build wall). (2) `SET_PIECE_READY_HOLD` (2s delay before kick). Taker evaluates pass safety; if unsafe, shoots/clears.
* **Throw-ins:** Taker walks to the touchline (ball has no owner until ready). Setup waits for the taker to arrive (up to +5s) so far players are not force-snapped early. Ball is pinned to a fixed touchline spot (no carry offset) until release. OOB setup zeroes velocity. Release aims prefer feet and bias deep infield (≥6u); direction needs ≥0.55 inward unit component. Line playbooks keep receivers in an 8–14u channel. `isThrowInFlight` clears only after ~2.5u interior depth (or OOB + nearly stopped).
* **Corners:** Same boundary pin as throw-ins. Ball is placed **inset** into the pitch (not on x=0/width,y=0/height); taker may stand just outside the flag for look, but the ball never follows carry-offset outside. Delivery aims and kick direction are biased into the box; loft is forced so ground skims cannot re-exit. Uses the same `isThrowInFlight` boundary grace after release.
* **Freekick Walls:** Formed on shot axis. Wall jumps on kick release, blocking chips based on precise dynamic `vz`.
* **Offside:** Caches lines per tick. Delayed whistle: only blows if the offside receiver actively claims the loose ball.
* **Fouls:** 0.7s `foul` state reaction before card/setup. Walk-back logic applies instead of instant teleports.
* **Penalty area / penalties:** Box geometry matches `pitch.js` markings (`match_rules.js`: depth ref 15.625, y 12.5–50). A foul by the defending team **inside their own box** awards a **penalty** (`MatchStates.Penalty`, ball on spot, GK on line, others outside box). Card path preserves `setPieceType === 'penalty'`.
* **Advantage:** When the fouled team still has the ball in the **attacking half**, the ref plays on for ~2.5s (`_pendingAdvantage`) instead of stopping — except for **penalties** and **red/double-yellow**. If possession is lost inside the window, the original foul is whistled at the stored spot; if the window expires with possession held, play continues (no free kick). Soft “ADVANTAGE” overlay while pending.
* **Indirect free kicks (true IFK):** Offside restart sets `setPieceIndirect`. AI does **not** shoot first on IFK (must lay off / pass). On kick, `ball.ifkActive` + `ifkTaker` arm a second-touch gate; any other player’s claim, GK catch, wall hit, or shot block clears it. A goal while `ifkActive` is **not** awarded — restart is a **goalkick** for the defending team.

## Naming Convention
* Players **MUST** use FIFA 3-letter abbreviation + jersey (e.g., `CAN 1`, `BRA 10`). No real names.

## Manual Control (Stage 1–4)

Optional browser-only human play for **Team A** (checkboxes in `html/index.html`). Plan: `docs/IMPROVED_GAMEPLAY_STAGED_PLAN.md`.

* **Input:** `kernel/core/lib/input_keyboard.js` (WASD + numpad/digit 1–5; **Shift** also sprints). Exposes press/down/release for Stage 2 hold-to-power. Off-ball ground: **1** foot, **2** slide, **3** body shove. Off-ball **air window**: **1** short header, **2** long header, **3** head shot.
* **Logic:** `kernel/core/lib/manual_control.js` — resolves controlled outfielder, maps pass/lob/shoot/tackle/header/switch onto existing FSMs; teammates + opponent + GK stay AI.
* **Power/curl helpers:** `kernel/core/lib/manual_commands.js` (pure; logic-tick hold → power, lateral stick → curve; Stage 3 slide/body; Stage 4 `buildHumanHeaderKick`).
* **Air intercepts:** `ball_prediction.findAirIntercept` / `findHeaderOpportunity` shared by AI Header entry, human header window, and loose-ball chase when airborne.
* **Hook:** `MatchStates.Play` calls `tickManualControl` before `updatePlayerAIStates`. Human players are skipped by AI assign (`humanControlled` / `shouldSkipAIAssign`).
* **Kick path:** Human sets `player.humanKick` before `Pass`/`Shoot`; `player.humanHeader` before/during `Header`. AI kicks unchanged when those are null.
* **Kickoff:** Opening pass is **always AI** (`forceKickoffPass` short lay-off to nearest mate). Manual control is fully gated (`isKickoffControlBlocked`) while `matchState === 'kickoff'` or `setPieceType === 'kickoff'` — no WASD, pass, or player switch until the AI kick clears the set piece. After a goal, `resetToKickoff` / `snapCameraToKickoff` hard-centers the camera (clears celebration orbit + `_manualCameraActive`). Taker/support/ball are re-pinned each tick (`pinKickoffSpots`) so the carrier does not drift ahead of the center mark before the pass.
* **Headless:** `Settings.HEADLESS` or `manualControl.teamA === false` → no human path (batch unchanged).
* **Team B:** UI checkbox disabled until a second input device (later stage).

### Stage 1.5 feel (`Settings.manualControl`)

| Flag | Default | Effect |
| :--- | :--- | :--- |
| `screenAwareMove` | true | WASD → screen axes via `Utils.worldDeltaFromScreenDelta` (iso/ortho) |
| `autoSwitchOnPass` | true | On pass/lob, control jumps to receiver (sticky until claim / timeout) |
| `passAssistFacing` | true | Hybrid pass pick: facing/move cone + AI `findBestPassTarget` |
| `cameraFollow` | true | Soft lerp of centered cam to player+ball midpoint (`updateManualCameraFollow`) |
| `blockAutoHeader` | true | Human avatar skips auto `Header` FSM (no mid-run steal) |
| `recordInput` | false | Optional `sim._manualInputLog` stub for future replay |

### Stage 2 power / aim (`Settings.manualControl`)

| Flag | Default | Effect |
| :--- | :--- | :--- |
| `holdToPower` | true | Press starts charge; **release** fires pass/lob/shoot with power from hold ticks (~0.05–0.6s logic). Off = Stage 1 press-to-fire |
| `holdPowerMinSec` / `holdPowerMaxSec` | 0.05 / 0.6 | Logic-time window for power ramp |
| `holdPowerTapFloor` | 0.28 | Power at minimum hold (tap) |
| `aimAssist` | true | Master: when false, pure facing kicks (no teammate lock / goal sample) |
| `shotAimAssist` | true | With master on: `canShoot` goal-mouth sample; off with master = facing aim |
| `passAssistFacing` | true | Still gates hybrid pass pick when `aimAssist` is on |

**Direction (primary):** pass / lob / shot aim follows **WASD stick** (sticky during hold so release still uses last aim). Assist only soft-locks a teammate **inside the facing cone**; otherwise the ball is kicked free along stick with hold-scaled range.

**Lob identity:** action `2` always launches with `vz > 0` (scaled by hold). **Curl:** lateral stick vs body orientation while charging biases `curveForce` (replaces pure random Magnus sample). Ground free-passes stay flat (no curve).

**Shot height:** hold power maps to **peak height** then `vz = √(2gh)` (same free-flight as `ball.js`). Tap ≈ driven (~0.3–0.8 m peak); full far hold ≈ chip (~3 m peak). Earlier Stage 2 used raw vz ≈ 0.5–3 which never reached 1 m peak.

Sprint hold uses `Settings.physics.PLAYER_SPRINT_MUL`. World speeds/loft live in `Settings.physics` (see `docs/01_architecture.md`).

### Stage 3 defense toolkit

| Feature | Behavior |
| :--- | :--- |
| Body shove (`3` off-ball) | `attemptTackle(..., 'body')` — short range (`BODY_TACKLE_RANGE`), knockdown + claim-or-loose, high foul/card risk (`BODY_FOUL_CHANCE`, `BODY_CARD_CHANCE_MUL`) |
| Directional slide (`2` off-ball) | Launch along **WASD** stick (`slideLaunchTarget` / `SLIDE_LAUNCH_DIST`); fixed dive line, soft ball blend only near contact |
| Take charge | Soft overlap push on opponent carrier without a tackle button (`manualControl.takeCharge*`); rare sprint dislodge, no foul |
| Recovery lock | Missed/failed tackles use `applyActionLock` (frames 5/6 + `actionTimer`); human input frozen until recovery ends |
| Human foul muls | `manualControl.humanFoulMul` / `humanBodyFoulMul` / `humanSlideFoulMul` scale foul rolls on top of referee strictness |

AI chase still auto foot/slide only (no auto body). `triggerFoul(tackler, victim, { tackleType })` raises card odds for body.

### Stage 4 air control (headers core)

| Feature | Behavior |
| :--- | :--- |
| Header window | Loose ball airborne + reachable sample in z 0.9–2.0 within ~0.95s (`evalHumanHeaderWindow`) |
| Short header (`1`) | Soft nod along stick; hold-to-power scales speed/vz |
| Long header (`2`) | Higher speed + hang; mild curl from lateral stick |
| Head shot (`3`) | Driven flatter header; `ball.isShot = true`; soft goal blend when aim assist on |
| Timing | Jump starts on release (or press if hold-to-power off); contact only if ball still in band + XY range during Header contact phase |
| AI | Auto Header uses same `findHeaderOpportunity` (not fixed t=0.45 only) |
| Out of core | Diving header, volley, bicycle (need new animation frames — deferred) |

Flags: `manualControl.manualHeader` (default true), `headerWindowMaxT`, `headerContactRadius`. `blockAutoHeader` still prevents auto-steal of the human avatar.
