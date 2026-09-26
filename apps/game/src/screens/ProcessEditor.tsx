import { ROLES, STEP_KINDS, type Acuity, type Role, type StepInput, type StepKind } from '@er/sim';
import { ROLE_LABEL } from '../controls';

const KIND_LABEL: Record<StepKind, string> = {
  registration: 'Registration',
  triage: 'Triage',
  vitals: 'Vitals',
  labs: 'Lab tests',
  imaging: 'Imaging',
  doctorEval: 'Doctor evaluation',
  workup: 'Waiting for results',
  disposition: 'Disposition (admit or discharge)',
};

/** A sensible step to start from when the player adds one. */
function newStep(kind: StepKind, id: string, after: string[]): StepInput {
  const base: Record<StepKind, Partial<StepInput>> = {
    registration: { role: 'triageNurse', meanMinutes: 3 },
    triage: { role: 'triageNurse', meanMinutes: 6 },
    vitals: { role: 'nurse', meanMinutes: 8, inBed: true },
    labs: { role: 'tech', meanMinutes: 5, turnaroundMinutes: 50, inBed: true },
    imaging: { role: 'tech', meanMinutes: 15, turnaroundMinutes: 25, inBed: true },
    doctorEval: { role: 'doctor', meanMinutes: 30, inBed: true, thoroughness: 0.5 },
    workup: { role: null, turnaroundMinutes: 60, inBed: true },
    disposition: { role: 'doctor', meanMinutes: 5, inBed: true },
  };
  return { id, kind, after, ...base[kind] };
}

/** A process with vitals, labs and imaging in parallel with the doctor. Used by the sandbox preset. */
export function detailedProcess(): StepInput[] {
  return [
    { id: 'triage', kind: 'triage', role: 'triageNurse', meanMinutes: 6 },
    { id: 'vitals', kind: 'vitals', role: 'nurse', meanMinutes: 8, after: ['triage'], inBed: true },
    {
      id: 'doctorEval',
      kind: 'doctorEval',
      role: 'doctor',
      meanMinutesByAcuity: { '1': 60, '2': 45, '3': 35, '4': 20, '5': 15 },
      after: ['vitals'],
      inBed: true,
      thoroughness: 0.5,
    },
    { id: 'labs', kind: 'labs', role: 'tech', meanMinutes: 5, turnaroundMinutes: 50, after: ['vitals'], inBed: true, maxAcuity: 3 },
    { id: 'imaging', kind: 'imaging', role: 'tech', meanMinutes: 15, turnaroundMinutes: 25, after: ['vitals'], inBed: true, maxAcuity: 3 },
    { id: 'disposition', kind: 'disposition', role: 'doctor', meanMinutes: 5, after: ['doctorEval', 'labs', 'imaging'], inBed: true },
  ];
}

/** Longest-path layers for drawing the graph left to right. */
export function graphLayers(steps: readonly StepInput[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const layer = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0; // cycle: validation reports it
    seen.add(id);
    const deps = (byId.get(id)?.after ?? []).filter((a) => byId.has(a));
    const l = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, seen))) : 0;
    layer.set(id, l);
    return l;
  };
  for (const s of steps) visit(s.id, new Set());
  return layer;
}

