import * as React from 'react';
import { AppState } from 'react-native';

import { api, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * Whether What's new has something this person hasn't read: "New" beside Ideas in More, and on the What's new tab.
 * Asked when More shows, again when the app comes back after a while, and put out the moment they open What's new.
 * A dot is never worth an error, so a failed ask shows none. It is the person's, so another person signing in on the
 * same phone starts from nothing.
 */
const ASK_AGAIN_MS = 10 * 60 * 1000;

let state = { userId: '', unseen: 0, askedAt: 0 };
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

async function ask(userId: string): Promise<void> {
  if (state.userId !== userId) state = { userId, unseen: 0, askedAt: 0 };
  if (Date.now() - state.askedAt < ASK_AGAIN_MS) return;
  state = { ...state, askedAt: Date.now() };
  try {
    const out = unwrap(await api.POST('/v1/queries/whats_new.unseen', { body: {} }));
    // Somebody else signed in while it was in the air: theirs is asked for separately.
    if (state.userId !== userId) return;
    state = { ...state, unseen: out.unseen };
    tell();
  } catch {
    // Nothing to show is the right answer to not knowing; the next ask can try again.
    if (state.userId === userId) state = { ...state, askedAt: 0 };
  }
}

/** They have read it: "New" goes out everywhere at once. */
export function whatsNewRead(): void {
  state = { ...state, unseen: 0, askedAt: Date.now() };
  tell();
}

/** Starts again from nothing (the tests). */
export function forgetWhatsNewSignal(): void {
  state = { userId: '', unseen: 0, askedAt: 0 };
  tell();
}

/** How many What's new entries this person hasn't read, asking when there's signal and the app comes back. */
export function useWhatsNewUnseen(userId: string): number {
  const { online } = useNetwork();
  React.useEffect(() => {
    if (online) void ask(userId);
  }, [online, userId]);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void ask(userId);
    });
    return () => sub.remove();
  }, [userId]);
  const unseen = React.useSyncExternalStore(
    subscribe,
    () => (state.userId === userId ? state.unseen : 0),
    () => 0,
  );
  return unseen;
}
