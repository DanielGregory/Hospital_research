/**
 * Where the waiting really comes from. Ranks root causes by the patient-hours of waiting they
 * explain, from a run's metrics: "no beds" is split into beds held by boarders (by unit), beds full
 * with ED patients, and free beds with no nurse; waiting for results is split by service into
 * backlog (queueing for a scanner or analyser) and normal processing. Pure; the planner and the
 * debrief turn it into words.
 */
import type { Metrics } from './metrics.js';
import { SERVICE_IDS, UNIT_IDS, type ServiceId, type UnitId } from './types.js';

export type BottleneckKey =
  | 'triage'
  | 'provider'
  | 'bedsHeldByBoarders'
  | 'bedsFullEdPatients'
  | 'noNurse'
  | `backlog:${ServiceId}`
  | `beds:${UnitId}`
  | `admitted:${UnitId}`
  | 'boarding';

export interface Bottleneck {
  key: BottleneckKey;
  /** Short name, e.g. "CT backlog". */
  label: string;
  /** Patient-hours of waiting it explains (inside the measurement window). */
  hours: number;
  /** Share of all attributed waiting. */
  share: number;
  /** One sentence on what is happening. */
  what: string;
  /** What tends to help (and what does not). */
  lever: string;
}

const SERVICE_NAME: Record<ServiceId, string> = { lab: 'Lab', xray: 'X-ray', ct: 'CT', ultrasound: 'Ultrasound' };
const UNIT_NAME: Record<UnitId, string> = { icu: 'ICU', stepdown: 'step-down', ward: 'ward' };

const svName = (sv: ServiceId) => (sv === 'ct' ? 'CT' : sv === 'xray' ? 'X-ray' : SERVICE_NAME[sv].toLowerCase());
const article = (w: string) => (/^[aeiouAEIOU]/.test(w) ? `an ${w}` : `a ${w}`);

/**
 * Patient-hours spent on test processing and reporting with no queue (diagnostics module), or on
 * results overall (module off). Time the work takes, not a bottleneck: reported beside the ranking.
 */
export function testProcessingHours(m: Metrics): number {
  if (!m.diagnostics) return m.waits.results;
  const backlog = SERVICE_IDS.reduce((s, sv) => s + ((m.diagnostics![sv].meanQueueMinutes ?? 0) * m.diagnostics![sv].orders) / 60, 0);
  return Math.max(0, m.waits.results - backlog);
}

