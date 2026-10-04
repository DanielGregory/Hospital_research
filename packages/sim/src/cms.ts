/**
 * CMS Care Compare, "Timely and Effective Care - Hospital" (data.cms.gov, dataset yv7e-xc69): the
 * emergency department measures each US hospital reports. Pure: parse the CSV into one compact row
 * per hospital. US government data (public domain); cite CMS and the reporting period.
 *
 * OP_18b: median minutes in the ED for patients sent home (not transfers or psychiatric).
 * OP_18a: the same for all patients. OP_18c: psychiatric/mental health. OP_18d: transfers.
 * OP_22: percent who left before being seen; its sample is the number of ED visits in the year.
 * EDV: volume band (low, medium, high, very high).
 */
import { parseCsv } from './visits.js';

export interface CmsHospital {
  id: string;
  name: string;
  city: string;
  state: string;
  volumeBand: string | null;
  /** Median minutes in the ED: sent home (OP_18b), all (OP_18a), psychiatric (OP_18c), transferred (OP_18d). */
  medianMinutesDischarged: number | null;
  medianMinutesAll: number | null;
  medianMinutesPsych: number | null;
  medianMinutesTransfer: number | null;
  /** Share who left before being seen (OP_22 / 100). */
  lwbsRate: number | null;
  /** ED visits in the year (OP_22 denominator). */
  visitsPerYear: number | null;
}

export interface CmsExtract {
  source: string;
  periods: Record<string, string>;
  hospitals: CmsHospital[];
}

const MEASURES = ['EDV', 'OP_18a', 'OP_18b', 'OP_18c', 'OP_18d', 'OP_22'] as const;

/** Read the Timely and Effective Care CSV, keeping the emergency department measures. */
export function parseCmsTimelyCare(csv: string): CmsExtract {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  const h = (rows[0] ?? []).map((x) => x.trim());
  const col = (name: string) => h.indexOf(name);
  const [cId, cName, cCity, cState, cMeasure, cScore, cSample, cStart, cEnd] = ['Facility ID', 'Facility Name', 'City/Town', 'State', 'Measure ID', 'Score', 'Sample', 'Start Date', 'End Date'].map(col);
  if ([cId, cMeasure, cScore].some((c) => c! < 0)) throw new Error('Not a Timely and Effective Care file: expected Facility ID, Measure ID and Score columns');
  const byId = new Map<string, CmsHospital>();
  const periods: Record<string, string> = {};
  const num = (s: string | undefined) => {
    const v = Number.parseFloat((s ?? '').replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
  };
  for (const r of rows.slice(1)) {
    const m = r[cMeasure!] as (typeof MEASURES)[number];
    if (!MEASURES.includes(m)) continue;
    const id = r[cId!]!;
    let x = byId.get(id);
    if (!x) {
      x = {
        id,
        name: r[cName!] ?? '',
        city: r[cCity!] ?? '',
        state: r[cState!] ?? '',
        volumeBand: null,
        medianMinutesDischarged: null,
        medianMinutesAll: null,
        medianMinutesPsych: null,
        medianMinutesTransfer: null,
        lwbsRate: null,
        visitsPerYear: null,
      };
      byId.set(id, x);
    }
    periods[m] ??= `${r[cStart!] ?? ''}–${r[cEnd!] ?? ''}`;
    const score = r[cScore!];
    if (m === 'EDV') x.volumeBand = score && score !== 'Not Available' ? score : null;
    else if (m === 'OP_18a') x.medianMinutesAll = num(score);
    else if (m === 'OP_18b') x.medianMinutesDischarged = num(score);
    else if (m === 'OP_18c') x.medianMinutesPsych = num(score);
    else if (m === 'OP_18d') x.medianMinutesTransfer = num(score);
    else if (m === 'OP_22') {
      const v = num(score);
      x.lwbsRate = v === null ? null : v / 100;
      x.visitsPerYear = num(r[cSample!]);
    }
  }
  return {
    source: 'Centers for Medicare & Medicaid Services. Care Compare: Timely and Effective Care - Hospital (data.cms.gov, dataset yv7e-xc69).',
    periods,
    // Hospitals with at least one ED measure reported.
    hospitals: [...byId.values()].filter((x) => x.visitsPerYear !== null || x.medianMinutesDischarged !== null),
  };
}
