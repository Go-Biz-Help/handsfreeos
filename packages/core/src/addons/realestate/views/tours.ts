/**
 * A buyer deal's tours from a phone's copy (Real Estate round six): what `realestate.tours` answers (ops/tours.ts),
 * worked out from the rows the phone keeps. Whether the buyer agreement lets a tour go ahead today, and each tour with
 * its homes in order, which were seen and what the clients thought of each.
 * `packages/core/test/addons/realestate-phone-offers.test.ts` holds it to the server's answer.
 *
 * Left to the server: whether this person may let a tour through without an agreement (`can.except`), a permission
 * the phone reads from `workspace.get`. A deal kept as its summary (someone who sees every deal, not on this one) has
 * neither its tours nor its documents on the phone: null, and its tours wait for signal. A client with no name shows
 * by their email here, where the server says “The client”: the copy keeps a person's name, else their email.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { ToursOutput } from '../schemas';
import {
  agreementEndsOn,
  agreementOut,
  tourOut,
  type StopStatus,
  type TourFeedbackRow,
  type TourInterest,
  type TourRow,
  type TourStatus,
  type TourStopRow,
} from '../tours';
import { byTimeAsc, byTimeDesc, num, str } from './columns';
import { holdsWhole, isoOr, termEntriesOfCopy } from './deal-facts';
import { byText, iso, type RealestateCopy } from './synced';

export type ToursView = Omit<z.infer<typeof ToursOutput>, 'can'>;

export function toursOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: {
    readonly userId: string | null;
    /** The business's today (YYYY-MM-DD). */
    readonly today: string;
    readonly includeCanceled?: boolean;
  },
): ToursView | null {
  const deal = copy.deals.get(dealId);
  if (!deal || !holdsWhole(copy, dealId, ctx.userId)) return null;

  // The signed agreement that counts, as the server picks it: the controlling one, then the latest signed.
  const [signed] = copy
    .rows('documents', dealId)
    .filter((d) => d.data.kind === 'buyer_agreement' && d.data.status === 'signed')
    .sort(
      (a, b) =>
        Number(b.data.controlling === true) - Number(a.data.controlling === true) ||
        byTimeDesc(a.data.signed_at, b.data.signed_at) ||
        byText(b.id, a.id),
    );
  const agreement = agreementOut(
    {
      signed: signed ? { documentId: signed.id, title: str(signed.data.title) ?? '' } : null,
      endsOn: agreementEndsOn(termEntriesOfCopy(copy, dealId)),
    },
    deal.name,
    ctx.today,
  );

  const tours: TourRow[] = copy
    .rows('tours', dealId)
    .filter((t) => ctx.includeCanceled || t.data.status === 'planned' || t.data.status === 'done')
    .sort((a, b) => byTimeDesc(a.data.starts_at, b.data.starts_at) || byText(b.id, a.id))
    .map(({ id, data: t }) => ({
      id,
      status: str(t.status) as TourStatus,
      startsAt: isoOr(t.starts_at) ?? iso(0),
      endsAt: isoOr(t.ends_at) ?? iso(0),
      appointmentId: str(t.appointment_id),
      calendarId: str(t.calendar_id),
      agentUserId: str(t.agent_user_id),
      note: str(t.note),
      exceptionReason: str(t.exception_reason),
      exceptionBy: str(t.exception_by),
      exceptionAt: isoOr(t.exception_at),
      canceledReason: str(t.canceled_reason),
    }));
  const shown = new Set(tours.map((t) => t.id));
  const addresses = new Map(
    copy.rows('homes', dealId).map((h) => [h.id, str(h.data.address) ?? '']),
  );
  const stops: TourStopRow[] = copy
    .rows('tour_stops', dealId)
    .filter((s) => shown.has(str(s.data.tour_id) ?? '') && addresses.has(str(s.data.home_id) ?? ''))
    .sort((a, b) => (num(a.data.position) ?? 0) - (num(b.data.position) ?? 0) || byText(a.id, b.id))
    .map(({ id, data: s }) => ({
      id,
      tourId: str(s.tour_id) ?? '',
      homeId: str(s.home_id) ?? '',
      address: addresses.get(str(s.home_id) ?? '') ?? '',
      position: num(s.position) ?? 0,
      status: str(s.status) as StopStatus,
      visitedAt: isoOr(s.visited_at),
      note: str(s.note),
    }));
  const feedback: TourFeedbackRow[] = copy
    .rows('tour_feedback', dealId)
    .filter((f) => shown.has(str(f.data.tour_id) ?? ''))
    .sort((a, b) => byTimeAsc(a.data.created_at, b.data.created_at) || byText(a.id, b.id))
    .map(({ id, data: f }) => ({
      id,
      stopId: str(f.stop_id) ?? '',
      personId: str(f.person_id) ?? '',
      interest: str(f.interest) as TourInterest,
      rating: num(f.rating),
      words: str(f.words),
      recordedBy: str(f.recorded_by),
      updatedAt: isoOr(f.updated_at) ?? iso(0),
    }));

  // Who gave feedback: the deal's clients by name, else "The client"; anyone else by name, else "A client".
  const clients = new Map<string, string>();
  for (const l of copy.linksTo.get(dealId) ?? [])
    if (l.addonKey === 'realestate_client' && l.personId)
      clients.set(l.personId, copy.personPlain(l.personId) ?? 'The client');
  const names = {
    user: (id: string) => copy.user(id),
    person: (id: string) => clients.get(id) ?? copy.personPlain(id) ?? 'A client',
  };
  return { agreement, tours: tours.map((t) => tourOut(t, stops, feedback, names)) };
}
