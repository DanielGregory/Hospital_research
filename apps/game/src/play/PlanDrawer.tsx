/**
 * Change the plan mid-shift: shift patterns, the patient process and how thorough doctors are.
 * The game is paused while this is open. Changes are sent as commands when the player applies them.
 */
import { pipelineAsSteps, resolveConfig, type Acuity, type Command, type PlayerControl, type Shift, type StepInput } from '@er/sim';
import { useState } from 'react';
import { buildConfig, scheduleRole, type SetupValues } from '../controls';
import type { LevelConfig } from '../levels';
import { ProcessEditor } from '../screens/ProcessEditor';
import { ScheduleEditor } from '../screens/ScheduleEditor';
import { SimpleControl } from '../screens/Setup';

export interface PlanState {
  values: SetupValues;
  steps: StepInput[] | null;
  fastTrackFrom: Acuity | null;
}

/** The plan in force at the start of a run. */
export function initialPlan(config: unknown, values: SetupValues): PlanState {
  const r = resolveConfig(config);
  const rule = r.routing.find((x) => x.lane === 'fastTrack');
  return { values, steps: r.modules.process ? pipelineAsSteps(r.pipeline) : null, fastTrackFrom: rule ? rule.minAcuity : null };
}

export function PlanDrawer(props: {
  level: LevelConfig | null;
  controls: readonly PlayerControl[];
  plan: PlanState;
  onApply: (next: PlanState, commands: Command[]) => void;
  onClose: () => void;
}) {
  const { level, controls } = props;
  const [draft, setDraft] = useState<PlanState>(props.plan);
  const [problem, setProblem] = useState<string | null>(null);
  const schedules = controls.filter(scheduleRole);
  const setValue = (ctl: PlayerControl, v: unknown) => setDraft({ ...draft, values: { ...draft.values, [ctl]: v } });

  const apply = () => {
    const cmds: Command[] = [];
    for (const ctl of schedules) {
      const before = JSON.stringify(props.plan.values[ctl]);
      const after = JSON.stringify(draft.values[ctl]);
      if (before !== after) cmds.push({ type: 'setSchedule', role: scheduleRole(ctl)!, shifts: draft.values[ctl] as Shift[] });
    }
    if (controls.includes('diagnosis.thoroughness') && draft.values['diagnosis.thoroughness'] !== props.plan.values['diagnosis.thoroughness'])
      cmds.push({ type: 'setThoroughness', value: Number(draft.values['diagnosis.thoroughness']) });
    if (draft.steps && (JSON.stringify(draft.steps) !== JSON.stringify(props.plan.steps) || draft.fastTrackFrom !== props.plan.fastTrackFrom))
      cmds.push({
        type: 'setProcess',
        steps: draft.steps,
        routing: draft.fastTrackFrom !== null ? [{ minAcuity: draft.fastTrackFrom, maxAcuity: 5, lane: 'fastTrack' }] : [],
      });
    setProblem(null);
    try {
      props.onApply(draft, cmds);
    } catch (e) {
      setProblem(e instanceof Error ? e.message.replace(/^Invalid config:\s*-?\s*/, '') : String(e));
    }
  };

  const config = level ? buildConfig(level, draft.values) : null;
  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Adjust the plan">
      <div className="drawer card">
        <header className="drawer-head">
          <div>
            <p className="eyebrow">Paused</p>
            <h2>Adjust the plan</h2>
          </div>
          <button className="ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {schedules.length > 0 && config && (
          <>
            <p className="muted">New shift patterns start at the next change of shift; people already on duty finish theirs.</p>
            {schedules.map((ctl) => (
              <ScheduleEditor key={ctl} role={scheduleRole(ctl)!} shifts={(draft.values[ctl] as Shift[]) ?? []} config={config} onChange={(s) => setValue(ctl, s)} />
            ))}
          </>
        )}
        {controls.includes('diagnosis.thoroughness') && (
          <section className="card">
            <SimpleControl control="diagnosis.thoroughness" value={draft.values['diagnosis.thoroughness']} onChange={(v) => setValue('diagnosis.thoroughness', v)} />
            <p className="muted" style={{ marginBottom: 0 }}>
              Applies to patients who arrive from now on.
            </p>
          </section>
        )}
        {draft.steps && (
          <section className="card process-editor">
            <p className="muted" style={{ marginTop: 0 }}>
              The new process applies to patients who arrive from now on. Patients already here keep the plan they started on.
            </p>
            <ProcessEditor
              steps={draft.steps}
              fastTrackFrom={draft.fastTrackFrom}
              onChange={(steps) => setDraft({ ...draft, steps })}
              onFastTrackFrom={(fastTrackFrom) => setDraft({ ...draft, fastTrackFrom })}
            />
          </section>
        )}
        {problem && (
          <ul className="problems" role="alert">
            <li>{problem}</li>
          </ul>
        )}
        <div className="actions">
          <button onClick={props.onClose}>Cancel</button>
          <button className="primary push" onClick={apply} data-testid="apply-plan">
            Apply and resume
          </button>
        </div>
      </div>
    </div>
  );
}
