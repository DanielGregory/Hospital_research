#!/usr/bin/env -S npx tsx
/**
 * Headless runner: runs a config at full speed and writes metrics as JSON or CSV.
 *
 *   run --config <file.json> [--seed 42 | --seeds 1-10] [--set path=value ...] [--out results.json] [--format json|csv]
 *
 * Output schema (JSON): { configPath, configId, overrides, limitProblems, level?, runs: [{ seed, metrics, commandLog, goals? }] }
 * CSV: one row per seed, metric keys flattened with dots, plus goal results for levels.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { BASELINES, fitToTargets, optimize, runWithPolicy, Session, type AggregateTargets, type SearchSpace } from '@er/research';
import { applySettings, balanceReport, checkSetup, ConfigError, evaluateGoals, resolveConfig, Simulation, type GoalResult, type Metrics, type TimedCommand } from '@er/sim';

export const USAGE = `Usage:
  run --config <file.json> [--seed <n> | --seeds <a-b>] [--set <path=value> ...] [--out <file>] [--format json|csv]
  balance --config <level.json> [--seeds <a-b>] [--set <path=value> ...]
      Goal pass rates for the shipped setup and the level's reference solution.
  policy --config <file.json> --policy <name> [--seeds <a-b>] [--out <file>]
      Run with a baseline policy in the loop: static, surge-staffing, fast-track-when-busy,
      escalate-when-boarding, all-heuristics.
  optimize --config <file.json> --space <space.json> [--iterations 200] [--seeds 1-5]
           [--objective compositeScore | --objective doorToDoctor.mean:min] [--out best.json]
      Simulated annealing over the settings in the space file. Reports the best setup found.
  calibrate --config <base.json> --targets <targets.json> [--seeds 1-3] [--out fitted.json]
      Fit admission, patience and workup scales so the sim matches published aggregates.
  serve
      JSON-lines protocol on stdin/stdout for other languages (see packages/research/src/serve.ts).

Options:
  --config   Level or sandbox config (JSON). Required.
  --seed     Single seed (default: the level's seed, else 1).
  --seeds    Inclusive seed range for replications, e.g. 1-20.
  --set      Override a config value (repeatable). Value is JSON, or a bare string:
             --set staffing.doctors=4  --set queue.discipline=fifo
             --set 'staffing.schedule.doctor=[{"startHour":8,"hours":12,"count":3}]'
  --out      Output file. Defaults to stdout.
  --format   json or csv. Defaults to csv if --out ends in .csv, else json.`;

export interface RunArgs {
  command: 'run' | 'balance' | 'policy' | 'optimize' | 'serve' | 'calibrate';
  targets?: string;
  policy?: string;
  space?: string;
  iterations?: number;
  objective?: string;
  config: string;
  /** Empty = use the level's seed, else 1. */
  seeds: number[];
  overrides: [string, unknown][];
  out?: string;
  format: 'json' | 'csv';
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): RunArgs {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run' && cmd !== 'balance' && cmd !== 'policy' && cmd !== 'optimize' && cmd !== 'serve' && cmd !== 'calibrate')
    throw new UsageError(cmd ? `Unknown command '${cmd}'` : 'Missing command');
  if (cmd === 'serve') return { command: 'serve', config: '', seeds: [], overrides: [], format: 'json' };
  const opts: Record<string, string> = {};
  const overrides: [string, unknown][] = [];
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (!key.startsWith('--')) throw new UsageError(`Unexpected argument '${key}'`);
    const val = rest[i + 1];
    if (val === undefined || val.startsWith('--')) throw new UsageError(`Missing value for ${key}`);
    if (key === '--set') overrides.push(parseOverride(val));
    else opts[key.slice(2)] = val;
    i++;
  }
  const known = new Set(['config', 'seed', 'seeds', 'out', 'format', 'policy', 'space', 'iterations', 'objective', 'targets']);
  for (const k of Object.keys(opts)) if (!known.has(k)) throw new UsageError(`Unknown option --${k}`);
  if (!opts.config) throw new UsageError('--config is required');
  if (opts.seed && opts.seeds) throw new UsageError('Use --seed or --seeds, not both');

  let seeds: number[];
  if (opts.seeds) {
    const m = /^(\d+)-(\d+)$/.exec(opts.seeds);
    if (!m || Number(m[1]) > Number(m[2])) throw new UsageError('--seeds must look like 1-10');
    seeds = [];
    for (let s = Number(m[1]); s <= Number(m[2]); s++) seeds.push(s);
  } else if (opts.seed !== undefined) {
    if (!/^\d+$/.test(opts.seed)) throw new UsageError('--seed must be a non-negative integer');
    seeds = [Number(opts.seed)];
  } else seeds = [];

  const format = opts.format ?? (opts.out?.endsWith('.csv') ? 'csv' : 'json');
  if (format !== 'json' && format !== 'csv') throw new UsageError('--format must be json or csv');
  if (cmd === 'policy' && !opts.policy) throw new UsageError('--policy is required');
  if (cmd === 'optimize' && !opts.space) throw new UsageError('--space is required');
  if (cmd === 'calibrate' && !opts.targets) throw new UsageError('--targets is required');
  if (opts.iterations !== undefined && !/^\d+$/.test(opts.iterations)) throw new UsageError('--iterations must be a positive integer');
  return {
    command: cmd,
    config: opts.config,
    seeds,
    overrides,
    out: opts.out,
    format,
    policy: opts.policy,
    space: opts.space,
    iterations: opts.iterations ? Number(opts.iterations) : undefined,
    objective: opts.objective,
    targets: opts.targets,
  };
}

