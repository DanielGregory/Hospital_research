/**
 * Writes configs/planner/sample-visits.csv: SYNTHETIC visit records from a simulated department
 * (not real patients), in the export format the planner reads. Used for demos and as an example
 * of the file a hospital would provide.
 *
 *   npx tsx tools/headless/scripts/sample-visits.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Simulation, visitsCsv } from '@er/sim';

const root = resolve(import.meta.dirname, '../../..');
const department = {
  id: 'sample-department',
  durationMinutes: 49 * 1440,
  modules: { staffing: true, boarding: true, diagnosis: true },
  staffing: {
    doctors: 0,
    triageNurses: 0,
    schedule: {
      doctor: [
        { startHour: 8, hours: 12, count: 3 },
        { startHour: 12, hours: 12, count: 1 },
        { startHour: 20, hours: 12, count: 2 },
      ],
      triageNurse: [
        { startHour: 0, hours: 24, count: 1 },
        { startHour: 10, hours: 12, count: 1 },
      ],
    },
  },
  beds: { main: 18 },
  arrivals: {
    hourlyRates: [2, 1.6, 1.4, 1.2, 1.2, 1.4, 2, 3, 4.2, 5, 5.6, 5.8, 5.8, 5.8, 5.6, 5.8, 6, 6.4, 6.6, 6.4, 5.8, 4.8, 3.6, 2.6],
    acuityMix: { '1': 0.02, '2': 0.2, '3': 0.5, '4': 0.22, '5': 0.06 },
  },
  disposition: { admitProbabilityByAcuity: { '1': 0.9, '2': 0.55, '3': 0.3, '4': 0.05, '5': 0.01 } },
  workup: { enabled: true, meanMinutesByAcuity: { '1': 120, '2': 130, '3': 110, '4': 30, '5': 5 } },
  boarding: { dischargesPerDay: 27 },
};
const sim = new Simulation(department, 2024);
sim.run();
// Drop the first week (the simulated department starts empty).
const csv = visitsCsv(sim.allPatients(), { fromMinute: 7 * 1440, startDate: '2024-01-01 00:00' });
writeFileSync(resolve(root, 'configs/planner/sample-visits.csv'), csv);
console.log(`${csv.split('\n').length - 2} synthetic visits`);
