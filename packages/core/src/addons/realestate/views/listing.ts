/**
 * A listing from a phone's copy (Real Estate round six): its page (`realestate.listing`), its price changes
 * (`realestate.listing.prices`), its marketing (`realestate.listing.marketing`) and its flyer
 * (`realestate.listing.flyer`), worked out from the rows the phone keeps. `listing-shape.ts` shapes the listing's page
 * for the server and the phone alike. `packages/core/test/addons/realestate-phone-listing.test.ts` holds each to the
 * server's answer.
 *
 * A listing's own rows go only to the deal's people: on a deal kept as its summary (someone who sees every deal, not
 * on this one) each view is null and waits for signal. So is one asked of a buyer deal, which the server refuses.
 *
 * Left to the server, and so not in these views:
 * - each fact's choices, and how many facts the old listing's words gave: they read the pasted words, which stay
 *   off phones;
 * - the fair housing checks of the description being worked on and of the social posts, and whether the description
 *   can go to the seller yet (which waits on them): a check counts for words by their hash, which phones don't work
 *   out;
 * - whether the person may let a description or a price through without the seller (their permissions).
 *
 * The seller's first name (a price signed in the portal) comes from the phone's people (`copy.personParts`).
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import type { MlsSnapshot, MlsState } from '../feed';
import {
  cityLineOf,
  factLines,
  noHomeWords,
  notOnMlsWords,
  streetOf,
  unsignedWords,
  type SellerAnswers,
} from '../listing';
import {
  descriptionShape,
  listingPageOf,
  listingShape,
  type DescriptionRow,
  type DescriptionState,
  type ListingPhoto,
  type ListingRow,
  type QuestionnaireRow,
} from '../listing-shape';
import type {
  ListingFlyerOutput,
  ListingMarketingOutput,
  ListingOutput,
  ListingPricesOutput,
} from '../schemas';
import { feedbackSummary, type ShowingFeedback, type ShowingState } from '../showings';
import { termsNow } from '../terms';
import { holdsWhole, isoOr, termEntriesOfCopy } from './deal-facts';
import { byText, iso, ms, text, type CopyDeal, type RealestateCopy } from './synced';

type ListingOut = z.infer<typeof ListingOutput>['listing'];
type DescriptionOut = ListingOut['description'];
type WorkingOut = NonNullable<DescriptionOut['working']>;
export type ListingDescriptionView = Omit<DescriptionOut, 'working'> & {
  readonly working: Omit<WorkingOut, 'flags' | 'checked' | 'blocked'> | null;
};
export type ListingView = Omit<ListingOut, 'choices' | 'pasted' | 'description' | 'can'> & {
  readonly pasted: Omit<ListingOut['pasted'], 'found'>;
  readonly description: ListingDescriptionView;
};
export type ListingPricesView = z.infer<typeof ListingPricesOutput>;
type MarketingOut = z.infer<typeof ListingMarketingOutput>;
type PostOut = MarketingOut['posts']['items'][number];
export type ListingMarketingView = Omit<MarketingOut, 'posts'> & {
  readonly posts: Omit<MarketingOut['posts'], 'items'> & {
    readonly items: Omit<PostOut, 'flags' | 'checked'>[];
  };
};
export type ListingFlyer = z.infer<typeof ListingFlyerOutput>;
/** The flyer, or why the server refuses it: its rule and words, worked out the same. */
export type ListingFlyerView =
  | { readonly flyer: ListingFlyer; readonly refused: null }
  | { readonly flyer: null; readonly refused: { readonly rule: string; readonly words: string } };

const isSet = (v: unknown) => v !== null && v !== undefined;
const num = (v: unknown) => Number(v ?? 0) || 0;
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The deal, when the phone holds it whole and it's on the side asked for. */
export function wholeDeal(
  copy: RealestateCopy,
  dealId: string,
  userId: string | null,
  side?: 'listing' | 'buyer',
): CopyDeal | null {
  const deal = copy.deals.get(dealId);
  if (!deal || !holdsWhole(copy, dealId, userId)) return null;
  return side && text(deal.data.side) !== side ? null : deal;
}

