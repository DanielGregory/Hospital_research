/**
 * The debrief's "why": the main bottleneck in plain words, where the waiting went, and the shift
 * as a timeline with the player's decisions marked on it.
 */
import { WAIT_CAUSES, type Metrics, type TimedCommand, type TimelineSample } from '@er/sim';
import { useMemo, useState } from 'react';
import { clockLabel } from '../format';
import { commandLabel, explain, WAIT_LABEL } from './explain';

export interface RunAnalysis {
  timeline: TimelineSample[];
  log: TimedCommand[];
  clock: { startDayOfWeek: number; startHour: number };
  /** Mass-casualty windows to shade, in sim minutes. */
  incidents: { start: number; end: number }[];
}

export function Why({ m, run }: { m: Metrics; run: RunAnalysis }) {
  const ex = useMemo(() => explain(m, run.timeline, run.log, run.clock), [m, run]);
  return (
    <section className="card why" data-testid="why">
      <h3>What happened</h3>
      {ex.lines.length ? (
        <ul className="why-lines">
          {ex.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">A calm shift: nobody waited long.</p>
      )}
      <div className="why-grid">
        <WaitBars m={m} />
        <Timeline run={run} />
      </div>
    </section>
  );
}

/** Patient-hours of waiting by cause, largest first. One hue: this is magnitude, not identity. */
function WaitBars({ m }: { m: Metrics }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = WAIT_CAUSES.reduce((s, k) => s + m.waits[k], 0);
  const rows = [...WAIT_CAUSES].sort((a, b) => m.waits[b] - m.waits[a]).filter((k) => m.waits[k] > 0.05);
  const max = Math.max(1e-9, ...rows.map((k) => m.waits[k]));
  return (
    <figure className="viz wait-bars">
      <figcaption>Where the waiting went (patient-hours)</figcaption>
      {rows.length === 0 && <p className="muted">No waiting to speak of.</p>}
      <ul>
        {rows.map((k, i) => (
          <li key={k} onPointerEnter={() => setHover(k)} onPointerLeave={() => setHover(null)} className={hover === k ? 'hover' : ''}>
            <span className="bar-label">{WAIT_LABEL[k].replace(/^waiting for /, 'For ').replace(/^admitted, /, 'Admitted, ')}</span>
            <span className="bar-track">
              <span className={`bar ${i === 0 ? 'top' : ''}`} style={{ width: `${(m.waits[k] / max) * 100}%` }} />
            </span>
            <span className="bar-value">
              {m.waits[k] >= 10 ? Math.round(m.waits[k]) : m.waits[k].toFixed(1)} h · {Math.round((m.waits[k] / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

const SERIES = [
  { key: 'waiting', label: 'Not yet seen', cls: 's1' },
  { key: 'inBeds', label: 'In beds', cls: 's2' },
  { key: 'boarding', label: 'Admitted, waiting for a ward bed', cls: 's3' },
] as const;

/** People in the department over the shift, with decisions marked. One axis: everything is a head count. */
function Timeline({ run }: { run: RunAnalysis }) {
  const { timeline: data, clock } = run;
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (data.length < 2) return null;
  const W = 640;
  const H = 240;
  const pad = { l: 34, r: 120, t: 34, b: 26 };
  const t0 = data[0]!.minute;
  const t1 = data.at(-1)!.minute;
  const series = SERIES.filter((s) => s.key !== 'boarding' || data.some((d) => d.boarding > 0));
  const yMax = Math.max(4, ...data.flatMap((d) => series.map((s) => d[s.key])));
  const niceMax = Math.ceil(yMax / 5) * 5;
  const x = (min: number) => pad.l + ((min - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / niceMax) * (H - pad.t - pad.b);
  const time = (min: number) => clockLabel(clock.startDayOfWeek, clock.startHour, min).split(' ').pop()!;
  const hours = (t1 - t0) / 60;
  const tickEvery = hours <= 12 ? 120 : hours <= 30 ? 360 : 720;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / tickEvery) * tickEvery; t <= t1; t += tickEvery) ticks.push(t);
  const markers = run.log.filter((c) => c.atMinute > t0 && c.atMinute <= t1);
  const nearest = (px: number) => {
    const min = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    let best = 0;
    data.forEach((d, i) => {
      if (Math.abs(d.minute - min) < Math.abs(data[best]!.minute - min)) best = i;
    });
    return best;
  };
  const h = hover !== null ? data[hover]! : null;
  const ends = series.map((s) => ({ s, v: data.at(-1)![s.key] }));
  // Keep end labels apart.
  const labelY = ends.map((e) => y(e.v));
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < labelY.length; i++)
      for (let j = 0; j < labelY.length; j++) if (i !== j && Math.abs(labelY[i]! - labelY[j]!) < 13) labelY[i]! < labelY[j]! ? (labelY[i]! -= 3) : (labelY[i]! += 3);

  return (
    <figure className="viz timeline">
      <figcaption>
        Over the shift{' '}
        <button className="ghost small" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? 'Chart' : 'Table'}
        </button>
      </figcaption>
      <ul className="viz-legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className={`swatch-line ${s.cls}`} /> {s.label}
          </li>
        ))}
        {markers.length > 0 && (
          <li>
            <span className="swatch-marker" /> Your decisions
          </li>
        )}
      </ul>
      {table ? (
        <div className="viz-table">
          <table className="metrics">
            <thead>
              <tr>
                <th>Time</th>
                {series.map((s) => (
                  <td key={s.key}>{s.label}</td>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.minute}>
                  <th scope="row">{time(d.minute)}</th>
                  {series.map((s) => (
                    <td key={s.key}>{d[s.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz-plot">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label="People in the department over the shift"
            onPointerMove={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              setHover(nearest(((e.clientX - r.left) / r.width) * W));
            }}
            onPointerLeave={() => setHover(null)}
          >
            {run.incidents.map((w, i) => (
              <rect key={i} x={x(Math.max(t0, w.start))} width={Math.max(2, x(Math.min(t1, w.end)) - x(Math.max(t0, w.start)))} y={pad.t} height={H - pad.t - pad.b} className="incident-band" />
            ))}
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={pad.l} x2={W - pad.r} y1={y(niceMax * f)} y2={y(niceMax * f)} className="grid" />
                <text x={pad.l - 6} y={y(niceMax * f) + 4} className="axis" textAnchor="end">
                  {Math.round(niceMax * f)}
                </text>
              </g>
            ))}
            {ticks.map((t) => (
              <text key={t} x={x(t)} y={H - 8} className="axis" textAnchor="middle">
                {time(t)}
              </text>
            ))}
            {markers.map((c, i) => (
              <g key={i} className="marker">
                <line x1={x(c.atMinute)} x2={x(c.atMinute)} y1={pad.t - 4} y2={H - pad.b} />
                <text x={x(c.atMinute) + 3} y={pad.t - 8 - (i % 2) * 10} className="marker-label">
                  {i < 6 ? commandLabel(c.command) : ''}
                </text>
              </g>
            ))}
            {series.map((s) => (
              <polyline key={s.key} className={`line ${s.cls}`} points={data.map((d) => `${x(d.minute)},${y(d[s.key])}`).join(' ')} />
            ))}
            {ends.map((e, i) => (
              <text key={e.s.key} x={W - pad.r + 8} y={labelY[i]! + 4} className="end-label">
                {e.s.label.split(',')[0]} {e.v}
              </text>
            ))}
            {h && (
              <g>
                <line x1={x(h.minute)} x2={x(h.minute)} y1={pad.t} y2={H - pad.b} className="crosshair" />
                {series.map((s) => (
                  <circle key={s.key} cx={x(h.minute)} cy={y(h[s.key])} r={4.5} className={`dot ${s.cls}`} />
                ))}
              </g>
            )}
          </svg>
          {h && (
            <div className="viz-tip" style={{ left: `${(x(h.minute) / W) * 100}%` }}>
              <strong>{time(h.minute)}</strong>
              {series.map((s) => (
                <span key={s.key}>
                  <span className={`swatch-line ${s.cls}`} /> {s.label}: {h[s.key]}
                </span>
              ))}
              {h.diversion && <span>Ambulances diverted</span>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
