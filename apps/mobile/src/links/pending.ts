import { useSyncExternalStore } from 'react';

/**
 * A link waiting to open: one that arrived while nobody was signed in, the app was locked, or the person's copy was
 * still opening (a notification tapped on a locked phone, an email's link before signing in). The app opens it as soon
 * as it can show it (`components/links/link-gate.tsx`); a newer link replaces an older one.
 *
 * Also the question to ask once a link has opened: a notification button whose change asks something first (quiet
 * hours, "Still send?") opens the conversation and asks there.
 */

export interface PendingLink {
  /** The web path or address, as it arrived. */
  readonly link: string;
  readonly at: number;
}

let pending: PendingLink | null = null;
let askAbout: string | null = null;
let unlockToRun = false;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

export const pendingLinks = {
  /** Keeps a link to open once the app can show it. */
  open(link: string, at = Date.now()): void {
    pending = { link, at };
    publish();
  },
  current: (): PendingLink | null => pending,
  /** Takes the link to open now, so it opens once. */
  take(): PendingLink | null {
    const value = pending;
    pending = null;
    if (value) publish();
    return value;
  },
  /** Asks about a change (its "Still send?" or quiet-hours question) once the screen it opened shows. */
  ask(changeId: string): void {
    askAbout = changeId;
    publish();
  },
  asking: (): string | null => askAbout,
  takeAsk(): string | null {
    const value = askAbout;
    askAbout = null;
    if (value) publish();
    return value;
  },
  /** The app was opened to run a notification's button that waited for the phone to be unlocked. */
  unlockToRun(): void {
    unlockToRun = true;
    publish();
  },
  wantsUnlock: (): boolean => unlockToRun,
  takeUnlock(): boolean {
    const value = unlockToRun;
    unlockToRun = false;
    if (value) publish();
    return value;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePendingLink(): PendingLink | null {
  return useSyncExternalStore(pendingLinks.subscribe, pendingLinks.current, pendingLinks.current);
}

export function useUnlockToRun(): boolean {
  return useSyncExternalStore(
    pendingLinks.subscribe,
    pendingLinks.wantsUnlock,
    pendingLinks.wantsUnlock,
  );
}

export function usePendingAsk(): string | null {
  return useSyncExternalStore(pendingLinks.subscribe, pendingLinks.asking, pendingLinks.asking);
}
