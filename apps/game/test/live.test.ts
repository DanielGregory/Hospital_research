import { applySettings, beatsBenchmark, PARAMS, patientStories, resolveLayout, Simulation } from '@er/sim';
import { describe, expect, it } from 'vitest';
import { buildConfig, initialValues } from '../src/controls';
import { LEVELS } from '../src/levels';
import { describeValue, differences } from '../src/play/benchmark';
import { AlertWatch } from '../src/play/alerts';
import { nextTip, triggered } from '../src/play/coach';
import { dailyChallenge, shareText } from '../src/play/daily';
import { commandLabel, explain } from '../src/play/explain';
import { personName } from '../src/play/names';
import { busiestRoutes, locationName } from '../src/play/WalkMap';
import { layoutHints } from '../src/screens/FloorDesigner';
import { COMPLAINTS, profileLine, storyText } from '../src/play/profiles';
import { recordBest, starsFor } from '../src/play/stars';

const level = (n: number) => LEVELS.find((l) => l.level.number === n)!;

describe('alerts', () => {
  it('warns about a mass casualty before it arrives, once, and pauses for it', () => {
    const cfg = level(6);
    const sim = new Simulation(cfg, cfg.level.seed ?? 1);
    const watch = new AlertWatch();
    const seen: string[] = [];
    for (let t = 0; t <= 200; t += 5) {
      sim.runUntil(t);
      for (const a of watch.check(sim.snapshot())) seen.push(`${a.kind}@${t}:${a.pause}`);
    }
    const incident = seen.filter((x) => x.startsWith('incident'));
    expect(incident).toHaveLength(1);
    expect(incident[0]).toMatch(/:true$/);
    const at = Number(incident[0]!.split('@')[1]!.split(':')[0]);
    const shock = cfg.shocks!.find((s) => s.type === 'massCasualty')!;
    expect(at).toBeLessThan(shock.atMinute);
  });

  it('flags a crowded department without repeating itself every tick', () => {
    const sim = new Simulation({ id: 'busy', durationMinutes: 1440, staffing: { doctors: 2 }, arrivals: { rateMultiplier: 1.6 } }, 2);
    const watch = new AlertWatch();
    const kinds: string[] = [];
    for (let t = 0; t <= 1440; t += 5) {
      sim.runUntil(t);
      kinds.push(...watch.check(sim.snapshot()).map((a) => a.kind));
    }
    const crowded = kinds.filter((k) => k === 'crowded').length;
    expect(crowded).toBeGreaterThan(0);
    expect(crowded).toBeLessThanOrEqual(1440 / 120 + 1);
  });
});

describe('level 1 coaching', () => {
  it('has tips that each come due during the level', () => {
    const cfg = level(1);
    const tips = cfg.level.coach!;
    expect(tips.length).toBeGreaterThan(2);
    const sim = new Simulation(applySettings(cfg, []), cfg.level.seed!);
    const shown = new Set<number>();
    for (let t = 0; t <= cfg.durationMinutes!; t += 5) {
      sim.runUntil(t);
      let i = nextTip(tips, shown, sim.snapshot());
      while (i !== null) {
        shown.add(i);
        i = nextTip(tips, shown, sim.snapshot());
      }
    }
    // Every tip except possibly 'firstLeft' fires on the level's night as shipped.
    const missing = tips.map((tip, i) => (shown.has(i) ? null : tip.when)).filter(Boolean);
    expect(missing.filter((w) => w !== 'firstLeft')).toEqual([]);
    expect(triggered('start', sim.snapshot())).toBe(true);
  });
});

describe('debrief explanations', () => {
  it('names the main bottleneck, the worst moment and the decisions taken', () => {
    const cfg = level(5);
    const sim = new Simulation(cfg, cfg.level.seed ?? 1);
    sim.runUntil(600);
    sim.command({ type: 'setHallwayBeds', count: 2 });
    const r = sim.run();
    const ex = explain(r.metrics, sim.timeline, r.commandLog, { startDayOfWeek: 0, startHour: 0 });
    expect(['boarding', 'bed']).toContain(ex.bottleneck!.cause);
    expect(ex.lines[0]).toMatch(/biggest share of waiting/);
    expect(ex.peak!.waiting).toBeGreaterThan(0);
    expect(ex.lines.some((l) => /hallway/.test(l))).toBe(r.metrics.live.hallwayPatients > 0);
    expect(commandLabel({ type: 'setHallwayBeds', count: 2 })).toBe('Hallway spaces: 2');
  });
});

