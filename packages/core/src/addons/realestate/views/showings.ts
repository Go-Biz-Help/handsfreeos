/**
 * A listing's showings and open houses from a phone's copy (Real Estate round six): what `realestate.showing.list`
 * and `realestate.open_houses` answer (ops/showings.ts, ops/open-houses.ts), worked out from the rows the phone keeps.
 * `packages/core/test/addons/realestate-phone-listing.test.ts` holds both to the server's answer.
 *
 * Like the rest of a listing, these go only to the deal's people: on a deal kept as its summary each view is null and
 * waits for signal, as it is for a buyer deal (which the server refuses).
 *
 * How to get in (the lockbox code, the listing's `showing_access`) never reaches a phone, so the showings' settings
 * here don't have it. The business's time zone, for when each showing is, comes from the workspace.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { openHousePath, showingRequestPath, streetOf } from '../listing';
import type { OpenHousesOutput, ShowingListOutput } from '../schemas';
import {
  feedbackSummary,
  interestWords,
  SHOWING_SOURCES,
  showingSettingsOf,
  showingStateWords,
  showingWhen,
  themesWords,
  type ListingShowingColumns,
  type ShowingFeedback,
  type ShowingSource,
  type ShowingState,
  type ShowingThemes,
} from '../showings';
import { isoOr } from './deal-facts';
import { addressOfCopy, listingRowOfCopy, wholeDeal } from './listing';
import { byText, iso, ms, text, type RealestateCopy } from './synced';

type ShowingListOut = z.infer<typeof ShowingListOutput>;
export type ShowingListView = Omit<ShowingListOut, 'settings'> & {
  readonly settings: Omit<ShowingListOut['settings'], 'access'>;
};
export type OpenHousesView = z.infer<typeof OpenHousesOutput>;

const isSet = (v: unknown) => v !== null && v !== undefined;
const num = (v: unknown) => (isSet(v) ? Number(v) : null);
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/** A column the server reads as a plain string, kept as it is (an empty one too). */
const str = (v: unknown): string | null => (isSet(v) ? String(v) : null);

/** How showings work on the listing, from its row, or null when it has none yet. */
function showingColumnsOf(
  r: Readonly<Record<string, unknown>> | undefined,
): ListingShowingColumns | null {
  if (!r) return null;
  return {
    showingsOpen: isSet(r.showings_open) ? r.showings_open === true : null,
    showingConfirm: text(r.showing_confirm) as ListingShowingColumns['showingConfirm'],
    showingDays: Array.isArray(r.showing_days) ? r.showing_days.map(Number) : null,
    showingFrom: text(r.showing_from),
    showingTo: text(r.showing_to),
    showingMinutes: num(r.showing_minutes),
    showingAccessHours: num(r.showing_access_hours),
    showingFeedbackHours: num(r.showing_feedback_hours),
  };
}

// ---------- showings ----------

