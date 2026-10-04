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
| **MIMIC-IV-ED** (PhysioNet) | Free, but needs a credentialed PhysioNet account (CITI training and a data use agreement). Download it yourself. | The same as the demo, from about 425,000 visits at one US academic ED: reliable shares by acuity, hourly patterns and length of stay | The same gaps as the demo. You may not redistribute the data, but fitted parameters with a citation are fine. |

The `open-data` command reads both sources. For the full dataset, sign in at
https://physionet.org/content/mimic-iv-ed/2.2/, download `ed/edstays.csv.gz` and `ed/triage.csv.gz`
into `data/open/mimic-ed/`, then run `pnpm headless open-data --source mimic-ed`.

Other open sources would fill the gaps above:

- **NHAMCS** (US CDC, national sample; public use, no account): wait to see a provider, length of
  stay, triage level, arrival mode and admission.
- **CMS Care Compare** (per US hospital, API): median ED time, share leaving unseen, ED volume band.
  These are useful as targets for one hospital.
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
