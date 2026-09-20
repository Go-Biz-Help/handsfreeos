/**
 * How a usage event names itself, so it is charged exactly once (M16, "One funnel").
 *
 * Every insert into `app.usage_ledger` is `on conflict do nothing returning id`, against a unique index on
 * `(workspace_id, idempotency_key)`. No rows back means the event was already counted. That makes the key the
 * whole of the protection, so it is derived here and nowhere else — a second place that builds these strings is
 * a second chance to bill a text twice.
 *
 * **The rule: a key names the thing, never the moment.** Twilio reports one outbound message as `sent` and then
 * as `delivered` (or `undelivered`), minutes apart, and bills us once. A key built from the message's own sid
 * collapses all three onto one row; a key with the status in it would bill three times, and a key with a
 * timestamp in it would bill however many times the webhook was retried.
 *
 * Pure and browser-safe, so a test can check a key without a database.
 */

/** A provider's id, trimmed and bounded, or nothing at all. An event with no id of its own cannot be counted. */
function sid(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v && v.length <= 190 ? v : null;
}

/** Raised rather than returned: a caller with no provider id has a bug, and silently not charging hides it. */
function need(value: string | null | undefined, what: string): string {
  const v = sid(value);
  if (!v) throw new Error(`A usage key needs the ${what}`);
  return v;
}

/**
 * One text, in or out, whatever Twilio calls its status this time. The sid is the message's, so `sent`,
 * `delivered` and `undelivered` all land on the row the first of them made.
 */
export const smsUsageKey = (messageSid: string): string => `sms:${need(messageSid, 'MessageSid')}`;

/** One picture message. Kept apart from `sms:` because the two are priced apart. */
export const mmsUsageKey = (messageSid: string): string => `mms:${need(messageSid, 'MessageSid')}`;

/** One call, from whichever end. The parent call's sid, so a status callback arriving twice counts once. */
export const callUsageKey = (callSid: string): string => `call:${need(callSid, 'CallSid')}`;

/**
 * One leg of a call. A call that rings somebody's own cell is **two** billable legs — the customer's and the
 * cell's — and they share a parent sid, so the number dialled is what tells them apart.
 */
export const callLegUsageKey = (parentCallSid: string, toE164: string): string =>
  `call-leg:${need(parentCallSid, 'ParentCallSid')}:${need(toE164, 'number the leg dialled')}`;

/**
 * One month of one phone number. The month is part of the key on purpose: this is the one usage event with no
 * provider id of its own, and a sweep that runs twice in October must not charge October twice.
 */
export const numberMonthUsageKey = (phoneNumberId: string, month: string): string =>
  `number:${need(phoneNumberId, 'phone number id')}:${monthKey(month)}`;

/** One AI request, by the `app.ai_usage` row that recorded it. */
export const aiUsageKey = (aiUsageId: string): string => `ai:${need(aiUsageId, 'ai_usage id')}`;

/** One Assistant run, which records its tokens in its own table rather than in `ai_usage`. */
export const assistantUsageKey = (runId: string): string =>
  `assistant:${need(runId, 'assistant run id')}`;

/** One top-up. The recharge row's id, which is written before the provider is ever called. */
export const topUpUsageKey = (rechargeId: string): string =>
  `topup:${need(rechargeId, 'recharge id')}`;

/**
 * A goodwill or support credit. Unlike everything else here the key is the caller's, because two credits of the
 * same amount on the same day are two different decisions somebody made.
 */
export const creditUsageKey = (reference: string): string =>
  `credit:${need(reference, 'credit reference')}`;

/**
 * A reconciliation against a carrier's daily records: one per category per day, so re-running the reconciler
 * over a week it has already done writes nothing.
 */
export const reconcileUsageKey = (category: string, day: string): string =>
  `reconcile:${need(category, 'usage category')}:${dayKey(day)}`;

/** `YYYY-MM`, from that or from an ISO date. Anything else raises rather than quietly charging another month. */
export function monthKey(value: string): string {
  const v = (value ?? '').trim();
  const match = /^(\d{4})-(\d{2})/.exec(v);
  if (!match)
    throw new Error(`A usage key needs a month like 2026-09, not ${JSON.stringify(value)}`);
  return `${match[1]}-${match[2]}`;
}

/** `YYYY-MM-DD`, from that or from an ISO timestamp. */
export function dayKey(value: string): string {
  const v = (value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (!match)
    throw new Error(`A usage key needs a day like 2026-09-20, not ${JSON.stringify(value)}`);
  return match[1]!;
}

/** The month a moment falls in, in a time zone, for the number sweep. */
export function monthOf(at: Date | number, timeZone: string): string {
  const d = typeof at === 'number' ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return monthKey(`${year}-${month}`);
}
