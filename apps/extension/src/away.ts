/**
 * Whether the person is away from their computer (docs/outreach.md, decision 120): no key pressed and the mouse not
 * moved for two minutes, as Chrome's idle state says. Only then does a read that needs the screen bring its window in
 * front (src/tab.ts), and it steps back the moment they're back. A locked screen isn't away for this, and nor is one
 * that stayed dark once its window came in front: Chrome draws nothing on either.
 */

/** How long without a key or the mouse before the person counts as away. */
export const AWAY_SECONDS = 120;

/** When a window that came in front still wasn't drawn: the screen asleep. Away again only after they're back. */
let darkAt: number | null = null;

/** Chrome's idle state, when this browser has it (Safari's may not). */
const idle = () => (typeof chrome === 'undefined' ? undefined : chrome.idle);

/**
 * Whether they're away now. A browser without Chrome's idle state counts them away, as every build before 0.109.0
 * did, so its reads still come in front.
 */
export async function awayNow(): Promise<boolean> {
  const api = idle();
  if (!api?.queryState) return true;
  const state = await api.queryState(AWAY_SECONDS).catch(() => 'active' as const);
  if (state !== 'idle') {
    if (state === 'active') darkAt = null;
    return false;
  }
  if (darkAt === null) return true;
  // A key or the mouse since the screen was dark: they came back and went again, so it's lit.
  const since = Math.max(15, Math.ceil((Date.now() - darkAt) / 1000));
  const lately = await api.queryState(since).catch(() => 'idle' as const);
  if (lately !== 'active') return false;
  darkAt = null;
  return true;
}

/** Notes that a window brought in front still wasn't drawn: their screen is asleep or locked. */
export const markDark = (): void => void (darkAt = Date.now());

/** Calls `back` the moment they're back at their computer; returns what stops listening. */
export function onBack(back: () => void): () => void {
  const api = idle();
  if (!api?.onStateChanged) return () => undefined;
  api.setDetectionInterval?.(AWAY_SECONDS);
  const heard = (state: string) => {
    if (state !== 'active') return;
    darkAt = null;
    back();
  };
  api.onStateChanged.addListener(heard);
  return () => api.onStateChanged.removeListener(heard);
}

/** What an ask says while a read that needs the screen waits for the person to be away. */
export const AWAY_WAIT_LINE =
  'Waiting till you’ve been away from your computer for 2 minutes. This part needs its window on screen, and it won’t pull it over your work.';

/**
 * A read that needs the screen, put off as the person isn't away, or came back while it read (decision 120): the
 * runner comes back to it later, and an ask the person stopped while it waited ends with it.
 */
export class NotAway extends Error {
  constructor() {
    super(AWAY_WAIT_LINE);
    this.name = 'NotAway';
  }
}

/** What a read waiting for the person to be away says meanwhile, and whether it was stopped. */
export interface Hold {
  say(line: string): void;
  stopped(): boolean;
}
