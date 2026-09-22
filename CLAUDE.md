# ER Optimization Game — Project Spec (CLAUDE.md)

## What this is
A game where the player runs an emergency department: designing the layout, staffing, and patient process, then watching a realistic simulation play out. It ships **game-first** (story mode + sandbox). Research comes later and uses the **same simulation engine** in headless mode (optimizers, RL agents, benchmark).

## Non-negotiable principles
1. **The sim engine is fully decoupled from rendering/UI.** `packages/sim` has zero DOM, zero rendering, zero framework imports. The game only reads sim state and sends player commands.
2. **Deterministic.** Every run takes a seed. Same seed + same config + same commands = identical results. Never call `Math.random()` directly; use the seeded RNG.
3. **Config-driven.** Levels and sandbox setups are data (JSON), not code. A story level = sandbox config with locked switches + goals + narrative text.
4. **Every system is a toggleable module** (layout, staffing, process pipeline, diagnostic accuracy, boarding, budget, shocks). Disabled modules fall back to simple defaults. This powers both the sandbox switches and research ablations.
5. **Headless runner from day one.** A CLI runs any config at max speed and outputs metrics as JSON/CSV.
6. **Placeholder parameters are labeled.** All numeric parameters live in one params file, marked `// PLACEHOLDER` until calibrated against real data (MIMIC-IV-ED, CMS, NHS).
7. Wording: never say "optimal" in UI or output. Say "best found."

## Tech stack (changeable, but decide before coding)
- TypeScript monorepo (pnpm workspaces)
- `packages/sim` — pure TS discrete-event simulation engine
- `apps/game` — browser game (React + Canvas, or Phaser). Keep the rendering layer thin.
- `tools/headless` — Node CLI: `run --config level1.json --seed 42 --out results.json`
- Later: Python Gym-style wrapper that talks to the headless runner (JSON over stdio)
- Tests: Vitest

## Simulation model

### Core loop
Discrete-event simulation: priority queue of timestamped events (arrival, service start/end, deterioration check, shift change, shock). Sim clock in minutes. The game can run it at 1x, 2x, 8x, or pause.

### Patients
- `trueCondition` (hidden from player) and `trueAcuity` (ESI 1–5, 1 = most critical)
- `assignedAcuity` from triage (can be wrong)
- `diagnosis` (can be wrong, depending on process thoroughness)
- Timestamps for every stage, for metrics
- Can deteriorate while waiting (rate increases with true acuity and wait time)
- Can leave without being seen (LWBS) if the wait exceeds their patience

### Arrivals
Non-homogeneous Poisson process with hourly rates (day-of-week and hour-of-day patterns). Acuity mix is set per config. Shocks inject surges (flu season = sustained multiplier, mass casualty = burst of high-acuity arrivals).

### Resources
Doctors, nurses, techs, beds/rooms by type (triage, fast-track, acute, trauma, imaging, lab). Staff shifts come from the schedule config. Staff fatigue accumulates and slightly raises service time and error rate (module: `burnout`).

### Process pipeline (module: `process`)
The player builds a directed graph of steps: registration, triage, vitals, labs, imaging, doctor evaluation, disposition. Per step:
- which staff role performs it
- sequential vs parallel with other steps
- one `thoroughness` dial (0–1): higher = longer service time, higher diagnostic accuracy
- routing rules (e.g., acuity ≤ 2 goes to acute; 4–5 goes to fast track)
When the module is disabled, a fixed default pipeline is used.

### Diagnostic accuracy (module: `diagnosis`)
Probability of a correct diagnosis depends on the thoroughness of the steps the patient passed through. Misdiagnosis consequences are **delayed**: a bounce-back (patient returns within 72 sim-hours with higher acuity) or deterioration after discharge. Parameters are PLACEHOLDER; calibrate from published ranges later.

### Boarding (module: `boarding`)
Admitted patients need an inpatient bed. Inpatient capacity is limited and frees up at a configurable rate. Admitted patients with no inpatient bed stay in their ER bed, blocking it. This is the key "twist" mechanic: it should be the dominant bottleneck in the boarding crisis level.

### Layout (module: `layout`)
Grid-based floor plan inside a fixed footprint (can be L-shaped, narrow, etc.). Rooms have a type and capacity. Walking distance between rooms adds to transfer time (shortest path on the grid). When disabled, transfers take a constant time.

### Budget (module: `budget`)
Staff, rooms, and equipment cost money. Sandbox/budget mode enforces a cap.

## Metrics (computed for every run)
- Door-to-doctor time (median, p90)
- Length of stay by acuity
- LWBS rate
- Bounce-back rate (72h)
- Deterioration events while waiting
- Staff utilization and fatigue
- Boarding hours
- Cost
- Composite score (weights set per level)

## Story mode levels (each = config + goals + narrative)
1. **Quiet Night** — low intake, one doctor, triage basics
2. **Monday Morning** — arrival spike, adjust shifts
3. **Fast Track** — unlock a minor-cases lane
4. **Flu Season** — sustained overload, nonlinear queue blowup past ~85% utilization
5. **Boarding Crisis** — inpatient beds full; more ER staff barely helps
6. **Mass Casualty** — sudden high-acuity surge
7. **Budget Mode** — full systems, fixed budget, balanced score

Narrative framing: trainee in escalating simulations (Ender's Game tone). Reveal after level 1 that it was a real night (data-derived; keep hospital/date vague unless a partner hospital consents). Bigger twist later: compare player decisions with what the real hospital did. **Narrative text lives in level configs, never in the engine.**

## Sandbox
Every module toggle exposed. Presets include "layout only" (just design the floor plan; sim scores it quietly).

## Validation tests (credibility; do these early)
- **Determinism:** same seed → byte-identical metrics
- **Erlang C check:** with all modules off and a single M/M/c queue, simulated mean wait matches the analytic Erlang C formula within tolerance
- **Little's Law:** average number in system ≈ arrival rate × average time in system
- **Monotonicity sanity:** more doctors never increase mean wait when boarding is off

## Build phases
- **Phase 0:** monorepo, seeded RNG, event queue, arrivals, single queue + servers, metrics, headless CLI, validation tests
- **Phase 1:** Level 1 playable: minimal top-down view, patients as dots, speed controls, end-of-level metrics screen
- **Phase 2:** triage + acuity, fast track, shift scheduling, levels 2–4
- **Phase 3:** boarding, diagnosis/bounce-backs, levels 5–6
- **Phase 4:** layout editor with footprint shapes and walking distances
- **Phase 5:** process pipeline node editor, full sandbox toggles, level 7
- **Phase 6 (research):** baseline policies, layout/process optimizer (e.g., simulated annealing over configs), Python wrapper, calibration against MIMIC-IV-ED

## Working rules for Claude Code
- Finish and test one phase before starting the next.
- Any new sim feature ships with a unit test and, where possible, a headless run showing its effect.
- Never put sim logic in the game app.
- Keep the params file as the single source of truth for numbers.

## Repo status & commands
- **Phase 0 is done.** Next up: Phase 1.
- `pnpm install` — install workspace deps
- `pnpm test` — all Vitest suites (includes the validation tests in `packages/sim/test/validation.test.ts`)
- `pnpm typecheck` — TypeScript across all packages
- `pnpm headless run --config configs/examples/basic.json --seed 42 --out results.json` (`--format csv` for CSV)
- Params file: `packages/sim/src/params.ts`. Config schema: `packages/sim/src/config.ts`.
- Modules that are not built yet are rejected by config validation with the phase they belong to, so a config never silently enables something that does nothing.
