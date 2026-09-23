import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { Simulation } from '../src/engine.js';
import { checkPipeline, makeStep } from '../src/pipeline.js';

const flat = (perHour: number) => Array(24).fill(perHour);
const week = { id: 'p3', durationMinutes: 7 * 1440, warmupMinutes: 1440 };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('beds and workup', () => {
  it('never puts more patients in beds than there are beds', () => {
    const sim = new Simulation({ ...week, beds: { main: 3 }, staffing: { doctors: 6 }, arrivals: { hourlyRates: flat(8) } }, 1);
    for (let t = 0; t < 3 * 1440; t += 10) {
      sim.runUntil(t);
      const s = sim.snapshot();
      const inBeds = s.patients.filter((p) => p.location === 'bed' && p.lane === 'main');
      expect(inBeds.length).toBeLessThanOrEqual(3);
      expect(new Set(inBeds.map((p) => p.bed)).size).toBe(inBeds.length);
      expect(s.beds.main).toEqual({ capacity: 3, occupied: inBeds.length, traumaBays: 2 });
    }
    expect(sim.run().metrics.doorToBed.median!).toBeGreaterThan(30);
  });

  it('setBeds opens more space mid-run', () => {
    const sim = new Simulation({ ...week, beds: { main: 2 }, staffing: { doctors: 6 }, arrivals: { hourlyRates: flat(8) } }, 2);
    sim.runUntil(600);
    expect(sim.snapshot().patients.some((p) => p.waitingFor === 'bed')).toBe(true);
    sim.command({ type: 'setBeds', lane: 'main', count: null });
    expect(sim.snapshot().patients.some((p) => p.waitingFor === 'bed')).toBe(false);
  });

  it('workup holds the bed without holding a doctor, and lengthens stays', () => {
    const on = new Simulation(week, 3).run().metrics;
    const off = new Simulation({ ...week, workup: { enabled: false } }, 3).run().metrics;
    expect(on.lengthOfStay.median!).toBeGreaterThan(off.lengthOfStay.median! + 30);
    expect(on.bedOccupancy.main!).toBeGreaterThan(off.bedOccupancy.main! * 1.5);
    expect(Math.abs(on.utilizationByRole.doctor! - off.utilizationByRole.doctor!)).toBeLessThan(0.05);
  });
});

describe('boarding module', () => {
  const tight = { ...week, modules: { boarding: true }, boarding: { inpatientBeds: 30, initialOccupied: 30, dischargesPerDay: 12 } };

  it('off: admitted patients leave at once', () => {
    const sim = new Simulation(week, 1);
    const { metrics } = sim.run();
    expect(metrics.admitted).toBeGreaterThan(0);
    expect(metrics.boarding.boarders).toBe(0);
    expect(sim.snapshot().inpatient).toBeNull();
  });

  it('on and full: admitted patients board in ED beds, which blocks new patients', () => {
    const sim = new Simulation(tight, 1);
    for (let t = 0; t < 7 * 1440; t += 30) {
      sim.runUntil(t);
      const s = sim.snapshot();
      expect(s.inpatient!.occupied).toBeLessThanOrEqual(30);
      expect(s.patients.filter((p) => p.boarding)).toHaveLength(s.inpatient!.boarders);
      for (const p of s.patients.filter((x) => x.boarding)) expect(p.location).toBe('bed');
    }
    const m = sim.run().metrics;
    expect(m.boarding.hours).toBeGreaterThan(100);
    expect(m.bedOccupancy.main!).toBeGreaterThan(0.8);
    const roomy = new Simulation({ ...tight, boarding: { inpatientBeds: 200, initialOccupied: 0, dischargesPerDay: 40 } }, 1).run().metrics;
    expect(roomy.boarding.boarders).toBe(0);
    expect(m.lwbsRate).toBeGreaterThan(roomy.lwbsRate * 3);
  });

  it('when boarding is the bottleneck, more ED doctors barely help; more inpatient discharges do', () => {
    const lwbs = (cfg: object) => mean([1, 2, 3].map((s) => new Simulation(cfg, s).run().metrics.lwbsRate));
    const base = lwbs({ ...tight, boarding: { ...tight.boarding, dischargesPerDay: 16 } });
    const moreDoctors = lwbs({ ...tight, boarding: { ...tight.boarding, dischargesPerDay: 16 }, staffing: { doctors: 8 } });
    const moreDischarges = lwbs({ ...tight, boarding: { ...tight.boarding, dischargesPerDay: 30 } });
    expect(base - moreDoctors).toBeLessThan((base - moreDischarges) / 3);
  });
});

