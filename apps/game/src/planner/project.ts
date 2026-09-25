/**
 * A planning project: the department as it is (the baseline), the what-ifs to test, and the
 * results. Scenarios are stored as templates with parameters and turned into settings against the
 * current baseline when they run, so editing the baseline never leaves a scenario stale.
 * Presentation-side data only; every number comes from the sim and research packages.
 */
import type { Comparison, Scenario } from '@er/research';
import type { Shift, SimConfig } from '@er/sim';

export interface Department {
  name: string;
  config: SimConfig;
  /** Set when the baseline was calibrated from visit records. */
  calibration?: { file: string; visits: number; days: number; fitted: Record<string, unknown>; notes: string[] };
}

export type TemplateId = 'beds' | 'doctorShift' | 'triageShift' | 'fastTrack' | 'security' | 'surge' | 'massCasualty' | 'wardPressure' | 'escalation';

export interface ScenarioSpec {
  id: string;
  template: TemplateId;
  /** Template parameters (numbers and shift times). */
  params: Record<string, number>;
  /** Optional custom name. */
  name?: string;
}

export interface Project {
  version: 1;
  department: Department;
  scenarios: ScenarioSpec[];
  /** Replications (weeks) per scenario. */
  weeks: number;
  results?: { at: string; comparison: Comparison };
}

export interface Template {
  id: TemplateId;
  label: string;
  /** What it changes, in a sentence (for the scenario card). */
  describe: (p: Record<string, number>, base: SimConfig) => string;
  defaults: Record<string, number>;
  fields: { key: string; label: string; min: number; max: number; step?: number; unit?: string }[];
  settings: (p: Record<string, number>, base: SimConfig) => Record<string, unknown>;
}

