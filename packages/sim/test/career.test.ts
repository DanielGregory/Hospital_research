import { describe, expect, it } from 'vitest';
import { career, PARAMS, resolveConfig, Simulation, type Metrics } from '../src/index';

const { newCareer, weekConfig, weekEvents, weekSeed, settleWeek, buyUpgrade, setBeds, setPolicy, forecast, UPGRADES } = career;

const playWeek = (s: ReturnType<typeof newCareer>) => settleWeek(s, new Simulation(weekConfig(s), weekSeed(s)).run().metrics);

describe('career weeks', () => {
  it('draw the same events and config every time a week is played, and different weeks differ', () => {
    const a = newCareer('A', 11);
    const b = newCareer('B', 11);
    for (let w = 1; w <= 30; w++) expect(weekEvents(a, w)).toEqual(weekEvents(b, w));
    expect(weekSeed(a, 3)).toBe(weekSeed(b, 3));
    expect(weekSeed(a, 3)).not.toBe(weekSeed(a, 4));
    const kinds = new Set(Array.from({ length: 60 }, (_, i) => weekEvents(a, i + 1).map((e) => e.kind)).flat());
    for (const k of ['flu', 'heatwave', 'wardsFull', 'incident']) expect(kinds.has(k as never)).toBe(true);
  });

  it('flu is much likelier in the flu season', () => {
    const s = newCareer('F', 5);
    let inSeason = 0;
    let outSeason = 0;
    for (let w = 1; w <= 26 * 20; w++) {
      const flu = weekEvents(s, w).some((e) => e.kind === 'flu');
      const season = (w - 1) % 26 >= 8 && (w - 1) % 26 <= 13;
      if (flu) season ? inSeason++ : outSeason++;
    }
    expect(inSeason / (6 * 20)).toBeGreaterThan(0.5);
    expect(outSeason / (20 * 20)).toBeLessThan(0.15);
  });

  it('builds a valid config for every week, and a week replays byte-identically', () => {
    const s = newCareer('V', 2);
    for (let w = 1; w <= 20; w++) expect(() => resolveConfig(weekConfig(s, w))).not.toThrow();
    const run = () => JSON.stringify(new Simulation(weekConfig(s), weekSeed(s)).run().metrics);
    expect(run()).toBe(run());
  });

  it('never announces incidents in the forecast', () => {
    const lines = forecast([{ kind: 'incident', atMinute: 3000, patients: 20, overMinutes: 40 }]);
    expect(lines.join(' ')).not.toMatch(/incident is/i);
    expect(lines).toContain('Major incidents come without warning.');
  });

  it('upgrades change the week: a fast-track area adds a lane, the ward expansion adds inpatient beds', () => {
    let s = newCareer('U', 1);
    expect(resolveConfig(weekConfig(s)).fastTrack.enabled).toBe(false);
    const r = buyUpgrade(s, 'fastTrackArea');
    expect(r.ok).toBe(true);
    s = (r as { state: typeof s }).state;
    const cfg = resolveConfig(weekConfig(s));
    expect(cfg.beds.fastTrack).toBe(4);
    expect(cfg.fastTrack.enabled).toBe(true);
    expect(s.money).toBe(PARAMS.career.startMoney - UPGRADES.find((u) => u.id === 'fastTrackArea')!.price);
    expect(buyUpgrade(s, 'fastTrackArea').ok).toBe(false);
    s = { ...s, money: 1e6 };
    s = (buyUpgrade(s, 'wardExpansion') as { state: typeof s }).state;
    expect(resolveConfig(weekConfig(s)).boarding.inpatientBeds).toBe(PARAMS.boarding.inpatientBeds + 10);
  });

  it('cannot buy what it cannot afford', () => {
    const s = { ...newCareer('P', 1), money: 1000 };
    const r = buyUpgrade(s, 'wardExpansion');
    expect(r.ok).toBe(false);
  });

  it('beds cost money to add and refund half to remove', () => {
    const s = newCareer('B', 1);
    const main = s.hospital.beds.main;
    const up = setBeds(s, 'main', main + 2);
    expect(up.ok && up.state.money).toBe(s.money - 2 * PARAMS.career.bedPrice.main);
    const down = setBeds(s, 'main', main - 2);
    expect(down.ok && down.state.money).toBe(s.money + 2 * PARAMS.career.bedPrice.main * PARAMS.career.bedRefundShare);
    expect(setBeds(s, 'fastTrack', 4).ok).toBe(false);
    expect(setBeds(s, 'main', 1).ok).toBe(false);
  });

  it('rejects a policy the simulation would reject', () => {
    const s = newCareer('X', 1);
    expect(setPolicy(s, { thoroughness: 0.8 }).ok).toBe(true);
    expect(setPolicy(s, { schedule: { ...s.hospital.schedule, doctor: [] } }).ok).toBe(false);
    const nightGap = setPolicy(s, { schedule: { ...s.hospital.schedule, doctor: [{ startHour: 8, hours: 12, count: 3 }] } });
    expect(nightGap.ok === false && nightGap.reason).toMatch(/No doctor on duty Monday at 00:00/);
  });
});

