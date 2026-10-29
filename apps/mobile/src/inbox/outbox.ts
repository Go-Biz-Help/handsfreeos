import { richSummary, type ConversationFolderValue, type ConversationShape } from '@hfos/core';

import type { OutboxRow, SqlRunner } from '@/changes/outbox';
import { isStale } from '@/changes/rules';

/**
 * The inbox's changes on this phone, over the synced rows (the plan's "screens show outbox items over the synced
 * data"): a conversation closed, snoozed, assigned or taken over here shows that way until the server's own row
 * arrives, even while the change waits for signal or is set aside to try again; a reply written here shows in the
 * thread until the server's copy of it arrives, with where it stands.
 */

type Input = Record<string, unknown>;

export function inputOf(row: Pick<OutboxRow, 'input'>): Input {
  try {
    const value: unknown = JSON.parse(row.input);
    return value && typeof value === 'object' ? (value as Input) : {};
  } catch {
    return {};
  }
}

/** A change that still stands in for the server's row: made here, and neither refused nor through yet. */
export const stillStanding = (row: Pick<OutboxRow, 'state'>): boolean =>
  row.state !== 'sent' && row.state !== 'refused';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

type RichParts = Parameters<typeof richSummary>[0];

/** A text's buttons, card or carousel (RCS, 0103) in a few words — "3 buttons", "Card", "Carousel of 2" — from what the change sends. */
function extrasOf(rich: unknown): string | null {
  if (!rich || typeof rich !== 'object') return null;
  const r = rich as { kind?: unknown; buttons?: unknown; cards?: unknown };
  if (r.kind !== 'buttons' && r.kind !== 'card' && r.kind !== 'carousel') return null;
  return richSummary({
    kind: r.kind,
    buttons: (Array.isArray(r.buttons) ? r.buttons : []) as RichParts['buttons'],
    cards: (Array.isArray(r.cards) ? r.cards : []) as RichParts['cards'],
  });
}

/**
 * A conversation as this phone's own changes leave it, in the order they were made: closed, snoozed, reopened,
 * assigned, read, taken over or handed to the AI teammate, and a reply sent (which opens it, answers the customer and,
 * like any person's reply, takes it from the teammate).
 */