/** The home's address on the deal: its latest home, as the server's `listingAddress` finds it. */
export function addressOfCopy(copy: RealestateCopy, dealId: string): string | null {
  const home = copy.homes.get(dealId);
  return home ? copy.record(home) : null;
}

/** The deal's list price as it stands: the newest entry not replaced or set aside, confirmed first (`listPriceOf`). */
export function listPriceOfCopy(copy: RealestateCopy, dealId: string): number | null {
  const [top] = copy
    .rows('term_entries', dealId)
    .filter(
      ({ data: e }) =>
        text(e.key) === 'list_price' && !isSet(e.superseded_at) && !isSet(e.rejected_at),
    )
    .map(({ id, data: e }) => ({
      id,
      cents: isSet(e.value_cents) ? Number(e.value_cents) : null,
      unconfirmed: isSet(e.confirmed_at) ? 0 : 1,
      at: ms(e.entered_at) ?? 0,
    }))
    .sort((a, b) => a.unconfirmed - b.unconfirmed || b.at - a.at || byText(b.id, a.id));
  return top?.cents ?? null;
}

/** The listing's own row, as `listing-shape.ts` reads it, or null when it has none yet. */
export function listingRowOfCopy(copy: RealestateCopy, dealId: string): ListingRow | null {
  const r = copy.rows('listings', dealId)[0]?.data;
  if (!r) return null;
  return {
    facts: record(r.facts) ?? {},
    factsConfirmedAt: isoOr(r.facts_confirmed_at),
    factsConfirmedBy: text(r.facts_confirmed_by),
    pastedState: (text(r.pasted_state) ?? 'none') as ListingRow['pastedState'],
    pastedFailure: text(r.pasted_failure),
    highlights: text(r.highlights),
    mlsNumber: text(r.mls_number),
    mlsLiveOn: text(r.mls_live_on),
    slug: text(r.slug),
    pageState: (text(r.page_state) ?? 'none') as ListingRow['pageState'],
    pagePublishedAt: isoOr(r.page_published_at),
    matchesSuggested: num(r.matches_suggested),
    matchesAdded: num(r.matches_added),
    matchedAt: isoOr(r.matched_at),
    mls: record(r.mls) as MlsSnapshot | null,
    mlsState: (text(r.mls_state) ?? 'none') as MlsState,
    mlsFailure: text(r.mls_failure),
  };
}

/** The listing's photos whose files the phone holds, in order (a photo shows with its file, as on the server). */
export function photosOfCopy(copy: RealestateCopy, dealId: string): ListingPhoto[] {
  return copy
    .rows('listing_photos', dealId)
    .flatMap(({ id, data: p }) => {
      const fileId = text(p.file_id) ?? '';
      const name = copy.file(fileId);
      if (name === null) return [];
      const photo: ListingPhoto = {
        id,
        fileId,
        name,
        position: num(p.position),
        caption: text(p.caption),
        public: p.public === true,
      };
      return [{ photo, at: ms(p.created_at) ?? 0 }];
    })
    .sort(
      (a, b) =>
        a.photo.position - b.photo.position || a.at - b.at || byText(a.photo.id, b.photo.id),
    )
    .map((p) => p.photo);
}

function descriptionRowsOfCopy(copy: RealestateCopy, dealId: string): DescriptionRow[] {
  return copy.rows('listing_descriptions', dealId).map(({ id, data: d }) => ({
    id,
    version: num(d.version),
    words: text(d.words),
    source: (text(d.source) ?? 'ai') as DescriptionRow['source'],
    state: (text(d.state) ?? 'drafting') as DescriptionState,
    failure: text(d.failure),
    signedAt: isoOr(d.signed_at),
    overrideReason: text(d.override_reason),
    flagsAcknowledgedAt: isoOr(d.flags_acknowledged_at),
    flagsAcknowledgedReason: text(d.flags_acknowledged_reason),
    sentAt: isoOr(d.sent_at),
    createdAt: isoOr(d.created_at) ?? iso(0),
  }));
}

