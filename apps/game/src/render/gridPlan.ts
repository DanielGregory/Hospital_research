/**
 * Pure layout of the grid (floor-plan) view used when the layout module is on:
 * rooms where the player drew them, beds inside acute and fast-track rooms,
 * patients and staff placed in the room they are in.
 */
import type { ResolvedLayout, SimSnapshot } from '@er/sim';
import type { Area, BedMark, FloorPlan, PatientDot, Rect, StaffMark } from './floorPlan';

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
    const base = { id: p.id, acuity: p.assignedAcuity, waited: s.now - p.arrivalTime, boarding: p.boarding, special: p.source === 'walkIn' ? null : p.source };
    if (p.location === 'bed') {
      const c = bedCentre.get(`${p.lane}:${p.bed}`);
      if (c) patients.push({ ...base, ...c });
    } else if (p.location === 'intake') patients.push({ ...base, ...cluster(firstOf('triage')?.id, intakeIdx++) });
    else patients.push({ ...base, ...cluster(firstOf('waiting')?.id, waitingIdx++) });
  }

  // Staff: next to their patient when busy, otherwise at their home room.
  const staff: StaffMark[] = [];
  const homeCount = new Map<string, number>();
  for (const m of s.staff) {
    const mark = { id: m.id, role: m.role, busy: m.busy, leaving: m.retiring, fatigue: m.fatigue };
    const patient = m.patientId === undefined ? undefined : patients.find((p) => p.id === m.patientId);
    if (patient) {
      staff.push({ ...mark, x: patient.x + 13, y: patient.y - 11 });
      continue;
    }
    const home = m.room ?? firstOf('station')?.id;
    const a = home ? roomRect.get(home) : undefined;
    const n = homeCount.get(home ?? '') ?? 0;
    homeCount.set(home ?? '', n + 1);
    const per = Math.max(1, Math.floor(((a?.w ?? 60) - 10) / 19));
    staff.push({ ...mark, x: (a?.x ?? ox) + 12 + (n % per) * 19, y: (a?.y ?? oy) + (a ? a.h - 12 : 0) - Math.floor(n / per) * 19 });
  }

  return { grid: { cells, entrance: rect(layout.entrance.x, layout.entrance.y), cell }, areas, beds, staff, patients, waitingLines: [] };
}
