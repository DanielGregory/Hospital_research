/** Story levels are plain JSON configs in /configs/levels. */
import type { LevelSpec, SimConfig } from '@er/sim';

export type LevelConfig = SimConfig & { level: LevelSpec };

const modules = import.meta.glob<{ default: LevelConfig }>('../../../configs/levels/*.json', { eager: true });

export const LEVELS: LevelConfig[] = Object.values(modules)
  .map((m) => m.default)
  .filter((c) => c.level)
  .sort((a, b) => a.level.number - b.level.number);