/** Root causes of waiting (queues), largest first. Causes under `minShare` of the total are dropped. */
export function findBottlenecks(m: Metrics, minShare = 0.02): Bottleneck[] {
  const out: Omit<Bottleneck, 'share'>[] = [];
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

  out.push({
    key: 'triage',
    label: 'Triage desk',
    hours: m.waits.triage,
    what: 'Patients queued before anyone assessed them.',
    lever: 'Another triage nurse at the peak, or a provider in triage, shortens this directly.',
  });
  out.push({
    key: 'provider',
    label: 'Providers',
    hours: m.waits.doctor,
    what: `Patients in a bed waited for a provider; providers were busy ${pct(m.utilizationByRole.doctor)} of the time.`,
    lever: 'A provider shift at the busiest hours helps most; past about 85% busy, waits grow very fast.',
  });

  // Waiting for a bed: split by why the bed was not available.
  const held = m.bedWaits.heldByBoarders;
  const full = Math.max(0, m.bedWaits.bedsFull - held);
  const byUnit = m.boarding.byUnit;
  if (byUnit) {
    // Spread the bed-hours lost to boarders over the units they were waiting for.
    const total = UNIT_IDS.reduce((s, u) => s + (byUnit[u]?.hours ?? 0), 0);
    for (const u of UNIT_IDS) {
      const x = byUnit[u];
      if (!x || total <= 0) continue;
      out.push({
        key: `beds:${u}` as BottleneckKey,
        label: `Beds blocked by ${UNIT_NAME[u]} boarders`,
        hours: (held * x.hours) / total,
        what: `ED beds were full, partly with ${x.boarders} patients waiting for ${article(UNIT_NAME[u])} bed (${x.meanHours?.toFixed(1) ?? '—'} h on average), so others could not get one.`,
        lever: `More ${UNIT_NAME[u]} beds or faster ${UNIT_NAME[u]} discharges free ED beds; more ED staff barely helps.`,
      });
    }
  } else
    out.push({
      key: 'bedsHeldByBoarders',
      label: 'Beds blocked by boarders',
      hours: held,
      what: `ED beds were full, partly with admitted patients waiting for a ward bed (${m.boarding.meanHours?.toFixed(1) ?? '—'} h on average).`,
      lever: 'Inpatient capacity, earlier ward discharges or the full-capacity protocol free ED beds; more ED staff barely helps.',
    });
  out.push({
    key: 'bedsFullEdPatients',
    label: 'Not enough treatment spaces',
    hours: full,
    what: `Every ED bed was in use by patients still being treated (the main ED was ${pct(m.bedOccupancy.main)} full on average).`,
    lever: 'More spaces, a fast track for minor cases, or faster test results (patients hold beds while they wait) help.',
  });
  out.push({
    key: 'noNurse',
    label: 'No nurse for a free bed',
    hours: m.bedWaits.noNurse,
    what: 'A bed was free but no bedside nurse could take another patient at the set ratios.',
    lever: 'Bedside nurses at the busy hours open beds that already exist; more beds would not help.',
  });

  // Waiting for results: backlog by service, and ordinary processing time.
  if (m.diagnostics) {
    for (const sv of SERVICE_IDS) {
      const d = m.diagnostics[sv];
      const h = ((d.meanQueueMinutes ?? 0) * d.orders) / 60;
      out.push({
        key: `backlog:${sv}` as BottleneckKey,
        label: `${SERVICE_NAME[sv]} backlog`,
        hours: h,
        what:
          `Orders waited ${Math.round(d.meanQueueMinutes ?? 0)} min on average for ${svName(sv)} (${pct(d.utilization)} busy, up to ${d.peakQueue} waiting)` +
          ((d.utilization ?? 0) < 0.5 && (d.meanQueueMinutes ?? 0) > 30 ? ', mostly while it was closed.' : '.'),
        lever:
          (d.utilization ?? 0) < 0.5 && (d.meanQueueMinutes ?? 0) > 30
            ? `Longer ${svName(sv)} opening hours would cut this; more machines would not.`
            : `More ${svName(sv)} capacity (or faster turnaround) cuts this; patients hold beds while they wait.`,
      });
    }
  }

  // Admitted patients waiting upstairs (their own wait, separate from the beds they block).
  if (byUnit) {
    for (const u of UNIT_IDS) {
      const x = byUnit[u];
      if (!x) continue;
      out.push({
        key: `admitted:${u}` as BottleneckKey,
        label: `Admitted, waiting for ${UNIT_NAME[u]}`,
        hours: x.hours,
        what: `${x.boarders} admitted patients waited ${x.meanHours?.toFixed(1) ?? '—'} h on average in the ED for ${article(UNIT_NAME[u])} bed.`,
        lever: `${UNIT_NAME[u] === 'ICU' ? 'ICU' : UNIT_NAME[u][0]!.toUpperCase() + UNIT_NAME[u].slice(1)} capacity and discharge timing; not something the ED can staff its way out of.`,
      });
    }
  } else
    out.push({
      key: 'boarding',
      label: 'Admitted, waiting for a ward',
      hours: m.waits.boarding,
      what: `Admitted patients spent ${m.boarding.hours.toFixed(0)} hours in ED beds waiting for the wards.`,
      lever: 'Inpatient capacity and discharge timing.',
    });

  const all = out.filter((b) => b.hours > 1e-9);
  const total = all.reduce((s, b) => s + b.hours, 0);
  return all
    .map((b) => ({ ...b, share: total > 0 ? b.hours / total : 0 }))
    .filter((b) => b.share >= minShare)
    .sort((a, b) => b.hours - a.hours);
}
