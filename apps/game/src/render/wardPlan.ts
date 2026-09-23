/**
 * The 3D view's floor when the layout module is off: laid out like a real department. Cubicles
 * line the walls of the main ED with their heads to the wall and a staff island in the aisle;
 * trauma rooms sit by the ambulance door; triage has booths; fast track has recliners.
 * Pure: a snapshot in, a FloorPlan out (20 units per metre). No sim logic.
 */
import type { SimSnapshot } from '@er/sim';
import type { Area, Bay, BedMark, Door, FloorPlan, Nav, PatientDot, Point, Prop, StaffMark } from './floorPlan';

/** Plan units per metre. */
export const WARD_UNITS_PER_METRE = 20;

const PAD = 12;
const GAP = 40; // corridor between the waiting room and the treatment areas
const WAIT_W = 280;
const TRIAGE_H = 130;
const BOOTH_W = 100;
const BAY_D = 76; // cubicle depth
const BAY_W = 62; // preferred cubicle width
const TRAUMA_W = 140;
const AISLE = 200;
const FT_H = 170;
const FT_BAY_D = 66;
const FT_BAY_W = 54;
const STATION_H = 84;
const COUNTER_D = 13;
const BED_W = 22;
const BED_L = 42;

const NORTH = Math.PI; // facing away from the camera
const SOUTH = 0;

type P = SimSnapshot['patients'][number];

