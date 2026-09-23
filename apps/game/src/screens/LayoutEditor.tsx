import {
  defaultCapacity,
  exampleLayout,
  footprintPreset,
  resolveLayout,
  ROOM_TYPES,
  checkLayoutForSim,
  FOOTPRINT_PRESETS,
  type Cell,
  type FootprintPreset,
  type LayoutSpec,
  type RoomSpec,
  type RoomType,
} from '@er/sim';
import { useMemo, useState } from 'react';
import { minutes, percent } from '../format';
import { downloadJson, quickScore, type GameConfig, type QuickScore } from '../sandbox';
import { Stepper } from './ScheduleEditor';

type Tool = RoomType | 'entrance' | 'erase';

const TOOL_LABEL: Record<Tool, string> = {
  waiting: 'Waiting room',
  triage: 'Triage',
  trauma: 'Trauma room',
  acute: 'Acute beds',
  fastTrack: 'Fast track',
  station: 'Staff station',
  imaging: 'Imaging',
  lab: 'Lab',
  entrance: 'Entrance',
  erase: 'Remove room',
};

const PRESET_LABEL: Record<FootprintPreset, string> = { rectangle: 'Rectangle', lShape: 'L-shape', uShape: 'U-shape', narrow: 'Long and narrow' };

/** The sandbox scenario a layout is tested in: a normal week, default staffing. */
export function layoutConfig(layout: LayoutSpec): GameConfig {
  return { id: 'layout-sandbox', name: 'Layout test', durationMinutes: 7 * 1440, warmupMinutes: 1440, modules: { layout: true }, layout };
}

