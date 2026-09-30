/** Small seeded PRNG (mulberry32) with the helpers the scenario needs. Same seed, same sequence, on any machine. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  float(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hi: number): number {
    return Math.floor(this.float(lo, hi + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** A derived generator, so adding draws in one area never shifts another area's sequence. */
  fork(label: string): Rng {
    let h = this.state ^ 0x85ebca6b;
    for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    return new Rng(h);
  }
}
