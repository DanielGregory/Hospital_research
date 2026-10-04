# Open data for the simulator

The simulator's numbers (`packages/sim/src/params.ts`) are placeholders until they are fitted to real
records. This page lists the open sources it can use, what each one can and cannot tell us, and how
to load them.

## One command

```sh
pnpm headless open-data --source mimic-ed-demo --fetch
```

This downloads the open MIMIC-IV-ED demo into `data/open/mimic-ed-demo/` (git-ignored), fits the
model to it and writes `configs/calibration/mimic-ed-demo.fitted.json`. That file holds the fitted
settings, a model-versus-data check and the citation. Options:

- `--visits-per-day 100` sets the daily volume (see "Shifted dates" below).
- `--config <department.json>` sets the department to fit (default: the planner's example).
- `--dir <folder>` reads files from another folder.
- `--out <file>` writes the result somewhere else.

## Sources

| Source | Access | What it gives | What it cannot give |
|---|---|---|---|
| **MIMIC-IV-ED Demo** (PhysioNet) | Open download | Arrival hour and weekday, triage acuity (ESI), admitted or not, arrival by ambulance, length of stay, sex | Daily volume (dates shifted), door-to-provider time, decision-to-admit time. Only about 200 stays: rough. |
| **NHAMCS 2022 ED** (NCHS/CDC, `--source nhamcs-2022`) | Open download from ftp.cdc.gov | A national probability sample: 16,025 visits weighted to 155.4 million US ED visits. Arrival hour and weekday, triage level, arrival by ambulance, wait to first provider, length of visit, every disposition, admitting unit (critical care, step-down, other), hospital stay, boarding minutes. | One department's daily volume and crowding (it samples many EDs). 35% of visits have no triage level. |
| **MIMIC-IV-ED** (PhysioNet) | Free, but needs a credentialed PhysioNet account (CITI training and a data use agreement). Download it yourself. | The same as the demo, from about 425,000 visits at one US academic ED: reliable shares by acuity, hourly patterns and length of stay | The same gaps as the demo. You may not redistribute the data, but fitted parameters with a citation are fine. |

The `open-data` command reads both sources. For the full dataset, sign in at
https://physionet.org/content/mimic-iv-ed/2.2/, download `ed/edstays.csv.gz` and `ed/triage.csv.gz`
into `data/open/mimic-ed/`, then run `pnpm headless open-data --source mimic-ed`.

## CMS Care Compare: start from a real hospital

`pnpm headless open-data --source cms-ed --fetch` downloads the current "Timely and Effective Care -
Hospital" file from data.cms.gov. The file name changes with each release, so it is read from the
dataset's metadata. The command writes `configs/open/cms-ed-hospitals.json`, compact rows for 4,130 hospitals:
- annual ED visits (the OP_22 denominator)
- median minutes in the ED for patients sent home, for all patients, for psychiatric patients and for transfers (OP_18b, a, c, d)
- share who left before being seen (OP_22)
- volume band

This is public-domain US government data. Cite CMS and the reporting period.

In the planner, "Start from a real hospital" searches that list. The chosen hospital becomes the
baseline (`fitToHospital`, `packages/research/src/hospital.ts`):
1. Volume comes from its visits a year.
2. Beds and shifts are scaled from the national starting department. The planner labels these as estimates until the hospital enters its own.
3. Test-result times and patience are fitted so the median time in the ED for patients sent home and the share leaving unseen match what it reports.

In the 3D builder, a real hospital sets the size and the patients a day.

Other open sources would add more:

- **NHS England A&E statistics** (monthly, per trust): 4-hour performance and 12-hour
  decision-to-admit waits.

None of these is wired in yet. Each needs its own reader, written against the real files.

## What the demo showed (fetched 2026-10-04)

The demo downloads and fits, but its people are not an ordinary ED population:

| Measure | Demo | Typical US ED |
|---|---|---|
| Visits (patients) | 222 (64) | — |
| Admitted | 68% | 15–20% |
| Arrived by ambulance | 60% | 15–20% |
| ESI 4–5 visits | 2 | about a third |

That fits it being drawn from patients in the hospital database, who are mostly people later admitted.
At the example department's usual volume (98 a day) this case mix overloads the model, and the
importer says so instead of fitting times. At 35 a day, the fitted model matches the demo's median
length of stay (overall and ESI 1–3), share leaving unseen and admission rate. Those results are in
`configs/calibration/mimic-ed-demo.fitted.json`.

Use them to check the pipeline, not as defaults. Defaults need the full dataset or a nationally
representative one (NHAMCS).

## NHAMCS 2022: what the simulator now uses (fetched 2026-10-04)

`pnpm headless open-data --source nhamcs-2022 --fetch --set beds.main=32` reads the fixed-width file
by the positions in the 2022 documentation (`packages/sim/src/nhamcs.ts`). The parse is checked
against the documentation's own tables: the weighted total is exactly 155,397,747 visits, and the
triage-level shares match.

National estimates (weighted):

| Measure | Value |
|---|---|
| Median wait to first provider | 16 min (90th percentile 98 min) |
| Median length of visit | 190 min (ESI 1 372, ESI 2 282, ESI 3 227, ESI 4 128, ESI 5 101) |
| Admitted | 11.8% (ESI 1 51%, ESI 2 32%, ESI 3 13%, ESI 4 2%) |
| Left without being seen | 1.9% |
| Admitted patients going to critical care / step-down / other | 17% / 4% / 79% |
| Median boarding (admit order to leaving the ED) | 62 min |

A mid-size department (about 98 visits a day, 32 beds) fitted to these figures matches 10 of 12 checks:
- **Matched:** wait to provider, share leaving unseen, admissions, boarding, and length of stay at every triage level.
- **Off:** the overall median stay, 217 vs 190 min. The 35% of visits without a triage level are not in the by-level targets and are probably quicker visits. The 90th percentile wait is also off, 151 vs 98 min.

Where it is used:
- **`params.ts` defaults:** arrivals by hour (scaled to the same daily total), weekday pattern, ambulance share by acuity, and admitting unit by acuity. These are labelled with the source.
- **Planner example department and new hospitals in the builder:** the whole fit (`apps/game/src/data/national.ts`): case mix, admission by acuity, test-result times and patience. The builder keeps its own volume and inpatient beds.
- **Story levels:** they keep the arrival pattern they were balanced on, written into each level's config. They are training scenarios, not data.

Terms (NCHS): statistical reporting and analysis only, with no attempt to identify anyone. The raw file
stays in git-ignored `data/open/`; only aggregates are committed.

## Shifted dates

MIMIC moves each patient's dates by a random offset, into the years 2110–2210. Time of day and day of
week are kept, but visits from different patients are no longer on a shared calendar. Daily volume
and crowding cannot be read from it. The importer lays the visits out at a volume you choose, keeping
each one's weekday and time of day. That volume is a setting, and the output says so.

## Network access

The cloud environment's network policy currently blocks `physionet.org`, `cdc.gov`, `ftp.cdc.gov`,
`data.cms.gov` and `england.nhs.uk`. To allow them, open the cloud environment menu in the session's
title bar, choose **Edit**, and under **Network access** pick a broader level or add the hosts under
Allowed domains. See https://code.claude.com/docs/en/cloud-environments#network-access.

Or download the files on your own machine and add them to `data/open/<source>/`.

## From a fit to the params file

A fit is evidence, not a change: the planner and the headless tools can use the fitted file directly.
To make fitted numbers the defaults:
1. Check the model-versus-data rows in the output.
2. Copy the settings into `params.ts`.
3. Replace each `// PLACEHOLDER` with the source and version, e.g. `// MIMIC-IV-ED 2.2 (fitted 2026-10)`.
4. Re-run `pnpm test` and the level benchmarks (`pnpm headless benchmark --config … --write`), because
   story levels are balanced against the current defaults.
