import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/index';

const base = { id: 'dx', durationMinutes: 5 * 1440, warmupMinutes: 1440, modules: { diagnostics: true } };
const run = (extra: object, seed = 2) => {
  const sim = new Simulation({ ...base, ...extra }, seed);
  return { m: sim.run().metrics, sim };
};

describe('diagnostics module', () => {
  it('off: nothing reported, results unchanged', () => {
    const plain = { id: 'dx', durationMinutes: 2 * 1440 };
    const m = new Simulation(plain, 3).run().metrics;
    expect(m.diagnostics).toBeNull();
    expect(JSON.stringify(new Simulation({ ...plain, diagnostics: { services: { ct: { servers: 3 } } } }, 3).run().metrics)).toBe(JSON.stringify(m));
  });

  it('tests follow the condition: strokes get a CT, sprains an X-ray, nobody gets tests they do not need', () => {
    const { sim } = run({});
    const ps = sim.allPatients().filter((p) => p.orders);
    const stroke = ps.filter((p) => p.conditionId === 'stroke');
    expect(stroke.every((p) => p.orders!.some((o) => o.service === 'ct'))).toBe(true);
    expect(ps.filter((p) => p.conditionId === 'minor-fracture').every((p) => p.orders!.some((o) => o.service === 'xray'))).toBe(true);
    expect(sim.allPatients().filter((p) => p.conditionId === 'prescription').every((p) => !p.orders)).toBe(true);
  });

  it('a slow, single CT scanner builds a backlog; a second scanner clears it', () => {
    const slow = { diagnostics: { services: { ct: { servers: 1, processMinutes: 60 } } } };
    const two = { diagnostics: { services: { ct: { servers: 2, processMinutes: 60 } } } };
    const a = run(slow).m.diagnostics!.ct;
    const b = run(two).m.diagnostics!.ct;
    expect(a.meanQueueMinutes!).toBeGreaterThan(b.meanQueueMinutes! * 2);
    expect(a.utilization!).toBeGreaterThan(b.utilization!);
    expect(a.orders).toBe(b.orders);
  });

  it('orders placed while a service is closed wait for it to open', () => {
    const { sim } = run({ diagnostics: { services: { ultrasound: { openHours: [8, 20] } } } });
    for (const p of sim.allPatients())
      for (const o of p.orders ?? [])
        if (o.service === 'ultrasound' && o.startedAt !== undefined) {
          const hour = (o.startedAt / 60) % 24;
          expect(hour >= 8 - 1e-6 && hour < 20).toBe(true);
        }
  });

  it('is deterministic and rejects unknown services', () => {
    expect(JSON.stringify(run({}, 5).m)).toBe(JSON.stringify(run({}, 5).m));
    expect(() => new Simulation({ ...base, diagnostics: { services: { mri: { servers: 1 } } } }, 1)).toThrow(/diagnostics.services.mri/);
  });
});
