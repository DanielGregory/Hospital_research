/**
 * Decisions during the shift: the level's quick controls, and the live calls (call in help,
 * divert ambulances, open hallway spaces, move a clinician). Sends commands; never simulates.
 */
import { PARAMS, type Acuity, type Command, type LiveCall, type PlayerControl, type QueueDiscipline, type SimSnapshot } from '@er/sim';
import type { SetupValues } from '../controls';
import { SimpleControl } from '../screens/Setup';
import { Stepper } from '../screens/ScheduleEditor';

/** Controls that change mid-shift with one click, and the command each one sends. */
export const QUICK: Partial<Record<PlayerControl, (v: unknown, all: SetupValues) => Command>> = {
  'queue.discipline': (v) => ({ type: 'setQueueDiscipline', discipline: v as QueueDiscipline }),
  'fastTrack.enabled': (v, all) => ({ type: 'setFastTrack', enabled: v === true, minAcuity: all['fastTrack.minAcuity'] as Acuity | undefined }),
  'fastTrack.minAcuity': (v, all) => ({ type: 'setFastTrack', enabled: all['fastTrack.enabled'] !== false, minAcuity: v as Acuity }),
  'staffing.doctors': (v) => ({ type: 'setStaff', role: 'doctor', count: Number(v) }),
  'staffing.triageNurses': (v) => ({ type: 'setStaff', role: 'triageNurse', count: Number(v) }),
  'staffing.fastTrackClinicians': (v) => ({ type: 'setStaff', role: 'fastTrackClinician', count: Number(v) }),
  'beds.main': (v) => ({ type: 'setBeds', lane: 'main', count: Number(v) }),
  'beds.fastTrack': (v) => ({ type: 'setBeds', lane: 'fastTrack', count: Number(v) }),
  'boarding.escalation': (v) => ({ type: 'setEscalation', enabled: v === true }),
};

/** Controls that belong in the plan drawer (they take more than one click). */
export const PLANNED: readonly PlayerControl[] = ['staffing.schedule.doctor', 'staffing.schedule.triageNurse', 'staffing.schedule.fastTrackClinician', 'process.steps', 'diagnosis.thoroughness'];

export function LivePanel(props: {
  controls: readonly PlayerControl[];
  calls: readonly LiveCall[];
  values: SetupValues;
  snap: SimSnapshot;
  hasLayout: boolean;
  onChange: (ctl: PlayerControl, v: unknown) => void;
  onCommand: (cmd: Command) => void;
  onPlan: (() => void) | null;
}) {
  const { snap, calls } = props;
  const quick = props.controls.filter((ctl) => QUICK[ctl] && !(ctl.startsWith('beds.') && props.hasLayout));
  const live = snap.live;
  const onDuty = (role: string) => snap.staff.filter((m) => m.role === role && !m.retiring).length;
  const hallwayPossible = snap.beds.main.capacity !== null;
  if (quick.length === 0 && calls.length === 0 && !props.onPlan) return null;
  return (
    <section className="card live-controls" data-coach="live">
      <h3>Right now</h3>
      {quick.map((ctl) => (
        <div key={ctl} data-coach={ctl}>
          <SimpleControl control={ctl} value={props.values[ctl]} onChange={(v) => props.onChange(ctl, v)} />
        </div>
      ))}
      {calls.length > 0 && <h4 className="calls-head">Calls</h4>}
      {calls.includes('callIn') && (
        <div className="call">
          <button onClick={() => props.onCommand({ type: 'callIn', role: 'doctor' })} disabled={live.callInsLeft === 0} data-testid="call-in">
            Call in the on-call doctor
          </button>
          <span className="muted">
            {live.callInsPending.length
              ? `On the way: here in ${Math.ceil(live.callInsPending[0]!.etaMinutes)} min`
              : `${live.callInsLeft} left · arrives in ${PARAMS.liveCalls.callInDelayMinutes} min, stays ${PARAMS.liveCalls.callInHours} h at ${PARAMS.liveCalls.callInWageMultiplier}× pay`}
          </span>
        </div>
      )}
      {calls.includes('diversion') && (
        <div className="call">
          <label className="check">
            <input type="checkbox" checked={live.diversion} onChange={(e) => props.onCommand({ type: 'setDiversion', enabled: e.target.checked })} data-testid="diversion" />{' '}
            Divert ambulances
          </label>
          <span className="muted">All but the most critical go to other hospitals. Costs money and goodwill.</span>
        </div>
      )}
      {calls.includes('hallway') && hallwayPossible && (
        <div className="call">
          <span className="call-row">
            Hallway spaces{' '}
            <Stepper value={live.hallwayBeds} min={0} max={PARAMS.liveCalls.maxHallwayBeds} onChange={(v) => props.onCommand({ type: 'setHallwayBeds', count: v })} label="Hallway spaces" />
          </span>
          <span className="muted">
            {live.hallwayInUse > 0 ? `${live.hallwayInUse} in use. ` : ''}Used only when every bed is full; care there is slower.
          </span>
        </div>
      )}
      {calls.includes('moveStaff') && (onDuty('fastTrackClinician') > 0 || onDuty('doctor') > 1) && (
        <div className="call move">
          <button onClick={() => props.onCommand({ type: 'moveStaff', from: 'fastTrackClinician', to: 'doctor' })} disabled={onDuty('fastTrackClinician') === 0}>
            Fast track → main ED
          </button>
          <button onClick={() => props.onCommand({ type: 'moveStaff', from: 'doctor', to: 'fastTrackClinician' })} disabled={onDuty('doctor') <= 1}>
            Main ED → fast track
          </button>
          <span className="muted">Moves one clinician now; shifts reset it at the next change of shift.</span>
        </div>
      )}
      {props.onPlan && (
        <button className="plan-button" onClick={props.onPlan} data-testid="adjust-plan">
          Adjust the plan…
        </button>
      )}
    </section>
  );
}
