/**
 * Pure layout of the top-down view: where each area, bed, staff member and
 * patient dot goes for a given snapshot and canvas size. No drawing, no sim logic.
 */
import type { Acuity, Lane, Role, SimSnapshot } from '@er/sim';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AreaId = 'waiting' | 'triage' | 'main' | 'fastTrack';

export interface Area extends Rect {
  /** Area id, or a room id in grid (layout) view. */
  id: string;
  label: string;
  /** Room type in grid view (for colouring). */
  kind?: string;
}

export interface BedMark extends Rect {
  lane: Lane;
  index: number;
  occupied: boolean;
}

export interface StaffMark {
  id: number;
  role: Role;
  x: number;
  y: number;
  busy: boolean;
  leaving: boolean;
  /** 0..1+ (burnout module). */
  fatigue: number;
  /** Area (or room) the mark stands in. */
  area: string;
  patientId?: number;
}

export interface PatientDot {
  id: number;
  x: number;
  y: number;
  /** What the player knows: undefined until triaged. */
  acuity?: Acuity;
  /** Minutes since arrival. */
  waited: number;
  boarding: boolean;
  /** Arrived by ambulance in a mass-casualty event, or came back after discharge. */
  special: 'massCasualty' | 'bounceBack' | null;
  /** Area (or room) the dot is in. */
  area: string;
  /** Lying in a bed (rather than waiting or with the triage nurse). */
  inBed: boolean;
}

/** A way in or out of the building: people appear at `outside` and walk in through `inside`. */
export interface Door {
  outside: Point;
  inside: Point;
  /** Area `inside` is in, or null for a corridor. */
  area: string | null;
}

/**
 * Walking routes for animation only (the sim has already decided where everyone is).
 * Areas are area or room ids; null means a corridor.
 */
export interface Nav {
  areaAt(p: Point): string | null;
  /** Waypoints from `from` to `to`, ending at `to`. */
  route(from: Point, fromArea: string | null, to: Point, toArea: string | null): Point[];
  doors: { entrance: Door; ambulance: Door; staff: Door; ward: Door };
  /** Gaps in room walls: a point on the wall and the gap's width. */
  openings: { area: string; x: number; y: number; width: number }[];
}

export interface WaitingLine {
  label: string;
  y: number;
}

export interface FloorPlan {
  /** Grid view (layout module): footprint cells to draw under the rooms. */
  grid?: { cells: Rect[]; entrance: Rect; cell: number };
  areas: Area[];
  beds: BedMark[];
  staff: StaffMark[];
  patients: PatientDot[];
  waitingLines: WaitingLine[];
  nav: Nav;
  /** Waiting-room chairs (default view). */
  seats: Point[];
}

const PAD = 12;
const DOT = 20; // grid spacing for waiting dots
const BED_W = 38;
const BED_H = 28;

