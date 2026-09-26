import { exampleLayout, resolveConfig, Simulation } from '@er/sim';
import { describe, expect, it } from 'vitest';
import { layoutFloor, type FloorPlan, type Point } from '../src/render/floorPlan';
import { layoutGrid } from '../src/render/gridPlan';
import { Crowd } from '../src/render/motion';
import { furnishGrid } from '../src/render/gridFurnish';
import { layoutWard } from '../src/render/wardPlan';

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

  it('lays the 3D department out with a cubicle for every bed and walks round beds and the station counters', () => {
    const sim = new Simulation({ ...busy, beds: { main: 14, fastTrack: 5, traumaBays: 2 }, fastTrack: { enabled: true } }, 9);
    sim.runUntil(14 * 60);
    const s = sim.snapshot();
    const plan = layoutWard(s, true);
    expect(plan.bays!.filter((b) => b.lane === 'main')).toHaveLength(14);
    expect(plan.bays!.filter((b) => b.kind === 'trauma').map((b) => b.index)).toEqual([0, 1]);
    expect(plan.bays!.filter((b) => b.kind === 'recliner')).toHaveLength(5);
    // Everyone the sim has in a bed is drawn in their bed.
    const inBeds = s.patients.filter((p) => p.location === 'bed');
    expect(plan.patients.filter((p) => p.inBed)).toHaveLength(inBeds.length);
    expect(inBeds.length).toBeGreaterThan(5);

    // Solid things: beds, and the counters, cabinet and board of the nurses' station.
    const solid = plan.props!.filter((p) => p.type === 'counter');
    expect(solid.length).toBe(5);
    const blocked = (q: Point, own?: Point) =>
      plan.beds.some((b) => q.x > b.x + 1 && q.x < b.x + b.w - 1 && q.y > b.y + 1 && q.y < b.y + b.h - 1 && !(own && own.x >= b.x && own.x <= b.x + b.w && own.y >= b.y && own.y <= b.y + b.h)) ||
      solid.some((c) => Math.abs(q.x - c.x) < c.w! / 2 - 1 && Math.abs(q.y - c.y) < c.h! / 2 - 1);
    const check = (pts: Point[], own?: Point) => {
      for (let i = 1; i < pts.length; i++)
        for (let t = 0; t <= 1; t += 0.05) expect(blocked({ x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t }, own)).toBe(false);
    };
    const { entrance, ambulance } = plan.nav.doors;
    for (const p of plan.patients.filter((x) => x.inBed)) {
      check([entrance.inside, ...plan.nav.route(entrance.inside, 'waiting', p, p.area)], p);
      check([ambulance.inside, ...plan.nav.route(ambulance.inside, 'main', p, p.area)], p);
    }
    // Staff walking from their seats inside the station to a bedside, and back.
    const bedside = plan.staff.filter((m) => m.busy && m.area === 'main');
    const seats = plan.props!.filter((p) => p.type === 'officeChair');
    expect(bedside.length).toBeGreaterThan(0);
    expect(seats.length).toBeGreaterThan(3);
    for (const m of bedside)
      for (const seat of seats) {
        check([seat, ...plan.nav.route(seat, 'main', m, 'main')]);
        check([m, ...plan.nav.route(m, 'main', seat, 'main')]);
      }
  });

  it('numbers trauma-room beds first on a custom layout, as the engine does', () => {
    const base = exampleLayout();
    const layout = { ...base, rooms: [...base.rooms, { id: 'resus', type: 'trauma' as const, x: 18, y: 8, w: 4, h: 4 }] };
    const cfg = { id: 'grid-trauma', durationMinutes: 600, modules: { layout: true }, layout };
    const sim = new Simulation(cfg, 2);
    sim.runUntil(300);
    const plan = layoutGrid(sim.snapshot(), resolveConfig(cfg).layout!, 960, 560);
    const main = plan.beds.filter((b) => b.lane === 'main');
    expect(main.filter((b) => b.trauma).map((b) => b.index)).toEqual([0, 1]);
    for (const p of plan.patients.filter((x) => x.inBed && x.area === 'resus')) expect(sim.snapshot().patients.find((q) => q.id === p.id)!.bed).toBeLessThan(2);
  });

  it('furnishes a custom floor plan: cubicles in engine bed order, routes round the beds', () => {
    const base = exampleLayout();
    const layout = { ...base, rooms: [...base.rooms, { id: 'resus', type: 'trauma' as const, x: 18, y: 8, w: 5, h: 4 }] };
    const cfg = { id: 'furnish', durationMinutes: 900, modules: { layout: true }, layout, fastTrack: { enabled: true }, arrivals: { rateMultiplier: 1.3 } };
    const resolved = resolveConfig(cfg).layout!;
    const sim = new Simulation(cfg, 4);
    sim.runUntil(12 * 60);
    const s = sim.snapshot();
    const cell = 40;
    const plan = furnishGrid(layoutGrid(s, resolved, resolved.width * cell, resolved.height * cell), s, resolved);
    // Every bed the engine has gets a cubicle, numbered as the engine numbers them.
    const main = plan.bays!.filter((b) => b.lane === 'main').map((b) => b.index).sort((a, b) => a - b);
    expect(main).toEqual([...Array(resolveConfig(cfg).beds.main).keys()]);
    expect(plan.bays!.filter((b) => b.kind === 'trauma').map((b) => b.index).sort()).toEqual([0, 1]);
    expect(plan.bays!.some((b) => b.kind === 'recliner')).toBe(true);
    expect(plan.seats.length).toBeGreaterThan(10);
    // The sim's bedded patients lie in their cubicle, in the right room.
    const inBeds = s.patients.filter((p) => p.location === 'bed');
    expect(inBeds.length).toBeGreaterThan(3);
    for (const p of inBeds) {
      const dot = plan.patients.find((d) => d.id === p.id)!;
      const bay = plan.bays!.find((b) => b.lane === p.lane && b.index === p.bed)!;
      expect(dot.x >= bay.x && dot.x <= bay.x + bay.w && dot.y >= bay.y && dot.y <= bay.y + bay.h).toBe(true);
    }
    // Walking in from the entrance never crosses somebody else's bed.
    const blocked = (q: Point, own: Point) =>
      plan.beds.some((b) => q.x > b.x + 1 && q.x < b.x + b.w - 1 && q.y > b.y + 1 && q.y < b.y + b.h - 1 && !(own.x >= b.x && own.x <= b.x + b.w && own.y >= b.y && own.y <= b.y + b.h));
    const door = plan.nav.doors.entrance;
    for (const p of plan.patients.filter((x) => x.inBed)) {
      const pts = [door.inside, ...plan.nav.route(door.inside, door.area, p, p.area)];
      for (let i = 1; i < pts.length; i++)
        for (let t = 0; t <= 1; t += 0.05) expect(blocked({ x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t }, p)).toBe(false);
    }
    // Moving within any room always gives somewhere to walk to.
    for (const a of plan.areas) {
      const to = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const r = plan.nav.route({ x: a.x + 6, y: a.y + 6 }, a.id, to, a.id);
      expect(r.at(-1)).toEqual(to);
    }
  });
});
