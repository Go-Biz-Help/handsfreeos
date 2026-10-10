/**
 * Whose turn it is on Facebook (docs/outreach.md, decision 43): the runner that works on its own (./run.ts) and what
 * the person asked of the extension from HandsFreeOS (../asks/run.ts) take turns, one at a time, in the order they
 * asked, so the extension never works two windows on Facebook at once. The runner gives way: before a step, when an ask
 * holds the turn, it waits a couple of minutes and says why.
 */
export type TurnTaker = 'runner' | 'ask';

let chain: Promise<unknown> = Promise.resolve();
let held: TurnTaker | null = null;
let queued = 0;
const waitingAsks = { n: 0 };

/** Who's working on Facebook now: null when nobody is. */
export const turnHeldBy = (): TurnTaker | null => held;

/** Whether an ask holds the turn or waits for it: the runner gives way. */
export const askInLine = (): boolean => held === 'ask' || waitingAsks.n > 0;

/** Does `work` in its turn, after whatever was asked before it; a failure doesn't hold up the next. */
export function inTurn<T>(who: TurnTaker, work: () => Promise<T>): Promise<T> {
  queued++;
  if (who === 'ask') waitingAsks.n++;
  const go = chain.then(async () => {
    if (who === 'ask') waitingAsks.n--;
    held = who;
    try {
      return await work();
    } finally {
      held = null;
      queued--;
    }
  });
  chain = go.catch(() => undefined);
  return go;
}

/** How many wait for or hold the turn: for tests. */
export const turnsQueued = (): number => queued;
