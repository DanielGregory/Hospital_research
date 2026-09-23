import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { Simulation } from '../src/engine.js';
import { exampleLayout, footprintPreset, resolveLayout, walkHeat, type LayoutSpec } from '../src/layout.js';

const corridor: LayoutSpec = {
  footprint: ['##########', '##########', '##########'],
  entrance: { x: 0, y: 1 },
  rooms: [
    { id: 'a', type: 'waiting', x: 2, y: 0, w: 2, h: 1 },
    { id: 'b', type: 'acute', x: 7, y: 0, w: 2, h: 1, capacity: 2 },
  ],
};

describe('footprints', () => {
  it('presets have the right shape', () => {
    const l = footprintPreset('lShape', 10, 8);
    expect(l[0]).toBe('#####.....');
    expect(l[7]).toBe('##########');
    const u = footprintPreset('uShape', 9, 6);
    expect(u[0]).toBe('###...###');
    const n = footprintPreset('narrow', 20, 12);
    expect(n.filter((r) => r.includes('#')).length).toBe(4);
  });
});

describe('resolveLayout', () => {
  it('computes corridor distances between doors', () => {
    const { layout, problems } = resolveLayout(corridor);
    expect(problems).toEqual([]);
    // a's door (2,0) opens onto (1,0), 2 cells from the entrance (0,1): +1 to step in = 3.
    // b's door (7,0) opens onto (6,0). Room a blocks row 0, so a -> b goes round:
    // (1,0) -> (1,1) -> ... -> (6,1) -> (6,0) = 7 cells, +1 out, +1 in = 9.
    expect(layout!.dist[0]![1]).toBe(3);
    expect(layout!.dist[1]![2]).toBe(9);
    const d = layout!.dist;
    for (let i = 0; i < d.length; i++) for (let j = 0; j < d.length; j++) expect(d[i]![j]).toBe(d[j]![i]);
  });

  it('picks the door nearest the entrance', () => {
    const { layout } = resolveLayout(corridor);
    expect(layout!.rooms[0]!.door).toEqual({ x: 2, y: 0 });
  });

  it('reports overlaps, rooms outside the footprint, bad entrances and unreachable rooms', () => {
    const bad = (patch: Partial<LayoutSpec>) => resolveLayout({ ...corridor, ...patch }).problems.join(' | ');
    expect(bad({ rooms: [...corridor.rooms, { id: 'c', type: 'acute', x: 3, y: 0, w: 2, h: 1 }] })).toMatch(/overlaps/);
    expect(bad({ rooms: [{ id: 'c', type: 'acute', x: 9, y: 0, w: 3, h: 1 }] })).toMatch(/outside the footprint/);
    expect(bad({ entrance: { x: 2, y: 0 } })).toMatch(/entrance/);
    // A wall of rooms cuts the floor in two.
    const walled = resolveLayout({
      footprint: ['#####', '#####', '#####'],
      entrance: { x: 0, y: 1 },
      rooms: [
        { id: 'wall', type: 'station', x: 2, y: 0, w: 1, h: 3 },
        { id: 'far', type: 'acute', x: 4, y: 0, w: 1, h: 1 },
      ],
    });
    expect(walled.problems.join()).toMatch(/far: cannot be reached/);
  });
});

describe('layout module in the simulation', () => {
  const withLayout = (layout: LayoutSpec, extra: object = {}) => ({ id: 'l', durationMinutes: 7 * 1440, warmupMinutes: 1440, modules: { layout: true }, layout, ...extra });

  it('takes beds from rooms and rejects setBeds', () => {
    const c = resolveConfig(withLayout(exampleLayout()));
    expect(c.beds.main).toBe(14);
    expect(c.beds.fastTrack).toBe(6);
    const sim = new Simulation(withLayout(exampleLayout()), 1);
    expect(() => sim.command({ type: 'setBeds', lane: 'main', count: 30 })).toThrow(/beds come from rooms/);
    expect(() => resolveConfig(withLayout(exampleLayout(), { commands: [{ atMinute: 1, command: { type: 'setBeds', lane: 'main', count: 3 } }] }))).toThrow(/setBeds/);
  });

  it('needs a waiting room, a triage room and acute beds', () => {
    const noTriage = { ...exampleLayout(), rooms: exampleLayout().rooms.filter((r) => r.type !== 'triage') };
    expect(() => resolveConfig(withLayout(noTriage))).toThrow(/triage room/);
    expect(() => resolveConfig(withLayout(noTriage, { triage: { enabled: false } }))).not.toThrow();
  });

  it('puts patients in beds inside acute and fast-track rooms, after walking there', () => {
    const cfg = withLayout(exampleLayout(), { fastTrack: { enabled: true }, staffing: { fastTrackClinicians: 1 } });
    const sim = new Simulation(cfg, 2);
    const types = new Map(exampleLayout().rooms.map((r) => [r.id, r.type]));
    for (let t = 0; t < 2 * 1440; t += 20) {
      sim.runUntil(t);
      for (const p of sim.snapshot().patients.filter((x) => x.location === 'bed'))
        expect(types.get(p.room!)).toBe(p.lane === 'main' ? 'acute' : 'fastTrack');
    }
    sim.run();
    // In-bed work cannot start before the walk from the waiting room is over.
    for (const p of sim.allPatients()) if (p.bedTime !== undefined && p.doctorStartTime !== undefined) expect(p.doctorStartTime).toBeGreaterThan(p.bedTime);
  });

  it('a spread-out floor costs walking time and waits', () => {
    const spread: LayoutSpec = {
      footprint: { preset: 'rectangle', width: 70, height: 8 },
      entrance: { x: 0, y: 4 },
      rooms: [
        { id: 'waiting', type: 'waiting', x: 1, y: 0, w: 5, h: 3 },
        { id: 'triage', type: 'triage', x: 1, y: 5, w: 4, h: 3 },
        { id: 'station', type: 'station', x: 8, y: 0, w: 3, h: 2 },
        { id: 'acute-a', type: 'acute', x: 30, y: 0, w: 7, h: 4 },
        { id: 'acute-b', type: 'acute', x: 60, y: 5, w: 7, h: 3, capacity: 7 },
        { id: 'fast', type: 'fastTrack', x: 45, y: 0, w: 5, h: 3, capacity: 6 },
      ],
    };
    const run = (l: LayoutSpec) => [1, 2, 3].map((s) => new Simulation(withLayout(l), s).run().metrics);
    const compact = run(exampleLayout());
    const far = run(spread);
    const mean = (ms: typeof compact, f: (m: (typeof compact)[number]) => number) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
    expect(mean(far, (m) => m.walking!.shareOfBusyByRole.doctor!)).toBeGreaterThan(mean(compact, (m) => m.walking!.shareOfBusyByRole.doctor!) * 3);
    expect(mean(far, (m) => m.doorToDoctor.mean!)).toBeGreaterThan(mean(compact, (m) => m.doorToDoctor.mean!));
  });

  it('off: a layout section changes nothing', () => {
    const base = { id: 'l', durationMinutes: 3 * 1440, beds: { main: 14, fastTrack: 6 } };
    const a = new Simulation(base, 4).run().metrics;
    const b = new Simulation({ ...base, layout: exampleLayout() }, 4).run().metrics;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.walking).toBeNull();
  });
});

