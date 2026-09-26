import { parseVisits, Simulation, summarizeVisits, visitsCsv } from '@er/sim';
import { describe, expect, it } from 'vitest';
import base from '../../../configs/planner/example-baseline.json';

/** A department that differs from the defaults: busier, sicker, slower results, busy evenings. */
const hidden = {
  ...base,
  durationMinutes: 35 * 1440,
  warmupMinutes: 0,
  arrivals: {
    rateMultiplier: 1,
    hourlyRates: [2, 1.6, 1.4, 1.2, 1.2, 1.4, 2, 3, 4.2, 5, 5.6, 5.8, 5.8, 5.8, 5.6, 5.8, 6, 6.4, 6.6, 6.4, 5.8, 4.8, 3.6, 2.6],
    acuityMix: { '1': 0.02, '2': 0.2, '3': 0.5, '4': 0.22, '5': 0.06 },
  },
  disposition: { admitProbabilityByAcuity: { '1': 0.9, '2': 0.55, '3': 0.3, '4': 0.05, '5': 0.01 } },
  workup: { enabled: true, meanMinutesByAcuity: { '1': 120, '2': 130, '3': 110, '4': 30, '5': 5 } },
  boarding: { dischargesPerDay: 27 },
};

describe('calibration from visit records', () => {
  it('writes what it reads (simulated patients round-trip through the export format)', () => {
    const sim = new Simulation({ ...hidden, durationMinutes: 3 * 1440 }, 5);
    sim.run();
    const back = parseVisits(visitsCsv(sim.allPatients()));
    expect(back.visits.length).toBe(sim.allPatients().filter((p) => p.departureTime !== undefined).length);
  });

  it('reads common alternative column names and formats', () => {
    const p = parseVisits('INTIME,ESI,Disposition,Arrival_Transport\n03/05/2024 14:07,3,Admitted to ward,Ambulance\n"03/05/2024 15:30",4,"Home, with GP letter",Walk in\n');
    expect(p.visits.map((v) => [v.acuity, v.disposition, v.byAmbulance, Math.round(v.hour * 60)])).toEqual([
      [3, 'admitted', true, 14 * 60 + 7],
      [4, 'discharged', false, 15 * 60 + 30],
    ]);
    expect(parseVisits('foo,bar\n1,2\n').problems[0]).toMatch(/arrival time/);
  });
});
