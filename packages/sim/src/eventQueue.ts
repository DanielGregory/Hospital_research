/**
 * Min-heap of timestamped events.
 *
 * Ordering is (time, priority, insertion sequence), so events at the same
 * timestamp always come out in the same order — required for determinism.
 */

export interface Scheduled<T> {
  time: number;
  /** Lower runs first among events at the same time. */
  priority: number;
  seq: number;
  event: T;
}

export class EventQueue<T> {
  private heap: Scheduled<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, event: T, priority = 0): void {
    if (!Number.isFinite(time)) throw new Error(`Event time must be finite, got ${time}`);
    const item: Scheduled<T> = { time, priority, seq: this.seq++, event };
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  peek(): Scheduled<T> | undefined {
    return this.heap[0];
  }

  pop(): Scheduled<T> | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

function less<T>(x: Scheduled<T>, y: Scheduled<T>): boolean {
  if (x.time !== y.time) return x.time < y.time;
  if (x.priority !== y.priority) return x.priority < y.priority;
  return x.seq < y.seq;
}