const hh = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:00`;
const schedule = (base: SimConfig, role: 'doctor' | 'triageNurse' | 'security' | 'fastTrackClinician'): Shift[] => base.staffing?.schedule?.[role] ?? [];

export const TEMPLATES: Record<TemplateId, Template> = {
  beds: {
    id: 'beds',
    label: 'Add treatment spaces',
    defaults: { add: 4 },
    fields: [{ key: 'add', label: 'Spaces to add', min: -10, max: 20 }],
    describe: (p, b) => `${p.add! >= 0 ? 'Add' : 'Remove'} ${Math.abs(p.add!)} main ED spaces (${b.beds?.main ?? 20} → ${(b.beds?.main ?? 20) + p.add!}).`,
    settings: (p, b) => ({ 'beds.main': Math.max(1, (b.beds?.main ?? 20) + p.add!) }),
  },
  doctorShift: {
    id: 'doctorShift',
    label: 'Add a provider shift',
    defaults: { start: 11, hours: 10, count: 1 },
    fields: [
      { key: 'start', label: 'Starts at', min: 0, max: 23, unit: 'h' },
      { key: 'hours', label: 'Length', min: 4, max: 12, unit: 'h' },
      { key: 'count', label: 'Providers', min: 1, max: 4 },
    ],
    describe: (p) => `${p.count} more provider${p.count! > 1 ? 's' : ''} ${hh(p.start!)}–${hh(p.start! + p.hours!)} every day.`,
    settings: (p, b) => ({ 'staffing.schedule.doctor': [...schedule(b, 'doctor'), { startHour: p.start, hours: p.hours, count: p.count }] }),
  },
  triageShift: {
    id: 'triageShift',
    label: 'Add a triage nurse shift',
    defaults: { start: 10, hours: 12, count: 1 },
    fields: [
      { key: 'start', label: 'Starts at', min: 0, max: 23, unit: 'h' },
      { key: 'hours', label: 'Length', min: 4, max: 12, unit: 'h' },
      { key: 'count', label: 'Nurses', min: 1, max: 3 },
    ],
    describe: (p) => `${p.count} more triage nurse${p.count! > 1 ? 's' : ''} ${hh(p.start!)}–${hh(p.start! + p.hours!)}.`,
    settings: (p, b) => ({ 'staffing.schedule.triageNurse': [...schedule(b, 'triageNurse'), { startHour: p.start, hours: p.hours, count: p.count }] }),
  },
  fastTrack: {
    id: 'fastTrack',
    label: 'Open a fast track',
    defaults: { spaces: 4, start: 10, hours: 12, minAcuity: 4 },
    fields: [
      { key: 'spaces', label: 'Chairs', min: 1, max: 12 },
      { key: 'start', label: 'Clinician from', min: 0, max: 23, unit: 'h' },
      { key: 'hours', label: 'for', min: 4, max: 24, unit: 'h' },
      { key: 'minAcuity', label: 'ESI from', min: 3, max: 5 },
    ],
    describe: (p) => `${p.spaces} chairs for ESI ${p.minAcuity}–5, one clinician ${hh(p.start!)}–${hh(p.start! + p.hours!)}.`,
    settings: (p, b) => ({
      'fastTrack.enabled': true,
      'fastTrack.minAcuity': p.minAcuity,
      'beds.fastTrack': p.spaces,
      'staffing.schedule.fastTrackClinician': [...schedule(b, 'fastTrackClinician'), { startHour: p.start, hours: p.hours, count: 1 }],
    }),
  },
  security: {
    id: 'security',
    label: 'Post security officers',
    defaults: { start: 18, hours: 12, count: 1 },
    fields: [
      { key: 'start', label: 'From', min: 0, max: 23, unit: 'h' },
      { key: 'hours', label: 'for', min: 4, max: 24, unit: 'h' },
      { key: 'count', label: 'Officers', min: 1, max: 4 },
    ],
    describe: (p) => `${p.count} security officer${p.count! > 1 ? 's' : ''} in the ED ${p.hours! >= 24 ? 'around the clock' : `${hh(p.start!)}–${hh(p.start! + p.hours!)}`}.`,
    settings: (p, b) => ({ 'modules.security': true, 'staffing.schedule.security': [...schedule(b, 'security'), { startHour: p.start, hours: p.hours, count: p.count }] }),
  },
  surge: {
    id: 'surge',
    label: 'Busier season (more arrivals)',
    defaults: { percent: 20 },
    fields: [{ key: 'percent', label: 'More arrivals', min: -30, max: 60, unit: '%' }],
    describe: (p) => `${p.percent! >= 0 ? '+' : ''}${p.percent}% arrivals all week (flu season, a neighbouring ED closing…).`,
    settings: (p, b) => ({ 'arrivals.rateMultiplier': (b.arrivals?.rateMultiplier ?? 1) * (1 + p.percent! / 100) }),
  },
  massCasualty: {
    id: 'massCasualty',
    label: 'Major incident',
    defaults: { patients: 20, day: 2, hour: 17 },
    fields: [
      { key: 'patients', label: 'Casualties', min: 5, max: 60 },
      { key: 'day', label: 'On day', min: 2, max: 7 },
      { key: 'hour', label: 'at', min: 0, max: 23, unit: 'h' },
    ],
    describe: (p) => `${p.patients} casualties in 45 minutes on day ${p.day} at ${hh(p.hour!)}.`,
    settings: (p, b) => ({
      'modules.shocks': true,
      shocks: [...(b.shocks ?? []), { type: 'massCasualty', atMinute: ((p.day! - 1) * 24 + p.hour!) * 60, patients: p.patients, overMinutes: 45 }],
    }),
  },
  wardPressure: {
    id: 'wardPressure',
    label: 'Wards under pressure',
    defaults: { percent: 10 },
    fields: [{ key: 'percent', label: 'Fewer ward beds / discharges', min: 1, max: 40, unit: '%' }],
    describe: (p) => `The wards take ${p.percent}% fewer ED admissions, so admitted patients wait in ED beds longer.`,
    settings: (p, b) =>
      b.boarding?.inpatientStayHours
        ? { 'boarding.inpatientBeds': Math.round((b.boarding.inpatientBeds ?? 40) * (1 - p.percent! / 100)) }
        : { 'boarding.dischargesPerDay': (b.boarding?.dischargesPerDay ?? 26) * (1 - p.percent! / 100) },
  },
  escalation: {
    id: 'escalation',
    label: 'Full-capacity protocol',
    defaults: {},
    fields: [],
    describe: () => 'The hospital full-capacity protocol is in force all week (wards discharge faster).',
    settings: () => ({ 'boarding.escalation': true }),
  },
};

export function toScenario(spec: ScenarioSpec, base: SimConfig): Scenario {
  const t = TEMPLATES[spec.template];
  return { id: spec.id, name: spec.name || t.label, description: t.describe(spec.params, base), settings: t.settings(spec.params, base) };
}

/** A typical department to start from (placeholder numbers until calibrated). */
export function exampleDepartment(): Department {
  return {
    name: 'Example department',
    config: {
      id: 'planner-baseline',
      name: 'Baseline',
      durationMinutes: 7 * 1440,
      warmupMinutes: 1440,
      startDayOfWeek: 0,
      startHour: 0,
      modules: { staffing: true, boarding: true, diagnosis: true },
      staffing: {
        doctors: 0,
        triageNurses: 0,
        schedule: {
          doctor: [
            { startHour: 8, hours: 12, count: 3 },
            { startHour: 12, hours: 12, count: 1 },
            { startHour: 20, hours: 12, count: 2 },
          ],
          triageNurse: [
            { startHour: 0, hours: 24, count: 1 },
            { startHour: 10, hours: 12, count: 1 },
          ],
        },
      },
      beds: { main: 18 },
    },
  };
}

export function newProject(): Project {
  return {
    version: 1,
    department: exampleDepartment(),
    scenarios: [
      { id: 's1', template: 'fastTrack', params: { ...TEMPLATES.fastTrack.defaults } },
      { id: 's2', template: 'doctorShift', params: { ...TEMPLATES.doctorShift.defaults } },
      { id: 's3', template: 'surge', params: { ...TEMPLATES.surge.defaults } },
    ],
    weeks: 20,
  };
}

const KEY = 'er-planner';

export function loadProject(): Project {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Project | null;
    if (p && p.version === 1) return p;
  } catch {
    // unreadable: start fresh
  }
  return newProject();
}

export function saveProject(p: Project): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage full or blocked: the project lasts as long as the tab
  }
}