function parseOverride(arg: string): [string, unknown] {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new UsageError(`--set expects path=value, got '${arg}'`);
  const path = arg.slice(0, eq);
  const raw = arg.slice(eq + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw; // bare string, e.g. queue.discipline=fifo
  }
  return [path, value];
}

/** Return a copy of `config` with each dot-path override applied (creating objects as needed). */
export function applyOverrides(config: unknown, overrides: readonly [string, unknown][]): unknown {
  return applySettings(config, overrides);
}

export interface RunOutput {
  configPath: string;
  configId: string;
  overrides: Record<string, unknown>;
  /** Starting config versus the level's staffing limits; empty when within limits or not a level. */
  limitProblems: string[];
  level?: { number: number; title: string; passRate: number };
  runs: { seed: number; metrics: Metrics; commandLog: TimedCommand[]; goals?: { passed: boolean; results: GoalResult[] } }[];
}

export function runConfig(config: unknown, configPath: string, seeds: readonly number[], overrides: readonly [string, unknown][] = []): RunOutput {
  const resolved = resolveConfig(config);
  const goals = resolved.level?.goals;
  if (seeds.length === 0) seeds = [resolved.level?.seed ?? 1];
  const runs = seeds.map((seed) => {
    const { metrics, commandLog } = new Simulation(config, seed).run();
    return { seed, metrics, commandLog, ...(goals ? { goals: evaluateGoals(metrics, goals) } : {}) };
  });
  const out: RunOutput = {
    configPath,
    configId: resolved.id,
    overrides: Object.fromEntries(overrides),
    limitProblems: checkSetup(resolved),
    runs,
  };
  if (resolved.level)
    out.level = {
      number: resolved.level.number,
      title: resolved.level.title,
      passRate: runs.filter((r) => r.goals!.passed).length / runs.length,
    };
  return out;
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
  const rows = output.runs.map((r) => {
    const row = flatten(r.metrics as unknown as Record<string, unknown>);
    if (r.goals) {
      row['goals.passed'] = r.goals.passed ? 1 : 0;
      for (const g of r.goals.results) row[`goal.${g.metric}`] = g.passed ? 1 : 0;
    }
    return row;
  });
  const header = Object.keys(rows[0] ?? {});
  const cell = (v: number | string | null | undefined) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
}

/** JSON-lines server: one request per stdin line, one response per stdout line. */
export async function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const session = new Session();
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ ok: false, error: 'invalid JSON' }) + '\n');
      continue;
    }
    output.write(JSON.stringify(session.handle(req)) + '\n');
    if ((req as { op?: string }).op === 'close') break;
  }
  rl.close();
}

