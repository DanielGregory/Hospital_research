import { describe, expect, it } from 'vitest';
import { findBottlenecks, Simulation } from '../src/index';

const run = (extra: object, seed = 3) => new Simulation({ id: 'b', durationMinutes: 10 * 1440, warmupMinutes: 2 * 1440, ...extra }, seed).run().metrics;

describe('bottleneck finder', () => {
  it('short of nurses: the top cause is free beds with no nurse, not beds', () => {
    const top = findBottlenecks(run({ modules: { nursing: true }, staffing: { nurses: 3 } }))[0]!;
    expect(top.key).toBe('noNurse');
    expect(top.lever).toMatch(/more beds would not help/);
  });

  it('short of ICU beds: ICU boarding shows up, named by unit', () => {
    const b = findBottlenecks(run({ modules: { boarding: true }, beds: { main: 14 }, boarding: { units: { icu: { beds: 4 }, stepdown: { beds: 30 }, ward: { beds: 200 } } } }));
    const keys = b.map((x) => x.key);
    expect(keys).toContain('admitted:icu');
    expect(keys.indexOf('admitted:icu')).toBeLessThan(keys.indexOf('provider') < 0 ? 99 : keys.indexOf('provider') + 1);
    expect(b.find((x) => x.key === 'admitted:icu')!.what).toMatch(/an ICU bed/);
  });

  it('a slow CT scanner is named as a CT backlog', () => {
    const b = findBottlenecks(run({ modules: { diagnostics: true }, diagnostics: { services: { ct: { servers: 1, processMinutes: 80 }, ultrasound: { openHours: null } } } }));
    expect(b[0]!.key).toBe('backlog:ct');
  });

  it('too few doctors: providers come first', () => {
    const b = findBottlenecks(run({ staffing: { doctors: 2 } }));
    expect(b[0]!.key).toBe('provider');
    expect(b.reduce((s, x) => s + x.share, 0)).toBeLessThanOrEqual(1 + 1e-9);
  });
});
