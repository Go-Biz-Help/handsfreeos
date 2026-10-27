/**
 * Waiting for you as the phone keeps it (decision 44, owner answer 19b): the person's messages waiting for their OK,
 * and comments (decision 92; the copy keeps no post, so a comment shows its words alone), from their phone's own copy
 * (`addon_phone_rows`, source `sends`; 20261027001800), so they read, and OK, change, skip and Approve all work, with
 * no signal. The rest of the list (steps it needs them for, friend requests to decide) is
 * the server's `outreach.waiting`, with signal.
 *
 * `waitingOfCopy` answers what `outreach.waiting` answers of the messages, on the fields the phone keeps:
 * `packages/core/test/addons/outreach-phone.test.ts` holds the two equal.
 *
 * Browser-safe and pure.
 */
import { SEND_KINDS, type SendKind } from '../automation';
import { cellMs, cellObject, cellText, rowKey, type SyncedPhoneRow } from '../../phone-rows';
import { SENDS_MOST, type Send } from '../sends';
import { oneByOne, type WaitingKinds } from '../waiting-words';

/** One of the person's messages waiting, as the phone keeps it. */
export type PhoneSend = Pick<
  Send,
  | 'sendId'
  | 'kind'
  | 'profileId'
  | 'name'
  | 'profileUrl'
  | 'threadKey'
  | 'text'
  | 'state'
  | 'handedOver'
  | 'needsYou'
  | 'createdAt'
>;

/** What the phone shows with no signal: replies handed over, then messages to OK, each oldest first. */
export interface PhoneWaiting {
  readonly replies: readonly PhoneSend[];
  readonly messages: readonly PhoneSend[];
  /** How many of each wait, and when the newest began to, as `outreach.waiting` counts them. */
  readonly kinds: Pick<WaitingKinds, 'reply' | 'message'>;
}

/** The phone's rows of Social Outreach's messages: `addon_phone_rows` of the add-on, source `sends`. */
export const SENDS_SOURCE = 'sends';

/** Who a message is to when the copy doesn't say. */
export const SOMEONE = 'Someone';

const bool = (v: unknown) => v === true || v === 1 || v === 'true';

/**
 * One row of the copy as a message or a comment, or null when it isn't one of `me`'s waiting. A build from before
 * comments takes only messages here, so a comment's row is left out of its copy and nothing breaks.
 */
export function phoneSendOf(row: SyncedPhoneRow, me: string): PhoneSend | null {
  if (cellText(row.source) !== SENDS_SOURCE) return null;
  const d = cellObject(row.data);
  if (cellText(d.user_id) !== me || cellText(d.state) !== 'waiting') return null;
  const kind = cellText(d.kind);
  const created = cellMs(d.created_at);
  const sendId = rowKey(row.id);
  if (!sendId || !kind || !SEND_KINDS.includes(kind as SendKind) || created === null) return null;
  return {
    sendId,
    kind: kind as SendKind,
    profileId: cellText(d.profile_id) ?? '',
    name: cellText(d.name) ?? SOMEONE,
    profileUrl: cellText(d.profile_url),
    threadKey: cellText(d.thread_key),
    text: typeof d.text === 'string' ? d.text : (cellText(d.text) ?? ''),
    state: 'waiting',
    handedOver: bool(d.handed_over),
    needsYou: cellText(d.needs_you),
    createdAt: new Date(created).toISOString(),
  };
}

const newest = (list: readonly PhoneSend[]) =>
  list.length
    ? new Date(Math.max(...list.map((s) => Date.parse(s.createdAt)))).toISOString()
    : null;

/** The person's messages waiting, from the rows their phone holds: theirs only, waiting only. */
export function waitingOfCopy(rows: readonly SyncedPhoneRow[], me: string): PhoneWaiting {
  const all = rows
    .map((row) => phoneSendOf(row, me))
    .filter((s): s is PhoneSend => s !== null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const replies = all.filter((s) => s.handedOver);
  const messages = all.filter((s) => !s.handedOver);
  // The server lists the oldest SENDS_MOST, then splits them.
  const listed = new Set(all.slice(0, SENDS_MOST).map((s) => s.sendId));
  return {
    replies: replies.filter((s) => listed.has(s.sendId)),
    messages: messages.filter((s) => listed.has(s.sendId)),
    kinds: {
      reply: { count: replies.length, newestAt: newest(replies) },
      message: { count: messages.length, newestAt: newest(messages) },
    },
  };
}

/**
 * What the phone's Approve all names: every message it shows but those that wait for an OK of their own
 * (`oneByOne`), oldest first, at most `SENDS_MOST`. It's sent with `partial`, so any OK'd or skipped elsewhere
 * meanwhile is passed over.
 */
export function approveAllFromPhone(waiting: PhoneWaiting): { sendId: string }[] {
  return waiting.messages
    .filter((s) => !oneByOne(s))
    .slice(0, SENDS_MOST)
    .map((s) => ({ sendId: s.sendId }));
}
