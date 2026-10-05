/**
 * The US national fit (NHAMCS 2021–2022 ED; `pnpm headless open-data --source nhamcs-2021-2022`
 * with the department in `fit.department.overrides`): a typical mid-size department (about 98
 * visits a day, 32 beds, a fast track) that reproduces national waits, lengths of stay, admissions,
 * boarding and leaving unseen. The planner's example and new hospitals start from it. Re-run the
 * command to refresh it.
 */
import { applySettings, type SimConfig } from '@er/sim';
import fit from '../../../../configs/calibration/nhamcs-2021-2022.fitted.json';

type Row = { status: string };

export const NATIONAL = {
  name: fit.source.name,
  citation: fit.source.citation,
  /** Checks that matched, of those with data. */
  close: (fit.check as Row[]).filter((c) => c.status === 'close').length,
  checked: (fit.check as Row[]).filter((c) => c.status !== 'no data').length,
};

/**
 * Apply the national fit. With `withCapacity` (the planner's example) the department it was fitted
 * for comes too: beds, fast track and shifts. Without it (a hospital of your own) only the case mix,
 * admissions, test times and patience: your own volume, beds, shifts and wards stay.
 */
export function withNational<T extends SimConfig>(config: T, withCapacity = true): T {
  const settings = Object.entries(fit.fitted).filter(([k]) => withCapacity || !(k === 'arrivals.rateMultiplier' || k.startsWith('boarding.inpatient') || k === 'boarding.initialOccupied'));
  const department = withCapacity ? Object.entries(fit.department.overrides as Record<string, unknown>) : [];
  return applySettings(config, Object.fromEntries([...department, ...settings])) as T;
}
