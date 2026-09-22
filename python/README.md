# er_sim (Python)

Python access to the simulation engine, standard library only. It starts the TypeScript engine as a subprocess (`pnpm headless serve`, JSON lines over stdio), so run `pnpm install` in the repo first.

```python
import sys; sys.path.insert(0, "python")
from er_sim import ErEnv, ACTIONS

env = ErEnv({"id": "rl", "durationMinutes": 7 * 1440, "modules": {"boarding": True}}, step_minutes=60)
obs, info = env.reset(seed=1)
done = False
while not done:
    obs, reward, done, truncated, info = env.step(ACTIONS.index("noop"))
print(env.metrics()["compositeScore"])
env.close()
```

- `ErEnv`: Gym-style `reset`/`step`. Observations are listed in `er_sim.env.OBSERVATION_NAMES`. The default reward charges for patient-hours waiting, LWBS, deterioration, bounce-backs and doctor-hours (weights in `RewardWeights`, all placeholders). With `gymnasium` and `numpy` installed, `er_sim.env.make_gym_env(config)` returns a real `gymnasium.Env`.
- `SimClient`: the raw session (`reset`, `step(minutes, commands)`, `metrics`). Commands are the engine's own (`setStaff`, `setSchedule`, `setQueueDiscipline`, `setFastTrack`, `setBeds`, `setEscalation`).
- `run_headless(config, seeds)`: full runs, returning metrics.

## Calibration against MIMIC-IV-ED

MIMIC-IV-ED needs credentialed PhysioNet access, so it is not in this repo. With your copy:

```sh
python3 -m er_sim.calibrate --edstays mimic-iv-ed/ed/edstays.csv.gz --triage mimic-iv-ed/ed/triage.csv.gz \
  --out calibrated.json --report calibration-report.json --compare --fit-workup
```

(run from `python/`, or put `python/` on `PYTHONPATH`). This writes a config fragment: arrival rates by hour of day and day of week, the acuity mix, admission probability by acuity and, with `--fit-workup`, workup times fitted to median LOS by acuity. `--compare` prints data vs simulation for volume, LWBS, admissions and LOS. Merge the fragment into a level or sandbox config; parameters it cannot fit (patience, service-time spread, triage accuracy) stay PLACEHOLDER in `params.ts`.

Tests: `pnpm test:python` (uses synthetic data in the MIMIC format).
