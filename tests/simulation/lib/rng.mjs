/**
 * Seeded randomness. Everything random in a simulation comes from one of these generators, derived from
 * the run's seed and a stream name, so a run is reproducible from its seed and adding a draw to one
 * stream never shifts another.
 */

/** FNV-1a over a string, to derive a stream's state from the seed and the stream's name. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small generator with a 32-bit state, good enough for choosing among a few dozen things. */
export function stream(seed, name) {
  let state = hash32(`${seed}:${name}`) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** Uniform in [0, 1). */
    next,
    /** Integer in [min, max]. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    /** `count` distinct elements, in a seeded order. */
    sample: (list, count) => {
      const pool = [...list];
      const out = [];
      while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      return out;
    },
  };
}

/** Choose from a list by a stored uniform draw (the plan stores draws; the list is only known at run time). */
export const byDraw = (list, draw) => (list.length === 0 ? undefined : list[Math.min(list.length - 1, Math.floor(draw * list.length))]);

/** A short stable digest of any JSON-serialisable value (FNV-1a, 64 bits as two 32-bit halves). */
export function digest(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((c << 5) | (c >>> 3)), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
