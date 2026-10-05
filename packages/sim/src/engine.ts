/**
 * Discrete-event simulation of the ED.
 *
 * A patient's visit follows the step graph in `config.pipeline` (see pipeline.ts):
 * the default is triage -> [bed] -> doctor evaluation -> workup -> disposition.
 * Around that sit the modules: beds and boarding (admitted patients hold their ED bed
 * until an inpatient bed frees up), diagnosis (misdiagnosis -> bounce-backs), shocks
 * (surges, mass casualties), burnout (fatigue slows staff and raises errors), and
 * staffing (shift schedules). Patients can deteriorate or leave while not yet seen.
 *
 * The engine has no notion of wall-clock time or rendering. A front end drives it
 * with `runUntil(t)`, reads `snapshot()`, and changes things only through `command()`.
 */

import { ArrivalProcess } from './arrivals.js';
import { checkCommand, ConfigError, resolveConfig, resolveStep, type ResolvedConfig, type StepInput } from './config.js';
import { EventQueue } from './eventQueue.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { PARAMS } from './params.js';
import { PatientQueue } from './patientQueue.js';
import type { WalkTrip } from './layout.js';
import { DIAGNOSTIC_KINDS, type RoutingRule, type StepDef } from './pipeline.js';
import { Rng } from './rng.js';
import { occurrencesInRun, scheduleBoundaries } from './schedule.js';
import { TimeWeighted } from './stats.js';
import {
  ACUITIES,
  ROLES,
  type Acuity,
  type ArrivalSource,
  type Command,
  type ConditionSpec,
  type Lane,
  type Outcome,
  type Patient,
  type PatientProfile,
  type QueueDiscipline,
  type Role,
  type Shift,
  type TimedCommand,
  UNIT_IDS,
  SERVICE_IDS,
  type ServiceId,
  type UnitId,
} from './types.js';

interface ArrivalSpec {
  source: ArrivalSource;
  /** Arrives with an assigned acuity from field triage and skips triage. */
  preTriaged?: boolean;
  /** Stream name for this patient's random draws. */
  stream: string;
  acuity?: Acuity;
  conditionId?: string;
  bounceOf?: number;
}

type SimEvent =
  | { kind: 'arrival' }
  | { kind: 'registered'; patientId: number }
  | { kind: 'specialArrival'; spec: ArrivalSpec }
  | { kind: 'taskEnd'; staffId: number; token: number }
  | { kind: 'turnaroundEnd'; patientId: number; step: number }
  | { kind: 'transferEnd'; patientId: number }
  | { kind: 'abandon'; patientId: number }
  | { kind: 'deteriorate'; patientId: number; token: number }
  | { kind: 'shift'; role: Role; version: number }
  | { kind: 'handover' }
  | { kind: 'inpatientDischarge' }
  | { kind: 'wardDischarge'; unit?: UnitId }
  | { kind: 'agitate'; patientId: number; token: number }
  | { kind: 'serviceEnd'; order: number }
  | { kind: 'resultReady'; order: number }
  | { kind: 'serviceOpen'; service: ServiceId }
  | { kind: 'incidentDone' }
  | { kind: 'callInArrive'; role: Role }
  | { kind: 'callInRelease'; staffId: number }
  | { kind: 'command'; command: Command };

/** Tie-break among events at the same instant. Commands run last so live and replayed commands match. */
const PRIORITY: Record<SimEvent['kind'], number> = {
  taskEnd: 0,
  turnaroundEnd: 0,
  transferEnd: 0,
  shift: 1,
  handover: 1,
  inpatientDischarge: 2,
  wardDischarge: 2,
  agitate: 2,
  serviceEnd: 0,
  resultReady: 0,
  serviceOpen: 1,
  incidentDone: 0,
  callInArrive: 1,
  callInRelease: 1,
  deteriorate: 2,
  abandon: 2,
  specialArrival: 3,
  arrival: 3,
  registered: 3,
  command: 4,
};

type StepStatus = 'blocked' | 'queued' | 'active' | 'turnaround' | 'done' | 'skipped';

export interface IncidentRecord {
  time: number;
  patientId: number;
  violent: boolean;
  /** A member of staff was hurt. */
  injury: boolean;
  /** Who dealt with it: a security officer, a clinician pulled off patient care, or nobody free at all. */
  responder: 'security' | 'clinician' | 'none';
  /** Minutes until someone arrived (null when nobody came). */
  responseMinutes: number | null;
  handleMinutes: number;
  /** The patient was admitted and boarding in the ED. */
  boarding: boolean;
}

interface Task {
  id: number;
  patientId: number;
  step: number;
  readyTime: number;
  pool: Role;
  /** Minutes of work left, for a task that was paused by pre-emption. */
  remaining?: number;
}

/** One version of the patient process. Patients keep the version in force when they arrived. */
interface Pipe {
  steps: StepDef[];
  index: Map<string, number>;
  disposition: number;
}

function makePipe(steps: StepDef[]): Pipe {
  return { steps, index: new Map(steps.map((s, i) => [s.id, i])), disposition: steps.findIndex((s) => s.kind === 'disposition') };
}

interface Runtime {
  rng: Rng;
  pipe: Pipe;
  condition: ConditionSpec;
  status: StepStatus[];
  taskIds: (number | undefined)[];
  bedRequested: boolean;
  /** In the bed (after walking there). */
  hasBed: boolean;
  activeTasks: number;
  wantsToLeave: boolean;
  seen: boolean;
  finished: boolean;
  deteriorationToken: number;
  thoroughness: number[];
  /** Fatigue of whoever did the first doctor evaluation (diagnosis errors). */
  evalFatigue: number;
  /** Fatigue of the triage nurse (triage errors). */
  triageFatigue: number;
  /** Security module: invalidates a pending agitation check. */
  agitationToken: number;
  /** Diagnostics module: results still to come for the workup step. */
  pendingOrders: number;
}

interface Staff {
  id: number;
  role: Role;
  taskId: number | null;
  retiring: boolean;
  /** Shift occurrence this person belongs to; undefined = fixed staffing or a manual extra. */
  occ?: string;
  shiftStart: number;
  busyMinutes: number;
  taskStart?: number;
  /** When the current task will end, and a token so a paused task's end event is ignored. */
  taskEnd?: number;
  taskToken: number;
  /** Home base (layout module): location index, 0 = entrance, i + 1 = room i. */
  loc: number;
  /** Called in from on-call: outside the schedule and fixed counts until released. */
  callIn?: boolean;
  /** Security module: busy with an incident until this time (no patient work meanwhile), and whose. */
  incidentUntil?: number;
  incidentPatient?: number;
}

/** Where a patient is, for renderers. */
export type PatientLocation = 'waiting' | 'intake' | 'bed';

/** What a renderer may show about a patient. True acuity and condition are for debrief/debug views only. */
export interface PatientView {
  id: number;
  location: PatientLocation;
  /** What they are waiting for, if not being attended: a step kind or 'bed'. */
  waitingFor?: string;
  lane?: Lane;
  bed?: number;
  /** Room id of their bed (layout module). */
  room?: string;
  boarding: boolean;
  /** Undefined until triaged. */
  assignedAcuity?: Acuity;
  trueAcuity: Acuity;
  arrivalTime: number;
  staffIds: number[];
  source: ArrivalSource;
  byAmbulance: boolean;
  /** Age, sex and what they say brings them in (never the hidden diagnosis). */
  profile: PatientProfile;
  /** Security module: an incident in the last 45 minutes. */
  agitated: boolean;
  /** In a hallway space (main ED, past the regular beds). */
  hallway: boolean;
}

export interface SimSnapshot {
  now: number;
  durationMinutes: number;
  finished: boolean;
  /** Everyone currently in the department, in id order. */
  patients: PatientView[];
  staff: { id: number; role: Role; busy: boolean; retiring: boolean; fatigue: number; patientId?: number; room?: string; /** Security module: dealing with this patient's incident. */ respondingTo?: number }[];
  /** traumaBays: main beds with index below this are trauma bays. */
  beds: Record<Lane, { capacity: number | null; occupied: number; traumaBays: number }>;
  /** Inpatient beds for admissions (boarding module), else null. */
  /** Diagnostics module: per service, servers, how many are busy, orders waiting, and whether it is open. */
  diagnostics: Record<ServiceId, { servers: number; busy: number; queue: number; open: boolean }> | null;
  inpatient: {
    capacity: number;
    occupied: number;
    boarders: number;
    escalated: boolean;
    /** Separate units (boarding.units): beds, occupied and ED boarders waiting for each. */
    units?: Partial<Record<UnitId, { beds: number; occupied: number; boarders: number }>>;
  } | null;
  settings: { discipline: QueueDiscipline; fastTrackEnabled: boolean; fastTrackOpen: boolean; fastTrackMinAcuity: Acuity };
  totals: { arrived: number; discharged: number; admitted: number; lwbs: number; bounceBacks: number; deteriorations: number; diverted: number };
  /** Live decisions available and in force. */
  live: {
    callInsLeft: number;
    /** Called in and on their way. */
    callInsPending: { role: Role; etaMinutes: number }[];
    diversion: boolean;
    hallwayBeds: number;
    hallwayInUse: number;
    thoroughness: number;
  };
  /** Mass-casualty incidents announced and not yet over. */
  incidents: { startsInMinutes: number; patients: number; overMinutes: number }[];
}

/** Minutes between timeline samples. */
export const TIMELINE_STEP = 30;

export interface TimelineSample {
  minute: number;
  inDepartment: number;
  /** Not yet seen by a doctor. */
  waiting: number;
  inBeds: number;
  boarding: number;
  doctors: number;
  hallway: number;
  diversion: boolean;
}

export interface RunResult {
  metrics: Metrics;
  commandLog: TimedCommand[];
}

/** Fatigue records for staff-shifts, for metrics. */
export interface FatigueRecord {
  role: Role;
  start: number;
  end: number;
  fatigue: number;
}

export class Simulation {
  readonly config: ResolvedConfig;
  readonly seed: number;

  private clock = 0;
  private readonly root: Rng;
  private readonly calendarOffset: number;
  private readonly events = new EventQueue<SimEvent>();
  private readonly arrivals: ArrivalProcess;
  private walkIns = 0;
  private readonly acuityWeights: number[];
  private readonly conditionsByAcuity: Record<Acuity, ConditionSpec[]>;
  private readonly conditionById: Map<string, ConditionSpec>;
  /** The process new arrivals follow (commands can replace it). */
  private pipe: Pipe;
  private routing: RoutingRule[];
  private thoroughness: number;
  private diversion = false;
  private hallwayBeds = 0;
  private callInsUsed = 0;
  get callInsCalled(): number {
    return this.callInsUsed;
  }
  private readonly callInsPending: { role: Role; at: number }[] = [];
  /** State every half hour, for the debrief timeline (read-only; recording it adds no events). */
  readonly timeline: TimelineSample[] = [];
  private nextSample = 0;

