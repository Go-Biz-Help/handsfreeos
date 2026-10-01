/**
 * The buyer's side, step 6 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): what the buyer
 * wants, and the homes they look at.
 *
 * - **The profile** is saved whole, each save kept as a version. Words that describe who lives somewhere rather than
 *   the home itself are refused, as fair housing asks: the fixed list reads every area, must-have and deal-breaker.
 * - **A home** is added by the agent (or, from step 12, the client in their portal) with its address, a listing's
 *   link (kept, never read) and the listing's pasted words. The AI reads only those words for the home's facts, each
 *   with the words it came from (`realestate.home.fill_facts`, the worker's); the agent checks and confirms them,
 *   which the AI is never offered.
 * - **Fit** says how each home meets what the buyer asked for, from confirmed facts and suggested ones alike.
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { people } from '@hfos/db/schema';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { checkWords } from '../fair-housing';
import {
  addressKey,
  HOME_STATUSES,
  homeFit,
  type FitProfile,
  type HomeStatus,
  type ListingFacts,
} from '../homes';
import { realestateAddon } from '../manifest';
import {
  BuyerProfileGetInput,
  BuyerProfileGetOutput,
  BuyerProfileSaveInput,
  BuyerProfileSaveOutput,
  HomeAddInput,
  HomeAddOutput,
  HomeConfirmFactsInput,
  HomeConfirmFactsOutput,
  HomeFillFactsInput,
  HomeFillFactsOutput,
  HomesInput,
  HomesOutput,
  HomeSetStatusInput,
  HomeSetStatusOutput,
} from '../schemas';
import type { HomeOut } from '../schemas';
import { buyerProfiles, buyerProfileVersions, homeReactions, homes } from '../tables';
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

type Home = typeof homes.$inferSelect;
type Profile = typeof buyerProfiles.$inferSelect;

/** Homes and a buyer's profile belong to buyer deals. */
export function requireBuyerSide(deal: Deal): void {
  if (deal.side !== 'buyer')
    throw HfosError.rule(
      'realestate_buyer_only',
      409,
      `${deal.name} is a listing. Homes to look at, and what a buyer wants, go on a buyer deal.`,
    );
}

/** One of a deal's homes, by id, if the person sees its deal. */
export async function loadHome(
  ctx: Ctx,
  homeId: string,
  opts: { lock?: boolean } = {},
): Promise<Home> {
  const q = ctx.tx
    .select()
    .from(homes)
    .where(and(eq(homes.id, homeId), eq(homes.workspaceId, ctx.scope.workspaceId!)));
  const [h] = opts.lock ? await q.for('update') : await q;
  if (!h)
    throw HfosError.notFound(
      'That home isn’t on the deal anymore, or you’re not on its deal. Refresh to see its homes as they are now.',
    );
  return h;
}

/** Words that describe who lives somewhere, not the home: refused, with what to say instead. */
export function refuseFairHousingWords(texts: readonly string[]): void {
  const flags = checkWords(texts.join('\n'));
  const first = flags[0];
  if (first)
    throw HfosError.rule(
      'realestate_fair_housing',
      422,
      `“${first.phrase}” isn’t kept: ${first.reason} ${first.safer}`.trim(),
    );
}

const profileOut = (p: Profile, updatedBy: { id: string; fullName: string } | null) => ({
  budgetMinCents: p.budgetMinCents,
  budgetMaxCents: p.budgetMaxCents,
  areas: p.areas,
  homeTypes: p.homeTypes,
  bedsMin: p.bedsMin,
  bathsMin: p.bathsMin === null ? null : Number(p.bathsMin),
  sqftMin: p.sqftMin,
  moveBy: p.moveBy,
  mustHaves: p.mustHaves,
  dealBreakers: p.dealBreakers,
  version: p.version,
  updatedAt: p.updatedAt.toISOString(),
  updatedBy,
});

