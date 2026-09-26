import { describe, expect, it } from 'vitest';
import { ConfigError, PARAMS, pipelineAsSteps, resolveConfig, Simulation, TIMELINE_STEP } from '../src/index';

const day = { id: 'live', durationMinutes: 24 * 60 };
const defaultProcessSteps = () => pipelineAsSteps(resolveConfig(day).pipeline);

describe('live process changes', () => {
  it('apply to patients arriving after the change; earlier patients keep their plan', () => {
    const steps = defaultProcessSteps();
    const cfg = { ...day, modules: { process: true }, process: { steps } };
    const sim = new Simulation(cfg, 3);
    sim.runUntil(600);
    const before = sim.allPatients().length;
    // A surge protocol: an extra quick nurse check, renamed so we can tell who got which plan.
    const surge = steps.map((s) => (s.kind === 'doctorEval' ? { ...s, id: 'rapidEval', meanMinutes: 15, meanMinutesByAcuity: undefined } : s)).map((s) => ({
      ...s,
      after: (s.after ?? []).map((a) => (a === 'doctorEval' ? 'rapidEval' : a)),
    }));
    sim.command({ type: 'setProcess', steps: surge });
    const log = sim.run().commandLog;
    const all = sim.allPatients();
    expect(all.slice(0, before).every((p) => !('rapidEval' in p.steps))).toBe(true);
    const later = all.slice(before).filter((p) => p.doctorStartTime !== undefined && p.source === 'walkIn');
    expect(later.length).toBeGreaterThan(10);
    expect(later.every((p) => 'rapidEval' in p.steps && !('doctorEval' in p.steps))).toBe(true);
    // The command log replays exactly.
    const replay = new Simulation({ ...cfg, commands: log }, 3).run();
    expect(JSON.stringify(replay.metrics)).toBe(JSON.stringify(sim.metrics()));
  });

  it('needs the process module, and staff for every role the new process uses', () => {
    const sim = new Simulation(day, 1);
    expect(() => sim.command({ type: 'setProcess', steps: defaultProcessSteps() })).toThrow(ConfigError);
    const on = new Simulation({ ...day, modules: { process: true }, process: { steps: defaultProcessSteps() } }, 1);
    const withTech = [...defaultProcessSteps(), { id: 'xray', kind: 'imaging' as const, role: 'tech' as const, meanMinutes: 10, after: ['triage'], inBed: true }];
    expect(() => on.command({ type: 'setProcess', steps: withTech })).toThrow(/tech/);
  });

  it('thoroughness changes lengthen diagnostic work for later arrivals only', () => {
    const cfg = { ...day, modules: { diagnosis: true }, staffing: { doctors: 12 }, queue: { preemptAcuity: 0 } };
    const base = new Simulation(cfg, 5);
    const changed = new Simulation(cfg, 5);
    base.runUntil(720);
    changed.runUntil(720);
    changed.command({ type: 'setThoroughness', value: 0.9 });
    base.run();
    changed.run();
    const evalTime = (sim: Simulation) =>
      new Map(sim.allPatients().filter((p) => p.source === 'walkIn' && p.steps.doctorEval?.end !== undefined).map((p) => [p.arrivalTime, p.steps.doctorEval!.end! - p.steps.doctorEval!.start]));
    const a = evalTime(base);
    const b = evalTime(changed);
    const [f0, f1] = PARAMS.diagnosis.timeFactorRange;
    const ratio = (f0 + (f1 - f0) * 0.9) / (f0 + (f1 - f0) * PARAMS.diagnosis.thoroughness);
    let checked = 0;
    for (const [t, d] of b) {
      if (!a.has(t)) continue;
      if (t < 720) expect(d).toBeCloseTo(a.get(t)!, 6);
      else {
        expect(d / a.get(t)!).toBeCloseTo(ratio, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(changed.snapshot().live.thoroughness).toBe(0.9);
  });
});

describe('live calls', () => {
  it('call in: arrives after the delay, stays for the call-in hours, costs a premium, and is limited', () => {
    const cfg = { ...day, liveCalls: { maxCallIns: 1 } };
    const sim = new Simulation(cfg, 2);
    sim.runUntil(300);
    const doctors = () => sim.snapshot().staff.filter((s) => s.role === 'doctor' && !s.retiring).length;
    const n = doctors();
    sim.command({ type: 'callIn', role: 'doctor' });
    expect(sim.snapshot().live.callInsLeft).toBe(0);
    expect(sim.snapshot().live.callInsPending).toEqual([{ role: 'doctor', etaMinutes: PARAMS.liveCalls.callInDelayMinutes }]);
    expect(() => sim.command({ type: 'callIn', role: 'doctor' })).toThrow(/no on-call/);
    sim.runUntil(300 + PARAMS.liveCalls.callInDelayMinutes - 1);
    expect(doctors()).toBe(n);
    sim.runUntil(300 + PARAMS.liveCalls.callInDelayMinutes + 1);
    expect(doctors()).toBe(n + 1);
    expect(sim.snapshot().live.callInsPending).toEqual([]);
    sim.runUntil(300 + PARAMS.liveCalls.callInDelayMinutes + PARAMS.liveCalls.callInHours * 60 + 120);
    expect(doctors()).toBe(n);
    const m = sim.run().metrics;
    expect(m.live.callIns).toBe(1);
    expect(m.live.callInHours).toBeCloseTo(PARAMS.liveCalls.callInHours, 0);
    expect(m.cost.calls).toBeCloseTo(PARAMS.liveCalls.callInHours * PARAMS.budget.hourlyWage.doctor * (PARAMS.liveCalls.callInWageMultiplier - 1), -1);
  });

  it('diversion turns ambulances away (but not the most critical) and leaves everyone else untouched', () => {
    const cfg = { ...day, arrivals: { rateMultiplier: 1.2 } };
    const open = new Simulation(cfg, 4);
    const div = new Simulation(cfg, 4);
    div.command({ type: 'setDiversion', enabled: true });
    const a = open.run();
    const b = div.run();
    expect(b.metrics.live.diverted).toBeGreaterThan(5);
    expect(b.metrics.live.diversionHours).toBeCloseTo(24, 6);
    expect(b.metrics.cost.calls).toBeCloseTo(b.metrics.live.diverted * PARAMS.liveCalls.diversionCostPerPatient, 6);
    const amb = b.metrics.arrivals - open.allPatients().filter((p) => !p.byAmbulance || p.initialAcuity <= PARAMS.liveCalls.diversionSparesAcuity).length;
    expect(amb).toBeLessThanOrEqual(0);
    // Walk-ins arrive exactly as before: the arrival process and their draws don't depend on diversion.
    const walk = (s: Simulation) => s.allPatients().filter((p) => !p.byAmbulance).map((p) => `${p.arrivalTime}:${p.initialAcuity}`);
    expect(walk(div)).toEqual(walk(open));
    expect(a.metrics.live.diverted).toBe(0);
  });

  it('hallway spaces are used only when the beds are full, and care there is slower', () => {
    const cfg = { ...day, beds: { main: 5 }, staffing: { doctors: 6 }, arrivals: { rateMultiplier: 1.3 } };
    const sim = new Simulation(cfg, 6);
    sim.command({ type: 'setHallwayBeds', count: 3 });
    for (let t = 10; t <= 1440; t += 10) {
      sim.runUntil(t);
      const s = sim.snapshot();
      const inHall = s.patients.filter((p) => p.hallway).length;
      expect(s.beds.main.occupied).toBeLessThanOrEqual(8);
      if (inHall > 0) expect(s.beds.main.occupied - s.live.hallwayInUse).toBe(5);
    }
    const m = sim.run().metrics;
    expect(m.live.hallwayPatients).toBeGreaterThan(0);
    expect(m.live.hallwayHours).toBeGreaterThan(0);
    const without = new Simulation(cfg, 6).run().metrics;
    expect(m.doorToBed.median!).toBeLessThan(without.doorToBed.median!);
    expect(() => new Simulation({ ...day, beds: { main: null } }, 1).command({ type: 'setHallwayBeds', count: 2 })).toThrow(ConfigError);
  });

  it('moves a fast-track clinician into the main ED straight away', () => {
    const sim = new Simulation({ ...day, staffing: { doctors: 3, fastTrackClinicians: 2 }, fastTrack: { enabled: true } }, 1);
    sim.runUntil(200);
    const count = (role: string) => sim.snapshot().staff.filter((s) => s.role === role && !s.retiring).length;
    sim.command({ type: 'moveStaff', from: 'fastTrackClinician', to: 'doctor' });
    expect([count('doctor'), count('fastTrackClinician')]).toEqual([4, 1]);
    sim.runUntil(900);
    expect([count('doctor'), count('fastTrackClinician')]).toEqual([4, 1]);
  });

  it('announces a mass-casualty incident before it arrives', () => {
    const cfg = { ...day, modules: { shocks: true }, shocks: [{ type: 'massCasualty', atMinute: 300, patients: 12, overMinutes: 40 }] };
    const sim = new Simulation(cfg, 1);
    sim.runUntil(300 - PARAMS.liveCalls.incidentWarningMinutes - 1);
    expect(sim.snapshot().incidents).toEqual([]);
    sim.runUntil(300 - 10);
    expect(sim.snapshot().incidents).toEqual([{ startsInMinutes: 10, patients: 12, overMinutes: 40 }]);
    sim.runUntil(345);
    expect(sim.snapshot().incidents).toEqual([]);
    // Casualties come by ambulance and are never diverted.
    expect(sim.allPatients().filter((p) => p.source === 'massCasualty').every((p) => p.byAmbulance)).toBe(true);
  });

  it('every live call replays exactly from the command log', () => {
    const cfg = { ...day, modules: { diagnosis: true }, beds: { main: 8 }, staffing: { fastTrackClinicians: 1 }, fastTrack: { enabled: true } };
    const sim = new Simulation(cfg, 8);
    sim.runUntil(240);
    sim.command({ type: 'setDiversion', enabled: true });
    sim.command({ type: 'callIn', role: 'doctor' });
    sim.runUntil(400);
    sim.command({ type: 'setHallwayBeds', count: 2 });
    sim.command({ type: 'moveStaff', from: 'fastTrackClinician', to: 'doctor' });
    sim.command({ type: 'setThoroughness', value: 0.3 });
    sim.runUntil(700);
    sim.command({ type: 'setDiversion', enabled: false });
    const r = sim.run();
    const replay = new Simulation({ ...cfg, commands: r.commandLog }, 8).run();
    expect(JSON.stringify(replay.metrics)).toBe(JSON.stringify(r.metrics));
  });
});

describe('debrief analysis', () => {
  it('samples the timeline every half hour without changing the run', () => {
    const sim = new Simulation(day, 3);
    const r = sim.run();
    expect(sim.timeline).toHaveLength(day.durationMinutes / TIMELINE_STEP + 1);
    expect(sim.timeline.map((s) => s.minute)).toEqual(sim.timeline.map((_, i) => i * TIMELINE_STEP));
    // Sampling mid-run (as the game does) gives the same samples and results.
    const stepped = new Simulation(day, 3);
    for (let t = 7; t < day.durationMinutes; t += 13) stepped.runUntil(t);
    const r2 = stepped.run();
    expect(stepped.timeline).toEqual(sim.timeline);
    expect(JSON.stringify(r2.metrics)).toBe(JSON.stringify(r.metrics));
  });

  it('attributes waiting to its cause: boarding dominates when the wards are full', () => {
    const m = new Simulation({ id: 'b', durationMinutes: 2 * 1440, warmupMinutes: 360, modules: { boarding: true }, boarding: { inpatientBeds: 30, initialOccupied: 30, dischargesPerDay: 8 } }, 2).run().metrics;
    const top = Object.entries(m.waits).sort((a, b) => b[1] - a[1])[0]![0];
    expect(['boarding', 'bed']).toContain(top);
    expect(m.waits.boarding).toBeCloseTo(m.boarding.hours, 0);
    const calm = new Simulation({ ...day, staffing: { doctors: 8 } }, 2).run().metrics;
    expect(calm.waits.boarding).toBe(0);
    expect(calm.waits.bed + calm.waits.doctor).toBeLessThan(m.waits.bed + m.waits.boarding);
  });

  it('counts patients who became critical while waiting, and bounce-backs still to come', () => {
    const m = new Simulation({ id: 'c', durationMinutes: 1440, staffing: { doctors: 2 }, lwbs: { enabled: false } }, 3).run().metrics;
    expect(m.deterioration.critical).toBeGreaterThan(0);
    expect(m.deterioration.critical).toBeLessThanOrEqual(m.deterioration.patients);
    const d = new Simulation({ id: 'd', durationMinutes: 1440, modules: { diagnosis: true }, diagnosis: { thoroughness: 0.1 } }, 3).run().metrics;
    expect(d.diagnosis.bounceBacksAfterRun).toBeGreaterThan(0);
    expect(d.diagnosis.bounceBacksAfterRun).toBeLessThanOrEqual(d.diagnosis.bounceBacks72h);
  });

  it('rejects bad live commands', () => {
    expect(() => new Simulation(day, 1).command({ type: 'setHallwayBeds', count: 99 })).toThrow(ConfigError);
    expect(() => new Simulation(day, 1).command({ type: 'setThoroughness', value: 2 })).toThrow(ConfigError);
    expect(() => new Simulation(day, 1).command({ type: 'moveStaff', from: 'doctor', to: 'doctor' })).toThrow(ConfigError);
    expect(() => resolveConfig({ ...day, liveCalls: { maxCallIns: -1 } })).toThrow(ConfigError);
  });
});
