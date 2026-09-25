# Pilot data request: emergency department visit records

**Purpose.** Calibrate an operational simulation of your emergency department and check that it reproduces
your recent performance before using it to test changes (staffing, layout, fast track, surge plans).
This is operational planning, not clinical decision support.

## What we need

One file (CSV) with **one row per ED visit** for a recent, typical period: **8–12 weeks** is ideal
(4 weeks is the minimum; a year lets us see seasons). **No names, no MRNs, no free text.**

| Column | Required | Example | Notes |
|---|---|---|---|
| `arrival_time` | **yes** | `2024-03-05 14:07` | Registration or arrival. Local clock time. |
| `acuity` | strongly preferred | `3` | Triage level (ESI 1–5, or CTAS/ATS). |
| `triage_time` | preferred | `2024-03-05 14:15` | Triage completed (or started — tell us which). |
| `provider_time` | **preferred** | `2024-03-05 14:52` | First provider (physician/APP) seen. |
| `decision_time` | preferred | `2024-03-05 17:30` | Disposition decision (admit/discharge). |
| `departure_time` | **yes** | `2024-03-05 18:10` | Left the ED (discharge, transfer or to the ward). |
| `disposition` | **yes** | `ADMITTED` | Discharged / admitted / transferred / left without being seen / left AMA. |
| `arrival_mode` | preferred | `AMBULANCE` | Ambulance or walk-in. |
| `age` | optional | `72` | Years, or a band (e.g. `70-79`). |
| `sex` | optional | `F` | |

Column names can differ; the importer recognises common names (e.g. `intime`, `esi`, `outtime`,
`arrival_transport`), and we can map others. Date formats `YYYY-MM-DD HH:MM` and `MM/DD/YYYY HH:MM` both work.
Shifting all dates by a fixed number of days is fine; please keep the weekday and time of day.

## Also helpful (a short note or spreadsheet is enough)

1. **Staffing:** providers and triage nurses by hour of day for a typical week (the roster pattern).
2. **Treatment spaces:** number of ED beds/cubicles, trauma/resus bays, fast-track chairs, hallway spaces used.
3. **Floor plan:** a PDF or image of the ED layout (to model walking distances).
4. **Wards / boarding:** for admitted patients, *bed requested* and *bed assigned* times if available,
   and the average inpatient length of stay. This makes the boarding model far more accurate.
5. **Workplace violence (optional, aggregate):** security incidents per month and security staffing.

## Privacy

- Only de-identified timestamps and codes; no identifiers or clinical notes.
- The calibration runs **locally in a web browser or on your own machine**; the file does not need to leave your organisation.
- Please follow your organisation's data governance process; an aggregate-only version (counts by hour, medians by acuity)
  can be used for a first pass if row-level data is not possible.

## What you get back

- A **baseline check**: your department's figures next to the model's (visits per day, door-to-provider,
  length of stay by acuity, left without being seen, admissions, boarding), each marked close or off.
- Then **what-if scenarios** of your choice, each reported as a range with a confidence interval for the change.

An example file in this format (synthetic, not real patients): `configs/planner/sample-visits.csv`.
