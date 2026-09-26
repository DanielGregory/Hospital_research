"""Tests for the Python wrapper. Run from the repo root: python3 -m unittest discover python/tests"""

import csv
import gzip
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from er_sim import ACTIONS, ErEnv, SimClient  # noqa: E402
from er_sim.calibrate import fit, load, main  # noqa: E402
from er_sim.client import SimError  # noqa: E402

SHORT = {"id": "py", "durationMinutes": 24 * 60, "staffing": {"doctors": 2}}


class ProtocolTest(unittest.TestCase):
    def test_reset_step_metrics(self):
        with SimClient() as c:
            obs = c.reset(SHORT, seed=3)
            self.assertEqual(obs["now"], 0)
            obs, done = c.step(120, [{"type": "setStaff", "role": "doctor", "count": 5}])
            self.assertEqual(obs["now"], 120)
            self.assertEqual(obs["staff"]["doctor"]["onDuty"], 5)
            self.assertFalse(done)
            with self.assertRaises(SimError):
                c.step(10, [{"type": "nonsense"}])
            _, done = c.step(24 * 60)
            self.assertTrue(done)
            self.assertGreater(c.metrics()["arrivals"], 50)


class EnvTest(unittest.TestCase):
    def test_episode_is_deterministic_and_actions_work(self):
        def episode():
            env = ErEnv(SHORT, step_minutes=120)
            try:
                obs, _ = env.reset(seed=5)
                total, observations = 0.0, [obs]
                for i in range(12):
                    obs, r, term, trunc, _ = env.step(1 if i < 2 else 0)  # call in two doctors, then wait
                    total += r
                    observations.append(obs)
                    if term:
                        break
                return total, observations, env.metrics()
            finally:
                env.close()

        a, b = episode(), episode()
        self.assertEqual(a[0], b[0])
        self.assertEqual(a[1], b[1])
        self.assertTrue(a[1][-1][0] >= 1.0 - 1e-9)  # ran to the end
        self.assertEqual(a[1][2][11], 4)  # doctors on duty after two +1 actions
        self.assertLess(a[0], 0)  # rewards are costs

    def test_more_doctors_less_waiting_reward(self):
        def total(action):
            env = ErEnv({**SHORT, "arrivals": {"rateMultiplier": 1.3}}, step_minutes=240)
            try:
                env.reset(seed=2)
                s = 0.0
                for _ in range(6):
                    _, r, term, _, _ = env.step(action)
                    s += r
                    if term:
                        break
                return s
            finally:
                env.close()

        # Hiring up to 7 doctors costs staffing reward but should beat leaving 2 to drown.
        self.assertGreater(total(ACTIONS.index("doctor+1")), total(ACTIONS.index("noop")))


def _write_csv(path, rows, fields):
    with gzip.open(path, "wt", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


class CalibrateTest(unittest.TestCase):
    def setUp(self):
        # Synthetic MIMIC-IV-ED-shaped data with known structure: 8 weeks, arrivals only
        # 08:00-19:59 (3/hour) except Sundays at half volume; ESI mix 10/20/40/20/10;
        # ESI 1-2 admitted 50%, others 10%; 5% LWBS; LOS 60 + 30 * (5 - ESI) minutes.
        rng = random.Random(1)
        self.dir = tempfile.TemporaryDirectory()
        d = Path(self.dir.name)
        stays, triage = [], []
        start = datetime(2180, 1, 3)  # a Monday
        sid = 0
        for day in range(56):
            date = start + timedelta(days=day)
            per_hour = 3 if date.weekday() != 6 else 1.5
            for hour in range(8, 20):
                n = int(per_hour) + (1 if rng.random() < per_hour % 1 else 0)
                for _ in range(n):
                    sid += 1
                    t = date + timedelta(hours=hour, minutes=rng.randrange(60))
                    esi = rng.choices([1, 2, 3, 4, 5], [10, 20, 40, 20, 10])[0]
                    u = rng.random()
                    dispo = "LEFT WITHOUT BEING SEEN" if u < 0.05 else ("ADMITTED" if rng.random() < (0.5 if esi <= 2 else 0.1) else "HOME")
                    los = 60 + 30 * (5 - esi)
                    transport = "AMBULANCE" if rng.random() < (0.7 if esi <= 2 else 0.1) else "WALK IN"
                    gender = "F" if rng.random() < 0.55 else "M"
                    stays.append({"subject_id": sid, "hadm_id": "", "stay_id": sid, "intime": t.strftime("%Y-%m-%d %H:%M:%S"), "outtime": (t + timedelta(minutes=los)).strftime("%Y-%m-%d %H:%M:%S"), "disposition": dispo, "arrival_transport": transport, "gender": gender})
                    triage.append({"subject_id": sid, "stay_id": sid, "acuity": f"{esi}.0" if rng.random() > 0.02 else ""})
        self.edstays = d / "edstays.csv.gz"
        self.triage = d / "triage.csv.gz"
        _write_csv(self.edstays, stays, ["subject_id", "hadm_id", "stay_id", "intime", "outtime", "disposition", "arrival_transport", "gender"])
        _write_csv(self.triage, triage, ["subject_id", "stay_id", "acuity"])

    def tearDown(self):
        self.dir.cleanup()

    def test_recovers_known_structure(self):
        fragment, report = fit(load(self.edstays, self.triage))
        rates = fragment["arrivals"]["hourlyRates"]
        self.assertTrue(all(r == 0 for h, r in enumerate(rates) if h < 8 or h >= 20))
        self.assertTrue(all(r > 2 for r in rates[8:20]))
        dow = fragment["arrivals"]["dayOfWeekMultipliers"]
        self.assertAlmostEqual(dow[6] / dow[0], 0.5, delta=0.1)
        mix = fragment["arrivals"]["acuityMix"]
        self.assertAlmostEqual(mix["3"], 0.4, delta=0.03)
        self.assertAlmostEqual(fragment["disposition"]["admitProbabilityByAcuity"]["1"], 0.5 * 0.95, delta=0.1)
        self.assertAlmostEqual(report["lwbsRate"], 0.05, delta=0.015)
        self.assertEqual(report["lengthOfStayByAcuity"]["5"]["median"], 60)
        amb = fragment["arrivals"]["ambulanceShareByAcuity"]
        self.assertAlmostEqual(amb["1"], 0.7, delta=0.1)
        self.assertAlmostEqual(amb["4"], 0.1, delta=0.05)
        self.assertAlmostEqual(report["femaleShare"], 0.55, delta=0.05)

    def test_cli_writes_a_runnable_fragment_and_compares(self):
        out = Path(self.dir.name) / "calibrated.json"
        base = Path(self.dir.name) / "base.json"
        base.write_text('{"id": "cal", "durationMinutes": 10080, "warmupMinutes": 1440}')
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        buf = StringIO()
        with redirect_stdout(buf), redirect_stderr(StringIO()):
            self.assertEqual(main(["--edstays", str(self.edstays), "--triage", str(self.triage), "--out", str(out), "--base", str(base), "--compare", "--seeds", "1"]), 0)
        import json

        cmp = json.loads(buf.getvalue())
        # The calibrated arrivals reproduce the data's volume.
        self.assertAlmostEqual(cmp["arrivalsPerDay"]["sim"] / cmp["arrivalsPerDay"]["data"], 1.0, delta=0.12)
        self.assertIn("losMedianByAcuity", cmp)


if __name__ == "__main__":
    unittest.main()
