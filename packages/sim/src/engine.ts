/**
 * Discrete-event simulation of the ED.
 *
 * Phase 0 model: non-homogeneous Poisson arrivals, a single FIFO queue, and a
 * pool of doctors (M/G/c when rates are constant). All modules are off.
 *
 * The engine has no notion of wall-clock time or rendering. A front end drives
 * it with `runUntil(t)` at whatever speed it likes, reads `snapshot()`, and
 * changes things only through `command()`.
 */

import { ArrivalProcess } from './arrivals.js';
import { resolveConfig, checkCommand, ConfigError, type ResolvedConfig } from './config.js';
import { EventQueue } from './eventQueue.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { Rng } from './rng.js';
import { TimeWeighted } from './stats.js';
import { ACUITIES, type Acuity, type Command, type Doctor, type Patient, type TimedCommand } from './types.js';

type SimEvent =
  | { kind: 'arrival' }
  | { kind: 'serviceEnd'; doctorId: number }
  | { kind: 'command'; command: Command };

/** Tie-break among events at the same instant. Commands run last so live and replayed commands match. */
const PRIORITY = { serviceEnd: 0, arrival: 1, command: 2 } as const;

export interface SimSnapshot {
  now: number;
  durationMinutes: number;
  finished: boolean;
  waiting: { id: number; trueAcuity: Acuity; arrivalTime: number }[];
  inService: { id: number; trueAcuity: Acuity; doctorId: number; startedAt: number }[];
  doctors: { id: number; busy: boolean; retiring: boolean }[];
  totals: { arrived: number; departed: number };
}

export interface RunResult {
  metrics: Metrics;
  commandLog: TimedCommand[];
}

export class Simulation {
  readonly config: ResolvedConfig;
  readonly seed: number;

  private clock = 0;
  private readonly events = new EventQueue<SimEvent>();
  private readonly arrivals: ArrivalProcess;
  private readonly acuityRng: Rng;
  private readonly serviceRng: Rng;
  private readonly acuityWeights: number[];

  private readonly patients: Patient[] = [];
  private readonly queue: number[] = [];
  private queueHead = 0;
  private readonly doctors: Doctor[] = [];
  private nextDoctorId = 0;
  private departed = 0;
  private readonly log: TimedCommand[] = [];

  // Time-weighted accumulators over [warmup, duration].
  readonly tw: {
    inSystem: TimeWeighted;
    inQueue: TimeWeighted;
    busyDoctors: TimeWeighted;
    onDutyDoctors: TimeWeighted;
  };

