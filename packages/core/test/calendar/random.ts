/** Seeded PRNG for property tests: failures print the seed, and `CALENDAR_SEED=<n>` replays one run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  readonly seed: number;
  float(): number;
  int(min: number, max: number): number;
  pick<T>(list: readonly T[]): T;
  chance(p: number): boolean;
  subset<T>(list: readonly T[], min?: number): T[];
}

export function rng(seed: number): Rng {
  const next = mulberry32(seed);
  const r: Rng = {
    seed,
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)]!,
    chance: (p) => next() < p,
    subset: (list, min = 0) => {
      const out = list.filter(() => next() < 0.5);
      while (out.length < min) {
        const extra = list.find((x) => !out.includes(x));
        if (extra === undefined) break;
        out.push(extra);
      }
      return out;
    },
  };
  return r;
}

/** Runs `body` for `runs` seeds; a failure rethrows with the seed in the message. */
export function forSeeds(
  runs: number,
  body: (r: Rng) => void,
  base = Number(process.env.CALENDAR_SEED ?? 20260913),
): void {
  const count = process.env.CALENDAR_SEED ? 1 : runs;
  for (let i = 0; i < count; i++) {
    const seed = base + i;
    try {
      body(rng(seed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed with seed ${seed} (replay: CALENDAR_SEED=${seed}).\n${message}`, {
        cause: error,
      });
    }
  }
}
