import { hourlyLoad, onDutyByHour, resolveConfig, staffingSummary, type Role, type Shift } from '@er/sim';
import { ROLE_LABEL } from '../controls';
import { hourLabel } from '../format';
import type { LevelConfig } from '../levels';

const LENGTHS = [4, 6, 8, 10, 12];

export function ScheduleEditor(props: { role: Role; shifts: Shift[]; config: LevelConfig; onChange: (s: Shift[]) => void }) {
  const { role, shifts, config, onChange } = props;
  const resolved = resolveConfig(config);
  const summary = staffingSummary(resolved)[role];
  const limit = config.level.limits?.staffHoursPerDay?.[role];
  const maxOnDuty = config.level.limits?.maxOnDuty?.[role];
  const onDuty = onDutyByHour(resolved, role).slice(0, 24);
  const load = role === 'doctor' ? hourlyLoad(resolved).slice(0, 24) : [];
  const peak = Math.max(1, ...onDuty, ...load.map((l) => l.doctorLoad), maxOnDuty ?? 0);

  const update = (i: number, patch: Partial<Shift>) => onChange(shifts.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <section className="schedule" data-testid={`schedule-${role}`}>
      <h3>{ROLE_LABEL[role]}: shifts</h3>
      <table>
        <thead>
          <tr>
            <th>Start</th>
            <th>Length</th>
            <th>Staff</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shifts.map((s, i) => (
            <tr key={i}>
              <td>
                <select value={s.startHour} onChange={(e) => update(i, { startHour: Number(e.target.value) })} aria-label="Shift start">
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={s.hours} onChange={(e) => update(i, { hours: Number(e.target.value) })} aria-label="Shift length">
                  {[...new Set([...LENGTHS, s.hours])].sort((a, b) => a - b).map((h) => (
                    <option key={h} value={h}>
                      {h} h
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <Stepper value={s.count} min={0} max={maxOnDuty ?? 10} onChange={(count) => update(i, { count })} label="Staff on shift" />
              </td>
              <td>
                <button className="icon" onClick={() => onChange(shifts.filter((_, j) => j !== i))} aria-label="Remove shift">
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => onChange([...shifts, { startHour: 8, hours: 12, count: 1 }])}>Add shift</button>
      <p className={limit !== undefined && summary.hoursPerDay > limit + 1e-9 ? 'over' : 'muted'}>
        {summary.hoursPerDay.toFixed(0)} staff-hours per day{limit !== undefined ? ` of ${limit} allowed` : ''}
        {maxOnDuty !== undefined ? `, at most ${maxOnDuty} on duty at once (now ${summary.maxOnDuty})` : ''}
      </p>
      <svg className="coverage" viewBox="0 0 480 120" role="img" aria-label={`${ROLE_LABEL[role]} on duty by hour`}>
        {onDuty.map((n, h) => (
          <rect key={h} x={h * 20 + 1} y={110 - (n / peak) * 100} width={18} height={(n / peak) * 100} className="bar" />
        ))}
        {load.length > 0 && (
          <polyline className="demand" points={load.map((l, h) => `${h * 20 + 10},${110 - (l.doctorLoad / peak) * 100}`).join(' ')} />
        )}
        {[0, 6, 12, 18].map((h) => (
          <text key={h} x={h * 20 + 2} y={119} className="tick">
            {hourLabel((resolved.startHour + h) % 24)}
          </text>
        ))}
      </svg>
      {load.length > 0 && <p className="legend muted">Bars: doctors on duty. Line: expected doctor workload (doctors needed to keep up, on average).</p>}
    </section>
  );
}

export function Stepper(props: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  const { value, min, max, onChange, label } = props;
  return (
    <span className="stepper" aria-label={label}>
      <button onClick={() => onChange(Math.max(min, value - 1))} aria-label={`Fewer: ${label}`}>
        −
      </button>
      <span className="value">{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} aria-label={`More: ${label}`}>
        +
      </button>
    </span>
  );
}