export function ProcessEditor(props: {
  steps: StepInput[];
  fastTrackFrom: Acuity | null;
  onChange: (steps: StepInput[]) => void;
  onFastTrackFrom: (a: Acuity | null) => void;
}) {
  const { steps, onChange } = props;
  const update = (i: number, patch: Partial<StepInput>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => {
    const id = steps[i]!.id;
    onChange(steps.filter((_, j) => j !== i).map((s) => ({ ...s, after: (s.after ?? []).filter((a) => a !== id) })));
  };
  const add = (kind: StepKind) => {
    let n = 1;
    while (steps.some((s) => s.id === `${kind}-${n}`)) n++;
    const dispo = steps.find((s) => s.kind === 'disposition');
    const step = newStep(kind, `${kind}-${n}`, steps.some((s) => s.id === 'triage') && kind !== 'triage' ? ['triage'] : []);
    // New steps finish before disposition.
    onChange([...steps.filter((s) => s !== dispo), step, ...(dispo ? [{ ...dispo, after: [...(dispo.after ?? []), step.id] }] : [])]);
  };

  return (
    <div data-testid="process-editor">
      <h3>Patient process</h3>
      <p className="muted">
        Each step is done by one role. A step starts when every step it follows is done; steps with the same predecessors run at the same time. Disposition
        always runs last.
      </p>
      <ProcessGraph steps={steps} />
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.id} className="step-card">
            <div className="step-head">
              <strong>{KIND_LABEL[s.kind]}</strong> <span className="muted">({s.id})</span>
              {s.kind !== 'disposition' && (
                <button className="icon" onClick={() => remove(i)} aria-label={`Remove ${s.id}`}>
                  ×
                </button>
              )}
            </div>
            <div className="step-fields">
              <label>
                Done by{' '}
                <select value={s.role ?? ''} onChange={(e) => update(i, { role: (e.target.value || null) as Role | null })}>
                  <option value="">nobody (a wait)</option>
                  {ROLES.filter((r) => r !== 'fastTrackClinician').map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Staff minutes{' '}
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={s.meanMinutes ?? Number(Object.values(s.meanMinutesByAcuity ?? {})[2] ?? 0)}
                  onChange={(e) => update(i, { meanMinutes: Math.max(0, Number(e.target.value)), meanMinutesByAcuity: undefined })}
                />
              </label>
              <label>
                Then wait (min){' '}
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={s.turnaroundMinutes ?? 0}
                  onChange={(e) => update(i, { turnaroundMinutes: Math.max(0, Number(e.target.value)) })}
                />
              </label>
              <label>
                <input type="checkbox" checked={s.inBed === true} onChange={(e) => update(i, { inBed: e.target.checked })} /> In a bed
              </label>
              {s.kind !== 'disposition' && s.kind !== 'triage' && (
                <label>
                  For ESI{' '}
                  <select value={s.minAcuity ?? 1} onChange={(e) => update(i, { minAcuity: Number(e.target.value) as Acuity })} aria-label="From ESI">
                    {[1, 2, 3, 4, 5].map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  –
                  <select value={s.maxAcuity ?? 5} onChange={(e) => update(i, { maxAcuity: Number(e.target.value) as Acuity })} aria-label="To ESI">
                    {[1, 2, 3, 4, 5].map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
              )}
              {['doctorEval', 'labs', 'imaging', 'vitals'].includes(s.kind) && (
                <label className="thorough">
                  Thoroughness {Math.round((s.thoroughness ?? 0.5) * 100)}%
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={s.thoroughness ?? 0.5}
                    onChange={(e) => update(i, { thoroughness: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>
            {steps.length > 1 && (
              <div className="step-after">
                After:{' '}
                {steps
                  .filter((o) => o.id !== s.id && o.kind !== 'disposition')
                  .map((o) => (
                    <label key={o.id}>
                      <input
                        type="checkbox"
                        checked={(s.after ?? []).includes(o.id)}
                        onChange={(e) => update(i, { after: e.target.checked ? [...(s.after ?? []), o.id] : (s.after ?? []).filter((a) => a !== o.id) })}
                      />{' '}
                      {o.id}
                    </label>
                  ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="actions">
        {STEP_KINDS.filter((k) => k !== 'disposition' && !(k === 'triage' && steps.some((s) => s.kind === 'triage'))).map((k) => (
          <button key={k} onClick={() => add(k)}>
            + {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <label className="control">
        Fast track takes triage level{' '}
        <select
          value={props.fastTrackFrom ?? ''}
          onChange={(e) => props.onFastTrackFrom(e.target.value ? (Number(e.target.value) as Acuity) : null)}
          aria-label="Fast-track routing"
        >
          <option value="">(no fast track)</option>
          <option value="4">4 and 5</option>
          <option value="5">5 only</option>
        </select>
      </label>
    </div>
  );
}

function ProcessGraph({ steps }: { steps: readonly StepInput[] }) {
  const layers = graphLayers(steps);
  const cols = Math.max(0, ...layers.values()) + 1;
  const rowsIn = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const s of steps) {
    const l = layers.get(s.id) ?? 0;
    const r = rowsIn.get(l) ?? 0;
    rowsIn.set(l, r + 1);
    pos.set(s.id, { x: 10 + l * 170, y: 10 + r * 44 });
  }
  const h = 20 + Math.max(1, ...rowsIn.values()) * 44;
  return (
    <svg className="process-graph" viewBox={`0 0 ${cols * 170 + 10} ${h}`} role="img" aria-label="Process graph">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
        </marker>
      </defs>
      {steps.flatMap((s) =>
        (s.after ?? [])
          .filter((a) => pos.has(a))
          .map((a) => {
            const from = pos.get(a)!;
            const to = pos.get(s.id)!;
            return <line key={`${a}->${s.id}`} x1={from.x + 140} y1={from.y + 15} x2={to.x} y2={to.y + 15} className="edge" markerEnd="url(#arrow)" />;
          }),
      )}
      {steps.map((s) => {
        const p = pos.get(s.id)!;
        return (
          <g key={s.id}>
            <rect x={p.x} y={p.y} width={140} height={30} rx={6} className={`node ${s.inBed ? 'in-bed' : ''}`} />
            <text x={p.x + 8} y={p.y + 19} className="node-label">
              {KIND_LABEL[s.kind].split(' (')[0]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
