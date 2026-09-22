/**
 * Floor plan (layout module): rooms on a grid inside a footprint, and walking
 * distances between them along corridors (shortest path, 4-connected).
 *
 * Coordinates are cells: x = column, y = row, (0, 0) top-left. A room occupies
 * the rectangle [x, x + w) × [y, y + h). Corridors are footprint cells outside
 * every room. Each room is entered from an "access" corridor cell next to its
 * edge; if the config gives no door, the access cell closest to the entrance is used.
 */

export const ROOM_TYPES = ['waiting', 'triage', 'acute', 'fastTrack', 'station', 'imaging', 'lab'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export interface Cell {
  x: number;
  y: number;
}

export interface RoomSpec {
  id: string;
  type: RoomType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Beds (acute, fastTrack) or stations (triage). Default from area. */
  capacity?: number;
  /** A cell on the room's edge that opens to a corridor. Default: nearest to the entrance. */
  door?: Cell;
}

export const FOOTPRINT_PRESETS = ['rectangle', 'lShape', 'uShape', 'narrow'] as const;
export type FootprintPreset = (typeof FOOTPRINT_PRESETS)[number];

export interface LayoutSpec {
  /** Rows of '#' (inside) and '.' (outside), or a preset shape. */
  footprint: string[] | { preset: FootprintPreset; width: number; height: number };
  entrance: Cell;
  rooms: RoomSpec[];
}

export interface ResolvedRoom extends Required<Omit<RoomSpec, 'door'>> {
  door: Cell;
  /** Corridor cell just outside the door. */
  access: Cell;
}

export interface ResolvedLayout {
  width: number;
  height: number;
  footprint: string[];
  entrance: Cell;
  rooms: ResolvedRoom[];
  /** Walking distance in cells between locations: index 0 = entrance, i + 1 = rooms[i]. */
  dist: number[][];
}

/** Cells per bed or triage station when a room gives no capacity. */
const CELLS_PER_BED = 4;

export function defaultCapacity(type: RoomType, w: number, h: number): number {
  switch (type) {
    case 'acute':
    case 'fastTrack':
      return Math.max(1, Math.floor((w * h) / CELLS_PER_BED));
    case 'triage':
    case 'imaging':
    case 'lab':
      return Math.max(1, Math.floor((w * h) / 6));
    default:
      return 0;
  }
}

export function footprintPreset(preset: FootprintPreset, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      let inside = true;
      if (preset === 'lShape') inside = !(x >= Math.ceil(width / 2) && y < Math.floor(height / 2));
      if (preset === 'uShape') inside = !(x >= Math.floor(width / 3) && x < Math.ceil((2 * width) / 3) && y < Math.floor(height / 2));
      if (preset === 'narrow') inside = y >= Math.floor(height / 3) && y < Math.floor(height / 3) + Math.max(4, Math.ceil(height / 3));
      row += inside ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const isCell = (x: unknown): x is Cell => isObj(x) && isInt(x.x) && isInt(x.y);

/** Shape checks on raw JSON. */
export function checkLayoutShape(raw: unknown, path = 'layout'): string[] {
  if (!isObj(raw)) return [`${path}: must be { footprint, entrance, rooms }`];
  const p: string[] = [];
  const fp = raw.footprint;
  if (Array.isArray(fp)) {
    if (fp.length === 0 || !fp.every((r) => typeof r === 'string' && /^[#.]+$/.test(r) && r.length === (fp[0] as string).length))
      p.push(`${path}.footprint: equal-length rows of '#' and '.'`);
  } else if (!(isObj(fp) && (FOOTPRINT_PRESETS as readonly unknown[]).includes(fp.preset) && isInt(fp.width) && isInt(fp.height) && fp.width >= 4 && fp.height >= 4 && fp.width <= 80 && fp.height <= 80))
    p.push(`${path}.footprint: rows, or { preset: ${FOOTPRINT_PRESETS.join('|')}, width: 4..80, height: 4..80 }`);
  if (!isCell(raw.entrance)) p.push(`${path}.entrance: { x, y }`);
  if (!Array.isArray(raw.rooms)) p.push(`${path}.rooms: array`);
  else
    raw.rooms.forEach((r, i) => {
      const rp = `${path}.rooms[${i}]`;
      if (!isObj(r)) return p.push(`${rp}: must be an object`);
      if (typeof r.id !== 'string' || !r.id) p.push(`${rp}.id: required string`);
      if (!(ROOM_TYPES as readonly unknown[]).includes(r.type)) p.push(`${rp}.type: one of ${ROOM_TYPES.join(', ')}`);
      for (const k of ['x', 'y', 'w', 'h']) if (!isInt(r[k]) || (r[k] as number) < (k === 'w' || k === 'h' ? 1 : 0)) p.push(`${rp}.${k}: ${k === 'w' || k === 'h' ? 'positive' : 'non-negative'} integer`);
      if (r.capacity !== undefined && !(isInt(r.capacity) && r.capacity >= 0)) p.push(`${rp}.capacity: non-negative integer`);
      if (r.door !== undefined && !isCell(r.door)) p.push(`${rp}.door: { x, y }`);
    });
  return p;
}

/** Resolve footprint, doors and distances. Returns problems instead of throwing so editors can show them. */
export function resolveLayout(spec: LayoutSpec): { layout?: ResolvedLayout; problems: string[] } {
  const p: string[] = [];
  const footprint = Array.isArray(spec.footprint) ? [...spec.footprint] : footprintPreset(spec.footprint.preset, spec.footprint.width, spec.footprint.height);
  const height = footprint.length;
  const width = footprint[0]?.length ?? 0;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && footprint[y]![x] === '#';

  const owner: number[][] = Array.from({ length: height }, () => Array(width).fill(-1));
  const ids = new Set<string>();
  spec.rooms.forEach((r, i) => {
    if (ids.has(r.id)) p.push(`layout.rooms: duplicate id '${r.id}'`);
    ids.add(r.id);
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!inside(x, y)) {
          p.push(`${r.id}: extends outside the footprint at (${x}, ${y})`);
          return;
        }
        if (owner[y]![x] !== -1) {
          p.push(`${r.id}: overlaps ${spec.rooms[owner[y]![x]!]!.id}`);
          return;
        }
        owner[y]![x] = i;
      }
  });
  const corridor = (x: number, y: number) => inside(x, y) && owner[y]![x] === -1;
  const e = spec.entrance;
  if (!corridor(e.x, e.y)) p.push('entrance: must be a footprint cell outside every room');
  if (p.length) return { problems: p };

  const bfs = (from: Cell): number[][] => {
    const d = Array.from({ length: height }, () => Array(width).fill(Infinity));
    d[from.y]![from.x] = 0;
    const q: Cell[] = [from];
    for (let h = 0; h < q.length; h++) {
      const c = q[h]!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (corridor(nx, ny) && d[ny]![nx] === Infinity) {
          d[ny]![nx] = d[c.y]![c.x]! + 1;
          q.push({ x: nx, y: ny });
        }
      }
    }
    return d;
  };
  const fromEntrance = bfs(e);

  const rooms: ResolvedRoom[] = [];
  for (const r of spec.rooms) {
    // Candidate doors: edge cells with a corridor neighbour outside the room.
    const candidates: { door: Cell; access: Cell }[] = [];
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const edge = x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1;
        if (!edge) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          if (corridor(x + dx, y + dy)) candidates.push({ door: { x, y }, access: { x: x + dx, y: y + dy } });
      }
    let pick: { door: Cell; access: Cell } | undefined;
    if (r.door) {
      pick = candidates.filter((c) => c.door.x === r.door!.x && c.door.y === r.door!.y).sort((a, b) => fromEntrance[a.access.y]![a.access.x]! - fromEntrance[b.access.y]![b.access.x]!)[0];
      if (!pick) p.push(`${r.id}: door (${r.door.x}, ${r.door.y}) does not open onto a corridor`);
    } else {
      pick = [...candidates].sort((a, b) => fromEntrance[a.access.y]![a.access.x]! - fromEntrance[b.access.y]![b.access.x]! || a.door.y - b.door.y || a.door.x - b.door.x)[0];
      if (!pick) p.push(`${r.id}: no corridor next to it, so nobody can get in`);
    }
    if (pick && !Number.isFinite(fromEntrance[pick.access.y]![pick.access.x]!)) p.push(`${r.id}: cannot be reached from the entrance`);
    if (pick) rooms.push({ id: r.id, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, capacity: r.capacity ?? defaultCapacity(r.type, r.w, r.h), door: pick.door, access: pick.access });
  }
  if (p.length) return { problems: p };

  // Distances between locations: entrance, then rooms (door to door, +1 cell to step in, +1 to step out).
  const points: Cell[] = [e, ...rooms.map((r) => r.access)];
  const dist = points.map((a, i) => {
    const d = bfs(a);
    return points.map((b, j) => (i === j ? 0 : d[b.y]![b.x]! + (i > 0 ? 1 : 0) + (j > 0 ? 1 : 0)));
  });
  return { layout: { width, height, footprint, entrance: e, rooms, dist }, problems: [] };
}

/** Requirements when the layout drives the simulation. */
export function checkLayoutForSim(l: ResolvedLayout, needsTriage: boolean): string[] {
  const p: string[] = [];
  const has = (t: RoomType) => l.rooms.some((r) => r.type === t);
  if (!has('waiting')) p.push('layout: needs a waiting room');
  if (needsTriage && !has('triage')) p.push('layout: needs a triage room');
  if (!l.rooms.some((r) => r.type === 'acute' && r.capacity > 0)) p.push('layout: needs at least one acute room with beds');
  return p;
}

/** A sensible starting plan, used by the editor and the layout-only sandbox preset. */
export function exampleLayout(): LayoutSpec {
  return {
    footprint: { preset: 'rectangle', width: 24, height: 14 },
    entrance: { x: 0, y: 7 },
    rooms: [
      { id: 'waiting', type: 'waiting', x: 1, y: 1, w: 6, h: 5 },
      { id: 'triage', type: 'triage', x: 1, y: 9, w: 4, h: 3 },
      { id: 'station', type: 'station', x: 10, y: 6, w: 3, h: 2 },
      { id: 'acute-a', type: 'acute', x: 9, y: 1, w: 7, h: 4 },
      { id: 'acute-b', type: 'acute', x: 9, y: 9, w: 7, h: 4 },
      { id: 'fast', type: 'fastTrack', x: 18, y: 1, w: 5, h: 5 },
    ],
  };
}
