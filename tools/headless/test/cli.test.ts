import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flatten, main, parseArgs, UsageError } from '../src/cli.js';

const root = resolve(import.meta.dirname, '../../..');

describe('parseArgs', () => {
  it('parses a single seed and infers format from --out', () => {
    expect(parseArgs(['run', '--config', 'c.json', '--seed', '42', '--out', 'r.csv'])).toEqual({
      config: 'c.json',
      seeds: [42],
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
    expect(out.runs[0].commandLog).toEqual([{ atMinute: 4320, command: { type: 'setDoctors', count: 3 } }]);
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
