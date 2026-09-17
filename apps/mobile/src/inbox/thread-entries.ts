import { dayDivider, dayKey, type ThreadItemShape } from '@hfos/core';

import type { PendingReply } from './outbox';

/**
 * A conversation's thread as the phone draws it, oldest first: a divider where the day changes, then its messages,
 * calls and the notes the business wrote about the customer, and the replies written on this phone that haven't come
 * back from HandsFreeOS yet (always last, in the order they were written). The screen shows the list newest at the
 * bottom.
 */

/** A note about the customer (the web keeps notes on the customer's timeline; the phone shows them in the thread). */
export interface NoteEntry {
  readonly id: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly author: string | null;
  /** Added on this phone and not through yet. */
  readonly waiting: boolean;
}

export type ThreadEntry =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'item'; readonly key: string; readonly item: ThreadItemShape }
  | { readonly kind: 'note'; readonly key: string; readonly note: NoteEntry }
  | { readonly kind: 'pending'; readonly key: string; readonly reply: PendingReply };

export function threadEntries(
  items: readonly ThreadItemShape[],
  notes: readonly NoteEntry[],
  pending: readonly PendingReply[],
  now = new Date(),
): ThreadEntry[] {
  const dated: ({ at: string; id: string } & (
    { kind: 'item'; item: ThreadItemShape } | { kind: 'note'; note: NoteEntry }
  ))[] = [
    ...items.map((item) => ({ at: item.occurredAt, id: item.id, kind: 'item' as const, item })),
    ...notes.map((note) => ({ at: note.occurredAt, id: note.id, kind: 'note' as const, note })),
  ].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1));

  const out: ThreadEntry[] = [];
  let day: string | null = null;
  const divider = (iso: string) => {
    const key = dayKey(iso);
    if (key === day) return;
    day = key;
    out.push({ kind: 'day', key: `day-${key}`, label: dayDivider(iso, now) });
  };
  for (const d of dated) {
    divider(d.at);
    if (d.kind === 'item') out.push({ kind: 'item', key: `item-${d.id}`, item: d.item });
    else out.push({ kind: 'note', key: `note-${d.id}`, note: d.note });
  }
  for (const reply of pending) {
    divider(reply.row.made_at);
    out.push({ kind: 'pending', key: `pending-${reply.row.id}`, reply });
  }
  return out;
}

/** A synced note, with its author's name. */
export interface NoteRow {
  readonly id: string;
  readonly body: string | null;
  readonly occurred_at: string | null;
  readonly created_at: string | null;
  readonly author_name: string | null;
}

export function noteOf(row: NoteRow): NoteEntry {
  return {
    id: row.id,
    body: row.body ?? '',
    occurredAt: new Date(row.occurred_at ?? row.created_at ?? 0).toISOString(),
    author: row.author_name,
    waiting: false,
  };
}
