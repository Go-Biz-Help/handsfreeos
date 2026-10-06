import type { KeptFiles } from './kept-files';

/**
 * The open person's store of files (`kept-files.ts`), opened and closed with their copy (`phone-copy.ts`). Keeping a
 * photo, uploading it and opening a document all go through here, so none of them can reach another person's.
 */

export interface OpenKeptFiles {
  readonly files: KeptFiles;
  close(): void;
}

/** Nothing can be kept while the person's copy isn't open (it's opening, or this phone can't keep one). */
export class NoKeptFiles extends Error {
  constructor() {
    super('This phone’s copy isn’t open yet, so it can’t keep a file. Try again in a moment.');
  }
}

type Listener = () => void;

let open: { readonly userId: string; readonly store: OpenKeptFiles } | null = null;
const listeners = new Set<Listener>();
const tell = () => {
  for (const listener of listeners) listener();
};

export const keptStore = {
  opened(userId: string, store: OpenKeptFiles): void {
    open = { userId, store };
    tell();
  },

  /** The copy is closing: after signing out, the documents go even when the copy stays for changes still waiting. */
  closing(signedOut: boolean): void {
    if (!open) return;
    const { store } = open;
    open = null;
    try {
      if (signedOut) store.files.removeKind('document');
    } finally {
      store.close();
      tell();
    }
  },

  /** The person's store, or null when it isn't open. */
  current(userId?: string | null): KeptFiles | null {
    if (!open || (userId && open.userId !== userId)) return null;
    return open.store.files;
  },

  /** The person's store, for keeping or reading a file now. */
  of(userId: string): KeptFiles {
    const files = keptStore.current(userId);
    if (!files) throw new NoKeptFiles();
    return files;
  },

  /** Whose store is open. */
  userId(): string | null {
    return open?.userId ?? null;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