export async function profileOf(ctx: Ctx, dealId: string): Promise<Profile | null> {
  const [p] = await ctx.tx
    .select()
    .from(buyerProfiles)
    .where(
      and(
        eq(buyerProfiles.workspaceId, ctx.scope.workspaceId!),
        eq(buyerProfiles.dealRecordId, dealId),
      ),
    );
  return p ?? null;
}

const fitProfileOf = (p: Profile | null): FitProfile => ({
  budgetMinCents: p?.budgetMinCents ?? null,
  budgetMaxCents: p?.budgetMaxCents ?? null,
  areas: p?.areas ?? [],
  homeTypes: p?.homeTypes ?? [],
  bedsMin: p?.bedsMin ?? null,
  bathsMin: p?.bathsMin === null || p?.bathsMin === undefined ? null : Number(p.bathsMin),
  sqftMin: p?.sqftMin ?? null,
});

export const buyerProfileSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.buyer_profile.save',
  description:
    'Save what a buyer wants: their price range, areas, kinds of home, bedrooms, baths, size, when they need to move, must-haves and deal-breakers. Each save is kept. Words about who lives in an area, rather than the home, are refused.',
  risk: 1,
  input: BuyerProfileSaveInput,
  output: BuyerProfileSaveOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_save_buyer_profile',
    description: 'Save what a buyer wants on their deal. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.buyer_profile.saved'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireBuyerSide(deal);
    const p = input.profile;
    refuseFairHousingWords([...p.areas, ...p.mustHaves, ...p.dealBreakers]);
    const before = await profileOf(ctx, deal.recordId);
    const values = {
      budgetMinCents: p.budgetMinCents,
      budgetMaxCents: p.budgetMaxCents,
      areas: p.areas,
      homeTypes: p.homeTypes,
      bedsMin: p.bedsMin,
      bathsMin: p.bathsMin === null ? null : String(p.bathsMin),
      sqftMin: p.sqftMin,
      moveBy: p.moveBy,
      mustHaves: p.mustHaves,
      dealBreakers: p.dealBreakers,
    };
    const same =
      before &&
      JSON.stringify({
        ...values,
        bathsMin: values.bathsMin === null ? null : Number(values.bathsMin),
      }) ===
        JSON.stringify({
          budgetMinCents: before.budgetMinCents,
          budgetMaxCents: before.budgetMaxCents,
          areas: before.areas,
          homeTypes: before.homeTypes,
          bedsMin: before.bedsMin,
          bathsMin: before.bathsMin === null ? null : Number(before.bathsMin),
          sqftMin: before.sqftMin,
          moveBy: before.moveBy,
          mustHaves: before.mustHaves,
          dealBreakers: before.dealBreakers,
        });
    if (before && same) return { dealId: deal.recordId, version: before.version, changed: false };
    const version = (before?.version ?? 0) + 1;
    const at = changeMoment(ctx.meta);
    if (before)
      await ctx.tx
        .update(buyerProfiles)
        .set({ ...values, version, updatedBy: actorUserId(ctx), updatedAt: at })
        .where(
          and(
            eq(buyerProfiles.workspaceId, deal.workspaceId),
            eq(buyerProfiles.dealRecordId, deal.recordId),
          ),
        );
    else
      await ctx.tx.insert(buyerProfiles).values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        ...values,
        version,
        updatedBy: actorUserId(ctx),
        updatedAt: at,
      });
    await ctx.tx.insert(buyerProfileVersions).values({
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      version,
      profile: { ...p },
      actorType: actorKind(ctx),
      savedBy: actorUserId(ctx),
      savedAt: at,
    });
    await historyLine(ctx, deal, 'buyer_profile', { after: { version } });
    await ctx.emit({
      type: 'realestate.buyer_profile.saved',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { version },
      after: { version },
    });
    return { dealId: deal.recordId, version, changed: true };
  },
});

