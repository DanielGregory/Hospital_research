/** Level tutorial tips: which one is due, given what has happened so far. Presentation only. */
import type { CoachTip, CoachTrigger, SimSnapshot } from '@er/sim';

export function triggered(when: CoachTrigger, s: SimSnapshot): boolean {
  switch (when) {
    case 'start':
      return true;
    case 'firstTriaged':
      return s.patients.some((p) => p.assignedAcuity !== undefined);
    case 'firstInBed':
      return s.patients.some((p) => p.location === 'bed');
    case 'emergentWaiting':
      return s.patients.some((p) => p.assignedAcuity !== undefined && p.assignedAcuity <= 2 && p.waitingFor === 'doctorEval');
    case 'firstLeft':
      return s.totals.lwbs > 0;
  }
}

/** The first tip, in order, not yet shown whose moment has come. */
export function nextTip(tips: readonly CoachTip[], shown: ReadonlySet<number>, s: SimSnapshot): number | null {
  for (let i = 0; i < tips.length; i++) if (!shown.has(i) && triggered(tips[i]!.when, s)) return i;
  return null;
}
