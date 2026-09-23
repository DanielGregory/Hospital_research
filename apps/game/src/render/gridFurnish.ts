/**
 * Furniture for a custom floor plan in the 3D view. Takes the grid plan (rooms where the player drew
 * them) and furnishes each room by type: curtained cubicles along the walls of bed rooms with an
 * aisle down the middle, chairs in the waiting room, desks in triage, workstations in the staff
 * station, a CT scanner in imaging, benches in the lab, and trolleys lined up in the corridor.
 * Beds keep the engine's numbering (trauma rooms first). Pure; no sim logic.
 */
import type { ResolvedLayout, ResolvedRoom, SimSnapshot } from '@er/sim';
import type { Bay, BedMark, FloorPlan, Nav, PatientDot, Point, Prop, Rect, StaffMark } from './floorPlan';

const NORTH = Math.PI;
const SOUTH = 0;
const BAY_DEPTH = 76;
const MIN_AISLE = 36;
const MIN_SLOT = 30;

interface Slot {
  bay: Bay;
  lie: Point;
  side: Point;
  head: 'up' | 'down';
  recliner: boolean;
}

/** Cubicles along one or two walls of a bed room, leaving the door clear. Null if they do not fit. */
function cubicles(room: ResolvedRoom, r: Rect, door: Rect, count: number, firstIndex: number, lane: 'main' | 'fastTrack'): { slots: Slot[]; aisleY: number } | null {
  const kind: Bay['kind'] = room.type === 'fastTrack' ? 'recliner' : room.type === 'trauma' ? 'trauma' : 'bay';
  const two = r.h >= 2 * 50 + MIN_AISLE && count > 1;
  // One row goes against the wall away from the door.
  const onlyBottom = !two && door.y <= r.y + 1;
  const rows: ('top' | 'bottom')[] = two ? ['top', 'bottom'] : [onlyBottom ? 'bottom' : 'top'];
  const depth = Math.min(BAY_DEPTH, (r.h - MIN_AISLE) / rows.length);
  if (depth < 40) return null;
  const band = (row: 'top' | 'bottom') => (row === 'top' ? { y0: r.y, y1: r.y + depth } : { y0: r.y + r.h - depth, y1: r.y + r.h });
  // Free stretches of each row: the whole wall, minus the door if the door opens into that row.
  const stretches = rows.map((row) => {
    const b = band(row);
    const whole: [number, number] = [r.x + 4, r.x + r.w - 4];
    if (door.y + door.h <= b.y0 || door.y >= b.y1) return [whole];
    const parts: [number, number][] = [
      [whole[0], door.x - 4],
      [door.x + door.w + 4, whole[1]],
    ];
    return parts.filter(([lo, hi]) => hi - lo > 0);
  });
  let slotW = Math.min(kind === 'trauma' ? 140 : 90, r.w);
  const fits = (w: number) => stretches.reduce((n, ss) => n + ss.reduce((m, [a, b]) => m + Math.floor((b - a) / w), 0), 0);
  while (slotW >= MIN_SLOT && fits(slotW) < count) slotW -= 2;
  if (slotW < MIN_SLOT) return null;
  // Positions along each row, then alternate rows so both walls fill as beds are taken.
  const free = stretches.map((ss) => ss.flatMap(([a, b]) => Array.from({ length: Math.floor((b - a) / slotW) }, (_, i) => a + i * slotW)));
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    let ri = i % rows.length;
    if (!free[ri]!.length) ri = (ri + 1) % rows.length;
    const x = free[ri]!.shift()!;
    const row = rows[ri]!;
    const top = row === 'top';
    const b = band(row);
    const index = firstIndex + i;
    const label = kind === 'trauma' ? `Trauma ${index + 1}` : lane === 'fastTrack' ? `FT ${index + 1}` : `Bay ${index + 1}`;
    const bay: Bay = { kind, lane, index, x, y: b.y0, w: slotW, h: depth, front: top ? 'down' : 'up', label, attended: false };
    const cx = x + slotW / 2;
    if (kind === 'recliner') {
      const seatY = top ? b.y0 + 20 : b.y1 - 20;
      slots.push({ bay, lie: { x: cx, y: seatY }, side: { x: cx + Math.min(22, slotW / 2 - 4), y: seatY + (top ? 6 : -6) }, head: top ? 'up' : 'down', recliner: true });
    } else {
      const bw = Math.min(22, slotW * 0.4);
      const bl = Math.min(42, depth - 14);
      const bx = cx - bw / 2 - (kind === 'trauma' ? 0 : Math.min(8, slotW * 0.12));
      const by = top ? b.y0 + 6 : b.y1 - 6 - bl;
      slots.push({ bay, lie: { x: bx + bw / 2, y: by + bl / 2 }, side: { x: Math.min(x + slotW - 5, bx + bw + 11), y: by + bl / 2 }, head: top ? 'up' : 'down', recliner: false });
    }
  }
  const aisleY = two ? r.y + depth + (r.h - 2 * depth) / 2 : rows[0] === 'top' ? r.y + depth + (r.h - depth) / 2 : r.y + (r.h - depth) / 2;
  return { slots, aisleY };
}

