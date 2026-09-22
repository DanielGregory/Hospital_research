/**
 * Discrete-event simulation of the ED.
 *
 * Default pipeline (the `process` module will make this editable in Phase 5):
 *   arrival -> [triage queue -> triage nurse] -> doctor queue -> doctor -> discharge
 * with an optional fast-track lane for low-acuity patients (free main-ED doctors
 * pick up fast-track overflow unless told not to) and LWBS from any
 * waiting line. Staff counts are fixed, or follow shift schedules when the
 * `staffing` module is on.
 *
 * The engine has no notion of wall-clock time or rendering. A front end drives
 * it with `runUntil(t)` at whatever speed it likes, reads `snapshot()`, and
 * changes things only through `command()`.
 */

import { ArrivalProcess } from './arrivals.js';
import { checkCommand, ConfigError, resolveConfig, type ResolvedConfig } from './config.js';
import { EventQueue } from './eventQueue.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { PatientQueue } from './patientQueue.js';
import { Rng } from './rng.js';
import { onDutyCount, scheduleBoundaries } from './schedule.js';
import { TimeWeighted } from './stats.js';
import {
  ACUITIES,
  ROLES,
  type Acuity,
  type Command,
  type Lane,
  type Patient,
  type QueueDiscipline,
  type Role,
  type Shift,
  type TimedCommand,
} from './types.js';

type SimEvent =
  | { kind: 'arrival' }
  | { kind: 'triageEnd'; staffId: number }
  | { kind: 'treatmentEnd'; staffId: number }
  | { kind: 'abandon'; patientId: number }
  | { kind: 'shift'; role: Role; version: number }
  | { kind: 'command'; command: Command };

/** Tie-break among events at the same instant. Commands run last so live and replayed commands match. */
const PRIORITY = { triageEnd: 0, treatmentEnd: 0, shift: 1, abandon: 2, arrival: 3, command: 4 } as const;

interface Staff {
  id: number;
  role: Role;
  patientId: number | null;
  /** Leaves once the current patient is done (count reduced while busy). */
  retiring: boolean;
}

/** Where a patient is, for renderers. */
export type PatientLocation = 'waitingTriage' | 'triage' | 'waitingDoctor' | 'waitingFastTrack' | 'doctor' | 'fastTrack';

/** What the player may see about a patient. True acuity is included for debrief/debug views only. */
export interface PatientView {
  id: number;
  location: PatientLocation;
  /** Undefined until triaged. */
  assignedAcuity?: Acuity;
  trueAcuity: Acuity;
  arrivalTime: number;
  /** Staff member currently with them. */
  staffId?: number;
}

export interface SimSnapshot {
  now: number;
  /** Everyone currently in the department, in id order. */
  patients: PatientView[];
  durationMinutes: number;
  finished: boolean;
  /** In service order. */
  waitingTriage: { id: number; trueAcuity: Acuity; arrivalTime: number }[];
  waitingDoctor: Record<Lane, { id: number; trueAcuity: Acuity; assignedAcuity?: Acuity; arrivalTime: number }[]>;
  inTriage: { id: number; trueAcuity: Acuity; staffId: number; startedAt: number }[];
  withDoctor: { id: number; trueAcuity: Acuity; assignedAcuity?: Acuity; staffId: number; lane: Lane; startedAt: number }[];
  staff: { id: number; role: Role; busy: boolean; retiring: boolean }[];
  settings: { discipline: QueueDiscipline; fastTrackEnabled: boolean; fastTrackOpen: boolean; fastTrackMinAcuity: Acuity };
  totals: { arrived: number; treated: number; lwbs: number };
}

export interface RunResult {
  metrics: Metrics;
  commandLog: TimedCommand[];
}

export class Simulation {
  readonly config: ResolvedConfig;
  readonly seed: number;

  private clock = 0;
  private readonly calendarOffset: number;
  private readonly events = new EventQueue<SimEvent>();
  private readonly arrivals: ArrivalProcess;
  private readonly rng: Record<'acuity' | 'service' | 'triageTime' | 'triageResult' | 'patience', Rng>;
  private readonly acuityWeights: number[];

  private readonly patients: Patient[] = [];
  private readonly triageQueue = new PatientQueue();
  private readonly doctorQueues: Record<Lane, PatientQueue> = { main: new PatientQueue(), fastTrack: new PatientQueue() };
  private readonly staff: Staff[] = [];
  private nextStaffId = 0;
  private treated = 0;
  private lwbs = 0;
  private readonly log: TimedCommand[] = [];