describe('diagnosis module', () => {
  it('off: no misdiagnosis, no bounce-backs', () => {
    const m = new Simulation(week, 1).run().metrics;
    expect(m.diagnosis.misdiagnosisRate).toBeNull();
    expect(m.arrivalsBySource.bounceBack).toBe(0);
  });

  it('more thoroughness: fewer misses, longer doctor time; less thoroughness brings patients back', () => {
    const run = (thoroughness: number, bounceBackProbability: number) => {
      const ms = [1, 2, 3].map((s) =>
        new Simulation({ ...week, modules: { diagnosis: true }, diagnosis: { thoroughness, bounceBackProbability } }, s).run().metrics,
      );
      return {
        miss: mean(ms.map((m) => m.diagnosis.misdiagnosisRate!)),
        util: mean(ms.map((m) => m.utilizationByRole.doctor!)),
        returns: mean(ms.map((m) => m.arrivalsBySource.bounceBack)),
      };
    };
    // Time effect alone (no returns): thorough doctors are busier.
    const [low, high] = [run(0.1, 0), run(0.9, 0)];
    expect(high.miss).toBeLessThan(low.miss / 2);
    expect(high.util).toBeGreaterThan(low.util);
    // With returns: cutting corners creates repeat visits.
    expect(run(0.1, 0.6).returns).toBeGreaterThan(run(0.9, 0.6).returns * 3);
  });

  it('bounce-backs return within 72 hours, sicker, as new arrivals', () => {
    const sim = new Simulation({ ...week, modules: { diagnosis: true }, diagnosis: { thoroughness: 0, bounceBackProbability: 1 } }, 4);
    const { metrics } = sim.run();
    const P = sim.allPatients();
    const returns = P.filter((p) => p.source === 'bounceBack');
    expect(returns.length).toBeGreaterThan(5);
    for (const r of returns) {
      const orig = P[r.bounceOf!]!;
      expect(orig.misdiagnosed).toBe(true);
      expect(orig.outcome).toBe('discharged');
      expect(r.arrivalTime - orig.departureTime!).toBeLessThanOrEqual(72 * 60);
      expect(r.initialAcuity).toBe(Math.max(1, orig.trueAcuity - 1));
      expect(r.conditionId).toBe(orig.conditionId);
    }
    expect(metrics.diagnosis.bounceBackRate72h!).toBeGreaterThan(0);
  });
});

describe('deterioration', () => {
  it('happens only before a doctor sees the patient, and more when waits are long', () => {
    const sim = new Simulation({ ...week, staffing: { doctors: 2 }, lwbs: { enabled: false } }, 1);
    const busy = sim.run().metrics;
    for (const p of sim.allPatients()) if (p.deteriorations > 0) expect(p.trueAcuity).toBe(Math.max(1, p.initialAcuity - p.deteriorations));
    const calm = new Simulation({ ...week, staffing: { doctors: 6 } }, 1).run().metrics;
    expect(busy.deterioration.per100Arrivals).toBeGreaterThan(calm.deterioration.per100Arrivals * 5);
    const off = new Simulation({ ...week, staffing: { doctors: 2 }, lwbs: { enabled: false }, deterioration: { enabled: false } }, 1).run().metrics;
    expect(off.deterioration.events).toBe(0);
  });

  it('staff notice: a triaged patient who worsens moves up the queue', () => {
    const sim = new Simulation({ ...week, staffing: { doctors: 1 }, lwbs: { enabled: false }, triage: { accuracy: 1 } }, 2);
    sim.run();
    const worsened = sim.allPatients().filter((p) => p.deteriorations > 0 && p.triageAssigned !== undefined && p.acuityAtTriage! > p.trueAcuity);
    expect(worsened.length).toBeGreaterThan(0);
    for (const p of worsened) expect(p.assignedAcuity).toBeLessThanOrEqual(p.triageAssigned!);
  });
});

