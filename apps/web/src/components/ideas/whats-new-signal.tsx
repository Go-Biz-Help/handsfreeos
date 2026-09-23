'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Whether What's new has something this person has not read: a dot beside Ideas in the menu and on the What's
 * new tab. Asked once when the app opens, again when the tab comes back after a while, and put out the moment
 * they open What's new. A dot is never worth an error, so a failed ask just shows none.
 */
const ASK_AGAIN_MS = 10 * 60 * 1000;
let unseen = 0;
let askedAt = 0;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

async function ask(): Promise<void> {
  if (Date.now() - askedAt < ASK_AGAIN_MS) return;
  askedAt = Date.now();
  try {
    const out = unwrap(await apiBrowser().POST('/v1/queries/whats_new.unseen', { body: {} }));
    unseen = out.unseen;
    tell();
  } catch {
    // Nothing to show is the right answer to not knowing.
  }
}

/** They have read it: the dot goes out everywhere at once. */
export function whatsNewRead(): void {
  unseen = 0;
  askedAt = Date.now();
  tell();
}

export function useWhatsNewUnseen(): number {
  useEffect(() => {
    void ask();
    const again = () => void ask();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => unseen,
    () => 0,
  );
}

/** The dot itself. */
export function NewDot({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="whats-new-dot"
      title={`${count} new in What’s new`}
      className={cn('inline-block h-2 w-2 flex-none rounded-full bg-accent', className)}
    >
      <span className="sr-only">{count} new in What’s new</span>
    </span>
  );
}
