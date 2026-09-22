import { describe, expect, it } from 'vitest';
import { EventQueue } from '../src/eventQueue.js';
import { Rng } from '../src/rng.js';

describe('EventQueue', () => {
  it('pops in time order', () => {
    const q = new EventQueue<number>();
    const r = new Rng(1);
    const times = Array.from({ length: 500 }, () => r.uniform(0, 100));
    times.forEach((t) => q.push(t, t));
    const out: number[] = [];
    while (q.size) out.push(q.pop()!.time);
    expect(out).toEqual([...times].sort((a, b) => a - b));
  });

  it('breaks ties by priority, then insertion order', () => {
    const q = new EventQueue<string>();
    q.push(5, 'late-low', 2);
    q.push(5, 'first-high', 0);
    q.push(5, 'second-high', 0);
    q.push(1, 'earliest', 9);
    const out: string[] = [];
    while (q.size) out.push(q.pop()!.event);
    expect(out).toEqual(['earliest', 'first-high', 'second-high', 'late-low']);
  });
});
