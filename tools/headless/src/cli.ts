#!/usr/bin/env -S npx tsx
/**
 * Headless runner: runs a config at full speed and writes metrics as JSON or CSV.
 *
 *   run --config <file.json> [--seed 42 | --seeds 1-10] [--out results.json] [--format json|csv]
 *
 * Output schema (JSON): { configPath, configId, runs: [{ seed, metrics, commandLog }] }
 * CSV: one row per seed, metric keys flattened with dots.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, Simulation, type Metrics, type TimedCommand } from '@er/sim';

export const USAGE = `Usage:
  run --config <file.json> [--seed <n> | --seeds <a-b>] [--out <file>] [--format json|csv]

Options:
  --config   Level or sandbox config (JSON). Required.
  --seed     Single seed (default 1).
  --seeds    Inclusive seed range for replications, e.g. 1-20.
  --out      Output file. Defaults to stdout.
  --format   json or csv. Defaults to csv if --out ends in .csv, else json.`;

export interface RunArgs {
  config: string;
  seeds: number[];
  out?: string;
  format: 'json' | 'csv';
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): RunArgs {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') throw new UsageError(cmd ? `Unknown command '${cmd}'` : 'Missing command');
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (!key.startsWith('--')) throw new UsageError(`Unexpected argument '${key}'`);
    const val = rest[i + 1];
    if (val === undefined || val.startsWith('--')) throw new UsageError(`Missing value for ${key}`);
    opts[key.slice(2)] = val;
    i++;
  }
  const known = new Set(['config', 'seed', 'seeds', 'out', 'format']);
  for (const k of Object.keys(opts)) if (!known.has(k)) throw new UsageError(`Unknown option --${k}`);
  if (!opts.config) throw new UsageError('--config is required');
  if (opts.seed && opts.seeds) throw new UsageError('Use --seed or --seeds, not both');

  let seeds: number[];
  if (opts.seeds) {
    const m = /^(\d+)-(\d+)$/.exec(opts.seeds);
    if (!m || Number(m[1]) > Number(m[2])) throw new UsageError('--seeds must look like 1-10');
    seeds = [];
    for (let s = Number(m[1]); s <= Number(m[2]); s++) seeds.push(s);
  } else {
    const s = opts.seed ?? '1';
    if (!/^\d+$/.test(s)) throw new UsageError('--seed must be a non-negative integer');
    seeds = [Number(s)];
  }

  const format = opts.format ?? (opts.out?.endsWith('.csv') ? 'csv' : 'json');
  if (format !== 'json' && format !== 'csv') throw new UsageError('--format must be json or csv');
  return { config: opts.config, seeds, out: opts.out, format };
}

export interface RunOutput {
  configPath: string;
  configId: string;
  runs: { seed: number; metrics: Metrics; commandLog: TimedCommand[] }[];
}

export function runConfig(config: unknown, configPath: string, seeds: readonly number[]): RunOutput {
  const runs = seeds.map((seed) => {
    const { metrics, commandLog } = new Simulation(config, seed).run();
    return { seed, metrics, commandLog };
  });
  return { configPath, configId: runs[0]?.metrics.configId ?? '', runs };
}

/** Flatten nested objects to dot keys; arrays are skipped (they don't fit a CSV cell). */
export function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, number | string | null> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) continue;
    if (v !== null && typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
    else out[key] = v as number | string | null;
  }
  return out;
}

export function toCsv(output: RunOutput): string {
  const rows = output.runs.map((r) => flatten(r.metrics as unknown as Record<string, unknown>));
  const header = Object.keys(rows[0] ?? {});
  const cell = (v: number | string | null | undefined) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
}

export function main(argv: readonly string[], cwd = process.cwd()): number {
  try {
    const args = parseArgs(argv);
    const configPath = resolve(cwd, args.config);
    const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const output = runConfig(config, args.config, args.seeds);
    const text = args.format === 'csv' ? toCsv(output) : JSON.stringify(output, null, 2) + '\n';
    if (args.out) {
      writeFileSync(resolve(cwd, args.out), text);
      process.stderr.write(`Wrote ${args.seeds.length} run(s) to ${args.out}\n`);
    } else process.stdout.write(text);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // pnpm runs scripts from the workspace root; INIT_CWD is where the user actually ran the command.
  process.exitCode = main(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd());
}
