/**
 * "Build your hospital": the player's own department as a draft (name, daily visits and a config
 * with a drawn floor plan), starter plans by size, typical staffing from the rules of thumb in
 * `PARAMS.planning`, and saving in the browser. Presentation-side data; the sim does the rest.
 */
import { PARAMS, resolveLayout, type LayoutSpec, type Shift, type SimConfig } from '@er/sim';
import type { Department } from '../planner/project';

export interface Hospital {
  version: 1;
  name: string;
  visitsPerDay: number;
  /** A runnable config: layout module on, beds from the drawn rooms. */
  config: SimConfig;
}

export type HospitalSize = 'small' | 'medium' | 'large' | 'empty';

/** Visits per day at the params' arrival rates (multiplier 1). */
export function baseVisitsPerDay(): number {
  const perDay = PARAMS.arrivals.hourlyRates.reduce((s, r) => s + r, 0);
  const dow = PARAMS.arrivals.dayOfWeekMultipliers.reduce((s, m) => s + m, 0) / PARAMS.arrivals.dayOfWeekMultipliers.length;
  return perDay * dow;
}

const room = (id: string, type: LayoutSpec['rooms'][number]['type'], x: number, y: number, w: number, h: number) => ({ id, type, x, y, w, h });

export const SIZES: Record<HospitalSize, { label: string; blurb: string; visits: number; layout: () => LayoutSpec }> = {
  small: {
    label: 'Small',
    blurb: 'A community ED: about 40 visits a day, 6 beds and a trauma bay.',
    visits: 40,
    layout: () => ({
      footprint: { preset: 'rectangle', width: 18, height: 12 },
      entrance: { x: 0, y: 6 },
      ambulanceDoor: { x: 17, y: 6 },
      rooms: [
        room('waiting-1', 'waiting', 1, 1, 5, 4),
        room('triage-1', 'triage', 1, 8, 3, 3),
        room('station-1', 'station', 8, 5, 2, 2),
        room('acute-1', 'acute', 7, 1, 8, 3),
        room('trauma-1', 'trauma', 12, 8, 5, 3),
      ],
    }),
  },
  medium: {
    label: 'Medium',
    blurb: 'A busy district ED: about 100 visits a day, 20 beds, 2 trauma bays and a fast track.',
    visits: 100,
    layout: () => ({
      footprint: { preset: 'rectangle', width: 26, height: 16 },
      entrance: { x: 0, y: 8 },
      ambulanceDoor: { x: 25, y: 8 },
      rooms: [
        room('waiting-1', 'waiting', 1, 1, 6, 5),
        room('triage-1', 'triage', 1, 11, 4, 3),
        room('station-1', 'station', 11, 7, 4, 2),
        room('acute-1', 'acute', 9, 1, 10, 4),
        room('acute-2', 'acute', 9, 11, 10, 4),
        room('trauma-1', 'trauma', 20, 11, 5, 4),
        room('fastTrack-1', 'fastTrack', 20, 1, 5, 5),
      ],
    }),
  },
  large: {
    label: 'Large',
    blurb: 'A major trauma centre: about 180 visits a day, 34 beds, 4 trauma bays and a fast track.',
    visits: 180,
    layout: () => ({
      footprint: { preset: 'rectangle', width: 34, height: 20 },
      entrance: { x: 0, y: 10 },
      ambulanceDoor: { x: 33, y: 10 },
      rooms: [
        room('waiting-1', 'waiting', 1, 1, 7, 6),
        room('triage-1', 'triage', 1, 13, 5, 4),
        room('station-1', 'station', 14, 9, 5, 2),
        room('acute-1', 'acute', 10, 1, 14, 5),
        room('acute-2', 'acute', 10, 14, 14, 5),
        room('trauma-1', 'trauma', 27, 13, 6, 6),
        room('fastTrack-1', 'fastTrack', 27, 1, 6, 6),
      ],
    }),
  },
  empty: {
    label: 'Empty floor',
    blurb: 'Start from a bare floor and draw every room yourself.',
    visits: 100,
    layout: () => ({ footprint: { preset: 'rectangle', width: 26, height: 16 }, entrance: { x: 0, y: 8 }, ambulanceDoor: { x: 25, y: 8 }, rooms: [] }),
  },
};