export function main(argv: readonly string[], cwd = process.cwd()): number {
  try {
    const args = parseArgs(argv);
    const configPath = resolve(cwd, args.config);
    const config = applyOverrides(JSON.parse(readFileSync(configPath, 'utf8')), args.overrides);
    const write = (text: string) => {
      if (args.out) writeFileSync(resolve(cwd, args.out), text);
      else process.stdout.write(text);
    };
    if (args.command === 'policy') {
      const make = BASELINES[args.policy!];
      if (!make) throw new UsageError(`Unknown policy '${args.policy}' (known: ${Object.keys(BASELINES).join(', ')})`);
      const seeds = args.seeds.length ? args.seeds : [1];
      const runs = seeds.map((seed) => ({ seed, ...runWithPolicy(config, seed, make()) }));
      write(JSON.stringify({ configPath: args.config, policy: make().name, runs }, null, 2) + '\n');
      return 0;
    }
    if (args.command === 'calibrate') {
      const raw = JSON.parse(readFileSync(resolve(cwd, args.targets!), 'utf8')) as { targets: AggregateTargets };
      const seeds = args.seeds.length ? args.seeds : [1, 2, 3];
      const fit = fitToTargets(config, raw.targets ?? (raw as AggregateTargets), seeds);
      process.stderr.write(`Fitted scales: admission ×${fit.scales.admission.toFixed(2)}, patience ×${fit.scales.patience.toFixed(2)}, workup ×${fit.scales.workup.toFixed(2)}\n`);
      write(JSON.stringify({ targetsFile: args.targets, seeds, ...fit }, null, 2) + '\n');
      return 0;
    }
    if (args.command === 'optimize') {
      const space = JSON.parse(readFileSync(resolve(cwd, args.space!), 'utf8')) as SearchSpace;
      const [metric, dir] = (args.objective ?? 'compositeScore').split(':');
      const objective = { metric: metric!, direction: dir === 'min' ? ('min' as const) : ('max' as const) };
      const seeds = args.seeds.length ? args.seeds : [1, 2, 3, 4, 5];
      const iterations = args.iterations ?? 200;
      const r = optimize({
        base: config,
        space,
        objective,
        seeds,
        iterations,
        onProgress: (i, _cur, best) => {
          if ((i + 1) % 25 === 0) process.stderr.write(`iteration ${i + 1}/${iterations}: best found ${best.toFixed(2)}\n`);
        },
      });
      process.stderr.write(`Best found ${objective.metric}: ${r.bestFound.value.toFixed(2)} (start ${r.start.value.toFixed(2)}, ${r.evaluations} setups tried)\n`);
      write(JSON.stringify({ objective, seeds, iterations, bestFound: r.bestFound, start: r.start, evaluations: r.evaluations, bestConfig: applySettings(config, r.bestFound.settings) }, null, 2) + '\n');
      return 0;
    }
    if (args.command === 'balance') {
      const seeds = args.seeds.length ? args.seeds : Array.from({ length: 40 }, (_, i) => i + 1);
      const r = balanceReport(config, seeds);
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const line = (name: string, row: NonNullable<typeof r.reference>) =>
        `${name.padEnd(10)} ${pct(row.passRate).padStart(4)} of ${r.seeds} days | level seed: ${row.onLevelSeed ? 'pass' : 'fail'} | ` +
        Object.entries(row.goalPassRates)
          .map(([k, v]) => `${k} ${pct(v)}`)
          .join(', ');
      process.stdout.write(`${r.levelId}\n${line('shipped', r.shipped)}\n${r.reference ? line('reference', r.reference) : 'reference  (none in config)'}\n`);
      process.stdout.write(`days where shipped fails and reference passes: ${r.discriminatingSeeds.slice(0, 12).join(' ') || 'none'}\n`);
      return 0;
    }
    const output = runConfig(config, args.config, args.seeds, args.overrides);
    const seedCount = output.runs.length;
    const text = args.format === 'csv' ? toCsv(output) : JSON.stringify(output, null, 2) + '\n';
    if (args.out) {
      writeFileSync(resolve(cwd, args.out), text);
      process.stderr.write(`Wrote ${seedCount} run(s) to ${args.out}\n`);
    } else process.stdout.write(text);
    for (const p of output.limitProblems) process.stderr.write(`Level limit exceeded: ${p}\n`);
    if (output.level) process.stderr.write(`Level ${output.level.number} (${output.level.title}): goals met in ${Math.round(output.level.passRate * 100)}% of runs\n`);
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
  if (process.argv[2] === 'serve') void serve().then(() => process.exit(0));
  // pnpm runs scripts from the workspace root; INIT_CWD is where the user actually ran the command.
  else process.exitCode = main(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd());
}
