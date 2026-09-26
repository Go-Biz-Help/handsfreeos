/**
 * Bringing a number that already lives in Twilio (20261010000900): the words and the small decisions, kept
 * here so the settings screen, the worker and the tests all say the same thing. Browser-safe: no database.
 *
 * Two places a number is usually sitting before it comes here, and neither is a carrier port:
 *
 * - **twilio** — the business's own Twilio account. They connect it, pick numbers, and say which workspace
 *   each one is for.
 * - **highlevel** — a GoHighLevel / LeadConnector "LC Phone" number. Those are Twilio numbers too, held in
 *   HighLevel's own Twilio account, so they move the same way once HighLevel's support sends them.
 *
 * Either way the number goes **account to account inside Twilio**, into the workspace's own subaccount, and
 * the public number never changes. HandsFreeOS watches the subaccount and sets the number up the moment it
 * arrives. **Nothing here ever tells anybody to release or delete a number first**: releasing hands it back to
 * the carrier, and a released number can be gone for good.
 */

export const NUMBER_IMPORT_SOURCES = ['twilio', 'highlevel'] as const;
export type NumberImportSourceName = (typeof NUMBER_IMPORT_SOURCES)[number];

/** US and Canadian toll-free prefixes. Anything else under +1 is a local (10DLC) number. */
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;

/** Whether a number is toll-free, which decides the registration it needs: toll-free verification, not 10DLC. */
export const isTollFreeNumber = (e164: string): boolean => TOLL_FREE.test(e164);

/** The two kinds of number this system keeps, from the number alone. */
export const numberTypeOf = (e164: string): 'local' | 'toll_free' =>
  isTollFreeNumber(e164) ? 'toll_free' : 'local';

/**
 * Whether a carrier lookup's answer means Twilio hosts the number. Twilio numbers answer with names like
 * `Twilio - SMS/MMS-SVR` or `Twilio - Toll-Free - SMS-Sybase365/MMS-SVR`; every one of them says Twilio.
 */
export const carrierIsTwilio = (carrierName: string | null | undefined): boolean =>
  !!carrierName && /twilio/i.test(carrierName);

/**
 * The hosts a HighLevel / LeadConnector number's webhooks point at. A number in a connected Twilio account that
 * answers here is one HighLevel is using today — an agency's "bring your own Twilio" — and moving it off moves
 * that sub-account's texting and calls with it, which the screen should say before anybody presses anything.
 */
const HIGHLEVEL_HOSTS =
  /(^|\.)(leadconnectorhq\.com|msgsndr\.com|gohighlevel\.com|highlevel\.com)$/i;

const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** Who a number's webhooks point at today, by its SMS and voice addresses. */
export type NumberUsedBy = 'highlevel' | 'handsfreeos' | 'other' | 'nothing';

export function numberUsedBy(
  urls: { readonly smsUrl?: string | null; readonly voiceUrl?: string | null },
  /** The worker's own public address, so a number already pointed at us says so. */
  ourUrl?: string | null,
): NumberUsedBy {
  const hosts = [hostOf(urls.smsUrl), hostOf(urls.voiceUrl)].filter((h): h is string => !!h);
  if (hosts.length === 0) return 'nothing';
  if (hosts.some((h) => HIGHLEVEL_HOSTS.test(h))) return 'highlevel';
  const ours = hostOf(ourUrl);
  if (ours && hosts.every((h) => h === ours)) return 'handsfreeos';
  return 'other';
}

/** Twilio account ids (AC…) and number ids (PN…), as the schemas and the database accept them. */
export const ACCOUNT_SID = /^AC[A-Za-z0-9]{8,40}$/;
export const NUMBER_SID = /^PN[A-Za-z0-9]{8,40}$/;
export const API_KEY_SID = /^SK[A-Za-z0-9]{8,40}$/;

/** HighLevel's own guide to moving LC Phone numbers to Twilio (US and international). */
export const HIGHLEVEL_MOVE_GUIDE_URL =
  'https://help.gohighlevel.com/support/solutions/articles/48001240107-moving-phone-numbers-from-lc-phone-to-twilio-us-international-';

/**
 * Whether HighLevel can move a number with Account SIDs alone. US and Canadian numbers can; anywhere else,
 * their support also asks for a Regulatory Bundle SID and an Address SID, which HandsFreeOS does not set up yet.
 */
