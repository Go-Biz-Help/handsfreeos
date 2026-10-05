/**
 * A listing as its page shows it (round three), shaped once: what the server's `realestate.listing` answers
 * (ops/listing.ts, ops/description.ts) and what the phone works out from its copy (views/listing.ts). Each side reads
 * its own rows into these inputs; the shaping, the defaults and the words are the same.
 *
 * Left to the server: each fact's choices (they read the old listing's pasted words, which stay off phones), the fair
 * housing checks of the description being worked on, and what the person may do.
 *
 * Browser-safe and pure.
 */
import { listingFeedDiffers, mlsOut, mlsStateWords, type MlsSnapshot, type MlsState } from './feed';
import { listingPagePath, streetOf, type ListingHomeFacts, type SellerAnswers } from './listing';

/** The listing's own row, as either side reads it: times as ISO strings. */
export interface ListingRow {
  readonly facts: Readonly<Record<string, unknown>>;
  readonly factsConfirmedAt: string | null;
  readonly factsConfirmedBy: string | null;
  readonly pastedState: 'none' | 'filling' | 'read' | 'failed';
  readonly pastedFailure: string | null;
  readonly highlights: string | null;
  readonly mlsNumber: string | null;
  readonly mlsLiveOn: string | null;
  readonly slug: string | null;
  readonly pageState: 'none' | 'published' | 'down';
  readonly pagePublishedAt: string | null;
  readonly matchesSuggested: number;
  readonly matchesAdded: number;
  readonly matchedAt: string | null;
  readonly mls: MlsSnapshot | null;
  readonly mlsState: MlsState;
  readonly mlsFailure: string | null;
}

export interface ListingPhoto {
  readonly id: string;
  readonly fileId: string;
  readonly name: string;
  readonly position: number;
  readonly caption: string | null;
  readonly public: boolean;
}

/** The seller's questionnaire, if they've started it. */
export interface QuestionnaireRow {
  readonly state: 'draft' | 'submitted';
  readonly answers: SellerAnswers;
  readonly submittedAt: string | null;
}

/** Everything the listing's page shows but each fact's choices, the description and what the person may do. */
export function listingShape(input: {
  readonly dealId: string;
  readonly deal: { readonly stage: string; readonly outcome: string | null };
  readonly listing: ListingRow | null;
  readonly address: string | null;
  readonly questionnaire: QuestionnaireRow | null;
  /** The questionnaire asked for and not yet started: its open task. */
  readonly questionnaireTaskId: string | null;
  /** In order. */
  readonly photos: readonly ListingPhoto[];
  /** The name of whoever confirmed the facts, if they're still known. */
  readonly confirmedByName: string | null;
  readonly listPriceCents: number | null;
}) {
  const { listing: l, questionnaire: q, address } = input;
  const taskId = q ? null : input.questionnaireTaskId;
  // A questionnaire still being filled in is the seller's to finish; only what they sent counts.
  const sent = q?.state === 'submitted' ? q.answers : null;
  return {
    dealId: input.dealId,
    address,
    street: address ? streetOf(address) : null,
    facts: (l?.facts ?? {}) as ListingHomeFacts,
    factsConfirmedAt: l?.factsConfirmedAt ?? null,
    factsConfirmedBy: l?.factsConfirmedBy
      ? { id: l.factsConfirmedBy, fullName: input.confirmedByName ?? 'Former member' }
      : null,
    feed: {
      state: l?.mlsState ?? ('none' as const),
      words: l ? mlsStateWords(l.mlsState, l.mlsFailure) : null,
      mls: l?.mls ? mlsOut(l.mls, (l.facts ?? {}) as ListingHomeFacts) : null,
      differences:
        l?.mls && l.mlsState === 'found'
          ? listingFeedDiffers(
              {
                stage: input.deal.stage,
                listPriceCents: input.listPriceCents,
                closed: input.deal.outcome === 'closed',
              },
              l.mls,
            )
          : [],
    },
    pasted: { state: l?.pastedState ?? ('none' as const), failure: l?.pastedFailure ?? null },
    highlights: l?.highlights ?? null,
    questionnaire: {
      state: q ? q.state : taskId ? ('asked' as const) : ('none' as const),
      taskId,
      submittedAt: q?.submittedAt ?? null,
      updates: sent ? (sent.updates ?? null) : null,
      loves: sent ? (sent.loves ?? null) : null,
    },
    photos: [...input.photos],
    mls: l?.mlsNumber && l.mlsLiveOn ? { number: l.mlsNumber, liveOn: l.mlsLiveOn } : null,
    page: {
      state: l?.pageState ?? ('none' as const),
      slug: l?.slug ?? null,
      publishedAt: l?.pagePublishedAt ?? null,
    },
    listPriceCents: input.listPriceCents,
    matches: {
      suggested: l?.matchesSuggested ?? 0,
      added: l?.matchesAdded ?? 0,
      at: l?.matchedAt ?? null,
    },
  };
}

