/**
 * Legal holds (round six, 20261022000200): the words both apps show about a record on hold, so the web's deal page
 * and the phone's say the same thing (board 93). Browser-safe; `commands/record-hold.ts` does the work.
 */
import { fmtMonthDay, localDayOf } from './calendar/when';

/** A legal hold as `record_hold.list` answers it. */
export interface LegalHoldLike {
  readonly placedAt: string;
  readonly reason: string | null;
  readonly placedBy: { readonly fullName: string } | null;
}

/** "Oct 1" (with the year when it isn't this one), where the business is. */
export function holdSince(h: Pick<LegalHoldLike, 'placedAt'>, timeZone: string): string {
  return fmtMonthDay(localDayOf(h.placedAt, timeZone), new Date().getFullYear());
}

/**
 * The banner on a record while it's held: "On legal hold since Oct 1." then "“Dispute over the earnest money.”
 * Placed by Dana Reyes. Its files and history can’t be changed or deleted until an owner or admin lifts it; new ones
 * can be added."
 */
export function legalHoldBanner(
  h: LegalHoldLike,
  timeZone: string,
): { title: string; body: string } {
  const reason = h.reason ? `“${quoted(h.reason)}” ` : '';
  const who = h.placedBy ? `Placed by ${h.placedBy.fullName}. ` : '';
  return {
    title: `On legal hold since ${holdSince(h, timeZone)}.`,
    body: `${reason}${who}Its files and history can’t be changed or deleted until an owner or admin lifts it; new ones can be added.`,
  };
}

/** One held record in a list: "Since Oct 1 · “Dispute over the earnest money.” · Dana Reyes". */
export function legalHoldLine(h: LegalHoldLike, timeZone: string): string {
  return [
    `Since ${holdSince(h, timeZone)}`,
    h.reason ? `“${quoted(h.reason)}”` : null,
    h.placedBy?.fullName ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What placing and lifting a hold ask first. */
export const LEGAL_HOLD_WORDS = {
  place: 'Place a legal hold…',
  placeTitle: (name: string) => `Put ${name} on legal hold?`,
  placeAbout:
    'Its files and history stay exactly as they are until an owner or admin lifts the hold. New ones can still be added, and work on it goes on. The reason is kept in its history.',
  placeSubmit: 'Place the hold',
  placeDone: 'On legal hold. Its files and history can’t be changed or deleted now.',
  lift: 'Lift…',
  liftMenu: 'Lift the legal hold…',
  liftTitle: (name: string) => `Lift the legal hold on ${name}?`,
  liftAbout:
    'Its files and history can be changed and deleted again. The reason is kept in its history.',
  liftSubmit: 'Lift the hold',
  liftDone: 'The legal hold is lifted.',
  reasonLabel: 'Why',
} as const;

/** A reason ends with its own stop inside the quotes, as the boards write it. */
function quoted(reason: string): string {
  const r = reason.trim();
  return /[.!?…]$/.test(r) ? r : `${r}.`;
}
