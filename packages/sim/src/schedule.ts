/**
 * Shift schedules. Times here are "calendar minutes": minutes since Monday
 * 00:00 of the week the run starts in. Sim time t maps to calendar time
 * offset + t, where offset = (startDayOfWeek * 24 + startHour) * 60.
 */

import type { Shift } from './types.js';

const DAY = 1440;
const WEEK = 7 * DAY;

/** Every shift occurrence overlapping calendar window [from, to). */
function occurrences(shifts: readonly Shift[], from: number, to: number): { start: number; end: number; count: number }[] {
  const out: { start: number; end: number; count: number }[] = [];
  const maxLen = Math.max(0, ...shifts.map((s) => s.hours * 60));
  const firstDay = Math.floor((from - maxLen) / DAY) - 1;
  const lastDay = Math.ceil(to / DAY) + 1;
  for (let d = firstDay; d <= lastDay; d++) {
    const dow = ((d % 7) + 7) % 7;
    for (const s of shifts) {
      if (s.days && !s.days.includes(dow)) continue;
      const start = d * DAY + s.startHour * 60;
      const end = start + s.hours * 60;
      if (end > from && start < to) out.push({ start, end, count: s.count });
    }
  }
  return out;
}

/** Staff on duty at sim time t. A shift covers [start, end). */
export function onDutyCount(shifts: readonly Shift[], offset: number, t: number): number {
  const at = offset + t;
  let n = 0;
  for (const o of occurrences(shifts, at, at + 1e-9)) if (o.start <= at && at < o.end) n += o.count;
  return n;
}

/** Sorted distinct sim times in (0, duration] where the on-duty count may change. */
export function scheduleBoundaries(shifts: readonly Shift[], offset: number, duration: number): number[] {
  const set = new Set<number>();
  for (const o of occurrences(shifts, offset, offset + duration + 1)) {
    for (const cal of [o.start, o.end]) {
      const t = cal - offset;
      if (t > 0 && t <= duration) set.add(t);
    }
  }
  return [...set].sort((a, b) => a - b);
}

export { WEEK as MINUTES_PER_WEEK };
