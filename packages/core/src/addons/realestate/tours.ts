/**
 * Tours on a buyer deal (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): the agreement
 * rule, and a tour's words on the calendar. Browser-safe and pure: the commands, the screens, the portal and the
 * Assistant say the same thing.
 *
 * Chris decided (2026-09-30): a tour needs a signed buyer agreement that hasn't ended by the tour's day. An owner or
 * admin (Approve exceptions) can let one through with a reason.
 */
import { parseLocalDate } from '../../calendar/engine/zoned';
import { fmtMonthDay } from '../../calendar/when';

export const TOUR_STATUSES = { planned: 'Planned', done: 'Done', canceled: 'Canceled' } as const;
export type TourStatus = keyof typeof TOUR_STATUSES;
export const TOUR_STATUS_KEYS = Object.keys(TOUR_STATUSES) as [TourStatus, ...TourStatus[]];

export const STOP_STATUSES = { planned: 'To see', visited: 'Seen', skipped: 'Skipped' } as const;
export type StopStatus = keyof typeof STOP_STATUSES;
export const STOP_STATUS_KEYS = Object.keys(STOP_STATUSES) as [StopStatus, ...StopStatus[]];

/** What a client thought of a home they saw. */
export const TOUR_INTEREST = { love: 'Loved it', maybe: 'Maybe', no: 'Not for us' } as const;
export type TourInterest = keyof typeof TOUR_INTEREST;
export const TOUR_INTEREST_KEYS = Object.keys(TOUR_INTEREST) as [TourInterest, ...TourInterest[]];

/** The most homes on one tour. */
export const MAX_TOUR_STOPS = 12;

/** A tour's length when none is given: half an hour a home, between half an hour and eight hours. */
export const defaultTourMinutes = (stops: number): number =>
  Math.min(480, Math.max(30, 30 * stops));

/** The deal's buyer agreement as the rule reads it. */
export interface AgreementFacts {
  /** The signed agreement that counts, if there is one. */
  readonly signed: { readonly documentId: string; readonly title: string } | null;
  /** When it ends (the deal's "Buyer agreement ends" key date), if entered. */
  readonly endsOn: string | null;
}

/** Whether a tour on `tourDate` may go ahead, and if not, why: the refusal's rule and its words. */
export type AgreementState =
  | { readonly ok: true; readonly documentId: string; readonly endsOn: string }
  | {
      readonly ok: false;
      readonly rule: 'buyer_agreement_needed' | 'buyer_agreement_expired';
      readonly reason: 'none' | 'no_end_date' | 'ended';
      readonly endsOn: string | null;
    };

/** The rule, for a tour on a local date. */
export function agreementState(facts: AgreementFacts, tourDate: string): AgreementState {
  if (!facts.signed)
    return { ok: false, rule: 'buyer_agreement_needed', reason: 'none', endsOn: facts.endsOn };
  if (!facts.endsOn)
    return { ok: false, rule: 'buyer_agreement_needed', reason: 'no_end_date', endsOn: null };
  // It covers the whole of its last day.
  if (facts.endsOn < tourDate)
    return { ok: false, rule: 'buyer_agreement_expired', reason: 'ended', endsOn: facts.endsOn };
  return { ok: true, documentId: facts.signed.documentId, endsOn: facts.endsOn };
}

/** Why a tour is refused, and what to do: for the refusal, the planning screen and the Assistant. */
export function agreementWords(
  state: Extract<AgreementState, { ok: false }>,
  dealName: string,
  tourDate: string,
): string {
  const letThrough = 'An owner or admin can let it through with a reason.';
  if (state.reason === 'none')
    return `${dealName} has no signed buyer agreement, so tours can’t be planned yet. Add the signed agreement under Documents on the deal and mark it signed. ${letThrough}`;
  if (state.reason === 'no_end_date')
    return `The buyer agreement on ${dealName} has no end date. Add “Buyer agreement ends” under Key dates on the deal, then plan the tour.`;
  const year = parseLocalDate(tourDate).year;
  return `The buyer agreement on ${dealName} ends ${fmtMonthDay(state.endsOn!, year)}, before this tour on ${fmtMonthDay(tourDate, year)}. Add the signed extension under Documents and change “Buyer agreement ends” under Key dates. ${letThrough}`;
}

/** The appointment's title: "Home tour: 418 Maple Ave" or "Home tour: 418 Maple Ave and 2 more". */
export function tourTitle(addresses: readonly string[]): string {
  const first = (addresses[0] ?? '').split(',')[0]!.trim() || 'homes';
  const more = addresses.length - 1;
  return more > 0 ? `Home tour: ${first} and ${more} more` : `Home tour: ${first}`;
}

/** The appointment's notes: the homes in order, then the agent's note. */
export function tourNotes(addresses: readonly string[], note?: string | null): string {
  const list = addresses.map((a, i) => `${i + 1}. ${a}`).join('\n');
  return note?.trim() ? `${list}\n\n${note.trim()}` : list;
}