describe('shocks module', () => {
  it('a surge multiplies arrivals in its window only', () => {
    const cfg = { id: 's', durationMinutes: 4 * 1440, modules: { shocks: true }, arrivals: { hourlyRates: flat(20), dayOfWeekMultipliers: [1, 1, 1, 1, 1, 1, 1] }, staffing: { doctors: 40, triageNurses: 8 }, beds: { main: null } };
    const sim = new Simulation({ ...cfg, shocks: [{ type: 'surge', startMinute: 1440, endMinute: 2880, multiplier: 2 }] }, 1);
    sim.run();
    const day = (d: number) => sim.allPatients().filter((p) => p.arrivalTime >= d * 1440 && p.arrivalTime < (d + 1) * 1440).length;
    const ratio = day(1) / ((day(0) + day(2) + day(3)) / 3);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
    const ignored = new Simulation({ ...cfg, modules: {}, shocks: [{ type: 'surge', startMinute: 1440, endMinute: 2880, multiplier: 2 }] }, 1);
    ignored.run();
    expect(ignored.allPatients().length).toBeLessThan(sim.allPatients().length * 0.85);
  });

  it('a mass casualty brings a burst of sicker patients', () => {
    const sim = new Simulation(
      { ...week, modules: { shocks: true }, shocks: [{ type: 'massCasualty', atMinute: 2000, patients: 25, overMinutes: 30, acuityMix: { '1': 0.5, '2': 0.5 } }] },
      1,
    );
    const { metrics } = sim.run();
    const mci = sim.allPatients().filter((p) => p.source === 'massCasualty');
    expect(mci).toHaveLength(25);
    for (const p of mci) {
      expect(p.arrivalTime).toBeGreaterThanOrEqual(2000);
      expect(p.arrivalTime).toBeLessThanOrEqual(2030);
      expect(p.initialAcuity).toBeLessThanOrEqual(2);
    }
    expect(metrics.arrivalsBySource.massCasualty).toBe(25);
  });
});

describe('burnout module', () => {
  it('off: no fatigue reported', () => {
    expect(new Simulation(week, 1).run().metrics.staffFatigue).toBeNull();
  });

  it('long shifts tire staff more, and tired staff are slower', () => {
    const cfg = (hours: number) => ({
      ...week,
      modules: { burnout: true, staffing: true },
      staffing: { schedule: { doctor: [{ startHour: 0, hours, count: 4 }, ...(hours === 12 ? [{ startHour: 12, hours: 12, count: 4 }] : [8, 16].map((h) => ({ startHour: h, hours: 8, count: 4 })))] } },
    });
    const long = new Simulation(cfg(12), 1).run().metrics;
    const short = new Simulation(cfg(8), 1).run().metrics;
    expect(long.staffFatigue!.byRole.doctor!).toBeGreaterThan(short.staffFatigue!.byRole.doctor! * 1.2);
    const rested = new Simulation({ ...cfg(12), modules: { staffing: true } }, 1).run().metrics;
    expect(long.utilizationByRole.doctor!).toBeGreaterThan(rested.utilizationByRole.doctor!);
  });

  it('fixed staff hand over, so fatigue does not grow forever', () => {
    const m = new Simulation({ ...week, modules: { burnout: true } }, 1).run().metrics;
    expect(m.staffFatigue!.max).toBeLessThan(0.6);
  });
});