export function withOwnChanges(
  c: ConversationShape,
  rows: readonly OutboxRow[],
  me: { readonly id: string; readonly fullName: string },
  names: ReadonlyMap<string, string> = new Map(),
): ConversationShape {
  let out = c;
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (!stillStanding(row)) continue;
    const input = inputOf(row);
    if (row.name === 'message.send') {
      if (str(input.conversationId) !== c.id || input.sendAfterQuietHours === true) continue;
      const body = str(input.body) ?? '';
      out = {
        ...out,
        status: 'open',
        snoozedUntil: null,
        lastMessageAt: row.made_at > (out.lastMessageAt ?? '') ? row.made_at : out.lastMessageAt,
        lastPreview: body || out.lastPreview,
        lastDirection: 'outbound',
        lastSentBy: me,
        awaitingReplySince: null,
        ...(out.handledBy === 'ai' || out.needsPersonSince
          ? { handledBy: 'person' as const, needsPersonSince: null, takenOverBy: me }
          : {}),
      };
      continue;
    }
    if (str(input.conversationId) !== c.id) continue;
    switch (row.name) {
      case 'conversation.close':
        out = { ...out, status: 'closed', snoozedUntil: null };
        break;
      case 'conversation.snooze':
        out = { ...out, status: 'snoozed', snoozedUntil: str(input.until) };
        break;
      case 'conversation.reopen':
        out = { ...out, status: 'open', snoozedUntil: null };
        break;
      case 'conversation.assign': {
        const id = str(input.assigneeUserId);
        out = {
          ...out,
          assignee: id ? { id, fullName: names.get(id) ?? out.assignee?.fullName ?? '' } : null,
        };
        break;
      }
      case 'conversation.mark_read':
        out = { ...out, unreadCount: 0 };
        break;
      case 'conversation.mark_unread':
        out = { ...out, unreadCount: Math.max(1, out.unreadCount) };
        break;
      case 'conversation.take_over':
        out = { ...out, handledBy: 'person', needsPersonSince: null, takenOverBy: me };
        break;
      case 'conversation.hand_to_ai':
        out = { ...out, handledBy: 'ai', needsPersonSince: null, takenOverBy: null };
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Email threads moved between the Inbox, Other mail and Spam, or shared with the team, on this phone (M19). Both are
 * online commands, so no change waits in the outbox to stand in for the server's row, and a thread just moved to Spam
 * would stay in the Inbox for the moment the synced row takes to arrive. Each stands until the synced row agrees, or
 * for a minute at most, since someone may have moved it again since. One shared straight onto a customer (its sender
 * added or linked from it) is theirs at once too.
 */
interface MovedHere {
  readonly folder?: ConversationFolderValue;
  readonly shared?: boolean;
  readonly person?: { readonly id: string; readonly fullName: string };
  readonly at: number;
}
const movedHere = new Map<string, MovedHere>();
const movedListeners = new Set<() => void>();
let movedVersion = 0;
const MOVED_STANDS_MS = 60_000;

/** A thread moved or shared here: the list and the thread show it so at once. */
export function markMovedHere(
  conversationId: string,
  moved: Omit<MovedHere, 'at'>,
  now = Date.now(),
): void {
  movedHere.set(conversationId, { ...movedHere.get(conversationId), ...moved, at: now });
  movedVersion += 1;
  for (const listener of movedListeners) listener();
}

/** For `useSyncExternalStore`: hears of each move or share made here. */
export function subscribeMovedHere(listener: () => void): () => void {
  movedListeners.add(listener);
  return () => movedListeners.delete(listener);
}

/** Changes whenever a thread is moved or shared here; only ever compared. */
export const movedHereVersion = (): number => movedVersion;

/** Tests: start again with nothing moved. */
export function forgetMovedHere(): void {
  movedHere.clear();
  movedVersion += 1;
}

/** A conversation as a move or share made here leaves it, until the synced row says the same. */
export function withMovedHere(c: ConversationShape, now = Date.now()): ConversationShape {
  const moved = movedHere.get(c.id);
  if (!moved) return c;
  const agrees =
    (!moved.folder || c.folder === moved.folder) &&
    (!moved.shared || c.privateTo === null) &&
    (!moved.person || c.person?.id === moved.person.id);
  if (agrees || now - moved.at > MOVED_STANDS_MS) {
    movedHere.delete(c.id);
    return c;
  }
  return {
    ...c,
    ...(moved.folder ? { folder: moved.folder } : {}),
    ...(moved.shared ? { privateTo: null, private: false } : {}),
    ...(moved.person ? { person: moved.person } : {}),
  };
}

/** The customer a thread was just shared onto here, until the synced row says so: whose details the thread shows. */
export function movedPersonOf(conversationId: string, now = Date.now()): string | null {
  const moved = movedHere.get(conversationId);
  return moved?.person && now - moved.at <= MOVED_STANDS_MS ? moved.person.id : null;
}

/** Where a reply written on this phone stands, for the words under it. */
export type ReplyStage =
  /** On its way: signal, and its turn has come. */
  | 'sending'
  /** No signal yet, and still fresh: it goes on its own by `goesBy`. */
  | 'waiting'
  /** Waiting for its photos to upload. */
  | 'photo'
  /** Older than 30 minutes with no signal, or the API asked: "Still send?". */
  | 'still-send'
  /** It would go inside quiet hours: "Send now, or at 8:00 AM when quiet hours end?". */
  | 'quiet-hours'
  /** HandsFreeOS asked something else first. */
  | 'ask'
  /** Couldn't get through, so it's set aside and goes again soon. */
  | 'retry'
  /** HandsFreeOS said no, and why. */
  | 'refused'
  /** Through: waiting for the server's copy to reach the phone. */
  | 'sent';

export interface PendingReply {
  readonly row: OutboxRow;
  readonly stage: ReplyStage;
  readonly body: string;
  readonly channel: 'sms' | 'email' | 'chat' | 'portal' | 'messenger' | 'instagram';
  readonly subject: string | null;
  /** The photos it carries, by file id. */
  readonly fileIds: readonly string[];
  /** What goes with the words, in a few words ("3 buttons"), for a text with buttons, a card or a carousel. */
  readonly extras: string | null;
  readonly clientId: string | null;
  /** When a fresh reply stops going on its own ("sends by 10:42 AM"). */
  readonly goesBy: number;
}

const FRESH_MS = 30 * 60_000;

export function replyStage(row: OutboxRow, online: boolean, now: number): ReplyStage {
  switch (row.state) {
    case 'sent':
      return 'sent';
    case 'refused':
      return 'refused';
    case 'held':
      // Waiting for its photos: with no signal, what matters is signal, and when it goes by.
      return online ? 'photo' : 'waiting';
    case 'retry':
      return 'retry';
    case 'ask':
      return row.rule === 'quiet_hours'
        ? 'quiet-hours'
        : row.rule === 'stale_action'
          ? 'still-send'
          : 'ask';
    case 'sending':
      return 'sending';
    default: {
      const stale = isStale({
        name: row.name,
        madeAt: Date.parse(row.made_at),
        confirmedAt: row.confirmed_at ? Date.parse(row.confirmed_at) : null,
        now,
      });
      if (stale && !online) return 'still-send';
      return online ? 'sending' : 'waiting';
    }
  }
}

/**
 * The replies written on this phone for a conversation that the thread shows itself, oldest first: every one not
 * through, and one through whose server copy hasn't reached the phone yet (matched by its client id).
 */
export function pendingReplies(
  rows: readonly OutboxRow[],
  conversationId: string,
  arrivedClientIds: ReadonlySet<string>,
  online: boolean,
  now: number,
): PendingReply[] {
  const out: PendingReply[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.name !== 'message.send') continue;
    const input = inputOf(row);
    if (str(input.conversationId) !== conversationId) continue;
    const clientId = str(input.clientId);
    if (clientId && arrivedClientIds.has(clientId)) continue;
    // A reply that went through without a client id (a notification's Reply) can't be matched: HandsFreeOS's own copy
    // is in the thread by then, so it isn't shown twice.
    if (row.state === 'sent' && !clientId) continue;
    // A text sent to wait for quiet hours shows as the server's held text once it arrives.
    if (row.state === 'sent' && input.sendAfterQuietHours === true) continue;
    const channel =
      input.channel === 'email' ||
      input.channel === 'chat' ||
      input.channel === 'portal' ||
      input.channel === 'messenger' ||
      input.channel === 'instagram'
        ? input.channel
        : 'sms';
    out.push({
      row,
      stage: replyStage(row, online, now),
      body: str(input.body) ?? '',
      channel,
      subject: str(input.subject),
      fileIds: Array.isArray(input.attachmentFileIds)
        ? input.attachmentFileIds.filter((id): id is string => typeof id === 'string')
        : [],
      extras: channel === 'sms' ? extrasOf(input.rich) : null,
      clientId,
      goesBy: Date.parse(row.made_at) + FRESH_MS,
    });
  }
  return out;
}

/**
 * Cancel on a held text, on this phone's copy at once, as message.cancel_scheduled does it: a new text never went, so
 * it leaves the thread; a failed text tried again in quiet hours goes back as it was (`failed_attempt`), not delivered,
 * with its reason and at its time. Says whether it stays, for the words.
 */
export async function cancelHeldHere(tx: SqlRunner, messageId: string): Promise<boolean> {
  const m = await tx.getOptional<{ failed_attempt: string | null }>(
    'SELECT failed_attempt FROM messages WHERE id = ?',
    [messageId],
  );
  const was = attemptOf(m?.failed_attempt ?? null);
  if (!was) {
    await tx.execute("UPDATE messages SET error_code = 'cancelled' WHERE id = ?", [messageId]);
    return false;
  }
  await tx.execute(
    'UPDATE messages SET status = ?, error_code = ?, error_message = ?, occurred_at = ?, failed_attempt = NULL WHERE id = ?',
    [was.status, was.errorCode, was.errorMessage, was.occurredAt, messageId],
  );
  return true;
}

/** How a failed text stood before it was tried again in quiet hours, from its synced `failed_attempt`. */
function attemptOf(json: string | null) {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const status = str(v.status);
    const occurredAt = str(v.occurredAt);
    if (!status || !occurredAt) return null;
    return { status, errorCode: str(v.errorCode), errorMessage: str(v.errorMessage), occurredAt };
  } catch {
    return null;
  }
}

/**
 * Held texts this phone cancelled, while the cancel is on its way: the thread leaves them out at once. (A failed text
 * tried again isn't held any more once cancelled here: it's back, not delivered.)
 */
export function cancelledHere(rows: readonly OutboxRow[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of rows)
    if (row.name === 'message.cancel_scheduled' && row.state !== 'refused') {
      const id = str(inputOf(row).messageId);
      if (id) ids.add(id);
    }
  return ids;
}
