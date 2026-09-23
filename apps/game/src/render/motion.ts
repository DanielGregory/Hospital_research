/**
 * Walking animation. The sim says where everyone is; the crowd walks each person there along
 * the plan's routes, brings newcomers in through a door and walks leavers out. Purely visual:
 * nothing here feeds back into the sim. Used by both the 2D and the 3D views.
 */
import type { Door, FloorPlan, PatientDot, Point, StaffMark } from './floorPlan';

export type Actor =
  | (ActorBase & { kind: 'patient'; data: PatientDot })
  | (ActorBase & { kind: 'staff'; data: StaffMark });

interface ActorBase {
  key: string;
  x: number;
  y: number;
  /** Direction of travel, radians, measured from +y towards +x (plan coordinates). */
  heading: number;
  /** Distance walked so far (drives the gait). */
  stride: number;
  /** Walked this frame. */
  moving: boolean;
  /** Waypoints still to walk. */
  path: Point[];
  /** Where the sim puts them, and the area that is in. */
  target: Point;
  targetArea: string | null;
  /** Gone from the sim; walking out, removed at the door. */
  leaving: boolean;
}

export interface CrowdOptions {
  /** Walking speed in plan units per real second. */
  speed: number;
  /** Place everyone at their target at once (first frame, resize, view change). */
  instant?: boolean;
}

/** People further than this many seconds behind their target speed up to catch up. */
const CATCH_UP_SECONDS = 2.5;

export class Crowd {
  private actors = new Map<string, Actor>();

  get size(): number {
    return this.actors.size;
  }

  list(): Actor[] {
    return [...this.actors.values()];
  }

  get(key: string): Actor | undefined {
    return this.actors.get(key);
  }

  clear(): void {
    this.actors.clear();
  }

  update(plan: FloorPlan, dtSeconds: number, opts: CrowdOptions): Actor[] {
    const { nav } = plan;
    const seen = new Set<string>();
    const place = (key: string, kind: 'patient' | 'staff', data: PatientDot | StaffMark, door: Door) => {
      seen.add(key);
      const target = { x: data.x, y: data.y };
      const existing = this.actors.get(key);
      if (!existing) {
        const a = {
          key,
          kind,
          data,
          x: opts.instant ? target.x : door.outside.x,
          y: opts.instant ? target.y : door.outside.y,
          heading: 0,
          stride: 0,
          moving: false,
          path: opts.instant ? [] : [door.inside, ...nav.route(door.inside, door.area, target, data.area)],
          target,
          targetArea: data.area,
          leaving: false,
        } as Actor;
        this.actors.set(key, a);
        return;
      }
      existing.data = data as never;
      existing.leaving = false;
      if (opts.instant) {
        existing.x = target.x;
        existing.y = target.y;
        existing.path = [];
      } else if (dist(existing.target, target) > 0.5 || existing.targetArea !== data.area) {
        const here = { x: existing.x, y: existing.y };
        existing.path = nav.route(here, nav.areaAt(here), target, data.area);
      }
      existing.target = target;
      existing.targetArea = data.area;
    };

    for (const p of plan.patients) place(`p${p.id}`, 'patient', p, p.special === 'massCasualty' ? nav.doors.ambulance : nav.doors.entrance);
    for (const s of plan.staff) place(`s${s.id}`, 'staff', s, nav.doors.staff);

    for (const a of this.actors.values()) {
      if (seen.has(a.key)) continue;
      if (opts.instant) {
        this.actors.delete(a.key);
        continue;
      }
      if (!a.leaving) {
        // Admitted patients go up to the ward; everyone else leaves the way they came.
        const door = a.kind === 'staff' ? nav.doors.staff : a.data.boarding ? nav.doors.ward : nav.doors.entrance;
        const here = { x: a.x, y: a.y };
        a.leaving = true;
        a.path = [...nav.route(here, nav.areaAt(here), door.inside, door.area), door.outside];
      }
    }

    for (const a of this.actors.values()) {
      walk(a, dtSeconds, opts.speed);
      if (a.leaving && a.path.length === 0) this.actors.delete(a.key);
    }
    return this.list();
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(a: Actor): number {
  let len = 0;
  let from: Point = a;
  for (const p of a.path) {
    len += dist(from, p);
    from = p;
  }
  return len;
}

function walk(a: Actor, dt: number, speed: number) {
  a.moving = false;
  if (a.path.length === 0 || dt <= 0) return;
  const remaining = pathLength(a);
  let step = Math.max(speed * dt, (remaining / CATCH_UP_SECONDS) * dt);
  const before = { x: a.x, y: a.y };
  while (step > 0 && a.path.length) {
    const next = a.path[0]!;
    const d = dist(a, next);
    if (d <= step) {
      a.x = next.x;
      a.y = next.y;
      a.path.shift();
      step -= d;
    } else {
      a.x += ((next.x - a.x) / d) * step;
      a.y += ((next.y - a.y) / d) * step;
      step = 0;
    }
  }
  const moved = dist(before, a);
  if (moved > 1e-6) {
    a.moving = true;
    a.stride += moved;
    a.heading = Math.atan2(a.x - before.x, a.y - before.y);
  }
}

/** The plan with everyone drawn where they are walking, leavers included (for the 2D view). */
export function withActors(plan: FloorPlan, actors: readonly Actor[]): FloorPlan {
  return {
    ...plan,
    patients: actors.flatMap((a) => (a.kind === 'patient' ? [{ ...a.data, x: a.x, y: a.y }] : [])),
    staff: actors.flatMap((a) => (a.kind === 'staff' ? [{ ...a.data, x: a.x, y: a.y }] : [])),
  };
}