/** Main ED beds in a plan (acute and trauma rooms), or 0 while the plan is incomplete. */
export function planBeds(layout: LayoutSpec): number {
  const l = resolveLayout(layout).layout;
  return l ? l.rooms.filter((r) => r.type === 'acute' || r.type === 'trauma').reduce((s, r) => s + r.capacity, 0) : 0;
}

/** Typical shifts for a department of this size (rules of thumb in `PARAMS.planning`). */
export function typicalStaffing(visitsPerDay: number, mainBeds: number): { doctor: Shift[]; triageNurse: Shift[]; nurse: Shift[] } {
  const p = PARAMS.planning;
  const hours = visitsPerDay * p.providerHoursPerVisit;
  const n = (share: number, min: number) => Math.max(min, Math.round((hours * share) / 12));
  const doctor: Shift[] = [
    { startHour: 8, hours: 12, count: n(p.providerSplit.day, 1) },
    { startHour: 20, hours: 12, count: n(p.providerSplit.night, 1) },
  ];
  const mid = n(p.providerSplit.mid, 0);
  if (mid > 0) doctor.splice(1, 0, { startHour: 12, hours: 12, count: mid });
  const triageNurse: Shift[] = [{ startHour: 0, hours: 24, count: 1 }];
  const extra = Math.floor(visitsPerDay / p.visitsPerTriageNurseDay);
  if (extra > 0) triageNurse.push({ startHour: 10, hours: 12, count: extra });
  const nurse: Shift[] = [{ startHour: 0, hours: 24, count: Math.max(1, Math.ceil(mainBeds / p.bedsPerNurse)) }];
  return { doctor, triageNurse, nurse };
}

/** Apply typical staffing to a hospital for its size and beds. */
export function withTypicalStaffing(h: Hospital): Hospital {
  const s = typicalStaffing(h.visitsPerDay, planBeds(h.config.layout!));
  return { ...h, config: { ...h.config, staffing: { ...h.config.staffing, doctors: 0, triageNurses: 0, schedule: { ...h.config.staffing?.schedule, ...s } } } };
}

/** Set daily visits (scales the arrival pattern). */
export function withVisits(h: Hospital, visitsPerDay: number): Hospital {
  return { ...h, visitsPerDay, config: { ...h.config, arrivals: { ...h.config.arrivals, rateMultiplier: visitsPerDay / baseVisitsPerDay() } } };
}

export function newHospital(size: HospitalSize, name = 'My hospital'): Hospital {
  const s = SIZES[size];
  const layout = s.layout();
  const h: Hospital = {
    version: 1,
    name,
    visitsPerDay: s.visits,
    config: {
      id: 'my-hospital',
      name,
      durationMinutes: 7 * 1440,
      warmupMinutes: 1440,
      startDayOfWeek: 0,
      startHour: 0,
      modules: { layout: true, staffing: true, boarding: true, nursing: true, diagnostics: true },
      layout,
      boarding: {
        units: {
          icu: { beds: Math.max(2, Math.round((PARAMS.boarding.units.icu.beds * s.visits) / 100)) },
          stepdown: { beds: Math.max(2, Math.round((PARAMS.boarding.units.stepdown.beds * s.visits) / 100)) },
          ward: { beds: Math.max(10, Math.round((PARAMS.boarding.units.ward.beds * s.visits) / 100)) },
        },
      },
    },
  };
  return withTypicalStaffing(withVisits(h, s.visits));
}

/** The hospital as a planner baseline. */
export function toDepartment(h: Hospital): Department {
  return { name: h.name, config: { ...h.config, id: 'planner-baseline', name: 'Baseline' } };
}

const KEY = 'er-hospital';

export function loadHospital(): Hospital | null {
  try {
    const h = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Hospital | null;
    return h && h.version === 1 ? h : null;
  } catch {
    return null;
  }
}

export function saveHospital(h: Hospital): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    // storage blocked: the draft lasts as long as the tab
  }
}
