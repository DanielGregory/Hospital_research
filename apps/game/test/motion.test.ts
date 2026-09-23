import { exampleLayout, resolveConfig, Simulation } from '@er/sim';
import { describe, expect, it } from 'vitest';
import { layoutFloor, type FloorPlan, type Point } from '../src/render/floorPlan';
import { layoutGrid } from '../src/render/gridPlan';
import { Crowd } from '../src/render/motion';

const busy = { id: 'motion', durationMinutes: 24 * 60, arrivals: { rateMultiplier: 1.3 } };
const plan3d = (sim: Simulation) => layoutFloor(sim.snapshot(), 680, 440, true, { corridor: 40, staffBesideBed: true });

/** Run the crowd for `seconds` of real time at 30 frames a second. */
function play(crowd: Crowd, plan: FloorPlan, seconds: number, speed = 50) {
  for (let i = 0; i < seconds * 30; i++) crowd.update(plan, 1 / 30, { speed });
}

describe('walking animation', () => {
  it('brings newcomers in through the entrance and walks them to where the sim put them', () => {
    const sim = new Simulation(busy, 4);
    sim.runUntil(60);
    const plan = plan3d(sim);
    const crowd = new Crowd();
    const first = crowd.update(plan, 0, { speed: 50 });
    const walkIn = first.find((a) => a.kind === 'patient' && a.data.special === null)!;
    const door = plan.nav.doors.entrance;
    expect(Math.hypot(walkIn.x - door.outside.x, walkIn.y - door.outside.y)).toBeLessThan(1e-9);
    play(crowd, plan, 10);
    for (const a of crowd.list()) {
      expect(a.path).toEqual([]);
      expect(a.x).toBeCloseTo(a.target.x, 6);
      expect(a.y).toBeCloseTo(a.target.y, 6);
    }
  });

  it('places everyone at once when asked, and walks leavers out before dropping them', () => {
    const sim = new Simulation(busy, 4);
    sim.runUntil(300);
    const crowd = new Crowd();
    crowd.update(plan3d(sim), 0, { speed: 50, instant: true });
    const before = new Set(crowd.list().map((a) => a.key));
    expect(crowd.list().every((a) => a.path.length === 0)).toBe(true);

    sim.runUntil(420);
    const later = plan3d(sim);
    crowd.update(later, 1 / 30, { speed: 50 });
    const inSim = new Set([...later.patients.map((p) => `p${p.id}`), ...later.staff.map((s) => `s${s.id}`)]);
    const leavers = crowd.list().filter((a) => !inSim.has(a.key));
    expect(leavers.length).toBeGreaterThan(0);
    expect(leavers.every((a) => a.leaving && before.has(a.key))).toBe(true);
    play(crowd, later, 15);
    expect(crowd.list().filter((a) => a.leaving)).toEqual([]);
    expect(crowd.size).toBe(inSim.size);
  });

  it('keeps to the corridor and the aisles on the default floor', () => {
    const sim = new Simulation(busy, 7);
    sim.runUntil(600);
    const plan = plan3d(sim);
    const { nav, beds } = plan;
    const insideBed = (p: Point, except?: Point) =>
      beds.some((b) => p.x > b.x + 1 && p.x < b.x + b.w - 1 && p.y > b.y + 1 && p.y < b.y + b.h - 1 && !(except && except.x >= b.x && except.x <= b.x + b.w && except.y >= b.y && except.y <= b.y + b.h));
    const entrance = nav.doors.entrance.inside;
    for (const p of plan.patients.filter((x) => x.inBed)) {
      const pts = [entrance, ...nav.route(entrance, 'waiting', p, p.area)];
      // Sample every segment: nobody walks across another patient's bed.
      for (let i = 1; i < pts.length; i++)
        for (let t = 0; t <= 1; t += 0.05) {
          const q = { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t };
          expect(insideBed(q, p)).toBe(false);
        }
      // Waiting room to a bed goes through the corridor between them.
      const waitW = plan.areas.find((a) => a.id === 'waiting')!.w;
      expect(pts.some((q) => q.x > waitW && q.x < waitW + 40)).toBe(true);
    }
  });

  it('walks corridor cells between rooms on a custom layout', () => {
    const cfg = { id: 'grid', durationMinutes: 600, modules: { layout: true }, layout: exampleLayout() };
    const layout = resolveConfig(cfg).layout!;
    const sim = new Simulation(cfg, 3);
    sim.runUntil(240);
    const cell = 40;
    const plan = layoutGrid(sim.snapshot(), layout, layout.width * cell, layout.height * cell);
    const inRoom = (x: number, y: number) => layout.rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    const rooms = layout.rooms;
    for (const a of rooms)
      for (const b of rooms) {
        if (a === b) continue;
        const from = { x: (a.x + a.w / 2) * cell, y: (a.y + a.h / 2) * cell };
        const to = { x: (b.x + b.w / 2) * cell, y: (b.y + b.h / 2) * cell };
        const pts = plan.nav.route(from, a.id, to, b.id);
        // Between leaving one door and entering the other, every corner is a corridor cell.
        for (const q of pts.slice(1, -2)) {
          const cx = Math.floor(q.x / cell);
          const cy = Math.floor(q.y / cell);
          expect(layout.footprint[cy]![cx]).toBe('#');
          expect(inRoom(cx, cy)).toBe(false);
        }
      }
  });
});
