#!/usr/bin/env node
/**
 * Runs headless matches and reports play-state frames where the ball is
 * uncontested (no effective chaser / owner not acting).
 */
require('../tests/mock_env.js');

const { Time } = require('../kernel/core/lib/time.js');
const { Settings } = require('../kernel/settings.js');
const { Simulator, MatchStates } = require('../kernel/providers/simulator/simulator.js');
const { PlayerStates } = require('../kernel/core/entities/player.js');
const { applySettingsFromConfig } = require('../kernel/providers/simulator/headless_runner.js');

function createSeededRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function classifyDeadlock(sim) {
    const ball = sim.ball;
    const owner = ball.owner;
    const chasers = sim.getActiveChasers();
    const chaserStates = [...chasers].map(p => p.fsm.getNameOfCurrentState());
    const activeChasers = [...chasers].filter(p => p.fsm.isInState(PlayerStates.ChaseBall));

    if (owner) {
        if (owner.isSentOff) return 'owner-sent-off';
        if (owner.role === 'GK') return null; // intentional
        const st = owner.fsm.getNameOfCurrentState();
        if (st === 'Pass' || st === 'Shoot') {
            if (owner.kickTimer > 0) return 'owner-kick-windup';
            return 'owner-pass-shoot-stuck';
        }
        if (st !== 'Dribble' && st !== 'ChaseBall') return `owner-idle-state-${st}`;
        return null;
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    if (chasers.size === 0) {
        return speed < 0.15 ? 'loose-still-no-chasers' : 'loose-moving-no-chasers';
    }
    if (activeChasers.length === 0) {
        return speed < 0.15 ? 'loose-still-chasers-not-chasing' : 'loose-moving-chasers-not-chasing';
    }
    return null;
}

async function runDiagnosticMatch(seed, config) {
    applySettingsFromConfig(config);
    const prevRandom = Math.random;
    try {
        Math.random = createSeededRandom(seed);

        const sim = new Simulator();
        await sim.start();
        sim.active = true;

        const events = [];
        let prevMatchState = sim.matchState;
        const dt = 0.05;
        const streak = new Map();
        const MIN_STREAK = 6; // 0.3s at 20 UPS

        for (let frame = 0; frame < 25000 && sim.matchState !== 'fulltime'; frame++) {
            Time.deltaTime = dt;
            sim.updateAll();

            if (sim.matchState !== prevMatchState) {
                events.push({ type: 'state', from: prevMatchState, to: sim.matchState, frame, cardType: sim.cardType || null });
                prevMatchState = sim.matchState;
            }

            if (sim.matchState !== 'play') {
                streak.clear();
                continue;
            }

            const kind = classifyDeadlock(sim);
            if (!kind) {
                streak.clear();
                continue;
            }

            const key = kind;
            const s = streak.get(key) || { start: frame, count: 0, lastEvent: events[events.length - 1] };
            s.count++;
            streak.set(key, s);

            if (s.count === MIN_STREAK) {
                const ball = sim.ball;
                const owner = ball.owner;
                events.push({
                    type: 'deadlock',
                    kind,
                    frame,
                    durationFrames: MIN_STREAK,
                    afterState: s.lastEvent ? `${s.lastEvent.from}->${s.lastEvent.to}` : 'play',
                    cardType: s.lastEvent && s.lastEvent.cardType,
                    ball: { x: +ball.x.toFixed(2), y: +ball.y.toFixed(2), vx: +ball.vx.toFixed(3), vy: +ball.vy.toFixed(3), z: +ball.z.toFixed(2) },
                    owner: owner ? { name: owner.name, team: owner.team, sentOff: owner.isSentOff, state: owner.fsm.getNameOfCurrentState(), kickTimer: owner.kickTimer } : null,
                    chasers: sim.getActiveChasers().size,
                    activeChasers: [...sim.getActiveChasers()].filter(p => p.fsm.isInState(PlayerStates.ChaseBall)).map(p => p.name)
                });
            }
        }

        return { seed, score: `${sim.scoreA}-${sim.scoreB}`, events, deadlocks: events.filter(e => e.type === 'deadlock') };
    } finally {
        Math.random = prevRandom;
    }
}

async function main() {
    const config = {
        headless: true,
        teamA: 'Brazil',
        teamB: 'Argentina',
        formationA: '4-4-2',
        formationB: '4-3-3',
        matchDurationSeconds: 600,
        fieldSizeMultiplier: 1.0,
        timeSpeed: 1.0
    };

    Settings.REFEREE_STRICTNESS = 0.85;

    const seeds = [7, 13, 42, 99, 123, 256, 512, 9001];
    const all = [];

    for (const seed of seeds) {
        const result = await runDiagnosticMatch(seed, config);
        all.push(result);
        console.log(`seed ${seed}: ${result.score}, deadlocks=${result.deadlocks.length}`);
    }

    const byKind = new Map();
    const byAfter = new Map();
    for (const m of all) {
        for (const d of m.deadlocks) {
            byKind.set(d.kind, (byKind.get(d.kind) || 0) + 1);
            const ctx = d.afterState;
            byAfter.set(ctx, (byAfter.get(ctx) || 0) + 1);
        }
    }

    console.log('\n=== Deadlock kinds ===');
    [...byKind.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

    console.log('\n=== Preceding state transitions ===');
    [...byAfter.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

    console.log('\n=== Sample incidents (first 12) ===');
    const samples = all.flatMap(m => m.deadlocks.map(d => ({ seed: m.seed, ...d }))).slice(0, 12);
    for (const s of samples) {
        console.log(JSON.stringify(s));
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});