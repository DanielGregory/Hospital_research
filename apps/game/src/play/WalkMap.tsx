/**
 * Where people walked: the floor plan with each corridor cell shaded by how often it was walked
 * (one-hue sequential ramp, five steps), plus the busiest routes as a table. Reads sim output only.
 */
import { walkHeat, type ResolvedLayout, type WalkTrip } from '@er/sim';
import { useMemo, useState } from 'react';

export interface Walks {
  staff: WalkTrip[];
  patient: WalkTrip[];
}

const ROOM_NAME: Record<string, string> = {
  waiting: 'Waiting room',
  triage: 'Triage',
  trauma: 'Trauma room',
  acute: 'Acute bay',
  fastTrack: 'Fast track',
  station: 'Staff station',
  imaging: 'Imaging',
  lab: 'Lab',
};

/** Human name for a location index (entrance, rooms, ambulance door). */
export function locationName(l: ResolvedLayout, i: number): string {
  if (i === 0) return 'Entrance';
  if (i === l.ambulanceLoc) return 'Ambulance door';
  const r = l.rooms[i - 1]!;
  const same = l.rooms.filter((x) => x.type === r.type);
  return same.length > 1 ? `${ROOM_NAME[r.type]} ${same.indexOf(r) + 1}` : ROOM_NAME[r.type]!;
}

/** Routes by number of walks (both directions together), busiest first. */
export function busiestRoutes(l: ResolvedLayout, trips: readonly WalkTrip[], n = 5) {
  const by = new Map<string, { a: number; b: number; walks: number }>();
  for (const t of trips) {
    const [a, b] = t.from < t.to ? [t.from, t.to] : [t.to, t.from];
    const k = `${a}-${b}`;
    const e = by.get(k) ?? { a, b, walks: 0 };
    e.walks += t.count;
    by.set(k, e);
  }
  return [...by.values()]
    .map((r) => ({ ...r, cells: l.dist[r.a]![r.b]! }))
    .sort((x, y) => y.walks * y.cells - x.walks * x.cells)
    .slice(0, n);
}

const STEPS = [0.1, 0.25, 0.5, 0.75, 1];
const bin = (v: number, max: number) => (v <= 0 ? 0 : STEPS.findIndex((s) => v <= s * max) + 1);

export function WalkMap({ layout: l, walks, caption }: { layout: ResolvedLayout; walks: Walks; caption?: string }) {
  const [who, setWho] = useState<'staff' | 'patient'>('staff');
  const [hover, setHover] = useState<{ x: number; y: number; v: number } | null>(null);
  const heat = useMemo(() => walkHeat(l, walks[who]), [l, walks, who]);
  const max = Math.max(1, ...heat.flat());
  const routes = busiestRoutes(l, walks[who]);
  const cell = 20;
  const inRoom = new Set(l.rooms.flatMap((r) => Array.from({ length: r.w * r.h }, (_, k) => `${r.x + (k % r.w)},${r.y + Math.floor(k / r.w)}`)));
  const doors = new Set(l.rooms.map((r) => `${r.door.x},${r.door.y}`));
  return (
    <figure className="viz walk-map" data-testid="walk-map">
      <figcaption>
        {caption ?? 'Where people walked'}
        <span className="seg" role="group" aria-label="Whose walking">
          {(['staff', 'patient'] as const).map((w) => (
            <button key={w} className={w === who ? 'on' : ''} aria-pressed={w === who} onClick={() => setWho(w)}>
              {w === 'staff' ? 'Staff' : 'Patients'}
            </button>
          ))}
        </span>
      </figcaption>
      <ul className="viz-legend heat-legend" aria-label="Walks through a spot">
        <li className="muted">Fewer</li>
        {STEPS.map((s, i) => (
          <li key={s}>
            <span className={`heat-swatch heat-${i + 1}`} />
          </li>
        ))}
        <li className="muted">More (up to {Math.round(max).toLocaleString('en-US')} walks)</li>
      </ul>
      <div className="viz-plot">
        <svg viewBox={`0 0 ${l.width * cell} ${l.height * cell}`} role="img" aria-label={`${who === 'staff' ? 'Staff' : 'Patient'} walking by corridor spot`} onPointerLeave={() => setHover(null)}>
          {l.footprint.map((row, y) =>
            [...row].map((c, x) => {
              if (c !== '#') return null;
              const k = `${x},${y}`;
              const room = inRoom.has(k) && !doors.has(k);
              const v = heat[y]![x]!;
              return (
                <rect
                  key={k}
                  x={x * cell}
                  y={y * cell}
                  width={cell}
                  height={cell}
                  className={room ? 'heat-room' : `heat-cell heat-${bin(v, max)}`}
                  onPointerEnter={room ? undefined : () => setHover({ x, y, v })}
                />
              );
            }),
          )}
          {l.rooms.map((r) => (
            <g key={r.id} pointerEvents="none">
              <rect x={r.x * cell + 1} y={r.y * cell + 1} width={r.w * cell - 2} height={r.h * cell - 2} rx={3} className="heat-room-outline" />
              <text x={r.x * cell + 4} y={r.y * cell + 13} className="heat-room-label">
                {ROOM_NAME[r.type]}
              </text>
            </g>
          ))}
          <text x={l.entrance.x * cell + cell / 2} y={l.entrance.y * cell + cell / 2 + 4} textAnchor="middle" className="heat-marker" pointerEvents="none">
            E
          </text>
          {l.ambulanceLoc !== null && (
            <text x={l.points[l.ambulanceLoc]!.x * cell + cell / 2} y={l.points[l.ambulanceLoc]!.y * cell + cell / 2 + 4} textAnchor="middle" className="heat-marker" pointerEvents="none">
              A
            </text>
          )}
          {hover && <rect x={hover.x * cell} y={hover.y * cell} width={cell} height={cell} className="heat-hover" pointerEvents="none" />}
        </svg>
        {hover && (
          <div className="viz-tip" style={{ left: `${((hover.x + 0.5) / l.width) * 100}%`, top: `${((hover.y + 1.2) / l.height) * 100}%` }}>
            <strong>{Math.round(hover.v).toLocaleString('en-US')}</strong> walks through here
          </div>
        )}
      </div>
      <p className="muted small">E: entrance{l.ambulanceLoc !== null ? ' · A: ambulance door' : ''}. The strongest blue marks the most-walked corridors; shorten the busiest routes.</p>
      {routes.length > 0 && (
        <table className="metrics routes" data-testid="busiest-routes">
          <caption>Busiest routes</caption>
          <thead>
            <tr>
              <th>Between</th>
              <th>Walks</th>
              <th>Each way</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={`${r.a}-${r.b}`}>
                <th scope="row">
                  {locationName(l, r.a)} ↔ {locationName(l, r.b)}
                </th>
                <td>{Math.round(r.walks).toLocaleString('en-US')}</td>
                <td>{r.cells} squares</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
