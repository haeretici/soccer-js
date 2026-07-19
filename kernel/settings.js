const spriteManifest = require('./core/lib/sprite_manifest.js');

var Settings = {
    FRAME_RATE: 60,
    tileWidth: spriteManifest.SPRITE_TILE_W,
    tileHeight: spriteManifest.SPRITE_TILE_H,
    screenColor: '#2b5f2b', // beautiful retro dark green pitch color
    showFPS: true,
    showTime: true,
    SPRITE_SPEED: 1,
    TIME_SPEED: 1.0, // Default play speed multiplier (1x)
    DEFAULT_PLAY_SPEED: 1.0,
    MATCH_DURATION: 600, // 10 minutes match (configurable in global settings)
    soundsMuted: false,
    REFEREE_STRICTNESS: 0.5, // 0.0 (lenient) to 1.0 (strict)
    provider: 'simulator',
    HEADLESS: false, // When true, skip canvas/minimap/DOM scoreboard rendering
    batchConfig: null, // Optional headless batch overrides (teams, formations) — set by CLI runner
    projectionMode: 'orthographic', // Classic 2.5D broadcast (see also 'topdown', 'isometric')
    weather: 'fine', // 'fine', 'rainy', or 'snowy'
    /**
     * Manual control (browser match only). Headless/batch ignore these flags.
     * Team A: keyboard. Team B: reserved (second device later).
     * Stage 1.5: feel. Stage 2: hold-to-power/curl. Stage 3: body/take-charge.
     * Stage 4: timed headers (short/long/shot) when ball is in the air window.
     */
    manualControl: {
        teamA: false,
        teamB: false,
        /** When any team is manual, clamp TIME_SPEED to 1.0 for playable reaction time */
        clampSpeed: true,
        /**
         * Map WASD to screen directions via Utils.worldDeltaFromScreenDelta
         * (ISS-style “up the pitch” under iso/ortho). false = pure world axes.
         */
        screenAwareMove: true,
        /** Immediately switch control to pass receiver when a pass is started */
        autoSwitchOnPass: true,
        /**
         * Hybrid pass pick: prefer teammates in the facing/move cone over pure AI score.
         * 0 = AI only, 1 = facing only (clamped in code).
         */
        passAssistFacing: true,
        /** Weight of facing term when passAssistFacing is true (0–1) */
        passAssistFacingWeight: 0.62,
        /** Half-angle of facing cone in degrees (teammates outside score poorly) */
        passAssistConeDeg: 58,
        /**
         * Soft camera follow midpoint of controlled player + ball while manual is on.
         * Uses existing centered camX/camY path (no effect when camera type is static).
         */
        cameraFollow: true,
        /** Blend: 0 = pure ball, 1 = pure controlled player (midpoint uses ~0.45) */
        cameraFollowPlayerBlend: 0.45,
        /** Exponential smooth factor per logic tick (~0.12–0.25) */
        cameraFollowLerp: 0.18,
        /** Skip auto Header FSM on the human avatar (keeps run agency) */
        blockAutoHeader: true,
        /** Optional per-tick command log on sim._manualInputLog (replay stub) */
        recordInput: false,
        recordInputMax: 2400,
        /**
         * Stage 2 — hold-to-power: press starts charge, release fires pass/lob/shoot.
         * false = Stage 1 press-to-fire (no power ramp).
         */
        holdToPower: true,
        /** Logic-time hold window (seconds) mapped to power ∈ [tapFloor, 1] */
        holdPowerMinSec: 0.05,
        holdPowerMaxSec: 0.6,
        /** Power at minimum hold (tap) */
        holdPowerTapFloor: 0.28,
        /**
         * Master aim assist. When false, pure facing kicks (no teammate / goal sample).
         * Pass still uses passAssistFacing; shot uses shotAimAssist when master is on.
         */
        aimAssist: true,
        /** Goal-mouth sample via canShoot when aiming shots (assist on) */
        shotAimAssist: true,
        /**
         * Stage 3 — soft “take charge”: slight collision advantage when overlapping
         * an opponent carrier without pressing a tackle button.
         */
        takeCharge: true,
        /** Max ground distance (m) for take-charge contact */
        takeChargeRange: 1.15,
        /** Push strength (m per logic tick) applied to carrier along separation */
        takeChargePush: 0.055,
        /** Extra chance/s to dislodge loose ball when sprinting into carrier (0–1) */
        takeChargeDislodgeChance: 0.035,
        /**
         * Human foul rate multipliers on top of AI foul chances (referee still applies).
         * Body shoves stay dirtier via humanBodyFoulMul.
         */
        humanFoulMul: 1.0,
        humanSlideFoulMul: 1.0,
        humanBodyFoulMul: 1.15,
        humanFootFoulMul: 1.0,
        /**
         * Stage 4 — manual timed headers when the loose ball is in the air
         * window near the human (keys 1/2/3 = short / long / head shot).
         */
        manualHeader: true,
        /** Max seconds ahead to search for a header intercept sample */
        headerWindowMaxT: 0.95,
        /** Ground contact radius for header opportunity */
        headerContactRadius: 1.9
    },
    weatherSnow: {
        poolCount: 25,          // Number of static pools on the pitch
        poolMinSize: 0.15,      // Min size of a pool in logical units
        poolMaxSize: 0.6,       // Max size of a pool in logical units
        poolOpacity: 0.85,      // Opacity of the static pools (0 to 1)
        fieldTint: 'rgba(235, 245, 255, 0.28)', // Color of the snowy grass overlay
        particleCount: 80,      // Number of falling snow particles
        particleSpeed: 1.0,     // Fall speed multiplier
        particleMinSize: 1.0,   // Min screen pixel size of falling snow
        particleMaxSize: 2.2    // Max screen pixel size of falling snow
    },
    ORTHO_SHEAR_RATIO: 0.3, // ly contribution to sx for inclined field lines
    BASE_SCALE: 20,
    SPRITE_TILE_W: spriteManifest.SPRITE_TILE_W,
    SPRITE_TILE_H: spriteManifest.SPRITE_TILE_H,
    SPRITE_FEET_SCREEN_PX: spriteManifest.SPRITE_FEET_SCREEN_PX,
    BALL_DRAW_RADIUS: 8,
    // Logical pitch size in world units (effective size = base × FIELD_SIZE_MULTIPLIER).
    BASE_FIELD_WIDTH: 106,
    BASE_FIELD_HEIGHT: 68,
    // formations.json and AI coordinates are authored on this reference grid.
    REFERENCE_FIELD_WIDTH: 100,
    REFERENCE_FIELD_HEIGHT: 100,
    FIELD_SIZE_MULTIPLIER: 1.0,
    camera: {
        scale: 20,
        offsetX: 40,
        offsetY: 80,
        type: 'centered'
    },
    /**
     * Shared world physics (SI-ish meters & seconds). Single source for ball.js,
     * ball_prediction, freekick chips, player locomotion, and kick loft.
     * Field size is BASE_FIELD_* × FIELD_SIZE_MULTIPLIER (≈ FIFA 105×68 m).
     */
    physics: {
        /** Ball / free-flight gravity (m/s²). Must match ball.js and predict3D. */
        GRAVITY: 9.81,
        /** Ground friction base: v *= pow(BASE, dt) each step (also ball_prediction). */
        GROUND_FRICTION_BASE: 0.65,
        /**
         * Horizontal air drag while z > 0: v *= pow(BASE, dt).
         * Ground is 0.65 (strong); air must be milder but non‑1 so lofted balls
         * slow and do not cruise forever past the aim (long-pass overshoot fix).
         */
        AIR_DRAG_BASE: 0.88,
        BALL_STOP_SPEED: 0.1,
        /** Logical ball radius (m) — match size ~22 cm diameter */
        BALL_RADIUS: 0.11,
        /** Bounce: vz' = -vz * RESTITUTION when |vz| > MIN_VZ */
        BOUNCE_RESTITUTION: 0.6,
        BOUNCE_HORIZONTAL_DAMP: 0.85,
        BOUNCE_MIN_VZ: 1.5,
        /** Magnus lateral accel scale and spin decay (must match predict3D) */
        MAGNUS_ACC_SCALE: 0.15,
        MAGNUS_VEL_CAP: 10.0,
        CURVE_DECAY_BASE: 0.80,
        CURVE_FORCE_STOP: 0.05,
        /**
         * Player top speed (m/s): BASE + (speedStat/100) * STAT_BONUS * stamina.
         * speed 60 ≈ 6.6 m/s; speed 100 ≈ 8.0 m/s (jog/run band; sprint multiplies).
         * Was ~1.6+1.7 → 2.6–3.3 m/s (too slow after metric conversion).
         */
        PLAYER_BASE_SPEED: 4.6,
        PLAYER_SPEED_STAT_BONUS: 3.4,
        PLAYER_ACCEL_BASE: 10.0,
        PLAYER_ACCEL_STAT_BONUS: 8.0,
        /** Manual sprint hold (numpad 5) multiplies moveTo speed */
        PLAYER_SPRINT_MUL: 1.42,
        /** Possession speed multipliers (with ball slower) */
        PLAYER_SPEED_WITH_BALL: 0.74,
        PLAYER_SPEED_WITHOUT_BALL: 1.0,
        /**
         * Long / lob pass loft: vz = BASE + min(dist * PER_DIST, CAP).
         * Peak height ≈ vz² / (2g). dist 20 → ~3.8 m; dist 40 → ~7 m.
         */
        LONG_PASS_VZ_BASE: 5.5,
        LONG_PASS_VZ_PER_DIST: 0.16,
        LONG_PASS_VZ_CAP: 7.5,
        /** GK long clear vertical band (m/s) */
        GK_CLEAR_VZ_MIN: 6.5,
        GK_CLEAR_VZ_SPREAD: 2.5,
        /** Pass initial ground speed clamps (m/s) — friction-aware arrival elsewhere */
        PASS_SHORT_MIN_SPEED: 11.0,
        PASS_SHORT_MAX_SPEED: 17.0,
        PASS_LONG_MIN_SPEED: 8.0,
        PASS_LONG_MAX_SPEED: 16.5,
        PASS_SHORT_ARRIVAL: 4.0,
        /**
         * Long passes no longer use ground-friction arrival for kick power
         * (air time bypasses ground model). Kept for any ground-only callers.
         */
        PASS_LONG_ARRIVAL: 3.5,
        PASS_SHORT_CUSHION: 1.06,
        PASS_LONG_CUSHION: 1.05,
        /**
         * Fraction of aim distance covered by first hang (air). Rest is bounce/roll.
         * < 1 so lob lands slightly short of pure cruise and dies near feet.
         */
        PASS_LONG_AIR_RANGE_SCALE: 0.90,
        /**
         * Shot ground speed: BASE + (shooting/100) * STAT_SCALE (m/s).
         * shooting 65 → ~14.9; 100 → ~17 (slightly less laser than 10+stat/10).
         */
        SHOOT_SPEED_BASE: 20.0,
        SHOOT_SPEED_STAT_SCALE: 6.0,
        /** Shot heightSpeed (vz) bands by distance — near = driven, far = more loft */
        SHOOT_HEIGHT_NEAR_MIN: 0.35,
        SHOOT_HEIGHT_NEAR_SPAN: 0.75,
        SHOOT_HEIGHT_FAR_MIN: 1.2,
        SHOOT_HEIGHT_FAR_SPAN: 1.6,
        /** Player wall-jump gravity (wall only — not ball) */
        PLAYER_JUMP_GRAVITY: 12.0
    },
    /**
     * Dev-only AI canvas overlays. All default false / off in production.
     * No effect when HEADLESS. Persisted via localStorage key ai_debug_overlays.
     */
    debugAI: {
        enabled: false,
        supportSpots: false,
        regions: false,
        homeTargets: false,
        roles: false,
        states: false,
        threatened: false,
        passLanes: false,
        /** A.1: store winning layer on player._positionTrace / draw labels */
        positionTrace: false,
        /** A.2: marker → target lines + cover points */
        marking: false,
        /** A.3: possession phase label near controlling player */
        playPhase: false,
        /** A.6: freekick wall rings + wall line */
        freekickWall: false,
        offsideLine: false,
        predictedPath: false,
        goalMouth: false
    },
    AI: {
        FOOT_TACKLE_RANGE: 0.75,
        BALL_CLAIM_RANGE: 1.0,
        LOOSE_BALL_PROXIMITY_RANGE: 1.2,
        LOOSE_BALL_INTERCEPT_MAX_T: 0.9,
        // Slightly shorter slide reach so chasers prefer feet when close
        SLIDE_TACKLE_RANGE: 2.2,
        FOOT_TACKLE_SUCCESS_BASE: 0.58,
        SLIDE_TACKLE_SUCCESS_BASE: 0.40,
        TACKLE_RECOVERY_FOOT: 0.45,
        TACKLE_RECOVERY_SLIDE: 0.95,
        /**
         * Stage 3 body shove (manual TACKLE_BODY; not auto-selected by AI chase).
         * Short range, medium success, long recovery, high foul/card risk.
         */
        BODY_TACKLE_RANGE: 1.05,
        BODY_TACKLE_SUCCESS_BASE: 0.48,
        TACKLE_RECOVERY_BODY: 0.78,
        /** Failed (or dirty success) body-shove foul probability before referee scale */
        BODY_FOUL_CHANCE: 0.40,
        /** On successful body shove, still risk a foul (dirty win) */
        BODY_SUCCESS_FOUL_CHANCE: 0.14,
        /** Multiplier on card chance when the foul came from a body shove */
        BODY_CARD_CHANCE_MUL: 1.55,
        /** P(claim ball | body success); else knockdown leaves ball loose */
        BODY_CLAIM_ON_SUCCESS: 0.55,
        /** How far a directional slide launches along stick (m) */
        SLIDE_LAUNCH_DIST: 3.2,
        /** Min logic seconds between tackle rolls (foot spam prevention) */
        TACKLE_ATTEMPT_COOLDOWN: 0.55,
        /**
         * Failed-slide foul probability (was hardcoded 0.45 — caused ~20+ fouls/match).
         * Real matches ~10–18 fouls; target sim ~12–16 at default referee.
         */
        SLIDE_FOUL_CHANCE: 0.18,
        /** Rare clumsy foot foul (late poke) */
        FOOT_FOUL_CHANCE: 0.035,
        /** Base P(card | foul) at REFEREE_STRICTNESS=0.5 (was ~0.35) */
        FOUL_CARD_CHANCE_BASE: 0.16,
        /** Share of cards that are straight red (was 0.15) */
        FOUL_CARD_RED_SHARE: 0.06,
        // Pass distances in meters
        SHORT_PASS_MIN_DIST: 3.0,
        SHORT_PASS_MAX_DIST: 20.0, // Was 8
        LONG_PASS_MIN_DIST: 18.0,  // Was 9
        LONG_PASS_MAX_DIST: 60.0,  // Was 22 (A cross-field switch)
        GK_CLAIM_DURATION: 0.7,
        GK_HOLD_DURATION: 1.2,
        /** Start closing / consider dive when predicted contact is within this (m) */
        GK_INTERCEPT_RANGE: 6.5,
        /** Standing catch radius (m); high-speed shots expand via GK_CATCH_SPEED_BONUS */
        // Slightly tighter than sim-perfect so ISS-style screamers beat the keeper more often
        GK_CATCH_RANGE: 1.32,
        /**
         * Extra catch radius per m/s of ground speed (tunnelling fix for ~20 m/s shots:
         * ball moves ~1 m/tick at 20 UPS, so static 1.3 m often skips the GK).
         */
        GK_CATCH_SPEED_BONUS: 0.022,
        /** Cap on expanded catch radius (m) */
        GK_CATCH_RANGE_MAX: 2.15,
        /** Ground speed above which GK prefers a dive (m/s) */
        GK_DIVE_SPEED_THRESHOLD: 11.0,
        /** P(dive | firm loose ball in intercept range) — was hardcoded 0.35 */
        GK_DIVE_CHANCE_FIRM: 0.58,
        /** P(dive | ball.isShot) — hard shots need early commit (arcade: slightly less automatic) */
        GK_DIVE_CHANCE_SHOT: 0.78,
        /**
         * Multiplies save probability on ball.isShot after other modifiers.
         * <1 → more screamers beat the keeper (ISS arcade).
         */
        GK_SHOT_SAVE_MULT: 0.58,
        /** Dive animation / commitment length (s) */
        GK_DIVE_DURATION: 0.55,
        /** moveTo speed mul during dive lunge */
        GK_DIVE_SPEED_MUL: 1.65,
        /** Min/max logic seconds for ball look-ahead when setting dive / close targets */
        GK_PRED_HORIZON_MIN: 0.18,
        GK_PRED_HORIZON_MAX: 0.85,
        GK_RELEASE_COOLDOWN: 2.5,
        PRESS_SECOND_CHASER_DIST: 7.0,
        PRESS_MAX_SECONDARY_DANGER: 2,
        CHASER_STICKINESS_MARGIN: 1.25, // primary chaser kept unless challenger is this much closer
        /** Keep active-player highlight unless challenger is this much closer (world units) */
        ACTIVE_MARKER_STICKINESS: 2.0,
        /** Do not show active marker when nearest is farther than this (avoids far-team flicker) */
        ACTIVE_MARKER_MAX_DIST: 25.0,
        /**
         * Loose-ball secondary chase hysteresis: once in ChaseBall, keep chasing until
         * dist > LOOSE_BALL_PROXIMITY_RANGE * this (prevents enter/exit thrashing).
         */
        LOOSE_CHASE_RELEASE_MULT: 1.85,
        CHASE_COMMIT_DIST: 5.0, // within this range, chaser closes on carrier not cut-off point
        CHASE_INTERCEPT_FAR_DIST: 10.0, // beyond this range, chaser holds deeper cut-off lane
        CHASE_CUT_OFF_RATIO: 0.35, // cut-off point as fraction of remaining distance to goal
        CHASE_BEATEN_AHEAD_DIST: 1.5, // x-units behind carrier = beaten for press duty
        CHASE_ABANDON_DIST: 9.0, // stop chasing when beaten and farther than this
        PRESS_PRIORITY_AHEAD_BONUS: 0.85,
        PRESS_PRIORITY_BEHIND_PENALTY: 2.8,
        // A.4 Counterpress — brief surge after losing the ball (logic seconds)
        /** How long the transition window lasts after lostControl */
        COUNTERPRESS_DURATION: 4.0,
        /** Max simultaneous surge chasers (primary + secondaries) during window */
        COUNTERPRESS_MAX_SURGE: 3,
        /** Secondary press radius during counterpress (world units) */
        COUNTERPRESS_SECONDARY_DIST: 11.0,
        /** Subtracted from press priority (lower = more preferred) for near players */
        COUNTERPRESS_PRIORITY_BONUS: 2.2,
        /** Scale defending depthBias for non-surge players during window (delay drop) */
        COUNTERPRESS_DELAY_DEPTH_SCALE: 0.3,
        /** Scale mid-block retreat for non-surge during window */
        COUNTERPRESS_DELAY_RETREAT_SCALE: 0.45,
        DEFENSIVE_COMPRESS_BLEND: 0.35,
        DEFENSIVE_RECOVERY_BLEND: 0.4,
        DANGER_ZONE_FIELD_RATIO: 0.45,
        // Strategy knobs (also exposed in Engine Tweakings UI)
        FORMATION_HOLD: 0.55,
        ATTACK_SUPPORT_INTENSITY: 0.65,
        DEFENSIVE_PRESS_INTENSITY: 0.45,
        PASS_AGGRESSION: 0.55,
        /**
         * Max shoot distance (reference-field units → scaleFieldX).
         * ISS-leaning: allow edge-of-box / early speculative strikes (~42 m on FIFA pitch).
         */
        SHOOT_RANGE_REF: 42,
        /**
         * Shot lane evaluation: scale defender max speed when testing soft clearances.
         * <1 opens more mouth samples against a packed box (arcade shoot-on-sight).
         */
        SHOOT_LANE_OPP_SPEED_SCALE: 0.50,
        /**
         * Base P(take shot | best mouth sample still blocked). Distance / blocker mults apply.
         * Used only when allowContested (default open-play decisions).
         */
        SHOOT_CONTESTED_CHANCE: 0.38,
        SHOOT_CONTESTED_NEAR_MULT: 1.55,
        SHOOT_CONTESTED_FAR_MULT: 0.48,
        /** Contested force-shot ignored if more than this many lane blockers */
        SHOOT_CONTESTED_MAX_BLOCKERS: 3,
        /**
         * When canShoot still fails inside range: P(force aim at goal mouth + Shoot).
         * Keeps ISS-style speculative attempts even under heavy traffic.
         */
        SHOOT_FORCE_BLOCKED_CHANCE: 0.14,
        /** Shot aim cone scale for applyKickDirectionNoise (lower = tighter, more on-target) */
        SHOOT_ANGLE_NOISE_SCALE: 0.0055,
        /** Multiplier on random Magnus for AI shots (human curl bypasses this) */
        SHOOT_CURVE_SCALE: 0.55,
        /** Outfield shot block body radius (m) — thinner than pass-safety for arcade */
        SHOT_BLOCK_PLAYER_RADIUS: 0.28,
        /** Ball z above this cannot be blocked by outfielders */
        SHOT_BLOCK_MAX_Z: 1.55,
        /** Scale defender close-speed when testing in-flight shot blocks */
        SHOT_BLOCK_OPP_SPEED_SCALE: 0.55,
        dynamicStrategyShifting: true,
        // Support spot calculator (sweet spots + modern edge model) — Team-owned grid
        SUPPORT_SPOT_GRID_X: 8,
        SUPPORT_SPOT_GRID_Y: 5,
        SUPPORT_SPOT_UPDATE_TICKS: 30, // ~1.5s at 20 UPS (full rescore is expensive)
        SPOT_PASS_SAFE_SCORE: 2.0,
        SPOT_CAN_SCORE_SCORE: 1.0,
        SPOT_DIST_FROM_CONTROLLER_SCORE: 2.0,
        SPOT_OPTIMAL_DIST_REF: 25, // reference-field units → scaleFieldX
        // Hard clamp only (stay on pitch) — fractions of field size (modern: small, not 10% dead flanks)
        SUPPORT_SPOT_MARGIN_X_FRAC: 0.03,
        SUPPORT_SPOT_MARGIN_Y_FRAC: 0.03,
        // Soft edge band as fraction of field height (score falloff toward touchlines)
        SUPPORT_SPOT_EDGE_SOFT_FRAC: 0.14,
        // Tactical width 0=narrow/central … 1=stretch flanks (soft edge + wing bonus)
        SUPPORT_WIDTH: 0.55,
        // At the hard edge, score multiplier ranges from EDGE_MIN_NARROW…EDGE_MIN_WIDE by SUPPORT_WIDTH
        SUPPORT_EDGE_MIN_MUL_NARROW: 0.28,
        SUPPORT_EDGE_MIN_MUL_WIDE: 0.92,
        // Extra score for wide channels when SUPPORT_WIDTH is high
        SUPPORT_WING_BONUS: 0.85,
        // Steering: arrive / separation / pursuit / interpose
        STEER_VIEW_DISTANCE: 4.5,
        STEER_SEPARATION_MULT: 2.2,
        STEER_ARRIVE_RADIUS: 3.5,
        STEER_GK_INTERPOSE_DIST: 2.0, // GK stand-off from goal line toward ball
        // Possession speed mults — prefer Settings.physics; kept for team-split / presets
        PLAYER_SPEED_WITH_BALL: 0.74,
        PLAYER_SPEED_WITHOUT_BALL: 1.0,
        // Pitch regions — home region column shift on attack/defense
        PITCH_REGION_COLS: 6,
        PITCH_REGION_ROWS: 3,
        // Kick timing (logic seconds only — independent of TIME_SPEED / wall clock)
        KICK_WINDUP: 0.2,
        KICKER_CLAIM_COOLDOWN: 0.3,
        KICKER_CLAIM_COOLDOWN_SETPIECE: 1.0,
        /**
         * After a kick, do not AI-assign ChaseBall to the last kicker for this long.
         * Stops the passer immediately chasing their own pass (manual + AI).
         * Claim lock stays shorter (KICKER_CLAIM_COOLDOWN); this only blocks chase assign.
         */
        PASS_FOLLOW_SUPPRESS: 1.35,
        /** Min logic seconds between dribble pass/shoot decision rolls */
        KICK_DECISION_INTERVAL: 0.25,
        // Comfort zone (isThreatened) — world units; prefer pass when threatened
        PLAYER_COMFORT_ZONE: 3.0,
        /** Soft pressure ring (elevated pass chance, not full "threatened") */
        PLAYER_PRESSURE_ZONE: 5.0,
        // A.2 Marking & cover (free attackers while defending)
        /** Max simultaneous mark assignments (1–2 typical) */
        MARK_MAX_MARKERS: 2,
        /** Logic ticks between full mark reassignment (~0.6s at 20 UPS) */
        MARK_UPDATE_TICKS: 20,
        /** Fraction of goal→mark distance for cover stand-off */
        MARK_COVER_RATIO: 0.42,
        MARK_COVER_MIN_DIST: 2.5,
        MARK_COVER_MAX_DIST: 20.0,
        /** Blend residual mid-block shape into cover point */
        MARK_SHAPE_BLEND: 0.28,
        /** Keep existing marker unless alternative cost is better by this margin */
        MARK_STICKINESS_MARGIN: 1.5,
        MARK_OPEN_LANE_BONUS: 3.5,
        MARK_ROLE_ATTACK_BONUS: 2.0,
        MARK_ROLE_MID_BONUS: 0.8,
        MARK_FAR_POST_BONUS: 1.2,
        /** Max world distance for a marker to accept a mark */
        MARK_MAX_ASSIGN_DIST: 40.0,
        // A.3 Phases of play — attack-axis thirds (0=own goal, 1=opp goal)
        /** Progress end of build phase [0,1] */
        PHASE_BUILD_END: 1 / 3,
        /** Progress start of finish phase [0,1] */
        PHASE_FINISH_START: 2 / 3,
        /** Multiplier on dribble pass chance when inside comfort zone */
        THREATENED_PASS_MULT: 1.2,
        /** When true, carriers set player.debugThreatened for overlays */
        DEBUG_HIGHLIGHT_THREATENED: false,
        // RequestPass protocol — logic-time rate limits (not wall clock)
        /** Min seconds between team-wide PassToMe dispatches */
        REQUEST_PASS_INTERVAL: 1.0,
        /** Per-player cooldown after a request attempt (sent or rejected) */
        REQUEST_PASS_PLAYER_COOLDOWN: 1.2,
        /** Soft backoff when team gate is busy (seconds) */
        REQUEST_PASS_BUSY_BACKOFF: 0.3,
        /** Base chance per SupportAttacker decision tick × PASS_AGGRESSION */
        REQUEST_PASS_CHANCE: 0.04,
        // A.6 Freekick wall
        /** Initial upward velocity (world units/s) when wall players jump on kick */
        FREEKICK_WALL_JUMP_VZ: 4.5, // Keep this! 4.5v / 9.81g = ~1.03m jump height. Perfect.
        /** Logic seconds after kick release before jump starts (0 = immediate on kick) */
        FREEKICK_WALL_JUMP_TRIGGER_T: 0,
        /** Standing wall block height (world units) for shot safety + ball contact */
        FREEKICK_WALL_STAND_HEIGHT: 1.75, // Was 1.15 (Now average human height)
        /** Airborne wall block height while jump active */
        FREEKICK_WALL_JUMP_HEIGHT: 2.45, // Was 1.85 (Stand height + jump peak)
        /** Fixed wall body radius for lane safety + ball collision (no sprint) */
        FREEKICK_WALL_BODY_RADIUS: 0.45, // Was 0.7 (Matches new PASS_SAFETY_PLAYER_RADIUS)
        /** Chip vz used when canShootPastWall selects an over-wall sample */
        FREEKICK_CHIP_VZ: 7.5,
        // A.7 Through-balls & progressive leads
        /** Weight on forward x-gain when ranking safe lead aims */
        PROGRESSIVE_LEAD_WEIGHT: 1.28,
        /** Score bonus when aim lands beyond second-last defender (line break) */
        LINE_BREAK_BONUS: 4.2,
        /** Reference-field depth past defensive line for through-ball samples */
        THROUGH_BALL_DEPTH_REF: 7.5,
        /** Scale for deeper lead tangents / forward samples vs classic LEAD_RANGE_SCALE circle */
        THROUGH_BALL_LEAD_EXTRA: 1.35,
        /** Extra findBestPassTarget score when selected aim is a line-break through-ball */
        THROUGH_BALL_TEAM_BONUS: 2.5,
        // A.8 First touch / heavy touch
        /** Incoming ball speed below this → always clean claim (soft arrivals land ~2) */
        FIRST_TOUCH_MIN_SPEED: 5.0,
        /** Base fumble probability before control/speed terms */
        FIRST_TOUCH_FUMBLE_BASE: 0.03,
        /** Scale of (1 − control) added to fumble chance */
        FIRST_TOUCH_FUMBLE_SCALE: 0.32,
        /** Cap on fumble probability */
        FIRST_TOUCH_FUMBLE_MAX: 0.4,
        /** Residual speed fraction min/max on heavy touch */
        FIRST_TOUCH_RESIDUAL_MIN: 0.28,
        FIRST_TOUCH_RESIDUAL_MAX: 0.55,
        /** Lateral noise magnitude on heavy touch residual */
        FIRST_TOUCH_NOISE: 0.85,
        /** Logic seconds before same player can re-claim after heavy touch */
        FIRST_TOUCH_CLAIM_LOCK: 0.28
    }
};

