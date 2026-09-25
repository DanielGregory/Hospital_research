import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/index';

const base = { id: 'n', durationMinutes: 5 * 1440, warmupMinutes: 1440, modules: { nursing: true, boarding: true } };
const run = (extra: object, seed = 2) => new Simulation({ ...base, ...extra }, seed).run().metrics;

describe('nursing module (staffed beds)', () => {
  it('fewer nurses: patients wait for a bed that is free but unstaffed', () => {
    const few = run({ staffing: { nurses: 3 } });
    const enough = run({ staffing: { nurses: 7 } });
    expect(few.bedWaits.noNurse).toBeGreaterThan(20);
    expect(enough.bedWaits.noNurse).toBeLessThan(few.bedWaits.noNurse / 10);
    expect(few.doorToDoctor.median!).toBeGreaterThanOrEqual(enough.doorToDoctor.median!);
  });

  it('never has more patients in beds than the nurses can take (at ratio), unless nurses left mid-stay', () => {
    const sim = new Simulation({ ...base, staffing: { nurses: 3 } }, 4);
    for (let t = 1440; t < 5 * 1440; t += 97) {
      sim.runUntil(t);
      const inBeds = sim.snapshot().patients.filter((p) => p.lane === 'main' && p.bed !== undefined);
      const load = inBeds.reduce((s, p) => s + 1 / ({ 1: 1, 2: 2, 3: 4, 4: 5, 5: 6 } as Record<number, number>)[p.assignedAcuity ?? p.trueAcuity]!, 0);
      expect(load).toBeLessThanOrEqual(3 + 1e-9);
    }
  });

  it('turning nursing on without saying how many nurses uses a typical team', () => {
    expect(run({}).nursing!.meanNursesOnDuty).toBeCloseTo(6, 6);
  });

  it('off: no nursing metrics and bed waits are only about full beds', () => {
    const m = new Simulation({ id: 'n', durationMinutes: 2 * 1440, beds: { main: 8 } }, 1).run().metrics;
    expect(m.nursing).toBeNull();
    expect(m.bedWaits.noNurse).toBe(0);
    expect(m.bedWaits.bedsFull).toBeGreaterThan(0);
  });
});
