/**
 * Pure layout of the top-down view: where each area, bed, staff member and
 * patient dot goes for a given snapshot and canvas size. No drawing, no sim logic.
 */
import type { Acuity, Lane, Role, SimSnapshot } from '@er/sim';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AreaId = 'waiting' | 'triage' | 'main' | 'fastTrack';

export interface Area extends Rect {
  id: AreaId;
  label: string;
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
}

export interface WaitingLine {
  label: string;
  y: number;
}

export interface FloorPlan {
  areas: Area[];
  beds: BedMark[];
  staff: StaffMark[];
  patients: PatientDot[];
  waitingLines: WaitingLine[];
}

const PAD = 12;
const DOT = 14; // grid spacing for waiting dots
const BED_W = 34;
const BED_H = 24;

export function layoutFloor(s: SimSnapshot, width: number, height: number, showFastTrack: boolean): FloorPlan {
  const waitW = Math.round(width * 0.32);
  const rightX = waitW + PAD;
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
  for (const lane of ['main', 'fastTrack'] as const) {
    const a = area(lane);
    if (!a) continue;
    const info = s.beds[lane];
    const used = s.patients.filter((p) => p.location === 'bed' && p.lane === lane).map((p) => p.bed ?? 0);
    const count = info.capacity ?? Math.max(12, ...used.map((b) => b + 1));
    const top = a.y + 58;
    const cols = Math.max(1, Math.floor((a.w - 2 * PAD) / (BED_W + 10)));
    const rows = Math.max(1, Math.floor((a.h - (top - a.y) - PAD) / (BED_H + 10)));
    const shown = Math.min(count, cols * rows);
    for (let i = 0; i < shown; i++) {
      const x = a.x + PAD + (i % cols) * (BED_W + 10);
      const y = top + Math.floor(i / cols) * (BED_H + 10);
      beds.push({ lane, index: i, x, y, w: BED_W, h: BED_H, occupied: used.includes(i) });
      bedPos.set(`${lane}:${i}`, { x: x + BED_W / 2, y: y + BED_H / 2 });
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
  const dot = (p: SimSnapshot['patients'][number], x: number, y: number): PatientDot => ({
    id: p.id,
    x,
    y,
    acuity: p.assignedAcuity,
    waited: s.now - p.arrivalTime,
    boarding: p.boarding,
    special: p.source === 'walkIn' ? null : p.source,
  });
  const inRoom = s.patients.filter((p) => p.location === 'waiting');
  lineDefs.forEach((line, li) => {
    const top = waiting.y + 30 + li * lineH;
    waitingLines.push({ label: line.label, y: top + 12 });
    const queued = inRoom.filter((p) => line.match(p.waitingFor)).sort((a, b) => a.arrivalTime - b.arrivalTime);
    const maxRows = Math.max(1, Math.floor((lineH - 24) / DOT));
    queued.forEach((p, i) => {
      const idx = Math.min(i, perRow * maxRows - 1); // overflow piles on the last slot
      patients.push(dot(p, waiting.x + PAD + (idx % perRow) * DOT + DOT / 2, top + 18 + Math.floor(idx / perRow) * DOT + DOT / 2));
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
      if (pos) patients.push(dot(p, pos.x, pos.y));
    } else if (p.location === 'intake') {
      const nurse = p.staffIds.map((id) => nursePos.get(id)).find(Boolean);
      const pos = nurse ?? { x: triageArea.x + triageArea.w - 30, y: triageArea.y + 40 };
      patients.push(dot(p, pos.x + 22, pos.y));
    }
  }

  // Staff: at their patient's bed when busy there, otherwise in a strip at the top of their area.
  const staff: StaffMark[] = [];
  const roleArea: Record<Role, AreaId> = { triageNurse: 'triage', doctor: 'main', fastTrackClinician: 'fastTrack', nurse: 'main', tech: 'main' };
  const stripCount = new Map<AreaId, number>();
  for (const m of s.staff) {
    const mark = { id: m.id, role: m.role, busy: m.busy, leaving: m.retiring, fatigue: m.fatigue };
    if (m.role === 'triageNurse') {
      const pos = nursePos.get(m.id)!;
      staff.push({ ...mark, ...pos });
      continue;
    }
    const patient = m.patientId === undefined ? undefined : s.patients.find((p) => p.id === m.patientId);
    const pos = patient?.location === 'bed' ? bedPos.get(`${patient.lane}:${patient.bed}`) : undefined;
    if (pos) {
      staff.push({ ...mark, x: pos.x + BED_W / 2 + 3, y: pos.y - BED_H / 2 + 2 });
      continue;
    }
    const aid = area(roleArea[m.role]) ? roleArea[m.role] : 'main';
    const a = area(aid)!;
    const n = stripCount.get(aid) ?? 0;
    stripCount.set(aid, n + 1);
    staff.push({ ...mark, x: a.x + PAD + 8 + n * 22, y: a.y + 38 });
  }

  return { areas, beds, staff, patients, waitingLines };
}
