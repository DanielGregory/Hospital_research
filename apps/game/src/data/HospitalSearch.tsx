/** Find a US hospital in the CMS Care Compare figures and pick it. */
import type { CmsHospital } from '@er/sim';
import { useEffect, useState } from 'react';
import { loadCms, searchHospitals, titleCase, type CmsData } from './cms';

/** Days since an ISO date (YYYY-MM-DD). */
export function staleDays(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : Infinity;
}

export function HospitalSearch(props: { onPick: (h: CmsHospital, data: CmsData) => void; busy?: boolean; action: string }) {
  const [data, setData] = useState<CmsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    loadCms()
      .then(setData)
      .catch(() => setFailed(true));
  }, []);
  const hits = data ? searchHospitals(data.hospitals, q) : [];
  if (failed) return <p className="muted small">The hospital list could not be loaded.</p>;
  return (
    <div className="hospital-search">
      <input
        type="search"
        placeholder={data ? `Search ${data.hospitals.length.toLocaleString('en-US')} US hospitals by name, city or state` : 'Loading hospitals…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={!data}
        aria-label="Search hospitals"
        data-testid="hospital-search"
      />
      {data && (
        <p className="muted small" data-testid="cms-date">
          CMS Care Compare figures, reporting period {data.periods.OP_18b ?? data.periods.OP_22}; downloaded {data.retrieved}.
          {staleDays(data.retrieved) > 120 && ' CMS updates these every quarter, so they may be out of date: refresh with pnpm data:cms.'}
        </p>
      )}
      {q.trim().length > 1 && data && (
        <ul className="hospital-hits">
          {hits.length === 0 && <li className="muted small">No match.</li>}
          {hits.map((h) => (
            <li key={h.id}>
              <div>
                <strong>{titleCase(h.name)}</strong> <span className="muted small">{titleCase(h.city)}, {h.state}</span>
                <div className="muted small">
                  {h.visitsPerYear ? `${Math.round(h.visitsPerYear / 365)} ED visits a day` : 'visits not reported'}
                  {h.medianMinutesDischarged !== null && ` · median ${h.medianMinutesDischarged} min in the ED (sent home)`}
                  {h.lwbsRate !== null && ` · ${Math.round(h.lwbsRate * 100)}% left before being seen`}
                </div>
              </div>
              <button onClick={() => props.onPick(h, data)} disabled={props.busy || !h.visitsPerYear} data-testid={`pick-${h.id}`}>
                {props.action}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