export function furnishGrid(base: FloorPlan, s: SimSnapshot, layout: ResolvedLayout): FloorPlan {
  const cell = base.grid!.cell;
  const first = layout.rooms[0]!;
  const firstArea = base.areas.find((a) => a.id === first.id)!;
  const ox = firstArea.x - first.x * cell;
  const oy = firstArea.y - first.y * cell;
  const rectOf = (room: ResolvedRoom): Rect => ({ x: ox + room.x * cell, y: oy + room.y * cell, w: room.w * cell, h: room.h * cell });
  const cellRect = (c: { x: number; y: number }): Rect => ({ x: ox + c.x * cell, y: oy + c.y * cell, w: cell, h: cell });
  const centre = (c: { x: number; y: number }): Point => ({ x: ox + (c.x + 0.5) * cell, y: oy + (c.y + 0.5) * cell });

  const props: Prop[] = [];
  const bays: Bay[] = [];
  const seats: Point[] = [];
  const slotOf = new Map<string, Slot>();
  const aisle = new Map<string, number>();
  const bedsFallback = new Set<string>();
  const next = { main: 0, fastTrack: 0 };
  const triageDesks = new Map<string, { nurse: Point; patient: Point }[]>();
  const stationSeats = new Map<string, (Point & { face: number })[]>();

  // Bed rooms in the engine's order: trauma rooms, then acute, then fast track.
  for (const type of ['trauma', 'acute', 'fastTrack'] as const)
    for (const room of layout.rooms.filter((x) => x.type === type)) {
      const lane = type === 'fastTrack' ? 'fastTrack' : 'main';
      const firstIndex = next[lane];
      next[lane] += room.capacity;
      const c = cubicles(room, rectOf(room), cellRect(room.door), room.capacity, firstIndex, lane);
      if (!c) {
        bedsFallback.add(room.id);
        continue;
      }
      aisle.set(room.id, c.aisleY);
      for (const sl of c.slots) {
        slotOf.set(`${lane}:${sl.bay.index}`, sl);
        bays.push(sl.bay);
      }
    }

  for (const room of layout.rooms) {
    const r = rectOf(room);
    if (room.type === 'waiting') {
      for (let y = r.y + 26; y < r.y + r.h - 16; y += 40) for (let x = r.x + 16; x < r.x + r.w - 14; x += 22) seats.push({ x, y });
      props.push({ type: 'plant', x: r.x + 10, y: r.y + r.h - 10 }, { type: 'plant', x: r.x + r.w - 10, y: r.y + r.h - 10 });
    } else if (room.type === 'triage') {
      const n = Math.max(1, room.capacity);
      const w = r.w / n;
      const deskY = r.y + r.h * 0.45;
      const desks = Array.from({ length: n }, (_, i) => {
        const x = r.x + w * (i + 0.5);
        props.push({ type: 'desk', x, y: deskY, w: Math.min(58, w - 12), h: 16 });
        props.push({ type: 'chair', x, y: deskY - 20, rot: SOUTH }, { type: 'chair', x, y: deskY + 20, rot: NORTH });
        return { nurse: { x, y: deskY - 20 }, patient: { x, y: deskY + 20 } };
      });
      triageDesks.set(room.id, desks);
    } else if (room.type === 'station') {
      // Workstations along the top wall; staff sit facing them.
      const n = Math.max(1, Math.floor((r.w - 20) / 36));
      const spots: (Point & { face: number })[] = [];
      props.push({ type: 'counter', x: r.x + r.w / 2, y: r.y + 10, w: r.w - 8, h: 13, rot: NORTH });
      for (let i = 0; i < n; i++) {
        const x = r.x + 22 + i * 36;
        props.push({ type: 'workstation', x, y: r.y + 13, rot: SOUTH }, { type: 'officeChair', x, y: r.y + 32, rot: NORTH });
        spots.push({ x, y: r.y + 32, face: NORTH });
      }
      if (r.h >= 70) props.push({ type: 'board', x: r.x + r.w - 16, y: r.y + r.h - 22, rot: -Math.PI / 2 + 0.6 });
      stationSeats.set(room.id, spots);
    } else if (room.type === 'imaging') {
      props.push({ type: 'scanner', x: r.x + r.w / 2, y: r.y + r.h / 2 - Math.min(20, r.h / 4), rot: 0 });
    } else if (room.type === 'lab') {
      props.push({ type: 'bench', x: r.x + r.w / 2, y: r.y + 12, w: r.w - 12, h: 14, rot: SOUTH });
    }
  }

  // Corridor cells in order of distance from the entrance: where ambulance arrivals wait on trolleys.
  const inRoom = (x: number, y: number) => layout.rooms.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
  const walkable = (x: number, y: number) => x >= 0 && y >= 0 && x < layout.width && y < layout.height && layout.footprint[y]![x] === '#' && !inRoom(x, y);
  const corridor: Point[] = [];
  {
    const seen = new Set([`${layout.entrance.x},${layout.entrance.y}`]);
    const queue = [layout.entrance];
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i]!;
      corridor.push(centre(c));
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = `${c.x + dx},${c.y + dy}`;
        if (!seen.has(k) && walkable(c.x + dx, c.y + dy)) {
          seen.add(k);
          queue.push({ x: c.x + dx, y: c.y + dy });
        }
      }
    }
  }
  const byRoom = new Map(layout.rooms.map((q) => [q.id, q]));
  const firstOf = (type: string) => layout.rooms.find((q) => q.type === type);

  // ---- People: patients.
  const patients: PatientDot[] = [];
  const staffAt = new Map<number, { pos: Point; area: string; pose: 'stand' | 'sit'; face: number }>();
  const baseDot = new Map(base.patients.map((p) => [p.id, p]));
  const nurseDesk = new Map<number, { room: string; k: number }>();
  const nurseCount = new Map<string, number>();
  for (const m of s.staff)
    if (m.role === 'triageNurse') {
      const room = m.room && triageDesks.has(m.room) ? m.room : firstOf('triage')?.id;
      if (!room) continue;
      const k = nurseCount.get(room) ?? 0;
      nurseCount.set(room, k + 1);
      nurseDesk.set(m.id, { room, k });
    }
  const taken = new Set<number>();
  let hallway = 0;
  for (const p of [...s.patients].sort((a, b) => a.id - b.id)) {
    const d = baseDot.get(p.id);
    if (!d) continue;
    const put = (pos: Point, area: string, pose: PatientDot['pose'], face: number, bedLabel?: string) => patients.push({ ...d, ...pos, area, pose, face, bedLabel });
    if (p.location === 'bed') {
      const sl = slotOf.get(`${p.lane}:${p.bed}`);
      if (!sl) {
        put(d, d.area, 'lie', Math.PI / 2);
        continue;
      }
      sl.bay.attended = p.staffIds.length > 0;
      put(sl.lie, p.room ?? d.area, sl.recliner ? 'sit' : 'lie', sl.recliner ? (sl.head === 'up' ? SOUTH : NORTH) : sl.head === 'up' ? 0 : Math.PI, sl.bay.label);
      p.staffIds.forEach((id, k) => staffAt.set(id, { pos: { x: sl.side.x, y: sl.side.y + k * 12 }, area: p.room ?? d.area, pose: 'stand', face: 0 }));
    } else if (p.location === 'intake') {
      const desk = p.staffIds.map((id) => nurseDesk.get(id)).find(Boolean);
      const spot = desk ? triageDesks.get(desk.room)?.[desk.k % triageDesks.get(desk.room)!.length] : undefined;
      if (desk && spot) put(spot.patient, desk.room, 'sit', NORTH);
      else put(d, d.area, 'stand', 0);
    } else if (p.source === 'massCasualty' && corridor.length > 2) {
      // On a trolley in the corridor, every other cell from the entrance.
      put(corridor[Math.min(corridor.length - 1, 2 + 2 * hallway++)]!, '', 'lie', 0);
    } else if (seats.length && d.area && byRoom.get(d.area)?.type === 'waiting') {
      let i = (p.id * 7919) % seats.length;
      for (let n = 0; n < seats.length && taken.has(i); n++) i = (i + 1) % seats.length;
      if (!taken.has(i)) {
        taken.add(i);
        put(seats[i]!, d.area, 'sit', SOUTH);
      } else put(d, d.area, 'stand', 0);
    } else put(d, d.area, 'stand', 0);
  }

  // ---- Staff.
  const staff: StaffMark[] = [];
  const seatUsed = new Map<string, number>();
  for (const m of base.staff) {
    const at = staffAt.get(m.id);
    if (at) {
      staff.push({ ...m, ...at.pos, area: at.area, pose: at.pose, face: at.face });
      continue;
    }
    const desk = nurseDesk.get(m.id);
    const deskSpot = desk ? triageDesks.get(desk.room)?.[desk.k] : undefined;
    if (desk && deskSpot) {
      staff.push({ ...m, ...deskSpot.nurse, area: desk.room, pose: 'sit', face: SOUTH });
      continue;
    }
    const spots = stationSeats.get(m.area);
    const used = seatUsed.get(m.area) ?? 0;
    if (spots && used < spots.length && !m.busy) {
      seatUsed.set(m.area, used + 1);
      staff.push({ ...m, ...spots[used]!, area: m.area, pose: 'sit', face: spots[used]!.face });
      continue;
    }
    staff.push(m);
  }

  // ---- Beds: cubicle beds where they fit, the plain grid otherwise.
  const beds: BedMark[] = base.beds
    .filter((b) => {
      const room = layout.rooms.find((q) => rectContains(rectOf(q), { x: b.x + b.w / 2, y: b.y + b.h / 2 }));
      return !room || bedsFallback.has(room.id);
    })
    .map((b) => ({ ...b }));
  for (const sl of slotOf.values()) {
    const b = sl.bay;
    const occupied = s.patients.some((p) => p.location === 'bed' && p.lane === b.lane && p.bed === b.index);
    if (sl.recliner) beds.push({ lane: b.lane, index: b.index, x: sl.lie.x - 13, y: sl.lie.y - 13, w: 26, h: 26, occupied, recliner: true, head: sl.head });
    else {
      const bw = Math.min(22, b.w * 0.4);
      const bl = Math.min(42, b.h - 14);
      beds.push({ lane: b.lane, index: b.index, x: sl.lie.x - bw / 2, y: sl.lie.y - bl / 2, w: bw, h: bl, occupied, trauma: b.kind === 'trauma', head: sl.head });
    }
  }

  return { ...base, beds, bays, props, seats, patients, staff, nav: furnishedNav(base.nav, layout, rectOf, centre, slotOf, aisle) };
}