export function layoutWard(s: SimSnapshot, showFastTrack: boolean): FloorPlan {
  // How many of each thing to draw.
  const usedMax = (lane: 'main' | 'fastTrack') => Math.max(-1, ...s.patients.filter((p) => p.lane === lane && p.bed !== undefined).map((p) => p.bed!));
  const mainCount = s.beds.main.capacity ?? Math.max(12, usedMax('main') + 1);
  const K = Math.min(s.beds.main.traumaBays, mainCount);
  const regular = mainCount - K;
  const perRow = Math.max(1, Math.ceil(regular / 2));
  const traumaCols = Math.ceil(K / 2);
  const ftCount = showFastTrack ? (s.beds.fastTrack.capacity ?? Math.max(6, usedMax('fastTrack') + 1)) : 0;
  const nurses = s.staff.filter((m) => m.role === 'triageNurse');
  const booths = Math.max(2, nurses.length);

  const rightW = Math.max(
    600,
    2 * PAD + traumaCols * TRAUMA_W + perRow * BAY_W + 40,
    2 * PAD + ftCount * FT_BAY_W + 180,
    2 * PAD + booths * BOOTH_W + 120,
  );
  const width = WAIT_W + GAP + rightW;
  const mainH = 2 * BAY_D + AISLE;
  const height = TRIAGE_H + PAD + mainH + (showFastTrack ? PAD + FT_H : 0);
  const rx = WAIT_W + GAP;
  const corrX = WAIT_W + GAP / 2;

  const waiting: Area = { id: 'waiting', label: 'Waiting room', x: 0, y: 0, w: WAIT_W, h: height };
  const triage: Area = { id: 'triage', label: 'Triage', x: rx, y: 0, w: rightW, h: TRIAGE_H };
  const main: Area = { id: 'main', label: 'Main ED', x: rx, y: TRIAGE_H + PAD, w: rightW, h: mainH };
  const ft: Area | null = showFastTrack ? { id: 'fastTrack', label: 'Fast track', x: rx, y: main.y + mainH + PAD, w: rightW, h: FT_H } : null;
  const areas = [waiting, triage, main, ...(ft ? [ft] : [])];

  const props: Prop[] = [];
  const bays: Bay[] = [];
  const beds: BedMark[] = [];
  const enclosures: NonNullable<FloorPlan['enclosures']> = [];
  const occupant = new Map<string, P>();
  for (const p of s.patients) if (p.location === 'bed' && p.lane && p.bed !== undefined) occupant.set(`${p.lane}:${p.bed}`, p);

  // ---- Main ED: trauma rooms at the ambulance end, cubicles along both long walls.
  const cy = main.y + mainH / 2;
  const topWalk = main.y + BAY_D + 30;
  const bottomWalk = main.y + mainH - BAY_D - 30;
  const regularSpan = rightW - 2 * PAD - traumaCols * TRAUMA_W - 40;
  const bayW = Math.min(90, regularSpan / perRow);
  /** Where each bed is: its cubicle, where the patient lies, and where a clinician stands. */
  const slot = new Map<string, { bay: Bay; lie: Point; head: 'up' | 'down' | 'left'; side: Point; recliner: boolean }>();
  const addBay = (lane: 'main' | 'fastTrack', index: number, kind: Bay['kind'], x: number, top: boolean, w: number, d: number, rowY: number, label?: string) => {
    const name = label ?? (lane === 'fastTrack' ? `FT ${index + 1}` : `Bay ${index - K + 1}`);
    const bay: Bay = { kind, lane, index, x, y: top ? rowY : rowY - d, w, h: d, front: top ? 'down' : 'up', label: name, attended: false };
    const p = occupant.get(`${lane}:${index}`);
    bay.attended = !!p && p.staffIds.length > 0;
    const cx = x + w / 2;
    if (kind === 'recliner') {
      // A recliner against the wall, facing the aisle.
      const seatY = bay.y + 20;
      beds.push({ lane, index, x: cx - 13, y: bay.y + 6, w: 26, h: 26, occupied: !!p, recliner: true, head: 'up' });
      slot.set(`${lane}:${index}`, { bay, lie: { x: cx, y: seatY }, head: 'up', side: { x: cx + 22, y: seatY + 6 }, recliner: true });
    } else {
      const bx = cx - BED_W / 2 - (kind === 'trauma' ? 0 : 8);
      const by = top ? bay.y + 6 : bay.y + d - 6 - BED_L;
      beds.push({ lane, index, x: bx, y: by, w: BED_W, h: BED_L, occupied: !!p, trauma: kind === 'trauma', head: top ? 'up' : 'down' });
      const lie = { x: bx + BED_W / 2, y: by + BED_L / 2 };
      slot.set(`${lane}:${index}`, { bay, lie, head: top ? 'up' : 'down', side: { x: bx + BED_W + 11, y: lie.y }, recliner: false });
    }
    bays.push(bay);
  };
  for (let k = 0; k < K; k++) {
    const col = Math.floor(k / 2);
    const top = k % 2 === 0;
    const x = main.x + main.w - PAD - (col + 1) * TRAUMA_W;
    addBay('main', k, 'trauma', x, top, TRAUMA_W - 8, BAY_D + 4, top ? main.y : main.y + mainH, `Trauma ${k + 1}`);
    const b = bays[bays.length - 1]!;
    const doorY = top ? b.y + b.h : b.y;
    enclosures.push({ x: b.x, y: b.y, w: b.w, h: b.h, kind: 'trauma', label: b.label!, openings: [{ x: b.x + b.w / 2, y: doorY, width: 56 }] });
  }
  for (let j = 0; j < regular; j++) {
    const top = j % 2 === 0;
    const col = Math.floor(j / 2);
    addBay('main', K + j, 'bay', main.x + PAD + 40 + col * bayW, top, bayW, BAY_D, top ? main.y : main.y + mainH);
  }
  // The nurses' station: a U of counters in the middle of the aisle, open at the end nearest the
  // door. Staff sit inside at workstations facing out towards the cubicles; the outer edge has a
  // raised ledge. The tracking board and the medicine cabinet stand at the closed end.
  const islandW = Math.min(220, Math.max(140, regularSpan * 0.42));
  const island = { x: main.x + PAD + 40 + regularSpan / 2 - islandW / 2, y: cy - STATION_H / 2, w: islandW, h: STATION_H };
  const T = COUNTER_D;
  const gap = 34;
  const side = (STATION_H - gap) / 2;
  for (const c of [
    { x: island.x, y: island.y, w: island.w, h: T, rot: NORTH }, // top run, ledge on the north side
    { x: island.x, y: island.y + island.h - T, w: island.w, h: T, rot: SOUTH },
    { x: island.x + island.w - T, y: island.y + T, w: T, h: island.h - 2 * T, rot: Math.PI / 2 }, // `rot` points outwards
    { x: island.x, y: island.y + T, w: T, h: side - T, rot: -Math.PI / 2 },
    { x: island.x, y: cy + gap / 2, w: T, h: side - T, rot: -Math.PI / 2 },
  ])
    props.push({ type: 'counter', x: c.x + c.w / 2, y: c.y + c.h / 2, w: c.w, h: c.h, rot: c.rot });
  const stationSpots: (Point & { face: number })[] = [];
  const perSide = Math.max(1, Math.floor((island.w - 80) / 36) + 1);
  for (let i = 0; i < perSide * 2; i++) {
    const topSide = i % 2 === 0;
    const x = island.x + 34 + Math.floor(i / 2) * 36;
    // Seated just inside the counter, facing out over it.
    stationSpots.push({ x, y: topSide ? island.y + T + 15 : island.y + island.h - T - 15, face: topSide ? NORTH : SOUTH });
  }
  for (const spot of stationSpots) {
    props.push({ type: 'officeChair', x: spot.x, y: spot.y, rot: spot.face });
    // A monitor and keyboard on the counter in front of each seat, facing the person sitting there.
    props.push({ type: 'workstation', x: spot.x, y: spot.face === NORTH ? island.y + T - 3 : island.y + island.h - T + 3, rot: spot.face === NORTH ? SOUTH : NORTH });
  }
  props.push({ type: 'printer', x: island.x + island.w - 26, y: island.y + T / 2 });
  props.push({ type: 'phone', x: island.x + 20, y: island.y + T / 2 }, { type: 'phone', x: island.x + 20, y: island.y + island.h - T / 2 });
  props.push({ type: 'pyxis', x: island.x + island.w - T - 14, y: cy + 12, rot: -Math.PI / 2 });
  // Angled so both the staff inside and the camera can read it.
  props.push({ type: 'board', x: island.x + island.w - T - 14, y: cy - 16, rot: -Math.PI / 2 + 0.6, w: 40 });
  props.push({ type: 'hangingSign', x: island.x + island.w / 2, y: cy, label: 'Nurses’ station' });

  // ---- Triage: booths with a desk, the nurse behind it and a chair for the patient.
  const walkT = triage.y + TRIAGE_H - 22;
  const boothX = (i: number) => triage.x + PAD + i * BOOTH_W;
  for (let i = 0; i < booths; i++) {
    const cx = boothX(i) + BOOTH_W / 2;
    props.push({ type: 'desk', x: cx, y: triage.y + 50, w: 58, h: 16 });
    props.push({ type: 'chair', x: cx, y: triage.y + 30, rot: SOUTH });
    props.push({ type: 'chair', x: cx, y: triage.y + 72, rot: NORTH });
    if (i < booths - 1) props.push({ type: 'partition', x: boothX(i + 1), y: triage.y + 45, w: 4, h: 90 });
  }
  const nurseSpot = (i: number) => ({ x: boothX(i) + BOOTH_W / 2, y: triage.y + 28 });
  const patientChair = (i: number) => ({ x: boothX(i) + BOOTH_W / 2, y: triage.y + 70 });
  const examSpot = (k: number) => ({ x: triage.x + triage.w - 50 - k * 44, y: triage.y + 70 });

  // ---- Fast track: recliners along the top wall, a clinicians' desk at the bottom.
  const walkF = ft ? ft.y + FT_BAY_D + 30 : 0;
  let ftDeskSpots: Point[] = [];
  if (ft) {
    for (let i = 0; i < ftCount; i++) addBay('fastTrack', i, 'recliner', ft.x + PAD + 40 + i * FT_BAY_W, true, FT_BAY_W, FT_BAY_D, ft.y);
    const desk = { x: ft.x + ft.w - 150, y: ft.y + FT_H - 36, w: 120, h: 20 };
    props.push({ type: 'desk', x: desk.x + desk.w / 2, y: desk.y + desk.h / 2, w: desk.w, h: desk.h });
    ftDeskSpots = [0, 1, 2, 3].map((i) => ({ x: desk.x + 18 + i * 28, y: desk.y - 13 }));
    for (const p of ftDeskSpots) props.push({ type: 'chair', x: p.x, y: p.y - 3, rot: SOUTH });
  }

  // ---- Waiting room: rows of chairs facing the camera side, reception by the door.
  const seats: Point[] = [];
  const seatCols = Math.floor((WAIT_W - 60) / 22);
  const seatRows = Math.floor((height - 220) / 40);
  for (let r = 0; r < seatRows; r++)
    for (let c = 0; c < seatCols; c++) {
      const aisleShift = c >= seatCols / 2 ? 20 : 0;
      seats.push({ x: 24 + c * 22 + aisleShift, y: 70 + r * 40 });
    }
  props.push({ type: 'reception', x: WAIT_W - 70, y: height - 70, w: 90, h: 22, label: 'Reception' });
  props.push({ type: 'plant', x: 18, y: 20 }, { type: 'plant', x: WAIT_W - 18, y: 20 }, { type: 'plant', x: 18, y: height - 20 });
  props.push({ type: 'vending', x: 16, y: height - 90, rot: Math.PI / 2 }, { type: 'vending', x: 16, y: height - 120, rot: Math.PI / 2 });
  props.push({ type: 'water', x: 16, y: height - 148, rot: Math.PI / 2 });

  // ---- Outside: road and ambulance bay on the right, parking below the entrance, trees.
  const ambulanceDoorY = cy;
  props.push({ type: 'road', x: width + 110, y: height / 2, w: 120, h: height + 400 });
  props.push({ type: 'ambulance', x: width + 90, y: ambulanceDoorY + 10, rot: NORTH });
  props.push({ type: 'parking', x: WAIT_W / 2 + 60, y: height + 150, w: 380, h: 140 });
  props.push({ type: 'sign', x: WAIT_W / 2, y: height + 2, label: 'EMERGENCY' });
  props.push({ type: 'elevator', x: corrX, y: 6, w: GAP + 8, label: 'To the wards' });
  for (const [x, y] of [
    [-60, 60],
    [-70, 260],
    [-60, height - 40],
    [WAIT_W + 150, height + 60],
    [width - 40, -60],
    [width / 2, -70],
    [WAIT_W / 2 - 40, -60],
  ] as const)
    props.push({ type: 'tree', x, y });

  // ---- People.
  const patients: PatientDot[] = [];
  const dot = (p: P, pos: Point, area: string | null, pose: PatientDot['pose'], face: number): PatientDot => ({
    id: p.id,
    x: pos.x,
    y: pos.y,
    acuity: p.assignedAcuity,
    waited: s.now - p.arrivalTime,
    boarding: p.boarding,
    special: p.source === 'walkIn' ? null : p.source,
    area: area ?? '',
    inBed: p.location === 'bed',
    pose,
    face,
    waitingFor: p.waitingFor,
  });
  const nurseBooth = new Map(nurses.map((m, i) => [m.id, i]));
  const staffPos = new Map<number, { pos: Point; area: string | null; face: number; pose: 'stand' | 'sit' }>();

  // Waiting patients keep a seat: each has a preferred seat and takes the next free one in id order.
  const taken = new Set<number>();
  let hallway = 0;
  let exam = 0;
  const waitingIds = s.patients.filter((p) => p.location === 'waiting').sort((a, b) => a.id - b.id);
  for (const p of waitingIds) {
    // Ambulance arrivals wait on trolleys in the corridor.
    if (p.source === 'massCasualty') {
      // Spaced for the trolley and the paramedic waiting with it.
      const places = Math.max(1, Math.floor((height - 120) / 62));
      patients.push(dot(p, { x: corrX, y: height - 70 - (hallway++ % places) * 62 }, null, 'lie', 0));
      continue;
    }
    let i = (p.id * 7919) % Math.max(1, seats.length);
    for (let n = 0; n < seats.length && taken.has(i); n++) i = (i + 1) % seats.length;
    if (seats.length && !taken.has(i)) {
      taken.add(i);
      patients.push(dot(p, seats[i]!, 'waiting', 'sit', SOUTH));
    } else {
      patients.push(dot(p, { x: 40 + (hallway % 8) * 24, y: height - 40 - Math.floor(hallway++ / 8) * 22 }, 'waiting', 'stand', SOUTH));
    }
  }
  for (const p of s.patients) {
    if (p.location === 'bed') {
      const sl = slot.get(`${p.lane}:${p.bed}`);
      if (!sl) continue;
      const head = sl.head === 'up' ? 0 : sl.head === 'down' ? Math.PI : Math.PI / 2;
      patients.push({ ...dot(p, sl.lie, p.lane === 'fastTrack' ? 'fastTrack' : 'main', sl.recliner ? 'sit' : 'lie', sl.recliner ? SOUTH : head), bedLabel: sl.bay.label });
      p.staffIds.forEach((id, k) => staffPos.set(id, { pos: { x: sl.side.x + k * 14, y: sl.side.y + (k ? 10 : 0) }, area: p.lane === 'fastTrack' ? 'fastTrack' : 'main', face: 0, pose: 'stand' }));
    } else if (p.location === 'intake') {
      const booth = p.staffIds.map((id) => nurseBooth.get(id)).find((b) => b !== undefined);
      if (booth !== undefined) {
        patients.push(dot(p, patientChair(booth), 'triage', 'sit', NORTH));
      } else {
        const spot = examSpot(exam++ % 4);
        patients.push(dot(p, spot, 'triage', 'sit', SOUTH));
        p.staffIds.forEach((id, k) => staffPos.set(id, { pos: { x: spot.x + 20 + k * 14, y: spot.y + 10 }, area: 'triage', face: 0, pose: 'stand' }));
      }
    }
  }

  const staff: StaffMark[] = [];
  let atStation = 0;
  let atFt = 0;
  for (const m of s.staff) {
    const mark = { id: m.id, role: m.role, busy: m.busy, leaving: m.retiring, fatigue: m.fatigue, patientId: m.patientId };
    const booth = nurseBooth.get(m.id);
    if (booth !== undefined) {
      staff.push({ ...mark, ...nurseSpot(booth), area: 'triage', pose: 'sit', face: SOUTH });
      continue;
    }
    const at = staffPos.get(m.id);
    if (at) {
      staff.push({ ...mark, ...at.pos, area: at.area ?? '', pose: at.pose, face: at.face });
      continue;
    }
    if (m.role === 'fastTrackClinician' && ft) {
      const spot = ftDeskSpots[atFt % ftDeskSpots.length]!;
      const extra = Math.floor(atFt++ / ftDeskSpots.length);
      staff.push({ ...mark, x: spot.x, y: spot.y - extra * 20, area: 'fastTrack', pose: extra ? 'stand' : 'sit', face: SOUTH });
      continue;
    }
    const spot = stationSpots[atStation];
    if (spot) staff.push({ ...mark, x: spot.x, y: spot.y, area: 'main', pose: 'sit', face: spot.face });
    else {
      const n = atStation - stationSpots.length;
      staff.push({ ...mark, x: island.x + island.w + 24 + (n % 4) * 20, y: cy - 20 + Math.floor(n / 4) * 20, area: 'main', pose: 'stand', face: -Math.PI / 2 });
    }
    atStation++;
  }

  const nav = wardNav({ waiting, triage, main, ft, height, width, corrX, cy, topWalk, bottomWalk, island, walkT, walkF, slot, boothX, ambulanceDoorY });
  return { areas, beds, staff, patients, waitingLines: [], seats, nav, bays, enclosures, props };
}

