/**
 * The listing, step 3 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core"): the home's facts
 * and its photos, beside a listing deal.
 *
 * - **The facts** come three ways (Chris, 2026-10-01): the seller's questionnaire in their portal, the old listing's
 *   words the agent pastes (the AI reads only those, each fact with the words it came from:
 *   `realestate.listing.fill_facts`, the worker's), or typed by the agent. Only a person confirms them, and only
 *   confirmed facts go on the page, the flyer and into matching. Each confirmed fact keeps where it came from.
 * - **The photos** are the deal's own files, in order, each on the public page or kept for the agent and the seller.
 * - **The list price** is the deal's `list_price` term (round one), read here as it stands.
 */
import { and, asc, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { files } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { feedFacts, type MlsSnapshot } from '../feed';
import { factChoices, streetOf, type FactFrom, type SellerAnswers } from '../listing';
import { listingShape, type ListingRow } from '../listing-shape';
import { realestateAddon } from '../manifest';
import {
  ListingConfirmFactsInput,
  ListingConfirmFactsOutput,
  ListingFillFactsInput,
  ListingFillFactsOutput,
  ListingInput,
  ListingOutput,
  ListingPasteInput,
  ListingPasteOutput,
  ListingPhotoAddInput,
  ListingPhotoRemoveInput,
  ListingPhotosArrangeInput,
  ListingPhotosOutput,
  ListingQuestionnaireRequestInput,
  ListingQuestionnaireRequestOutput,
} from '../schemas';
import {
  clientTasks,
  listingPhotos,
  listings,
  sellerQuestionnaires,
  termEntries,
  type ListingFactSource,
} from '../tables';
import {
  actorKind,
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { descriptionView, mayLetThrough } from './description';
import { propertyOf } from './people';
import { addProof, PROOF_EVENTS } from './proof-hooks';

export type Listing = typeof listings.$inferSelect;

/** A listing's facts, photos and page belong to listing deals. */
export function requireListingSide(deal: Deal): void {
  if (deal.side !== 'listing')
    throw HfosError.rule(
      'realestate_listing_only',
      409,
      `${deal.name} is a buyer deal. A home’s facts, photos and page for selling it go on its listing deal.`,
    );
}

/** The deal's listing row, if it has one yet. */
export async function listingOf(ctx: Ctx, dealId: string, lock = false): Promise<Listing | null> {
  const q = ctx.tx
    .select()
    .from(listings)
    .where(
      and(eq(listings.workspaceId, ctx.scope.workspaceId!), eq(listings.dealRecordId, dealId)),
    );
  const [l] = lock ? await q.for('update') : await q;
  return l ?? null;
}

/** The deal's listing, made the first time anything is kept on it. */
export async function ensureListing(ctx: CommandContext, deal: Deal): Promise<Listing> {
  requireListingSide(deal);
  const found = await listingOf(ctx, deal.recordId, true);
  if (found) return found;
  await ctx.tx
    .insert(listings)
    .values({ workspaceId: deal.workspaceId, dealRecordId: deal.recordId })
    .onConflictDoNothing();
  return (await listingOf(ctx, deal.recordId, true))!;
}

/** The home's address on the deal; a listing needs one before anything about it is shared. */
export async function listingAddress(ctx: Ctx, deal: Deal): Promise<string | null> {
  return (await propertyOf(ctx, deal.recordId))?.address ?? null;
}

/** The deal's list price as it stands: the newest entry not replaced or set aside, confirmed first. */
export async function listPriceOf(ctx: Ctx, dealId: string): Promise<number | null> {
  const [t] = await ctx.tx
    .select({ cents: termEntries.valueCents })
    .from(termEntries)
    .where(
      and(
        eq(termEntries.dealRecordId, dealId),
        eq(termEntries.key, 'list_price'),
        isNull(termEntries.supersededAt),
        isNull(termEntries.rejectedAt),
      ),
    )
    .orderBy(
      dsql`${termEntries.confirmedAt} is null`,
      desc(termEntries.enteredAt),
      desc(termEntries.id),
    )
    .limit(1);
  return t?.cents ?? null;
}

async function questionnaireOf(ctx: Ctx, dealId: string) {
  const [q] = await ctx.tx
    .select()
    .from(sellerQuestionnaires)
    .where(
      and(
        eq(sellerQuestionnaires.workspaceId, ctx.scope.workspaceId!),
        eq(sellerQuestionnaires.dealRecordId, dealId),
      ),
    );
  return q ?? null;
}

async function questionnaireTask(ctx: Ctx, dealId: string) {
  const [t] = await ctx.tx
    .select({ id: clientTasks.id, status: clientTasks.status })
    .from(clientTasks)
    .where(
      and(
        eq(clientTasks.dealRecordId, dealId),
        eq(clientTasks.kind, 'questionnaire'),
        dsql`${clientTasks.status} <> 'canceled'`,
      ),
    )
    .orderBy(desc(clientTasks.createdAt), desc(clientTasks.id))
    .limit(1);
  return t ?? null;
}

/** Everything the listing's page and the deal page read: its facts and their sources, photos, the MLS, the page. */
export async function listingView(ctx: Ctx, deal: Deal) {
  const l = await listingOf(ctx, deal.recordId);
  const address = await listingAddress(ctx, deal);
  const q = await questionnaireOf(ctx, deal.recordId);
  const task = q ? null : await questionnaireTask(ctx, deal.recordId);
  const answers = (q?.answers ?? {}) as SellerAnswers;
  const photos = await ctx.tx
    .select({
      id: listingPhotos.id,
      fileId: listingPhotos.fileId,
      name: files.name,
      position: listingPhotos.position,
      caption: listingPhotos.caption,
      public: listingPhotos.public,
    })
    .from(listingPhotos)
    .innerJoin(files, eq(files.id, listingPhotos.fileId))
    .where(and(eq(listingPhotos.dealRecordId, deal.recordId), isNull(files.deletedAt)))
    .orderBy(asc(listingPhotos.position), asc(listingPhotos.createdAt), asc(listingPhotos.id));
  const names = await userNames(ctx, [l?.factsConfirmedBy ?? null]);
  const pastedFacts = (l?.pastedFacts ?? {}) as Record<string, unknown>;
  const shape = listingShape({
    dealId: deal.recordId,
    deal: { stage: deal.stage, outcome: deal.outcome },
    listing: l ? listingRowOf(l) : null,
    address,
    questionnaire: q
      ? { state: q.state, answers, submittedAt: q.submittedAt?.toISOString() ?? null }
      : null,
    questionnaireTaskId: task?.id ?? null,
    photos,
    confirmedByName: l?.factsConfirmedBy ? (names.get(l.factsConfirmedBy) ?? null) : null,
    listPriceCents: await listPriceOf(ctx, deal.recordId),
  });
  return {
    ...shape,
    choices: factChoices({
      confirmed: (l?.facts ?? {}) as Record<string, unknown>,
      confirmedSources: (l?.factSources ?? {}) as Record<string, ListingFactSource>,
      // A questionnaire still being filled in is the seller's to finish; only what they sent counts.
      seller: q?.state === 'submitted' ? (answers.facts ?? null) : null,
      pasted: pastedFacts,
      pastedQuotes: (l?.pastedSources ?? {}) as Record<string, string>,
      mls: l?.mls ? (feedFacts(l.mls as unknown as MlsSnapshot) as Record<string, unknown>) : null,
    }),
    pasted: { ...shape.pasted, found: Object.keys(pastedFacts).length },
    description: await descriptionView(ctx, deal),
    can: { letThrough: mayLetThrough(ctx) },
  };
}

/** The listing's row as the listing's page reads it (listing-shape.ts). */
function listingRowOf(l: Listing): ListingRow {
  return {
    facts: l.facts,
    factsConfirmedAt: l.factsConfirmedAt?.toISOString() ?? null,
    factsConfirmedBy: l.factsConfirmedBy,
    pastedState: l.pastedState,
    pastedFailure: l.pastedFailure,
    highlights: l.highlights,
    mlsNumber: l.mlsNumber,
    mlsLiveOn: l.mlsLiveOn,
    slug: l.slug,
    pageState: l.pageState,
    pagePublishedAt: l.pagePublishedAt?.toISOString() ?? null,
    matchesSuggested: l.matchesSuggested,
    matchesAdded: l.matchesAdded,
    matchedAt: l.matchedAt?.toISOString() ?? null,
    mls: (l.mls as unknown as MlsSnapshot | null) ?? null,
    mlsState: l.mlsState,
    mlsFailure: l.mlsFailure,
  };
}

// ---------- the listing ----------

export const listingGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.listing',
  description:
    'A listing deal’s listing: the home’s facts and where each came from, what the seller and the old listing say, its photos, when it went live on the MLS, its public page and its list price.',
  input: ListingInput,
  output: ListingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_get_listing',
    description: 'A listing’s facts, photos, MLS status, public page and list price.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireListingSide(deal);
    return { listing: await listingView(ctx, deal) };
  },
});

