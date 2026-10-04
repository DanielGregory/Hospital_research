/**
 * Hospital emergency department figures from CMS Care Compare (configs/open/cms-ed-hospitals.json,
 * refreshed with `pnpm headless open-data --source cms-ed --fetch`). Loaded on demand: it is a few
 * hundred kilobytes.
 */
import type { CmsHospital } from '@er/sim';

export interface CmsData {
  source: string;
  periods: Record<string, string>;
  retrieved: string;
  hospitals: CmsHospital[];
}

let cache: Promise<CmsData> | null = null;

export function loadCms(): Promise<CmsData> {
  cache ??= import('../../../../configs/open/cms-ed-hospitals.json').then((m) => {
    const d = m.default as { source: string; periods: Record<string, string>; retrieved: string; columns: string[]; rows: unknown[][] };
    return { ...d, hospitals: d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]])) as unknown as CmsHospital) };
  });
  return cache;
}

/** Hospitals whose name, city or state match every word of the query (most visits first). */
export function searchHospitals(hs: readonly CmsHospital[], query: string, limit = 8): CmsHospital[] {
  const words = query.toUpperCase().split(/[\s,]+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return hs
    .filter((h) => {
      const text = `${h.name} ${h.city} ${h.state} ${h.id}`;
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => (b.visitsPerYear ?? 0) - (a.visitsPerYear ?? 0))
    .slice(0, limit);
}

/** "SOUTHEAST HEALTH MEDICAL CENTER" → "Southeast Health Medical Center". */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Of|And|The|At|In)\b/g, (w) => w.toLowerCase()).replace(/^./, (c) => c.toUpperCase());
}
