import { describe, expect, it } from 'vitest';
import { parseCmsTimelyCare } from '../src/index';

// Made-up rows in the Timely and Effective Care file's format.
const csv = [
  '﻿Facility ID,Facility Name,Address,City/Town,State,ZIP Code,County/Parish,Telephone Number,Condition,Measure ID,Measure Name,Score,Sample,Footnote,Start Date,End Date',
  '999001,EXAMPLE GENERAL HOSPITAL,1 MAIN ST,SPRINGFIELD,ZZ,00000,X,(000) 000-0000,Emergency Department,EDV,Emergency department volume,high,,,01/01/2024,12/31/2024',
  '999001,EXAMPLE GENERAL HOSPITAL,1 MAIN ST,SPRINGFIELD,ZZ,00000,X,(000) 000-0000,Emergency Department,OP_18b,"Median time, sent home",165,812,,10/01/2024,09/30/2025',
  '999001,EXAMPLE GENERAL HOSPITAL,1 MAIN ST,SPRINGFIELD,ZZ,00000,X,(000) 000-0000,Emergency Department,OP_22,Left before being seen,2,"45,625",,01/01/2024,12/31/2024',
  '999001,EXAMPLE GENERAL HOSPITAL,1 MAIN ST,SPRINGFIELD,ZZ,00000,X,(000) 000-0000,Emergency Department,OP_18c,Psych,Not Available,Not Available,5,10/01/2024,09/30/2025',
  '999001,EXAMPLE GENERAL HOSPITAL,1 MAIN ST,SPRINGFIELD,ZZ,00000,X,(000) 000-0000,Heart Attack,OP_4,Aspirin,95,100,,01/01/2024,12/31/2024',
  '999002,NO ED CLINIC,2 MAIN ST,SPRINGFIELD,ZZ,00000,X,(000) 000-0000,Emergency Department,EDV,Emergency department volume,Not Available,,,01/01/2024,12/31/2024',
].join('\n');

describe('CMS Care Compare ED measures', () => {
  it('keeps one row per hospital with its ED measures, and the reporting periods', () => {
    const x = parseCmsTimelyCare(csv);
    expect(x.hospitals).toHaveLength(1);
    expect(x.hospitals[0]).toEqual({
      id: '999001',
      name: 'EXAMPLE GENERAL HOSPITAL',
      city: 'SPRINGFIELD',
      state: 'ZZ',
      volumeBand: 'high',
      medianMinutesDischarged: 165,
      medianMinutesAll: null,
      medianMinutesPsych: null,
      medianMinutesTransfer: null,
      lwbsRate: 0.02,
      visitsPerYear: 45625,
    });
    expect(x.periods.OP_18b).toBe('10/01/2024–09/30/2025');
  });

  it('refuses a file of another shape', () => {
    expect(() => parseCmsTimelyCare('a,b\n1,2')).toThrow(/Facility ID/);
  });
});