export const buyerProfileGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.buyer_profile.get',
  description: 'What a buyer wants, as last saved on their deal.',
  input: BuyerProfileGetInput,
  output: BuyerProfileGetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: { tool: 'realestate_get_buyer_profile', description: 'What a buyer wants, from their deal.' },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const p = await profileOf(ctx, deal.recordId);
    if (!p) return { profile: null };
    const names = await userNames(ctx, [p.updatedBy]);
    return {
      profile: profileOut(
        p,
        p.updatedBy
          ? { id: p.updatedBy, fullName: names.get(p.updatedBy) ?? 'Former member' }
          : null,
      ),
    };
  },
});

/** A new home on a deal: refused when the deal already has it. */
export async function addHome(
  ctx: CommandContext,
  deal: Deal,
  input: {
    readonly address: string;
    readonly link?: string | undefined;
    readonly pastedText?: string | undefined;
    readonly source: 'agent' | 'client';
    readonly personId?: string | null;
  },
): Promise<{ homeId: string; filling: boolean }> {
  requireNotArchived(deal);
  requireBuyerSide(deal);
  const key = addressKey(input.address);
  const [already] = await ctx.tx
    .select({ id: homes.id })
    .from(homes)
    .where(
      and(
        eq(homes.workspaceId, deal.workspaceId),
        eq(homes.dealRecordId, deal.recordId),
        eq(homes.addressKey, key),
        ne(homes.status, 'removed'),
      ),
    );
  if (already)
    throw HfosError.rule(
      'realestate_home_already',
      409,
      `${input.address} is already on ${deal.name}. Open it there to change it.`,
    );
  const pasted = input.pastedText?.trim() || null;
  const [h] = await ctx.tx
    .insert(homes)
    .values({
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      address: input.address.trim(),
      addressKey: key,
      source: input.source,
      link: input.link ?? null,
      pastedText: pasted,
      factsState: pasted ? 'filling' : 'none',
      addedBy: actorUserId(ctx),
      addedByPersonId: input.source === 'client' ? (input.personId ?? null) : null,
    })
    .returning({ id: homes.id });
  await historyLine(ctx, deal, 'home_added', {
    after: { address: input.address.trim(), source: input.source },
  });
  const eventId = await ctx.emit({
    type: 'realestate.home.added',
    entityType: 'realestate_deal',
    entityId: deal.recordId,
    payload: { homeId: h!.id, fill: !!pasted, source: input.source },
    after: { address: input.address.trim() },
  });
  await dealLine(
    ctx,
    deal,
    input.source === 'client'
      ? `added ${input.address.trim()} to their homes`
      : `added ${input.address.trim()} to the homes`,
    { eventId },
  );
  return { homeId: h!.id, filling: !!pasted };
}

export const homeAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.home.add',
  description:
    'Add a home to a buyer deal: its address, a listing’s link (kept for people to open, never read) and, if there is one, the listing’s pasted words, which the AI reads for the home’s facts for the agent to confirm.',
  risk: 1,
  input: HomeAddInput,
  output: HomeAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_home',
    description:
      'Add a home a buyer is interested in to their deal, with its address and any listing text.',
  },
  emits: ['realestate.home.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    return addHome(ctx, deal, {
      address: input.address,
      link: input.link,
      pastedText: input.pastedText,
      source: 'agent',
    });
  },
});

