import { describe, expect, it } from 'vitest';
import { fitVisits, mimicEdVisits, restackVisits, summarizeVisits } from '../src/index';
import { Rng } from '../src/rng';

/** Synthetic stays in MIMIC-IV-ED's format, with each patient's dates shifted far apart (as MIMIC does). */
function fakeMimic(n: number) {
  const rng = new Rng(7);
  const ed = ['subject_id,hadm_id,stay_id,intime,outtime,gender,race,arrival_transport,disposition'];
  const tri = ['subject_id,stay_id,temperature,heartrate,resprate,o2sat,sbp,dbp,pain,acuity,chiefcomplaint'];
  const pad = (x: number) => String(x).padStart(2, '0');
  const stamp = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  };
  for (let i = 0; i < n; i++) {
    // A different century-scale shift per patient, like MIMIC's 2110–2210 dates.
    const t = Date.UTC(2110 + Math.floor(rng.next() * 100), Math.floor(rng.next() * 12), 1 + Math.floor(rng.next() * 28), Math.floor(rng.next() * 24), Math.floor(rng.next() * 60));
    const acuity = 1 + Math.floor(rng.next() * 5);
    const los = 60 + rng.next() * 400;
    const admitted = acuity <= 2 ? rng.next() < 0.7 : rng.next() < 0.1;
    const amb = acuity <= 2 ? 'AMBULANCE' : rng.next() < 0.1 ? 'UNKNOWN' : 'WALK IN';
    ed.push(`${1000 + i},,${3000 + i},${stamp(t)},${stamp(t + los * 60000)},${rng.next() < 0.5 ? 'F' : 'M'},WHITE,${amb},${admitted ? 'ADMITTED' : 'HOME'}`);
    // Some stays have no triage row, and one complaint has a comma.
    if (i % 10 !== 9) tri.push(`${1000 + i},${3000 + i},98.6,80,16,98,120,80,3,${acuity},"Abd pain, nausea"`);
  }
  return { edstays: ed.join('\n'), triage: tri.join('\n') };
}

describe('open data: MIMIC-IV-ED', () => {
  const { edstays, triage } = fakeMimic(700);

  it('joins stays to triage acuity by stay_id and reads disposition and arrival mode', () => {
    const r = mimicEdVisits(edstays, triage);
    expect(r.stays).toBe(700);
    expect(r.visits).toHaveLength(700);
    expect(r.withAcuity).toBe(630);
    expect(r.visits.filter((v) => v.acuity === null)).toHaveLength(70);
    expect(r.visits.some((v) => v.disposition === 'admitted')).toBe(true);
    // UNKNOWN arrival mode is unknown, not "walked in".
    expect(r.visits.some((v) => v.byAmbulance === null)).toBe(true);
    expect(r.visits.every((v) => v.lengthOfStay! >= 59)).toBe(true);
  });

  it('lays shifted dates out at a chosen volume, keeping weekday, time of day and length of stay', () => {
    const { visits } = mimicEdVisits(edstays, triage);
    const restacked = restackVisits(visits, 100);
    expect(restacked).toHaveLength(visits.length);
    expect(summarizeVisits(restacked).arrivalsPerDay).toBeCloseTo(100, -1);
    for (const v of restacked) {
      expect(Math.floor(v.arrival / 1440) % 7).toBe(v.dayOfWeek);
      expect(Math.abs((v.arrival % 1440) - v.hour * 60)).toBeLessThan(0.01);
    }
    const los = (vs: typeof visits) => vs.map((v) => v.lengthOfStay).sort((a, b) => a! - b!);
    expect(los(restacked)).toEqual(los(visits));
    // The fit reads acuity mix and admission by acuity from it.
    const f = fitVisits(restacked).fragment as { arrivals: { acuityMix: Record<string, number> }; disposition: { admitProbabilityByAcuity: Record<string, number> } };
    expect(f.disposition.admitProbabilityByAcuity['1']!).toBeGreaterThan(f.disposition.admitProbabilityByAcuity['5']!);
    expect(Object.values(f.arrivals.acuityMix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });

  it('reports a missing column instead of guessing', () => {
    expect(mimicEdVisits('a,b\n1,2', triage).problems[0]).toMatch(/stay_id/);
  });
});
