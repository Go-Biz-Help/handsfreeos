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
import { intlTimeZone } from '../intl/engine-zones';

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
  `number:${need(phoneNumberId, 'phone number id')}:${billingMonth(month)}`;

/** One AI request, by the `app.ai_usage` row that recorded it. */
export const aiUsageKey = (aiUsageId: string): string => `ai:${need(aiUsageId, 'ai_usage id')}`;

/** One Assistant run, which records its tokens in its own table rather than in `ai_usage`. */
export const assistantUsageKey = (runId: string): string =>
  `assistant:${need(runId, 'assistant run id')}`;

/**
 * One running total of speech, for one price line: everything a business heard and said since the last one,
 * claimed as a batch before it's charged. The batch's id is the key, so a sweep that charges it twice (a crash
 * between charging and marking it charged) counts it once.
 */
export const speechUsageKey = (batchId: string, rateKey: string): string =>
  `speech:${need(batchId, 'speech batch id')}:${need(rateKey, 'rate key')}`;

/**
 * A business's brand registered for texting on local numbers, by the brand's own sid. Sending a turned-down
 * brand again keeps its sid, so it lands on this row and isn't charged twice (Twilio doesn't charge it twice).
 */
export const a2pBrandUsageKey = (brandSid: string): string =>
  `a2p-brand:${need(brandSid, 'brand sid')}`;

/** The brand's extra (secondary) check, once per brand. */
export const a2pBrandVettingUsageKey = (brandSid: string): string =>
  `a2p-brand-vetting:${need(brandSid, 'brand sid')}`;

/**
 * One review of one campaign. A turned-down campaign is replaced by a new one with a new sid, and Twilio
 * charges the review again, so this does too.
 */
export const a2pCampaignVettingUsageKey = (campaignSid: string): string =>
  `a2p-campaign-vetting:${need(campaignSid, 'campaign sid')}`;

/**
 * One month of one campaign. Like a number's month, the month is part of the key, so a sweep that runs every
 * day charges each month once. The month is the one its period starts in (`campaignPeriod`).
 */
export const a2pCampaignMonthUsageKey = (campaignSid: string, month: string): string =>
  `a2p-campaign:${need(campaignSid, 'campaign sid')}:${billingMonth(month)}`;

/** One month of a campaign: the month the key names, and the moment that month's period began. */
export interface CampaignPeriod {
  readonly month: string;
  readonly startsAt: Date;
}

/**
 * Which month's fee a campaign owes now, or null before its first. Twilio charges the first month on approval
 * and each month after on the same day of the month, so a campaign approved on October 15 owes October's from
 * then, November's from November 15, and so on. A day the month doesn't have is its last day: one approved
 * January 31 owes February's from February 28. In UTC, which is how Twilio dates its charges.
 */
export function campaignPeriod(
  approvedAt: Date | number,
  now: Date | number,
): CampaignPeriod | null {
  const from = typeof approvedAt === 'number' ? new Date(approvedAt) : approvedAt;
  const at = typeof now === 'number' ? new Date(now) : now;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(at.getTime()) || at < from) return null;
  /** The moment the period that starts `n` months after approval begins. */
  const startOf = (n: number): Date => {
    const year = from.getUTCFullYear();
    const month = from.getUTCMonth() + n;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        year,
        month,
        Math.min(from.getUTCDate(), lastDay),
        from.getUTCHours(),
        from.getUTCMinutes(),
        from.getUTCSeconds(),
        from.getUTCMilliseconds(),
      ),
    );
  };
  let months =
    (at.getUTCFullYear() - from.getUTCFullYear()) * 12 + (at.getUTCMonth() - from.getUTCMonth());
  if (startOf(months) > at) months -= 1;
  const startsAt = startOf(months);
  return { month: startsAt.toISOString().slice(0, 7), startsAt };
}

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
  `reconcile:${need(category, 'usage category')}:${billingDay(day)}`;

/**
 * `YYYY-MM`, from that or from an ISO date, for the one usage key that carries a period. Named apart from the
 * inbox's `dayKey`, which groups a thread on the reader's own clock and is a different question entirely.
 */
export function billingMonth(value: string): string {
  const v = (value ?? '').trim();
  const match = /^(\d{4})-(\d{2})/.exec(v);
  if (!match)
    throw new Error(`A usage key needs a month like 2026-09, not ${JSON.stringify(value)}`);
  return `${match[1]}-${match[2]}`;
}

/** `YYYY-MM-DD`, from that or from an ISO timestamp. */
export function billingDay(value: string): string {
  const v = (value ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (!match)
    throw new Error(`A usage key needs a day like 2026-09-20, not ${JSON.stringify(value)}`);
  return match[1]!;
}

/**
 * The month a moment falls in, where the business is, for the number sweep. The zone goes through
 * `intlTimeZone` like every other Intl call in core: a device whose time-zone data has never heard of
 * `America/Ciudad_Juarez` would otherwise throw here, and charging a month is not the place to find out.
 */
export function monthOf(at: Date | number, timeZone: string): string {
  const d = typeof at === 'number' ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: intlTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return billingMonth(`${year}-${month}`);
}
