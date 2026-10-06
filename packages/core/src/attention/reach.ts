/**
 * How HandsFreeOS reaches a customer, as pure rules (M8; browser-safe since M10): which kinds a person's reply
 * handles, whom a confirmation request or a nudge can text or email, and the channel a person's reply goes by. The
 * server's Let HandsFreeOS Handle plan (`auto-plan.ts`), the list's per-item hints and the phone all use them.
 */
import type { ConversationChannel } from '../schemas/conversation';
import type { AttentionKind } from './kinds';

/** The kinds whose Handle is a person's reply to the customer (a text, an email or a chat). */
export const REPLY_KINDS: ReadonlySet<AttentionKind> = new Set([
  'hot_lead',
  'unanswered_lead',
  'customer_waiting',
]);

/**
 * The kinds whose Handle is a person following up about a money document. They reach the customer by the same
 * reply rules, with the message already written (money-draft.ts) — and never through the AI teammate.
 */
export const MONEY_KINDS: ReadonlySet<AttentionKind> = new Set([
  'estimate_waiting',
  'invoice_overdue',
]);

export interface ReachContact {
  readonly phone: string | null;
  readonly email: string | null;
  /** The booking's own consent (the ticked box, a staff booking for a number that never said STOP). */
  readonly smsOk: boolean;
  readonly personConsent: 'unknown' | 'opted_in' | 'opted_out';
}

export interface Reach {
  /** Why a text can't go, or null when it can (quiet hours aside). */
  readonly text: string | null;
  /** Why an email can't go, or null when it can. */
  readonly email: string | null;
  /** A text now would be the first to this number: it carries the STOP wording. */
  readonly firstText: boolean;
}

/** What the reach rule needs to know about the business, looked up once. */
export interface ReachBusiness {
  /** An active number the carriers approved. */
  readonly textingReady: boolean;
  /** An address to send email from. */
  readonly canEmail: boolean;
}

/**
 * How HandsFreeOS can reach a customer on its own (the booking reminders' rules), as a pure rule: texts need their
 * agreement and texting set up, and never override a STOP; email needs an address that isn't stopped, and one to
 * send from. `known` says whether their number said STOP and whether email to them is stopped.
 */
export function reachRule(
  c: ReachContact,
  known: { readonly optedOut: boolean; readonly emailStopped: boolean },
  b: ReachBusiness,
): Pick<Reach, 'text' | 'email'> {
  let text: string | null = null;
  if (!c.phone) text = 'no_phone';
  else if (c.personConsent === 'opted_out' || known.optedOut) text = 'opted_out';
  else if (!c.smsOk && c.personConsent !== 'opted_in') text = 'no_consent';
  else if (!b.textingReady) text = 'texting_not_ready';
  const email = !c.email
    ? 'no_email'
    : known.emailStopped
      ? 'email_stopped'
      : !b.canEmail
        ? 'no_email_address'
        : null;
  return { text, email };
}

/** A text when one can go, else an email, else nothing. */
export const reachChannel = (r: Pick<Reach, 'text' | 'email'>): 'sms' | 'email' | null =>
  r.text === null ? 'sms' : r.email === null ? 'email' : null;

/**
 * The channel a person's reply goes by, as a pure rule: the conversation's, else a text to their number, else an
 * email; a text to a number that said STOP goes by email instead when there's an address, and can't go otherwise.
 */
export function replyChannelRule(c: {
  readonly conversationChannel: ConversationChannel | null;
  readonly phone: string | null;
  readonly email: string | null;
  /** The number the text would go to said STOP (or the customer is marked opted out). */
  readonly textStopped: boolean;
}): ConversationChannel | null {
  const preferred = c.conversationChannel ?? (c.phone ? 'sms' : c.email ? 'email' : null);
  return preferred === 'sms' && c.textStopped ? (c.email ? 'email' : null) : preferred;
}

/** A follow-up nudge texts only someone who agreed to texts; a web-form lead who didn't gets an email. */
export const nudgeContact = (p: {
  readonly phone: string | null;
  readonly email: string | null;
  readonly consent: 'unknown' | 'opted_in' | 'opted_out' | null;
}): ReachContact => ({
  phone: p.phone,
  email: p.email,
  smsOk: false,
  personConsent: p.consent ?? 'unknown',
});
