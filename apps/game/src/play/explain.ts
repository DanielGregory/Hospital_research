/**
 * Plain-language reasons for how a shift went, from its metrics, timeline and commands. The
 * debrief shows these so the player sees cause and effect, not just a score.
 */
import { WAIT_CAUSES, type Metrics, type TimedCommand, type TimelineSample, type WaitCause } from '@er/sim';
import { clockLabel } from '../format';

export const WAIT_LABEL: Record<WaitCause, string> = {
  triage: 'waiting for triage',
  bed: 'waiting for a bed',
  doctor: 'waiting for a doctor',
  results: 'waiting for test results',
  boarding: 'admitted, waiting for a ward bed',
};

export interface Explanation {
  /** Most important first. */
  lines: string[];
  /** Largest share of waiting, if any waiting happened. */
  bottleneck: { cause: WaitCause; share: number; hours: number } | null;
  /** Worst half-hour: most people waiting. */
  peak: { minute: number; waiting: number } | null;
}

export function explain(m: Metrics, timeline: readonly TimelineSample[], log: readonly TimedCommand[], clock: { startDayOfWeek: number; startHour: number }): Explanation {
  const lines: string[] = [];
  const total = WAIT_CAUSES.reduce((s, k) => s + m.waits[k], 0);
  const top = total > 0 ? [...WAIT_CAUSES].sort((a, b) => m.waits[b] - m.waits[a])[0]! : null;
  const bottleneck = top ? { cause: top, share: m.waits[top] / total, hours: m.waits[top] } : null;
  const peakSample = timeline.length ? timeline.reduce((a, b) => (b.waiting > a.waiting ? b : a)) : null;
  const peak = peakSample && peakSample.waiting > 0 ? { minute: peakSample.minute, waiting: peakSample.waiting } : null;
  const at = (min: number) => clockLabel(clock.startDayOfWeek, clock.startHour, min).split(' ').pop()!;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const hrs = (h: number) => (h >= 10 ? `${Math.round(h)} hours` : `${h.toFixed(1)} hours`);

  if (bottleneck) {
    const { cause, share, hours } = bottleneck;
    const lead = `The biggest share of waiting (${pct(share)}, ${hrs(hours)} across all patients) was ${WAIT_LABEL[cause]}.`;
    const why: Record<WaitCause, string> = {
      triage: ' The triage desk could not keep up: more triage nurses, or fewer steps before triage, would have helped.',
      bed: ` Beds were the constraint${m.bedOccupancy.main !== null ? `: the main ED was ${pct(m.bedOccupancy.main)} full on average` : ''}. More beds, hallway spaces or a fast track move people through.`,
      doctor: ` Doctors were busy ${pct(m.utilizationByRole.doctor ?? 0)} of the time. Past about 85% busy, queues grow very fast: another doctor at the peak would have made a big difference.`,
      results: ' Test results held patients in beds. A leaner process for minor cases (fewer tests) frees beds sooner.',
      boarding: ` Admitted patients spent ${hrs(m.boarding.hours)} in ED beds waiting for the wards. More ED staff barely helps; the full-capacity protocol and freeing beds do.`,
    };
    lines.push(lead + why[cause]);
  }
  if (peak && peak.waiting >= 5) lines.push(`The worst moment was around ${at(peak.minute)}, with ${peak.waiting} people not yet seen by a doctor.`);
  if (m.lwbsCount > 0) lines.push(`${m.lwbsCount} ${m.lwbsCount === 1 ? 'person' : 'people'} gave up and left without being seen.`);
  if (m.deterioration.critical > 0)
    lines.push(`${m.deterioration.critical} ${m.deterioration.critical === 1 ? 'patient' : 'patients'} became critical (ESI 1) while waiting to be seen.`);
  if (m.diagnosis.bounceBacks72h > 0) {
    const later = m.diagnosis.bounceBacksAfterRun;
    lines.push(
      `${m.diagnosis.bounceBacks72h} ${m.diagnosis.bounceBacks72h === 1 ? 'patient' : 'patients'} you sent home had something missed and will come back sicker within 72 hours` +
        (later > 0 ? ` (${later} after this shift ended).` : '.'),
    );
  }
  const calls: string[] = [];
  if (m.live.callIns > 0) calls.push(`called in ${m.live.callIns} on-call ${m.live.callIns === 1 ? 'doctor' : 'staff'}`);
  if (m.live.diverted > 0) calls.push(`diverted ${m.live.diverted} ambulance ${m.live.diverted === 1 ? 'patient' : 'patients'} to other hospitals`);
  if (m.live.hallwayPatients > 0) calls.push(`treated ${m.live.hallwayPatients} in hallway spaces`);
  const changes = log.filter((c) => c.command.type === 'setProcess' || c.command.type === 'setSchedule').length;
  if (changes > 0) calls.push(`changed the plan ${changes} ${changes === 1 ? 'time' : 'times'} mid-shift`);
  if (calls.length) lines.push(`You ${joinAnd(calls)}.`);
  return { lines, bottleneck, peak };
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** Short label for a logged command, for timeline markers. */
export function commandLabel(c: TimedCommand['command']): string {
  switch (c.type) {
    case 'callIn':
      return 'Called in help';
    case 'setDiversion':
      return c.enabled ? 'Diversion on' : 'Diversion off';
    case 'setHallwayBeds':
      return `Hallway spaces: ${c.count}`;
    case 'moveStaff':
      return 'Moved staff';
    case 'setProcess':
      return 'New process';
    case 'setThoroughness':
      return 'Thoroughness';
    case 'setSchedule':
      return 'New shifts';
    case 'setStaff':
      return 'Staffing';
    case 'setQueueDiscipline':
      return c.discipline === 'acuity' ? 'Sickest first' : 'Arrival order';
    case 'setFastTrack':
      return c.enabled ? 'Fast track open' : 'Fast track closed';
    case 'setBeds':
      return 'Beds';
    case 'setEscalation':
      return c.enabled ? 'Full-capacity protocol' : 'Protocol off';
  }
}
