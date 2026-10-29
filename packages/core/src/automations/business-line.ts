/**
 * Whether a number is a business landline (AI calls, part 5; Chris, 2026-10-28). With **Call business landlines
 * without a yes** on, a campaign's or workflow's call may go to someone who hasn't agreed in writing when their number
 * is one: the federal rule that needs a written yes for an AI voice covers home lines and cell phones, and the Do Not
 * Call list covers people, not businesses.
 *
 * A business landline is a number the phone company says is a **landline**, whose registered owner is a business
 * (its caller name record), or that is a company's own number in HandsFreeOS. A mobile is never one, even a work
 * cell, nor is an internet (VoIP) number or a home landline. When the phone company can't say, it isn't one.
 *
 * The worker asks Twilio Lookup just before the call: the line type first, and the caller name only for a landline
 * that isn't a company's number here, since each is paid for. What Twilio said is kept for `LINE_CHECK_DAYS`
 * (`app.phone_line_checks`), then asked again. Pure and browser-safe.
 */

/** How long what the phone company said about a number is used before it's asked again. */
export const LINE_CHECK_DAYS = 90;

/** What kind of line Twilio says a number is, in our words (`app.phone_line_checks.line_type`). */
export const LINE_TYPES = ['landline', 'mobile', 'voip', 'toll_free', 'other', 'unknown'] as const;
export type LineType = (typeof LINE_TYPES)[number];

/** Who the caller name record says owns the number (`app.phone_line_checks.caller_type`). */
export const CALLER_TYPES = ['business', 'consumer', 'unknown'] as const;
export type CallerType = (typeof CALLER_TYPES)[number];

/** Twilio's line type words (Line Type Intelligence) in ours. */
export function lineTypeOf(twilio: string | null | undefined): LineType {
  switch ((twilio ?? '').trim()) {
    case 'landline':
      return 'landline';
    case 'mobile':
      return 'mobile';
    case 'fixedVoip':
    case 'nonFixedVoip':
      return 'voip';
    case 'tollFree':
      return 'toll_free';
    case '':
    case 'unknown':
      return 'unknown';
    default:
      // personal, premium, sharedCost, uan, voicemail, pager: none of them a business's landline.
      return 'other';
  }
}

/** Twilio's caller type (Caller Name: BUSINESS, CONSUMER, UNDETERMINED) in ours. */
export function callerTypeOf(twilio: string | null | undefined): CallerType {
  const t = (twilio ?? '').trim().toUpperCase();
  return t === 'BUSINESS' ? 'business' : t === 'CONSUMER' ? 'consumer' : 'unknown';
}

export interface LineFacts {
  /** What Twilio said the line is, or null when it hasn't been asked (or was asked too long ago). */
  readonly lineType: LineType | null;
  /** Who Twilio said owns it, or null when it hasn't been asked. */
  readonly callerType: CallerType | null;
  /** A company in this business's HandsFreeOS has this as its number. */
  readonly companyNumber: boolean;
}

/**
 * `business`: a business landline, so a call may go without a yes. `other`: it isn't one (or the phone company
 * couldn't say), so it needs the yes. `unchecked`: the phone company has to be asked first.
 */
export type BusinessLine = 'business' | 'other' | 'unchecked';

export function businessLineOf(f: LineFacts): BusinessLine {
  if (f.lineType === null) return 'unchecked';
  if (f.lineType !== 'landline') return 'other';
  if (f.companyNumber) return 'business';
  if (f.callerType === null) return 'unchecked';
  return f.callerType === 'business' ? 'business' : 'other';
}

/** Whether the caller name is worth paying for: a landline that isn't a company's number here, not asked yet. */
export const needsCallerName = (f: LineFacts): boolean =>
  f.lineType === 'landline' && !f.companyNumber && f.callerType === null;