/** The description the seller signed off and in use, if there is one. */
const descriptionInUseOfCopy = (copy: RealestateCopy, dealId: string): string | null =>
  descriptionShape(descriptionRowsOfCopy(copy, dealId)).inUse?.words ?? null;

// ---------- the listing ----------

export function listingOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): ListingView | null {
  const deal = wholeDeal(copy, dealId, ctx.userId, 'listing');
  if (!deal) return null;
  const l = listingRowOfCopy(copy, dealId);
  const q = copy.rows('seller_questionnaires', dealId)[0]?.data;
  const questionnaire: QuestionnaireRow | null = q
    ? {
        state: (text(q.state) ?? 'draft') as QuestionnaireRow['state'],
        answers: (record(q.answers) ?? {}) as SellerAnswers,
        submittedAt: isoOr(q.submitted_at),
      }
    : null;
  // The questionnaire asked for: the newest of its tasks not taken back.
  const [task] = copy
    .rows('client_tasks', dealId)
    .filter(({ data: t }) => text(t.kind) === 'questionnaire' && text(t.status) !== 'canceled')
    .sort(
      (a, b) => (ms(b.data.created_at) ?? 0) - (ms(a.data.created_at) ?? 0) || byText(b.id, a.id),
    );
  return {
    ...listingShape({
      dealId,
      deal: { stage: text(deal.data.stage) ?? '', outcome: text(deal.data.outcome) },
      listing: l,
      address: addressOfCopy(copy, dealId),
      questionnaire,
      questionnaireTaskId: task?.id ?? null,
      photos: photosOfCopy(copy, dealId),
      confirmedByName: l?.factsConfirmedBy ? copy.user(l.factsConfirmedBy) : null,
      listPriceCents: listPriceOfCopy(copy, dealId),
    }),
    description: descriptionShape(descriptionRowsOfCopy(copy, dealId)),
  };
}

// ---------- price changes ----------

export function listingPricesOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): ListingPricesView | null {
  if (!wholeDeal(copy, dealId, ctx.userId, 'listing')) return null;
  const sellers = new Set(
    (copy.linksTo.get(dealId) ?? []).flatMap((l) =>
      l.addonKey === 'realestate_client' && l.personId ? [l.personId] : [],
    ),
  );
  const who = (id: string | null) =>
    id ? { id, fullName: copy.user(id) ?? 'Former member' } : null;
  const history = [...copy.rows('listing_prices', dealId)]
    .sort(
      (a, b) => (ms(b.data.proposed_at) ?? 0) - (ms(a.data.proposed_at) ?? 0) || byText(b.id, a.id),
    )
    .map(({ id, data: p }) => {
      const state = (text(p.state) ?? 'waiting') as ListingPricesView['history'][number]['state'];
      const overrideReason = text(p.override_reason);
      const signedBy = text(p.signed_by_person_id);
      return {
        id,
        fromCents: num(p.from_cents),
        toCents: num(p.to_cents),
        words: text(p.words) ?? '',
        note: text(p.note),
        state,
        how:
          state !== 'applied'
            ? null
            : overrideReason !== null
              ? ('let_through' as const)
              : ('portal' as const),
        signedBy: signedBy
          ? ((sellers.has(signedBy) ? (copy.personParts(signedBy)?.firstName ?? null) : null) ??
            'The seller')
          : null,
        overrideBy: who(text(p.override_by)),
        overrideReason,
        appliedAt: isoOr(p.applied_at),
        withdrawnReason: text(p.withdrawn_reason),
        taskId: text(p.client_task_id),
        proposedAt: isoOr(p.proposed_at) ?? iso(0),
        proposedBy: who(text(p.proposed_by)),
      };
    });
  const shown = feedbackSummary(
    copy.rows('showings', dealId).map(({ data: s }) => ({
      state: (text(s.state) ?? 'requested') as ShowingState,
      feedback: record(s.feedback) as ShowingFeedback | null,
    })),
  );
  return {
    dealId,
    currentCents:
      termsNow(termEntriesOfCopy(copy, dealId)).get('list_price')?.current?.valueCents ?? null,
    waiting: history.find((p) => p.state === 'waiting') ?? null,
    history,
    showings: {
      showings: shown.showings,
      answered: shown.answered,
      averageInterest: shown.averageInterest,
      priceHigh: shown.price.high,
      words: `${shown.words}${shown.price.high ? ` · ${shown.price.high} said the price was high` : ''}`,
    },
  };
}

