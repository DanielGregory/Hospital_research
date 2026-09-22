/**
 * The patient process as a directed acyclic graph of steps.
 *
 * With the `process` module off, `defaultPipeline` builds the fixed pipeline
 *   triage -> [bed] -> doctor evaluation -> workup (results) -> disposition
 * from plain config sections. With it on (Phase 5), the player's own graph is used.
 *
 * Step semantics the engine relies on:
 * - A step starts when every applicable step in `after` is done. Several can run at once.
 * - `inBed` steps need the patient in a treatment space; the bed is taken before the first one.
 * - `role` = who does the staffed part (null = no staff). Doctor steps for fast-track
 *   patients go to fast-track clinicians (free main doctors can take them).
 * - `turnaround` is a wait after the staffed part with no staff (e.g. lab results).
 * - `triage` sets the assigned acuity. The first `doctorEval` start is "seen by a doctor".
 * - `disposition` runs last (after every other applicable step) and decides admit/discharge.
 */

import type { Acuity, Lane, Role } from './types.js';
import { ACUITIES, ROLES } from './types.js';

export const STEP_KINDS = ['registration', 'triage', 'vitals', 'labs', 'imaging', 'doctorEval', 'workup', 'disposition'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Kinds whose thoroughness counts towards diagnostic accuracy. */
export const DIAGNOSTIC_KINDS: readonly StepKind[] = ['vitals', 'labs', 'imaging', 'doctorEval'];

export interface StepDef {
  id: string;
  kind: StepKind;
  label: string;
  role: Role | null;
  /** Mean staffed time by true acuity (0 = instant). */
  meanMinutesByAcuity: Record<Acuity, number>;
  distribution: 'exponential' | 'lognormal';
  cv: number;
  /** Mean unstaffed wait after the staffed part, by true acuity. Lognormal with `turnaroundCv`. */
  turnaroundMinutesByAcuity: Record<Acuity, number>;
  turnaroundCv: number;
  /** 0..1: higher = slower, more accurate (diagnosis module). */
  thoroughness: number;
  after: string[];
  inBed: boolean;
  /** Applies to patients whose assigned acuity (3 if not triaged yet) is in [minAcuity, maxAcuity] and whose lane is listed. */
  minAcuity: Acuity;
  maxAcuity: Acuity;
  lanes: Lane[];
}

/** Routing: first matching rule picks the lane (by assigned acuity); default main. */
export interface RoutingRule {
  minAcuity: Acuity;
  maxAcuity: Acuity;
  lane: Lane;
}

const byAcuity = (v: number): Record<Acuity, number> => ({ 1: v, 2: v, 3: v, 4: v, 5: v });

export function makeStep(p: Partial<StepDef> & Pick<StepDef, 'id' | 'kind'>): StepDef {
  return {
    label: p.label ?? p.kind,
    role: null,
    meanMinutesByAcuity: byAcuity(0),
    distribution: 'lognormal',
    cv: 0.5,
    turnaroundMinutesByAcuity: byAcuity(0),
    turnaroundCv: 0.6,
    thoroughness: 0.5,
    after: [],
    inBed: false,
    minAcuity: 1,
    maxAcuity: 5,
    lanes: ['main', 'fastTrack'],
    ...p,
  };
}

export interface DefaultPipelineInput {
  triage: { enabled: boolean; meanMinutes: number; cv: number };
  serviceMeanByAcuity: Record<Acuity, number>;
  serviceDistribution: 'exponential' | 'lognormal';
  lognormalCv: number;
  thoroughness: number;
  workup: { enabled: boolean; meanMinutesByAcuity: Record<Acuity, number>; cv: number };
  disposition: { doctorMinutes: number; cv: number };
}

export function defaultPipeline(c: DefaultPipelineInput): StepDef[] {
  const steps: StepDef[] = [];
  if (c.triage.enabled)
    steps.push(makeStep({ id: 'triage', kind: 'triage', label: 'Triage', role: 'triageNurse', meanMinutesByAcuity: byAcuity(c.triage.meanMinutes), cv: c.triage.cv }));
  steps.push(
    makeStep({
      id: 'doctorEval',
      kind: 'doctorEval',
      label: 'Doctor evaluation',
      role: 'doctor',
      meanMinutesByAcuity: { ...c.serviceMeanByAcuity },
      distribution: c.serviceDistribution,
      cv: c.lognormalCv,
      thoroughness: c.thoroughness,
      after: c.triage.enabled ? ['triage'] : [],
      inBed: true,
    }),
  );
  let last = 'doctorEval';
  if (c.workup.enabled) {
    steps.push(
      makeStep({
        id: 'workup',
        kind: 'workup',
        label: 'Tests and results',
        turnaroundMinutesByAcuity: { ...c.workup.meanMinutesByAcuity },
        turnaroundCv: c.workup.cv,
        after: [last],
        inBed: true,
      }),
    );
    last = 'workup';
  }
  steps.push(
    makeStep({
      id: 'disposition',
      kind: 'disposition',
      label: 'Disposition',
      role: c.disposition.doctorMinutes > 0 ? 'doctor' : null,
      meanMinutesByAcuity: byAcuity(c.disposition.doctorMinutes),
      cv: c.disposition.cv,
      after: [last],
      inBed: true,
    }),
  );
  return steps;
}

/** Problems with a pipeline graph (empty = valid). */
export function checkPipeline(steps: readonly StepDef[], path = 'process.steps'): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  steps.forEach((s, i) => {
    const sp = `${path}[${i}]`;
    if (!s.id) p.push(`${sp}.id: required`);
    if (ids.has(s.id)) p.push(`${sp}.id: duplicate '${s.id}'`);
    ids.add(s.id);
    if (!(STEP_KINDS as readonly string[]).includes(s.kind)) p.push(`${sp}.kind: one of ${STEP_KINDS.join(', ')}`);
    if (s.role !== null && !(ROLES as readonly string[]).includes(s.role)) p.push(`${sp}.role: one of ${ROLES.join(', ')} or null`);
    if (!(s.thoroughness >= 0 && s.thoroughness <= 1)) p.push(`${sp}.thoroughness: 0..1`);
    if (s.minAcuity > s.maxAcuity) p.push(`${sp}: minAcuity > maxAcuity`);
    for (const a of ACUITIES) {
      if (!(s.meanMinutesByAcuity[a] >= 0)) p.push(`${sp}.meanMinutesByAcuity: non-negative numbers`);
      if (!(s.turnaroundMinutesByAcuity[a] >= 0)) p.push(`${sp}.turnaroundMinutesByAcuity: non-negative numbers`);
    }
    if (s.kind === 'disposition' && (s.minAcuity !== 1 || s.maxAcuity !== 5 || s.lanes.length < 2)) p.push(`${sp}: disposition must apply to every patient`);
  });
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const s of steps) for (const a of s.after) if (!byId.has(a)) p.push(`${path}: '${s.id}' comes after unknown step '${a}'`);
  if (steps.filter((s) => s.kind === 'disposition').length !== 1) p.push(`${path}: needs exactly one disposition step`);
  if (steps.filter((s) => s.kind === 'triage').length > 1) p.push(`${path}: at most one triage step`);
  if (!steps.some((s) => s.kind === 'doctorEval')) p.push(`${path}: needs at least one doctor evaluation`);
  // Acyclic (DFS).
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 2) return true;
    state.set(id, 1);
    for (const a of byId.get(id)?.after ?? []) if (byId.has(a) && !visit(a)) return false;
    state.set(id, 2);
    return true;
  };
  if (!steps.every((s) => visit(s.id))) p.push(`${path}: steps form a cycle`);
  // Out-of-bed steps cannot wait on in-bed steps (a patient cannot go back to the waiting room).
  for (const s of steps) if (!s.inBed) for (const a of s.after) if (byId.get(a)?.inBed) p.push(`${path}: '${s.id}' is before the bed but comes after in-bed step '${a}'`);
  // Steps before triage finish cannot be acuity-specific.
  const triage = steps.find((s) => s.kind === 'triage');
  if (triage) {
    const afterTriage = new Set<string>();
    const reach = (id: string): boolean => id === triage.id || (byId.get(id)?.after ?? []).some(reach);
    for (const s of steps) if (reach(s.id)) afterTriage.add(s.id);
    for (const s of steps)
      if (!afterTriage.has(s.id) && s.id !== triage.id && (s.minAcuity !== 1 || s.maxAcuity !== 5))
        p.push(`${path}: '${s.id}' can happen before triage, so it cannot depend on acuity`);
  }
  return p;
}