describe('settling a week', () => {
  const metrics = (over: Partial<Metrics> = {}): Metrics => {
    const m = new Simulation({ id: 'tiny', durationMinutes: 600 }, 1).run().metrics;
    return { ...m, ...over };
  };

  it('adds up income and costs into the balance', () => {
    const s = newCareer('S', 1);
    const m = metrics();
    const { state, record } = settleWeek(s, m);
    const total = (ls: { amount: number }[]) => ls.reduce((a, l) => a + l.amount, 0);
    expect(record.net).toBeCloseTo(total(record.income) - total(record.costs), 6);
    expect(state.money).toBeCloseTo(s.money + record.net, 6);
    expect(record.income[0]!.amount).toBe(m.treated * PARAMS.career.paymentPerPatient);
    expect(state.week).toBe(2);
    expect(state.history).toHaveLength(1);
  });

  it('moves reputation part of the way towards the score', () => {
    const s = newCareer('R', 1);
    const { state } = settleWeek(s, metrics({ compositeScore: 100 }));
    expect(state.reputation).toBeCloseTo(s.reputation + (100 - s.reputation) * PARAMS.career.reputationWeight, 6);
  });

  it('pays the quality bonus from a score threshold', () => {
    const s = newCareer('Q', 1);
    const hi = settleWeek(s, metrics({ compositeScore: 90 })).record;
    const lo = settleWeek(s, metrics({ compositeScore: 50 })).record;
    expect(hi.income.some((l) => l.label.startsWith('Quality bonus'))).toBe(true);
    expect(lo.income.some((l) => l.label.startsWith('Quality bonus'))).toBe(false);
  });

  it('ends the career below the bankruptcy line', () => {
    const s = { ...newCareer('Z', 1), money: PARAMS.career.bankruptAt };
    const m = metrics({ treated: 0, compositeScore: 0 });
    expect(settleWeek(s, m).state.over).toBe(true);
  });

  it('awards milestones once', () => {
    const s = newCareer('M', 1);
    const first = settleWeek(s, metrics());
    expect(first.newMilestones).toContain('firstWeek');
    const second = settleWeek(first.state, metrics());
    expect(second.newMilestones).not.toContain('firstWeek');
    expect(second.state.milestones.filter((m) => m === 'firstWeek')).toHaveLength(1);
  });

  it('the starting hospital survives a quarter left alone, but does not thrive', () => {
    let s = newCareer('Baseline', 1);
    for (let w = 0; w < 12 && !s.over; w++) s = playWeek(s).state;
    expect(s.over).toBe(false);
    expect(s.history).toHaveLength(12);
    // Room to improve: a hands-off hospital never reaches a score-85 week on every week.
    expect(s.history.every((r) => r.score >= 85)).toBe(false);
  }, 30_000);
});
