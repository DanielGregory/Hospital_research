import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine.js';

const base = {
  id: 'ft',
  durationMinutes: 14 * 1440,
  warmupMinutes: 1440,
  staffing: { doctors: 2, fastTrackClinicians: 1 },
};

describe('fast track', () => {
  it('routes assigned 4–5 to the fast-track lane; fast-track clinicians see nobody else', () => {
    const sim = new Simulation({ ...base, fastTrack: { enabled: true, doctorsTakeOverflow: false } }, 1);
    const { metrics } = sim.run();
    const clinicians = new Set(sim.snapshot().staff.filter((s) => s.role === 'fastTrackClinician').map((s) => s.id));
    for (const p of sim.allPatients()) {
      if (p.doctorStartTime === undefined) continue;
      // Routing uses the acuity triage assigned (a later deterioration can raise priority in place).
      if (p.lane === 'fastTrack') expect(p.triageAssigned!).toBeGreaterThanOrEqual(4);
      else expect(p.triageAssigned!).toBeLessThanOrEqual(3);
      if (clinicians.has(p.providerId!)) expect(p.lane).toBe('fastTrack');
    }
    expect(metrics.fastTrack.shareOfTreated!).toBeGreaterThan(0.3);
  });

  it('free main doctors take fast-track overflow unless told not to', () => {
    const check = (overflow: boolean) => {
      const sim = new Simulation({ ...base, fastTrack: { enabled: true, doctorsTakeOverflow: overflow } }, 4);
      let idleDoctorWhileFtWaits = false;
      const doctorIds = new Set<number>();
      for (let t = 0; t < 5 * 1440; t += 5) {
        sim.runUntil(t);
        const s = sim.snapshot();
        for (const x of s.staff) if (x.role === 'doctor') doctorIds.add(x.id);
        const idleDoctor = s.staff.some((x) => x.role === 'doctor' && !x.busy && !x.retiring);
        if (idleDoctor && sim.queuedTasks('fastTrackClinician').length > 0) idleDoctorWhileFtWaits = true;
      }
      const overflowSeen = sim.allPatients().some((p) => p.lane === 'fastTrack' && p.providerId !== undefined && doctorIds.has(p.providerId));
      return { idleDoctorWhileFtWaits, overflowSeen };
    };
    expect(check(true)).toEqual({ idleDoctorWhileFtWaits: false, overflowSeen: true });
    expect(check(false)).toEqual({ idleDoctorWhileFtWaits: true, overflowSeen: false });
  });

  it('as added capacity, it frees main doctors: urgent patients seen sooner, fewer LWBS', () => {
    const ft = new Simulation({ ...base, staffing: { doctors: 3, fastTrackClinicians: 1 }, fastTrack: { enabled: true } }, 2).run().metrics;
    const none = new Simulation({ ...base, staffing: { doctors: 3, fastTrackClinicians: 1 } }, 2).run().metrics;
    expect(none.fastTrack.treated).toBe(0); // clinician on duty but lane closed: idle
    expect(ft.doorToDoctorByGroup.urgent.mean!).toBeLessThan(none.doorToDoctorByGroup.urgent.mean!);
    expect(ft.lwbsRate).toBeLessThan(none.lwbsRate * 0.8);
  });

  it('is closed when disabled or unstaffed, and waiting patients move back to main', () => {
    const sim = new Simulation({ ...base, fastTrack: { enabled: true } }, 3);
    sim.runUntil(3000);
    expect(sim.snapshot().settings.fastTrackOpen).toBe(true);
    sim.command({ type: 'setStaff', role: 'fastTrackClinician', count: 0 });
    const s = sim.snapshot();
    expect(s.settings.fastTrackOpen).toBe(false);
    expect(s.patients.filter((p) => p.waitingFor === 'bed' && p.lane === 'fastTrack')).toHaveLength(0);
    sim.runUntil(6000);
    const late = sim.allPatients().filter((p) => p.arrivalTime > 3000 && p.doctorQueueTime !== undefined);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((p) => p.lane === 'main')).toBe(true);
    sim.command({ type: 'setFastTrack', enabled: true, minAcuity: 5 });
    sim.command({ type: 'setStaff', role: 'fastTrackClinician', count: 1 });
    expect(sim.snapshot().patients.filter((p) => p.waitingFor === 'bed' && p.lane === 'fastTrack').every((p) => p.assignedAcuity === 5)).toBe(true);
  });

  it('needs triage', () => {
    expect(() => new Simulation({ id: 'x', triage: { enabled: false }, fastTrack: { enabled: true } }, 1)).toThrow(/needs triage/);
  });
});