export function layoutFloor(s: SimSnapshot, width: number, height: number, showFastTrack: boolean, opts: { corridor?: number; staffBesideBed?: boolean } = {}): FloorPlan {
  const gap = opts.corridor ?? PAD;
  const waitW = Math.round(width * 0.32);
  const rightX = waitW + gap;
  const rightW = width - rightX;
  const triageH = Math.round(height * 0.2);
  const ftH = showFastTrack ? Math.round(height * 0.26) : 0;
  const mainH = height - triageH - ftH - (showFastTrack ? 2 * PAD : PAD);

  const areas: Area[] = [
    { id: 'waiting', label: 'Waiting room', x: 0, y: 0, w: waitW, h: height },
    { id: 'triage', label: 'Triage', x: rightX, y: 0, w: rightW, h: triageH },
    { id: 'main', label: 'Main ED', x: rightX, y: triageH + PAD, w: rightW, h: mainH },
  ];
  if (showFastTrack) areas.push({ id: 'fastTrack', label: 'Fast track', x: rightX, y: height - ftH, w: rightW, h: ftH });
  const area = (id: AreaId) => areas.find((a) => a.id === id);

  // Beds: a grid in each treatment area, under a strip where free staff wait.
  const beds: BedMark[] = [];
  const bedPos = new Map<string, { x: number; y: number }>();
  const besidePos = new Map<string, Point>();
  for (const lane of ['main', 'fastTrack'] as const) {
    const a = area(lane);
    if (!a) continue;
    const info = s.beds[lane];
    const used = s.patients.filter((p) => p.location === 'bed' && p.lane === lane).map((p) => p.bed ?? 0);
    const count = info.capacity ?? Math.max(12, ...used.map((b) => b + 1));
    const top = a.y + 58;
    // Size beds to fill the room: try every column count, keep the one giving the biggest bed.
    const availW = a.w - 2 * PAD;
    const availH = a.h - (top - a.y) - PAD;
    let best = { cols: 1, bw: BED_W, bh: BED_H };
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      const bw = Math.min(64, availW / cols - 12, ((availH / rows - 12) * BED_W) / BED_H);
      if (bw > best.bw || cols === 1) best = { cols, bw: Math.max(bw, 22), bh: (Math.max(bw, 22) * BED_H) / BED_W };
    }
    const { cols, bw, bh } = best;
    const rows = Math.max(1, Math.floor((availH + 12) / (bh + 12)));
    const shown = Math.min(count, cols * rows);
    for (let i = 0; i < shown; i++) {
      const x = a.x + PAD + (i % cols) * (bw + 12);
      const y = top + Math.floor(i / cols) * (bh + 12);
      beds.push({ lane, index: i, x, y, w: bw, h: bh, occupied: used.includes(i) });
      bedPos.set(`${lane}:${i}`, { x: x + bw * 0.58, y: y + bh / 2 });
      if (opts.staffBesideBed) besidePos.set(`${lane}:${i}`, { x: x + bw + 6, y: y + bh / 2 });
    }
  }

  // Waiting room: longest-waiting first, one block per line.
  const waiting = area('waiting')!;
  const lineDefs: { label: string; match: (w: string | undefined) => boolean }[] = [
    { label: 'Waiting for triage', match: (w) => w === 'triage' || w === 'registration' },
    { label: 'Waiting for a bed', match: (w) => w === 'bed' },
    { label: 'Other waits', match: (w) => w !== 'triage' && w !== 'registration' && w !== 'bed' },
  ];
  const lineH = (waiting.h - 30) / lineDefs.length;
  const perRow = Math.max(1, Math.floor((waiting.w - 2 * PAD) / DOT));
  const patients: PatientDot[] = [];
  const waitingLines: WaitingLine[] = [];
  const seats: Point[] = [];
  const dot = (p: SimSnapshot['patients'][number], x: number, y: number, area: AreaId): PatientDot => ({
    id: p.id,
    x,
    y,
    acuity: p.assignedAcuity,
    waited: s.now - p.arrivalTime,
    boarding: p.boarding,
    special: p.source === 'walkIn' ? null : p.source,
    area,
    inBed: p.location === 'bed',
  });
  const inRoom = s.patients.filter((p) => p.location === 'waiting');
  lineDefs.forEach((line, li) => {
    const top = waiting.y + 30 + li * lineH;
    waitingLines.push({ label: line.label, y: top + 12 });
    const queued = inRoom.filter((p) => line.match(p.waitingFor)).sort((a, b) => a.arrivalTime - b.arrivalTime);
    const maxRows = Math.max(1, Math.floor((lineH - 24) / DOT));
    for (let i = 0; i < perRow * maxRows; i++) seats.push({ x: waiting.x + PAD + (i % perRow) * DOT + DOT / 2, y: top + 18 + Math.floor(i / perRow) * DOT + DOT / 2 });
    queued.forEach((p, i) => {
      const idx = Math.min(i, perRow * maxRows - 1); // overflow piles on the last slot
      patients.push(dot(p, waiting.x + PAD + (idx % perRow) * DOT + DOT / 2, top + 18 + Math.floor(idx / perRow) * DOT + DOT / 2, 'waiting'));
    });
  });

  // Patients in beds sit on their bed; intake (triage) patients sit beside their nurse.
  const triageArea = area('triage')!;
  const nurses = s.staff.filter((m) => m.role === 'triageNurse');
  const nursePos = new Map<number, { x: number; y: number }>();
  nurses.forEach((m, i) => nursePos.set(m.id, { x: triageArea.x + PAD + 16 + i * 64, y: triageArea.y + 40 }));
  for (const p of s.patients) {
    if (p.location === 'bed') {
      const pos = bedPos.get(`${p.lane}:${p.bed}`);
      if (pos) patients.push(dot(p, pos.x, pos.y, p.lane === 'fastTrack' && area('fastTrack') ? 'fastTrack' : 'main'));
    } else if (p.location === 'intake') {
      const nurse = p.staffIds.map((id) => nursePos.get(id)).find(Boolean);
      const pos = nurse ?? { x: triageArea.x + triageArea.w - 30, y: triageArea.y + 40 };
      patients.push(dot(p, pos.x + 22, pos.y, 'triage'));
    }
  }

  // Staff: at their patient's bed when busy there, otherwise in a strip at the top of their area.
  const staff: StaffMark[] = [];
  const roleArea: Record<Role, AreaId> = { triageNurse: 'triage', doctor: 'main', fastTrackClinician: 'fastTrack', nurse: 'main', tech: 'main' };
  const stripCount = new Map<AreaId, number>();
  for (const m of s.staff) {
    const mark = { id: m.id, role: m.role, busy: m.busy, leaving: m.retiring, fatigue: m.fatigue, patientId: m.patientId };
    if (m.role === 'triageNurse') {
      const pos = nursePos.get(m.id)!;
      staff.push({ ...mark, ...pos, area: 'triage' });
      continue;
    }
    const patient = m.patientId === undefined ? undefined : s.patients.find((p) => p.id === m.patientId);
    const pos = patient?.location === 'bed' ? bedPos.get(`${patient.lane}:${patient.bed}`) : undefined;
    if (pos) {
      const beside = besidePos.get(`${patient!.lane}:${patient!.bed}`);
      staff.push({ ...mark, ...(beside ?? { x: pos.x + 14, y: pos.y - 12 }), area: patient!.lane === 'fastTrack' && area('fastTrack') ? 'fastTrack' : 'main' });
      continue;
    }
    const aid = area(roleArea[m.role]) ? roleArea[m.role] : 'main';
    const a = area(aid)!;
    const n = stripCount.get(aid) ?? 0;
    stripCount.set(aid, n + 1);
    staff.push({ ...mark, x: a.x + PAD + 8 + n * 22, y: a.y + 38, area: aid });
  }

  return { areas, beds, staff, patients, waitingLines, seats, nav: defaultNav(areas, beds, width, height, waitW, gap) };
}

