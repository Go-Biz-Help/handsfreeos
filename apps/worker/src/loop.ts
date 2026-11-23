/**
 * One loop per queue, each on its own: a workflow step waiting minutes on the AI, or a slow import, holds up
 * its own queue and nothing else, so a text that came in still gets its reply. A loop that claimed a full batch
 * goes again straight away; one that found less waits for the next poll.
 *
 * A queue that is empty nearly always can also take a longer wait while nothing is happening (`idle`). The
 * migration queue asked once a second, all day, and found work one time in 3,500: that one question was a tenth
 * of everything the database did. It now asks every 30 seconds once a minute has gone by with nothing to claim,
 * and `wake()` brings it straight back the moment something is queued for it.
 */

export interface LoopOptions {
  /** A pass that claimed a full batch goes again at once. */
  readonly drain: boolean;
  /** After `afterMs` with nothing claimed, wait `everyMs` between passes instead of the usual poll. */
  readonly idle?: { readonly afterMs: number; readonly everyMs: number };
}

export interface LoopDeps {
  /** The usual wait between passes. */
  readonly pollMs: number;
  /** What a full batch is, for `drain`. */
  readonly batchSize: number;
  /** False once the worker is stopping: the loop ends after the pass it is in. */
  readonly running: () => boolean;
  readonly log: {
    info(stats: object, message: string): void;
    error(details: object, message: string): void;
  };
}

export interface Loop {
  /** Settles when the loop has ended. */
  readonly done: Promise<void>;
  /**
   * Look again now, and keep the usual pace for a while: something was just queued for this loop, or the worker
   * is stopping and must not sit out a long wait first.
   */
  wake(): void;
}

export function runLoop(
  name: string,
  pass: () => Promise<{ claimed: number }>,
  opts: LoopOptions,
  deps: LoopDeps,
): Loop {
  let endWait: (() => void) | null = null;
  // A wake that lands while a pass is running still counts: the wait after that pass is skipped.
  let woken = false;
  let busyAt = Date.now();

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        endWait = null;
        resolve();
      }
      endWait = done;
    });

  const done = (async () => {
    while (deps.running()) {
      let claimed = 0;
      woken = false;
      try {
        const stats = await pass();
        claimed = stats.claimed;
        if (claimed > 0) deps.log.info(stats, `${name} pass`);
      } catch (e) {
        deps.log.error({ err: e, loop: name }, 'worker pass crashed');
      }
      if (claimed > 0) busyAt = Date.now();
      if (!deps.running() || woken || (opts.drain && claimed >= deps.batchSize)) continue;
      const idle = opts.idle;
      await wait(idle && Date.now() - busyAt >= idle.afterMs ? idle.everyMs : deps.pollMs);
    }
  })();

  return {
    done,
    wake() {
      woken = true;
      busyAt = Date.now();
      endWait?.();
    },
  };
}