export const homeFillFacts = defineAddonCommand(realestateAddon, {
  name: 'realestate.home.fill_facts',
  description:
    'Worker: the facts the AI found in a home’s pasted listing text, each with the words it came from, for the agent to check. Or why it couldn’t read them.',
  risk: 0,
  input: HomeFillFactsInput,
  output: HomeFillFactsOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.home.facts_filled'],
  async handler(ctx, input) {
    const home = await loadHome(ctx, input.homeId, { lock: true });
    // Confirmed since, or not waiting on the AI: what a person settled stays.
    if (home.factsState !== 'filling') return { homeId: home.id, state: 'skipped' as const };
    const failed = !!input.failure || Object.keys(input.facts).length === 0;
    await ctx.tx
      .update(homes)
      .set(
        failed
          ? {
              factsState: 'failed',
              factsFailure:
                input.failure ??
                'The listing’s words didn’t say its facts clearly enough. Enter them from the listing.',
              factsModel: input.model ?? null,
            }
          : {
              factsState: 'suggested',
              facts: input.facts,
              factSources: input.sources,
              factsModel: input.model ?? null,
              factsFailure: null,
            },
      )
      .where(eq(homes.id, home.id));
    await ctx.emit({
      type: 'realestate.home.facts_filled',
      entityType: 'realestate_deal',
      entityId: home.dealRecordId,
      payload: {
        homeId: home.id,
        state: failed ? 'failed' : 'suggested',
        found: Object.keys(input.facts).length,
        dropped: input.dropped,
      },
    });
    return { homeId: home.id, state: failed ? ('failed' as const) : ('suggested' as const) };
  },
});

export const homeConfirmFacts = defineAddonCommand(realestateAddon, {
  name: 'realestate.home.confirm_facts',
  description:
    'Confirm a home’s facts as the agent checked them against the listing. The AI suggests them; only a person confirms.',
  risk: 1,
  input: HomeConfirmFactsInput,
  output: HomeConfirmFactsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.home.facts_confirmed'],
  async handler(ctx, input) {
    if (ctx.actor.type !== 'human' || ctx.meta.channel === 'assistant')
      throw HfosError.forbidden('A person confirms a home’s facts, against the listing.');
    const home = await loadHome(ctx, input.homeId, { lock: true });
    const deal = await loadDeal(ctx, home.dealRecordId);
    requireNotArchived(deal);
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(homes)
      .set({
        facts: input.facts,
        factsState: 'confirmed',
        factsConfirmedBy: actorUserId(ctx),
        factsConfirmedAt: at,
        factsFailure: null,
      })
      .where(eq(homes.id, home.id));
    await historyLine(ctx, deal, 'home_facts', { after: { address: home.address } });
    await ctx.emit({
      type: 'realestate.home.facts_confirmed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { homeId: home.id },
      before: { facts: home.facts },
      after: { facts: input.facts },
    });
    return { homeId: home.id, confirmedAt: at.toISOString() };
  },
});

export const homeSetStatus = defineAddonCommand(realestateAddon, {
  name: 'realestate.home.set_status',
  description:
    'Say where a home stands for the buyer: saved, shortlisted, toured, offer made, passed, or removed from the deal.',
  risk: 1,
  input: HomeSetStatusInput,
  output: HomeSetStatusOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_set_home_status',
    description:
      'Say where a home stands for the buyer (shortlisted, passed…). Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.home.status_changed'],
  async handler(ctx, input) {
    const home = await loadHome(ctx, input.homeId, { lock: true });
    const deal = await loadDeal(ctx, home.dealRecordId);
    requireNotArchived(deal);
    if (home.status === input.status && (home.statusNote ?? undefined) === input.note)
      return { homeId: home.id, status: input.status, changed: false };
    // Bringing a removed home back: refused when the address is on the deal again since.
    if (home.status === 'removed' && input.status !== 'removed') {
      const [again] = await ctx.tx
        .select({ id: homes.id })
        .from(homes)
        .where(
          and(
            eq(homes.dealRecordId, home.dealRecordId),
            eq(homes.addressKey, home.addressKey),
            ne(homes.status, 'removed'),
          ),
        );
      if (again)
        throw HfosError.rule(
          'realestate_home_already',
          409,
          `${home.address} is on ${deal.name} again already. Change that one instead.`,
        );
    }
    await ctx.tx
      .update(homes)
      .set({ status: input.status, statusNote: input.note ?? null })
      .where(eq(homes.id, home.id));
    await historyLine(ctx, deal, 'home_status', {
      before: { address: home.address, status: home.status },
      after: { address: home.address, status: input.status },
      note: input.note ?? null,
    });
    await ctx.emit({
      type: 'realestate.home.status_changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { homeId: home.id, from: home.status, to: input.status },
      before: { status: home.status },
      after: { status: input.status },
    });
    return { homeId: home.id, status: input.status, changed: true };
  },
});

