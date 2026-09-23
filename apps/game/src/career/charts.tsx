/** Career history charts: one y-axis per chart, direct labels, and a table view for screen readers. */
export interface Series {
  label: string;
  /** Palette slot (1–3), validated in the Why charts. */
  slot: 1 | 2 | 3;
  values: number[];
}

export function WeekChart(props: { title: string; series: Series[]; format: (v: number) => string; min?: number; max?: number; zeroLine?: boolean; testId?: string }) {
  const { series } = props;
  const n = Math.max(...series.map((s) => s.values.length));
  if (n === 0) return null;
  const all = series.flatMap((s) => s.values);
  let lo = props.min ?? Math.min(0, ...all);
  let hi = props.max ?? Math.max(...all);
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  const W = 520;
  const H = 170;
  const left = 58;
  const right = 92;
  const top = 10;
  const bottom = 22;
  const x = (i: number) => left + (n === 1 ? (W - left - right) / 2 : (i / (n - 1)) * (W - left - right));
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
  const ticks = [lo, (lo + hi) / 2, hi];
  const every = Math.max(1, Math.ceil(n / 8));
  return (
    <figure className="viz week-chart" data-testid={props.testId}>
      <figcaption>{props.title}</figcaption>
      {series.length > 1 && (
        <ul className="viz-legend">
          {series.map((s) => (
            <li key={s.label}>
              <span className={`swatch-line s${s.slot}`} /> {s.label}
            </li>
          ))}
        </ul>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${props.title}, week 1 to ${n}`}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line className="grid-line" x1={left} x2={W - right} y1={y(v)} y2={y(v)} />
            <text className="tick" x={left - 6} y={y(v) + 3} textAnchor="end">
              {props.format(v)}
            </text>
          </g>
        ))}
        {props.zeroLine && lo < 0 && hi > 0 && <line className="zero-line" x1={left} x2={W - right} y1={y(0)} y2={y(0)} />}
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % every === 0 || i === n - 1)
          .map((i) => (
            <text key={i} className="tick" x={x(i)} y={H - 6} textAnchor="middle">
              {i + 1}
            </text>
          ))}
        {series.map((s) => (
          <g key={s.label} className={`s${s.slot}`}>
            {s.values.length > 1 && <polyline className="line" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />}
            {s.values.map((v, i) => (
              <circle key={i} className="pt" cx={x(i)} cy={y(v)} r={s.values.length > 12 ? 2 : 3.2}>
                <title>
                  Week {i + 1}: {s.label} {props.format(v)}
                </title>
              </circle>
            ))}
            <text className="end-label" x={x(s.values.length - 1) + 8} y={y(s.values.at(-1)!) + 4}>
              {props.format(s.values.at(-1)!)}
            </text>
          </g>
        ))}
      </svg>
      <details className="table-view">
        <summary>Show as a table</summary>
        <table className="metrics">
          <thead>
            <tr>
              <th>Week</th>
              {series.map((s) => (
                <th key={s.label}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: n }, (_, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                {series.map((s) => (
                  <td key={s.label}>{s.values[i] === undefined ? '—' : props.format(s.values[i]!)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
