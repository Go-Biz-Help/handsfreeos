import { describe, heldWords, type ChangeWords, type NameBook } from './describe';
import type { OutboxRow } from './outbox';
import type { PhotoRow } from './photos';
import { isStale, parseIds, SENT_SHOWN_MS } from './rules';

/**
 * Changes on this phone, as the canvas lists them: **Needs you** (a question to answer, or a refusal to fix), **Waiting**
 * (on its way, held behind another change, a photo uploading on its own, or set aside to try again), and **Sent just
 * now** (grouped by customer: "3 changes for Maria Lopez · Number and email · a note · moved to Won").
 */

export type AskKind = 'still-send' | 'quiet-hours' | 'other';

export interface ChangeItem {
  readonly row: OutboxRow;
  readonly photo: PhotoRow | null;
  readonly words: ChangeWords;
  /** The question it waits on, for changes that need the person. */
  readonly ask: AskKind | null;
  /** Why it's held, in words, for held changes. */
  readonly held: string | null;
}

export interface SentGroup {
  readonly key: string;
  readonly title: string;
  readonly line: string;
  readonly count: number;
  readonly lastSentAt: number;
}

export interface ChangeList {
  readonly needsYou: readonly ChangeItem[];
  readonly waiting: readonly ChangeItem[];
  readonly sent: readonly SentGroup[];
  /** Changes not through yet. */
  readonly unsent: number;
}

/** Which question an asked (or waiting and already too old) change needs answered. */
export function askOf(row: OutboxRow, now: number): AskKind | null {
  if (row.state === 'ask') {
    if (row.rule === 'quiet_hours') return 'quiet-hours';
    if (row.rule === 'stale_action') return 'still-send';
    return 'other';
  }
  // Waiting for signal, and already older than it may go on its own: the person can answer before it's reached.
  if (
    row.state === 'waiting' &&
    row.track === 'queue' &&
    isStale({
      name: row.name,
      madeAt: Date.parse(row.made_at),
      confirmedAt: row.confirmed_at ? Date.parse(row.confirmed_at) : null,
      now,
    })
  )
    return 'still-send';
  return null;
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function listChanges(input: {
  readonly rows: readonly OutboxRow[];
  readonly photos: readonly PhotoRow[];
  readonly names: NameBook;
  readonly now: number;
}): ChangeList {
  const { rows, names, now } = input;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const photos = new Map(input.photos.map((photo) => [photo.id, photo]));
  const needsYou: ChangeItem[] = [];
  const waiting: ChangeItem[] = [];
  const sentRows: { row: OutboxRow; words: ChangeWords; at: number }[] = [];
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  for (const row of ordered) {
    const words = describe(row, names);
    if (row.state === 'sent') {
      const at = row.sent_at ? Date.parse(row.sent_at) : 0;
      if (now - at <= SENT_SHOWN_MS) sentRows.push({ row, words, at });
      continue;
    }
    const ask = row.state === 'refused' ? null : askOf(row, now);
    const held =
      row.state === 'held'
        ? heldWords(
            parseIds(row.depends_on)
              .map((id) => byId.get(id) ?? null)
              .filter((dep) => dep === null || dep.state !== 'sent')
              .map((dep) => ({ words: dep ? describe(dep, names) : null })),
          )
        : null;
    const item: ChangeItem = { row, photo: photos.get(row.id) ?? null, words, ask, held };
    if (row.state === 'refused' || ask !== null) needsYou.push(item);
    else waiting.push(item);
  }

  const groups = new Map<string, { title: string; parts: string[]; count: number; last: number }>();
  for (const { row, words, at } of sentRows) {
    const key = words.about?.key ?? row.id;
    const group = groups.get(key) ?? { title: '', parts: [], count: 0, last: 0 };
    group.count += 1;
    group.parts.push(words.part);
    group.last = Math.max(group.last, at);
    group.title =
      group.count === 1
        ? words.title
        : `${group.count} changes for ${words.about?.name ?? 'a customer'}`;
    groups.set(key, group);
  }
  const sent = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      title: g.title,
      line: capital([...new Set(g.parts)].join(' · ')),
      count: g.count,
      lastSentAt: g.last,
    }))
    .sort((a, b) => b.lastSentAt - a.lastSentAt);

  return { needsYou, waiting, sent, unsent: needsYou.length + waiting.length };
}

/** "1.6 of 2.4 MB". */
export function megabytes(sent: number, total: number): string {
  const mb = (bytes: number) => (Math.round(Math.max(0, bytes) / 100_000) / 10).toFixed(1);
  return `${mb(sent)} of ${mb(total)} MB`;
}
