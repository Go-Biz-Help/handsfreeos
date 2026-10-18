/**
 * How partners earn (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): what their link carries, a client's 12
 * months, when a commission is free to pay out, and a share of what a client paid. The commands
 * (../commands/partners.ts) and the screens work it out the same way from these.
 *
 * Browser-safe.
 */
import { BASIS_POINTS, roundHalfUp } from '../money/totals';

/** A partner's link carries `?ref=pa-<code>` on the business's booking page (the attendee's `link_ref`). */
export const PARTNER_LINK_PREFIX = 'pa-';
/** A partner's code: 10 letters and digits, made by `partner.add`. */
export const PARTNER_CODE = /^[A-Za-z0-9]{10}$/;
export const PARTNER_CODE_LENGTH = 10;

export const partnerLinkRef = (code: string): string => `${PARTNER_LINK_PREFIX}${code}`;

/** The partner code a booking's ref carries, or null when it isn't a partner's. */
export function partnerCodeOf(ref: string | null | undefined): string | null {
  if (!ref?.startsWith(PARTNER_LINK_PREFIX)) return null;
  const code = ref.slice(PARTNER_LINK_PREFIX.length);
  return PARTNER_CODE.test(code) ? code : null;
}

/** A partner's link on the business's own address: the calendar's booking page that works whatever its name. */
export const partnerLinkPath = (calendarId: string, code: string): string =>
  `/book/c/${calendarId}?ref=${partnerLinkRef(code)}`;

/** Each payment in a client's first 12 months earns their partner (decision 7). */
export const PARTNER_MONTHS = 12;
/** A commission is free to pay out 30 days after it's earned, so a refund never has to be clawed back (decision 8). */
export const PAYABLE_AFTER_DAYS = 30;

/** When a client's months end: 12 months after their first payment. */
export function monthsEndAt(firstPaidAt: Date): Date {
  const end = new Date(firstPaidAt.getTime());
  end.setUTCMonth(end.getUTCMonth() + PARTNER_MONTHS);
  return end;
}

/** When a commission earned then is free to pay out. */
export const payableAt = (earnedAt: Date): Date =>
  new Date(earnedAt.getTime() + PAYABLE_AFTER_DAYS * 86_400_000);

/** A share of an amount at a rate in basis points, to the nearest cent. */
export const commissionCents = (baseCents: number, rateBp: number): number =>
  roundHalfUp((baseCents * rateBp) / BASIS_POINTS);

/** A rate as people read it: "10%", "12.5%". */
export function rateWords(rateBp: number): string {
  const pct = rateBp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%`;
}
