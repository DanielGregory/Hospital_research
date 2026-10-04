/**
 * The US national fit (NHAMCS 2022 ED, `pnpm headless open-data --source nhamcs-2022 --set
 * beds.main=32`): settings that make a typical mid-size department reproduce national waits,
 * lengths of stay, admissions and leaving unseen. The planner's example and new hospitals start
 * from it. Re-run the command to refresh it.
 */
import { applySettings, type SimConfig } from '@er/sim';
import fit from '../../../../configs/calibration/nhamcs-2022.fitted.json';

export const NATIONAL = {
  name: fit.source.name,
  citation: fit.source.citation,
  /** Beds of the department the fit was made for. */
  beds: (fit.department.overrides as Record<string, number>)['beds.main'] ?? null,
  /** Checks that matched, of those with data. */
  close: fit.check.filter((c) => c.status === 'close').length,
  checked: fit.check.filter((c) => c.status !== 'no data').length,
};

/** Apply the national fit. `withCapacity` false keeps the config's own volume and inpatient beds. */
export function withNational<T extends SimConfig>(config: T, withCapacity = true): T {
  const settings = Object.entries(fit.fitted).filter(([k]) => withCapacity || !(k === 'arrivals.rateMultiplier' || k.startsWith('boarding.inpatient') || k === 'boarding.initialOccupied'));
  return applySettings(config, Object.fromEntries(settings)) as T;
}
