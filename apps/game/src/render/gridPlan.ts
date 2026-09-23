/**
 * Pure layout of the grid (floor-plan) view used when the layout module is on:
 * rooms where the player drew them, beds inside acute and fast-track rooms,
 * patients and staff placed in the room they are in.
 */
import type { ResolvedLayout, SimSnapshot } from '@er/sim';
import type { Area, BedMark, Door, FloorPlan, Nav, PatientDot, Point, Rect, StaffMark } from './floorPlan';

const ROOM_LABEL: Record<string, string> = {
  waiting: 'Waiting',
  triage: 'Triage',
  acute: 'Acute',
  fastTrack: 'Fast track',
  station: 'Staff station',
  imaging: 'Imaging',
  lab: 'Lab',
};

export function layoutGrid(s: SimSnapshot, layout: ResolvedLayout, width: number, height: number): FloorPlan {
  const cell = Math.max(4, Math.floor(Math.min(width / layout.width, height / layout.height)));
  const ox = Math.floor((width - cell * layout.width) / 2);
  const oy = Math.floor((height - cell * layout.height) / 2);
  const rect = (x: number, y: number, w = 1, h = 1): Rect => ({ x: ox + x * cell, y: oy + y * cell, w: w * cell, h: h * cell });

  const cells: Rect[] = [];
  layout.footprint.forEach((row, y) => [...row].forEach((c, x) => c === '#' && cells.push(rect(x, y))));
  const areas: Area[] = layout.rooms.map((r) => ({ id: r.id, kind: r.type, label: `${ROOM_LABEL[r.type] ?? r.type}`, ...rect(r.x, r.y, r.w, r.h) }));
  const roomRect = new Map(areas.map((a) => [a.id, a]));

  // Beds: spread each room's beds across its rectangle, in the engine's bed order.
  const beds: BedMark[] = [];
  const bedCentre = new Map<string, { x: number; y: number }>();
  for (const [lane, type] of [
    ['main', 'acute'],
    ['fastTrack', 'fastTrack'],
  ] as const) {
    let index = 0;
    const used = new Set(s.patients.filter((p) => p.location === 'bed' && p.lane === lane).map((p) => p.bed));
    for (const r of layout.rooms.filter((x) => x.type === type)) {
      const a = roomRect.get(r.id)!;
      const cols = Math.max(1, Math.ceil(Math.sqrt((r.capacity * a.w) / a.h)));
      const rows = Math.max(1, Math.ceil(r.capacity / cols));
      const bw = (a.w - 8) / cols;
      const bh = (a.h - 18) / rows;
      for (let k = 0; k < r.capacity; k++, index++) {
        const x = a.x + 4 + (k % cols) * bw;
        const y = a.y + 16 + Math.floor(k / cols) * bh;
        beds.push({ lane, index, x: x + 1, y: y + 1, w: Math.max(4, bw - 2), h: Math.max(4, bh - 2), occupied: used.has(index) });
        bedCentre.set(`${lane}:${index}`, { x: x + bw / 2, y: y + bh / 2 });
      }
    }
  }

  // Patients: in their bed, or clustered inside the waiting/triage room.
  const patients: PatientDot[] = [];
  const firstOf = (type: string) => layout.rooms.find((r) => r.type === type);
  const cluster = (roomId: string | undefined, i: number) => {
    const a = roomId ? roomRect.get(roomId) : undefined;
    if (!a) return { x: ox, y: oy };
    const per = Math.max(1, Math.floor((a.w - 8) / 10));
    return { x: a.x + 8 + (i % per) * 10, y: Math.min(a.y + a.h - 6, a.y + 22 + Math.floor(i / per) * 10) };
  };
  let waitingIdx = 0;
  let intakeIdx = 0;
  for (const p of s.patients) {
    const base = {
      id: p.id,
      acuity: p.assignedAcuity,
      waited: s.now - p.arrivalTime,
      boarding: p.boarding,
      special: p.source === 'walkIn' ? null : p.source,
      inBed: p.location === 'bed',
    };
    if (p.location === 'bed') {
      const c = bedCentre.get(`${p.lane}:${p.bed}`);
      if (c) patients.push({ ...base, ...c, area: p.room ?? '' });
    } else if (p.location === 'intake') {
      const room = firstOf('triage')?.id;
      patients.push({ ...base, ...cluster(room, intakeIdx++), area: room ?? '' });
    } else {
      const room = firstOf('waiting')?.id;
      patients.push({ ...base, ...cluster(room, waitingIdx++), area: room ?? '' });
    }
  }

  // Staff: next to their patient when busy, otherwise at their home room.
  const staff: StaffMark[] = [];
  const homeCount = new Map<string, number>();
  for (const m of s.staff) {
    const mark = { id: m.id, role: m.role, busy: m.busy, leaving: m.retiring, fatigue: m.fatigue, patientId: m.patientId };
    const patient = m.patientId === undefined ? undefined : patients.find((p) => p.id === m.patientId);
    if (patient) {
      staff.push({ ...mark, x: patient.x + 13, y: patient.y - 11, area: patient.area });
      continue;
    }
    const home = m.room ?? firstOf('station')?.id;
    const a = home ? roomRect.get(home) : undefined;
    const n = homeCount.get(home ?? '') ?? 0;
    homeCount.set(home ?? '', n + 1);
    const per = Math.max(1, Math.floor(((a?.w ?? 60) - 10) / 19));
    staff.push({ ...mark, x: (a?.x ?? ox) + 12 + (n % per) * 19, y: (a?.y ?? oy) + (a ? a.h - 12 : 0) - Math.floor(n / per) * 19, area: home ?? '' });
  }

  return {
    grid: { cells, entrance: rect(layout.entrance.x, layout.entrance.y), cell },
    areas,
    beds,
    staff,
    patients,
    waitingLines: [],
    seats: [],
    nav: gridNav(layout, cell, ox, oy),
  };
}