export function showingListOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: {
    readonly userId: string | null;
    readonly now: number;
    /** The business's time zone. */
    readonly timeZone: string;
  },
): ShowingListView | null {
  if (!wholeDeal(copy, dealId, ctx.userId, 'listing')) return null;
  const row = copy.rows('listings', dealId)[0]?.data;
  const l = listingRowOfCopy(copy, dealId);
  const address = addressOfCopy(copy, dealId);
  const site = l?.slug && l.pageState === 'published' ? copy.bookingSlug : null;
  // The deal's first client: the seller the screens name.
  const client = copy.clients.get(dealId);
  const seller = client ? (copy.personParts(client)?.firstName ?? null) : null;
  const list = copy
    .rows('showings', dealId)
    .map(({ id, data: s }) => ({
      id,
      s,
      starts: ms(s.starts_at) ?? 0,
      ends: ms(s.ends_at) ?? 0,
      state: (text(s.state) ?? 'requested') as ShowingState,
      feedback: record(s.feedback) as ShowingFeedback | null,
    }))
    .sort((a, b) => b.starts - a.starts || byText(b.id, a.id));
  const summary = feedbackSummary(list.map((x) => ({ state: x.state, feedback: x.feedback })));
  const themes = record(row?.showing_themes) as ShowingThemes | null;
  const themesAt = isoOr(row?.showing_themes_at);
  return {
    dealId,
    street: address ? streetOf(address) : null,
    requestPath: site && l?.slug ? showingRequestPath(site, l.slug) : null,
    sellerFirstName: seller,
    settings: showingSettingsOf(showingColumnsOf(row)),
    showings: list.map(({ id, s, starts, ends, state, feedback }) => {
      const ahead = ends > ctx.now;
      const source = (text(s.source) ?? 'agent') as ShowingSource;
      const sharedAt = isoOr(s.feedback_shared_at);
      const checked = s.checked === true;
      return {
        id,
        source,
        sourceLabel: SHOWING_SOURCES[source],
        state,
        stateWords: showingStateWords(state, seller),
        startsAt: iso(starts),
        endsAt: iso(ends),
        when: showingWhen(starts, ctx.timeZone),
        agentName: str(s.agent_name) ?? '',
        brokerage: str(s.brokerage),
        license: str(s.license),
        agentEmail: str(s.agent_email),
        agentPhone: str(s.agent_phone),
        checked,
        requestedAt: isoOr(s.requested_at) ?? iso(0),
        decidedAt: isoOr(s.decided_at),
        decisionNote: str(s.decision_note),
        accessSentAt: isoOr(s.access_sent_at),
        feedbackAskedAt: isoOr(s.feedback_asked_at),
        feedback,
        feedbackAt: isoOr(s.feedback_at),
        feedbackSource: text(s.feedback_source) as ShowingSource | null,
        feedbackSharedAt: sharedAt,
        can: {
          confirm: state === 'requested' && ahead,
          decline: state === 'requested',
          cancel: (state === 'requested' || state === 'confirmed') && ahead,
          check: !checked,
          feedback: state === 'confirmed' || state === 'done',
          share: !!feedback && !sharedAt,
        },
      };
    }),
    summary: { ...summary, interestWords: interestWords(summary.averageInterest) },
    themes:
      themes && themesAt
        ? {
            liked: themes.liked.map((t) => ({ ...t, quotes: [...t.quotes] })),
            disliked: themes.disliked.map((t) => ({ ...t, quotes: [...t.quotes] })),
            likedWords: themesWords(themes.liked),
            dislikedWords: themesWords(themes.disliked),
            at: themesAt,
          }
        : null,
  };
}

// ---------- open houses ----------

export function openHousesOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): OpenHousesView | null {
  if (!wholeDeal(copy, dealId, ctx.userId, 'listing')) return null;
  const l = listingRowOfCopy(copy, dealId);
  const live = !!l?.mlsNumber;
  const site = live && l?.slug ? copy.bookingSlug : null;
  const byTime = (a: { at: number; id: string }, b: { at: number; id: string }) =>
    a.at - b.at || byText(a.id, b.id);
  const visitors = copy
    .rows('open_house_visitors', dealId)
    .map(({ id, data: v }) => ({ id, v, at: ms(v.signed_in_at) ?? 0 }))
    .sort(byTime);
  return {
    dealId,
    live,
    openHouses: copy
      .rows('open_houses', dealId)
      .map(({ id, data: o }) => ({ id, o, at: ms(o.starts_at) ?? 0 }))
      .sort(byTime)
      .map(({ id, o }) => {
        const state = (text(o.state) ?? 'planned') as OpenHousesView['openHouses'][number]['state'];
        const host = text(o.host_user_id);
        return {
          id,
          startsAt: isoOr(o.starts_at) ?? iso(0),
          endsAt: isoOr(o.ends_at) ?? iso(0),
          state,
          host: host ? { id: host, fullName: copy.user(host) ?? 'Former member' } : null,
          signInPath:
            site && l?.slug && state === 'planned' ? openHousePath(site, l.slug, id) : null,
          visitors: visitors
            .filter(({ v }) => text(v.open_house_id) === id)
            .map(({ id: visitorId, v }) => ({
              id: visitorId,
              firstName: str(v.first_name) ?? '',
              lastName: str(v.last_name),
              email: str(v.email),
              phone: str(v.phone),
              withAgent: v.with_agent === true,
              agentName: str(v.agent_name),
              smsConsent: v.sms_consent === true,
              signedInAt: isoOr(v.signed_in_at) ?? iso(0),
              personId: text(v.person_id),
              followedUpAt: isoOr(v.followed_up_at),
            })),
        };
      }),
  };
}
