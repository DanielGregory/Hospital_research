/**
 * Moments worth interrupting the player for, read from snapshots. Presentation only: nothing
 * here changes the sim. Each kind of alert has a cooldown so the same news isn't repeated.
 */
import type { SimSnapshot } from '@er/sim';

export type AlertKind = 'incident' | 'emergentWaiting' | 'crowded' | 'bedsFull' | 'boarding' | 'leaving' | 'callInArrived';

export interface Alert {
  kind: AlertKind;
  severity: 'info' | 'warn' | 'urgent';
  title: string;
  body: string;
  /** Sim minute it fired. */
  at: number;
  /** Worth pausing for (when the player has auto-pause on). */
  pause: boolean;
}

/** Sim minutes before the same kind of alert can fire again. */
const COOLDOWN = 120;

export class AlertWatch {
  private readonly lastAt = new Map<AlertKind, number>();
  private readonly incidentsSeen = new Set<string>();
  private pending = -1;
  private lwbsMarks: { at: number; total: number }[] = [];

  check(s: SimSnapshot): Alert[] {
    const out: Alert[] = [];
    const fire = (a: Omit<Alert, 'at'>) => {
      const last = this.lastAt.get(a.kind);
      if (last !== undefined && s.now - last < COOLDOWN) return;
      this.lastAt.set(a.kind, s.now);
      out.push({ ...a, at: s.now });
    };

    for (const inc of s.incidents) {
      const key = `${inc.patients}:${inc.overMinutes}:${Math.round(s.now + inc.startsInMinutes)}`;
      if (inc.startsInMinutes <= 0 || this.incidentsSeen.has(key)) continue;
      this.incidentsSeen.add(key);
      out.push({
        kind: 'incident',
        severity: 'urgent',
        title: 'Major incident declared',
        body: `About ${inc.patients} casualties, the first in about ${Math.round(inc.startsInMinutes)} minutes, arriving over ${inc.overMinutes} minutes. Now is the time to free beds, call in help or open hallway spaces.`,
        at: s.now,
        pause: true,
      });
    }

    const doctors = s.staff.filter((m) => m.role === 'doctor' && !m.retiring).length;
    const unseenEmergent = s.patients.filter((p) => p.assignedAcuity !== undefined && p.assignedAcuity <= 2 && p.staffIds.length === 0 && p.location !== 'bed' && !p.boarding).length;
    if (unseenEmergent >= 3)
      fire({ kind: 'emergentWaiting', severity: 'urgent', title: `${unseenEmergent} emergent patients are waiting`, body: 'ESI 1–2 patients are waiting with nobody attending them. Sickest-first ordering, more doctors or more beds would help.', pause: true });

    const waiting = s.patients.filter((p) => p.location === 'waiting').length;
    if (waiting >= Math.max(15, 4 * doctors))
      fire({ kind: 'crowded', severity: 'warn', title: 'The waiting room is filling up', body: `${waiting} people are waiting. Long waits make people leave and let the sick get sicker.`, pause: false });

    const main = s.beds.main;
    const forBed = s.patients.filter((p) => p.waitingFor === 'bed').length;
    if (main.capacity !== null && main.occupied >= main.capacity + s.live.hallwayBeds && forBed >= 4)
      fire({ kind: 'bedsFull', severity: 'warn', title: 'Every bed is taken', body: `${forBed} patients are waiting for a bed.`, pause: false });

    const boarders = s.patients.filter((p) => p.boarding).length;
    if (boarders >= Math.max(3, Math.ceil((main.capacity ?? 20) * 0.25)))
      fire({ kind: 'boarding', severity: 'warn', title: `${boarders} admitted patients are stuck in ED beds`, body: 'They are waiting for a ward bed and keep your beds full. More ED staff will not fix this.', pause: false });

    this.lwbsMarks = [...this.lwbsMarks.filter((m) => s.now - m.at <= 60), { at: s.now, total: s.totals.lwbs }];
    if (s.totals.lwbs - this.lwbsMarks[0]!.total >= 3)
      fire({ kind: 'leaving', severity: 'warn', title: 'People are giving up and leaving', body: `${s.totals.lwbs - this.lwbsMarks[0]!.total} left without being seen in the last hour.`, pause: false });

    const pending = s.live.callInsPending.length;
    if (this.pending > pending) out.push({ kind: 'callInArrived', severity: 'info', title: 'On-call help has arrived', body: 'The on-call doctor is on the floor.', at: s.now, pause: false });
    this.pending = pending;
    return out;
  }
}
