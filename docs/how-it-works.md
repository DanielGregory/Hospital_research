# ER Planner: how it works, and how far to trust it

ER Planner simulates an emergency department patient by patient, week after week. It lets a hospital
test a change before making it: a shift, more beds, a fast track, more ICU beds, a second CT scanner.
It also shows where the waiting really comes from. The same page is in the app: menu →
"How it works and how accurate it is". A one-click demo runs the example comparison at `/?demo`.

## A simulated week
1. **Patients arrive** by hour and weekday at the volume you set. Each has a hidden condition and a triage level (ESI 1–5); some come by ambulance, and about 1 in 5 are children.
2. **Registration and triage.** Triage is sometimes one level off, as in real triage.
3. **A bed and a provider.** Patients wait for a bed and, optionally, a bedside nurse with room at California's legal ratios. Then they wait for a provider; sicker patients first, and minor cases can use a fast track.
4. **Tests.** Lab, X-ray, CT and ultrasound are ordered by condition and can queue for real machines and opening hours.
5. **Decision.** Patients go home or are admitted. Admitted patients board in their ED bed until an ICU, step-down or ward bed frees up.
6. **What can go wrong.** Patients worsen while waiting, leave unseen, have something missed and return within 72 hours, or become agitated.

Runs are seeded and reproducible. Options are compared on the same simulated weeks (common random
numbers), with ranges across weeks and 95% confidence intervals for changes.

## Accuracy
The starting department is a typical US ED, fitted to the NHAMCS 2021–2022 national survey of
emergency visits: about 98 visits a day, 32 beds and a fast track.

It matches 11 of 12 national checks:
- visits a day
- median and 90th-percentile wait to a provider
- length of stay overall and at every triage level
- leaving unseen
- admissions

Boarding is the miss: it swings with one ward bed more or less when wards are near full. Further checks:
- waits by triage level: within about 4 minutes
- test rates: within about 3 points
- returns within 72 hours: 4.1% against 4.1%

The full table is in the app; the data work is in [open-data.md](open-data.md).

A specific US hospital can start from its published CMS figures (visits a year, median time in the
ED, leaving before being seen). With the hospital's own visit records, the planner fits the model to
them instead.

## Limits
- **Department detail:** staffing by hour, bed counts, test turnaround and inpatient capacity are estimates until the hospital enters them.
- **Costs:** placeholder rates. Compare direction, not dollars.
- **Placeholders:** ICU and step-down stays, missed-diagnosis rates and violence rates are labelled placeholders.
- **People:** no teamwork, morale or local workarounds. The model shows what the constraints imply.

## How the model is checked
- Same seed and setup give identical results.
- With modules off, waits match the Erlang C formula and Little's law.
- More doctors never lengthen waits when boarding is off.
- National figures are read from the official CDC files and checked against the CDC's own published totals.
