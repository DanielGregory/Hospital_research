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
    <section className="card schedule" data-testid={`schedule-${role}`}>
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
                  {[...new Set([...LENGTHS, s.hours])]
                    .sort((a, b) => a - b)
                    .map((h) => (
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
      <CoverageChart role={role} onDuty={onDuty} demand={load.map((l) => l.doctorLoad)} startHour={resolved.startHour} maxY={Math.ceil(peak)} />
      <div className="legend-inline" aria-hidden>
        <span>
          <span className="key" style={{ background: 'var(--staff)' }} />
          {ROLE_LABEL[role]} on duty
        </span>
        {load.length > 0 && (
          <span>
            <span className="key line" style={{ background: 'var(--fail)' }} />
            Doctors needed to keep up (average)
          </span>
        )}
      </div>
    </section>
  );
}

/** Staff on duty per hour (bars, 2px gaps, rounded tops) against expected demand (line). One y-axis: people. */
function CoverageChart(props: { role: Role; onDuty: number[]; demand: number[]; startHour: number; maxY: number }) {
  const W = 480;
  const H = 150;
  const left = 22;
  const bottom = 18;
  const top = 6;
  const plotH = H - bottom - top;
  const slot = (W - left) / 24;
  const y = (v: number) => top + plotH - (v / props.maxY) * plotH;
  const ticks = Array.from({ length: props.maxY + 1 }, (_, i) => i).filter((v) => props.maxY <= 6 || v % 2 === 0);
  return (
    <svg className="coverage" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${ROLE_LABEL[props.role]} on duty by hour, against demand`}>
      {ticks.map((v) => (
        <g key={v}>
          <line className="grid-line" x1={left} x2={W} y1={y(v)} y2={y(v)} />
          <text className="tick" x={left - 6} y={y(v) + 3} textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      {props.onDuty.map((n, h) => {
        const hgt = Math.max(0, (n / props.maxY) * plotH);
        const x = left + h * slot + 1;
        const w = slot - 2;
        const r = Math.min(4, w / 2, hgt);
        return (
          <path key={h} className="bar" d={`M${x},${top + plotH} v${-(hgt - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${hgt - r} z`}>
            <title>
              {hourLabel((props.startHour + h) % 24)}: {n} on duty
              {props.demand[h] !== undefined ? `, about ${props.demand[h]!.toFixed(1)} needed` : ''}
            </title>
          </path>
        );
      })}
      {props.demand.length > 0 && <polyline className="demand" points={props.demand.map((d, h) => `${left + h * slot + slot / 2},${y(d)}`).join(' ')} />}
      {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
        <text key={h} className="tick" x={left + h * slot + slot / 2} y={H - 4} textAnchor="middle">
          {hourLabel((props.startHour + h) % 24)}
        </text>
      ))}
    </svg>
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
