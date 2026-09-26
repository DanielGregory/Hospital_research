"""Calibrate simulation parameters from MIMIC-IV-ED (or any data in the same shape).

Reads `edstays.csv[.gz]` (stay_id, intime, outtime, disposition, ...) and
`triage.csv[.gz]` (stay_id, acuity, ...) and writes a config fragment with:

- arrivals.hourlyRates        mean arrivals per hour of day
- arrivals.dayOfWeekMultipliers
- arrivals.acuityMix          share of triaged stays by ESI level
- disposition.admitProbabilityByAcuity
- arrivals.ambulanceShareByAcuity (if `arrival_transport` is present)

plus a report of what the data says about things the simulation produces
rather than takes as input (length of stay by acuity, LWBS rate). With
`--compare`, it runs the simulation with the fragment and prints data vs sim.
With `--fit-workup`, it also scales workup (test-result) times so median length
of stay by acuity matches the data (a few rounds of proportional correction).

MIMIC-IV shifts dates into the future per patient but keeps the day of week and
time of day, which is all this uses.

    python -m er_sim.calibrate --edstays edstays.csv.gz --triage triage.csv.gz --out calibrated.json --compare
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from .client import run_headless

TIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S")
ADMITTED = {"ADMITTED"}
LWBS = {"LEFT WITHOUT BEING SEEN", "ELOPED"}
AMBULANCE = {"AMBULANCE", "HELICOPTER"}
WALK_IN = {"WALK IN"}


def _open(path: str | Path) -> Iterator[dict[str, str]]:
    p = Path(path)
    opener = gzip.open if p.suffix == ".gz" else open
    with opener(p, "rt", newline="") as f:  # type: ignore[operator]
        yield from csv.DictReader(f)


def _time(s: str) -> datetime | None:
    for fmt in TIME_FORMATS:
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _quantile(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))]


def load(edstays: str | Path, triage: str | Path) -> list[dict[str, Any]]:
    """One record per stay: arrival time, length of stay (min), ESI (or None), disposition."""
    acuity: dict[str, int] = {}
    for row in _open(triage):
        try:
            a = int(float(row.get("acuity") or ""))
        except ValueError:
            continue
        if 1 <= a <= 5:
            acuity[row["stay_id"]] = a
    stays = []
    for row in _open(edstays):
        t_in, t_out = _time(row.get("intime", "")), _time(row.get("outtime", ""))
        if t_in is None:
            continue
        stays.append(
            {
                "intime": t_in,
                "los": (t_out - t_in).total_seconds() / 60 if t_out and t_out >= t_in else None,
                "acuity": acuity.get(row["stay_id"]),
                "disposition": (row.get("disposition") or "").strip().upper(),
                # Optional columns (MIMIC-IV-ED has both): how they came, and sex.
                "transport": (row.get("arrival_transport") or "").strip().upper(),
                "gender": (row.get("gender") or "").strip().upper(),
            }
        )
    if not stays:
        raise ValueError("no usable stays in edstays")
    return stays


def fit(stays: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (config fragment, report)."""
    days = sorted({s["intime"].date() for s in stays})
    n_days = len(days)
    by_hour = Counter(s["intime"].hour for s in stays)
    hourly = [by_hour[h] / n_days for h in range(24)]

    # Day-of-week multipliers: mean arrivals on that weekday / mean over all days.
    per_day = Counter(s["intime"].date() for s in stays)
    dow_counts: dict[int, list[int]] = defaultdict(list)
    for d in days:
        dow_counts[d.weekday()].append(per_day[d])
    overall = sum(per_day.values()) / n_days
    dow = [round(statistics.mean(dow_counts[i]) / overall, 4) if dow_counts[i] else 1.0 for i in range(7)]
    # Hourly rates are an all-days average, so they already include the weekday mix;
    # dividing by the mean multiplier keeps total volume right once multipliers are applied.
    mean_mult = sum(dow) / 7
    hourly = [round(h / mean_mult, 4) for h in hourly]

    triaged = [s for s in stays if s["acuity"] is not None]
    mix_counts = Counter(s["acuity"] for s in triaged)
    mix = {str(a): round(mix_counts[a] / len(triaged), 4) for a in range(1, 6)} if triaged else {}

    admit: dict[str, float] = {}
    los_by: dict[str, dict[str, float | None]] = {}
    for a in range(1, 6):
        group = [s for s in triaged if s["acuity"] == a]
        if group:
            admit[str(a)] = round(sum(s["disposition"] in ADMITTED for s in group) / len(group), 4)
        treated = [s["los"] for s in group if s["los"] is not None and s["disposition"] not in LWBS]
        los_by[str(a)] = {"n": len(treated), "median": _quantile(treated, 0.5), "p90": _quantile(treated, 0.9)}

    # Ambulance share by acuity, from stays whose arrival transport is known.
    known = [s for s in triaged if s["transport"] in AMBULANCE | WALK_IN]
    ambulance: dict[str, float] = {}
    for a in range(1, 6):
        group = [s for s in known if s["acuity"] == a]
        if group:
            ambulance[str(a)] = round(sum(s["transport"] in AMBULANCE for s in group) / len(group), 4)
    sexed = [s for s in stays if s["gender"] in ("F", "M")]

    arrivals: dict[str, Any] = {"hourlyRates": hourly, "dayOfWeekMultipliers": dow, "acuityMix": mix}
    if ambulance:
        arrivals["ambulanceShareByAcuity"] = ambulance
    fragment = {
        "arrivals": arrivals,
        "disposition": {"admitProbabilityByAcuity": admit},
    }
    report = {
        "stays": len(stays),
        "days": n_days,
        "arrivalsPerDay": round(overall, 2),
        "triagedShare": round(len(triaged) / len(stays), 4),
        "lwbsRate": round(sum(s["disposition"] in LWBS for s in stays) / len(stays), 4),
        "admissionRate": round(sum(s["disposition"] in ADMITTED for s in stays) / len(stays), 4),
        "lengthOfStayByAcuity": los_by,
        "dispositions": dict(Counter(s["disposition"] for s in stays).most_common()),
        "femaleShare": round(sum(s["gender"] == "F" for s in sexed) / len(sexed), 4) if sexed else None,
        "arrivalTransport": dict(Counter(s["transport"] for s in stays if s["transport"]).most_common()),
    }
    return fragment, report


