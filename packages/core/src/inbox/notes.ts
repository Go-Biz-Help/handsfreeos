/**
 * The notes the business writes about a customer, shown inside their conversation (M10 step 15).
 *
 * The phone put them in the thread first (step 14, finding 7): in a truck, the note that says "gate code 4821" belongs
 * where the texts are, not on another screen. Chris decided on 2026-09-17 to keep them there and let the web catch up,
 * so the merge and the words live here and both apps use them. A note is an `activity` of kind `note` on the customer,
 * so a customer with a text thread and an email thread sees their notes in both.
 */

export interface NoteEntry {
  readonly id: string;
  readonly body: string;
  readonly occurredAt: string;
  /** Who wrote it, or nothing for a note whose author has left. */
  readonly author: string | null;
  /** Written on this phone and not through yet. */
  readonly waiting: boolean;
}

/** Anything a thread puts in time order: a message, a call, or a note. */
export interface Dated {
  readonly id: string;
  readonly occurredAt: string;
}

export type ThreadPiece<I extends Dated> =
  | { readonly kind: 'item'; readonly at: string; readonly id: string; readonly item: I }
  | { readonly kind: 'note'; readonly at: string; readonly id: string; readonly note: NoteEntry };

/** A thread's messages and calls with the customer's notes folded in, oldest first, ties broken by id. */
export function threadWithNotes<I extends Dated>(
  items: readonly I[],
  notes: readonly NoteEntry[],
): ThreadPiece<I>[] {
  const pieces: ThreadPiece<I>[] = [
    ...items.map((item) => ({ kind: 'item' as const, at: item.occurredAt, id: item.id, item })),
    ...notes.map((note) => ({ kind: 'note' as const, at: note.occurredAt, id: note.id, note })),
  ];
  return pieces.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1));
}

/** "Dale added a note", or "A note" when nobody's name is left on it. */
export function noteHeading(note: Pick<NoteEntry, 'author'>): string {
  return note.author ? `${note.author} added a note` : 'A note';
}

/** The one line over a note in a thread: "Note · Dale · 9:24 AM", the phone's card and now the web's. */
export function noteLine(note: Pick<NoteEntry, 'author'>, time: string): string {
  return [`Note`, note.author, time].filter(Boolean).join(' · ');
}

export const THREAD_NOTE_WORDS = {
  /** What the ⋯ menu calls it, on both apps. */
  add: 'Add a note',
  /** Under a note written with no signal. */
  waiting: 'Waiting for signal',
  /** Why a note sits in a conversation at all. */
  explain: 'Only your team sees notes.',
} as const;
