import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOverrides, flatten, main, parseArgs, UsageError } from '../src/cli.js';

const root = resolve(import.meta.dirname, '../../..');

describe('parseArgs', () => {
  it('parses a single seed and infers format from --out', () => {
    expect(parseArgs(['run', '--config', 'c.json', '--seed', '42', '--out', 'r.csv'])).toEqual({
      config: 'c.json',
      seeds: [42],
      overrides: [],
      out: 'r.csv',
      format: 'csv',
    });
  });

  it('expands seed ranges', () => {
    expect(parseArgs(['run', '--config', 'c.json', '--seeds', '3-5']).seeds).toEqual([3, 4, 5]);
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['go'])).toThrow(UsageError);
    expect(() => parseArgs(['run'])).toThrow(/--config/);
    expect(() => parseArgs(['run', '--config', 'c', '--seed', '1', '--seeds', '1-2'])).toThrow(UsageError);
    expect(() => parseArgs(['run', '--config', 'c', '--speed', '8'])).toThrow(/Unknown option/);
  });
});

describe('main', () => {
  it('writes deterministic JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-headless-'));
    const args = ['run', '--config', 'configs/examples/basic.json', '--seed', '42'];
    expect(main([...args, '--out', join(dir, 'a.json')], root)).toBe(0);
    expect(main([...args, '--out', join(dir, 'b.json')], root)).toBe(0);
    const a = readFileSync(join(dir, 'a.json'), 'utf8');
    expect(a).toBe(readFileSync(join(dir, 'b.json'), 'utf8'));
    const out = JSON.parse(a);
    expect(out.configId).toBe('basic');
    expect(out.runs[0].seed).toBe(42);
    expect(out.runs[0].metrics.arrivals).toBeGreaterThan(0);
    expect(out.runs[0].commandLog).toEqual([{ atMinute: 4320, command: { type: 'setStaff', role: 'doctor', count: 3 } }]);
  });

  it('writes one CSV row per seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-headless-'));
    const out = join(dir, 'r.csv');
    expect(main(['run', '--config', 'configs/examples/basic.json', '--seeds', '1-3', '--out', out], root)).toBe(0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('doorToDoctor.median');
    expect(lines[0]).not.toContain('optimal');
  });

  it('returns non-zero on a bad config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-headless-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ id: 'x', modules: { boarding: true } }));
    expect(main(['run', '--config', bad], root)).toBe(1);
  });
});

describe('flatten', () => {
  it('uses dot keys and skips arrays', () => {
    expect(flatten({ a: 1, b: { c: null, d: [1] } })).toEqual({ a: 1, 'b.c': null });
  });
});

describe('overrides and levels', () => {
  it('--set applies JSON or bare-string values at a dot path', () => {
    const args = parseArgs(['run', '--config', 'c.json', '--set', 'staffing.doctors=4', '--set', 'queue.discipline=fifo']);
    expect(args.overrides).toEqual([
      ['staffing.doctors', 4],
      ['queue.discipline', 'fifo'],
    ]);
    expect(applyOverrides({ id: 'x', staffing: { triageNurses: 2 } }, args.overrides)).toEqual({
      id: 'x',
      staffing: { triageNurses: 2, doctors: 4 },
      queue: { discipline: 'fifo' },
    });
    expect(() => parseArgs(['run', '--config', 'c', '--set', 'novalue'])).toThrow(/path=value/);
  });

  it('reports goals and uses the level seed by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-headless-'));
    const out = join(dir, 'l.json');
    expect(main(['run', '--config', 'configs/levels/level-03-fast-track.json', '--out', out], root)).toBe(0);
    const r = JSON.parse(readFileSync(out, 'utf8'));
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0].seed).toBe(1);
    expect(r.level).toMatchObject({ number: 3, passRate: 0 });
    expect(r.runs[0].goals.results).toHaveLength(3);

    const fixed = join(dir, 'f.json');
    const set = ['--set', 'fastTrack.enabled=true', '--set', 'staffing.schedule.fastTrackClinician=[{"startHour":10,"hours":12,"count":1}]'];
    expect(main(['run', '--config', 'configs/levels/level-03-fast-track.json', ...set, '--out', fixed], root)).toBe(0);
    expect(JSON.parse(readFileSync(fixed, 'utf8')).level.passRate).toBe(1);
  });

  it('flags a setup over the level limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-headless-'));
    const out = join(dir, 'x.json');
    main(['run', '--config', 'configs/levels/level-02-monday-morning.json', '--set', 'staffing.schedule.doctor=[{"startHour":0,"hours":24,"count":5}]', '--out', out], root);
    expect(JSON.parse(readFileSync(out, 'utf8')).limitProblems[0]).toMatch(/exceeds the limit of 84/);
  });
});
