/**
 * Live on the MLS, and marketing: steps 5 and 6 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core").
 *
 * - **The hold** (Chris, 2026-10-01): nothing public goes before the listing is live on the MLS: its page, the flyer,
 *   an email or text to the business's contacts, the social posts, the open house sign-in and matching to buyers are
 *   all refused until it is (`realestate_not_on_mls`). Nothing lets it through: it's the MLS's rule.
 * - **Live on the MLS** is the agent's word, with its number and day, and the MLS page as proof if they have it
 *   (S-20). A listing still before Active moves there.
 * - **The page** shows only confirmed facts, the photos marked for it and the signed-off description. Published, it's
 *   under the business's site (`/a/<site>/realestate/<slug>`); it shows when the deal is under contract or sold, and
 *   comes down when the listing is withdrawn, expires or is cancelled.
 * - **Email or text to contacts** starts a core campaign with exact words made from the signed-off description and
 *   read by the fair housing list; the agent approves it in Campaigns as any other.
 */
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { bookingSites, files } from '@hfos/db/schema';
import { ensureBookingSite } from '../../../calendar/site';
import { campaignCreate } from '../../../commands/campaign';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { money } from '../../../money/format';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { checkWords, FAIR_HOUSING_WORDS_VERSION, type FairHousingFlag } from '../fair-housing';
import { factWords, LISTING_FACTS } from '../homes';
import {
  LISTING_HOME_FACT_KEYS,
  listingEmailWords,
  listingPagePath,
  listingSlugFrom,
  listingTextWords,
  notOnMlsWords,
  streetOf,
} from '../listing';
import { realestateAddon } from '../manifest';
import {
  ListingCampaignInput,
  ListingCampaignOutput,
  ListingFlyerOutput,
  ListingInput,
  ListingMarkLiveInput,
  ListingMarkLiveOutput,
  ListingMarketingOutput,
  ListingPageOutput,
  ListingPostCheckedInput,
  ListingPostOutput,
  ListingPostSaveInput,
  ListingPostsDraftedInput,
  ListingPostsOutput,
  ListingPostsRequestInput,
} from '../schemas';
import { LISTING_STAGES } from '../states';
import {
  documents,
  listingDescriptions,
  listingPhotos,
  listingPosts,
  listings,
  type PostChecks,
} from '../tables';
import { textHashOf } from './client-updates';
import {
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireOpen,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { dealMoveStage } from './deals';
import {
  ensureListing,
  listingAddress,
  listingOf,
  listPriceOf,
  requireListingSide,
  type Listing,
} from './listing';
import { addProof, documentProof, PROOF_EVENTS } from './proof-hooks';

/** The hold: nothing public before the listing is live on the MLS. */
export async function requireOnMls(ctx: Ctx, deal: Deal): Promise<Listing> {
  const l = await listingOf(ctx, deal.recordId);
  if (!l?.mlsNumber || !l.mlsLiveOn)
    throw HfosError.rule(
      'realestate_not_on_mls',
      409,
      notOnMlsWords((await listingAddress(ctx, deal)) ?? deal.name),
    );
  return l;
}

/** The address a listing's public things need; refused without one. */
async function requireAddress(ctx: Ctx, deal: Deal): Promise<string> {
  const address = await listingAddress(ctx, deal);
  if (!address)
    throw HfosError.rule(
      'realestate_listing_no_address',
      409,
      `${deal.name} has no home on it yet. Add the home’s address on the deal’s page first.`,
    );
  return address;
}

/** The signed-off description in use, if there is one. */
export async function descriptionInUse(ctx: Ctx, dealId: string): Promise<string | null> {
  const [d] = await ctx.tx
    .select({ words: listingDescriptions.words })
    .from(listingDescriptions)
    .where(
      and(eq(listingDescriptions.dealRecordId, dealId), eq(listingDescriptions.state, 'signed')),
    );
  return d?.words ?? null;
}

/** The confirmed facts, in words, in the order they're shown. */
export function factLines(facts: Record<string, unknown>) {
  return LISTING_HOME_FACT_KEYS.filter((k) => facts[k] !== undefined && facts[k] !== null).map(
    (k) => ({ label: LISTING_FACTS[k].label, words: factWords(k, facts[k]) }),
  );
}

/** The photos the public page and the flyer show, in order. */
export async function publicPhotos(ctx: Ctx, dealId: string) {
  return ctx.tx
    .select({ fileId: listingPhotos.fileId, caption: listingPhotos.caption })
    .from(listingPhotos)
    .innerJoin(files, eq(files.id, listingPhotos.fileId))
    .where(
      and(
        eq(listingPhotos.dealRecordId, dealId),
        eq(listingPhotos.public, true),
        isNull(files.deletedAt),
      ),
    )
    .orderBy(asc(listingPhotos.position));
}

const cityLineOf = (address: string): string | null =>
  address.split(',').slice(1).join(',').trim() || null;

// ---------- live on the MLS ----------

export const listingMarkLive = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.mark_live',
  description:
    'Mark a listing live on the MLS, with its MLS number and the day it went live, and the MLS page as proof if there is one. Until then nothing about it is shared outside the office. A listing before Active moves there.',
  risk: 1,
  input: ListingMarkLiveInput,
  output: ListingMarkLiveOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_mark_listing_live',
    description:
      'Mark a listing live on the MLS with its MLS number and the day. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.listing.live', 'realestate.deal.stage_changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    return markListingLive(ctx, input);
  },
});

