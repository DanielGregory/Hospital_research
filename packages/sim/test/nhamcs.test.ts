import { describe, expect, it } from 'vitest';
import { nhamcsVisits, parseNhamcs, summarizeNhamcs, weightedQuantile } from '../src/index';

/** A made-up 2022 record: fields placed at the documented 1-based positions, everything else blank. */
function record(f: Partial<Record<string, string>>): string {
  const pos: Record<string, [number, number]> = {
    VMONTH: [1, 2], VDAYR: [3, 1], ARRTIME: [4, 4], WAITTIME: [8, 4], LOV: [12, 4], AGE: [16, 3], SEX: [25, 1], ARREMS: [33, 2], IMMEDR: [67, 2],
    LWBS: [491, 1], ADMITHOS: [499, 1], TRANOTH: [498, 1], ADMIT: [503, 2], LOS: [507, 2], YEAR: [2341, 4], PATWT: [2359, 11], BOARDED: [2379, 4],
  };
  const line = Array(2382).fill(' ');
  for (const [k, v] of Object.entries({ YEAR: '2022', LWBS: '0', ADMITHOS: '0', TRANOTH: '0', ...f })) {
    const [s, n] = pos[k]!;
    v!.padStart(n).split('').forEach((c, i) => (line[s - 1 + i] = c));
  }
  return line.join('');
}

describe('NHAMCS ED file (2022 layout)', () => {
  const lines = [
    // Monday 14:30, ESI 2, ambulance, admitted to critical care, waited 12 min, stayed 300 min, boarded 90 min.
    record({ VMONTH: '03', VDAYR: '2', ARRTIME: '1430', WAITTIME: '12', LOV: '300', AGE: '67', SEX: '1', ARREMS: '1', IMMEDR: '2', ADMITHOS: '1', ADMIT: '1', LOS: '5', BOARDED: '90', PATWT: '3000.5' }),
    // Sunday 02:05, ESI 4, walked in, left without being seen; weight 1000.
    record({ VMONTH: '07', VDAYR: '1', ARRTIME: '205', WAITTIME: '-7', LOV: '45', AGE: '25', SEX: '2', ARREMS: '2', IMMEDR: '4', LWBS: '1', PATWT: '1000' }),
    // No triage done (IMMEDR 0), discharged home; weight 1000.
    record({ VMONTH: '11', VDAYR: '4', ARRTIME: '900', WAITTIME: '30', LOV: '120', SEX: '1', ARREMS: '-8', IMMEDR: '0', PATWT: '1000' }),
  ];

  it('reads fields by position and maps the codes', () => {
    const { visits, problems } = parseNhamcs(lines.join('\r\n'), 2022);
    expect(problems).toEqual([]);
    const [a, b, c] = visits;
    expect(a).toMatchObject({ dayOfWeek: 0, hour: 14.5, wait: 12, lengthOfVisit: 300, age: 67, sex: 'F', ambulance: true, acuity: 2, disposition: 'admitted', unit: 'icu', hospitalDays: 5, boarded: 90, weight: 3000.5 });
    expect(b).toMatchObject({ dayOfWeek: 6, wait: null, sex: 'M', ambulance: false, acuity: 4, disposition: 'lwbs', unit: null });
    expect(b!.hour).toBeCloseTo(2 + 5 / 60, 6);
    expect(c).toMatchObject({ acuity: null, ambulance: null, disposition: 'discharged' });
  });

  it('rejects records from another year or of the wrong length, and unknown years', () => {
    expect(parseNhamcs(record({ YEAR: '2021' }), 2022).visits).toHaveLength(0);
    expect(parseNhamcs('short line', 2022).problems[0]).toMatch(/2382/);
    expect(parseNhamcs(lines[0]!, 1999).problems[0]).toMatch(/No record layout/);
  });

  it('weights national estimates and draws visits in proportion to the weights', () => {
    const { visits } = parseNhamcs(lines.join('\n'), 2022);
    const s = summarizeNhamcs(visits);
    expect(s.weightedVisits).toBe(5001);
    expect(s.triagedShare).toBeCloseTo(4000.5 / 5000.5, 3);
    expect(s.lwbsRate).toBeCloseTo(1000 / 5000.5, 3);
    expect(s.units.icu.share).toBe(1);
    expect(weightedQuantile([{ v: 1, w: 1 }, { v: 10, w: 3 }], 0.5)).toBe(10);
    const drawn = nhamcsVisits(visits, 50);
    expect(drawn).toHaveLength(50);
    expect(drawn.filter((v) => v.disposition === 'admitted').length).toBe(30);
    expect(drawn.find((v) => v.disposition === 'admitted')!.toDecision).toBe(210);
  });
});