  private readonly patients: Patient[] = [];
  /** Ids of patients still in the department, in id order. */
  private readonly active = new Set<number>();
  private inSystem = 0;
  private notSeen = 0;
  private readonly rt: Runtime[] = [];
  private readonly tasks = new Map<number, Task>();
  private nextTaskId = 0;
  private readonly pools: Record<Role, PatientQueue>;
  private readonly bedQueues: Record<Lane, PatientQueue> = { main: new PatientQueue(), fastTrack: new PatientQueue() };
  private readonly bedCapacity: Record<Lane, number>;
  private readonly bedsUsed: Record<Lane, (number | null)[]> = { main: [], fastTrack: [] };
  private readonly staff: Staff[] = [];
  private nextStaffId = 0;
  private readonly fatigueLog: FatigueRecord[] = [];
  /** Layout: location index of every bed, per lane; home location per role. */
  private readonly bedLoc: Record<Lane, number[]> = { main: [], fastTrack: [] };
  private readonly waitingLoc: number = 0;
  private readonly triageLocs: number[] = [];
  private readonly stationLoc: number = 0;
  /** Ambulance door location (layout module), or -1: ambulance patients then wait with everyone else. */
  private readonly ambulanceLoc: number = -1;
  /** Walks inside the measurement window (layout module), keyed "who:from:to". */
  private readonly trips = new Map<string, number>();
  /** Minutes spent walking, by role (inside the measurement window). */
  readonly walkingMinutes: Record<Role, number> = { triageNurse: 0, doctor: 0, fastTrackClinician: 0, nurse: 0, tech: 0, security: 0 };

  private inpatientOccupied: number;
  /** Nursing module: a free main ED bed could not be used for lack of a nurse (as of the last bed check). */
  private nursingBlocked = false;
  /** Ward model by length of stay: beds freed early by escalation, whose scheduled discharge is then skipped. */
  private wardFreedEarly = 0;
  /** Separate inpatient units (boarding.units), or null for one ward pool. */
  private readonly units: Partial<Record<UnitId, { beds: number; stayHours: number; occupied: number; freedEarly: number; boarders: number[] }>> | null = null;
  private readonly boarders: number[] = [];
  private readonly inpatientArrivals: ArrivalProcess | undefined;
  private escalated: boolean;

  private counts = { discharged: 0, admitted: 0, lwbs: 0, bounceBacks: 0, deteriorations: 0, diverted: 0 };
  /** Patients turned away by diversion (inside the measurement window). */
  divertedMeasured = 0;
  /** Times a doctor was pulled away from a less urgent patient. */
  preemptions = 0;
  /** Diagnostics module: per service, the queue of orders and servers in use. */
  private readonly services: Record<ServiceId, { queue: PatientQueue; busy: number; openScheduled: boolean; busyMinutes: number; peakQueue: number }> | null = null;
  /** Diagnostics module: every order (index = order id). */
  readonly orderLog: { patientId: number; step: number; service: ServiceId; index: number }[] = [];
  /** Security module: every incident, in time order. */
  readonly incidentLog: IncidentRecord[] = [];
  private readonly log: TimedCommand[] = [];

  // Live settings (commands change these).
  private discipline: QueueDiscipline;
  private fastTrackEnabled: boolean;
  private fastTrackMinAcuity: Acuity;
  private fastTrackWasOpen = false;
  private readonly schedule: Partial<Record<Role, Shift[]>>;
  private readonly fixedTarget: Record<Role, number>;
  private readonly scheduleVersion: Record<Role, number> = { triageNurse: 0, doctor: 0, fastTrackClinician: 0, nurse: 0, tech: 0, security: 0 };

  /** Time-weighted accumulators over [warmup, duration]. */
  readonly tw: {
    inSystem: TimeWeighted;
    waiting: TimeWeighted;
    boarding: TimeWeighted;
    bedsOccupied: Record<Lane, TimeWeighted>;
    /** Beds paid for: capacity, or occupied beds when unlimited. */
    bedsCosted: Record<Lane, TimeWeighted>;
    escalated: TimeWeighted;
    busy: Record<Role, TimeWeighted>;
    onDuty: Record<Role, TimeWeighted>;
    diversion: TimeWeighted;
    hallway: TimeWeighted;
    hallwayOpen: TimeWeighted;
    /** Patients waiting for a main ED bed while a bed was free but no nurse could take them (nursing module). */
    bedWaitNursing: TimeWeighted;
    /** Patients waiting for a main ED bed while all beds were full, weighted by the share held by boarders. */
    bedWaitBoarders: TimeWeighted;
    /** Patients waiting for a main ED bed while all beds were full (any reason). */
    bedWaitFull: TimeWeighted;
    /** Called-in staff on duty, by role (premium pay). */
    callIn: Record<Role, TimeWeighted>;
  };

