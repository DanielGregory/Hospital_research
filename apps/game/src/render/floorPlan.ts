/**
 * Pure layout of the top-down view: where each area, staff member and patient
 * dot goes for a given snapshot and canvas size. No drawing, no sim logic.
 */
import type { Acuity, PatientLocation, Role, SimSnapshot } from '@er/sim';

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

export interface StaffMark {
  id: number;
  role: Role;
  x: number;
  y: number;
  busy: boolean;
  leaving: boolean;
}

export interface PatientDot {
  id: number;
  x: number;
  y: number;
  /** What the player knows: undefined until triaged. */
  acuity?: Acuity;
  /** Minutes since arrival. */
  waited: number;
}

export interface FloorPlan {
  areas: Area[];
  staff: StaffMark[];
  patients: PatientDot[];
}

const PAD = 12;
const DOT = 14; // grid spacing for waiting dots

export function layoutFloor(s: SimSnapshot, width: number, height: number, showFastTrack: boolean): FloorPlan {
  const waitW = Math.round(width * 0.38);
  const rightX = waitW + PAD;
  const rightW = width - rightX;
  const triageH = Math.round(height * 0.26);
  const ftH = showFastTrack ? Math.round(height * 0.3) : 0;
  const mainH = height - triageH - ftH - (showFastTrack ? 2 * PAD : PAD);

  const areas: Area[] = [
    { id: 'waiting', label: 'Waiting room', x: 0, y: 0, w: waitW, h: height },
    { id: 'triage', label: 'Triage', x: rightX, y: 0, w: rightW, h: triageH },
    { id: 'main', label: 'Main ED', x: rightX, y: triageH + PAD, w: rightW, h: mainH },
  ];
  if (showFastTrack) areas.push({ id: 'fastTrack', label: 'Fast track', x: rightX, y: height - ftH, w: rightW, h: ftH });
  const area = (id: AreaId) => areas.find((a) => a.id === id);

  // Staff sit in bays across their area; the patient they are seeing sits beside them.
  const staff: StaffMark[] = [];
  const staffPos = new Map<number, { x: number; y: number }>();
  const roleArea: Record<Role, AreaId> = { triageNurse: 'triage', doctor: 'main', fastTrackClinician: 'fastTrack' };
  for (const role of ['triageNurse', 'doctor', 'fastTrackClinician'] as const) {
    const a = area(roleArea[role]);
    const members = s.staff.filter((m) => m.role === role);
    if (!a) continue;
    members.forEach((m, i) => {
      const cols = Math.max(1, Math.min(members.length, Math.floor((a.w - PAD) / 70)));
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = a.x + PAD + col * ((a.w - 2 * PAD) / cols) + 16;
      const y = a.y + 34 + row * 40;
      staff.push({ id: m.id, role, x, y, busy: m.busy, leaving: m.retiring });
      staffPos.set(m.id, { x, y });
    });
  }

  // Waiting room: three lines stacked, in service order.
  const waiting = area('waiting')!;
  const lines: { loc: PatientLocation; label: string }[] = [
    { loc: 'waitingTriage', label: 'triage' },
    { loc: 'waitingDoctor', label: 'doctor' },
    { loc: 'waitingFastTrack', label: 'fast track' },
  ];
  const lineH = (waiting.h - 30) / (showFastTrack ? 3 : 2);
  const perRow = Math.max(1, Math.floor((waiting.w - 2 * PAD) / DOT));
  const patients: PatientDot[] = [];
  lines.forEach((line, li) => {
    if (!showFastTrack && line.loc === 'waitingFastTrack') return;
    const top = waiting.y + 30 + li * lineH + 18;
    const queued = s.patients.filter((p) => p.location === line.loc);
    // Waiting lists come in id order; show longest-waiting first.
    queued.sort((a, b) => a.arrivalTime - b.arrivalTime);
    queued.forEach((p, i) => {
      const maxRows = Math.max(1, Math.floor((lineH - 24) / DOT));
      const idx = Math.min(i, perRow * maxRows - 1); // overflow piles on the last slot
      patients.push({
        id: p.id,
        x: waiting.x + PAD + (idx % perRow) * DOT + DOT / 2,
        y: top + Math.floor(idx / perRow) * DOT + DOT / 2,
        acuity: p.assignedAcuity,
        waited: s.now - p.arrivalTime,
      });
    });
  });

  for (const p of s.patients) {
    if (p.staffId === undefined) continue;
    const pos = staffPos.get(p.staffId);
    if (!pos) continue;
    patients.push({ id: p.id, x: pos.x + 22, y: pos.y, acuity: p.assignedAcuity, waited: s.now - p.arrivalTime });
  }

  return { areas, staff, patients };
}

/** Label for a waiting line, for the renderer. */
export const WAITING_LINE_LABELS = ['Waiting for triage', 'Waiting for a doctor', 'Waiting for fast track'];