interface NavInput {
  waiting: Area;
  triage: Area;
  main: Area;
  ft: Area | null;
  width: number;
  height: number;
  corrX: number;
  cy: number;
  topWalk: number;
  bottomWalk: number;
  island: { x: number; y: number; w: number; h: number };
  walkT: number;
  walkF: number;
  slot: Map<string, { bay: Bay; side: Point }>;
  boothX: (i: number) => number;
  ambulanceDoorY: number;
}

function wardNav(n: NavInput): Nav {
  const { waiting, triage, main, ft, corrX } = n;
  const byId = new Map<string, Area>([waiting, triage, main, ...(ft ? [ft] : [])].map((a) => [a.id, a]));
  // Each treatment area has one door onto the corridor, level with its walkway.
  const doorY: Record<string, number> = { triage: n.walkT, main: n.cy, ...(ft ? { fastTrack: n.walkF } : {}) };
  const waitDoors = Object.values(doorY).map((y) => ({ x: waiting.w, y }));
  const door = (id: string, towardY: number): Point =>
    id === 'waiting' ? waitDoors.reduce((b, d) => (Math.abs(d.y - towardY) < Math.abs(b.y - towardY) ? d : b)) : { x: byId.get(id)!.x, y: doorY[id]! };
  const bays = [...n.slot.values()].map((s) => s.bay);
  const bayAt = (p: Point) => bays.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);

  /** How to reach `p` from its area's walkway: the point on the walkway, then the steps off it. */
  const fromWalk = (area: string, p: Point): { walk: Point; steps: Point[] } => {
    const a = byId.get(area)!;
    const isl = n.island;
    if (area === 'main' && p.x > isl.x && p.x < isl.x + isl.w && p.y > isl.y && p.y < isl.y + isl.h) {
      // Into the station through the open end, then along its middle to the seat.
      const outside = isl.x - 20;
      const mid = isl.y + isl.h / 2;
      return { walk: { x: outside, y: p.y < mid ? n.topWalk : n.bottomWalk }, steps: [{ x: outside, y: mid }, { x: isl.x + 22, y: mid }, { x: p.x, y: mid }, p] };
    }
    if (area === 'main' || area === 'fastTrack') {
      const bay = bayAt(p);
      const y = area === 'fastTrack' ? n.walkF : bay ? (bay.front === 'down' ? n.topWalk : n.bottomWalk) : p.y < n.cy ? n.topWalk : n.bottomWalk;
      if (bay) {
        const cx = bay.x + bay.w / 2;
        const frontY = bay.front === 'down' ? bay.y + bay.h + 6 : bay.y - 6;
        // In at the front of the cubicle, then up beside the bed rather than across it.
        return { walk: { x: cx, y }, steps: [{ x: cx, y: frontY }, { x: p.x, y: bay.front === 'down' ? Math.min(p.y + 14, frontY) : Math.max(p.y - 14, frontY) }, p] };
      }
      return { walk: { x: p.x, y }, steps: [p] };
    }
    if (area === 'triage') {
      // Nurses go round the right-hand end of their desk.
      if (p.y < a.y + 45) {
        const i = Math.max(0, Math.floor((p.x - a.x - PAD) / BOOTH_W));
        const lane = n.boothX(i) + BOOTH_W - 14;
        return { walk: { x: lane, y: n.walkT }, steps: [{ x: lane, y: p.y }, p] };
      }
      return { walk: { x: p.x, y: n.walkT }, steps: [p] };
    }
    return { walk: p, steps: [p] };
  };

  /** Along a walkway; in the main ED, round the island if changing sides. */
  const along = (area: string, a: Point, b: Point): Point[] => {
    if (area !== 'main' || a.y === b.y) return [b];
    const ends = [n.island.x - 24, n.island.x + n.island.w + 24];
    const end = ends.reduce((best, x) => (Math.abs(x - a.x) + Math.abs(x - b.x) < Math.abs(best - a.x) + Math.abs(best - b.x) ? x : best));
    return [{ x: end, y: a.y }, { x: end, y: b.y }, b];
  };

  const areaAt = (p: Point): string | null => {
    for (const a of byId.values()) if (p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h) return a.id;
    return null;
  };

  const route = (from: Point, fromArea: string | null, to: Point, toArea: string | null): Point[] => {
    if (fromArea === 'waiting' && toArea === 'waiting') return [to];
    if (fromArea !== null && fromArea === toArea) {
      const a = fromWalk(fromArea, from);
      const b = fromWalk(toArea, to);
      return [...a.steps.slice(0, -1).reverse(), a.walk, ...along(fromArea, a.walk, b.walk), ...b.steps];
    }
    const pts: Point[] = [];
    const target = toArea ? door(toArea, fromArea ? door(fromArea, to.y).y : from.y) : null;
    if (fromArea) {
      const d = door(fromArea, target?.y ?? to.y);
      if (fromArea !== 'waiting') {
        const a = fromWalk(fromArea, from);
        const lane = { x: d.x + 20, y: d.y };
        pts.push(...a.steps.slice(0, -1).reverse(), a.walk, ...along(fromArea, a.walk, { x: lane.x, y: fromArea === 'main' ? a.walk.y : lane.y }), { x: lane.x, y: lane.y });
      }
      pts.push(d, { x: corrX, y: d.y });
    } else pts.push({ x: corrX, y: from.y });
    if (toArea && target) {
      pts.push({ x: corrX, y: target.y }, target);
      if (toArea !== 'waiting') {
        const b = fromWalk(toArea, to);
        const lane = { x: target.x + 20, y: target.y };
        pts.push(lane, { x: lane.x, y: toArea === 'main' ? b.walk.y : lane.y }, b.walk, ...b.steps);
      } else pts.push(to);
    } else pts.push({ x: corrX, y: to.y }, to);
    return pts;
  };

  const side = (y: number): Door => ({ outside: { x: n.width + 70, y: y + 10 }, inside: { x: main.x + main.w - 10, y }, area: 'main' });
  const entrance: Door = { outside: { x: waiting.w / 2, y: n.height + 70 }, inside: { x: waiting.w / 2, y: n.height - 8 }, area: 'waiting' };
  const ward: Door = { outside: { x: corrX, y: -30 }, inside: { x: corrX, y: 16 }, area: null };
  const openings: Nav['openings'] = [
    ...Object.entries(doorY).map(([area, y]) => ({ area, x: byId.get(area)!.x, y, width: 36 })),
    ...waitDoors.map((d) => ({ area: 'waiting', ...d, width: 36 })),
    { area: 'waiting', x: waiting.w / 2, y: n.height, width: 50 },
    { area: 'main', x: main.x + main.w, y: n.ambulanceDoorY, width: 50 },
  ];
  return { areaAt, route, doors: { entrance, ambulance: side(n.ambulanceDoorY), staff: side(n.ambulanceDoorY), ward }, openings };
}
