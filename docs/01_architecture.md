# 01. Architecture, Hierarchy & Determinism

## Core File Paths (Abridged)
* `kernel/core/entities/`: Base classes (`gameobject.js`, `team.js`, `player.js`, `ball.js`, `pitch.js`).
* `kernel/core/lib/`: Utilities, FSM, math, and AI logic modules.
* `kernel/core/lib/app_paths.js`: Browser `appUrl()` for subpath-safe asset/preset URLs (see `docs/03_rendering_assets.md`).
* `kernel/providers/simulator/`: Match flow and headless runners.
* `engine.js`: Main loops.

## Scene Graph Hierarchy
Match entities form a parent/child tree via `GameObject.insertChild`:
```text
Simulator (level root)
├── Pitch
│   ├── TeamA (owns up to 11 Players)
│   └── TeamB
└── Ball

```

* **GameObject:** Manages `children`, scripts (ECS style), and cascades `updateAll`/`renderAll`.
* **Pitch:** Renders turf, ensures `Goals` exist, bounds the field.
* **Simulator:** Holds `teamA`, `teamB`, flat `players` list (y-sorted during render), match FSM, and ball.

## Update Decoupling & Determinism

1. **CanvasLoop (`engine.js`):** Runs at 60 FPS (rendering).
2. **ApplicationLoop (`engine.js`):** Logical updates at 20 UPS (1x speed).
3. **Fixed Timestep:** `Time.advanceFixedLogicStep()` is ALWAYS `LOGIC_DT` (0.05s). Play speed multiplier (`Settings.TIME_SPEED`) only changes wall-clock scheduling.
4. **Seeding:** `bindSeededRandom()` is called at start. To prevent non-deterministic interference in browser environments from asynchronous callbacks, rendering, or third-party libraries, the custom seeded LCG `Math.random` override is only active during the execution of logical updates (`updateAll()`) and initialization (`bootstrapMatch()`), after which the native browser `Math.random` is safely restored. Never use `Math.random()` in audio or rendering.

## World units & `Settings.physics`

Logical space is **meters and seconds** on a FIFA-scale pitch (`BASE_FIELD_WIDTH` × `BASE_FIELD_HEIGHT`, default 106×68).

**Single source of truth:** `kernel/settings.js` → `Settings.physics`.

| Group | Keys (examples) | Consumers |
| :--- | :--- | :--- |
| Ball free flight | `GRAVITY`, bounce / Magnus, `AIR_DRAG_BASE` | `ball.js`, `ball_prediction.predict3D` |
| Ground friction | `GROUND_FRICTION_BASE`, `BALL_STOP_SPEED` | Short-pass travel time, intercepts |
| Player locomotion | `PLAYER_BASE_SPEED`, `PLAYER_SPEED_STAT_BONUS`, accel, `PLAYER_SPRINT_MUL` | `Player.moveTo`, pass-safety max speed, manual sprint |
| Kicks | `LONG_PASS_VZ_*`, hang-time long speed (`longPassInitialSpeed`), short arrival, `SHOOT_SPEED_*` | Pass / Shoot / GK clear |

**Long passes:** horizontal speed uses hang time + air drag (not ground-friction arrival). While `z > 0`, `AIR_DRAG_BASE` slows `vx/vy` so lofted balls do not cruise forever.

Do **not** hardcode gravity (`9.81`) or player base speeds in entities — read from `Settings.physics` so feel tweaks stay in one place. Freekick wall chip math uses the same `GRAVITY` via `ballGravity()`.

## Goal geometry & scoring (`goal.js`)

* **Mouth:** posts / bar / net depth live on `Goal` (`createPair` from field bounds). AI and match rules share the same `yMin/yMax/height`.
* **Goal event:** only `Goal.scored` — the free-flight segment must cross the goal-line plane **from the pitch**, between the posts and under the bar. Paths that go wide of the posts (or leave the net toward the pitch) are never goals; past-line without a mouth cross → corner/goalkick.
* **Frame physics:** free balls hit solid posts, crossbar, and exterior net (`resolveBallCollisions` from `Simulator.resolveGoalFrameCollisions` after `ball.update`). Soft net settle after a goal remains `checkGoalNetCollisions` in the Goal match state.

