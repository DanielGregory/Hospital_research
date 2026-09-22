import { describe, expect, it } from 'vitest';
import { ConfigError, IMPLEMENTED_MODULES, MODULES, resolveConfig, validateConfig } from '../src/config.js';
import { PARAMS } from '../src/params.js';

describe('config', () => {
  it('fills defaults from PARAMS', () => {
    const c = resolveConfig({ id: 'x' });
    expect(c.staff.doctor).toBe(PARAMS.staffing.doctors);
    expect(c.hourlyRates).toEqual(PARAMS.arrivals.hourlyRates);
    expect(Object.values(c.modules).every((on) => on === false)).toBe(true);
  });

  it('meanMinutes overrides every acuity', () => {
    const c = resolveConfig({ id: 'x', service: { meanMinutes: 12 } });
    expect(Object.values(c.serviceMeanByAcuity)).toEqual([12, 12, 12, 12, 12]);
  });

  it('a partial acuity mix zeroes the unlisted levels', () => {
    const c = resolveConfig({ id: 'x', arrivals: { acuityMix: { '3': 1 } } });
    expect(c.acuityMix).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 });
  });

  it('reports every problem at once', () => {
    try {
      validateConfig({ durationMinutes: -1, arrivals: { hourlyRates: [1, 2] }, staffing: { doctors: 1.5 } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toHaveLength(4);
    }
  });

  it('rejects unknown modules; every spec module is built', () => {
    expect(() => validateConfig({ id: 'x', modules: { teleport: true } })).toThrow(/unknown module/);
    expect([...IMPLEMENTED_MODULES].sort()).toEqual([...MODULES].sort());
    expect(() => resolveConfig({ id: 'x', modules: { process: true } })).toThrow(/needs a process section/);
  });

  it('rejects bad commands', () => {
    expect(() => validateConfig({ id: 'x', commands: [{ atMinute: 5, command: { type: 'fireEveryone' } }] })).toThrow(/unknown command/);
  });
});
