/**
 * JSON-lines protocol for driving a simulation from another process (e.g. the
 * Python wrapper). One request per line on stdin, one response per line on stdout.
 *
 *   {"op":"reset","config":{...},"seed":1}              -> {"ok":true,"obs":{...}}
 *   {"op":"step","commands":[...],"minutes":60}         -> {"ok":true,"obs":{...},"done":false}
 *   {"op":"metrics"}                                     -> {"ok":true,"metrics":{...}}
 *   {"op":"close"}                                       -> {"ok":true}
 * Errors: {"ok":false,"error":"..."}.
 */
import { Simulation, type Command, type SimSnapshot } from '@er/sim';

export interface Observation {
  now: number;
  duration: number;
  /** Not yet seen by a doctor, by assigned acuity ("0" = not triaged). */
  waitingByAcuity: Record<string, number>;
  waitingForBed: number;
  bedsOccupied: { main: number; fastTrack: number };
  bedCapacity: { main: number | null; fastTrack: number | null };
  boarders: number;
  inpatientFree: number | null;
  staff: Record<string, { onDuty: number; busy: number; meanFatigue: number }>;
  fastTrackOpen: boolean;
  escalated: boolean;
  /** Running totals since t = 0, for reward shaping. */
  totals: { arrived: number; discharged: number; admitted: number; lwbs: number; bounceBacks: number; deteriorations: number; waitingPatientMinutes: number };
}

export function observe(sim: Simulation): Observation {
  const s: SimSnapshot = sim.snapshot();
  const waitingByAcuity: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  const P = sim.allPatients();
  for (const p of s.patients) if (!p.boarding && P[p.id]!.doctorStartTime === undefined) waitingByAcuity[String(p.assignedAcuity ?? 0)]!++;
  const staff: Observation['staff'] = {};
  for (const m of s.staff) {
    const r = (staff[m.role] ??= { onDuty: 0, busy: 0, meanFatigue: 0 });
    r.onDuty++;
    if (m.busy) r.busy++;
    r.meanFatigue += m.fatigue;
  }
  for (const r of Object.values(staff)) r.meanFatigue = r.onDuty ? r.meanFatigue / r.onDuty : 0;
  return {
    now: s.now,
    duration: s.durationMinutes,
    waitingByAcuity,
    waitingForBed: s.patients.filter((p) => p.waitingFor === 'bed').length,
    bedsOccupied: { main: s.beds.main.occupied, fastTrack: s.beds.fastTrack.occupied },
    bedCapacity: { main: s.beds.main.capacity, fastTrack: s.beds.fastTrack.capacity },
    boarders: s.inpatient?.boarders ?? 0,
    inpatientFree: s.inpatient ? s.inpatient.capacity - s.inpatient.occupied : null,
    staff,
    fastTrackOpen: s.settings.fastTrackOpen,
    escalated: s.inpatient?.escalated ?? false,
    totals: { ...s.totals, waitingPatientMinutes: sim.tw.waiting.integral(s.now) },
  };
}

/** Handle one request against the current session. */
export class Session {
  private sim: Simulation | null = null;

  handle(req: unknown): unknown {
    try {
      if (typeof req !== 'object' || req === null) throw new Error('request must be a JSON object');
      const r = req as Record<string, unknown>;
      switch (r.op) {
        case 'reset': {
          const seed = r.seed ?? 1;
          if (typeof seed !== 'number') throw new Error('seed must be a number');
          this.sim = new Simulation(r.config, seed);
          return { ok: true, obs: observe(this.sim) };
        }
        case 'step': {
          const sim = this.need();
          for (const cmd of (r.commands as Command[] | undefined) ?? []) sim.command(cmd);
          const minutes = r.minutes ?? 60;
          if (typeof minutes !== 'number' || !(minutes > 0)) throw new Error('minutes must be a positive number');
          sim.runUntil(sim.now + minutes);
          return { ok: true, obs: observe(sim), done: sim.finished };
        }
        case 'metrics':
          return { ok: true, metrics: this.need().metrics() };
        case 'close':
          this.sim = null;
          return { ok: true };
        default:
          throw new Error(`unknown op '${String(r.op)}'`);
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private need(): Simulation {
    if (!this.sim) throw new Error('no simulation: send reset first');
    return this.sim;
  }
}