/**
 * Marks a listing live on the MLS: its number and day kept, its MLS-input duty's proof, Active if it was before it,
 * and `realestate.listing.live`. A person does it (`realestate.listing.mark_live`), or the listing feed seeing it
 * Active on the MLS (round five), whose words then say so on the proof.
 */
export async function markListingLive(
  ctx: CommandContext,
  input: {
    readonly dealId: string;
    readonly mlsNumber: string;
    readonly liveOn: string;
    readonly documentId?: string | undefined;
    /** "From the MLS, through Repliers": it was the feed that saw it live. */
    readonly fromFeed?: string | undefined;
  },
): Promise<{ dealId: string; liveOn: string; movedTo: string | null }> {
  const deal = await loadDeal(ctx, input.dealId, { lock: true });
  requireOpen(deal);
  const address = await requireAddress(ctx, deal);
  const today = todayIn(await timeZoneOf(ctx));
  if (input.liveOn > today)
    throw HfosError.validation(
      [{ path: 'liveOn', message: 'Mark it live on the day it goes live, not before.' }],
      'Mark it live on the day it goes live, not before.',
    );
  const l = await ensureListing(ctx, deal);
  if (input.documentId) {
    const [doc] = await ctx.tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.dealRecordId, deal.recordId)));
    if (!doc)
      throw HfosError.notFound(
        `That document isn’t on ${deal.name}. Upload the MLS page to the deal’s documents first, then pick it.`,
      );
  }
  const at = changeMoment(ctx.meta);
  await ctx.tx
    .update(listings)
    .set({
      mlsNumber: input.mlsNumber,
      mlsLiveOn: input.liveOn,
      mlsMarkedBy: actorUserId(ctx),
      mlsMarkedAt: at,
      updatedAt: at,
    })
    .where(and(eq(listings.workspaceId, l.workspaceId), eq(listings.dealRecordId, l.dealRecordId)));
  await historyLine(ctx, deal, 'listing_live', {
    before: l.mlsNumber ? { mlsNumber: l.mlsNumber, liveOn: l.mlsLiveOn } : null,
    after: {
      mlsNumber: input.mlsNumber,
      liveOn: input.liveOn,
      address,
      ...(input.fromFeed ? { from: input.fromFeed } : {}),
    },
  });
  // S-20 "Enter listing into MLS": the MLS page is its document; the number and day, its record.
  await addProof(
    ctx,
    deal,
    { keys: ['S-20'] },
    {
      kind: 'record',
      refKind: 'listing_mls',
      refId: deal.recordId,
      body: `Live on the MLS since ${input.liveOn}, #${input.mlsNumber}${input.fromFeed ? ` (${input.fromFeed})` : ''}`,
    },
  );
  if (input.documentId) await documentProof(ctx, deal, input.documentId);
  const at0 = LISTING_STAGES.indexOf(deal.stage as (typeof LISTING_STAGES)[number]);
  let movedTo: string | null = null;
  if (at0 >= 0 && at0 < LISTING_STAGES.indexOf('active')) {
    await executeCommandWithin(ctx, dealMoveStage, {
      workspaceId: deal.workspaceId,
      dealId: deal.recordId,
      stage: 'active',
    });
    movedTo = 'active';
  }
  await ctx.emit({
    type: 'realestate.listing.live',
    entityType: 'realestate_deal',
    entityId: deal.recordId,
    payload: { mlsNumber: input.mlsNumber, liveOn: input.liveOn, first: !l.mlsNumber },
  });
  return { dealId: deal.recordId, liveOn: input.liveOn, movedTo };
}