export const listingPaste = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.paste',
  description:
    'Paste the home’s old listing words: the AI reads only these for its facts, each with the words it came from, for the agent to confirm. Replaces what was pasted before.',
  risk: 1,
  input: ListingPasteInput,
  output: ListingPasteOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.pasted'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    await ensureListing(ctx, deal);
    await ctx.tx
      .update(listings)
      .set({
        pastedText: input.text,
        pastedState: 'filling',
        pastedFacts: {},
        pastedSources: {},
        pastedModel: null,
        pastedFailure: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(listings.workspaceId, deal.workspaceId), eq(listings.dealRecordId, deal.recordId)),
      );
    await ctx.emit({
      type: 'realestate.listing.pasted',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {},
      broadcast: false,
    });
    return { dealId: deal.recordId, filling: true };
  },
});

export const listingFillFacts = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.fill_facts',
  description:
    'Worker: the facts the AI found in a listing’s pasted old words, each with the words it came from, for the agent to check. Or why it couldn’t read them.',
  risk: 0,
  input: ListingFillFactsInput,
  output: ListingFillFactsOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.listing.facts_read'],
  async handler(ctx, input) {
    const l = await listingOf(ctx, input.dealId, true);
    // Pasted again since, or nothing waiting on the AI.
    if (!l || l.pastedState !== 'filling')
      return { dealId: input.dealId, state: 'skipped' as const };
    const failed = !!input.failure || Object.keys(input.facts).length === 0;
    await ctx.tx
      .update(listings)
      .set(
        failed
          ? {
              pastedState: 'failed',
              pastedFailure:
                input.failure ??
                'The old listing’s words didn’t say the home’s facts clearly enough. Enter them yourself.',
              pastedModel: input.model ?? null,
              updatedAt: new Date(),
            }
          : {
              pastedState: 'read',
              pastedFacts: input.facts,
              pastedSources: input.sources,
              pastedModel: input.model ?? null,
              pastedFailure: null,
              updatedAt: new Date(),
            },
      )
      .where(
        and(eq(listings.workspaceId, l.workspaceId), eq(listings.dealRecordId, l.dealRecordId)),
      );
    await ctx.emit({
      type: 'realestate.listing.facts_read',
      entityType: 'realestate_deal',
      entityId: l.dealRecordId,
      payload: {
        state: failed ? 'failed' : 'read',
        found: Object.keys(input.facts).length,
        dropped: input.dropped,
      },
      broadcast: false,
    });
    return { dealId: l.dealRecordId, state: failed ? ('failed' as const) : ('read' as const) };
  },
});