describe('pipeline graph', () => {
  const base = () => resolveConfig({ id: 'x' }).pipeline;

  it('the default pipeline is valid', () => {
    expect(checkPipeline(base())).toEqual([]);
    expect(base().map((s) => s.kind)).toEqual(['triage', 'doctorEval', 'workup', 'disposition']);
  });

  it('rejects cycles, missing steps and impossible orders', () => {
    const steps = base();
    expect(checkPipeline(steps.filter((s) => s.kind !== 'disposition')).join()).toMatch(/exactly one disposition/);
    const cyc = steps.map((s) => (s.id === 'triage' ? { ...s, after: ['disposition'] } : s));
    expect(checkPipeline(cyc).join()).toMatch(/cycle/);
    const unknown = [...steps, makeStep({ id: 'x', kind: 'labs', after: ['nope'] })];
    expect(checkPipeline(unknown).join()).toMatch(/unknown step 'nope'/);
    const early = [...steps, makeStep({ id: 'reg', kind: 'registration', maxAcuity: 3 })];
    expect(checkPipeline(early).join()).toMatch(/before triage/);
    const back = [...steps, makeStep({ id: 'late', kind: 'vitals', after: ['doctorEval'], inBed: false })];
    expect(checkPipeline(back).join()).toMatch(/before the bed/);
  });
});

describe('everything on', () => {
  it('is deterministic and replays live commands exactly', () => {
    const cfg = {
      ...week,
      modules: { staffing: true, boarding: true, diagnosis: true, burnout: true, shocks: true },
      staffing: { schedule: { doctor: [{ startHour: 7, hours: 12, count: 4 }, { startHour: 19, hours: 12, count: 3 }] } },
      shocks: [{ type: 'massCasualty' as const, atMinute: 3000, patients: 12, overMinutes: 20 }],
      fastTrack: { enabled: true },
    };
    const live = new Simulation(cfg, 9);
    live.runUntil(1000);
    live.command({ type: 'setStaff', role: 'fastTrackClinician', count: 1 });
    live.command({ type: 'setBeds', lane: 'main', count: 12 });
    live.runUntil(4000.25);
    live.command({ type: 'setSchedule', role: 'doctor', shifts: [{ startHour: 0, hours: 24, count: 5 }] });
    const a = live.run();
    const b = new Simulation({ ...cfg, commands: a.commandLog }, 9).run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(new Simulation(cfg, 9).run())).toBe(JSON.stringify(new Simulation(cfg, 9).run()));
  });
});

describe('pre-emption (ESI 1)', () => {
  const oneDoctor = {
    id: 'pe',
    durationMinutes: 14 * 1440,
    staffing: { doctors: 1 },
    beds: { main: null },
    arrivals: { rateMultiplier: 0.3 },
    triage: { accuracy: 1 },
    lwbs: { enabled: false },
    deterioration: { enabled: false },
  };

  it('ESI 1 patients reach a doctor almost at once, even with one busy doctor', () => {
    const on = new Simulation(oneDoctor, 1).run().metrics;
    const off = new Simulation({ ...oneDoctor, queue: { preemptAcuity: 0 } }, 1).run().metrics;
    expect(on.preemptions).toBeGreaterThan(0);
    expect(off.preemptions).toBe(0);
    const wait = (m: typeof on) => m.doorToDoctorByAcuity['1'].mean! - m.doorToTriage.mean!;
    expect(wait(on)).toBeLessThan(wait(off) / 2);
  });

  it('interrupted work resumes where it stopped: nothing is lost or double-counted', () => {
    const sim = new Simulation(oneDoctor, 2);
    const { metrics } = sim.run();
    expect(metrics.preemptions).toBeGreaterThan(0);
    const s = sim.snapshot();
    expect(s.totals.arrived).toBe(s.totals.discharged + s.totals.admitted + s.totals.lwbs + s.patients.length);
    // Utilisation stays a fraction and matches a run without pre-emption closely (same work, reordered).
    const off = new Simulation({ ...oneDoctor, queue: { preemptAcuity: 0 } }, 2).run().metrics;
    expect(Math.abs(metrics.utilizationByRole.doctor! - off.utilizationByRole.doctor!)).toBeLessThan(0.03);
  });

  it('only under acuity ordering, and never interrupts another ESI 1', () => {
    expect(new Simulation({ ...oneDoctor, queue: { discipline: 'fifo' } }, 1).run().metrics.preemptions).toBe(0);
    const all1 = new Simulation({ ...oneDoctor, durationMinutes: 2 * 1440, arrivals: { acuityMix: { '1': 1 }, rateMultiplier: 0.5 } }, 1).run().metrics;
    expect(all1.preemptions).toBe(0);
  });
});