export function LayoutEditor(props: { initial?: LayoutSpec; onPlay: (config: GameConfig) => void; onBack: () => void }) {
  const [spec, setSpec] = useState<LayoutSpec>(() => props.initial ?? exampleLayout());
  const [tool, setTool] = useState<Tool>('acute');
  const [drag, setDrag] = useState<{ a: Cell; b: Cell } | null>(null);
  const [score, setScore] = useState<QuickScore | null>(null);
  const [best, setBest] = useState<QuickScore | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fp = Array.isArray(spec.footprint) ? null : spec.footprint;
  const footprint = Array.isArray(spec.footprint) ? spec.footprint : footprintPreset(spec.footprint.preset, spec.footprint.width, spec.footprint.height);
  const width = footprint[0]!.length;
  const height = footprint.length;
  const resolved = useMemo(() => resolveLayout(spec), [spec]);
  const problems = resolved.layout ? checkLayoutForSim(resolved.layout, true) : resolved.problems;
  const beds = (type: RoomType) => (resolved.layout?.rooms ?? []).filter((r) => r.type === type).reduce((s, r) => s + r.capacity, 0);

  const change = (next: LayoutSpec) => {
    setSpec(next);
    setScore(null);
    setMessage(null);
  };

  const cellAt = (e: React.PointerEvent<SVGSVGElement>): Cell => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(width - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * width))),
      y: Math.min(height - 1, Math.max(0, Math.floor(((e.clientY - box.top) / box.height) * height))),
    };
  };
  const roomAt = (c: Cell) => spec.rooms.findIndex((r) => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h);

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const c = cellAt(e);
    if (tool === 'erase') {
      const i = roomAt(c);
      if (i >= 0) change({ ...spec, rooms: spec.rooms.filter((_, j) => j !== i) });
      return;
    }
    if (tool === 'entrance') {
      change({ ...spec, entrance: c });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ a: c, b: c });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => drag && setDrag({ ...drag, b: cellAt(e) });
  const onUp = () => {
    if (!drag || tool === 'erase' || tool === 'entrance') return;
    const x = Math.min(drag.a.x, drag.b.x);
    const y = Math.min(drag.a.y, drag.b.y);
    const room: RoomSpec = { id: nextId(spec.rooms, tool), type: tool, x, y, w: Math.abs(drag.a.x - drag.b.x) + 1, h: Math.abs(drag.a.y - drag.b.y) + 1 };
    setDrag(null);
    const trial = { ...spec, rooms: [...spec.rooms, room] };
    const r = resolveLayout(trial);
    const own = r.problems.filter((p) => p.startsWith(room.id));
    if (own.length) setMessage(own[0]!);
    else change(trial);
  };

  const setPreset = (preset: FootprintPreset, w: number, h: number) => change({ ...spec, footprint: { preset, width: w, height: h } });

  const test = () => {
    const s = quickScore(layoutConfig(spec));
    setScore(s);
    if (!best || s.doorToDoctorMean < best.doorToDoctorMean) setBest(s);
  };

  const cellPx = 20;
  const sel = drag && {
    x: Math.min(drag.a.x, drag.b.x),
    y: Math.min(drag.a.y, drag.b.y),
    w: Math.abs(drag.a.x - drag.b.x) + 1,
    h: Math.abs(drag.a.y - drag.b.y) + 1,
  };

  return (
    <main className="screen layout-editor">
      <p className="eyebrow">Sandbox · layout only</p>
      <h1>Design the floor</h1>
      <p className="muted">
        Draw rooms by dragging on the grid. Staff walk from their station to every patient and back, so distance costs time. Test the plan on a normal week to
        see how it performs.
      </p>

      <div className="editor-bar">
        <label>
          Shape{' '}
          <select value={fp?.preset ?? 'rectangle'} onChange={(e) => setPreset(e.target.value as FootprintPreset, width, height)} aria-label="Footprint shape">
            {FOOTPRINT_PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <span>
          Width <Stepper value={width} min={8} max={60} onChange={(v) => setPreset(fp?.preset ?? 'rectangle', v, height)} label="Floor width" />
        </span>
        <span>
          Depth <Stepper value={height} min={6} max={40} onChange={(v) => setPreset(fp?.preset ?? 'rectangle', width, v)} label="Floor depth" />
        </span>
      </div>

      <div className="tools" role="toolbar" aria-label="Tools">
        {([...ROOM_TYPES.filter((t) => t !== 'imaging' && t !== 'lab'), 'entrance', 'erase'] as Tool[]).map((t) => (
          <button key={t} className={t === tool ? 'on' : ''} aria-pressed={t === tool} onClick={() => setTool(t)} data-testid={`tool-${t}`}>
            {t !== 'entrance' && t !== 'erase' && <span className={`swatch room-${t}`} />}
            {TOOL_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="grid-wrap">
        <svg
          className="grid"
          viewBox={`0 0 ${width * cellPx} ${height * cellPx}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          role="application"
          aria-label="Floor plan grid"
          data-testid="layout-grid"
        >
          {footprint.map((row, y) =>
            [...row].map((c, x) => (
              <rect key={`${x},${y}`} x={x * cellPx} y={y * cellPx} width={cellPx} height={cellPx} className={c === '#' ? 'cell' : 'outside'} />
            )),
          )}
          {spec.rooms.map((r) => (
            <g key={r.id}>
              <rect x={r.x * cellPx + 1} y={r.y * cellPx + 1} width={r.w * cellPx - 2} height={r.h * cellPx - 2} rx={3} className={`room room-${r.type}`} />
              <text x={r.x * cellPx + 4} y={r.y * cellPx + 13} className="room-label">
                {TOOL_LABEL[r.type]}
              </text>
            </g>
          ))}
          {resolved.layout?.rooms.map((r) => (
            <rect key={`door-${r.id}`} x={r.door.x * cellPx + 6} y={r.door.y * cellPx + 6} width={8} height={8} className="door" />
          ))}
          <rect x={spec.entrance.x * cellPx + 2} y={spec.entrance.y * cellPx + 2} width={cellPx - 4} height={cellPx - 4} className="entrance" />
          {sel && <rect x={sel.x * cellPx} y={sel.y * cellPx} width={sel.w * cellPx} height={sel.h * cellPx} className={`drag room-${tool}`} />}
        </svg>
      </div>

      {message && (
        <p className="over" role="alert">
          {message}
        </p>
      )}

      <section className="card room-list" style={{ marginTop: 16 }}>
        <h2>Rooms</h2>
        <p className="muted">
          {beds('trauma')} trauma bays, {beds('acute')} acute beds, {beds('fastTrack')} fast-track beds.
        </p>
        <ul>
          {spec.rooms.map((r, i) => (
            <li key={r.id}>
              <span className={`swatch room-${r.type}`} /> {TOOL_LABEL[r.type]} ({r.w}×{r.h})
              {(r.type === 'acute' || r.type === 'fastTrack' || r.type === 'triage') && (
                <>
                  {' '}
                  · {r.type === 'triage' ? 'stations' : 'beds'}{' '}
                  <Stepper
                    value={r.capacity ?? defaultCapacity(r.type, r.w, r.h)}
                    min={1}
                    max={r.w * r.h}
                    onChange={(capacity) => change({ ...spec, rooms: spec.rooms.map((x, j) => (j === i ? { ...x, capacity } : x)) })}
                    label={`${r.id} capacity`}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button onClick={props.onBack}>Back</button>
        <button onClick={() => downloadJson('layout-sandbox.json', layoutConfig(spec))} disabled={problems.length > 0}>
          Export config
        </button>
        <button onClick={test} disabled={problems.length > 0} data-testid="test-layout">
          Test this layout
        </button>
        <button className="primary push" onClick={() => props.onPlay(layoutConfig(spec))} disabled={problems.length > 0} data-testid="play-layout">
          Watch a shift
        </button>
      </div>

      {score && (
        <section className="card score" data-testid="layout-score">
          <h2>Result (a normal week, three runs)</h2>
          <ScoreTable score={score} best={best} />
        </section>
      )}
    </main>
  );
}

function ScoreTable({ score, best }: { score: QuickScore; best: QuickScore | null }) {
  const rows: [string, (s: QuickScore) => string][] = [
    ['Door to doctor, average', (s) => minutes(s.doorToDoctorMean)],
    ['Door to doctor, median', (s) => minutes(s.doorToDoctorMedian)],
    ['Length of stay, median', (s) => minutes(s.lengthOfStayMedian)],
    ['Left without being seen', (s) => percent(s.lwbsRate)],
    ["Doctors' busy time spent walking", (s) => percent(s.doctorWalkingShare)],
  ];
  return (
    <table className="metrics">
      <thead>
        <tr>
          <th />
          <td>This layout</td>
          <td>Best found this session</td>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, f]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{f(score)}</td>
            <td>{best ? f(best) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function nextId(rooms: RoomSpec[], type: RoomType): string {
  for (let n = 1; ; n++) if (!rooms.some((r) => r.id === `${type}-${n}`)) return `${type}-${n}`;
}