describe('stars and the daily challenge', () => {
  it('gives no stars for missed goals and more for higher scores', () => {
    const cfg = level(1);
    const shipped = new Simulation(cfg, cfg.level.seed!).run().metrics;
    expect(starsFor(cfg.level, shipped)).toBe(0);
    const ref = new Simulation(applySettings(cfg, Object.entries(cfg.level.reference ?? {})), cfg.level.seed!).run().metrics;
    expect(starsFor(cfg.level, ref)).toBeGreaterThanOrEqual(1);
    const table = recordBest(recordBest({}, 'x', { stars: 1, score: 50 }), 'x', { stars: 3, score: 40 });
    expect(table.x).toEqual({ stars: 3, score: 50 });
  });

  it('picks the same level and seed for everyone on a date, and rotates through levels 2-7', () => {
    const a = dailyChallenge(LEVELS, '2026-09-23');
    const b = dailyChallenge(LEVELS, '2026-09-23');
    expect(a.level.id).toBe(b.level.id);
    expect(a.seed).toBe(b.seed);
    const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map((d) => dailyChallenge(LEVELS, d).level.level.number);
    expect(new Set(week).size).toBe(6);
    expect(week.every((n) => n >= 2)).toBe(true);
    expect(dailyChallenge(LEVELS, '2026-09-24').seed).not.toBe(a.seed);
    expect(shareText(a, 2, 71.6, 'https://example.org/')).toContain('★★☆ score 72/100');
  });

  it('gives each person a stable made-up name', () => {
    expect(personName('patient', 7, 3)).toEqual(personName('patient', 7, 3));
    const names = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(personName('patient', i, 3))));
    expect(names.size).toBeGreaterThan(40);
  });
});

describe('beat the best found', () => {
  it('loading the best found setup through the game reproduces its score on the level day', () => {
    for (const level of LEVELS) {
      const b = level.level.benchmark!;
      const values = { ...initialValues(level), ...b.settings };
      expect(differences(b, values)).toEqual([]);
      const m = new Simulation(buildConfig(level, values), level.level.seed!).run().metrics;
      expect(Math.round(m.compositeScore * 100) / 100).toBe(b.score);
      expect(beatsBenchmark(b, m.compositeScore, true)).toBe(false); // matching is not beating
    }
  });

  it('the shipped setup differs from the best found, and a beat is remembered', () => {
    const l2 = LEVELS[1]!;
    expect(differences(l2.level.benchmark!, initialValues(l2))).toEqual(['staffing.schedule.doctor']);
    const t = recordBest(recordBest({}, 'x', { stars: 3, score: 97, beat: true }), 'x', { stars: 1, score: 60 });
    expect(t.x!.beat).toBe(true);
  });

  it('describes settings in words', () => {
    expect(describeValue('staffing.schedule.doctor', [{ startHour: 22, hours: 12, count: 2 }])).toBe('2 from 22:00 for 12 h');
    expect(describeValue('queue.discipline', 'acuity')).toBe('Sickest first');
  });
});

describe('patient profiles and stories', () => {
  it('every complaint the sim can give has words', () => {
    for (const c of PARAMS.conditions) for (const k of c.complaints ?? []) expect(COMPLAINTS[k], k).toBeDefined();
  });

  it('tells stories without giving the diagnosis away before the run ends', () => {
    const cfg = level(5);
    const sim = new Simulation(cfg, cfg.level.seed!);
    sim.run();
    const stories = patientStories(sim.allPatients(), sim.now);
    expect(stories.length).toBeGreaterThan(0);
    for (const s of stories) expect(storyText(s, 3).body).toContain(s.condition.toLowerCase());
    const p = sim.allPatients()[0]!;
    const line = profileLine(p.id, p.profile, 3);
    expect(line).toContain(String(p.profile.age));
    expect(line).not.toContain(PARAMS.conditions.find((c) => c.id === p.conditionId)!.label);
  });
});

describe('floor design (level 8)', () => {
  const l8 = level(8);
  const plan = (rooms: unknown) => resolveLayout({ ...l8.layout!, rooms: rooms as never }).layout!;

  it('hints show the draft walks further than the reference plan', () => {
    const draft = layoutHints(plan(l8.layout!.rooms));
    const ref = layoutHints(plan(l8.level.reference!['layout.rooms']));
    const get = (h: typeof draft, k: string) => h.find((x) => x.label.startsWith(k))!.cells!;
    expect(get(ref, 'Staff station')).toBeLessThan(get(draft, 'Staff station'));
    expect(get(ref, 'Ambulance door')).toBeLessThan(get(draft, 'Ambulance door'));
  });

  it('the debrief map names the busiest routes from real walks', () => {
    const cfg = buildConfig(l8, initialValues(l8));
    const sim = new Simulation(cfg, l8.level.seed!);
    sim.run();
    const routes = busiestRoutes(sim.config.layout!, sim.walkTrips('staff'));
    expect(routes.length).toBeGreaterThan(0);
    expect(locationName(sim.config.layout!, routes[0]!.a)).toMatch(/\w/);
    expect(describeValue('layout.rooms', l8.layout!.rooms)).toContain('Staff station at');
  });
});