describe('ambulance door and walking heat', () => {
  const base = {
    footprint: { preset: 'rectangle' as const, width: 24, height: 14 },
    entrance: { x: 0, y: 7 },
    rooms: [
      { id: 'waiting', type: 'waiting' as const, x: 1, y: 1, w: 5, h: 4 },
      { id: 'triage', type: 'triage' as const, x: 1, y: 9, w: 4, h: 3 },
      { id: 'station', type: 'station' as const, x: 10, y: 6, w: 3, h: 2 },
      { id: 'acute', type: 'acute' as const, x: 8, y: 1, w: 8, h: 4 },
      { id: 'acute-b', type: 'acute' as const, x: 8, y: 9, w: 8, h: 4 },
    ],
  };
  const withTrauma = (x: number) => ({ ...base, ambulanceDoor: { x: 23, y: 7 }, rooms: [...base.rooms, { id: 'trauma', type: 'trauma' as const, x, y: 9, w: 4, h: 4 }] });
  const cfg = (layout: object) => ({ id: 'amb', durationMinutes: 3 * 1440, modules: { layout: true }, layout, arrivals: { acuityMix: { '1': 0.1, '2': 0.3, '3': 0.4, '4': 0.1, '5': 0.1 } } });

  it('resolves as an extra location after the rooms', () => {
    const r = resolveLayout(withTrauma(19)).layout!;
    expect(r.ambulanceLoc).toBe(r.rooms.length + 1);
    expect(r.dist.length).toBe(r.rooms.length + 2);
    expect(resolveLayout({ ...base, ambulanceDoor: { x: 2, y: 2 } }).problems[0]).toMatch(/ambulance door/);
  });

  it('no door: results are exactly as before', () => {
    const a = new Simulation(cfg(base), 3).run().metrics;
    const b = new Simulation(cfg({ ...base }), 3).run().metrics;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a trauma room by the ambulance door means less walking than one across the floor', () => {
    const near = new Simulation(cfg(withTrauma(19)), 5);
    const far = new Simulation(cfg({ ...withTrauma(19), ambulanceDoor: { x: 0, y: 12 } }), 5);
    const mn = near.run().metrics;
    const mf = far.run().metrics;
    // Minutes of wheeling into the trauma room, per patient taken there.
    const toTrauma = (s: Simulation, spec: LayoutSpec) => {
      const l = resolveLayout(spec).layout!;
      const trauma = l.rooms.findIndex((r) => r.type === 'trauma') + 1;
      const ts = s.walkTrips('patient').filter((w) => w.to === trauma);
      return ts.reduce((t, w) => t + w.count * l.dist[w.from]![w.to]!, 0) / ts.reduce((t, w) => t + w.count, 0);
    };
    expect(toTrauma(near, withTrauma(19))).toBeLessThan(toTrauma(far, { ...withTrauma(19), ambulanceDoor: { x: 0, y: 12 } }));
    expect(mn.arrivals).toBe(mf.arrivals);
  });

  it('heat follows the trips: each staff trip lights a path from base to patient', () => {
    const s = new Simulation(cfg(withTrauma(19)), 2);
    s.run();
    const l = resolveLayout(withTrauma(19)).layout!;
    const trips = s.walkTrips('staff');
    expect(trips.length).toBeGreaterThan(0);
    const heat = walkHeat(l, trips);
    const station = l.rooms.find((r) => r.id === 'station')!;
    expect(heat[station.access.y]![station.access.x]!).toBeGreaterThan(0);
    // One trip of known length: path cells + doors.
    const one = walkHeat(l, [{ from: 0, to: 1, count: 3 }]);
    const total = one.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(3 * (l.dist[0]![1]! - 1 + 1 + 1));
  });
});
