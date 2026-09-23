import { checkLayoutForSim, exampleLayout, FOOTPRINT_PRESETS, footprintPreset, resolveLayout, type FootprintPreset, type LayoutSpec } from '@er/sim';
import { useMemo, useState } from 'react';
import { minutes, percent } from '../format';
import { downloadJson, quickScore, type GameConfig, type QuickScore } from '../sandbox';
import { WalkMap } from '../play/WalkMap';
import { FloorDesigner, type Tool } from './FloorDesigner';
import { Stepper } from './ScheduleEditor';

const PRESET_LABEL: Record<FootprintPreset, string> = { rectangle: 'Rectangle', lShape: 'L-shape', uShape: 'U-shape', narrow: 'Long and narrow' };

/** The sandbox scenario a layout is tested in: a normal week, default staffing. */
export function layoutConfig(layout: LayoutSpec): GameConfig {
  return { id: 'layout-sandbox', name: 'Layout test', durationMinutes: 7 * 1440, warmupMinutes: 1440, modules: { layout: true }, layout };
}

export function LayoutEditor(props: { initial?: LayoutSpec; onPlay: (config: GameConfig) => void; onBack: () => void }) {
  const [spec, setSpec] = useState<LayoutSpec>(() => props.initial ?? exampleLayout());
  const [score, setScore] = useState<QuickScore | null>(null);
  const [best, setBest] = useState<QuickScore | null>(null);

  const fp = Array.isArray(spec.footprint) ? null : spec.footprint;
  const footprint = Array.isArray(spec.footprint) ? spec.footprint : footprintPreset(spec.footprint.preset, spec.footprint.width, spec.footprint.height);
  const width = footprint[0]!.length;
  const height = footprint.length;
  const resolved = useMemo(() => resolveLayout(spec), [spec]);
  const problems = resolved.layout ? checkLayoutForSim(resolved.layout, true) : resolved.problems;

  const change = (next: LayoutSpec) => {
    setSpec(next);
    setScore(null);
  };
  const setPreset = (preset: FootprintPreset, w: number, h: number) => change({ ...spec, footprint: { preset, width: w, height: h } });

  const test = () => {
    const s = quickScore(layoutConfig(spec));
    setScore(s);
    if (!best || s.doorToDoctorMean < best.doorToDoctorMean) setBest(s);
  };

  return (
    <main className="screen layout-editor">
      <p className="eyebrow">Sandbox · layout only</p>
      <h1>Design the floor</h1>
      <p className="muted">
        Draw rooms by dragging on the grid. Staff walk from their station to every patient and back, so distance costs time. Test the plan on a normal week to
        see how it performs and where everyone walked.
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

      <FloorDesigner spec={spec} onChange={change} tools={SANDBOX_TOOLS} extraProblems={resolved.layout ? problems : []} />

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
          {score.walks && <WalkMap layout={score.walks.layout} walks={score.walks.walks} caption="Where people walked (first run)" />}
        </section>
      )}
    </main>
  );
}

const SANDBOX_TOOLS: Tool[] = ['waiting', 'triage', 'trauma', 'acute', 'fastTrack', 'station', 'door', 'entrance', 'ambulance', 'erase'];

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
