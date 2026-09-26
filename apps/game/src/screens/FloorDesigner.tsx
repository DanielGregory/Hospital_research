/**
 * Drawing a floor plan: rooms dragged on a grid, doors, the entrance and ambulance door, undo/redo,
 * and live walking-distance hints. Used by the sandbox layout editor and by story levels that let
 * the player design the department. Validation comes from the sim (`resolveLayout`).
 */
import { defaultCapacity, footprintPreset, PARAMS, resolveLayout, type Cell, type LayoutSpec, type ResolvedLayout, type RoomSpec, type RoomType } from '@er/sim';
import { useEffect, useMemo, useState } from 'react';
import { Stepper } from './ScheduleEditor';

export type Tool = RoomType | 'door' | 'entrance' | 'ambulance' | 'erase';

export const TOOL_LABEL: Record<Tool, string> = {
  waiting: 'Waiting room',
  triage: 'Triage',
  trauma: 'Trauma room',
  acute: 'Acute beds',
  fastTrack: 'Fast track',
  station: 'Staff station',
  imaging: 'Imaging',
  lab: 'Lab',
  door: 'Move a door',
  entrance: 'Entrance',
  ambulance: 'Ambulance door',
  erase: 'Remove room',
};

export const ROOM_TOOLS = new Set<Tool>(['waiting', 'triage', 'trauma', 'acute', 'fastTrack', 'station', 'imaging', 'lab']);

/** Distances that matter, in grid squares (door to door along corridors). */
export function layoutHints(l: ResolvedLayout): { label: string; cells: number | null; note: string }[] {
  const locs = (t: RoomType) => l.rooms.flatMap((r, i) => (r.type === t ? [{ i: i + 1, cap: r.capacity }] : []));
  const d = (a: number, b: number) => l.dist[a]![b]!;
  const nearest = (from: number, to: { i: number }[]) => (to.length ? Math.min(...to.map((t) => d(from, t.i))) : null);
  const station = locs('station')[0];
  const waiting = locs('waiting')[0];
  const beds = [...locs('acute'), ...locs('trauma')];
  const bedCap = beds.reduce((s, b) => s + b.cap, 0);
  const amb = l.ambulanceLoc ?? 0;
  return [
    { label: 'Staff station to beds', cells: station && bedCap ? Math.round(beds.reduce((s, b) => s + d(station.i, b.i) * b.cap, 0) / bedCap) : null, note: 'average per bed; walked for every task' },
    { label: 'Waiting room to triage', cells: waiting ? nearest(waiting.i, locs('triage')) : null, note: 'every walk-in patient' },
    { label: `${l.ambulanceLoc !== null ? 'Ambulance door' : 'Entrance'} to trauma room`, cells: nearest(amb, locs('trauma')), note: 'the sickest patients, on a trolley' },
    { label: 'Entrance to waiting room', cells: nearest(0, locs('waiting')), note: 'every walk-in patient' },
  ];
}

export interface FloorEditor {
  tool: Tool;
  setTool: (t: Tool) => void;
  /** The rectangle being dragged, in cells. */
  sel: { x: number; y: number; w: number; h: number } | null;
  message: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Pointer down / move / up on a grid cell (from the 2D grid or the 3D floor). */
  down: (c: Cell) => 'drag' | 'done';
  move: (c: Cell) => void;
  up: () => void;
  cancel: () => void;
  /** Apply a change with undo (e.g. a capacity stepper). */
  change: (next: LayoutSpec) => void;
}

