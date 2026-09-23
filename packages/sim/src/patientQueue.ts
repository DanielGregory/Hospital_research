/**
 * Waiting line ordered by (class, entry time, patient id), with O(log n)
 * push/pop and O(1) removal by lazy deletion (for LWBS and rerouting).
 * Class 0 is served first; with a single class it is plain FIFO.
 */

interface Entry {
  cls: number;
  time: number;
  id: number;
  token: number;
}

export class PatientQueue {
  private heap: Entry[] = [];
  /** Live token per patient id; entries with a different token are dead. */
  private readonly live = new Map<number, number>();
  private nextToken = 0;

  get size(): number {
    return this.live.size;
  }

  has(id: number): boolean {
    return this.live.has(id);
  }

  push(id: number, cls: number, time: number): void {
    if (this.live.has(id)) throw new Error(`patient ${id} is already queued`);
    const token = this.nextToken++;
    this.live.set(id, token);
    const h = this.heap;
    h.push({ cls, time, id, token });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  /** Remove and return the id of the next live patient. */
  pop(): number | undefined {
    for (;;) {
      const top = this.popRaw();
      if (!top) return undefined;
      if (this.live.get(top.id) === top.token) {
        this.live.delete(top.id);
        return top.id;
      }
    }
  }

  /** The id `pop()` would return, without removing it. */
  peek(): number | undefined {
    for (;;) {
      const top = this.heap[0];
      if (!top) return undefined;
      if (this.live.get(top.id) === top.token) return top.id;
      this.popRaw();
    }
  }

  remove(id: number): boolean {
    return this.live.delete(id);
  }

  /** Live patient ids in service order (copy). */
  ids(): number[] {
    return this.heap
      .filter((e) => this.live.get(e.id) === e.token)
      .sort((a, b) => (less(a, b) ? -1 : 1))
      .map((e) => e.id);
  }

  /** Empty the queue, returning live ids in service order. */
  drain(): number[] {
    const ids = this.ids();
    this.heap = [];
    this.live.clear();
    return ids;
  }

  private popRaw(): Entry | undefined {
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

function less(a: Entry, b: Entry): boolean {
  if (a.cls !== b.cls) return a.cls < b.cls;
  if (a.time !== b.time) return a.time < b.time;
  return a.id < b.id;
}
