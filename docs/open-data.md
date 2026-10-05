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
| **NHAMCS ED** (NCHS/CDC, `--source nhamcs-2021-2022`; also `nhamcs-2022`, `nhamcs-2019-2022`) | Open download from ftp.cdc.gov | A national probability sample: about 16,000 visits a year (2022: 16,025 weighted to 155.4 million US ED visits); 2021–2022 pooled is 32,232 visits. Arrival hour and weekday, triage level, arrival by ambulance, wait to first provider, length of visit, every disposition, admitting unit (critical care, step-down, other), hospital stay, boarding minutes, tests ordered (lab, X-ray, CT, ultrasound), seen in the same ED in the previous 72 hours, and whether the ED has a fast track. | One department's daily volume and crowding (it samples many EDs). 35% of visits have no triage level. |
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

## NHAMCS 2021–2022: what the simulator now uses (fetched 2026-10-04)

`pnpm data:national` runs the full command (and `pnpm data:cms` refreshes the hospital list):

```sh
pnpm headless open-data --source nhamcs-2021-2022 --fetch --set beds.main=32 --set fastTrack.enabled=true \
  --set fastTrack.minAcuity=4 --set beds.fastTrack=6 \
  --set 'staffing.schedule.fastTrackClinician=[{"startHour":10,"hours":12,"count":1}]' \
  --set 'staffing.schedule.doctor=[{"startHour":8,"hours":12,"count":3},{"startHour":14,"hours":8,"count":1},{"startHour":20,"hours":12,"count":2}]'
```

The reader (`packages/sim/src/nhamcs.ts`) knows the 2019, 2020, 2021 and 2022 layouts, taken from each year's documentation. Before 2022, the disposition block and the fields at the end of the record sit two characters earlier. Every year is checked against its documentation's own tables, and the record counts, weighted totals and share female match exactly. Years are pooled with their weights averaged. 2021–2022 is the default: twice the sample of one year, and after the 2020 dip (fewer visits, sicker mix, shorter waits).

| Year | Median wait to provider | Median visit | Admitted | Left unseen |
|---|---|---|---|---|
| 2019 | 14 min | 168 min | 11.4% | 1.3% |
| 2020 | 11 min | 176 min | 14.5% | 1.0% |
| 2021 | 16 min | 193 min | 13.4% | 1.7% |
| 2022 | 16 min | 190 min | 11.8% | 1.9% |

National estimates, 2021–2022 pooled (weighted):

| Measure | Value |
|---|---|
| Median wait to first provider | 16 min (ESI 1 13, ESI 2 12, ESI 3 16, ESI 4 18, ESI 5 17) |
| Median length of visit | 193 min (ESI 1 218, ESI 2 287, ESI 3 225, ESI 4 125, ESI 5 100) |
| Admitted / left without being seen | 12.6% / 1.8% |
| Visits with a lab test / X-ray / CT / ultrasound | 60% / 37% / 24% / 6.5% |
| Visits by someone seen in the same ED in the previous 72 hours | 4.1% |
| Admitted patients going to critical care | 16% |
| Mean hospital stay, ward admissions / ICU admissions | 5.2 / 7.0 days (whole stay) |
| Visits to EDs with a separate fast track / a provider at triage | 65% / 54% (of EDs that answered, 2022) |
| Female / under 16 | 54% / 18% |

The fitted department is the typical US ED a planner starts from:
- about 98 visits a day and 32 beds
- a fast track (6 chairs for ESI 4–5, a clinician 10:00–22:00), since most visits are to EDs with one; without it the model makes ESI 4 wait twice as long as ESI 3, unlike the national data
- 72 provider-hours a day

It matches 11 of 12 checks:
- **Matched:** visits, the median and 90th-percentile wait to a provider (16 against 16 min), length of stay overall and at every triage level, leaving unseen and admissions.
- **Off:** boarding, 1.9 against 3.6 hours. With wards near full, one ward bed more or less swings it from over 5 hours to under 2.

Calibration fits a **registration** time, minutes from walking in to joining the triage queue (`triage.registrationMinutes`), whenever the data has provider times: 6.5 minutes here. National waits count from arrival, and without it the model's waits were 6 minutes short.

Further national checks:
- **Wait to a provider by triage level:** within 4 minutes at every level.
- **Test rates:** within 3 points.
- **Returns within 72 hours:** 4.1% against 4.1%. National returns are for any reason, so this is an upper bound for the model's missed-diagnosis returns.

The planner shows all of these under "How the starting department compares with US national figures".

**Children:** 18% of US ED visits are under 16 (median age 5). Conditions children come in with have a `childShare`, set so each triage level matches its national child share. Child profiles are described as children and drawn smaller in 3D. Profiles come from their own random stream, so results are unchanged.

Where it is used:
- **`params.ts` defaults:** arrivals by hour and weekday, ambulance share and admitting unit by triage level, test orders by condition (`fitOrderRates` rescales the hand-made table so each triage level orders each test at the national rate; conditions keep their differences, and a prescription refill still gets none), and the typical ward stay (5.2 days). Each is labelled with the source.
- **Planner example department:** the whole fit, staffing and fast track included (`apps/game/src/data/national.ts`).
- **New hospitals in the builder:** case mix, admissions, test times and patience; their own volume, beds and shifts.
- **Story levels:** they keep the arrival pattern they were balanced on (training scenarios, not data).

Not used: ICU and step-down stays. NHAMCS gives the whole hospital stay of patients admitted there, not the time in that unit, so those stay placeholders.

Terms (NCHS): statistical reporting and analysis only, with no attempt to identify anyone. Raw files stay in git-ignored `data/open/`; only aggregates are committed.

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
