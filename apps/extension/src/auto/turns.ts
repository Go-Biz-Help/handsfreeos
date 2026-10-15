/**
 * Whose turn it is on each network (docs/outreach.md, decision 43; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "One runner, one turn"): on one network, the runner that works on its own (./run.ts) and what the person asked of
 * the extension from HandsFreeOS (../asks/run.ts) take turns, one at a time, in the order they asked, so the extension
 * never works two windows on one network at once. Each network has its own line: a LinkedIn ask never waits on
 * Facebook's runner, or on a Facebook step handed to the person, and the reverse. The runner gives way: before a step,
 * when an ask holds its network's turn, it waits a couple of minutes and says why. Facebook's line when none is named.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';

export type TurnTaker = 'runner' | 'ask';

interface Line {
  chain: Promise<unknown>;
  held: TurnTaker | null;
  queued: number;
  waitingAsks: number;
}

const lines = new Map<Platform, Line>();

function lineOf(platform: Platform): Line {
  let line = lines.get(platform);
  if (!line) {
    line = { chain: Promise.resolve(), held: null, queued: 0, waitingAsks: 0 };
    lines.set(platform, line);
  }
  return line;
}

/** Who's working on a network now: null when nobody is. */
export const turnHeldBy = (platform: Platform = 'facebook'): TurnTaker | null =>
  lineOf(platform).held;

/** Whether an ask holds a network's turn or waits for it: the runner there gives way. */
export const askInLine = (platform: Platform = 'facebook'): boolean => {
  const line = lineOf(platform);
  return line.held === 'ask' || line.waitingAsks > 0;
};

/** Does `work` in its turn on its network, after whatever was asked there before it; a failure doesn't hold up the next. */
export function inTurn<T>(
  who: TurnTaker,
  work: () => Promise<T>,
  platform: Platform = 'facebook',
): Promise<T> {
  const line = lineOf(platform);
  line.queued++;
  if (who === 'ask') line.waitingAsks++;
  const go = line.chain.then(async () => {
    if (who === 'ask') line.waitingAsks--;
    line.held = who;
    try {
      return await work();
    } finally {
      line.held = null;
      line.queued--;
    }
  });
  line.chain = go.catch(() => undefined);
  return go;
}

/** How many wait for or hold a network's turn (every network's, with none named): for tests. */
export const turnsQueued = (platform?: Platform): number =>
  platform
    ? lineOf(platform).queued
    : [...lines.values()].reduce((sum, line) => sum + line.queued, 0);
