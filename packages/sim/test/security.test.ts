import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/index';

const base = { id: 'sec', durationMinutes: 7 * 1440, warmupMinutes: 1440, modules: { security: true, boarding: true }, arrivals: { rateMultiplier: 1.15 } };
const run = (extra: object, seed: number) => new Simulation({ ...base, ...extra }, seed).run().metrics;
const seeds = [1, 2, 3, 4, 5, 6];
const total = (extra: object, f: (m: ReturnType<typeof run>) => number) => seeds.reduce((s, seed) => s + f(run(extra, seed)), 0);

describe('security module', () => {
  it('off: no incidents are reported and results are exactly as before', () => {
    const plain = { id: 'sec', durationMinutes: 3 * 1440, modules: { boarding: true } };
    const m = new Simulation(plain, 4).run().metrics;
    expect(m.security).toBeNull();
    expect(JSON.stringify(new Simulation({ ...plain, staffing: { securityOfficers: 0 } }, 4).run().metrics)).toBe(JSON.stringify(m));
  });

  it('is deterministic', () => {
    expect(JSON.stringify(run({ staffing: { securityOfficers: 1 } }, 9))).toBe(JSON.stringify(run({ staffing: { securityOfficers: 1 } }, 9)));
  });

  it('officers take incidents off clinicians and make violence rarer', () => {
    const none = { staffing: { securityOfficers: 0 } };
    const one = { staffing: { securityOfficers: 1 } };
    expect(total(one, (m) => m.security!.clinicianHours)).toBeLessThan(total(none, (m) => m.security!.clinicianHours) / 4);
    expect(total(one, (m) => m.security!.bySecurity)).toBeGreaterThan(0);
    expect(total(one, (m) => m.security!.violent) / total(one, (m) => m.security!.incidents)).toBeLessThan(
      total(none, (m) => m.security!.violent) / total(none, (m) => m.security!.incidents),
    );
  });

  it('crowding and more at-risk patients mean more incidents', () => {
    const calm = total({ arrivals: { rateMultiplier: 0.8 } }, (m) => m.security!.incidentsPer1000Visits);
    const busy = total({ arrivals: { rateMultiplier: 1.3 } }, (m) => m.security!.incidentsPer1000Visits);
    expect(busy).toBeGreaterThan(calm);
    expect(total({ security: { riskShare: 0.15 } }, (m) => m.security!.incidents)).toBeGreaterThan(total({}, (m) => m.security!.incidents));
  });

  it('rejects unknown settings', () => {
    expect(() => new Simulation({ ...base, security: { nope: 1 } }, 1)).toThrow(/security.nope/);
  });
});
