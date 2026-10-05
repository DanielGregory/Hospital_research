import { describe, expect, it } from 'vitest';
import { PARAMS, patientStories, Simulation } from '../src/index';

const week = { id: 'profiles', durationMinutes: 3 * 1440, modules: { diagnosis: true, boarding: true } };

describe('patient profiles', () => {
  const sim = new Simulation(week, 4);
  sim.run();
  const patients = sim.allPatients();

  it('fit the condition: age in range, a complaint from its list', () => {
    const byId = new Map(PARAMS.conditions.map((c) => [c.id, c]));
    for (const p of patients) {
      const c = byId.get(p.conditionId)!;
      // Adults in the condition's range; children (conditions with a child share) in the child range.
      const [lo, , hi] = p.profile.age < c.ages![0] && c.childShare ? PARAMS.childAges : c.ages!;
      expect(p.profile.age).toBeGreaterThanOrEqual(lo);
      expect(p.profile.age).toBeLessThanOrEqual(hi);
      expect(c.complaints).toContain(p.profile.complaint);
      expect(['F', 'M']).toContain(p.profile.sex);
    }
  });

  it('includes children at about the national share, only for conditions children come in with', () => {
    const kids = patients.filter((p) => p.profile.age < 16);
    expect(kids.length / patients.length).toBeGreaterThan(0.12);
    expect(kids.length / patients.length).toBeLessThan(0.25);
    const byId = new Map(PARAMS.conditions.map((c) => [c.id, c]));
    expect(kids.every((p) => (byId.get(p.conditionId)!.childShare ?? 0) > 0)).toBe(true);
  });

  it('bounce-backs are the same person coming back', () => {
    const back = patients.filter((p) => p.bounceOf !== undefined);
    expect(back.length).toBeGreaterThan(0);
    for (const p of back) expect(p.profile).toEqual(patients[p.bounceOf!]!.profile);
  });

  it('a complaint never gives the diagnosis away on its own for the serious ones', () => {
    const conditionsFor = (k: string) => PARAMS.conditions.filter((c) => c.complaints?.includes(k)).length;
    for (const k of ['chestPain', 'breathless', 'abdominalPain', 'fever', 'collapsed', 'confused']) expect(conditionsFor(k)).toBeGreaterThanOrEqual(k === 'confused' ? 1 : 2);
  });

  it('are visible in the snapshot', () => {
    const s = new Simulation(week, 4);
    s.runUntil(600);
    const v = s.snapshot().patients[0]!;
    expect(v.profile.age).toBeGreaterThan(0);
  });
});

describe('patient stories', () => {
  it('pick distinct real patients, deterministically, most serious first', () => {
    const run = () => {
      const s = new Simulation({ ...week, arrivals: { rateMultiplier: 1.4 } }, 2);
      s.run();
      return patientStories(s.allPatients(), s.now);
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a.length).toBeGreaterThan(2);
    expect(new Set(a.map((x) => x.patientId)).size).toBe(a.length);
    expect(a[0]!.kind).toBe('missed');
    expect(a.find((x) => x.kind === 'leftUnseen')?.outcome).toBe('lwbs');
  });
});
