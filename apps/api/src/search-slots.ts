/**
 * Search's slot gate (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 6): at most 3 searches at once on a
 * machine, so search never holds more than half of the machine's 6 database connections. A fourth waits up to a
 * second for a slot, then is refused `search_busy`, which a client retries. Other routes never wait on it.
 *
 * In memory, on each machine: two machines hold at most 6 of the API's 12 connections for search.
 */

/** Searches running at once on one machine. */
export const SEARCH_SLOTS = 3;
/** How long a search waits for a slot before it's refused. */
export const SEARCH_SLOT_WAIT_MS = 1_000;

/** Lets the slot go; calling it again does nothing. */
export type ReleaseSlot = () => void;

export interface SlotGate {
  /** A slot, waiting up to `timeoutMs` for one; null when none came free in time. */
  acquireSlot(timeoutMs: number): Promise<ReleaseSlot | null>;
  /** Slots held now, and searches waiting for one. */
  readonly held: number;
  readonly waiting: number;
}

/** A gate of `size` slots, handed out first come, first served. */
export function createSlotGate(size: number): SlotGate {
  let held = 0;
  const queue: ((release: ReleaseSlot) => void)[] = [];
  const releaser = (): ReleaseSlot => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      // The slot passes straight to the next one waiting, so it never counts as free in between.
      if (next) next(releaser());
      else held--;
    };
  };
  return {
    get held() {
      return held;
    },
    get waiting() {
      return queue.length;
    },
    acquireSlot(timeoutMs) {
      if (held < size) {
        held++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve) => {
        const take = (release: ReleaseSlot) => {
          clearTimeout(timer);
          resolve(release);
        };
        const timer = setTimeout(() => {
          const at = queue.indexOf(take);
          if (at >= 0) queue.splice(at, 1);
          resolve(null);
        }, timeoutMs);
        queue.push(take);
      });
    },
  };
}

/** This machine's gate. */
export const searchSlots: SlotGate = createSlotGate(SEARCH_SLOTS);

/** A slot on this machine's gate, or null after `timeoutMs`. */
export const acquireSlot = (timeoutMs: number): Promise<ReleaseSlot | null> =>
  searchSlots.acquireSlot(timeoutMs);
