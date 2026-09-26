/**
 * Baseline policies: simple controllers that watch the department and issue
 * commands during a run, like a charge nurse would. They are the yardstick for
 * learned policies (RL agents) and a way to test "rules of thumb" headlessly.
 */
import { Simulation, type Command, type RunResult, type SimSnapshot } from '@er/sim';

export interface Policy {
  name: string;
  /** Called every `everyMinutes`; returns commands to apply now. */
  decide(s: SimSnapshot): Command[];
}

/** Run a config with a policy in the loop. Deterministic for a given seed. */
export function runWithPolicy(config: unknown, seed: number, policy: Policy, everyMinutes = 15): RunResult {
  const sim = new Simulation(config, seed);
  for (let t = 0; !sim.finished; t += everyMinutes) {
    sim.runUntil(t);
    for (const cmd of policy.decide(sim.snapshot())) sim.command(cmd);
  }
  return sim.run();
}

/** Does nothing: the setup as configured. */
export const staticPolicy: Policy = { name: 'static', decide: () => [] };

const notSeen = (s: SimSnapshot) => s.patients.filter((p) => p.location !== 'bed' || p.staffIds.length === 0).filter((p) => !p.boarding).length;
const onDuty = (s: SimSnapshot, role: string) => s.staff.filter((x) => x.role === role && !x.retiring).length;

/**
 * Call in an extra doctor when the waiting count per doctor passes `callAt`,
 * send one home when it drops below `releaseAt`, between `min` and `max` doctors.
 */
export function surgeStaffing(opts: { callAt?: number; releaseAt?: number; min?: number; max?: number } = {}): Policy {
  const { callAt = 4, releaseAt = 1, min = 2, max = 8 } = opts;
  return {
    name: `surge-staffing(${callAt},${releaseAt},${min}-${max})`,
    decide(s) {
      const doctors = onDuty(s, 'doctor');
      const perDoctor = notSeen(s) / Math.max(1, doctors);
      if (perDoctor > callAt && doctors < max) return [{ type: 'setStaff', role: 'doctor', count: doctors + 1 }];
      if (perDoctor < releaseAt && doctors > min) return [{ type: 'setStaff', role: 'doctor', count: doctors - 1 }];
      return [];
    },
  };
}

/** Open the fast track while minor cases are piling up (needs fast-track clinicians on duty). */
export function fastTrackWhenBusy(opts: { openAt?: number; closeAt?: number } = {}): Policy {
  const { openAt = 3, closeAt = 0 } = opts;
  return {
    name: `fast-track-when-busy(${openAt},${closeAt})`,
    decide(s) {
      const minors = s.patients.filter((p) => (p.assignedAcuity ?? 0) >= 4 && p.location !== 'bed').length;
      if (!s.settings.fastTrackEnabled && minors >= openAt) return [{ type: 'setFastTrack', enabled: true }];
      if (s.settings.fastTrackEnabled && minors <= closeAt) return [{ type: 'setFastTrack', enabled: false }];
      return [];
    },
  };
}

/** Declare the hospital full-capacity protocol while boarders exceed `declareAt`. */
export function escalateWhenBoarding(opts: { declareAt?: number; standDownAt?: number } = {}): Policy {
  const { declareAt = 4, standDownAt = 1 } = opts;
  return {
    name: `escalate-when-boarding(${declareAt},${standDownAt})`,
    decide(s) {
      if (!s.inpatient) return [];
      if (!s.inpatient.escalated && s.inpatient.boarders >= declareAt) return [{ type: 'setEscalation', enabled: true }];
      if (s.inpatient.escalated && s.inpatient.boarders <= standDownAt) return [{ type: 'setEscalation', enabled: false }];
      return [];
    },
  };
}

/** Run several policies in turn each tick. */
export function combine(...policies: Policy[]): Policy {
  return { name: policies.map((p) => p.name).join('+'), decide: (s) => policies.flatMap((p) => p.decide(s)) };
}

export const BASELINES: Record<string, () => Policy> = {
  static: () => staticPolicy,
  'surge-staffing': () => surgeStaffing(),
  'fast-track-when-busy': () => fastTrackWhenBusy(),
  'escalate-when-boarding': () => escalateWhenBoarding(),
  'all-heuristics': () => combine(surgeStaffing(), fastTrackWhenBusy(), escalateWhenBoarding()),
};