// ---------- the description ----------

/** The versions still being worked on: the newest of them is the one the agent edits. */
export const DESCRIPTION_WORKING = ['drafting', 'ready', 'failed', 'sent'] as const;
export type DescriptionState = (typeof DESCRIPTION_WORKING)[number] | 'signed' | 'replaced';

/** One version of the description, as either side reads it. */
export interface DescriptionRow {
  readonly id: string;
  readonly version: number;
  readonly words: string | null;
  readonly source: 'ai' | 'person';
  readonly state: DescriptionState;
  readonly failure: string | null;
  readonly signedAt: string | null;
  readonly overrideReason: string | null;
  readonly flagsAcknowledgedAt: string | null;
  readonly flagsAcknowledgedReason: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

const isWorking = (state: DescriptionState): state is (typeof DESCRIPTION_WORKING)[number] =>
  (DESCRIPTION_WORKING as readonly string[]).includes(state);

/**
 * The description in use, the one being worked on (without its checks, which the server adds) and every version,
 * newest first.
 */
export function descriptionShape(all: readonly DescriptionRow[]) {
  const list = [...all].sort((a, b) => b.version - a.version);
  const inUse = list.find((d) => d.state === 'signed') ?? null;
  const working = list.find((d) => isWorking(d.state) && d.version > (inUse?.version ?? 0)) ?? null;
  return {
    inUse: inUse
      ? {
          id: inUse.id,
          version: inUse.version,
          words: inUse.words!,
          signedAt: inUse.signedAt!,
          how: inUse.overrideReason ? ('let_through' as const) : ('portal' as const),
          reason: inUse.overrideReason,
        }
      : null,
    working: working
      ? {
          id: working.id,
          version: working.version,
          words: working.words,
          source: working.source,
          state: working.state as (typeof DESCRIPTION_WORKING)[number],
          failure: working.failure,
          acknowledged:
            working.flagsAcknowledgedAt && working.flagsAcknowledgedReason
              ? { reason: working.flagsAcknowledgedReason, at: working.flagsAcknowledgedAt }
              : null,
          sentAt: working.sentAt,
        }
      : null,
    history: list.map((d) => ({
      id: d.id,
      version: d.version,
      source: d.source,
      state: d.state,
      words: d.words,
      at: d.createdAt,
    })),
  };
}

// ---------- the public page ----------

/** Where the listing's public page stands, and its address under the business's site once it has one. */
export function listingPageOf(
  dealId: string,
  l: Pick<ListingRow, 'slug' | 'pageState'> | null,
  /** The business's site name, if it has one. */
  site: string | null,
) {
  const at = l?.slug ? site : null;
  return {
    dealId,
    state: l?.pageState ?? ('none' as const),
    site: at,
    slug: l?.slug ?? null,
    path: at && l?.slug ? listingPagePath(at, l.slug) : null,
  };
}
