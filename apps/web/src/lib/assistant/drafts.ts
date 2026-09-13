'use client';
import { useSyncExternalStore } from 'react';

/** A draft the Assistant hands to a conversation's own composer (Edit on a text or email card). */
export interface ComposerDraft {
  /** New with each hand-off, so the composer starts over with it. */
  readonly id: string;
  readonly text: string;
  readonly subject?: string;
  /** Once the person sends their version. */
  readonly onSent?: () => void;
}

const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export function handDraft(conversationId: string, draft: Omit<ComposerDraft, 'id'>): void {
  drafts.set(conversationId, { ...draft, id: crypto.randomUUID() });
  notify();
}

export function dropDraft(conversationId: string): void {
  if (drafts.delete(conversationId)) notify();
}

/** The draft waiting for this conversation's composer, if any. */
export function useComposerDraft(conversationId: string): ComposerDraft | null {
  return useSyncExternalStore(
    subscribe,
    () => drafts.get(conversationId) ?? null,
    () => null,
  );
}