export const listingConfirmFacts = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.confirm_facts',
  description:
    'Confirm a listing’s facts as the agent checked them, each saying where it came from: the seller’s questionnaire, the old listing, or typed. Only these go on the page and the flyer. The AI suggests; only a person confirms.',
  risk: 1,
  input: ListingConfirmFactsInput,
  output: ListingConfirmFactsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.facts_confirmed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    if (actorKind(ctx) !== 'person')
      throw HfosError.forbidden(
        'Only a person confirms a home’s facts, from the listing’s facts page.',
      );
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const l = await ensureListing(ctx, deal);
    const quotes = (l.pastedSources ?? {}) as Record<string, string>;
    const sources: Record<string, ListingFactSource> = {};
    for (const key of Object.keys(input.facts)) {
      const from: FactFrom = input.sources[key as keyof typeof input.sources] ?? 'agent';
      sources[key] = from === 'pasted' && quotes[key] ? { from, quote: quotes[key] } : { from };
    }
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(listings)
      .set({
        facts: input.facts,
        factSources: sources,
        factsConfirmedBy: actorUserId(ctx),
        factsConfirmedAt: at,
        ...(input.highlights !== undefined ? { highlights: input.highlights } : {}),
        updatedAt: at,
      })
      .where(
        and(eq(listings.workspaceId, deal.workspaceId), eq(listings.dealRecordId, deal.recordId)),
      );
    const address = (await listingAddress(ctx, deal)) ?? deal.name;
    await historyLine(ctx, deal, 'listing_facts', {
      after: { address, count: Object.keys(input.facts).length },
    });
    // S-09 "Collect property information": the confirmed facts are its record.
    await addProof(
      ctx,
      deal,
      { keys: ['S-09'] },
      {
        kind: 'record',
        refKind: 'listing',
        refId: deal.recordId,
        body: `The facts of ${streetOf(address)}, confirmed`,
      },
    );
    await ctx.emit({
      type: 'realestate.listing.facts_confirmed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { count: Object.keys(input.facts).length },
    });
    return { dealId: deal.recordId, confirmedAt: at.toISOString() };
  },
});

