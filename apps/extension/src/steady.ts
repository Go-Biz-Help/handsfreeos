/**
 * Waiting in a page that may sit in a window Chrome hides (docs/socialcontent.md, "Posting"; apps/extension/README.md,
 * "Posts on time with the posting window behind yours (0.146.0)").
 *
 * Chrome slows a page's timers while its window is hidden behind others: to once a second, and once it has been hidden
 * five minutes, to once a minute. AI Social Media Content Creator puts posts up from a window of its own beside the
 * person's, mostly hidden while they work, and its hands counted their waits in looks (90 seconds as 225 looks of
 * 400 ms). Once Chrome woke the page once a minute, a Facebook Page post's 90-second wait for Business Suite could take
 * nearly four hours, and every post due after it waited behind it (the owner's 12 PM posts of 16 Nov 2026 went up at
 * 1:52 PM, behind a Facebook post that took 1 hour 50 minutes).
 *
 * - `pause`: its own timer, and, while the page is hidden in the posting window, the background's as well (`hfos-wake`,
 *   which Chrome doesn't slow), whichever comes first. Anywhere else (or in a test) only its own timer.
 * - `waitFor`, `within`: wait by the clock, never by how many looks they took, so a wait is never longer than it says
 *   by more than one slowed look.
 */

/** The note a hidden page sends the background to be woken after a while, and the longest it's woken after. */
export const WAKE_NOTE = 'hfos-wake';
export const WAKE_MOST_MS = 180_000;

interface Runtime {
  readonly id?: string;
  sendMessage(message: unknown): Promise<unknown>;
}

/** The extension's messaging, in its own part of a page; null elsewhere (a page's own world, a test). */
function runtimeHere(): Runtime | null {
  const runtime = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  return runtime?.id && typeof runtime.sendMessage === 'function' ? runtime : null;
}

/** Whether Chrome hides the page the code runs in: its timers are slowed then. */
function hiddenHere(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc?.visibilityState === 'hidden';
}

/** Waits `ms`: its own timer, or the background's while the page is hidden, whichever wakes it first. */
export function pause(ms: number): Promise<void> {
  return new Promise((done) => {
    let woken = false;
    const wake = () => {
      if (woken) return;
      woken = true;
      done();
    };
    setTimeout(wake, ms);
    const runtime = ms > 0 && hiddenHere() ? runtimeHere() : null;
    if (!runtime) return;
    try {
      runtime.sendMessage({ type: WAKE_NOTE, ms: Math.min(ms, WAKE_MOST_MS) }).then(
        (answer) => {
          if ((answer as { ok?: unknown } | undefined)?.ok === true) wake();
        },
        () => undefined,
      );
    } catch {
      // Its own timer wakes it.
    }
  });
}

/** How long the background waits before waking a page that asked (`WAKE_NOTE`): what it asked, within reason. */
export function wakeAfter(message: unknown): number {
  const ms = Number((message as { ms?: unknown } | null)?.ms);
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), WAKE_MOST_MS) : 0;
}

/** Waits up to `ms` by the clock for `find` to find something, looking each `lookMs`. Null when it didn't. */
export async function waitFor<T>(
  find: () => T | null,
  ms: number,
  lookMs: number,
): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() >= until) return null;
    await pause(lookMs);
  }
}

/** Waits up to `ms` by the clock for `ready`, looking each `lookMs`; whether it was ready. */
export async function within(ms: number, ready: () => boolean, lookMs: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ready()) return true;
    await pause(lookMs);
  }
  return ready();
}
