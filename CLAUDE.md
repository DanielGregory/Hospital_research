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
- **Phases 0–6: done.** Calibration code exists but has not been run on real data (MIMIC-IV-ED needs credentialed access); all numbers in `params.ts` are still PLACEHOLDER.
- `pnpm install` / `pnpm test` / `pnpm typecheck`
- `pnpm game`: run the browser game (Vite dev server). `pnpm e2e`: build it and play levels 1–2 in headless Chromium (light + dark, mobile width). `SCREENSHOTS=dir pnpm e2e` saves screenshots.
- `pnpm headless run --config configs/examples/basic.json --seed 42 --out results.json` (`--format csv` for CSV)
- `pnpm headless run --config configs/levels/level-03-fast-track.json --seeds 1-40 --set fastTrack.enabled=true` prints the level pass rate. `--set path=value` overrides any config value (JSON or bare string).
- `pnpm headless balance --config configs/levels/<level>.json` shows how often the shipped setup, the level's reference solution and its trap meet the goals across 40 days, plus the days that separate them (candidates for `level.seed`).
- Aggregate calibration: `pnpm headless calibrate --config configs/calibration/base-week.json --targets configs/calibration/us-aggregates.targets.json --out configs/calibration/us-aggregates.fitted.json`. **The targets file is UNVERIFIED** (written from memory; the source sites were unreachable from the build environment). Verify each number against its listed source before applying the fitted fragment to `params.ts`, then change the affected `// PLACEHOLDER` labels to cite the source.
- Research: `pnpm headless policy --config <c> --policy all-heuristics --seeds 1-10`, `pnpm headless optimize --config configs/levels/level-07-budget-mode.json --space configs/research/space-level7.json --iterations 200`, `pnpm headless serve` (JSON lines). Python: `python/README.md`; `pnpm test:python`.
- Params file: `packages/sim/src/params.ts`. Config schema: `packages/sim/src/config.ts`. Levels: `packages/sim/src/levels.ts`, `configs/levels/`.
- Modules that are not built yet are rejected by config validation with the phase they belong to, so a config never silently enables something that does nothing.

