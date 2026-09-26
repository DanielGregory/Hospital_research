/**
 * Drives a Simulation in real time. No sim logic here: it only decides how far
 * to advance the clock each frame and forwards player commands.
 */
import { Simulation, type Command } from '@er/sim';

/** Sim minutes per real second at 1x. */
export const SIM_MINUTES_PER_SECOND = 4;
export const SPEEDS = [0, 1, 2, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** Longest real-time step we honour (a backgrounded tab should not jump hours). */
const MAX_FRAME_MS = 250;

export class GameRunner {
  readonly sim: Simulation;
  speed: Speed = 1;

  constructor(config: unknown, seed: number) {
    this.sim = new Simulation(config, seed);
  }

  advance(realMs: number): void {
    if (this.speed === 0 || this.sim.finished) return;
    const dt = Math.min(realMs, MAX_FRAME_MS) / 1000;
    this.sim.runUntil(this.sim.now + dt * SIM_MINUTES_PER_SECOND * this.speed);
  }

  skipToEnd(): void {
    this.sim.runUntil(this.sim.config.durationMinutes);
  }

  command(cmd: Command): void {
    this.sim.command(cmd);
  }
}