// ---------- marketing ----------

export function listingMarketingOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): ListingMarketingView | null {
  const deal = wholeDeal(copy, dealId, ctx.userId, 'listing');
  if (!deal) return null;
  const l = listingRowOfCopy(copy, dealId);
  const address = addressOfCopy(copy, dealId) ?? deal.name;
  const live = l?.mlsNumber && l.mlsLiveOn ? { number: l.mlsNumber, liveOn: l.mlsLiveOn } : null;
  // The newest batch of social posts, in order.
  const all = copy.rows('listing_posts', dealId).map(({ id, data: p }) => ({
    id,
    batch: num(p.batch),
    position: num(p.position),
    words: text(p.words),
    state: text(p.state) ?? '',
    failure: text(p.failure),
    edited: isSet(p.edited_at),
  }));
  const last = Math.max(0, ...all.map((p) => p.batch));
  const posts = all
    .filter((p) => p.batch === last)
    .sort((a, b) => a.position - b.position || byText(a.id, b.id));
  return {
    dealId,
    mls: live,
    hold: live ? null : notOnMlsWords(address),
    page: listingPageOf(dealId, l, copy.bookingSlug),
    ready: {
      facts: !!l?.factsConfirmedAt,
      description: !!descriptionInUseOfCopy(copy, dealId),
      photos: photosOfCopy(copy, dealId).filter((p) => p.public).length,
    },
    posts: {
      state: !posts.length
        ? 'none'
        : posts.some((p) => p.state === 'drafting')
          ? 'drafting'
          : posts.every((p) => p.state === 'failed')
            ? 'failed'
            : 'ready',
      failure: posts.find((p) => p.state === 'failed')?.failure ?? null,
      items: posts
        .filter((p) => p.state === 'ready')
        .map((p) => ({ id: p.id, position: p.position, words: p.words, edited: p.edited })),
    },
  };
}

// ---------- the flyer ----------

const refused = (rule: string, words: string): ListingFlyerView => ({
  flyer: null,
  refused: { rule, words },
});

/** The flyer, or why it can't be made yet, as the server says it. Null when the phone doesn't hold the deal whole. */
export function listingFlyerOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): ListingFlyerView | null {
  // Any deal the phone holds whole, as on the server: one with no listing isn't live on the MLS.
  const deal = wholeDeal(copy, dealId, ctx.userId);
  if (!deal) return null;
  const address = addressOfCopy(copy, dealId);
  if (!address) return refused('realestate_listing_no_address', noHomeWords(deal.name));
  const l = listingRowOfCopy(copy, dealId);
  if (!l?.mlsNumber || !l.mlsLiveOn)
    return refused('realestate_not_on_mls', notOnMlsWords(address));
  const description = descriptionInUseOfCopy(copy, dealId);
  if (!description) return refused('realestate_description_unsigned', unsignedWords('flyer'));
  const page = listingPageOf(dealId, l, copy.bookingSlug);
  return {
    refused: null,
    flyer: {
      street: streetOf(address),
      cityLine: cityLineOf(address),
      priceCents: listPriceOfCopy(copy, dealId),
      facts: factLines(l.facts),
      description,
      photos: photosOfCopy(copy, dealId)
        .filter((p) => p.public)
        .slice(0, 4)
        .map((p) => ({ fileId: p.fileId, caption: p.caption })),
      agentName: deal.ownerUserId ? copy.user(deal.ownerUserId) : null,
      mlsNumber: l.mlsNumber,
      page:
        page.state === 'published' && page.site && page.slug && page.path
          ? { site: page.site, slug: page.slug, path: page.path }
          : null,
    },
  };
}
