import { describe, expect, it } from 'vitest';
import { ConfigError, exampleLayout, resolveConfig, Simulation, type LayoutSpec } from '../src/index';

const day = { id: 'trauma', durationMinutes: 24 * 60, arrivals: { rateMultiplier: 1.2 } };

describe('trauma bays', () => {
  it('go to the sickest patients; others use them only when no regular bed is free', () => {
    const sim = new Simulation({ ...day, beds: { main: 40, traumaBays: 2 } }, 5);
    let sickInBay = 0;
    for (let t = 5; t <= day.durationMinutes; t += 5) {
      sim.runUntil(t);
      const s = sim.snapshot();
      expect(s.beds.main.traumaBays).toBe(2);
      for (const p of s.patients.filter((x) => x.location === 'bed' && x.lane === 'main' && x.bed! < 2)) {
        // With 40 beds a regular bed is always free, so only ESI 1-2 end up in a bay.
        expect(p.assignedAcuity).toBeLessThanOrEqual(2);
        sickInBay++;
      }
    }
    expect(sickInBay).toBeGreaterThan(0);
  });

  it('only change which bed a patient gets, never the results', () => {
    for (const seed of [1, 2, 3]) {
      const a = new Simulation({ ...day, beds: { main: 12, traumaBays: 0 } }, seed).run().metrics;
      const b = new Simulation({ ...day, beds: { main: 12, traumaBays: 3 } }, seed).run().metrics;
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('are the beds in trauma rooms with the layout module', () => {
    const base = exampleLayout();
    const layout: LayoutSpec = { ...base, rooms: [...base.rooms, { id: 'resus', type: 'trauma', x: 18, y: 8, w: 4, h: 4 }] };
    const cfg = { ...day, modules: { layout: true }, layout };
    const r = resolveConfig(cfg);
    expect(r.traumaBays).toBe(2); // 16 cells, two cells per bed twice over
    const without = resolveConfig({ ...day, modules: { layout: true }, layout: base });
    expect(r.beds.main).toBe(without.beds.main + 2);
    const sim = new Simulation(cfg, 2);
    let seen = 0;
    for (let t = 10; t <= 600; t += 10) {
      sim.runUntil(t);
      for (const p of sim.snapshot().patients.filter((x) => x.location === 'bed' && x.lane === 'main')) {
        expect(p.room === 'resus').toBe(p.bed! < 2);
        if (p.room === 'resus') seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(() => resolveConfig({ ...cfg, beds: { traumaBays: 1 } })).toThrow(ConfigError);
  });

  it('rejects a negative count', () => {
    expect(() => resolveConfig({ ...day, beds: { traumaBays: -1 } })).toThrow(/traumaBays/);
  });
});