export const dealHomes = defineAddonQuery(realestateAddon, {
  name: 'realestate.homes',
  description:
    'A buyer deal’s homes: each one’s facts (and where the AI found them, until confirmed), where it stands, how it fits what the buyer wants, and what each client said about it.',
  input: HomesInput,
  output: HomesOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_list_homes',
    description:
      'The homes on a buyer’s deal, how each fits what they want, and what the clients said.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(homes)
      .where(
        and(
          eq(homes.workspaceId, deal.workspaceId),
          eq(homes.dealRecordId, deal.recordId),
          ...(input.includeRemoved ? [] : [ne(homes.status, 'removed')]),
        ),
      )
      .orderBy(asc(homes.createdAt));
    const profile = fitProfileOf(await profileOf(ctx, deal.recordId));
    const ids = list.map((h) => h.id);
    const reactions = ids.length
      ? await ctx.tx
          .select({
            homeId: homeReactions.homeId,
            personId: homeReactions.personId,
            reaction: homeReactions.reaction,
            note: homeReactions.note,
            at: homeReactions.reactedAt,
            first: people.firstName,
            last: people.lastName,
          })
          .from(homeReactions)
          .innerJoin(people, eq(people.id, homeReactions.personId))
          .where(inArray(homeReactions.homeId, ids))
      : [];
    const clients = list.flatMap((h) => (h.addedByPersonId ? [h.addedByPersonId] : []));
    const clientNames = clients.length
      ? new Map(
          (
            await rows<{ id: string; name: string }>(
              ctx.tx,
              sql`select id, btrim(first_name || ' ' || last_name) as name from app.people
                  where id = any(${`{${[...new Set(clients)].join(',')}}`}::uuid[])`,
            )
          ).map((p) => [p.id, p.name]),
        )
      : new Map<string, string>();
    const names = await userNames(
      ctx,
      list.map((h) => h.addedBy),
    );
    return {
      homes: list.map((h): z.input<typeof HomeOut> => {
        const facts = h.facts as ListingFacts;
        return {
          id: h.id,
          address: h.address,
          source: h.source,
          link: h.link,
          status: h.status as HomeStatus,
          statusNote: h.statusNote,
          facts,
          factSources: h.factsState === 'suggested' ? h.factSources : {},
          factsState: h.factsState,
          factsFailure: h.factsFailure,
          hasPastedText: !!h.pastedText,
          fit: (({ lines, ...counts }) => ({ ...counts, lines: [...lines] }))(
            homeFit(profile, facts, h.address),
          ),
          reactions: reactions
            .filter((r) => r.homeId === h.id)
            .map((r) => ({
              personId: r.personId,
              name: `${r.first} ${r.last}`.trim() || 'Client',
              reaction: r.reaction,
              note: r.note,
              at: r.at.toISOString(),
            })),
          addedBy: h.addedBy
            ? { id: h.addedBy, fullName: names.get(h.addedBy) ?? 'Former member' }
            : null,
          addedByClient: h.addedByPersonId
            ? { id: h.addedByPersonId, name: clientNames.get(h.addedByPersonId) || 'Client' }
            : null,
          addedAt: h.createdAt.toISOString(),
        };
      }),
    };
  },
});

/** Where a home stands, in words ("Shortlisted"). */
export const homeStatusWords = (status: string): string =>
  HOME_STATUSES[status as HomeStatus] ?? status;

export const homeCommands = [
  buyerProfileSave,
  homeAdd,
  homeFillFacts,
  homeConfirmFacts,
  homeSetStatus,
] as const;
export const homeQueries = [buyerProfileGet, dealHomes] as const;
