/**
 * Real Estate's public pages (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core", step 6):
 * what anyone with the link sees, signed in to nothing, through core's public door (Real Estate round three, step 1).
 *
 * - **A listing's page** shows only what was published: a page put up by the agent, for a listing live on the MLS and
 *   not withdrawn, expired or cancelled; its confirmed facts, the photos marked for it, its signed-off description,
 *   its open houses, its agent's name and its MLS number. Under contract and sold say so.
 * - **"Ask about this home"** finds or makes the visitor as a customer, opens a lead for the listing's agent where the
 *   business's forms would, keeps their yes to texts with where it came from, and puts their question on their
 *   timeline. The agent hears about it (the worker's alert).
 */
import { and, asc, eq, gte } from 'drizzle-orm';
import { signUpFromPage, SIGN_UP_EVENTS } from '../../../crm/signup';
import { HfosError } from '../../../errors';
import { requirePublic } from '../../../kernel/actor';
import type { QueryContext } from '../../../kernel/types';
import { addonTimelineLine, defineAddonCommand, defineAddonQuery } from '../../server';
import { publicStatus, streetOf } from '../listing';
import { realestateAddon } from '../manifest';
import {
  PublicListingAskInput,
  PublicListingAskOutput,
  PublicListingInput,
  PublicListingOutput,
} from '../schemas';
import { listings, openHouses } from '../tables';
import { inWorkspace, loadDeal, userNames, type Ctx } from './common';
import { listingAddress, listPriceOf } from './listing';
import { descriptionInUse, factLines, publicPhotos } from './marketing';

const noPage = () =>
  HfosError.notFound(
    'There’s no page at this address. Check the link, or contact the business if you still need it.',
  );

/** The published listing at this address, and its deal; anything else is "no page". */
export async function publishedListing(ctx: Ctx, slug: string) {
  const [l] = await ctx.tx
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.workspaceId, ctx.scope.workspaceId!),
        eq(listings.slug, slug.toLowerCase()),
        eq(listings.pageState, 'published'),
      ),
    );
  if (!l?.mlsNumber) throw noPage();
  const deal = await loadDeal(ctx, l.dealRecordId).catch(() => null);
  const status = deal ? publicStatus(deal.stage) : null;
  if (!deal || deal.archivedAt || !status) throw noPage();
  const address = await listingAddress(ctx, deal);
  if (!address) throw noPage();
  return { l, deal, status, address };
}

/** A listing's open houses still to come (or on now), and whether sign-in is open for each. */
async function upcomingOpenHouses(ctx: Ctx, dealId: string) {
  const now = Date.now();
  const list = await ctx.tx
    .select({ id: openHouses.id, startsAt: openHouses.startsAt, endsAt: openHouses.endsAt })
    .from(openHouses)
    .where(
      and(
        eq(openHouses.dealRecordId, dealId),
        eq(openHouses.state, 'planned'),
        gte(openHouses.endsAt, new Date(now - HOUR)),
      ),
    )
    .orderBy(asc(openHouses.startsAt))
    .limit(5);
  return list.map((o) => ({
    id: o.id,
    startsAt: o.startsAt.toISOString(),
    endsAt: o.endsAt.toISOString(),
    signInOpen: now >= o.startsAt.getTime() - HOUR && now <= o.endsAt.getTime() + HOUR,
  }));
}

const HOUR = 3_600_000;

export const publicListing = defineAddonQuery(realestateAddon, {
  name: 'realestate.public.listing',
  description:
    'A listing’s public page: what its agent published about it, for anyone with the link.',
  input: PublicListingInput,
  output: PublicListingOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  async handler(ctx: QueryContext, input) {
    requirePublic(ctx);
    const { l, deal, status, address } = await publishedListing(ctx, input.slug);
    const names = await userNames(ctx, [deal.ownerUserId]);
    return {
      slug: l.slug!,
      street: streetOf(address),
      cityLine: address.split(',').slice(1).join(',').trim() || null,
      status,
      priceCents: await listPriceOf(ctx, deal.recordId),
      facts: factLines((l.facts ?? {}) as Record<string, unknown>),
      description: await descriptionInUse(ctx, deal.recordId),
      photos: (await publicPhotos(ctx, deal.recordId)).map((p) => ({
        publicFileId: p.fileId,
        caption: p.caption,
      })),
      openHouses: await upcomingOpenHouses(ctx, deal.recordId),
      agentName: deal.ownerUserId ? (names.get(deal.ownerUserId) ?? null) : null,
      mlsNumber: l.mlsNumber!,
    };
  },
});

export const publicListingAsk = defineAddonCommand(realestateAddon, {
  name: 'realestate.public.ask',
  description:
    'A visitor to a listing’s page asks about the home: they become a customer with a lead for the listing’s agent, with their question on their timeline.',
  risk: 2,
  input: PublicListingAskInput,
  output: PublicListingAskOutput,
  permission: null,
  actors: ['public'],
  scope: inWorkspace,
  emits: ['realestate.listing.asked', ...SIGN_UP_EVENTS],
  async handler(ctx, input) {
    requirePublic(ctx);
    const { deal, status, address } = await publishedListing(ctx, input.slug);
    if (status === 'sold')
      throw HfosError.rule(
        'realestate_listing_sold',
        409,
        `${streetOf(address)} has sold. Contact the business about other homes.`,
      );
    const street = streetOf(address);
    const signed = await signUpFromPage(ctx, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: `Listing page: ${street}`,
      smsConsent: input.smsConsent,
      lead: { title: `Asked about ${street}`, assigneeUserId: deal.ownerUserId },
    });
    await addonTimelineLine(ctx, realestateAddon, {
      personId: signed.personId,
      words: `asked about ${street} on its listing page`,
      body: input.question,
    });
    await ctx.emit({
      type: 'realestate.listing.asked',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        personId: signed.personId,
        leadId: signed.leadId,
        street,
        ownerUserId: deal.ownerUserId,
        name: `${input.firstName} ${input.lastName}`.trim(),
      },
    });
    return { sent: true as const };
  },
});

export const publicQueries = [publicListing] as const;
export const publicCommands = [publicListingAsk] as const;