  constructor(rawConfig: unknown, seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`);
    this.config = resolveConfig(rawConfig);
    this.seed = seed;
    const root = new Rng(seed);
    const c = this.config;
    this.arrivals = new ArrivalProcess(c, root.stream('arrivals'));
    this.acuityRng = root.stream('acuity');
    this.serviceRng = root.stream('service');
    this.acuityWeights = ACUITIES.map((a) => c.acuityMix[a]);

    const w0 = c.warmupMinutes;
    const w1 = c.durationMinutes;
    this.tw = {
      inSystem: new TimeWeighted(w0, w1),
      inQueue: new TimeWeighted(w0, w1),
      busyDoctors: new TimeWeighted(w0, w1),
      onDutyDoctors: new TimeWeighted(w0, w1),
    };

    for (let i = 0; i < c.doctors; i++) this.doctors.push({ id: this.nextDoctorId++, patientId: null, retiring: false });
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
    this.apply({ ...cmd });
  }

  commandLog(): TimedCommand[] {
    return this.log.map((tc) => ({ atMinute: tc.atMinute, command: { ...tc.command } }));
  }

  metrics(): Metrics {
    return computeMetrics(this);
  }

  /** Read-only view for renderers. Returns fresh objects every call. */
  snapshot(): SimSnapshot {
    const waiting = [];
    for (let i = this.queueHead; i < this.queue.length; i++) {
      const p = this.patients[this.queue[i]!]!;
      waiting.push({ id: p.id, trueAcuity: p.trueAcuity, arrivalTime: p.arrivalTime });
    }
    const inService = [];
    for (const d of this.doctors) {
      if (d.patientId === null) continue;
      const p = this.patients[d.patientId]!;
      inService.push({ id: p.id, trueAcuity: p.trueAcuity, doctorId: d.id, startedAt: p.doctorStartTime! });
    }
    return {
      now: this.clock,
      durationMinutes: this.config.durationMinutes,
      finished: this.finished,
      waiting,
      inService,
      doctors: this.doctors.map((d) => ({ id: d.id, busy: d.patientId !== null, retiring: d.retiring })),
      totals: { arrived: this.patients.length, departed: this.departed },
    };
  }

  /** All patients so far (read-only use: metrics, debugging). */
  allPatients(): readonly Patient[] {
    return this.patients;
  }

  // --- internals -----------------------------------------------------------

  private handle(ev: SimEvent): void {
    switch (ev.kind) {
      case 'arrival':
        this.onArrival();
        break;
      case 'serviceEnd':
        this.onServiceEnd(ev.doctorId);
        break;
      case 'command':
        this.apply(ev.command);
        break;
    }
  }

  private scheduleNextArrival(from: number): void {
    const t = this.arrivals.next(from, this.config.durationMinutes);
    if (t !== undefined) this.events.push(t, { kind: 'arrival' }, PRIORITY.arrival);
  }

  private onArrival(): void {
    const trueAcuity = ACUITIES[this.acuityRng.weightedIndex(this.acuityWeights)]!;
    const mean = this.config.serviceMeanByAcuity[trueAcuity];
    const serviceMinutes =
      this.config.serviceDistribution === 'lognormal'
        ? this.serviceRng.lognormal(mean, this.config.lognormalCv)
        : this.serviceRng.exponential(mean);
    const p: Patient = { id: this.patients.length, trueAcuity, serviceMinutes, arrivalTime: this.clock };
    this.patients.push(p);
    this.queue.push(p.id);
    this.dispatch();
    this.updateCounters();
    this.scheduleNextArrival(this.clock);
  }

  private onServiceEnd(doctorId: number): void {
    const idx = this.doctors.findIndex((d) => d.id === doctorId);
    const d = this.doctors[idx]!;
    const p = this.patients[d.patientId!]!;
    p.departureTime = this.clock;
    this.departed++;
    d.patientId = null;
    if (d.retiring) this.doctors.splice(idx, 1);
    this.dispatch();
    this.updateCounters();
  }

  /** Start service for waiting patients while any on-duty doctor is free (lowest id first). */
  private dispatch(): void {
    while (this.queueHead < this.queue.length) {
      const d = this.doctors.find((x) => x.patientId === null && !x.retiring);
      if (!d) return;
      const p = this.patients[this.queue[this.queueHead++]!]!;
      d.patientId = p.id;
      p.doctorId = d.id;
      p.doctorStartTime = this.clock;
      this.events.push(this.clock + p.serviceMinutes, { kind: 'serviceEnd', doctorId: d.id }, PRIORITY.serviceEnd);
    }
    // Compact the queue array occasionally.
    if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
  }

  private apply(cmd: Command): void {
    this.log.push({ atMinute: this.clock, command: { ...cmd } });
    switch (cmd.type) {
      case 'setDoctors':
        this.setDoctors(cmd.count);
        break;
    }
    this.updateCounters();
  }

  private setDoctors(target: number): void {
    let active = this.doctors.filter((d) => !d.retiring).length;
    // Grow: first cancel pending departures, then hire.
    for (const d of this.doctors) {
      if (active >= target) break;
      if (d.retiring) {
        d.retiring = false;
        active++;
      }
    }
    while (active < target) {
      this.doctors.push({ id: this.nextDoctorId++, patientId: null, retiring: false });
      active++;
    }
    // Shrink: idle doctors leave now (highest id first); busy ones finish their patient.
    for (let i = this.doctors.length - 1; i >= 0 && active > target; i--) {
      const d = this.doctors[i]!;
      if (!d.retiring && d.patientId === null) {
        this.doctors.splice(i, 1);
        active--;
      }
    }
    for (let i = this.doctors.length - 1; i >= 0 && active > target; i--) {
      const d = this.doctors[i]!;
      if (!d.retiring) {
        d.retiring = true;
        active--;
      }
    }
    this.dispatch();
  }

  private updateCounters(): void {
    const t = this.clock;
    const waiting = this.queue.length - this.queueHead;
    let busy = 0;
    for (const d of this.doctors) if (d.patientId !== null) busy++;
    this.tw.inQueue.set(t, waiting);
    this.tw.inSystem.set(t, waiting + busy);
    this.tw.busyDoctors.set(t, busy);
    this.tw.onDutyDoctors.set(t, this.doctors.length);
  }
}