export const movesWithSidsAlone = (e164: string): boolean => e164.startsWith('+1');

/**
 * The request the owner sends to move the number, filled in, ready to copy.
 *
 * Addressed to HighLevel's support for an LC Phone number, and to Twilio's for a number in the business's own
 * account. HighLevel's guide asks for the Twilio **Account SID** (HandsFreeOS's parent account), the
 * **destination sub-account SID** (this business's), the number, and a **preferred cutover window**, so all four
 * are here. Both say, in so many words, **do not release it**: a support desk asked to "move a number off" an
 * account sometimes releases it, and a released number can go straight back to the carrier.
 */
export function transferRequestText(input: {
  readonly source: NumberImportSourceName;
  readonly display: string;
  /** The workspace's own subaccount: where the number is going. */
  readonly toAccountSid: string;
  /** HandsFreeOS's parent Twilio account, which the subaccount sits under. HighLevel asks for both. */
  readonly parentAccountSid?: string | null;
  /** The account holding it today, when known (the business's own Twilio account). */
  readonly fromAccountSid?: string | null;
  readonly businessName?: string | null;
  /** When the business would like it to move: "a weekday after 6 PM Central". */
  readonly cutoverWindow?: string | null;
}): string {
  const whose = input.businessName ? ` for ${input.businessName}` : '';
  const cutover = input.cutoverWindow?.trim();
  const destination = input.parentAccountSid
    ? [
        `Twilio Account SID: ${input.parentAccountSid}`,
        `Destination sub-account SID: ${input.toAccountSid}`,
      ]
    : [`Destination Twilio Account SID: ${input.toAccountSid}`];
  if (input.source === 'highlevel')
    return [
      'Hello,',
      '',
      `Please move my LC Phone number to my own Twilio account${whose}.`,
      '',
      `Phone number: ${input.display}`,
      ...destination,
      ...(cutover ? [`Preferred cutover window: ${cutover}`] : []),
      '',
      'Please keep the number active and do not release or delete it — it has to stay the same number. Let me know when it is live in the Twilio account.',
      '',
      'Thank you.',
    ].join('\n');
  return [
    'Hello,',
    '',
    `Please transfer the phone number ${input.display} between my Twilio accounts${whose}.`,
    '',
    ...(input.fromAccountSid ? [`From Account SID: ${input.fromAccountSid}`] : []),
    ...(input.parentAccountSid
      ? [`To Account SID: ${input.parentAccountSid}`, `To sub-account SID: ${input.toAccountSid}`]
      : [`To Account SID: ${input.toAccountSid}`]),
    ...(cutover ? [`Preferred cutover window: ${cutover}`] : []),
    '',
    'The number must stay active and keep the same phone number. Please do not release it.',
    '',
    'Thank you.',
  ].join('\n');
}

/** Where texting stands for an imported number: the carrier registration, kept apart from the number itself. */
export type ImportTextingState = 'needs_registration' | 'in_review' | 'approved' | 'rejected';

/**
 * From `readiness()`'s next step to the four words the import screen uses. The number and its registration are
 * two different questions — a number can have landed and ring the inbox while texting still waits on the
 * carriers — so the screen shows them side by side and never folds one into the other.
 */
export function textingStateOf(nextStep: string): ImportTextingState {
  switch (nextStep) {
    case 'ready':
      return 'approved';
    case 'awaiting_approval':
      return 'in_review';
    case 'rejected':
      return 'rejected';
    default:
      return 'needs_registration';
  }
}

/** How long to wait before looking for a number again: often at first, then less as the days go by. */
export function nextImportCheckMs(input: {
  readonly startedAt: Date;
  readonly now: number;
  /** The worker's base interval (NUMBER_IMPORT_POLL_MS). */
  readonly baseMs: number;
}): number {
  const age = input.now - input.startedAt.getTime();
  const DAY = 24 * 60 * 60 * 1000;
  // A transfer usually lands within a few business days; after two, hourly is plenty, and after two weeks
  // it is a request somebody forgot to send, so a few times a day is enough to catch it when they do.
  if (age > 14 * DAY) return Math.max(input.baseMs, 6 * 60 * 60 * 1000);
  if (age > 2 * DAY) return Math.max(input.baseMs, 60 * 60 * 1000);
  return input.baseMs;
}
