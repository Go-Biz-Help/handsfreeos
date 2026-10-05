/**
 * Tours on a buyer deal (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): the agreement
 * rule, a tour's words on the calendar, and a tour as the tours page shows it. Browser-safe and pure: the commands,
 * the screens, the portal, the phone and the Assistant say the same thing.
 *
 * Chris decided (2026-09-30): a tour needs a signed buyer agreement that hasn't ended by the tour's day. An owner or
 * admin (Approve exceptions) can let one through with a reason.
 */
import type { z } from 'zod';
import { parseLocalDate } from '../../calendar/engine/zoned';
import { fmtMonthDay } from '../../calendar/when';
import type { AgreementOut, TourOut } from './schemas';
import { termsNow, type TermEntry } from './terms';

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

/**
 * When the buyer agreement ends, from the deal's term entries ("Buyer agreement ends"). Two entries that disagree:
 * the earlier date, until a person settles it.
 */
export function agreementEndsOn(entries: readonly TermEntry[]): string | null {
  const term = termsNow(entries).get('buyer_agreement_expiry');
  if (!term) return null;
  return (
    term.current?.valueDate ??
    term.live
      .map((e) => e.valueDate)
      .filter((d): d is string => !!d)
      .sort()[0] ??
    null
  );
}

/** Whether a tour today may go ahead, as the tours page says it. */
export function agreementOut(
  facts: AgreementFacts,
  dealName: string,
  today: string,
): z.infer<typeof AgreementOut> {
  const state = agreementState(facts, today);
  return {
    ok: state.ok,
    rule: state.ok ? null : state.rule,
    words: state.ok ? null : agreementWords(state, dealName, today),
    signedTitle: facts.signed?.title ?? null,
    endsOn: facts.endsOn,
  };
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

// ---------- a tour as the tours page shows it ----------

/** A tour's row, as the server reads it and a phone keeps it (times as a `Date` or ISO text). */
export interface TourRow {
  readonly id: string;
  readonly status: TourStatus;
  readonly startsAt: Date | string;
  readonly endsAt: Date | string;
  readonly appointmentId: string | null;
  readonly calendarId: string | null;
  readonly agentUserId: string | null;
  readonly note: string | null;
  readonly exceptionReason: string | null;
  readonly exceptionBy: string | null;
  readonly exceptionAt: Date | string | null;
  readonly canceledReason: string | null;
}

/** A stop's row, with its home's address. */
export interface TourStopRow {
  readonly id: string;
  readonly tourId: string;
  readonly homeId: string;
  readonly address: string;
  readonly position: number;
  readonly status: StopStatus;
  readonly visitedAt: Date | string | null;
  readonly note: string | null;
}

/** What a client thought of a stop, as kept. */
export interface TourFeedbackRow {
  readonly id: string;
  readonly stopId: string;
  readonly personId: string;
  readonly interest: TourInterest;
  readonly rating: number | null;
  readonly words: string | null;
  readonly recordedBy: string | null;
  readonly updatedAt: Date | string;
}

/**
 * A tour as the tours page shows it: its stops in their order, each with what the clients thought. `user` names a
 * member (null when they're gone); `person` names whoever gave feedback.
 */
export function tourOut(
  t: TourRow,
  stops: readonly TourStopRow[],
  feedback: readonly TourFeedbackRow[],
  names: { user(id: string): string | null; person(id: string): string },
): z.infer<typeof TourOut> {
  const who = (id: string | null) =>
    id ? { id, fullName: names.user(id) ?? 'Former member' } : null;
  return {
    id: t.id,
    status: t.status,
    startsAt: new Date(t.startsAt).toISOString(),
    endsAt: new Date(t.endsAt).toISOString(),
    appointmentId: t.appointmentId,
    calendarId: t.calendarId,
    agent: who(t.agentUserId),
    note: t.note,
    exception:
      t.exceptionReason && t.exceptionAt
        ? {
            reason: t.exceptionReason,
            by: who(t.exceptionBy),
            at: new Date(t.exceptionAt).toISOString(),
          }
        : null,
    canceledReason: t.canceledReason,
    stops: stops
      .filter((s) => s.tourId === t.id)
      .map((s) => ({
        id: s.id,
        homeId: s.homeId,
        address: s.address,
        position: s.position,
        status: s.status,
        visitedAt: s.visitedAt ? new Date(s.visitedAt).toISOString() : null,
        note: s.note,
        feedback: feedback
          .filter((f) => f.stopId === s.id)
          .map((f) => ({
            id: f.id,
            personId: f.personId,
            name: names.person(f.personId),
            interest: f.interest,
            rating: f.rating,
            words: f.words,
            recordedBy: who(f.recordedBy),
            at: new Date(f.updatedAt).toISOString(),
          })),
      })),
  };
}
