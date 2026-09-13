/**
 * Reaching a customer about a booking. Whether a text may go (they agreed, never said STOP, texting is set
 * up), when quiet hours end, and sending through message.send as the system actor: a fixed clientId, so a
 * retry sends once, and keepConversationStatus, so an automatic message never reopens a conversation or
 * marks the customer's messages read. A refusal comes back as a reason, never as a thrown error.
 */
import { createHash } from 'node:crypto';
import {
  addDays,
  attendeeRecordReminder,
  executeCommand,
  HfosError,
  isOptedOut,
  liveNumber,
  loadRegistrations,
  localDateOf,
  localInstant,
  messageSend,
  quietHoursState,
  readiness,
  type QuietHoursWindow,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { systemActor, type TenantScope, type WorkerServices } from '../services';
import type { EmailText } from './messages';
import { plainSms } from './messages';

export interface Contact {
  readonly phone: string | null;
  readonly email: string | null;
  /** The booking's own consent: the ticked box online, or a staff booking for a number that never said STOP. */
  readonly smsOk: boolean;
  readonly personConsent: 'unknown' | 'opted_in' | 'opted_out';
}

/** The calendar's notification switches for this kind of message. */
export interface Channels {
  readonly text: boolean;
  readonly email: boolean;
}

export interface Reach {
  /** Why a text can't go, or null when it can (quiet hours aside). */
  readonly text: string | null;
  /** Why an email can't go, or null when it can. */
  readonly email: string | null;
  /** A text now would be the first to this number: it carries the STOP wording. */
  readonly firstText: boolean;
}

/** Whether this number has had a text from the business that went out (a failed one never reached it). */
async function hasTexted(tx: Tx, workspaceId: string, phone: string): Promise<boolean> {
  const found = await rows(
    tx,
    sql`select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.workspace_id = ${workspaceId} and c.channel = 'sms' and c.counterpart = ${phone}
          and m.direction = 'outbound' and m.status not in ('failed', 'undelivered')
        limit 1`,
  );
  return found.length > 0;
}

/** How a customer can be reached. Texts need their agreement and texting set up, and never override a STOP. */
export async function reachOf(
  tx: Tx,
  workspaceId: string,
  c: Contact,
  channels: Channels,
): Promise<Reach> {
  let text: string | null = null;
  if (!channels.text) text = 'text_off';
  else if (!c.phone) text = 'no_phone';
  else if (c.personConsent === 'opted_out' || (await isOptedOut(tx, workspaceId, c.phone)))
    text = 'opted_out';
  else if (!c.smsOk && c.personConsent !== 'opted_in') text = 'no_consent';
  else {
    const number = await liveNumber(tx, workspaceId);
    const ready =
      !!number &&
      number.status === 'active' &&
      readiness(number, await loadRegistrations(tx, workspaceId)).messagingReady;
    if (!ready) text = 'texting_not_ready';
  }
  const email = !channels.email ? 'email_off' : !c.email ? 'no_email' : null;
  return {
    text,
    email,
    firstText: text === null && !!c.phone && !(await hasTexted(tx, workspaceId, c.phone)),
  };
}

/** A fixed clientId from what makes a message unique: the same message on a retry dedupes in message.send. */
export const clientIdFor = (...parts: readonly (string | number)[]): string =>
  `hfos-${createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 40)}`;

/** When quiet hours end, as an instant, or null when it isn't quiet hours at `now`. */
export function quietEndAt(window: QuietHoursWindow, timeZone: string, now: number): number | null {
  const q = quietHoursState(window, timeZone, new Date(now));
  if (!q.quiet || !q.endsAt) return null;
  const today = localDateOf(now, timeZone);
  const end = localInstant(today, q.endsAt, timeZone);
  return end > now ? end : localInstant(addDays(today, 1), q.endsAt, timeZone);
}

export type Sent = { readonly messageId: string } | { readonly refused: string };

export const wasSent = (r: Sent): r is { readonly messageId: string } => 'messageId' in r;

const TEXT_REFUSALS = new Set(['opted_out', 'quiet_hours', 'messaging_not_ready', 'no_number']);
const EMAIL_REFUSALS = new Set([
  'recipient_suppressed',
  'no_email_address',
  'email_domain_unverified',
]);

function refusal(e: unknown, known: ReadonlySet<string>): string | null {
  if (!(e instanceof HfosError)) return null;
  if (e.rule && known.has(e.rule)) return e.rule;
  if (e.code === 'validation') return 'invalid_contact';
  return null;
}

/** A text through message.send as the system. Quiet hours, a STOP or texting not being ready come back as refusals. */
export async function sendText(
  s: WorkerServices,
  scope: TenantScope,
  to: string,
  body: string,
  clientId: string,
  meta: RequestMeta,
): Promise<Sent> {
  try {
    const { output } = await executeCommand(
      s.db,
      messageSend,
      {
        workspaceId: scope.workspaceId,
        toPhone: to,
        channel: 'sms',
        body: plainSms(body),
        clientId,
        keepConversationStatus: true,
      },
      systemActor(scope),
      meta,
    );
    return { messageId: output.messageId };
  } catch (e) {
    const why = refusal(e, TEXT_REFUSALS);
    if (why) return { refused: why };
    throw e;
  }
}

/** An email through message.send as the system, from the workspace's address. A stopped address is a refusal. */
export async function sendEmail(
  s: WorkerServices,
  scope: TenantScope,
  to: string,
  content: EmailText,
  clientId: string,
  meta: RequestMeta,
): Promise<Sent> {
  try {
    const { output } = await executeCommand(
      s.db,
      messageSend,
      {
        workspaceId: scope.workspaceId,
        toEmail: to,
        channel: 'email',
        subject: content.subject.slice(0, 200),
        body: content.body,
        clientId,
        keepConversationStatus: true,
      },
      systemActor(scope),
      meta,
    );
    return { messageId: output.messageId };
  } catch (e) {
    const why = refusal(e, EMAIL_REFUSALS);
    if (why) return { refused: why };
    throw e;
  }
}

export interface RecordInput {
  readonly key: string;
  readonly status: 'scheduled' | 'sent' | 'skipped';
  readonly channel?: 'sms' | 'email' | null;
  readonly reason?: string | null;
  readonly startsAt: Date | number;
  readonly dueAt?: number | null;
  readonly messageId?: string | null;
}

/** Writes an outcome into the attendee's reminder_state (attendee.record_reminder). */
export async function record(
  s: WorkerServices,
  scope: TenantScope,
  attendeeId: string,
  r: RecordInput,
  meta: RequestMeta,
): Promise<void> {
  await executeCommand(
    s.db,
    attendeeRecordReminder,
    {
      workspaceId: scope.workspaceId,
      attendeeId,
      key: r.key,
      status: r.status,
      channel: r.channel ?? null,
      reason: r.reason ?? null,
      startsAt: new Date(r.startsAt).toISOString(),
      dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null,
      messageId: r.messageId ?? null,
    },
    systemActor(scope),
    meta,
  );
}