def merge(base: dict[str, Any], fragment: dict[str, Any]) -> dict[str, Any]:
    out = json.loads(json.dumps(base))
    for k, v in fragment.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out


def compare(config: dict[str, Any], report: dict[str, Any], seeds: list[int]) -> dict[str, Any]:
    """Run the sim and line it up against the data."""
    ms = run_headless(config, seeds)
    days = [(m["simMinutes"] - m["window"]["start"]) / 1440 for m in ms]
    mean = lambda f: statistics.mean(f(m) for m in ms)  # noqa: E731
    return {
        "arrivalsPerDay": {"data": report["arrivalsPerDay"], "sim": round(statistics.mean(m["arrivals"] / d for m, d in zip(ms, days)), 2)},
        "lwbsRate": {"data": report["lwbsRate"], "sim": round(mean(lambda m: m["lwbsRate"]), 4)},
        "admissionRate": {"data": report["admissionRate"], "sim": round(mean(lambda m: m["admitted"] / max(1, m["arrivals"])), 4)},
        "losMedianByAcuity": {
            a: {"data": report["lengthOfStayByAcuity"][a]["median"], "sim": _mean_or_none([m["lengthOfStayByAcuity"][a]["median"] for m in ms])}
            for a in ("1", "2", "3", "4", "5")
        },
    }


def _mean_or_none(xs: list[float | None]) -> float | None:
    ys = [x for x in xs if x is not None]
    return round(statistics.mean(ys), 1) if ys else None


def fit_workup(config: dict[str, Any], report: dict[str, Any], seeds: list[int], rounds: int = 4) -> dict[str, Any]:
    """Scale workup means per acuity so the simulated median LOS matches the data."""
    params_default = {"1": 90, "2": 90, "3": 75, "4": 20, "5": 0}  # PARAMS.workup defaults (see params.ts)
    workup = {**params_default, **config.get("workup", {}).get("meanMinutesByAcuity", {})}
    for _ in range(rounds):
        cfg = merge(config, {"workup": {"enabled": True, "meanMinutesByAcuity": workup}})
        cmp = compare(cfg, report, seeds)["losMedianByAcuity"]
        for a, v in cmp.items():
            if v["data"] is None or v["sim"] is None:
                continue
            gap = v["data"] - v["sim"]
            workup[a] = max(0.0, round(workup[a] + gap, 1))
    return {"workup": {"enabled": True, "meanMinutesByAcuity": workup}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--edstays", required=True)
    ap.add_argument("--triage", required=True)
    ap.add_argument("--out", required=True, help="config fragment (JSON) to write")
    ap.add_argument("--report", help="data summary (JSON) to write")
    ap.add_argument("--base", help="base config to merge the fragment into for --compare (default: a 4-week run)")
    ap.add_argument("--compare", action="store_true", help="run the simulation and print data vs sim")
    ap.add_argument("--fit-workup", action="store_true", help="also fit workup times to median LOS by acuity")
    ap.add_argument("--seeds", type=int, default=3)
    args = ap.parse_args(argv)

    fragment, report = fit(load(args.edstays, args.triage))
    base = json.loads(Path(args.base).read_text()) if args.base else {"id": "calibrated", "durationMinutes": 28 * 1440, "warmupMinutes": 1440}
    seeds = list(range(1, args.seeds + 1))
    if args.fit_workup:
        fragment = merge(fragment, fit_workup(merge(base, fragment), report, seeds))
    Path(args.out).write_text(json.dumps(fragment, indent=2) + "\n")
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2, default=str) + "\n")
    print(f"{report['stays']} stays over {report['days']} days ({report['arrivalsPerDay']}/day); wrote {args.out}", file=sys.stderr)
    if args.compare:
        print(json.dumps(compare(merge(base, fragment), report, seeds), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