  constructor(rawConfig: unknown, seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`);
    this.config = resolveConfig(rawConfig);
    this.seed = seed;
    const c = this.config;
    this.root = new Rng(seed);

    // Arrivals, with surge multipliers when the shocks module is on.
    const surges = c.shocks.filter((s) => s.type === 'surge');
    const surgeAt = (t: number) => surges.reduce((m, s) => (t >= s.startMinute && t < s.endMinute ? m * s.multiplier : m), 1);
    const maxSurge = surges.reduce((m, s) => m * Math.max(1, s.multiplier), 1);
    this.arrivals = new ArrivalProcess(c, this.root.stream('arrivals'), surgeAt, maxSurge);

    this.acuityWeights = ACUITIES.map((a) => c.acuityMix[a]);
    this.conditionsByAcuity = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    for (const cond of c.conditions) this.conditionsByAcuity[cond.acuity].push(cond);
    this.conditionById = new Map(c.conditions.map((x) => [x.id, x]));
    this.pipe = makePipe(c.pipeline);
    this.routing = c.routing;
    this.thoroughness = c.diagnosis.thoroughness;

    this.calendarOffset = (c.startDayOfWeek * 24 + c.startHour) * 60;
    this.discipline = c.discipline;
    this.fastTrackEnabled = c.fastTrack.enabled || this.routing.some((r) => r.lane === 'fastTrack');
    this.fastTrackMinAcuity = c.fastTrack.minAcuity;
    this.schedule = c.modules.staffing ? JSON.parse(JSON.stringify(c.schedule)) : {};
    this.fixedTarget = { ...c.staff };
    this.bedCapacity = { ...c.beds };
    this.pools = Object.fromEntries(ROLES.map((r) => [r, new PatientQueue()])) as Record<Role, PatientQueue>;

    const [w0, w1] = [c.warmupMinutes, c.durationMinutes];
    const perRole = () => Object.fromEntries(ROLES.map((r) => [r, new TimeWeighted(w0, w1)])) as Record<Role, TimeWeighted>;
    this.tw = {
      inSystem: new TimeWeighted(w0, w1),
      waiting: new TimeWeighted(w0, w1),
      boarding: new TimeWeighted(w0, w1),
      bedsOccupied: { main: new TimeWeighted(w0, w1), fastTrack: new TimeWeighted(w0, w1) },
      bedsCosted: { main: new TimeWeighted(w0, w1), fastTrack: new TimeWeighted(w0, w1) },
      escalated: new TimeWeighted(w0, w1),
      busy: perRole(),
      onDuty: perRole(),
      diversion: new TimeWeighted(w0, w1),
      hallway: new TimeWeighted(w0, w1),
      hallwayOpen: new TimeWeighted(w0, w1),
      bedWaitNursing: new TimeWeighted(w0, w1),
      bedWaitBoarders: new TimeWeighted(w0, w1),
      bedWaitFull: new TimeWeighted(w0, w1),
      callIn: perRole(),
    };

    if (c.layout) {
      const locOf = (type: string) => c.layout!.rooms.flatMap((r, i) => (r.type === type ? [i + 1] : []));
      // Trauma-room beds come first in the main lane: bed indexes below traumaBays are the bays.
      for (const [lane, type] of [
        ['main', 'trauma'],
        ['main', 'acute'],
        ['fastTrack', 'fastTrack'],
      ] as const)
        c.layout.rooms.forEach((r, i) => {
          if (r.type === type) for (let k = 0; k < r.capacity; k++) this.bedLoc[lane].push(i + 1);
        });
      this.waitingLoc = locOf('waiting')[0]!;
      this.triageLocs = locOf('triage');
      this.stationLoc = locOf('station')[0] ?? this.bedLoc.main[0]!;
      this.ambulanceLoc = c.layout.ambulanceLoc ?? -1;
    }

    for (const role of ROLES) {
      this.reconcileStaff(role);
      if (this.schedule[role]) this.scheduleShiftEvents(role);
    }
    if (c.modules.burnout) {
      const every = c.burnout.handoverHours * 60;
      for (let t = every; t <= c.durationMinutes; t += every) this.push(t, { kind: 'handover' });
    }

    if (c.modules.diagnostics)
      this.services = Object.fromEntries(SERVICE_IDS.map((sv) => [sv, { queue: new PatientQueue(), busy: 0, openScheduled: false, busyMinutes: 0, peakQueue: 0 }])) as NonNullable<
        typeof this.services
      >;
    this.inpatientOccupied = c.boarding.initialOccupied;
    this.escalated = c.boarding.escalation;
    if (c.modules.boarding) {
      const w = c.boarding.dischargeHourlyWeights;
      const mean = w.reduce((a, b) => a + b, 0) / 24;
      const byStay = c.boarding.inpatientStayHours !== null || c.boarding.units !== null;
      // Fixed-rate wards discharge all the time (faster when escalated). Wards by length of stay discharge
      // each patient when their stay ends; the Poisson process then only adds escalation's early discharges.
      const perHour = (byStay ? c.boarding.escalationExtraDischargesPerDay : c.boarding.dischargesPerDay) / 24;
      // Escalation scales the discharge rate; thinning needs its maximum up front.
      const boost = byStay ? 1 : c.boarding.dischargesPerDay > 0 ? (c.boarding.dischargesPerDay + c.boarding.escalationExtraDischargesPerDay) / c.boarding.dischargesPerDay : 1;
      this.inpatientArrivals = new ArrivalProcess(
        { hourlyRates: w.map((x) => (x / mean) * perHour), dayOfWeekMultipliers: [1, 1, 1, 1, 1, 1, 1], startDayOfWeek: c.startDayOfWeek, startHour: c.startHour },
        this.root.stream('inpatientDischarges'),
        byStay ? () => (this.escalated ? 1 : 0) : () => (this.escalated ? boost : 1),
        boost,
      );
      if (c.boarding.units) {
        this.units = {};
        for (const u of UNIT_IDS) {
          const spec = c.boarding.units[u];
          if (!spec) continue;
          this.units[u] = { beds: spec.beds, stayHours: spec.stayHours, occupied: spec.initialOccupied, freedEarly: 0, boarders: [] };
          // Patients already on the unit: each has part of a stay left.
          for (let k = 0; k < spec.initialOccupied; k++) {
            const rng = this.root.stream(`ward:${u}:initial:${k}`);
            this.push(rng.next() * this.unitStay(u, rng), { kind: 'wardDischarge', unit: u });
          }
        }
      } else if (byStay)
        // Patients already on the ward: each has part of a stay left.
        for (let k = 0; k < c.boarding.initialOccupied; k++) {
          const rng = this.root.stream(`ward:initial:${k}`);
          this.push(rng.next() * this.wardStay(rng), { kind: 'wardDischarge' });
        }
      const t = this.inpatientArrivals.next(0, c.durationMinutes);
      if (t !== undefined) this.push(t, { kind: 'inpatientDischarge' });
    }

    c.shocks.forEach((s, i) => {
      if (s.type !== 'massCasualty') return;
      const rng = this.root.stream(`massCasualty:${i}`);
      const mix = s.acuityMix ?? { '1': 0.2, '2': 0.4, '3': 0.3, '4': 0.1 };
      const weights = ACUITIES.map((a) => mix[`${a}`] ?? 0);
      for (let k = 0; k < s.patients; k++) {
        const t = s.atMinute + rng.next() * s.overMinutes;
        const acuity = ACUITIES[rng.weightedIndex(weights)]!;
        const preTriaged = s.preTriaged ?? true;
        if (t <= c.durationMinutes) this.push(t, { kind: 'specialArrival', spec: { source: 'massCasualty', stream: `massCasualty:${i}:${k}`, acuity, preTriaged } });
      }
    });

    this.fastTrackWasOpen = this.fastTrackOpen();
    this.updateCounters();

    for (const tc of c.commands) this.push(tc.atMinute, { kind: 'command', command: tc.command });
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
      this.sampleUpTo(next.time);
      this.events.pop();
      this.clock = next.time;
      this.handle(next.event);
    }
    this.sampleUpTo(until);
    if (until > this.clock) this.clock = until;
  }

  /** Record the (unchanged) state at every sample time up to t. */
  private sampleUpTo(t: number): void {
    while (this.nextSample <= t && this.nextSample <= this.config.durationMinutes) {
      let inBeds = 0;
      for (const lane of ['main', 'fastTrack'] as const) inBeds += this.bedsUsed[lane].filter((x) => x !== null).length;
      this.timeline.push({
        minute: this.nextSample,
        inDepartment: this.inSystem,
        waiting: this.notSeen,
        inBeds,
        boarding: this.boarders.length,
        doctors: this.activeCount('doctor'),
        hallway: this.bedsUsed.main.filter((id, i) => id !== null && this.isHallway('main', i)).length,
        diversion: this.diversion,
      });
      this.nextSample += TIMELINE_STEP;
    }
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
    if (cmd.type === 'setSchedule' && !this.config.modules.staffing) throw new ConfigError(['command: setSchedule needs the staffing module on']);
    if (cmd.type === 'setBeds' && this.config.layout) throw new ConfigError(['command: setBeds is not available with the layout module (beds come from rooms)']);
    if (cmd.type === 'setProcess') {
      if (!this.config.modules.process) throw new ConfigError(['command: setProcess needs the process module on']);
      const missing = [...new Set(cmd.steps.map((s) => s.role).filter((r): r is Role => !!r && r !== 'fastTrackClinician'))].filter(
        (r) => this.activeCount(r) === 0 && !this.schedule[r],
      );
      if (missing.length) throw new ConfigError([`command: the new process needs staff for ${missing.join(', ')}`]);
    }
    if (cmd.type === 'callIn' && this.callInsUsed >= this.config.liveCalls.maxCallIns) throw new ConfigError(['command: no on-call staff left to call in']);
    if (cmd.type === 'setHallwayBeds' && !Number.isFinite(this.bedCapacity.main)) throw new ConfigError(['command: hallway spaces need a fixed number of main beds']);
    this.apply(JSON.parse(JSON.stringify(cmd)) as Command);
  }

  commandLog(): TimedCommand[] {
    return JSON.parse(JSON.stringify(this.log)) as TimedCommand[];
  }

  metrics(): Metrics {
    return computeMetrics(this);
  }

  /** All patients so far (read-only use: metrics, debugging, tests). */
  allPatients(): readonly Patient[] {
    return this.patients;
  }

  /** Fatigue at the end of every staff-shift so far, plus staff still on duty (burnout module). */
  fatigueRecords(): FatigueRecord[] {
    return [...this.fatigueLog, ...this.staff.map((s) => ({ role: s.role, start: s.shiftStart, end: this.clock, fatigue: this.fatigue(s) }))];
  }

  /** Tasks waiting for a role, in the order they will be served (read-only). */
  queuedTasks(role: Role): { patientId: number; kind: StepDef['kind'] }[] {
    return this.pools[role].ids().map((tid) => {
      const t = this.tasks.get(tid)!;
      return { patientId: t.patientId, kind: this.stepOf(t).kind };
    });
  }

  conditionOf(p: Patient): ConditionSpec {
    return this.conditionById.get(p.conditionId)!;
  }

  /** Read-only view for renderers. Returns fresh objects every call. */
  snapshot(): SimSnapshot {
    const staffByPatient = new Map<number, number[]>();
    for (const s of this.staff) {
      if (s.taskId === null) continue;
      const pid = this.tasks.get(s.taskId)!.patientId;
      staffByPatient.set(pid, [...(staffByPatient.get(pid) ?? []), s.id]);
    }
    const patients: PatientView[] = [];
    for (const id of this.active) {
      const p = this.patients[id]!;
      const r = this.rt[id]!;
      const staffIds = staffByPatient.get(id) ?? [];
      let location: PatientLocation;
      let waitingFor: string | undefined;
      if (r.hasBed) location = 'bed';
      else if (staffIds.length > 0) location = 'intake';
      else location = 'waiting';
      if (staffIds.length === 0 && p.boardingStartTime === undefined) {
        const queued = r.status.findIndex((st) => st === 'queued');
        if (queued >= 0) waitingFor = r.pipe.steps[queued]!.kind;
        else if (this.holdsBed(p) && !r.hasBed) waitingFor = 'transfer';
        else if (r.bedRequested && !r.hasBed) waitingFor = 'bed';
      }
      patients.push({
        id,
        location,
        waitingFor,
        lane: p.lane,
        bed: p.bed,
        room: this.config.layout && r.hasBed ? this.config.layout.rooms[this.bedLoc[p.lane!][p.bed!]! - 1]!.id : undefined,
        boarding: p.boardingStartTime !== undefined,
        assignedAcuity: p.assignedAcuity,
        trueAcuity: p.trueAcuity,
        arrivalTime: p.arrivalTime,
        staffIds,
        source: p.source,
        byAmbulance: p.byAmbulance === true,
        profile: p.profile,
        agitated: p.lastIncidentAt !== undefined && this.clock - p.lastIncidentAt < 45,
        hallway: r.hasBed && p.lane !== undefined && this.isHallway(p.lane, p.bed!),
      });
    }
    const bedInfo = (lane: Lane) => ({
      capacity: Number.isFinite(this.bedCapacity[lane]) ? this.bedCapacity[lane] : null,
      traumaBays: lane === 'main' ? Math.min(this.config.traumaBays, this.bedCapacity[lane]) : 0,
      occupied: this.bedsUsed[lane].filter((x) => x !== null).length,
    });
    return {
      now: this.clock,
      durationMinutes: this.config.durationMinutes,
      finished: this.finished,
      patients,
      staff: this.staff.map((s) => ({
        id: s.id,
        role: s.role,
        busy: s.taskId !== null,
        retiring: s.retiring,
        fatigue: this.fatigue(s),
        patientId: s.taskId === null ? undefined : this.tasks.get(s.taskId)!.patientId,
        respondingTo: (s.incidentUntil ?? -1) > this.now ? s.incidentPatient : undefined,
        room: this.config.layout && s.loc > 0 ? this.config.layout.rooms[s.loc - 1]!.id : undefined,
      })),
      beds: { main: bedInfo('main'), fastTrack: bedInfo('fastTrack') },
      diagnostics: this.services
        ? (Object.fromEntries(
            SERVICE_IDS.map((sv) => [
              sv,
              { servers: this.config.diagnostics.services[sv].servers, busy: this.services![sv].busy, queue: this.services![sv].queue.size, open: this.serviceOpen(sv, this.clock) },
            ]),
          ) as SimSnapshot['diagnostics'])
        : null,
      inpatient: this.config.modules.boarding
        ? this.units
          ? {
              capacity: UNIT_IDS.reduce((s, u) => s + (this.units![u]?.beds ?? 0), 0),
              occupied: UNIT_IDS.reduce((s, u) => s + (this.units![u]?.occupied ?? 0), 0),
              boarders: this.boarders.length,
              escalated: this.escalated,
              units: Object.fromEntries(UNIT_IDS.filter((u) => this.units![u]).map((u) => [u, { beds: this.units![u]!.beds, occupied: this.units![u]!.occupied, boarders: this.units![u]!.boarders.length }])),
            }
          : { capacity: this.config.boarding.inpatientBeds, occupied: this.inpatientOccupied, boarders: this.boarders.length, escalated: this.escalated }
        : null,
      settings: {
        discipline: this.discipline,
        fastTrackEnabled: this.fastTrackEnabled,
        fastTrackOpen: this.fastTrackOpen(),
        fastTrackMinAcuity: this.fastTrackMinAcuity,
      },
      totals: { arrived: this.patients.length, ...this.counts },
      live: {
        callInsLeft: Math.max(0, this.config.liveCalls.maxCallIns - this.callInsUsed),
        callInsPending: this.callInsPending.map((x) => ({ role: x.role, etaMinutes: Math.max(0, x.at - this.clock) })),
        diversion: this.diversion,
        hallwayBeds: this.hallwayFor('main'),
        hallwayInUse: this.bedsUsed.main.filter((id, i) => id !== null && this.isHallway('main', i)).length,
        thoroughness: this.thoroughness,
      },
      incidents: this.config.shocks
        .filter((x) => x.type === 'massCasualty')
        .filter((x) => this.clock >= x.atMinute - this.config.liveCalls.incidentWarningMinutes && this.clock < x.atMinute + x.overMinutes)
        .map((x) => ({ startsInMinutes: Math.max(0, x.atMinute - this.clock), patients: x.patients, overMinutes: x.overMinutes })),
    };
  }

  /** The step a task is for, in its patient's own version of the process. */
  private stepOf(t: Task): StepDef {
    return this.rt[t.patientId]!.pipe.steps[t.step]!;
  }

  // --- events ----------------------------------------------------------------

  private push(time: number, ev: SimEvent): void {
    this.events.push(time, ev, PRIORITY[ev.kind]);
  }

  private handle(ev: SimEvent): void {
    switch (ev.kind) {
      case 'arrival':
        this.admitArrival({ source: 'walkIn', stream: `walkIn:${this.walkIns++}` });
        this.scheduleNextArrival(this.clock);
        break;
      case 'callInArrive': {
        const i = this.callInsPending.findIndex((x) => x.role === ev.role && x.at <= this.clock);
        if (i >= 0) this.callInsPending.splice(i, 1);
        const id = this.addStaff(ev.role, undefined, this.clock);
        this.staff.find((s) => s.id === id)!.callIn = true;
        this.push(this.clock + this.config.liveCalls.callInHours * 60, { kind: 'callInRelease', staffId: id });
        break;
      }
      case 'callInRelease': {
        const s = this.staff.find((x) => x.id === ev.staffId);
        if (s) this.retire(s);
        break;
      }
      case 'specialArrival':
        this.admitArrival(ev.spec);
        break;
      case 'taskEnd': {
        const s = this.staff.find((x) => x.id === ev.staffId);
        if (s && s.taskToken === ev.token) this.onTaskEnd(ev.staffId);
        break;
      }
      case 'turnaroundEnd':
        this.completeStep(this.patients[ev.patientId]!, ev.step);
        break;
      case 'transferEnd': {
        const p = this.patients[ev.patientId]!;
        const r = this.rt[p.id]!;
        if (!r.finished) {
          r.hasBed = true;
          this.advance(p);
        }
        break;
      }
      case 'abandon':
        this.onAbandon(ev.patientId);
        break;
      case 'registered':
        if (!this.rt[ev.patientId]!.finished) this.advance(this.patients[ev.patientId]!);
        break;
      case 'deteriorate':
        this.onDeteriorate(ev.patientId, ev.token);
        break;
      case 'shift':
        if (ev.version === this.scheduleVersion[ev.role]) this.reconcileStaff(ev.role);
        break;
      case 'handover':
        this.onHandover();
        break;
      case 'inpatientDischarge':
        this.onInpatientDischarge();
        break;
      case 'serviceEnd':
        this.onServiceEnd(ev.order);
        break;
      case 'resultReady':
        this.onResultReady(ev.order);
        break;
      case 'serviceOpen':
        this.services![ev.service].openScheduled = false;
        this.runService(ev.service);
        break;
      case 'agitate':
        this.onAgitate(ev.patientId, ev.token);
        break;
      case 'incidentDone':
        break; // the dispatch after every event puts the responder back to work
      case 'wardDischarge':
        if (ev.unit) {
          const u = this.units![ev.unit]!;
          if (u.freedEarly > 0) u.freedEarly--;
          else this.freeUnitBed(ev.unit);
        } else if (this.wardFreedEarly > 0)
          // A bed an early (escalation) discharge already freed: nothing left to free.
          this.wardFreedEarly--;
        else this.freeWardBed();
        break;
      case 'command':
        this.apply(ev.command);
        return; // apply() already refreshed state
    }
    this.afterChange();
  }

  private scheduleNextArrival(from: number): void {
    const t = this.arrivals.next(from, this.config.durationMinutes);
    if (t !== undefined) this.push(t, { kind: 'arrival' });
  }

  private admitArrival(spec: ArrivalSpec): void {
    const c = this.config;
    // Every patient has their own random stream, so their draws don't depend on anyone else.
    const rng = this.root.stream(spec.stream);
    const acuityDraw = ACUITIES[rng.weightedIndex(this.acuityWeights)]!;
    const acuity = spec.acuity ?? acuityDraw;
    // How they came: from a stream of its own, so nobody's other draws change.
    const byAmbulance =
      spec.source === 'massCasualty' || (spec.source === 'walkIn' && this.root.stream(`mode:${spec.stream}`).next() < c.ambulanceShareByAcuity[acuity]);
    if (byAmbulance && this.diversion && spec.source === 'walkIn' && acuity > c.liveCalls.diversionSparesAcuity) {
      // On diversion the ambulance takes them to another hospital.
      this.counts.diverted++;
      if (this.clock >= c.warmupMinutes) this.divertedMeasured++;
      return;
    }
    const pool = this.conditionsByAcuity[acuity];
    const conditionDraw = pool[rng.weightedIndex(pool.map((x) => x.weight))]!;
    const condition = (spec.conditionId && this.conditionById.get(spec.conditionId)) || conditionDraw;
    const patienceMean = c.lwbs.patienceMeanByAcuity[acuity];
    const z = rng.normal();
    const sigma2 = Math.log(1 + c.lwbs.patienceCv ** 2);
    const patienceMinutes = Number.isFinite(patienceMean) ? Math.exp(Math.log(patienceMean) - sigma2 / 2 + Math.sqrt(sigma2) * z) : Infinity;

    const p: Patient = {
      id: this.patients.length,
      source: spec.source,
      bounceOf: spec.bounceOf,
      conditionId: condition.id,
      // The same person comes back after a missed diagnosis; everyone else gets a profile from a stream of their own.
      profile: spec.bounceOf !== undefined ? this.patients[spec.bounceOf]!.profile : drawProfile(this.root.stream(`profile:${spec.stream}`), condition),
      initialAcuity: acuity,
      trueAcuity: acuity,
      patienceMinutes,
      deteriorations: 0,
      arrivalTime: this.clock,
      steps: {},
      byAmbulance: byAmbulance || undefined,
    };
    this.patients.push(p);
    const pipe = this.pipe;
    this.rt.push({
      rng,
      pipe,
      condition,
      status: pipe.steps.map(() => 'blocked'),
      taskIds: pipe.steps.map(() => undefined),
      bedRequested: false,
      agitationToken: 0,
      pendingOrders: 0,
      hasBed: false,
      activeTasks: 0,
      wantsToLeave: false,
      seen: false,
      finished: false,
      deteriorationToken: 0,
      thoroughness: [],
      evalFatigue: 0,
      triageFatigue: 0,
    });
    this.active.add(p.id);
    this.inSystem++;
    this.notSeen++;
    if (spec.source === 'bounceBack') this.counts.bounceBacks++;

    if (spec.preTriaged) {
      // Field triage: tagged on scene (same accuracy as the ED triage desk), no triage step here.
      p.assignedAcuity = this.triageResult(p);
      p.triageAssigned = p.assignedAcuity;
      p.acuityAtTriage = p.trueAcuity;
      pipe.steps.forEach((s, i) => {
        if (s.kind === 'triage') this.rt[p.id]!.status[i] = 'skipped';
      });
    }
    if (c.lwbs.enabled && Number.isFinite(patienceMinutes)) this.push(this.clock + patienceMinutes, { kind: 'abandon', patientId: p.id });
    if (c.deterioration.enabled) this.scheduleDeterioration(p);
    if (c.modules.security) {
      // Who is at risk comes from a stream of its own, so nobody else's draws change.
      const share = c.security.riskShare + (condition.id === 'overdose' ? c.security.overdoseExtra : 0);
      if (this.root.stream(`security:${spec.stream}`).next() < share) {
        p.atRisk = true;
        p.incidents = 0;
        this.scheduleAgitation(p);
      }
    }
    // Walk-ins register before they join the triage queue; ambulance and major-incident arrivals do not wait for it.
    const reg = c.triage.registrationMinutes;
    if (reg > 0 && spec.source !== 'massCasualty' && !byAmbulance && !spec.preTriaged) this.push(this.clock + reg, { kind: 'registered', patientId: p.id });
    else this.advance(p);
  }

  // --- the step graph ----------------------------------------------------------

  private applies(p: Patient, s: StepDef): boolean {
    const a = p.assignedAcuity ?? 3;
    const lane = p.lane ?? this.routeLane(p);
    return a >= s.minAcuity && a <= s.maxAcuity && s.lanes.includes(lane);
  }

  /** Start every step whose prerequisites are met; finish the visit when all are done. */
  private advance(p: Patient): void {
    const r = this.rt[p.id]!;
    if (r.finished) return;
    let progressed = true;
    while (progressed && !r.finished) {
      progressed = false;
      const steps = r.pipe.steps;
      for (let i = 0; i < steps.length; i++) {
        if (r.status[i] !== 'blocked') continue;
        const s = steps[i]!;
        const ready =
          s.after.every((id) => {
            const st = r.status[r.pipe.index.get(id)!];
            return st === 'done' || st === 'skipped';
          }) && (i !== r.pipe.disposition || r.status.every((st, j) => j === i || st === 'done' || st === 'skipped'));
        if (!ready) continue;
        if (!this.applies(p, s)) {
          r.status[i] = 'skipped';
          progressed = true;
          continue;
        }
        if (s.inBed && !r.hasBed) {
          this.requestBed(p);
          continue;
        }
        this.startStep(p, i);
        progressed = true;
      }
    }
  }

  private startStep(p: Patient, i: number): void {
    const r = this.rt[p.id]!;
    const s = r.pipe.steps[i]!;
    if (s.kind === 'doctorEval' && p.doctorQueueTime === undefined) p.doctorQueueTime = this.clock;
    if (s.role !== null && s.meanMinutesByAcuity[p.trueAcuity] > 0) {
      const pool: Role = s.role === 'doctor' && p.lane === 'fastTrack' ? 'fastTrackClinician' : s.role;
      const task: Task = { id: this.nextTaskId++, patientId: p.id, step: i, readyTime: this.clock, pool };
      this.tasks.set(task.id, task);
      r.taskIds[i] = task.id;
      r.status[i] = 'queued';
      this.pools[pool].push(task.id, this.taskClass(p, s), task.readyTime);
      return;
    }
    // Unstaffed (or zero-time) step: straight to its turnaround, if any.
    p.steps[s.id] = { kind: s.kind, start: this.clock };
    if (s.kind === 'doctorEval') this.markSeen(p, undefined, 0);
    this.startTurnaround(p, i);
  }

  private taskClass(p: Patient, s: StepDef): number {
    if (s.kind === 'disposition' && this.config.dispositionFirst) return -1;
    if (s.kind === 'triage' || s.kind === 'registration') return 0;
    return this.discipline === 'acuity' ? (p.assignedAcuity ?? 3) : 0;
  }

  private startTurnaround(p: Patient, i: number): void {
    const r = this.rt[p.id]!;
    const s = r.pipe.steps[i]!;
    if (s.kind === 'workup' && this.services) return this.orderTests(p, i);
    const mean = s.turnaroundMinutesByAcuity[p.trueAcuity];
    const minutes = mean > 0 ? drawDuration(r.rng.stream(`turnaround:${s.id}`), mean, s.turnaroundCv, 'lognormal') : 0;
    if (minutes > 0) {
      r.status[i] = 'turnaround';
      this.push(this.clock + minutes, { kind: 'turnaroundEnd', patientId: p.id, step: i });
    } else this.completeStep(p, i);
  }

  private completeStep(p: Patient, i: number): void {
    const r = this.rt[p.id]!;
    if (r.finished) return;
    const s = r.pipe.steps[i]!;
    r.status[i] = 'done';
    p.steps[s.id] = { kind: s.kind, start: p.steps[s.id]?.start ?? this.clock, end: this.clock };
    if (DIAGNOSTIC_KINDS.includes(s.kind)) r.thoroughness.push(s.thoroughness);
    if (s.kind === 'triage') {
      p.triageEndTime = this.clock;
      p.assignedAcuity = this.triageResult(p);
      p.triageAssigned = p.assignedAcuity;
      p.acuityAtTriage = p.trueAcuity;
    }
    if (s.kind === 'disposition') {
      this.dispose(p);
      return;
    }
    if (r.wantsToLeave && !r.seen && r.activeTasks === 0) {
      this.leaveWithoutBeingSeen(p);
      return;
    }
    this.advance(p);
  }

  private triageResult(p: Patient): Acuity {
    const r = this.rt[p.id]!;
    const { accuracy, underTriageShare } = this.config.triage;
    const rng = r.rng.stream('triage');
    const u = rng.next();
    const v = rng.next();
    const errorFactor = this.config.modules.burnout ? 1 + this.config.burnout.errorEffect * r.triageFatigue : 1;
    if (u >= Math.min(1, (1 - accuracy) * errorFactor)) return p.trueAcuity;
    // Off by one level, clipped to 1..5; at the edge the error goes the other way.
    let a = p.trueAcuity + (v < underTriageShare ? 1 : -1);
    if (a > 5) a = 4;
    if (a < 1) a = 2;
    return a as Acuity;
  }

  private markSeen(p: Patient, staffId: number | undefined, fatigue: number): void {
    const r = this.rt[p.id]!;
    if (r.seen) return;
    r.seen = true;
    this.notSeen--;
    r.evalFatigue = fatigue;
    p.doctorStartTime = this.clock;
    p.providerId = staffId;
  }

  /** Disposition: diagnosis outcome, then admit (maybe boarding) or discharge. */
  private dispose(p: Patient): void {
    const c = this.config;
    const r = this.rt[p.id]!;
    p.dispositionTime = this.clock;
    const rng = r.rng.stream('disposition');
    const [uMiss, uBounce, uWhen, uAdmit] = [rng.next(), rng.next(), rng.next(), rng.next()];
    if (c.modules.diagnosis) {
      const t = r.thoroughness.length ? r.thoroughness.reduce((a, b) => a + b, 0) / r.thoroughness.length : c.diagnosis.thoroughness;
      const [m0, m1] = c.diagnosis.missFactorRange;
      const fatigueFactor = c.modules.burnout ? 1 + c.burnout.errorEffect * r.evalFatigue : 1;
      const missProb = Math.min(1, r.condition.missRisk * (m0 + (m1 - m0) * t) * fatigueFactor);
      if (uMiss < missProb) {
        // A missed diagnosis sends the patient home.
        p.misdiagnosed = true;
        if (uBounce < c.diagnosis.bounceBackProbability) {
          p.returnsAt = this.clock + uWhen * c.diagnosis.returnWithinHours * 60;
          if (p.returnsAt <= c.durationMinutes) {
            const acuity = Math.max(1, p.trueAcuity - 1) as Acuity;
            this.push(p.returnsAt, { kind: 'specialArrival', spec: { source: 'bounceBack', stream: `bounceBack:${p.id}`, acuity, conditionId: p.conditionId, bounceOf: p.id } });
          }
        }
        this.depart(p, 'discharged');
        return;
      }
    }
    const admitChance = c.disposition.admitProbabilityByAcuity[p.initialAcuity] ?? r.condition.admit;
    if (uAdmit >= admitChance) {
      this.depart(p, 'discharged');
      return;
    }
    if (!c.modules.boarding) {
      this.depart(p, 'admitted');
      return;
    }
    if (this.units) {
      // Separate units: the patient needs a bed on a particular one.
      const unit = this.pickUnit(p);
      p.admitUnit = unit;
      const u = this.units[unit]!;
      if (u.occupied < u.beds) {
        this.takeUnitBed(p, unit);
        this.depart(p, 'admitted');
        return;
      }
      u.boarders.push(p.id);
    } else if (this.inpatientOccupied < c.boarding.inpatientBeds) {
      this.takeWardBed(p);
      this.depart(p, 'admitted');
      return;
    }
    // Boarding: stays in the ED bed until an inpatient bed frees up.
    p.boardingStartTime = this.clock;
    // Long boarding frustrates too.
    if (p.atRisk && (p.incidents ?? 0) < c.security.maxIncidentsPerPatient) this.scheduleAgitation(p);
    r.finished = true;
    this.boarders.push(p.id);
  }

  private onInpatientDischarge(): void {
    if (this.units) {
      // Escalation frees a ward bed early (the general ward, else the last unit listed).
      const unit = this.units.ward ? 'ward' : (UNIT_IDS.filter((u) => this.units![u]).at(-1) as UnitId);
      const u = this.units[unit]!;
      if (u.occupied > 0) {
        u.freedEarly++;
        this.freeUnitBed(unit);
      }
    } else if (this.config.boarding.inpatientStayHours !== null) {
      // Escalation discharges someone early; their scheduled discharge will then be skipped.
      if (this.inpatientOccupied > 0) {
        this.wardFreedEarly++;
        this.freeWardBed();
      }
    } else this.freeWardBed();
    const t = this.inpatientArrivals!.next(this.clock, this.config.durationMinutes);
    if (t !== undefined) this.push(t, { kind: 'inpatientDischarge' });
  }

  /** A ward bed frees up: the longest-boarding patient goes up. */
  private freeWardBed(): void {
    if (this.inpatientOccupied > 0) this.inpatientOccupied--;
    while (this.boarders.length > 0 && this.inpatientOccupied < this.config.boarding.inpatientBeds) {
      const p = this.patients[this.boarders.shift()!]!;
      this.takeWardBed(p);
      this.depart(p, 'admitted');
    }
  }

  /** An admitted patient takes a ward bed (and, by length of stay, will leave it later). */
  private takeWardBed(p: Patient): void {
    this.inpatientOccupied++;
    if (this.config.boarding.inpatientStayHours !== null) this.push(this.clock + this.wardStay(this.rt[p.id]!.rng.stream('ward')), { kind: 'wardDischarge' });
  }

  /** Which unit an admitted patient needs: by true acuity, among the units that exist (else the ward, else the first). */
  private pickUnit(p: Patient): UnitId {
    const units = UNIT_IDS.filter((u) => this.units![u]);
    const shares = this.config.boarding.unitShareByAcuity[p.trueAcuity];
    const weights = units.map((u) => shares[u] ?? 0);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return units.includes('ward') ? 'ward' : units[0]!;
    let x = this.rt[p.id]!.rng.stream('unit').next() * total;
    for (let i = 0; i < units.length; i++) {
      x -= weights[i]!;
      if (x < 0) return units[i]!;
    }
    return units.at(-1)!;
  }

  private takeUnitBed(p: Patient, unit: UnitId): void {
    const u = this.units![unit]!;
    u.occupied++;
    this.push(this.clock + this.unitStay(unit, this.rt[p.id]!.rng.stream('ward')), { kind: 'wardDischarge', unit });
  }

  /** A unit bed frees up: that unit's longest-boarding patient goes up. */
  private freeUnitBed(unit: UnitId): void {
    const u = this.units![unit]!;
    if (u.occupied > 0) u.occupied--;
    while (u.boarders.length > 0 && u.occupied < u.beds) {
      const id = u.boarders.shift()!;
      this.boarders.splice(this.boarders.indexOf(id), 1);
      const p = this.patients[id]!;
      this.takeUnitBed(p, unit);
      this.depart(p, 'admitted');
    }
  }

  private unitStay(unit: UnitId, rng: Rng): number {
    const mean = this.units![unit]!.stayHours * 60;
    const s2 = Math.log(1 + this.config.boarding.inpatientStayCv ** 2);
    return Math.exp(Math.log(mean) - s2 / 2 + Math.sqrt(s2) * rng.normal());
  }

  /** A ward stay in minutes (lognormal). */
  private wardStay(rng: Rng): number {
    const b = this.config.boarding;
    const mean = b.inpatientStayHours! * 60;
    const s2 = Math.log(1 + b.inpatientStayCv ** 2);
    return Math.exp(Math.log(mean) - s2 / 2 + Math.sqrt(s2) * rng.normal());
  }

  private depart(p: Patient, outcome: Outcome): void {
    const r = this.rt[p.id]!;
    r.finished = true;
    p.outcome = outcome;
    p.departureTime = this.clock;
    this.active.delete(p.id);
    this.inSystem--;
    if (!r.seen) this.notSeen--;
    this.counts[outcome === 'lwbs' ? 'lwbs' : outcome]++;
    // Cancel anything still queued for them.
    r.taskIds.forEach((tid, i) => {
      if (tid === undefined || r.status[i] !== 'queued') return;
      this.pools[this.tasks.get(tid)!.pool].remove(tid);
      this.tasks.delete(tid);
    });
    if (p.lane !== undefined) this.bedQueues[p.lane].remove(p.id);
    if (this.holdsBed(p)) this.releaseBed(p);
  }

  // --- diagnostics module -------------------------------------------------------

  /** Order the tests this patient's condition calls for; the workup ends when the last result is back. */
  private orderTests(p: Patient, step: number): void {
    const c = this.config;
    const r = this.rt[p.id]!;
    const chances = c.diagnostics.ordersByCondition[p.conditionId] ?? {};
    const rng = r.rng.stream('orders');
    const wanted = SERVICE_IDS.filter((sv) => rng.next() < (chances[sv] ?? 0));
    if (!wanted.length) return this.completeStep(p, step);
    r.status[step] = 'turnaround';
    r.pendingOrders = wanted.length;
    p.orders = [];
    for (const sv of wanted) {
      const id = this.orderLog.length;
      this.orderLog.push({ patientId: p.id, step, service: sv, index: p.orders.length });
      p.orders.push({ service: sv, orderedAt: this.clock });
      const q = this.services![sv];
      // Sickest first, then first come.
      q.queue.push(id, p.assignedAcuity ?? 3, this.clock);
      if (this.clock >= c.warmupMinutes) q.peakQueue = Math.max(q.peakQueue, q.queue.size);
      this.runService(sv);
    }
  }

  private serviceOpen(sv: ServiceId, t: number): boolean {
    const h = this.config.diagnostics.services[sv].openHours;
    if (!h) return true;
    const hour = ((((this.config.startDayOfWeek * 24 + this.config.startHour) * 60 + t) / 60) % 24 + 24) % 24;
    return h[0] <= h[1] ? hour >= h[0] && hour < h[1] : hour >= h[0] || hour < h[1];
  }

  /** Start as many queued orders as there are free servers (if the service is open). */
  private runService(sv: ServiceId): void {
    const c = this.config;
    const spec = c.diagnostics.services[sv];
    const q = this.services![sv];
    if (!this.serviceOpen(sv, this.clock)) {
      if (q.queue.size && !q.openScheduled && spec.openHours) {
        const hourNow = ((((c.startDayOfWeek * 24 + c.startHour) * 60 + this.clock) / 60) % 24 + 24) % 24;
        const wait = ((spec.openHours[0] - hourNow + 24) % 24) * 60;
        q.openScheduled = true;
        this.push(this.clock + Math.max(1e-6, wait), { kind: 'serviceOpen', service: sv });
      }
      return;
    }
    while (q.busy < spec.servers && q.queue.size) {
      const id = q.queue.pop()!;
      const o = this.orderLog[id]!;
      const p = this.patients[o.patientId]!;
      if (this.rt[p.id]!.finished) continue;
      q.busy++;
      p.orders![o.index]!.startedAt = this.clock;
      const minutes = drawDuration(this.rt[p.id]!.rng.stream(`service:${sv}`), spec.processMinutes, c.diagnostics.cv, 'lognormal');
      const end = this.clock + minutes;
      q.busyMinutes += Math.max(0, Math.min(end, c.durationMinutes) - Math.max(this.clock, c.warmupMinutes));
      this.push(end, { kind: 'serviceEnd', order: id });
    }
  }

  private onServiceEnd(id: number): void {
    const o = this.orderLog[id]!;
    const p = this.patients[o.patientId]!;
    const q = this.services![o.service];
    q.busy--;
    p.orders![o.index]!.doneAt = this.clock;
    const report = this.config.diagnostics.services[o.service].reportMinutes;
    const minutes = report > 0 ? drawDuration(this.rt[p.id]!.rng.stream(`report:${o.service}`), report, this.config.diagnostics.cv, 'lognormal') : 0;
    this.push(this.clock + minutes, { kind: 'resultReady', order: id });
    this.runService(o.service);
  }

  private onResultReady(id: number): void {
    const o = this.orderLog[id]!;
    const p = this.patients[o.patientId]!;
    const r = this.rt[p.id]!;
    p.orders![o.index]!.resultAt = this.clock;
    if (r.finished) return;
    r.pendingOrders--;
    if (r.pendingOrders === 0) this.completeStep(p, o.step);
  }

  /** Busy server-minutes and peak queue per service inside the measurement window (for metrics). */
  serviceStats(): Record<ServiceId, { busyMinutes: number; peakQueue: number; queued: number }> | null {
    if (!this.services) return null;
    return Object.fromEntries(SERVICE_IDS.map((sv) => [sv, { busyMinutes: this.services![sv].busyMinutes, peakQueue: this.services![sv].peakQueue, queued: this.services![sv].queue.size }])) as Record<
      ServiceId,
      { busyMinutes: number; peakQueue: number; queued: number }
    >;
  }

  // --- security module ----------------------------------------------------------

  /** When an at-risk patient's patience for waiting runs out (shorter when the department is crowded). */
  private scheduleAgitation(p: Patient): void {
    const sc = this.config.security;
    const r = this.rt[p.id]!;
    const rng = r.rng.stream(`agitation:${p.incidents ?? 0}:${p.boardingStartTime === undefined ? 'wait' : 'board'}`);
    const tolerance = drawDuration(rng, sc.toleranceMeanMinutes, sc.toleranceCv, 'lognormal') / (1 + (sc.crowdingEffect * this.notSeen) / 10);
    this.push(this.clock + tolerance, { kind: 'agitate', patientId: p.id, token: ++r.agitationToken });
  }

  private onAgitate(id: number, token: number): void {
    const p = this.patients[id]!;
    const r = this.rt[id]!;
    if (token !== r.agitationToken || p.departureTime !== undefined) return;
    const boarding = p.boardingStartTime !== undefined;
    // Once a clinician has seen them (and they are not stuck boarding), they are being looked after.
    if (!boarding && r.seen) return;
    this.incident(p);
  }

  private incident(p: Patient): void {
    const c = this.config;
    const sc = c.security;
    const r = this.rt[p.id]!;
    p.incidents = (p.incidents ?? 0) + 1;
    p.lastIncidentAt = this.clock;
    const rng = r.rng.stream(`incident:${p.incidents}`);
    const [uViolent, uInjury, uLeave, uTime] = [rng.next(), rng.next(), rng.next(), rng];
    const where = this.holdsBed(p) && p.lane !== undefined && p.bed !== undefined ? this.bedLoc[p.lane][p.bed]! : this.waitLoc(p);
    const free = (s: Staff) => !s.retiring && s.taskId === null && (s.incidentUntil ?? -1) <= this.clock;
    const officer = this.staff.find((s) => s.role === 'security' && !s.retiring && (s.incidentUntil ?? -1) <= this.clock);
    const walk = (s: Staff) => (c.layout ? c.layout.dist[s.loc]![where]! * c.walking.minutesPerCell : 0);
    const violent = uViolent < Math.min(1, sc.violentShare * (officer ? 1 : sc.noSecurityViolentFactor));
    const injury = violent && uInjury < (officer ? sc.injuryWithSecurity : sc.injuryWithoutSecurity);
    const handle = drawDuration(uTime, violent ? sc.violentMinutes : sc.verbalMinutes, 0.6, 'lognormal');
    let responder: IncidentRecord['responder'] = 'none';
    let response: number | null = null;
    if (officer) {
      response = sc.responseMinutes + walk(officer);
      officer.incidentUntil = this.clock + response + handle;
      officer.incidentPatient = p.id;
      this.push(officer.incidentUntil, { kind: 'incidentDone' });
      responder = 'security';
    } else {
      // No officer free: a clinician steps in (the triage nurse first), leaving their patients waiting.
      const roles: Role[] = ['triageNurse', 'doctor'];
      let s = roles.map((role) => this.staff.find((x) => x.role === role && free(x))).find((x) => x !== undefined);
      if (s) {
        s.incidentUntil = this.clock + handle;
        s.incidentPatient = p.id;
        this.push(s.incidentUntil, { kind: 'incidentDone' });
      } else {
        s = roles.map((role) => this.staff.find((x) => x.role === role && !x.retiring && x.taskId !== null && x.taskEnd !== undefined)).find((x) => x !== undefined);
        if (s) {
          // Their current task is put off by the time it takes.
          s.taskEnd = s.taskEnd! + handle;
          this.push(s.taskEnd, { kind: 'taskEnd', staffId: s.id, token: ++s.taskToken });
        }
      }
      if (s) {
        responder = 'clinician';
        response = walk(s);
      }
    }
    this.incidentLog.push({ time: this.clock, patientId: p.id, violent, injury, responder, responseMinutes: response, handleMinutes: handle, boarding: p.boardingStartTime !== undefined });
    // Afterwards: some leave before being seen; others settle for a while and may flare up again.
    if (!r.seen && !r.finished && uLeave < sc.leaveAfterIncident) {
      if (r.activeTasks > 0) r.wantsToLeave = true;
      else this.leaveWithoutBeingSeen(p);
    } else if (p.incidents < sc.maxIncidentsPerPatient) this.scheduleAgitation(p);
  }

  private leaveWithoutBeingSeen(p: Patient): void {
    this.depart(p, 'lwbs');
  }

  private onAbandon(id: number): void {
    const p = this.patients[id]!;
    const r = this.rt[id]!;
    if (r.finished || r.seen) return;
    if (r.activeTasks > 0) r.wantsToLeave = true; // leaves when the current step ends
    else this.leaveWithoutBeingSeen(p);
  }

  private scheduleDeterioration(p: Patient): void {
    const r = this.rt[p.id]!;
    if (p.trueAcuity === 1) return;
    const { scaleMinutesByAcuity, shape } = this.config.deterioration;
    const u = r.rng.stream(`deteriorate:${p.deteriorations}`).next();
    // Weibull: time to worsen, measured from arrival. Hazard rises with time waited.
    const scale = scaleMinutesByAcuity[p.trueAcuity];
    const sinceArrival = scale * Math.pow(-Math.log(1 - u), 1 / shape);
    const at = Math.max(this.clock, p.arrivalTime + sinceArrival);
    this.push(at, { kind: 'deteriorate', patientId: p.id, token: ++r.deteriorationToken });
  }

  private onDeteriorate(id: number, token: number): void {
    const p = this.patients[id]!;
    const r = this.rt[id]!;
    if (r.finished || r.seen || token !== r.deteriorationToken) return;
    p.trueAcuity = Math.max(1, p.trueAcuity - 1) as Acuity;
    p.deteriorations++;
    this.counts.deteriorations++;
    if (p.trueAcuity === 1) p.becameCritical = true;
    // Staff notice: if already triaged, their priority is raised to match.
    if (p.assignedAcuity !== undefined && p.assignedAcuity > p.trueAcuity) {
      p.assignedAcuity = p.trueAcuity;
      this.requeue(p);
    }
    this.scheduleDeterioration(p);
  }

  /** Re-sort a patient's queued tasks and bed request after their priority changed. */
  private requeue(p: Patient): void {
    const r = this.rt[p.id]!;
    r.taskIds.forEach((tid, i) => {
      if (tid === undefined || r.status[i] !== 'queued') return;
      const task = this.tasks.get(tid)!;
      this.pools[task.pool].remove(tid);
      this.pools[task.pool].push(tid, this.taskClass(p, r.pipe.steps[i]!), task.readyTime);
    });
    if (p.lane !== undefined && this.bedQueues[p.lane].remove(p.id)) this.bedQueues[p.lane].push(p.id, this.bedClass(p), p.bedRequestTime!);
  }

  // --- beds ---------------------------------------------------------------------

  private fastTrackOpen(): boolean {
    return this.fastTrackEnabled && this.activeCount('fastTrackClinician') > 0;
  }

  private routeLane(p: Patient): Lane {
    if (p.assignedAcuity === undefined || !this.fastTrackOpen()) return 'main';
    if (this.routing.length > 0) {
      const rule = this.routing.find((x) => p.assignedAcuity! >= x.minAcuity && p.assignedAcuity! <= x.maxAcuity);
      return rule?.lane ?? 'main';
    }
    return p.assignedAcuity >= this.fastTrackMinAcuity ? 'fastTrack' : 'main';
  }

  private bedClass(p: Patient): number {
    return this.discipline === 'acuity' ? (p.assignedAcuity ?? 3) : 0;
  }

  private requestBed(p: Patient): void {
    const r = this.rt[p.id]!;
    if (r.bedRequested) return;
    r.bedRequested = true;
    p.bedRequestTime = this.clock;
    p.lane = this.routeLane(p);
    this.bedQueues[p.lane].push(p.id, this.bedClass(p), p.bedRequestTime);
    this.fillBeds(p.lane);
  }

  private fillBeds(lane: Lane): void {
    const used = this.bedsUsed[lane];
    const nursing = lane === 'main' && this.config.modules.nursing;
    if (nursing) this.nursingBlocked = false;
    for (;;) {
      const occupied = used.filter((x) => x !== null).length;
      if (occupied >= this.bedCapacity[lane] + this.hallwayFor(lane) || this.bedQueues[lane].size === 0) return;
      const next = this.patients[this.bedQueues[lane].peek()!]!;
      // Staffed beds: the nurses on duty must be able to take one more patient like this.
      if (nursing && this.nurseLoad() + this.nurseWeight(next) > this.activeCount('nurse') + 1e-9) {
        this.nursingBlocked = true;
        return;
      }
      const idx = this.pickBed(lane, next);
      if (idx < 0) return;
      const id = this.bedQueues[lane].pop()!;
      const p = this.patients[id]!;
      used[idx] = id;
      p.bed = idx;
      if (this.isHallway(lane, idx)) p.hallway = true;
      p.bedTime = this.clock;
      // Walk (or be wheeled) from the waiting room to the bed.
      const c = this.config;
      const from = this.waitLoc(p);
      const walk = c.layout ? c.layout.dist[from]![this.bedLoc[lane][idx]!]! * c.walking.minutesPerCell : c.walking.disabledTransferMinutes;
      if (c.layout) this.recordTrip('patient', from, this.bedLoc[lane][idx]!, 1);
      if (walk > 0) this.push(this.clock + walk, { kind: 'transferEnd', patientId: id });
      else {
        this.rt[id]!.hasBed = true;
        this.advance(p);
      }
    }
  }

  /**
   * Which free bed a patient gets. Beds below traumaBays are trauma bays: the sickest patients
   * (triaged at or below traumaMaxAcuity) take one first; everyone else takes a regular bed and
   * uses a bay only when no regular bed is free. The choice never changes how many beds are in use.
   */
  private pickBed(lane: Lane, p: Patient): number {
    const used = this.bedsUsed[lane];
    const cap = this.bedCapacity[lane];
    const bays = lane === 'main' ? Math.min(this.config.traumaBays, cap) : 0;
    const sick = (p.assignedAcuity ?? p.trueAcuity) <= this.config.traumaMaxAcuity;
    const free = (i: number) => i >= used.length || used[i] === null;
    const firstFree = (from: number, to: number) => {
      for (let i = from; i < to; i++) if (free(i)) return i;
      return -1;
    };
    // Regular beds run from `bays` up to the capacity (or one past the end when unlimited);
    // hallway spaces, if open, come after the capacity and are used last.
    const top = Number.isFinite(cap) ? cap : Math.max(used.length, bays) + 1;
    const order = sick ? [firstFree(0, bays), firstFree(bays, top)] : [firstFree(bays, top), firstFree(0, bays)];
    let idx = order.find((i) => i >= 0) ?? (Number.isFinite(cap) ? firstFree(cap, cap + this.hallwayFor(lane)) : firstFree(0, Math.max(used.length + 1, top)));
    if (idx < 0) {
      if (Number.isFinite(cap)) return -1;
      idx = used.length;
    }
    while (used.length <= idx) used.push(null);
    return idx;
  }

  private hallwayFor(lane: Lane): number {
    return lane === 'main' && Number.isFinite(this.bedCapacity.main) ? this.hallwayBeds : 0;
  }

  private isHallway(lane: Lane, idx: number): boolean {
    return lane === 'main' && Number.isFinite(this.bedCapacity.main) && idx >= this.bedCapacity.main;
  }

  private releaseBed(p: Patient): void {
    const lane = p.lane!;
    const used = this.bedsUsed[lane];
    const freed = p.bed!;
    used[freed] = null;
    this.rt[p.id]!.hasBed = false;
    if (!this.isHallway(lane, freed)) {
      // A cubicle came free: whoever has been in a hallway space longest moves into it.
      let from = -1;
      for (let i = this.bedCapacity[lane]; i < used.length; i++) {
        const id = used[i];
        if (id === null || id === undefined || !this.rt[id]!.hasBed) continue;
        if (from < 0 || this.patients[id]!.bedTime! < this.patients[used[from]!]!.bedTime!) from = i;
      }
      if (from >= 0) {
        const mover = this.patients[used[from]!]!;
        used[freed] = mover.id;
        used[from] = null;
        mover.bed = freed;
      }
    }
    this.fillBeds(lane);
  }

  /** Share of a bedside nurse a patient in a main ED bed needs (nursing module). */
  private nurseWeight(p: Patient): number {
    const n = this.config.nursing;
    if (p.admitUnit === 'icu' && p.boardingStartTime !== undefined) return 1 / n.icuBoarderPatientsPerNurse;
    return 1 / n.patientsPerNurseByAcuity[p.assignedAcuity ?? p.trueAcuity];
  }

  /** Nurses' worth of patients in main ED beds now. */
  private nurseLoad(): number {
    let load = 0;
    for (const id of this.bedsUsed.main) if (id !== null && id !== undefined) load += this.nurseWeight(this.patients[id]!);
    return load;
  }

  /** Holds a bed (in it, or on the way to it). */
  private holdsBed(p: Patient): boolean {
    return p.lane !== undefined && p.bed !== undefined && this.bedsUsed[p.lane][p.bed] === p.id;
  }

  /** Patients still waiting for a bed are re-routed when fast track opens or closes. */
  private rerouteBedQueues(): void {
    const ids = [...this.bedQueues.main.drain(), ...this.bedQueues.fastTrack.drain()].sort((a, b) => a - b);
    for (const id of ids) {
      const p = this.patients[id]!;
      p.lane = this.routeLane(p);
      this.bedQueues[p.lane].push(id, this.bedClass(p), p.bedRequestTime!);
    }
    this.fillBeds('main');
    this.fillBeds('fastTrack');
  }

  /** Re-key every queued task (after the queue discipline changed). */
  private requeueAll(): void {
    for (const id of this.active) if (!this.rt[id]!.finished) this.requeue(this.patients[id]!);
  }

  // --- staff --------------------------------------------------------------------

  private afterChange(): void {
    const open = this.fastTrackOpen();
    if (open !== this.fastTrackWasOpen) {
      this.fastTrackWasOpen = open;
      this.rerouteBedQueues();
    }
    // Staffed beds: a nurse coming on shift (or a patient needing less nursing) can open a bed.
    if (this.config.modules.nursing) this.fillBeds('main');
    this.dispatch();
    this.updateCounters();
  }

  /** Give free staff the next task from their pool (lowest staff id first). */
  /**
   * Pre-emption: a patient triaged at or above `preemptAcuity` who is ready for a doctor, with no
   * doctor free, takes the doctor whose current patient is least urgent (most recently started first).
   * The interrupted work goes back in the queue and resumes where it stopped.
   */
  private preempt(): void {
    const level = this.config.preemptAcuity;
    if (level < 1 || this.discipline !== 'acuity') return;
    for (;;) {
      const urgent = this.pools.doctor
        .ids()
        .map((tid) => this.tasks.get(tid)!)
        .find((t) => this.stepOf(t).kind === 'doctorEval' && (this.patients[t.patientId]!.assignedAcuity ?? 9) <= level);
      if (!urgent) return;
      const victims = this.staff
        .filter((x) => x.role === 'doctor' && !x.retiring && x.taskId !== null)
        .map((x) => ({ x, t: this.tasks.get(x.taskId!)! }))
        .filter(({ t }) => (this.patients[t.patientId]!.assignedAcuity ?? 3) > level)
        .sort((a, b) => b.x.taskStart! - a.x.taskStart! || a.x.id - b.x.id);
      const v = victims[0];
      if (!v) return;
      // Pause the victim's task and put it back in the queue.
      const s = v.x;
      const t = v.t;
      t.remaining = Math.max(0, s.taskEnd! - this.clock);
      s.busyMinutes += this.clock - s.taskStart!;
      s.taskId = null;
      s.taskStart = undefined;
      s.taskToken++;
      const vp = this.patients[t.patientId]!;
      const vr = this.rt[vp.id]!;
      vr.activeTasks--;
      vr.status[t.step] = 'queued';
      this.pools[t.pool].push(t.id, this.taskClass(vp, vr.pipe.steps[t.step]!), t.readyTime);
      this.pools.doctor.remove(urgent.id);
      this.startTask(s, urgent);
      this.preemptions++;
    }
  }

  private dispatch(): void {
    this.preempt();
    const ftClosed = !this.fastTrackOpen();
    for (const s of this.staff) {
      if (s.taskId !== null || s.retiring || (s.incidentUntil ?? -1) > this.clock) continue;
      let tid = this.pools[s.role].pop();
      if (tid === undefined && s.role === 'doctor' && (this.config.fastTrack.doctorsTakeOverflow || ftClosed)) {
        // A free main-ED doctor picks up fast-track work rather than sit idle.
        tid = this.pools.fastTrackClinician.pop();
      }
      if (tid === undefined) continue;
      this.startTask(s, this.tasks.get(tid)!);
    }
  }

  private startTask(s: Staff, task: Task): void {
    const c = this.config;
    const p = this.patients[task.patientId]!;
    const r = this.rt[p.id]!;
    const step = r.pipe.steps[task.step]!;
    const fatigue = this.fatigue(s);
    s.taskId = task.id;
    s.taskStart = this.clock;
    r.status[task.step] = 'active';
    p.steps[step.id] = { kind: step.kind, start: p.steps[step.id]?.start ?? this.clock };
    r.activeTasks++;
    if (task.remaining !== undefined) {
      // Resuming work that was interrupted by a more urgent patient.
      s.taskEnd = this.clock + task.remaining;
      task.remaining = undefined;
      this.push(s.taskEnd, { kind: 'taskEnd', staffId: s.id, token: ++s.taskToken });
      return;
    }
    if (step.kind === 'triage') {
      p.triageStartTime = this.clock;
      r.triageFatigue = fatigue;
    }
    if (step.kind === 'doctorEval') this.markSeen(p, s.id, fatigue);

    let minutes = drawDuration(r.rng.stream(`step:${step.id}`), step.meanMinutesByAcuity[p.trueAcuity], step.cv, step.distribution);
    if (c.modules.diagnosis && DIAGNOSTIC_KINDS.includes(step.kind)) {
      const [f0, f1] = c.diagnosis.timeFactorRange;
      // Scaled so the baseline thoroughness leaves the params' service times unchanged.
      const at = (t: number) => f0 + (f1 - f0) * t;
      minutes *= at(step.thoroughness) / at(c.diagnosis.baselineThoroughness);
    }
    if (c.modules.burnout) minutes *= 1 + c.burnout.timeEffect * fatigue;
    if (s.role === 'fastTrackClinician') minutes *= c.fastTrack.serviceFactor;
    if (p.lane !== undefined && p.bed !== undefined && this.holdsBed(p) && this.isHallway(p.lane, p.bed)) minutes *= c.liveCalls.hallwayServiceFactor;
    if (c.layout) {
      // Staff work from a home base (station, or their triage room) and make a round trip for each task:
      // out to the patient and back to document. Triage nurses fetch the patient from the waiting room.
      const where = step.kind === 'triage' ? this.waitLoc(p) : this.taskLocation(s, p, step);
      const walk = 2 * c.layout.dist[s.loc]![where]! * c.walking.minutesPerCell;
      minutes += walk;
      if (this.clock >= c.warmupMinutes) this.walkingMinutes[s.role] += walk;
      this.recordTrip('staff', s.loc, where, 2);
    }
    s.taskEnd = this.clock + minutes;
    this.push(s.taskEnd, { kind: 'taskEnd', staffId: s.id, token: ++s.taskToken });
  }

  /** Where a task happens (layout module). */
  private taskLocation(s: Staff, p: Patient, step: StepDef): number {
    if (this.holdsBed(p)) return this.bedLoc[p.lane!][p.bed!]!;
    if (step.kind === 'triage' && this.triageLocs.length) return this.triageLocs[s.id % this.triageLocs.length]!;
    return this.waitLoc(p);
  }

  /** Where a patient waits before they have a bed: ambulance arrivals by the ambulance door, if there is one. */
  private waitLoc(p: Patient): number {
    return p.byAmbulance && this.ambulanceLoc >= 0 ? this.ambulanceLoc : this.waitingLoc;
  }

  private recordTrip(who: 'staff' | 'patient', from: number, to: number, count: number): void {
    if (from === to || this.clock < this.config.warmupMinutes) return;
    const key = `${who}:${from}:${to}`;
    this.trips.set(key, (this.trips.get(key) ?? 0) + count);
  }

  /** Walks so far in the measurement window (layout module), for heat maps (`walkHeat`). */
  walkTrips(who: 'staff' | 'patient' | 'all' = 'all'): WalkTrip[] {
    const out: WalkTrip[] = [];
    for (const [k, count] of this.trips) {
      const [w, from, to] = k.split(':');
      if (who === 'all' || w === who) out.push({ from: Number(from), to: Number(to), count });
    }
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  }

  private onTaskEnd(staffId: number): void {
    const s = this.staff.find((x) => x.id === staffId)!;
    const task = this.tasks.get(s.taskId!)!;
    this.tasks.delete(task.id);
    s.busyMinutes += this.clock - s.taskStart!;
    s.taskId = null;
    s.taskStart = undefined;
    if (s.retiring) this.removeStaff(s);
    const p = this.patients[task.patientId]!;
    const r = this.rt[p.id]!;
    r.activeTasks--;
    if (r.finished) return;
    r.taskIds[task.step] = undefined;
    this.startTurnaround(p, task.step);
  }

  private fatigue(s: Staff): number {
    if (!this.config.modules.burnout) return 0;
    const b = this.config.burnout;
    const busy = s.busyMinutes + (s.taskStart !== undefined ? this.clock - s.taskStart : 0);
    return (b.perBusyHour * busy) / 60 + (b.perShiftHour * Math.max(0, this.clock - s.shiftStart)) / 60;
  }

  private activeCount(role: Role): number {
    let n = 0;
    for (const s of this.staff) if (s.role === role && !s.retiring) n++;
    return n;
  }

  private addStaff(role: Role, occ: string | undefined, shiftStart: number): number {
    const id = this.nextStaffId++;
    // Staff start at their base: triage room for triage nurses, the staff station for everyone else.
    const loc = !this.config.layout
      ? 0
      : role === 'security'
        ? this.waitingLoc
        : role === 'triageNurse' && this.triageLocs.length
        ? this.triageLocs[id % this.triageLocs.length]!
        : role === 'fastTrackClinician' && this.bedLoc.fastTrack.length
          ? this.bedLoc.fastTrack[0]!
          : this.stationLoc;
    this.staff.push({ id, role, taskId: null, retiring: false, occ, shiftStart, busyMinutes: 0, loc, taskToken: 0 });
    return id;
  }

  private removeStaff(s: Staff): void {
    this.fatigueLog.push({ role: s.role, start: s.shiftStart, end: this.clock, fatigue: this.fatigue(s) });
    this.staff.splice(this.staff.indexOf(s), 1);
  }

  /** Send someone home: now if idle, else after their current task. */
  private retire(s: Staff): void {
    if (s.taskId === null) this.removeStaff(s);
    else s.retiring = true;
  }

  /**
   * Bring a role's staff in line with its schedule (one group per shift occurrence in progress)
   * or its fixed target. Manual extras from setStaff last until the role's next shift boundary.
   */
  private reconcileStaff(role: Role): void {
    const shifts = this.schedule[role];
    const mine = () => this.staff.filter((s) => s.role === role && !s.retiring && !s.callIn);
    if (!shifts) {
      const active = mine();
      for (let n = active.length; n < this.fixedTarget[role]; n++) this.addStaff(role, undefined, this.clock);
      // Newest leave first, idle before busy.
      const extra = active.length - this.fixedTarget[role];
      if (extra > 0) {
        const order = [...active].reverse().sort((a, b) => Number(a.taskId !== null) - Number(b.taskId !== null));
        order.slice(0, extra).forEach((s) => this.retire(s));
      }
      return;
    }
    const current = occurrencesInRun(shifts, this.calendarOffset, this.clock, this.clock + 1e-9).filter((o) => o.start <= this.clock && this.clock < o.end);
    const keys = new Set(current.map((o) => o.key));
    for (const s of mine()) if (s.occ === undefined || !keys.has(s.occ)) this.retire(s);
    for (const o of current) {
      const members = mine().filter((s) => s.occ === o.key);
      for (let n = members.length; n < o.count; n++) this.addStaff(role, o.key, o.start);
      members.slice(o.count).forEach((s) => this.retire(s));
    }
  }

  private setStaffNow(role: Role, target: number): void {
    const active = this.staff.filter((s) => s.role === role && !s.retiring && !s.callIn);
    // Cancel pending departures first, then bring in extras.
    let n = active.length;
    for (const s of this.staff) {
      if (n >= target) break;
      if (s.role === role && s.retiring && !s.callIn) {
        s.retiring = false;
        n++;
      }
    }
    for (; n < target; n++) this.addStaff(role, undefined, this.clock);
    const now = this.staff.filter((s) => s.role === role && !s.retiring && !s.callIn);
    const extra = now.length - target;
    if (extra > 0) {
      const order = [...now].reverse().sort((a, b) => Number(a.taskId !== null) - Number(b.taskId !== null));
      order.slice(0, extra).forEach((s) => this.retire(s));
    }
  }

  private scheduleShiftEvents(role: Role): void {
    const version = this.scheduleVersion[role];
    for (const t of scheduleBoundaries(this.schedule[role]!, this.calendarOffset, this.config.durationMinutes)) {
      if (t > this.clock) this.push(t, { kind: 'shift', role, version });
    }
  }

  /** Fixed (unscheduled) staff hand over every few hours: fatigue starts again. */
  private onHandover(): void {
    for (const s of this.staff) {
      if (s.occ !== undefined || this.schedule[s.role]) continue;
      this.fatigueLog.push({ role: s.role, start: s.shiftStart, end: this.clock, fatigue: this.fatigue(s) });
      s.shiftStart = this.clock;
      s.busyMinutes = s.taskStart !== undefined ? -(this.clock - s.taskStart) : 0;
    }
  }

  // --- commands --------------------------------------------------------------

  private apply(cmd: Command): void {
    this.log.push({ atMinute: this.clock, command: JSON.parse(JSON.stringify(cmd)) as Command });
    switch (cmd.type) {
      case 'setStaff':
        if (this.schedule[cmd.role]) this.setStaffNow(cmd.role, cmd.count);
        else {
          this.fixedTarget[cmd.role] = cmd.count;
          this.setStaffNow(cmd.role, cmd.count);
        }
        break;
      case 'setSchedule':
        this.schedule[cmd.role] = cmd.shifts;
        this.scheduleVersion[cmd.role]++;
        this.reconcileStaff(cmd.role);
        this.scheduleShiftEvents(cmd.role);
        break;
      case 'setQueueDiscipline':
        this.discipline = cmd.discipline;
        break;
      case 'setFastTrack':
        this.fastTrackEnabled = cmd.enabled;
        if (cmd.minAcuity !== undefined) this.fastTrackMinAcuity = cmd.minAcuity;
        break;
      case 'setBeds':
        this.bedCapacity[cmd.lane] = cmd.count ?? Infinity;
        break;
      case 'setEscalation':
        this.escalated = cmd.enabled;
        break;
      case 'setProcess':
        this.pipe = makePipe(cmd.steps.map((s: StepInput) => resolveStep(s)));
        this.routing = (cmd.routing ?? []) as RoutingRule[];
        break;
      case 'setThoroughness':
        this.thoroughness = cmd.value;
        this.pipe = makePipe(this.pipe.steps.map((s) => (DIAGNOSTIC_KINDS.includes(s.kind) ? { ...s, thoroughness: cmd.value } : s)));
        break;
      case 'callIn': {
        const at = this.clock + this.config.liveCalls.callInDelayMinutes;
        this.callInsUsed++;
        this.callInsPending.push({ role: cmd.role, at });
        this.push(at, { kind: 'callInArrive', role: cmd.role });
        break;
      }
      case 'setDiversion':
        this.diversion = cmd.enabled;
        break;
      case 'setHallwayBeds':
        this.hallwayBeds = cmd.count;
        break;
      case 'moveStaff': {
        // Whoever will be free soonest (idle first); they finish any current task in their old role.
        const pick = this.staff
          .filter((s) => s.role === cmd.from && !s.retiring)
          .sort((a, b) => (a.taskEnd ?? -1) - (b.taskEnd ?? -1) || a.id - b.id)[0];
        if (!pick) break;
        pick.role = cmd.to;
        if (!this.schedule[cmd.from]) this.fixedTarget[cmd.from] = Math.max(0, this.fixedTarget[cmd.from] - 1);
        if (!this.schedule[cmd.to]) this.fixedTarget[cmd.to]++;
        break;
      }
    }
    // Routing or queue order may have changed.
    this.fastTrackWasOpen = this.fastTrackOpen();
    this.rerouteBedQueues();
    this.requeueAll();
    this.dispatch();
    this.updateCounters();
  }

  private updateCounters(): void {
    const t = this.clock;
    this.tw.inSystem.set(t, this.inSystem);
    // "Waiting" = in the department and not yet seen by a doctor.
    this.tw.waiting.set(t, this.notSeen);
    this.tw.boarding.set(t, this.boarders.length);
    for (const lane of ['main', 'fastTrack'] as const) {
      const occupied = this.bedsUsed[lane].filter((x) => x !== null).length;
      this.tw.bedsOccupied[lane].set(t, occupied);
      this.tw.bedsCosted[lane].set(t, Number.isFinite(this.bedCapacity[lane]) ? this.bedCapacity[lane] : occupied);
    }
    this.tw.escalated.set(t, this.config.modules.boarding && this.escalated ? 1 : 0);
    this.tw.diversion.set(t, this.diversion ? 1 : 0);
    this.tw.hallway.set(t, this.bedsUsed.main.filter((id, i) => id !== null && this.isHallway('main', i)).length);
    this.tw.hallwayOpen.set(t, this.hallwayFor('main'));
    {
      // Why patients are waiting for a main ED bed: all beds full (and how much of that is boarders), or a free bed with no nurse.
      const waiting = this.bedQueues.main.size;
      const used = this.bedsUsed.main.filter((x) => x !== null);
      const full = used.length >= this.bedCapacity.main + this.hallwayFor('main');
      const boarders = used.filter((id) => this.patients[id!]!.boardingStartTime !== undefined).length;
      this.tw.bedWaitFull.set(t, full ? waiting : 0);
      this.tw.bedWaitBoarders.set(t, full && used.length ? (waiting * boarders) / used.length : 0);
      this.tw.bedWaitNursing.set(t, !full && this.nursingBlocked ? waiting : 0);
    }
    for (const role of ROLES) this.tw.callIn[role].set(t, this.staff.filter((s) => s.role === role && s.callIn).length);
    for (const role of ROLES) {
      let busy = 0;
      let duty = 0;
      for (const s of this.staff) {
        if (s.role !== role) continue;
        duty++;
        if (s.taskId !== null) busy++;
      }
      this.tw.busy[role].set(t, busy);
      this.tw.onDuty[role].set(t, duty);
    }
  }
}

/** A duration with the given mean: exponential, or lognormal with coefficient of variation `cv` (0 = fixed). */
function drawDuration(rng: Rng, mean: number, cv: number, distribution: 'exponential' | 'lognormal'): number {
  if (!(mean > 0)) return 0;
  if (distribution === 'exponential') return rng.exponential(mean);
  if (!(cv > 0)) return mean;
  return rng.lognormal(mean, cv);
}

/** Age (triangular over the condition's range), sex and presenting complaint. */
export function drawProfile(rng: Rng, c: ConditionSpec): PatientProfile {
  const [lo, mode, hi] = c.ages ?? [18, 45, 90];
  const u = rng.next();
  const f = (mode - lo) / Math.max(1e-9, hi - lo);
  const x = u < f ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
  const sex = rng.next() < (c.femaleShare ?? 0.5) ? 'F' : 'M';
  const complaints = c.complaints?.length ? c.complaints : ['unwell'];
  const complaint = complaints[rng.int(complaints.length)]!;
  // A child: one more draw after the others, so adults keep exactly the profile they had.
  if (c.childShare && rng.next() < c.childShare) {
    const [clo, cmode, chi] = PARAMS.childAges;
    const cf = (cmode - clo) / (chi - clo);
    const age = u < cf ? clo + Math.sqrt(u * (chi - clo) * (cmode - clo)) : chi - Math.sqrt((1 - u) * (chi - clo) * (chi - cmode));
    return { age: Math.floor(age), sex: rng.next() < 0.5 ? 'F' : 'M', complaint };
  }
  return { age: Math.floor(x), sex, complaint };
}
