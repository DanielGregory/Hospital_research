const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "Tuesday 23:40" for a sim time. */
export function clockLabel(startDayOfWeek: number, startHour: number, now: number): string {
  const total = (startDayOfWeek * 24 + startHour) * 60 + now;
  const day = Math.floor(total / 1440) % 7;
  const mins = Math.floor(total % 1440);
  return `${DAYS[day]} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function minutes(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v >= 120) return `${(v / 60).toFixed(1)} h`;
  return `${Math.round(v)} min`;
}

export function percent(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}

/** Format a metric by its path: rates and utilisation as %, everything else as minutes. */
export function metricValue(path: string, v: number | null | undefined): string {
  if (/rate|Rate|utilization|accuracy|share/.test(path)) return percent(v);
  if (/count|Count|arrivals|treated|Hours|per100|events|Score|cost/.test(path)) return v === null || v === undefined ? '—' : String(Math.round(v * 10) / 10);
  return minutes(v);
}

export function hourLabel(h: number): string {
  const whole = Math.floor(h);
  const m = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