// ---------- the public page ----------

async function pageOut(ctx: Ctx, deal: Deal, l: Listing | null) {
  const site = l?.slug ? await ensureSiteSlug(ctx, deal.workspaceId) : null;
  return {
    dealId: deal.recordId,
    state: l?.pageState ?? ('none' as const),
    site,
    slug: l?.slug ?? null,
    path: site && l?.slug ? listingPagePath(site, l.slug) : null,
  };
}

/** The business's site name, if it has one (publishing makes one). */
async function ensureSiteSlug(ctx: Ctx, workspaceId: string): Promise<string | null> {
  const [s] = await ctx.tx
    .select({ slug: bookingSites.slug })
    .from(bookingSites)
    .where(eq(bookingSites.workspaceId, workspaceId));
  return s ? String(s.slug) : null;
}

/** A page address no other listing of the business has: the street, then -2, -3. */
async function freeSlug(ctx: CommandContext, deal: Deal, address: string): Promise<string> {
  const base = listingSlugFrom(address);
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 74)}-${n}`;
    const [taken] = await ctx.tx
      .select({ id: listings.dealRecordId })
      .from(listings)
      .where(
        and(
          eq(listings.workspaceId, deal.workspaceId),
          eq(listings.slug, slug),
          ne(listings.dealRecordId, deal.recordId),
        ),
      );
    if (!taken) return slug;
  }
  throw new Error(`no free page address for ${deal.recordId}`);
}

export const listingPagePublish = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.page_publish',
  description:
    'Put a listing’s public page up, under the business’s site: its confirmed facts, the photos marked for it, its signed-off description and its open houses. Refused before it’s live on the MLS.',
  risk: 2,
  input: ListingInput,
  output: ListingPageOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_publish_listing_page',
    description: 'Put a live listing’s public page up. Always asks the person first.',
  },
  emits: ['realestate.listing.page_changed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const address = await requireAddress(ctx, deal);
    const l = await requireOnMls(ctx, deal);
    if (!l.factsConfirmedAt)
      throw HfosError.rule(
        'realestate_listing_no_facts',
        409,
        'Confirm the home’s facts first: the page shows only what you’ve confirmed.',
      );
    if (!(await descriptionInUse(ctx, deal.recordId)))
      throw HfosError.rule(
        'realestate_description_unsigned',
        409,
        'The page needs a description the seller signed off. Send one to them from Description.',
      );
    // The page lives under the business's public name, as its forms do; the first page gives it one.
    if (!(await ensureSiteSlug(ctx, deal.workspaceId)))
      try {
        await ctx.tx.transaction((sp) => ensureBookingSite(sp, deal.workspaceId, actorUserId(ctx)));
      } catch {
        throw HfosError.rule(
          'realestate_no_public_name',
          409,
          'The business doesn’t have its public web address yet. Ask an owner or admin to put this page up the first time, or to set the address in Settings → Booking site.',
        );
      }
    const slug = l.slug ?? (await freeSlug(ctx, deal, address));
    const at = changeMoment(ctx.meta);
    const [next] = await ctx.tx
      .update(listings)
      .set({
        slug,
        pageState: 'published',
        pagePublishedBy: actorUserId(ctx),
        pagePublishedAt: at,
        updatedAt: at,
      })
      .where(
        and(eq(listings.workspaceId, l.workspaceId), eq(listings.dealRecordId, l.dealRecordId)),
      )
      .returning();
    await historyLine(ctx, deal, 'page_published', { after: { slug } });
    // S-22 "Publish and syndicate marketing": the page is its record.
    await addProof(
      ctx,
      deal,
      { keys: ['S-22'] },
      {
        kind: 'record',
        refKind: 'listing_page',
        refId: deal.recordId,
        body: 'The listing’s public page',
      },
    );
    await ctx.emit({
      type: 'realestate.listing.page_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { state: 'published', slug },
    });
    return pageOut(ctx, deal, next!);
  },
});

export const listingPageTakeDown = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.page_take_down',
  description: 'Take a listing’s public page down. Its address stays the same if it goes up again.',
  risk: 1,
  input: ListingInput,
  output: ListingPageOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.page_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    const l = await listingOf(ctx, deal.recordId, true);
    if (!l || l.pageState !== 'published') return pageOut(ctx, deal, l);
    const [next] = await ctx.tx
      .update(listings)
      .set({ pageState: 'down', updatedAt: changeMoment(ctx.meta) })
      .where(
        and(eq(listings.workspaceId, l.workspaceId), eq(listings.dealRecordId, l.dealRecordId)),
      )
      .returning();
    await historyLine(ctx, deal, 'page_taken_down', { after: { slug: l.slug } });
    await ctx.emit({
      type: 'realestate.listing.page_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { state: 'down', slug: l.slug },
    });
    return pageOut(ctx, deal, next!);
  },
});

// ---------- the flyer ----------

export const listingFlyer = defineAddonQuery(realestateAddon, {
  name: 'realestate.listing.flyer',
  description:
    'What a listing’s printable flyer shows: its first photos, price, confirmed facts, signed-off description, its agent and the QR code to its page. Refused before it’s live on the MLS.',
  input: ListingInput,
  output: ListingFlyerOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const address = await requireAddress(ctx, deal);
    const l = await requireOnMls(ctx, deal);
    const description = await descriptionInUse(ctx, deal.recordId);
    if (!description)
      throw HfosError.rule(
        'realestate_description_unsigned',
        409,
        'The flyer needs a description the seller signed off. Send one to them from Description.',
      );
    const names = await userNames(ctx, [deal.ownerUserId]);
    const page = await pageOut(ctx, deal, l);
    return {
      street: streetOf(address),
      cityLine: cityLineOf(address),
      priceCents: await listPriceOf(ctx, deal.recordId),
      facts: factLines((l.facts ?? {}) as Record<string, unknown>),
      description,
      photos: (await publicPhotos(ctx, deal.recordId)).slice(0, 4),
      agentName: deal.ownerUserId ? (names.get(deal.ownerUserId) ?? null) : null,
      mlsNumber: l.mlsNumber!,
      page:
        page.state === 'published' && page.site && page.slug && page.path
          ? { site: page.site, slug: page.slug, path: page.path }
          : null,
    };
  },
});

// ---------- email or text to contacts ----------

export const listingCampaign = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.campaign',
  description:
    'Tell the business’s contacts about a live listing by email or text: a campaign with exact words from its signed-off description and a link to its page, to the tags or stages picked. It waits in Campaigns for someone to approve it.',
  risk: 2,
  input: ListingCampaignInput,
  output: ListingCampaignOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.campaign_started', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const address = await requireAddress(ctx, deal);
    const l = await requireOnMls(ctx, deal);
    const page = await pageOut(ctx, deal, l);
    if (page.state !== 'published' || !page.path)
      throw HfosError.rule(
        'realestate_page_not_published',
        409,
        'Put the listing’s page up first: the email and the text link to it.',
      );
    let url: URL;
    try {
      url = new URL(input.pageUrl);
    } catch {
      url = new URL('invalid:');
    }
    if (!/^https?:$/.test(url.protocol) || url.pathname !== page.path)
      throw HfosError.validation(
        [{ path: 'pageUrl', message: 'Use the listing’s page link, as it shows on Marketing.' }],
        'Use the listing’s page link, as it shows on Marketing.',
      );
    const description = await descriptionInUse(ctx, deal.recordId);
    if (!description)
      throw HfosError.rule(
        'realestate_description_unsigned',
        409,
        'The email needs a description the seller signed off. Send one to them from Description.',
      );
    const street = streetOf(address);
    const price = await listPriceOf(ctx, deal.recordId);
    const priceWords = price ? money(price) : null;
    const facts = (l.facts ?? {}) as Record<string, number>;
    const rooms =
      facts['beds'] && facts['baths'] ? `${facts['beds']} beds, ${facts['baths']} baths` : null;
    const email = input.channel === 'email';
    const words = email
      ? listingEmailWords({ street, priceWords, description, pageUrl: url.toString() })
      : { text: listingTextWords({ street, priceWords, rooms, pageUrl: url.toString() }) };
    const flags = checkWords('text' in words ? words.text : `${words.subject}\n${words.body}`);
    if (flags.length)
      throw HfosError.rule(
        'realestate_fair_housing_flags',
        409,
        `The words have something that could read as a preference about who should live there: ${flags
          .map((f) => `“${f.phrase}”`)
          .join(', ')}. Change the description, then try again.`,
      );
    const { output } = await executeCommandWithin(ctx, campaignCreate, {
      workspaceId: deal.workspaceId,
      name: `Just listed: ${street}`.slice(0, 120),
      goal: `Tell people about the new listing at ${street}.`.slice(0, 500),
      audience: input.audience,
      channel: input.channel,
      words,
    });
    await historyLine(ctx, deal, 'listing_campaign', {
      after: { channel: input.channel, recipients: output.recipients },
    });
    // S-22 again: telling the business's contacts is publishing it too.
    await addProof(
      ctx,
      deal,
      { keys: ['S-22', 'S-23'] },
      {
        kind: 'record',
        refKind: 'listing_campaign',
        refId: output.campaignId,
        body: `${email ? 'An email' : 'A text'} to ${output.recipients} of the business’s contacts`,
      },
    );
    await ctx.emit({
      type: 'realestate.listing.campaign_started',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { campaignId: output.campaignId, channel: input.channel },
    });
    return output;
  },
});

// ---------- social posts ----------

type Post = typeof listingPosts.$inferSelect;

/** A post's flags between both checks of its words as they are now, and which checks have read them. */
export function postChecks(p: Post) {
  const c = (p.checks ?? {}) as PostChecks;
  const current = !!p.words && c.hash === textHashOf(null, p.words);
  const flags: FairHousingFlag[] = [];
  const seen = new Set<string>();
  if (current)
    for (const f of [...(c.words?.flags ?? []), ...(c.model?.flags ?? [])] as FairHousingFlag[]) {
      if (seen.has(f.phrase.toLowerCase())) continue;
      seen.add(f.phrase.toLowerCase());
      flags.push(f);
    }
  return { flags, words: current && !!c.words, model: current && !!c.model };
}

async function latestPosts(ctx: Ctx, dealId: string): Promise<Post[]> {
  const [last] = await ctx.tx
    .select({ batch: listingPosts.batch })
    .from(listingPosts)
    .where(eq(listingPosts.dealRecordId, dealId))
    .orderBy(desc(listingPosts.batch))
    .limit(1);
  if (!last) return [];
  return ctx.tx
    .select()
    .from(listingPosts)
    .where(and(eq(listingPosts.dealRecordId, dealId), eq(listingPosts.batch, last.batch)))
    .orderBy(asc(listingPosts.position));
}

const POSTS_PER_BATCH = 3;

export const listingPostsRequest = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.posts_request',
  description:
    'Ask the AI for three social posts about a listing, from its confirmed facts, price, signed-off description and open houses, each read by both fair housing checks. Nothing is posted: the agent copies them once it’s live on the MLS.',
  risk: 1,
  input: ListingPostsRequestInput,
  output: ListingPostsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_draft_listing_posts',
    description: 'Draft three social posts about a listing for the agent to check and copy.',
  },
  emits: ['realestate.listing.posts_requested'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const l = await ensureListing(ctx, deal);
    if (!l.factsConfirmedAt)
      throw HfosError.rule(
        'realestate_listing_no_facts',
        409,
        'Confirm the home’s facts first: the posts are written from them.',
      );
    const before = await latestPosts(ctx, deal.recordId);
    if (before.some((p) => p.state === 'drafting'))
      return { dealId: deal.recordId, batch: before[0]!.batch, state: 'drafting' as const };
    const batch = (before[0]?.batch ?? 0) + 1;
    if (before.length)
      await ctx.tx
        .update(listingPosts)
        .set({ state: 'replaced', updatedAt: new Date() })
        .where(
          and(eq(listingPosts.dealRecordId, deal.recordId), eq(listingPosts.batch, batch - 1)),
        );
    await ctx.tx.insert(listingPosts).values(
      Array.from({ length: POSTS_PER_BATCH }, (_, position) => ({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        batch,
        position,
        state: 'drafting' as const,
        createdBy: actorUserId(ctx),
      })),
    );
    await ctx.emit({
      type: 'realestate.listing.posts_requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { batch },
      broadcast: false,
    });
    return { dealId: deal.recordId, batch, state: 'drafting' as const };
  },
});

export const listingPostsDrafted = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.posts_drafted',
  description:
    'Real Estate Agent’s own: the AI’s social posts for a listing and their first fair housing checks, or why they couldn’t be written.',
  risk: 0,
  input: ListingPostsDraftedInput,
  output: ListingPostsOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.listing.posts_ready', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    const rows0 = (await latestPosts(ctx, deal.recordId)).filter(
      (p) => p.batch === input.batch && p.state === 'drafting',
    );
    if (!rows0.length)
      return { dealId: deal.recordId, batch: input.batch, state: 'ready' as const };
    const failed = !input.posts.length || !!input.failure;
    for (const p of rows0) {
      const got = input.posts[p.position];
      const words = got?.words.trim() || null;
      const hash = words ? textHashOf(null, words) : undefined;
      const checks: PostChecks = {};
      if (words && got) {
        const w = got.checks.find((c) => c.source === 'words');
        const m = got.checks.find((c) => c.source === 'model');
        Object.assign(checks, {
          hash,
          ...(w ? { words: { version: w.version, flags: w.flags } } : {}),
          ...(m ? { model: { version: m.version, status: m.status, flags: m.flags } } : {}),
        });
      }
      await ctx.tx
        .update(listingPosts)
        .set(
          failed || !words
            ? {
                state: 'failed',
                failure:
                  input.failure?.slice(0, 500) ||
                  'The posts couldn’t be written. Ask for them again, or write your own.',
                updatedAt: new Date(),
              }
            : { state: 'ready', words, model: input.model ?? null, checks, updatedAt: new Date() },
        )
        .where(eq(listingPosts.id, p.id));
    }
    if (!failed)
      // S-21 "Create marketing assets": the posts are some of them.
      await addProof(
        ctx,
        deal,
        { keys: ['S-21'] },
        {
          kind: 'record',
          refKind: 'listing_posts',
          refId: deal.recordId,
          body: 'Social posts, drafted',
        },
      );
    await ctx.emit({
      type: 'realestate.listing.posts_ready',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { batch: input.batch, failed },
      broadcast: false,
    });
    return {
      dealId: deal.recordId,
      batch: input.batch,
      state: failed ? ('failed' as const) : ('ready' as const),
    };
  },
});

async function loadPost(ctx: Ctx, id: string, lock = false): Promise<Post> {
  const q = ctx.tx
    .select()
    .from(listingPosts)
    .where(and(eq(listingPosts.id, id), eq(listingPosts.workspaceId, ctx.scope.workspaceId!)));
  const [p] = lock ? await q.for('update') : await q;
  if (!p)
    throw HfosError.notFound('That post isn’t there anymore. Refresh to see the newest drafts.');
  return p;
}

export const listingPostSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.post_save',
  description:
    'Save the agent’s own words for one of a listing’s social posts. The fixed list reads them at once and the model a moment later.',
  risk: 1,
  input: ListingPostSaveInput,
  output: ListingPostOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.post_saved'],
  async handler(ctx, input) {
    const p = await loadPost(ctx, input.postId, true);
    const deal = await loadDeal(ctx, p.dealRecordId);
    requireOpen(deal);
    if (p.state !== 'ready' && p.state !== 'failed')
      throw HfosError.conflict(
        'Those drafts were replaced. Refresh to see the newest ones.',
        'realestate_post_replaced',
      );
    const flags = checkWords(input.words);
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(listingPosts)
      .set({
        words: input.words,
        state: 'ready',
        failure: null,
        checks: {
          hash: textHashOf(null, input.words),
          words: { version: FAIR_HOUSING_WORDS_VERSION, flags },
        },
        editedBy: actorUserId(ctx),
        editedAt: at,
        updatedAt: at,
      })
      .where(eq(listingPosts.id, p.id));
    await ctx.emit({
      type: 'realestate.listing.post_saved',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { postId: p.id },
      broadcast: false,
    });
    return { postId: p.id, flags };
  },
});

export const listingPostChecked = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.post_checked',
  description: 'Real Estate Agent’s own: the model’s fair housing check of a social post’s words.',
  risk: 0,
  input: ListingPostCheckedInput,
  output: ListingPostOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const p = await loadPost(ctx, input.postId, true);
    const c = (p.checks ?? {}) as PostChecks;
    if (p.state === 'ready' && p.words && textHashOf(null, p.words) === input.textHash)
      await ctx.tx
        .update(listingPosts)
        .set({
          checks: {
            ...c,
            hash: input.textHash,
            model: { version: input.version, status: input.status, flags: input.flags },
          },
          updatedAt: new Date(),
        })
        .where(eq(listingPosts.id, p.id));
    return { postId: p.id, flags: postChecks(await loadPost(ctx, p.id)).flags };
  },
});

// ---------- the marketing page ----------

export const listingMarketing = defineAddonQuery(realestateAddon, {
  name: 'realestate.listing.marketing',
  description:
    'A listing’s marketing: whether it’s live on the MLS (and the hold until it is), its public page, what’s still missing, and its social post drafts with their checks.',
  input: ListingInput,
  output: ListingMarketingOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireListingSide(deal);
    const l = await listingOf(ctx, deal.recordId);
    const address = (await listingAddress(ctx, deal)) ?? deal.name;
    const posts = await latestPosts(ctx, deal.recordId);
    const live = l?.mlsNumber && l.mlsLiveOn ? { number: l.mlsNumber, liveOn: l.mlsLiveOn } : null;
    return {
      dealId: deal.recordId,
      mls: live,
      hold: live ? null : notOnMlsWords(address),
      page: await pageOut(ctx, deal, l),
      ready: {
        facts: !!l?.factsConfirmedAt,
        description: !!(await descriptionInUse(ctx, deal.recordId)),
        photos: (await publicPhotos(ctx, deal.recordId)).length,
      },
      posts: {
        state: !posts.length
          ? ('none' as const)
          : posts.some((p) => p.state === 'drafting')
            ? ('drafting' as const)
            : posts.every((p) => p.state === 'failed')
              ? ('failed' as const)
              : ('ready' as const),
        failure: posts.find((p) => p.state === 'failed')?.failure ?? null,
        items: posts
          .filter((p) => p.state === 'ready')
          .map((p) => {
            const c = postChecks(p);
            return {
              id: p.id,
              position: p.position,
              words: p.words,
              flags: c.flags,
              checked: { words: c.words, model: c.model },
              edited: !!p.editedAt,
            };
          }),
      },
    };
  },
});

export const marketingQueries = [listingFlyer, listingMarketing] as const;
export const marketingCommands = [
  listingMarkLive,
  listingPagePublish,
  listingPageTakeDown,
  listingCampaign,
  listingPostsRequest,
  listingPostsDrafted,
  listingPostSave,
  listingPostChecked,
] as const;