export const listingRequestQuestionnaire = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.request_questionnaire',
  description:
    'Ask the seller to tell us about their home in their portal: its beds, baths, size, year built, HOA and garage, what they’ve updated and what they love about it. Asked once; asking again gives the same task.',
  risk: 1,
  input: ListingQuestionnaireRequestInput,
  output: ListingQuestionnaireRequestOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.client_task.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    await ensureListing(ctx, deal);
    const open = await questionnaireTask(ctx, deal.recordId);
    if (open) return { taskId: open.id, created: false };
    const [t] = await ctx.tx
      .insert(clientTasks)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: 'questionnaire',
        title: 'Tell us about your home',
        detail:
          'A few questions about your home: its rooms and size, what you’ve updated, and what you love about it. Save as you go, and send it when you’re done.',
        forPersonId: input.forPersonId ?? null,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: clientTasks.id });
    await historyLine(ctx, deal, 'client_task_added', {
      after: { title: 'Tell us about your home', kind: 'questionnaire' },
    });
    await ctx.emit({
      type: 'realestate.client_task.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { taskId: t!.id, kind: 'questionnaire' },
    });
    return { taskId: t!.id, created: true };
  },
});

// ---------- photos ----------

async function photoCount(ctx: Ctx, dealId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_realestate.listing_photos where deal_record_id = ${dealId}`,
  );
  return r?.n ?? 0;
}

export const listingPhotoAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.photo_add',
  description:
    'Add one of the deal’s uploaded photos to the listing, at the end. It’s on the public page and the flyer unless it’s kept for the agent and the seller.',
  risk: 1,
  input: ListingPhotoAddInput,
  output: ListingPhotosOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.photos_changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    await ensureListing(ctx, deal);
    const [f] = await rows<{ id: string; mime_type: string | null; name: string }>(
      ctx.tx,
      sql`select id, mime_type, name from app.files where id = ${input.fileId}
            and workspace_id = ${deal.workspaceId} and record_type = 'custom_record'
            and record_id = ${deal.recordId} and status = 'ready' and deleted_at is null`,
    );
    if (!f)
      throw HfosError.notFound(
        `That photo isn’t uploaded to ${deal.name}. Upload it to the deal’s files first, then add it.`,
      );
    if (!f.mime_type?.startsWith('image/'))
      throw HfosError.rule(
        'realestate_photo_not_image',
        422,
        `${f.name} isn’t a photo. Add a JPEG, PNG or WebP image.`,
      );
    const n = await photoCount(ctx, deal.recordId);
    await ctx.tx
      .insert(listingPhotos)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        fileId: f.id,
        position: n,
        caption: input.caption ?? null,
        public: input.public,
        addedBy: actorUserId(ctx),
      })
      .onConflictDoNothing();
    // S-18 "Organize listing photos": the listing's photos are its record.
    await addProof(
      ctx,
      deal,
      { keys: ['S-18'] },
      {
        kind: 'record',
        refKind: 'listing_photos',
        refId: deal.recordId,
        body: 'The listing’s photos',
      },
    );
    await ctx.emit({
      type: 'realestate.listing.photos_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { added: f.id },
      broadcast: false,
    });
    return { dealId: deal.recordId, photos: await photoCount(ctx, deal.recordId) };
  },
});

export const listingPhotosArrange = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.photos_arrange',
  description:
    'Put a listing’s photos in order, with their captions, and say which the public page shows. Every photo is listed, in the order shown.',
  risk: 1,
  input: ListingPhotosArrangeInput,
  output: ListingPhotosOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.photos_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireListingSide(deal);
    const have = await ctx.tx
      .select({ id: listingPhotos.id })
      .from(listingPhotos)
      .where(eq(listingPhotos.dealRecordId, deal.recordId));
    const ids = new Set(have.map((p) => p.id));
    if (
      input.photos.length !== ids.size ||
      !input.photos.every((p) => ids.has(p.id)) ||
      new Set(input.photos.map((p) => p.id)).size !== input.photos.length
    )
      throw HfosError.conflict(
        'The photos changed since you opened them. Refresh, then put them in order again.',
        'realestate_photos_changed',
      );
    for (const [position, p] of input.photos.entries())
      await ctx.tx
        .update(listingPhotos)
        .set({ position, caption: p.caption, public: p.public })
        .where(eq(listingPhotos.id, p.id));
    await ctx.emit({
      type: 'realestate.listing.photos_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { arranged: input.photos.length },
      broadcast: false,
    });
    return { dealId: deal.recordId, photos: input.photos.length };
  },
});

export const listingPhotoRemove = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.photo_remove',
  description:
    'Take a photo off the listing. The file stays in the deal’s files; the page and the flyer stop showing it.',
  risk: 1,
  input: ListingPhotoRemoveInput,
  output: ListingPhotosOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.photos_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireListingSide(deal);
    const gone = await ctx.tx
      .delete(listingPhotos)
      .where(
        and(eq(listingPhotos.id, input.photoId), eq(listingPhotos.dealRecordId, deal.recordId)),
      )
      .returning({ id: listingPhotos.id });
    if (gone.length)
      await rows(
        ctx.tx,
        sql`update addon_realestate.listing_photos p set position = o.n
            from (select id, (row_number() over (order by position, created_at) - 1)::int as n
                  from addon_realestate.listing_photos where deal_record_id = ${deal.recordId}) o
            where p.id = o.id and p.position <> o.n`,
      );
    await ctx.emit({
      type: 'realestate.listing.photos_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { removed: input.photoId },
      broadcast: false,
    });
    return { dealId: deal.recordId, photos: await photoCount(ctx, deal.recordId) };
  },
});

/** A line on the deal's timeline about the listing, in the add-on's words. */
export const listingLine = (ctx: CommandContext, deal: Deal, words: string, eventId?: string) =>
  dealLine(ctx, deal, words, eventId ? { eventId } : {});

export const listingQueries = [listingGet] as const;
export const listingCommands = [
  listingPaste,
  listingFillFacts,
  listingConfirmFacts,
  listingRequestQuestionnaire,
  listingPhotoAdd,
  listingPhotosArrange,
  listingPhotoRemove,
] as const;