  // Live settings (commands change these).
  private discipline: QueueDiscipline;
  private fastTrackEnabled: boolean;
  private fastTrackMinAcuity: Acuity;
  private fastTrackWasOpen = false;
  private readonly schedule: Partial<Record<Role, Shift[]>>;
  private readonly scheduleVersion: Record<Role, number> = { triageNurse: 0, doctor: 0, fastTrackClinician: 0 };

  /** Time-weighted accumulators over [warmup, duration]. */
  readonly tw: {
    inSystem: TimeWeighted;
    waiting: TimeWeighted;
    busy: Record<Role, TimeWeighted>;
    onDuty: Record<Role, TimeWeighted>;
  };

  constructor(rawConfig: unknown, seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`);
    this.config = resolveConfig(rawConfig);
    this.seed = seed;
    const c = this.config;
    const root = new Rng(seed);
    this.arrivals = new ArrivalProcess(c, root.stream('arrivals'));
    this.rng = {
      acuity: root.stream('acuity'),
      service: root.stream('service'),
      triageTime: root.stream('triageTime'),
      triageResult: root.stream('triageResult'),
      patience: root.stream('patience'),
    };
    this.acuityWeights = ACUITIES.map((a) => c.acuityMix[a]);
    this.calendarOffset = (c.startDayOfWeek * 24 + c.startHour) * 60;
    this.discipline = c.discipline;
    this.fastTrackEnabled = c.fastTrack.enabled;
    this.fastTrackMinAcuity = c.fastTrack.minAcuity;
    this.schedule = c.modules.staffing ? { ...c.schedule } : {};

    const [w0, w1] = [c.warmupMinutes, c.durationMinutes];
    const perRole = () => Object.fromEntries(ROLES.map((r) => [r, new TimeWeighted(w0, w1)])) as Record<Role, TimeWeighted>;
    this.tw = { inSystem: new TimeWeighted(w0, w1), waiting: new TimeWeighted(w0, w1), busy: perRole(), onDuty: perRole() };

    for (const role of ROLES) {
      const shifts = this.schedule[role];
      this.setCount(role, shifts ? onDutyCount(shifts, this.calendarOffset, 0) : c.staff[role]);
      if (shifts) this.scheduleShiftEvents(role);
    }
    this.fastTrackWasOpen = this.fastTrackOpen();
    this.updateCounters();

    for (const tc of c.commands) this.events.push(tc.atMinute, { kind: 'command', command: tc.command }, PRIORITY.command);
    this.scheduleNextArrival(0);
  }

  get now(): number {
    return this.clock;
  }

  get finished(): boolean {
    return this.clock >= this.config.durationMinutes;
  }

  /** Process every event with time <= t (capped at the run's duration), then set the clock to t. */
  runUntil(t: number): void {
    const until = Math.min(t, this.config.durationMinutes);
    for (;;) {
      const next = this.events.peek();
      if (!next || next.time > until) break;
      this.events.pop();
      this.clock = next.time;
      this.handle(next.event);
    }
    if (until > this.clock) this.clock = until;
  }

  /** Run to the end and return metrics. */
  run(): RunResult {
    this.runUntil(this.config.durationMinutes);
    return { metrics: this.metrics(), commandLog: this.commandLog() };
  }

  /**
   * Apply a player/policy command now. Every command is logged with its time,
   * so feeding `commandLog()` back in as config `commands` replays the run exactly.
   */
  command(cmd: Command): void {
    const problems = checkCommand(cmd, 'command');
    if (problems.length > 0) throw new ConfigError(problems);
    if (cmd.type === 'setSchedule' && !this.config.modules.staffing)
      throw new ConfigError(['command: setSchedule needs the staffing module on']);
    this.apply(JSON.parse(JSON.stringify(cmd)) as Command);
  }

  commandLog(): TimedCommand[] {
    return JSON.parse(JSON.stringify(this.log)) as TimedCommand[];
  }

  metrics(): Metrics {
    return computeMetrics(this);
  }

  /** Read-only view for renderers. Returns fresh objects every call. */
  snapshot(): SimSnapshot {
    const P = (id: number) => this.patients[id]!;
    const doctorLine = (lane: Lane) =>
      this.doctorQueues[lane].ids().map((id) => {
        const p = P(id);
        return { id, trueAcuity: p.trueAcuity, assignedAcuity: p.assignedAcuity, arrivalTime: p.arrivalTime };
      });
    const inTriage: SimSnapshot['inTriage'] = [];
    const withDoctor: SimSnapshot['withDoctor'] = [];
    for (const s of this.staff) {
      if (s.patientId === null) continue;
      const p = P(s.patientId);
      if (s.role === 'triageNurse') inTriage.push({ id: p.id, trueAcuity: p.trueAcuity, staffId: s.id, startedAt: p.triageStartTime! });
      else
        withDoctor.push({
          id: p.id,
          trueAcuity: p.trueAcuity,
          assignedAcuity: p.assignedAcuity,
          staffId: s.id,
          lane: p.lane!,
          startedAt: p.doctorStartTime!,
        });
    }
    const patients: PatientView[] = [];
    const view = (id: number, location: PatientLocation, staffId?: number) => {
      const p = P(id);
      patients.push({ id, location, assignedAcuity: p.assignedAcuity, trueAcuity: p.trueAcuity, arrivalTime: p.arrivalTime, staffId });
    };
    for (const id of this.triageQueue.ids()) view(id, 'waitingTriage');
    for (const id of this.doctorQueues.main.ids()) view(id, 'waitingDoctor');
    for (const id of this.doctorQueues.fastTrack.ids()) view(id, 'waitingFastTrack');
    for (const x of inTriage) view(x.id, 'triage', x.staffId);
    for (const x of withDoctor) view(x.id, x.lane === 'fastTrack' ? 'fastTrack' : 'doctor', x.staffId);
    patients.sort((a, b) => a.id - b.id);
    return {
      now: this.clock,
      patients,
      durationMinutes: this.config.durationMinutes,
      finished: this.finished,
      waitingTriage: this.triageQueue.ids().map((id) => ({ id, trueAcuity: P(id).trueAcuity, arrivalTime: P(id).arrivalTime })),
      waitingDoctor: { main: doctorLine('main'), fastTrack: doctorLine('fastTrack') },
      inTriage,
      withDoctor,
      staff: this.staff.map((s) => ({ id: s.id, role: s.role, busy: s.patientId !== null, retiring: s.retiring })),
      settings: {
        discipline: this.discipline,
        fastTrackEnabled: this.fastTrackEnabled,
        fastTrackOpen: this.fastTrackOpen(),
        fastTrackMinAcuity: this.fastTrackMinAcuity,
      },
      totals: { arrived: this.patients.length, treated: this.treated, lwbs: this.lwbs },
    };
  }

  /** All patients so far (read-only use: metrics, debugging, tests). */
  allPatients(): readonly Patient[] {
    return this.patients;
  }

  // --- event handlers ------------------------------------------------------

  private handle(ev: SimEvent): void {
    switch (ev.kind) {
      case 'arrival':
        this.onArrival();
        break;
      case 'triageEnd':
        this.onTriageEnd(ev.staffId);
        break;
      case 'treatmentEnd':
        this.onTreatmentEnd(ev.staffId);
        break;
      case 'abandon':
        this.onAbandon(ev.patientId);
        break;
      case 'shift':
        if (ev.version === this.scheduleVersion[ev.role]) this.setCount(ev.role, onDutyCount(this.schedule[ev.role]!, this.calendarOffset, this.clock));
        break;
      case 'command':
        this.apply(ev.command);
        return; // apply() already refreshed state
    }
    this.afterChange();
  }

  private scheduleNextArrival(from: number): void {
    const t = this.arrivals.next(from, this.config.durationMinutes);
    if (t !== undefined) this.events.push(t, { kind: 'arrival' }, PRIORITY.arrival);
  }

  private onArrival(): void {
    const c = this.config;
    const trueAcuity = ACUITIES[this.rng.acuity.weightedIndex(this.acuityWeights)]!;
    // Every per-patient draw happens here, in a fixed order, whatever the config: common random numbers.
    const mean = c.serviceMeanByAcuity[trueAcuity];
    const serviceMinutes =
      c.serviceDistribution === 'lognormal' ? this.rng.service.lognormal(mean, c.lognormalCv) : this.rng.service.exponential(mean);
    const triageMinutes = this.rng.triageTime.lognormal(c.triage.meanMinutes, c.triage.cv);
    const triageResult = this.drawTriageResult(trueAcuity);
    const patienceMean = c.lwbs.patienceMeanByAcuity[trueAcuity];
    // Lognormal from one standard-normal draw, taken even when unused so streams stay aligned.
    const z = this.rng.patience.normal();
    const sigma2 = Math.log(1 + c.lwbs.patienceCv ** 2);
    const patienceMinutes = Number.isFinite(patienceMean) ? Math.exp(Math.log(patienceMean) - sigma2 / 2 + Math.sqrt(sigma2) * z) : Infinity;

    const p: Patient = {
      id: this.patients.length,
      trueAcuity,
      state: 'waitingTriage',
      serviceMinutes,
      triageMinutes,
      triageResult,
      patienceMinutes,
      arrivalTime: this.clock,
    };
    this.patients.push(p);

    if (c.lwbs.enabled && Number.isFinite(patienceMinutes))
      this.events.push(this.clock + patienceMinutes, { kind: 'abandon', patientId: p.id }, PRIORITY.abandon);

    if (c.triage.enabled) this.triageQueue.push(p.id, 0, this.clock);
    else this.enqueueForDoctor(p);
    this.scheduleNextArrival(this.clock);
  }

  private drawTriageResult(trueAcuity: Acuity): Acuity {
    const { accuracy, underTriageShare } = this.config.triage;
    const u = this.rng.triageResult.next();
    const v = this.rng.triageResult.next();
    if (u < accuracy) return trueAcuity;
    const under = v < underTriageShare;
    // Off by one level, clipped to 1..5; at the edge the error goes the other way.
    let a = trueAcuity + (under ? 1 : -1);
    if (a > 5) a = 4;
    if (a < 1) a = 2;
    return a as Acuity;
  }

  private onTriageEnd(staffId: number): void {
    const s = this.staffById(staffId);
    const p = this.patients[s.patientId!]!;
    this.release(s);
    p.triageEndTime = this.clock;
    p.assignedAcuity = p.triageResult;
    if (this.config.lwbs.enabled && this.clock - p.arrivalTime >= p.patienceMinutes) {
      // Patience ran out during triage: they leave rather than join the doctor queue.
      this.depart(p, 'lwbs');
      return;
    }
    this.enqueueForDoctor(p);
  }

  private onTreatmentEnd(staffId: number): void {
    const s = this.staffById(staffId);
    const p = this.patients[s.patientId!]!;
    this.release(s);
    this.depart(p, 'treated');
  }

  private onAbandon(id: number): void {
    const p = this.patients[id]!;
    if (p.state === 'waitingTriage') this.triageQueue.remove(id);
    else if (p.state === 'waitingDoctor') this.doctorQueues[p.lane!].remove(id);
    else return; // being seen (or already gone): stays
    this.depart(p, 'lwbs');
  }

  // --- routing & dispatch ----------------------------------------------------

  private fastTrackOpen(): boolean {
    return this.fastTrackEnabled && this.config.triage.enabled && this.activeCount('fastTrackClinician') > 0;
  }

  private laneFor(p: Patient): Lane {
    return this.fastTrackOpen() && p.assignedAcuity !== undefined && p.assignedAcuity >= this.fastTrackMinAcuity ? 'fastTrack' : 'main';
  }

  private queueClass(p: Patient): number {
    return this.discipline === 'acuity' ? (p.assignedAcuity ?? 3) : 0;
  }

  private enqueueForDoctor(p: Patient): void {
    p.state = 'waitingDoctor';
    p.doctorQueueTime ??= this.clock;
    p.lane = this.laneFor(p);
    this.doctorQueues[p.lane].push(p.id, this.queueClass(p), p.doctorQueueTime);
  }

  /** Re-sort everyone waiting for a doctor (after routing rules or queue order change). */
  private reroute(): void {
    const ids = [...this.doctorQueues.main.drain(), ...this.doctorQueues.fastTrack.drain()];
    for (const id of ids) this.enqueueForDoctor(this.patients[id]!);
  }

  private afterChange(): void {
    const open = this.fastTrackOpen();
    if (open !== this.fastTrackWasOpen) {
      this.fastTrackWasOpen = open;
      this.reroute();
    }
    this.dispatch();
    this.updateCounters();
  }

  /** Give free staff the next patient from their line (lowest staff id first). */
  private dispatch(): void {
    for (const s of this.staff) {
      if (s.patientId !== null || s.retiring) continue;
      let id: number | undefined;
      if (s.role === 'triageNurse') id = this.triageQueue.pop();
      else if (s.role === 'fastTrackClinician') id = this.doctorQueues.fastTrack.pop();
      else {
        id = this.doctorQueues.main.pop();
        if (id === undefined && this.config.fastTrack.doctorsTakeOverflow) {
          // A free main-ED doctor picks up a minor case rather than sit idle; seen in the main ED.
          id = this.doctorQueues.fastTrack.pop();
          if (id !== undefined) this.patients[id]!.lane = 'main';
        }
      }
      if (id === undefined) continue;
      const p = this.patients[id]!;
      s.patientId = id;
      p.providerId = s.id;
      if (s.role === 'triageNurse') {
        p.state = 'inTriage';
        p.triageStartTime = this.clock;
        this.events.push(this.clock + p.triageMinutes, { kind: 'triageEnd', staffId: s.id }, PRIORITY.triageEnd);
      } else {
        p.state = 'withDoctor';
        p.doctorStartTime = this.clock;
        const minutes = p.serviceMinutes * (p.lane === 'fastTrack' ? this.config.fastTrack.serviceFactor : 1);
        this.events.push(this.clock + minutes, { kind: 'treatmentEnd', staffId: s.id }, PRIORITY.treatmentEnd);
      }
    }
  }

  private depart(p: Patient, outcome: 'treated' | 'lwbs'): void {
    p.state = 'departed';
    p.outcome = outcome;
    p.departureTime = this.clock;
    if (outcome === 'treated') this.treated++;
    else this.lwbs++;
  }

  // --- staff -----------------------------------------------------------------

  private staffById(id: number): Staff {
    return this.staff.find((s) => s.id === id)!;
  }

  private activeCount(role: Role): number {
    let n = 0;
    for (const s of this.staff) if (s.role === role && !s.retiring) n++;
    return n;
  }

  private release(s: Staff): void {
    s.patientId = null;
    if (s.retiring) this.staff.splice(this.staff.indexOf(s), 1);
  }

  private setCount(role: Role, target: number): void {
    let active = this.activeCount(role);
    // Grow: first cancel pending departures, then bring in new staff.
    for (const s of this.staff) {
      if (active >= target) break;
      if (s.role === role && s.retiring) {
        s.retiring = false;
        active++;
      }
    }
    while (active < target) {
      this.staff.push({ id: this.nextStaffId++, role, patientId: null, retiring: false });
      active++;
    }
    // Shrink: idle staff leave now (newest first); busy ones finish their patient.
    for (let i = this.staff.length - 1; i >= 0 && active > target; i--) {
      const s = this.staff[i]!;
      if (s.role === role && !s.retiring && s.patientId === null) {
        this.staff.splice(i, 1);
        active--;
      }
    }
    for (let i = this.staff.length - 1; i >= 0 && active > target; i--) {
      const s = this.staff[i]!;
      if (s.role === role && !s.retiring) {
        s.retiring = true;
        active--;
      }
    }
  }

  private scheduleShiftEvents(role: Role): void {
    const version = this.scheduleVersion[role];
    for (const t of scheduleBoundaries(this.schedule[role]!, this.calendarOffset, this.config.durationMinutes)) {
      if (t > this.clock) this.events.push(t, { kind: 'shift', role, version }, PRIORITY.shift);
    }
  }

  // --- commands --------------------------------------------------------------

  private apply(cmd: Command): void {
    this.log.push({ atMinute: this.clock, command: JSON.parse(JSON.stringify(cmd)) as Command });
    switch (cmd.type) {
      case 'setStaff':
        // Holds until the role's next shift boundary, if it has a schedule.
        this.setCount(cmd.role, cmd.count);
        break;
      case 'setSchedule':
        this.schedule[cmd.role] = cmd.shifts;
        this.scheduleVersion[cmd.role]++;
        this.setCount(cmd.role, onDutyCount(cmd.shifts, this.calendarOffset, this.clock));
        this.scheduleShiftEvents(cmd.role);
        break;
      case 'setQueueDiscipline':
        this.discipline = cmd.discipline;
        break;
      case 'setFastTrack':
        this.fastTrackEnabled = cmd.enabled;
        if (cmd.minAcuity !== undefined) this.fastTrackMinAcuity = cmd.minAcuity;
        break;
    }
    // Routing rules or queue order may have changed: re-sort everyone waiting for a doctor.
    this.fastTrackWasOpen = this.fastTrackOpen();
    this.reroute();
    this.dispatch();
    this.updateCounters();
  }

  private updateCounters(): void {
    const t = this.clock;
    const waiting = this.triageQueue.size + this.doctorQueues.main.size + this.doctorQueues.fastTrack.size;
    let busyTotal = 0;
    for (const role of ROLES) {
      let busy = 0;
      let duty = 0;
      for (const s of this.staff) {
        if (s.role !== role) continue;
        duty++;
        if (s.patientId !== null) busy++;
      }
      busyTotal += busy;
      this.tw.busy[role].set(t, busy);
      this.tw.onDuty[role].set(t, duty);
    }
    this.tw.waiting.set(t, waiting);
    this.tw.inSystem.set(t, waiting + busyTotal);
  }
}