/** Routes on the grid: out of the room by its door, along corridor cells (breadth-first), in by the other door. */
function gridNav(layout: ResolvedLayout, cell: number, ox: number, oy: number): Nav {
  const W = layout.width;
  const H = layout.height;
  const centre = (c: { x: number; y: number }): Point => ({ x: ox + (c.x + 0.5) * cell, y: oy + (c.y + 0.5) * cell });
  const inRoom = (x: number, y: number) => layout.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const walkable = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && layout.footprint[y]![x] === '#' && !inRoom(x, y);
  const toCell = (p: Point) => ({ x: Math.floor((p.x - ox) / cell), y: Math.floor((p.y - oy) / cell) });
  const byId = new Map(layout.rooms.map((r) => [r.id, r]));

  const nearestCorridor = (p: Point) => {
    const c = toCell(p);
    if (walkable(c.x, c.y)) return c;
    let best = layout.entrance;
    let bestD = Infinity;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (walkable(x, y)) {
          const d = (x - c.x) ** 2 + (y - c.y) ** 2;
          if (d < bestD) [best, bestD] = [{ x, y }, d];
        }
    return best;
  };

  const cache = new Map<string, Point[]>();
  const corridorPath = (a: { x: number; y: number }, b: { x: number; y: number }): Point[] => {
    const key = `${a.x},${a.y}>${b.x},${b.y}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const prev = new Map<number, number>();
    const start = a.y * W + a.x;
    const goal = b.y * W + b.x;
    prev.set(start, -1);
    const queue = [start];
    for (let i = 0; i < queue.length && !prev.has(goal); i++) {
      const cur = queue[i]!;
      const cx = cur % W;
      const cy = Math.floor(cur / W);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        const k = ny * W + nx;
        if (!prev.has(k) && (walkable(nx, ny) || k === goal)) {
          prev.set(k, cur);
          queue.push(k);
        }
      }
    }
    const cells: Point[] = [];
    if (prev.has(goal)) for (let k = goal; k !== -1; k = prev.get(k)!) cells.unshift(centre({ x: k % W, y: Math.floor(k / W) }));
    else cells.push(centre(b));
    // Keep the corners only.
    const pts = cells.filter((p, i) => {
      const q = cells[i - 1];
      const r = cells[i + 1];
      return !q || !r || (q.x - p.x) * (r.y - p.y) !== (q.y - p.y) * (r.x - p.x);
    });
    cache.set(key, pts);
    return pts;
  };

  const areaAt = (p: Point): string | null => {
    const c = toCell(p);
    return inRoom(c.x, c.y)?.id ?? null;
  };

  const route = (from: Point, fromArea: string | null, to: Point, toArea: string | null): Point[] => {
    if (fromArea !== null && fromArea === toArea) return [to];
    const a = fromArea ? byId.get(fromArea) : undefined;
    const b = toArea ? byId.get(toArea) : undefined;
    const pts: Point[] = [];
    if (a) pts.push(centre(a.door));
    pts.push(...corridorPath(a ? a.access : nearestCorridor(from), b ? b.access : nearestCorridor(to)));
    if (b) pts.push(centre(b.door));
    pts.push(to);
    return pts;
  };

  // The entrance: a corridor cell on the footprint edge; people come from the outside neighbour.
  const e = layout.entrance;
  const out = ([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).find(([dx, dy]) => layout.footprint[e.y + dy]?.[e.x + dx] !== '#') ?? [0, 1];
  const entrance: Door = { outside: centre({ x: e.x + out[0] * 2, y: e.y + out[1] * 2 }), inside: centre(e), area: null };
  const openings = layout.rooms.map((r) => {
    const d = centre(r.door);
    const acc = centre(r.access);
    return { area: r.id, x: (d.x + acc.x) / 2, y: (d.y + acc.y) / 2, width: cell * 0.8 };
  });
  return { areaAt, route, doors: { entrance, ambulance: entrance, staff: entrance, ward: entrance }, openings };
}