## Implementation decisions (keep consistent)
- **Research (Phase 6, `packages/research`):** baseline policies are `Policy.decide(snapshot) → commands`, run every N minutes (`runWithPolicy`); their command logs replay exactly. The optimizer is simulated annealing over discrete dimensions (dot paths + ordered values), scoring every candidate on the same seeds; setups that fail `checkSetup` are infeasible. Output says "best found", never "optimal". `Session` implements the JSON-lines protocol behind `headless serve` and the Python `SimClient`/`ErEnv`. Calibration (`python/er_sim/calibrate.py`, stdlib only) fits arrivals, acuity mix and admission by acuity (`disposition.admitProbabilityByAcuity`), and optionally workup times to median LOS.
- **Process module (Phase 5):** `process.steps` (StepInput JSON: role, meanMinutes or meanMinutesByAcuity, turnaroundMinutes, thoroughness, after, inBed, acuity range, lanes) plus `process.routing` rules (assigned acuity → lane). Config validation requires staff for every role a step uses. Writing the default pipeline out as a process gives byte-identical results (tested). Per-step times are recorded in `patient.steps`.
- **Cost (every run) and budget module:** rates in `PARAMS.budget` (placeholder currency). `metrics.cost` = staff-hours × wage + treatment spaces × daily rate (occupied beds when unlimited) + escalation hours + floor space (layout). The budget module caps the *planned* daily cost of the starting setup (`checkBudget`; `checkSetup` = level limits + budget). The game and CLI block or flag setups over the cap.
- **Composite score (every run):** `score.terms` (metric, weight, target, worst; default `PARAMS.score.terms`) → 0–100. Missing data counts as on target. Level 7's goal is the score plus cost per day.
- **Game Phase 5:** Sandbox screen (every module toggle, presets, knobs, process editor with a DAG preview, quick test, watch, export). Debrief shows the score breakdown; setup shows planned cost against the cap.
- **Layout module (Phase 4, `layout.ts`):** a grid footprint (rows of `#`/`.` or a preset: rectangle, lShape, uShape, narrow) holding typed rooms (waiting, triage, acute, fastTrack, station, imaging, lab) with capacities. Corridors are footprint cells outside rooms. Doors default to the edge cell nearest the entrance. Distances are corridor BFS, door to door. With the module on, bed counts come from acute/fastTrack rooms (`setBeds` is rejected). Patients walk from the waiting room to their bed before in-bed work starts. Staff work from a home base (station; triage nurses from their triage room) and make a round trip per task, including walking back to document; triage nurses fetch patients from the waiting room. `PARAMS.layout.minutesPerCell` sets walking speed. Off: transfers take `disabledTransferMinutes` (0), so earlier results are unchanged.
- **Game sandbox:** the Layout editor (menu → Sandbox) draws rooms on an SVG grid and validates live. "Test this layout" averages three headless weeks and tracks the best found this session; "Export config" downloads a runnable JSON; "Watch a shift" plays it in the grid view (`render/gridPlan.ts`). Sandbox runs have no level: every live control is available and there are no goals.
- **Step graph (Phase 3):** a visit is a DAG of steps (`pipeline.ts`). The default, used while `process` is off, is triage → [bed] → doctorEval → workup (results; bed held, no staff) → disposition (a short second doctor contact). A step starts when its `after` steps are done; several can run in parallel. Doctor steps for fast-track patients go to fast-track clinicians. Disposition runs last and decides admit or discharge. Each patient draws all their randomness from their own stream (`walkIn:n`, `massCasualty:i:k`, `bounceBack:id`), so one patient's draws never shift another's.
- **Beds:** `beds.main` / `beds.fastTrack` (null = unlimited; params default 20 / 6). The patient takes a bed before their first in-bed step and keeps it until departure, or until an inpatient bed frees up if they are boarding. Bed queues follow the queue discipline.
- **Conditions:** hidden `conditionId` per patient from `PARAMS.conditions` (sets admission chance and how easy it is to miss). Metrics group by *initial* true acuity.
- **Deterioration** (always available, `deterioration.enabled`): Weibull time-to-worsen by current acuity, only until first doctor contact. Staff notice, so a triaged patient's priority is raised. Deteriorated patients need longer evaluations, a real feedback loop: an understaffed ED without LWBS can spiral.
- **Boarding module:** inpatient beds for ED admissions only; ward discharges are a time-of-day Poisson process. `boarding.escalation` (hospital full-capacity protocol) adds discharges. Off: admitted patients leave at once.
- **Diagnosis module:** miss probability = condition missRisk × thoroughness factor × fatigue factor. A miss sends the patient home; with `bounceBackProbability` they return within 72 h, one level sicker, as a new arrival. Thoroughness also scales diagnostic step times (1.0 at the 0.5 baseline). Off: no misses.
- **Shocks module:** `surge` (rate multiplier over a window) and `massCasualty` (burst of arrivals, field-triaged by default so they skip the triage desk).
- **Burnout module:** fatigue = busy hours × rate + hours on shift × rate. It slows service and raises triage and diagnosis errors. Scheduled staff are new people each shift; fixed staff hand over every 12 h.
- **Default doctors are 4** since Phase 3: dispositions add doctor time, and 3 doctors spiral without LWBS.
- **Levels** carry designer-only `reference` (a sensible solution), optional `trap` (a tempting wrong answer), `designNote` and `minCrossSeedGap`. Balance tests read these from the configs.
- **Game (`apps/game`):** Vite + React, with the floor drawn on a Canvas. `runner.ts` only advances the clock (1x = 4 sim-minutes per real second; 1/2/8x, pause, "End shift") and forwards commands. `render/floorPlan.ts` is a pure layout function (tested); `render/draw.ts` paints it. Dots show *assigned* acuity (grey until triaged); true acuity is never shown during play. Setup screens edit only a level's `playerControls`, and `buildConfig` ignores anything else. Demand and on-duty charts come from `hourlyLoad` / `onDutyByHour` in the sim.
- **Trauma bays:** the first `beds.traumaBays` main beds (default `PARAMS.beds.traumaBays`, 2; with the layout module, the beds in `trauma` rooms, numbered first) are trauma bays. Patients triaged at or below `PARAMS.beds.traumaMaxAcuity` take a free bay first; others take a bay only when no regular bed is free. It changes which bed a patient gets, never how many are in use, so results without the layout module are identical with or without bays (tested). The snapshot reports `beds.main.traumaBays`.
- **3D view and walking (game only):** the play screen defaults to a three.js 3D view (`render/scene3d.ts`, its own lazily loaded chunk); 2D stays one click away and is the fallback without WebGL. Without the layout module the 3D floor comes from `render/wardPlan.ts`, laid out like a real department: curtained cubicles along both walls of the main ED (heads to the wall, privacy curtain drawn while a clinician is with the patient, monitor and drip stand), a nurses' station island, trauma rooms by the ambulance door, triage booths, fast-track recliners, and ambulance arrivals on trolleys (lined up in the corridor while they wait). The nurses' station is a U of counters (raised outer ledge, desk-height inside) that staff sit inside facing out, with workstations, a medicine cabinet and a tracking board that lists the patients in beds live. Paramedics push ambulance arrivals in on trolleys and wait with them; porters wheel admitted patients to the lifts. With the layout module, `render/gridFurnish.ts` furnishes the player's rooms the same way (cubicles along the walls with an aisle, waiting chairs, triage desks, workstations, CT scanner, lab bench, trolleys in the corridor), keeping the engine's bed numbering and falling back to plain beds where cubicles do not fit. Patients change into gowns once in bed; doctors wear white coats; hovering over someone describes them. Plans carry furniture as data (`props`, `bays`, `enclosures`); the scene only draws it. Both views animate people with `render/motion.ts` (`Crowd`): the sim still decides where everyone is, and the crowd only walks them there along routes from the plan's `nav` (default floor: doors onto a corridor, aisles between beds; layout module: BFS over corridor cells). Newcomers enter by the entrance (mass casualties by the ambulance door), leavers walk out (admissions to the wards), and anyone far behind speeds up to catch up. Purely visual: nothing feeds back into the sim.
- **Level 1:** one doctor, 22:00–08:00. With ESI 1 pre-emption, acuity order beats arrival order by ~25 points across random nights; the level seed is a night where it clearly does.
- **Pre-emption** (`queue.preemptAcuity`, default 1, acuity ordering only): an ESI 1 patient ready for a doctor, with no doctor free, takes the doctor whose current patient is least urgent (most recently started first). The interrupted task goes back in the queue and resumes with its remaining time. Implemented with a per-staff task token so the paused task's end event is ignored.
- **Story claims:** narrative text must not claim the scenarios are real data until they are (calibrated against real or partner-hospital records). The "it was a real night" / "compared with the real department" reveals from the spec are held back until then; current debriefs foreshadow instead.
- **Default pipeline** (used while `process` is off): arrival → triage queue (FIFO) → triage nurse → doctor queue → doctor → discharge. Its knobs are plain config sections, not modules: `triage` (enabled, time, accuracy), `queue.discipline` (`acuity` | `fifo`), `fastTrack`, `lwbs`. The Phase 5 `process` module replaces this with the node graph.
- **Roles:** `triageNurse`, `doctor`, `fastTrackClinician`. Fast-track clinicians see only the fast-track lane. Free main-ED doctors take fast-track overflow (`fastTrack.doctorsTakeOverflow`, default true). Without overflow, a fast track splits capacity and does worse than no fast track.
- **Triage** errors are off by one ESI level (under/over split in params). Queue priority uses *assigned* acuity; metrics group by *true* acuity.
- **LWBS** landed in Phase 2 because queue priority and fast track only show a measurable effect when low-acuity patients can leave. Patience is lognormal, and ESI 1–2 never leave by default. Deterioration while waiting is still not modeled.
- **Staffing module:** shift schedules per role; staff finish their current patient after their shift ends. `setStaff` holds until that role's next shift boundary. `setSchedule` replaces future shifts. With the module off, schedules are ignored and fixed counts are used.
- **Commands:** `setStaff`, `setSchedule`, `setQueueDiscipline`, `setFastTrack`, `setBeds`, `setEscalation`, plus the live decisions below. Live commands are logged, and the log replays byte-identically.
- **Live decisions (sim):** `setProcess` (process module only) gives new arrivals a new step graph; each patient keeps the version of the process in force when they arrived (`Runtime.pipe`), so a change never corrupts a visit in progress, and routing changes apply at once to anyone still waiting for a bed. `setThoroughness` does the same for diagnostic steps. `callIn` (on-call staff arrive after `PARAMS.liveCalls.callInDelayMinutes`, stay `callInHours`, cost `callInWageMultiplier`× pay, limited by `liveCalls.maxCallIns`; they sit outside schedules and fixed counts). `setDiversion`: walk-in-stream patients who come by ambulance (share by acuity in `PARAMS.arrivals.ambulanceShareByAcuity`, drawn from their own `mode:` stream so nobody else's draws change) are turned away unless ESI ≤ `diversionSparesAcuity`; each costs `diversionCostPerPatient`. `setHallwayBeds`: extra main-ED spaces past the capacity, used only when every bed is full, `hallwayServiceFactor` slower; a hallway patient moves into the next free cubicle. `moveStaff` changes one person's role now. Mass casualties are announced in `snapshot.incidents` `incidentWarningMinutes` ahead. Existing results are unchanged by all of this (tested).
- **Debrief analysis (sim):** `metrics.waits` attributes patient-hours of waiting to triage / bed / doctor / results / boarding; `sim.timeline` samples the department every `TIMELINE_STEP` minutes without adding events; `deterioration.critical` counts patients who became ESI 1 while waiting; `diagnosis.bounceBacksAfterRun` counts misses due back after the run; `metrics.live` and `cost.calls` cover the live decisions.
- **Live play (game):** levels list their live calls (`level.liveCalls`) and may unlock `process.steps` (Level 6 runs the process module with its default process written out, which gives identical results). The play screen has quick controls and calls in "Right now", and "Adjust the plan…" opens a drawer (game paused) for shifts, thoroughness and the process editor. Alerts (`play/alerts.ts`, presentation only, with cooldowns) cover incidents, unseen emergent patients, crowding, full beds, boarding and people leaving; serious ones pause the game if "Pause on alerts" is on. Ambulance arrivals come in by the ambulance door on trolleys pushed by paramedics and wait (and are triaged) in the corridor.
- **Debrief (game):** "What happened" (`play/explain.ts`: main bottleneck in words, worst moment, people who left, critical events, bounce-backs still to come, the player's decisions), a waiting-by-cause bar chart and a timeline with the player's decisions and incidents marked (palette slots validated with the dataviz validator; table view for accessibility).
- **Stars, daily challenge, onboarding, sound (game):** stars = goals met, plus `level.stars.two/three` score thresholds; best per level saved in the browser. The daily challenge picks a level (2–7 in turn) and a seed from the UTC date, so everyone plays the same shift; `?daily=YYYY-MM-DD` links open it and the debrief offers a share line. Level 1 teaches through `level.coach` tips that fire on moments (start, first triage, first bed, emergent patient waiting, first person leaving); tip text lives in the level config. Sound is generated in the browser (monitor beeps, alert chime, siren, a murmur that grows with the waiting room), starts on the first click, and can be muted. Patients and staff get fictional names (`play/names.ts`).
- **Common random numbers:** every per-patient draw (acuity, service, triage time and result, patience) happens at arrival from its own stream, whatever the config.
- **Levels:** `level` block in the config: narrative, goals (metric dot-paths with max/min), `playerControls` (everything else is locked), `limits` (staff-hours/day, max on duty), and a fixed `seed` (story mode replays one specific day). `packages/sim/test/levelBalance.ts` holds a reference solution per level. The balance tests check that the shipped setup fails, the reference passes on the level seed, and the reference beats the shipped setup by ≥25 points across other seeds. After changing params or engine behavior, re-run them and re-tune goals if needed.