/**
 * Routes on the default floor: the waiting room on the left, the other areas on the right,
 * a corridor between them. Each right-hand area has one door onto the corridor; the waiting
 * room has one opposite each of them. Inside a treatment area people keep to the aisles.
 */
function defaultNav(areas: Area[], beds: BedMark[], width: number, height: number, waitW: number, gap: number): Nav {
  const corrX = waitW + gap / 2;
  const byId = new Map(areas.map((a) => [a.id, a]));
  const right = areas.filter((a) => a.id !== 'waiting');
  const doorOf = new Map<string, Point>(right.map((a) => [a.id, { x: a.x, y: a.y + (a.id === 'main' ? Math.min(a.h / 2, 46) : a.h / 2) }]));
  const waitDoors = right.map((a) => ({ x: waitW, y: Math.min(height - 20, doorOf.get(a.id)!.y) }));
  const door = (id: string, towardY: number): Point =>
    id === 'waiting' ? waitDoors.reduce((b, d) => (Math.abs(d.y - towardY) < Math.abs(b.y - towardY) ? d : b)) : doorOf.get(id)!;

  // Inside an area with beds: from the door, along the left margin to the aisle, then down the gap beside the bed.
  const inside = (id: string, doorPt: Point, to: Point): Point[] => {
    const a = byId.get(id);
    if (!a || id === 'waiting' || id === 'triage') return [];
    const aisleY = a.y + 46;
    const bed = beds.find((b) => to.x >= b.x && to.x <= b.x + b.w && to.y >= b.y && to.y <= b.y + b.h);
    const laneX = a.x + PAD / 2;
    if (!bed) return [{ x: laneX, y: doorPt.y }, { x: laneX, y: aisleY }, { x: to.x, y: aisleY }];
    const gapX = bed.x - 6;
    return [{ x: laneX, y: doorPt.y }, { x: laneX, y: aisleY }, { x: gapX, y: aisleY }, { x: gapX, y: to.y }];
  };

  const areaAt = (p: Point): string | null => {
    const hit = areas.find((a) => p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h);
    return hit ? hit.id : null;
  };

  const route = (from: Point, fromArea: string | null, to: Point, toArea: string | null): Point[] => {
    if (fromArea !== null && fromArea === toArea) {
      // Same room: in a treatment area, back out to the aisle first.
      const a = byId.get(fromArea)!;
      if (fromArea === 'main' || fromArea === 'fastTrack') {
        const out = inside(fromArea, from, from).slice(2).reverse();
        const back = out.length ? out : [{ x: from.x, y: a.y + 46 }];
        return [...back, ...inside(fromArea, from, to).slice(2), to];
      }
      return [to];
    }
    const pts: Point[] = [];
    const toDoor = toArea ? door(toArea, fromArea ? door(fromArea, to.y).y : from.y) : null;
    if (fromArea) {
      const d = door(fromArea, toDoor?.y ?? to.y);
      pts.push(...inside(fromArea, d, from).reverse(), d, { x: corrX, y: d.y });
    } else pts.push({ x: corrX, y: from.y });
    if (toArea && toDoor) {
      pts.push({ x: corrX, y: toDoor.y }, toDoor, ...inside(toArea, toDoor, to));
    } else pts.push({ x: corrX, y: to.y });
    pts.push(to);
    return pts;
  };

  const main = byId.get('main')!;
  const waiting = byId.get('waiting')!;
  const entrance: Door = { outside: { x: waitW / 2, y: height + 40 }, inside: { x: waitW / 2, y: height - 8 }, area: 'waiting' };
  const side = (y: number): Door => ({ outside: { x: width + 40, y }, inside: { x: width - 10, y }, area: 'main' });
  const openings: Nav['openings'] = [
    ...right.map((a) => ({ area: a.id, ...doorOf.get(a.id)!, width: 34 })),
    ...waitDoors.map((d) => ({ area: 'waiting', ...d, width: 34 })),
    { area: 'waiting', x: waiting.x + waitW / 2, y: waiting.y + waiting.h, width: 44 },
    { area: 'main', x: width, y: main.y + 46, width: 34 },
    { area: 'main', x: width, y: main.y + main.h - 24, width: 34 },
  ];
  return {
    areaAt,
    route,
    // Ambulances and staff use the side door; admitted patients leave by the ward corridor at the top.
    doors: { entrance, ambulance: side(main.y + main.h - 24), staff: side(main.y + main.h - 24), ward: side(main.y + 46) },
    openings,
  };
}