function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Routes that use the aisle inside bed rooms, so nobody walks across a bed. */
function furnishedNav(
  base: Nav,
  layout: ResolvedLayout,
  rectOf: (r: ResolvedRoom) => Rect,
  centre: (c: { x: number; y: number }) => Point,
  slotOf: Map<string, Slot>,
  aisle: Map<string, number>,
): Nav {
  const rooms = new Map(layout.rooms.map((r) => [r.id, r]));
  const bays = [...slotOf.values()].map((s) => s.bay);
  /** From the room's door to `p`: along the aisle to the cubicle, in at its front. */
  const inside = (roomId: string | null, p: Point): Point[] => {
    const room = roomId ? rooms.get(roomId) : undefined;
    const y = roomId ? aisle.get(roomId) : undefined;
    if (!room || y === undefined) return [p];
    const door = centre(room.door);
    const r = rectOf(room);
    const bay = bays.find((b) => rectContains(b, p));
    const clampX = (x: number) => Math.max(r.x + 8, Math.min(r.x + r.w - 8, x));
    const pts: Point[] = [{ x: clampX(door.x), y }];
    if (bay) {
      const cx = bay.x + bay.w / 2;
      const frontY = bay.front === 'down' ? bay.y + bay.h + 4 : bay.y - 4;
      pts.push({ x: cx, y }, { x: cx, y: frontY }, { x: p.x, y: bay.front === 'down' ? Math.min(p.y + 14, frontY) : Math.max(p.y - 14, frontY) });
    } else pts.push({ x: p.x, y });
    pts.push(p);
    return pts;
  };
  const route = (from: Point, fromArea: string | null, to: Point, toArea: string | null): Point[] => {
    const fa = fromArea || null;
    const ta = toArea || null;
    if (fa && fa === ta) {
      if (!aisle.has(fa)) return [to];
      const out = inside(fa, from).slice(0, -1).reverse();
      const back = inside(ta, to);
      // Both via the aisle: drop the door-side point on each leg.
      return [...out.slice(0, -1), ...back.slice(1)];
    }
    const exit = fa ? inside(fa, from).slice(0, -1).reverse() : [];
    const doorB = ta && rooms.get(ta) ? centre(rooms.get(ta)!.door) : to;
    const middle = base.route(from, fa, doorB, ta);
    const enter = ta && rooms.get(ta) ? inside(ta, to) : [];
    return [...exit, ...middle, ...enter];
  };
  return { ...base, route };
}