/** The drawing rules shared by the 2D grid and the 3D builder: tools, validation, undo and redo. */
export function useFloorEditor(spec: LayoutSpec, onChange: (next: LayoutSpec) => void, tools: readonly Tool[]): FloorEditor {
  const [tool, setTool] = useState<Tool>(tools.find((t) => ROOM_TOOLS.has(t)) ?? 'erase');
  const [drag, setDrag] = useState<{ a: Cell; b: Cell } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [past, setPast] = useState<LayoutSpec[]>([]);
  const [future, setFuture] = useState<LayoutSpec[]>([]);

  const change = (next: LayoutSpec) => {
    setPast((p) => [...p.slice(-49), spec]);
    setFuture([]);
    setMessage(null);
    onChange(next);
  };
  const undo = () => {
    const prev = past.at(-1);
    if (!prev) return;
    setPast(past.slice(0, -1));
    setFuture([spec, ...future]);
    onChange(prev);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture(future.slice(1));
    setPast([...past, spec]);
    onChange(next);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const roomAt = (c: Cell) => spec.rooms.findIndex((r) => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h);
  /** Apply a change only if the plan stays valid for the part it touched. */
  const tryChange = (next: LayoutSpec, own: (p: string) => boolean) => {
    const bad = resolveLayout(next).problems.filter(own);
    if (bad.length) setMessage(bad[0]!);
    else change(next);
  };

  const down = (c: Cell): 'drag' | 'done' => {
    if (tool === 'erase') {
      const i = roomAt(c);
      if (i >= 0) change({ ...spec, rooms: spec.rooms.filter((_, j) => j !== i) });
      return 'done';
    }
    if (tool === 'entrance') return tryChange({ ...spec, entrance: c }, (p) => p.startsWith('entrance')), 'done';
    if (tool === 'ambulance') return tryChange({ ...spec, ambulanceDoor: c }, (p) => p.startsWith('ambulance')), 'done';
    if (tool === 'door') {
      const i = roomAt(c);
      if (i < 0) return setMessage('Click on the edge of a room to put its door there'), 'done';
      const r = spec.rooms[i]!;
      return tryChange({ ...spec, rooms: spec.rooms.map((x, j) => (j === i ? { ...x, door: c } : x)) }, (p) => p.startsWith(r.id)), 'done';
    }
    setDrag({ a: c, b: c });
    return 'drag';
  };
  const move = (c: Cell) => drag && (drag.b.x !== c.x || drag.b.y !== c.y) && setDrag({ ...drag, b: c });
  const up = () => {
    if (!drag || !ROOM_TOOLS.has(tool)) return;
    const type = tool as RoomType;
    const x = Math.min(drag.a.x, drag.b.x);
    const y = Math.min(drag.a.y, drag.b.y);
    const room: RoomSpec = { id: nextId(spec.rooms, type), type, x, y, w: Math.abs(drag.a.x - drag.b.x) + 1, h: Math.abs(drag.a.y - drag.b.y) + 1 };
    setDrag(null);
    tryChange({ ...spec, rooms: [...spec.rooms, room] }, (p) => p.startsWith(room.id));
  };
  const sel = drag && {
    x: Math.min(drag.a.x, drag.b.x),
    y: Math.min(drag.a.y, drag.b.y),
    w: Math.abs(drag.a.x - drag.b.x) + 1,
    h: Math.abs(drag.a.y - drag.b.y) + 1,
  };
  return {
    tool,
    setTool: (t) => {
      setTool(t);
      setMessage(null);
    },
    sel,
    message,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undo,
    redo,
    down,
    move,
    up,
    cancel: () => setDrag(null),
    change,
  };
}

/** The tool buttons with undo and redo. */
export function ToolBar({ ed, tools, vertical }: { ed: FloorEditor; tools: readonly Tool[]; vertical?: boolean }) {
  return (
    <div className={`tools ${vertical ? 'vertical' : ''}`} role="toolbar" aria-label="Tools">
      {tools.map((t) => (
        <button key={t} className={t === ed.tool ? 'on' : ''} aria-pressed={t === ed.tool} onClick={() => ed.setTool(t)} data-testid={`tool-${t}`}>
          {ROOM_TOOLS.has(t) && <span className={`swatch room-${t}`} />}
          {TOOL_LABEL[t]}
        </button>
      ))}
      <span className="push" />
      <button onClick={ed.undo} disabled={!ed.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="undo">
        ↶ Undo
      </button>
      <button onClick={ed.redo} disabled={!ed.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" data-testid="redo">
        ↷ Redo
      </button>
    </div>
  );
}

/** Rooms with their bed counts, and the walking distances that matter. */
export function RoomPanel({ spec, ed }: { spec: LayoutSpec; ed: FloorEditor }) {
  const resolved = useMemo(() => resolveLayout(spec), [spec]);
  const beds = (type: RoomType) => (resolved.layout?.rooms ?? []).filter((r) => r.type === type).reduce((s, r) => s + r.capacity, 0);
  const secondsPerCell = PARAMS.layout.minutesPerCell * 60;
  return (
    <div className="designer-grid">
      <section className="card room-list">
        <h3>Rooms</h3>
        <p className="muted">
          {beds('trauma')} trauma bays, {beds('acute')} acute beds{beds('fastTrack') ? `, ${beds('fastTrack')} fast-track beds` : ''}.
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
                    onChange={(capacity) => ed.change({ ...spec, rooms: spec.rooms.map((x, j) => (j === i ? { ...x, capacity } : x)) })}
                    label={`${r.id} capacity`}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      {resolved.layout && (
        <section className="card hints" data-testid="layout-hints">
          <h3>Walking distances</h3>
          <table className="metrics">
            <tbody>
              {layoutHints(resolved.layout).map((h) => (
                <tr key={h.label}>
                  <th scope="row">
                    {h.label}
                    <span className="muted small"> · {h.note}</span>
                  </th>
                  <td>{h.cells === null ? '—' : `${h.cells} squares · ${Math.round(h.cells * secondsPerCell)} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Shorter is better. Staff walk out and back for every task, so the station-to-beds distance counts twice.</p>
        </section>
      )}
    </div>
  );
}

export function FloorDesigner(props: {
  spec: LayoutSpec;
  onChange: (next: LayoutSpec) => void;
  /** Tools on offer (room types, door, entrance, ambulance, erase). */
  tools: readonly Tool[];
  /** Problems beyond the plan's own (e.g. a level's requirements), shown with it. */
  extraProblems?: string[];
}) {
  const { spec } = props;
  const ed = useFloorEditor(spec, props.onChange, props.tools);
  const footprint = Array.isArray(spec.footprint) ? spec.footprint : footprintPreset(spec.footprint.preset, spec.footprint.width, spec.footprint.height);
  const width = footprint[0]!.length;
  const height = footprint.length;
  const resolved = useMemo(() => resolveLayout(spec), [spec]);

  const cellAt = (e: React.PointerEvent<SVGSVGElement>): Cell => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(width - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * width))),
      y: Math.min(height - 1, Math.max(0, Math.floor(((e.clientY - box.top) / box.height) * height))),
    };
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (ed.down(cellAt(e)) === 'drag') e.currentTarget.setPointerCapture(e.pointerId);
  };

  const cellPx = 20;
  const sel = ed.sel;
  const problems = [...(resolved.layout ? [] : resolved.problems), ...(props.extraProblems ?? [])];

  return (
    <div className="floor-designer">
      <ToolBar ed={ed} tools={props.tools} />

      <div className="grid-wrap">
        <svg
          className="grid"
          viewBox={`0 0 ${width * cellPx} ${height * cellPx}`}
          onPointerDown={onDown}
          onPointerMove={(e) => ed.move(cellAt(e))}
          onPointerUp={ed.up}
          role="application"
          aria-label="Floor plan grid"
          data-testid="layout-grid"
        >
          {footprint.map((row, y) =>
            [...row].map((c, x) => <rect key={`${x},${y}`} x={x * cellPx} y={y * cellPx} width={cellPx} height={cellPx} className={c === '#' ? 'cell' : 'outside'} />),
          )}
          {spec.rooms.map((r) => (
            <g key={r.id}>
              <rect x={r.x * cellPx + 1} y={r.y * cellPx + 1} width={r.w * cellPx - 2} height={r.h * cellPx - 2} rx={3} className={`room room-${r.type}`} />
              <text x={r.x * cellPx + 4} y={r.y * cellPx + 13} className="room-label">
                {TOOL_LABEL[r.type]}
              </text>
            </g>
          ))}
          {resolved.layout?.rooms.map((r) => <rect key={`door-${r.id}`} x={r.door.x * cellPx + 6} y={r.door.y * cellPx + 6} width={8} height={8} className="door" />)}
          <rect x={spec.entrance.x * cellPx + 2} y={spec.entrance.y * cellPx + 2} width={cellPx - 4} height={cellPx - 4} className="entrance" />
          <text x={spec.entrance.x * cellPx + cellPx / 2} y={spec.entrance.y * cellPx + cellPx / 2 + 4} textAnchor="middle" className="marker-label">
            E
          </text>
          {spec.ambulanceDoor && (
            <>
              <rect x={spec.ambulanceDoor.x * cellPx + 2} y={spec.ambulanceDoor.y * cellPx + 2} width={cellPx - 4} height={cellPx - 4} className="ambulance-door" />
              <text x={spec.ambulanceDoor.x * cellPx + cellPx / 2} y={spec.ambulanceDoor.y * cellPx + cellPx / 2 + 4} textAnchor="middle" className="marker-label">
                A
              </text>
            </>
          )}
          {sel && <rect x={sel.x * cellPx} y={sel.y * cellPx} width={sel.w * cellPx} height={sel.h * cellPx} className={`drag room-${ed.tool}`} />}
        </svg>
      </div>
      <p className="muted small">
        Drag to draw a room. E: public entrance{spec.ambulanceDoor ? ' · A: ambulance door' : ''}. The small squares are doors
        {props.tools.includes('door') ? '; use “Move a door” and click a room’s edge to move one' : ''}.
      </p>

      {ed.message && (
        <p className="over" role="alert">
          {ed.message}
        </p>
      )}

      <RoomPanel spec={spec} ed={ed} />

      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function nextId(rooms: RoomSpec[], type: RoomType): string {
  for (let n = 1; ; n++) if (!rooms.some((r) => r.id === `${type}-${n}`)) return `${type}-${n}`;
}