Settings.AI.A = Object.create(Settings.AI);
Settings.AI.B = Object.create(Settings.AI);

function applyTeamSplitAISettings(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.A && parsed.B) {
        Settings.AI.A = Object.assign(Object.create(Settings.AI), parsed.A);
        Settings.AI.B = Object.assign(Object.create(Settings.AI), parsed.B);
        return;
    }
    Settings.AI.A = Object.assign(Object.create(Settings.AI), parsed);
    Settings.AI.B = Object.assign(Object.create(Settings.AI), parsed);
}

// Persist / Load from LocalStorage
if (typeof window !== 'undefined' && window.localStorage) {
    const savedCam = window.localStorage.getItem('camera_settings');
    if (savedCam) {
        try {
            const saved = JSON.parse(savedCam);
            Settings.camera = Object.assign(Settings.camera, saved);
        } catch (e) {
            console.error("Error loading camera settings:", e);
        }
    }
    const savedDuration = window.localStorage.getItem('match_duration');
    if (savedDuration) {
        const parsed = parseInt(savedDuration, 10);
        if (!isNaN(parsed)) {
            Settings.MATCH_DURATION = parsed;
        }
    }
    const savedFieldSize = window.localStorage.getItem('field_size_multiplier');
    if (savedFieldSize) {
        const parsed = parseFloat(savedFieldSize);
        if (!isNaN(parsed) && parsed >= 0.25 && parsed <= 10) {
            Settings.FIELD_SIZE_MULTIPLIER = parsed;
        }
    }
    const savedMute = window.localStorage.getItem('sounds_muted');
    if (savedMute !== null) {
        Settings.soundsMuted = (savedMute === 'true');
    }
    const savedDynamicStrategy = window.localStorage.getItem('dynamic_strategy_shifting');
    if (savedDynamicStrategy !== null) {
        Settings.AI.dynamicStrategyShifting = (savedDynamicStrategy === 'true');
    }
    const savedProjMode = window.localStorage.getItem('projection_mode');
    if (savedProjMode) {
        Settings.projectionMode = savedProjMode;
    }
    const savedWeather = window.localStorage.getItem('weather_state');
    if (savedWeather) {
        Settings.weather = savedWeather;
    }
    const savedSpeed = window.localStorage.getItem('play_speed_multiplier');
    if (savedSpeed) {
        const parsed = parseFloat(savedSpeed);
        if (!isNaN(parsed) && parsed >= 0.25 && parsed <= 10) {
            Settings.TIME_SPEED = parsed;
            Settings.DEFAULT_PLAY_SPEED = parsed;
        }
    }
    const savedAISplit = window.localStorage.getItem('ai_strategy_settings_team_split');
    const savedAILegacy = window.localStorage.getItem('ai_strategy_settings');
    const savedAI = savedAISplit || savedAILegacy;
    if (savedAI) {
        try {
            const parsed = JSON.parse(savedAI);
            if (savedAISplit) {
                applyTeamSplitAISettings(parsed);
            } else {
                const keys = [
                    'FORMATION_HOLD',
                    'ATTACK_SUPPORT_INTENSITY',
                    'DEFENSIVE_PRESS_INTENSITY',
                    'PASS_AGGRESSION'
                ];
                for (const key of keys) {
                    const val = parsed[key];
                    if (typeof val === 'number' && val >= 0 && val <= 1) {
                        Settings.AI[key] = val;
                    }
                }
                applyTeamSplitAISettings(parsed);
            }
        } catch (e) {
            console.error('Error loading AI strategy settings:', e);
        }
    }
    const savedDebugAI = window.localStorage.getItem('ai_debug_overlays');
    if (savedDebugAI) {
        try {
            const saved = JSON.parse(savedDebugAI);
            Settings.debugAI = Object.assign(Settings.debugAI || {}, saved);
        } catch (e) {
            console.error("Error loading debug AI settings:", e);
        }
    }
}

module.exports = { Settings };
