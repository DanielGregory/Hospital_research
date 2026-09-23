/**
 * Candidate floor plans for Level 8's best-found search: every combination of a few placements
 * for each room, kept when the plan is valid and within the level's limits. Writes
 * configs/benchmarks/level-08.space.json (one dimension, `layout.rooms`).
 *
 *   npx tsx tools/headless/scripts/level8-space.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applySettings, checkSetup, resolveConfig, type RoomSpec } from '@er/sim';

const root = resolve(import.meta.dirname, '../../..');
const level = JSON.parse(readFileSync(resolve(root, 'configs/levels/level-08-new-build.json'), 'utf8'));

type Place = Omit<RoomSpec, 'id' | 'type'>;
const options: Record<string, { type: RoomSpec['type']; at: Place[] }> = {
  waiting: { type: 'waiting', at: [{ x: 1, y: 1, w: 5, h: 5 }, { x: 1, y: 2, w: 5, h: 4 }] },
  triage: { type: 'triage', at: [{ x: 1, y: 10, w: 4, h: 3 }, { x: 1, y: 12, w: 4, h: 3 }, { x: 7, y: 7, w: 3, h: 3 }] },
  station: { type: 'station', at: [{ x: 11, y: 7, w: 3, h: 2 }, { x: 9, y: 7, w: 3, h: 2 }, { x: 14, y: 7, w: 3, h: 2 }, { x: 12, y: 6, w: 2, h: 3 }] },
  'acute-a': { type: 'acute', at: [{ x: 7, y: 1, w: 10, h: 5 }, { x: 8, y: 1, w: 10, h: 5 }] },
  'acute-b': { type: 'acute', at: [{ x: 7, y: 11, w: 8, h: 4 }, { x: 9, y: 11, w: 8, h: 4 }, { x: 11, y: 10, w: 8, h: 4 }] },
  trauma: { type: 'trauma', at: [{ x: 18, y: 10, w: 5, h: 4 }, { x: 20, y: 11, w: 5, h: 4 }, { x: 19, y: 6, w: 5, h: 4 }] },
};

const names = Object.keys(options);
const plans: RoomSpec[][] = [];
const pick = (i: number, acc: RoomSpec[]) => {
  if (i === names.length) {
    const cfg = applySettings(level, { 'layout.rooms': acc });
    try {
      if (checkSetup(resolveConfig(cfg)).length === 0) plans.push(acc);
    } catch {
      // overlapping or unreachable: not a plan
    }
    return;
  }
  const id = names[i]!;
  for (const at of options[id]!.at) pick(i + 1, [...acc, { id, type: options[id]!.type, ...at }]);
};
pick(0, []);
writeFileSync(resolve(root, 'configs/benchmarks/level-08.space.json'), JSON.stringify({ dims: [{ path: 'layout.rooms', values: plans }] }) + '\n');
console.log(`${plans.length} valid plans`);
