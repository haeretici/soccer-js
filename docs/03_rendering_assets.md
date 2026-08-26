# 03. Rendering, Projections & Assets

## Dynamic Coordinate Mapping (`Utils.toScreen`)
Engine translates logic $(x, y)$ and height $(z)$ to screen $(sx, sy)$ via 3 modes:
1. **Orthographic (2.5D):** 
   `sx = offsetX + x*scale + y*(scale*0.3)`
   `sy = offsetY + y*(scale*0.8) - z*scale`
2. **Top-Down:** 
   `sx = offsetX + x*scale`
   `sy = offsetY + y*(scale*0.8) - z*scale`
3. **Isometric:** 
   `sx = offsetX + (x-y) * (scale*1.2)/2`
   `sy = offsetY + (x+y) * (scale*1.2)/4 - z*(scale*1.2)/2`

*Ball shadow renders at true ground `(X,Y)`. Y-sorting handles draw order based on ground Y.*

## Pitch offscreen cache (`pitch.js`)

Static stadium + turf + markings + **rest-state goals** are baked into an offscreen canvas and blitted once per frame.

| Invalidates cache | Survives without rebuild |
| :--- | :--- |
| `projectionMode`, camera `scale`, layout `offsetX/Y`, `FIELD_SIZE_MULTIPLIER`, `weather` | `Application.camX` / `camY` pan (`g.translate` in `engine.js`) |

* **Isometric turf:** painted as 4-unit band quads (same light/dark pattern as the old per-tile diamonds), not one diamond per world tile.
* **Goal nets:** rest mesh lives in the cache. While `|leftNetExp|` / `|rightNetExp|` exceed `Settings.GOAL_NET_AT_REST_EPS`, only the deformed back/top mesh is redrawn live.
* **Headless / mock ctx:** no `drawImage` → direct path (tests); call `invalidateRenderCache()` after structural field changes if needed.

## Pause freeze (`engine.js`)

When `Settings.RENDER_SKIP_WHEN_PAUSED` (default **true**) and `Application.paused`, CanvasLoop keeps the last frame (no `clearScreen` / `render` / `onGUI`) until unpause or `Application.markRenderDirty()` (e.g. projection/weather UI while paused).

## Sprites & Assets
* **Player Spritesheet:** Sprites are generated on the fly and cached by a "Modular Animation System", when changing player sprites related code (that is, `sprite_generator.js`) you can read for `05_spritesheet.md` for further information (only when necessary, avoid otherwise).
* **Recoloring:** `sprite_generator.js` uses fast bitwise replacement. Slots 1-7 are team colors (kit); slots 8-15 are player colors (skin/hair). Caches in `ImageDB`.
* **Browser UI shell:** Compact full-viewport editor layout (romdashboard-inspired) shared across `html/*.html` — header bar + optional sidebars + status bar. SCSS: `scss/_layout.scss`, `scss/_components.scss`. Pages stay separate (Match Simulator, Batch Builder, Analyze Results, Asset Manager, Scenario Lab).
* **Asset Manager (engine viewer):** `html/asset-manager.html` + `kernel/apps/asset-manager/app.js` — preview, kit/player recolor, and compiled sheet only. Styles in `scss/apps/_asset-manager.scss`.
* **Asset Manager (full editor):** Standalone package at `asset-manager/` (part pixel editor + animation rig customizer). Independent of the engine; see `asset-manager/README.md`. Intended to be split into its own repository later.
* **Audio (`sounddb.js`):** Web Audio one-shots + continuous crowd bed. Procedural synths by default; optional WAV overrides at `assets/sounds/<name>.wav` via `appUrl()` (see `assets/sounds/README.md`). Isolated audio LCG — **never** `Math.random()` / sim RNG. No-ops when `HEADLESS` or `soundsMuted` (also muted during scrub seek). Crowd intensity follows match state and ball final-third heat via `SoundDB.updateCrowd`.
* **Flags:** Located in `assets/flags/` (SVG). Regenerate via `node presets/generate_flags.js`. Loaded with `appUrl('assets/flags/…')`.

## Subpath hosting (`app_paths.js`)
Browser pages live under `html/`. Runtime asset/preset URLs must not use host-root `/…` so the app works under a deploy prefix (e.g. `https://host/soccer/html/`).

* **Root `index.html`:** redirects to `html/` using the pathname as a directory (`/prefix` and `/prefix/` → `/prefix/html/`). A relative `html/` target would drop the prefix when the URL has no trailing slash (`/soccer-js` → `/html/`).
* **`kernel/core/lib/app_paths.js`:** `getAppRoot()` / `appUrl(relPath)` resolve the repo root from `document.baseURI` (parent of the `/html/` path segment). Optional override: `window.__APP_ROOT__`.
* **HTML static tags** (`link`, `script`, default flag `img`): relative `../build/…`, `../assets/…` from `html/*.html`.
* **JS fetch / Image:** always `appUrl('assets/…')` or `appUrl('presets/…')` — relative strings in the bundle resolve against the **page**, not the script file.
* **Node / headless:** no `document.baseURI` → `appUrl` returns `/…` (compatible with `tests/mock_env.js`).

## Presets (`presets/`)
* `formations.json`: Base coords for tactical shapes.
* `ai_archetypes.json`: Custom AI strategy presets (strategy + attack shape knobs).
* `ai_params.json`: Named AI param profiles for batch / sweeps.
* `player_stats.json`: Base stats + 8 player-specific palette colors.
* `palettes.json`: 7 kit colors per team (48 nations).
* `sprite_manifest.json`: Single source of truth for tile/frame sizes.

