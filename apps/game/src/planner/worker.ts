/// <reference lib="webworker" />
/**
 * Planner runs off the main thread: scenario comparisons and calibration take seconds.
 * Messages in: { kind: 'compare' | 'calibrate', ... }; out: progress, then a result or an error.
 */
import { baselineCheck, calibrate, compareScenarios, fitToHospital, type HospitalTargets, type Scenario } from '@er/research';
import { parseVisits, summarizeVisits, type SimConfig } from '@er/sim';

export type WorkerRequest =
  | { kind: 'compare'; base: SimConfig; scenarios: Scenario[]; seeds: number[] }
  | { kind: 'calibrate'; base: SimConfig; csv: string; seeds: number[] }
  | { kind: 'check'; base: SimConfig; csv: string; seeds: number[] }
  | { kind: 'fitHospital'; base: SimConfig; targets: HospitalTargets; seeds: number[] };

export type WorkerResponse =
  | { kind: 'progress'; done: number; total: number; label: string }
  | { kind: 'compare'; comparison: ReturnType<typeof compareScenarios> }
  | {
      kind: 'calibrate' | 'check';
      columns: ReturnType<typeof parseVisits>['columns'];
      problems: string[];
      data: ReturnType<typeof summarizeVisits> | null;
      config: SimConfig;
      fitted: Record<string, unknown>;
      notes: string[];
      check: ReturnType<typeof baselineCheck>;
    }
  | { kind: 'fitHospital'; fit: ReturnType<typeof fitToHospital> }
  | { kind: 'error'; message: string };

const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.kind === 'compare') {
      const comparison = compareScenarios(req.base, req.scenarios, {
        seeds: req.seeds,
        onProgress: (done, total) => {
          if (done % 4 === 0 || done === total) post({ kind: 'progress', done, total, label: 'Simulating weeks' });
        },
      });
      post({ kind: 'compare', comparison });
      return;
    }
    if (req.kind === 'fitHospital') {
      post({ kind: 'progress', done: 0, total: 1, label: 'Fitting the model to the hospital’s published figures' });
      post({ kind: 'fitHospital', fit: fitToHospital(req.base, req.targets, req.seeds) });
      return;
    }
    const parsed = parseVisits(req.csv);
    if (!parsed.visits.length) {
      post({ kind: req.kind, columns: parsed.columns, problems: parsed.problems, data: null, config: req.base, fitted: {}, notes: [], check: [] });
      return;
    }
    const data = summarizeVisits(parsed.visits);
    post({ kind: 'progress', done: 0, total: 2, label: req.kind === 'calibrate' ? 'Fitting the model to your data' : 'Checking the model' });
    const cal =
      req.kind === 'calibrate' ? calibrate(req.base, parsed.visits, data, { seeds: req.seeds.slice(0, 3) }) : { config: req.base, fitted: {}, notes: [] as string[] };
    post({ kind: 'progress', done: 1, total: 2, label: 'Checking the model against your data' });
    const check = baselineCheck(cal.config, data, req.seeds);
    post({ kind: req.kind, columns: parsed.columns, problems: parsed.problems, data, config: cal.config as SimConfig, fitted: cal.fitted, notes: cal.notes, check });
  } catch (err) {
    post({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
