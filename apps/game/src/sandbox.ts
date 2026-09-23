/** Sandbox runs: a plain config (no story level), used by the layout editor and the sandbox screen. */
import { Simulation, type LevelSpec, type Metrics, type ResolvedLayout, type SimConfig } from '@er/sim';
import type { Walks } from './play/WalkMap';

export type GameConfig = SimConfig & { level?: LevelSpec };

export interface QuickScore {
  doorToDoctorMean: number;
  doorToDoctorMedian: number;
  lengthOfStayMedian: number;
  lwbsRate: number;
  doctorWalkingShare: number | null;
  /** Walking records from the first run, with its floor plan (layout module only). */
  walks?: { layout: ResolvedLayout; walks: Walks };
}

/** Average a few headless runs of a config. Fast enough to call from a click handler. */
export function quickScore(config: SimConfig, seeds: readonly number[] = [1, 2, 3]): QuickScore {
  const sims = seeds.map((s) => new Simulation(config, s));
  const ms: Metrics[] = sims.map((sim) => sim.run().metrics);
  const first = sims[0]!;
  const avg = (f: (m: Metrics) => number | null | undefined) => ms.reduce((a, m) => a + (f(m) ?? 0), 0) / ms.length;
  return {
    doorToDoctorMean: avg((m) => m.doorToDoctor.mean),
    doorToDoctorMedian: avg((m) => m.doorToDoctor.median),
    lengthOfStayMedian: avg((m) => m.lengthOfStay.median),
    lwbsRate: avg((m) => m.lwbsRate),
    doctorWalkingShare: ms[0]!.walking ? avg((m) => m.walking?.shareOfBusyByRole.doctor) : null,
    ...(first.config.layout ? { walks: { layout: first.config.layout, walks: { staff: first.walkTrips('staff'), patient: first.walkTrips('patient') } } } : {}),
  };
}

/** Offer a config as a JSON file download. */
export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
