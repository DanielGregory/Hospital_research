/**
 * Shift schedules. Times here are "calendar minutes": minutes since Monday
 * 00:00 of the week the run starts in. Sim time t maps to calendar time
 * offset + t, where offset = (startDayOfWeek * 24 + startHour) * 60.
 */

import type { Shift } from './types.js';

const DAY = 1440;
const WEEK = 7 * DAY;

/** Every shift occurrence overlapping calendar window [from, to). */
function occurrences(shifts: readonly Shift[], from: number, to: number): { start: number; end: number; count: number; index: number }[] {
  const out: { start: number; end: number; count: number; index: number }[] = [];
  const maxLen = Math.max(0, ...shifts.map((s) => s.hours * 60));
  const firstDay = Math.floor((from - maxLen) / DAY) - 1;
  const lastDay = Math.ceil(to / DAY) + 1;
  for (let d = firstDay; d <= lastDay; d++) {
    const dow = ((d % 7) + 7) % 7;
    shifts.forEach((s, index) => {
      if (s.days && !s.days.includes(dow)) return;
      const start = d * DAY + s.startHour * 60;
      const end = start + s.hours * 60;
      if (end > from && start < to) out.push({ start, end, count: s.count, index });
    });
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

/** Shift occurrences overlapping sim window [from, to), in sim time (start may be before 0). */
export function occurrencesInRun(shifts: readonly Shift[], offset: number, from: number, to: number): { key: string; start: number; end: number; count: number }[] {
  return occurrences(shifts, offset + from, offset + to).map((o) => ({
    key: `${o.start}:${o.end}:${o.index}`,
    start: o.start - offset,
    end: o.end - offset,
    count: o.count,
  }));
}

export { WEEK as MINUTES_PER_WEEK };
