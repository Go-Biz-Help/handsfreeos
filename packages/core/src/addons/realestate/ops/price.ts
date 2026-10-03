/**
 * A listing's price changes, step 10 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core").
 * Chris decided (2026-10-01): the seller signs off before a new price is used.
 *
 * - **Asking.** "Change the price" keeps the change (`listing_prices`) and makes a sign-off task in the seller's
 *   portal with its exact words: "Change the list price of 418 Maple Ave from $409,000 to $399,000." One waits at a
 *   time; the first list price is entered as a key term, with no sign-off.
 * - **Using it.** Signed in the portal (or let through by an owner or admin, with a reason), the new price replaces
 *   the `list_price` term, keeping the old one in its history; the listing's page shows it at once; the agent is
 *   reminded to change it on the MLS (the worker's alert); S-34's proof. `realestate.term.enter` refuses a new list
 *   price on a listing with one confirmed (`realestate_price_needs_signoff`): this is the only way in.
 * - **Withdrawn**, with why, takes the task back from the portal.
 */
import { and, desc, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { FRESH_MINUTES } from '../../../mobile';
import { money } from '../../../money/format';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { streetOf } from '../listing';
import { realestateAddon } from '../manifest';
import {
  ListingInput,
  ListingPriceChangeInput,
  ListingPriceChangeOutput,
  ListingPriceProposeInput,
  ListingPriceProposeOutput,
  ListingPricesOutput,
} from '../schemas';
import { feedbackSummary, type ShowingFeedback } from '../showings';
import { clientTasks, listingPrices, listings, showings, termEntries } from '../tables';
import { termsNow } from '../terms';
import {
  actorUserId,
  dealClients,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireOpen,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { requireLetThrough } from './description';
import { termEntriesOf } from './engine';
import { listingAddress, requireListingSide } from './listing';
import { addProof, PROOF_EVENTS } from './proof-hooks';

type Price = typeof listingPrices.$inferSelect;

/** The events using a new price causes, for the commands that can (the portal's sign-off among them). */
export const PRICE_EVENTS = ['realestate.listing.price_changed', ...PROOF_EVENTS] as const;

async function loadPrice(ctx: Ctx, id: string, lock = false): Promise<{ p: Price; deal: Deal }> {
  const q = ctx.tx
    .select()
    .from(listingPrices)
    .where(and(eq(listingPrices.id, id), eq(listingPrices.workspaceId, ctx.scope.workspaceId!)));
  const [p] = lock ? await q.for('update') : await q;
  if (!p)
    throw HfosError.notFound(
      'That price change isn’t there anymore, or you’re not on its listing. Refresh the listing.',
    );
  return { p, deal: await loadDeal(ctx, p.dealRecordId) };
}

/** The list price entry in use: the one a change replaces. */
async function currentListPrice(ctx: Ctx, dealId: string) {
  const now = termsNow(await termEntriesOf(ctx, dealId)).get('list_price');
  return now?.current ?? null;
}

async function priceOut(ctx: Ctx, list: readonly Price[]) {
  const names = await userNames(
    ctx,
    list.flatMap((p) => [p.proposedBy, p.overrideBy]),
  );
  const sellers = list.length ? await dealClients(ctx, list[0]!.dealRecordId) : [];
  const who = (id: string | null) =>
    id ? { id, fullName: names.get(id) ?? 'Former member' } : null;
  return list.map((p) => ({
    id: p.id,
    fromCents: p.fromCents,
    toCents: p.toCents,
    words: p.words,
    note: p.note,
    state: p.state,
    how:
      p.state !== 'applied'
        ? null
        : p.overrideReason !== null
          ? ('let_through' as const)
          : ('portal' as const),
    signedBy: p.signedByPersonId
      ? (sellers.find((s) => s.id === p.signedByPersonId)?.firstName ?? 'The seller')
      : null,
    overrideBy: who(p.overrideBy),
    overrideReason: p.overrideReason,
    appliedAt: p.appliedAt?.toISOString() ?? null,
    withdrawnReason: p.withdrawnReason,
    taskId: p.clientTaskId,
    proposedAt: p.proposedAt.toISOString(),
    proposedBy: who(p.proposedBy),
  }));
}

/**
 * Uses a signed (or let through) change: the new `list_price` entry replaces the one in use, S-34's proof, and the
 * agent hears to change it on the MLS.
 */
async function applyPrice(
  ctx: CommandContext,
  deal: Deal,
  p: Price,
  by: { personId: string } | { reason: string },
): Promise<void> {
  const at = changeMoment(ctx.meta);
  await ctx.tx
    .update(listingPrices)
    .set({
      state: 'applied',
      appliedAt: at,
      updatedAt: at,
      ...('personId' in by
        ? { signedByPersonId: by.personId }
        : { overrideBy: actorUserId(ctx), overrideReason: by.reason }),
    })
    .where(eq(listingPrices.id, p.id));
  // The new list price replaces the one in use, which stays in its history. Written here, not through
  // `realestate.term.enter` (which refuses it): the seller's sign-off in the portal is what lets it in, and the
  // agent who asked for exactly this price confirms it.
  const current = await currentListPrice(ctx, deal.recordId);
  const confirmer = 'personId' in by ? p.proposedBy : actorUserId(ctx);
  const [entry] = await ctx.tx
    .insert(termEntries)
    .values({
      workspaceId: deal.workspaceId,
      dealRecordId: deal.recordId,
      key: 'list_price',
      valueCents: p.toCents,
      source: 'agreement',
      note: p.words,
      enteredBy: actorUserId(ctx) ?? p.proposedBy,
      enteredAt: at,
      ...(confirmer ? { confirmedBy: confirmer, confirmedAt: at } : {}),
    })
    .returning({ id: termEntries.id });
  if (current)
    await ctx.tx
      .update(termEntries)
      .set({ supersededBy: entry!.id, supersededAt: at })
      .where(eq(termEntries.id, current.id));
  await ctx.tx
    .update(listingPrices)
    .set({ termEntryId: entry!.id })
    .where(eq(listingPrices.id, p.id));
  const [l] = await ctx.tx
    .select({ mlsNumber: listings.mlsNumber, pageState: listings.pageState })
    .from(listings)
    .where(eq(listings.dealRecordId, deal.recordId));
  await historyLine(ctx, deal, 'price_changed', {
    before: { price: money(p.fromCents) },
    after: { price: money(p.toCents), how: 'personId' in by ? 'portal' : 'let_through' },
    note: 'reason' in by ? by.reason : null,
  });
  // S-34 "Recommend price or strategy review": the change, signed off.
  await addProof(
    ctx,
    deal,
    { keys: ['S-34'] },
    {
      kind: 'record',
      refKind: 'listing_price',
      refId: p.id,
      body: `List price from ${money(p.fromCents)} to ${money(p.toCents)}`,
    },
  );
  const address = (await listingAddress(ctx, deal)) ?? deal.name;
  const eventId = await ctx.emit({
    type: 'realestate.listing.price_changed',
    entityType: 'realestate_deal',
    entityId: deal.recordId,
    payload: {
      priceId: p.id,
      fromCents: p.fromCents,
      toCents: p.toCents,
      street: streetOf(address),
      ownerUserId: deal.ownerUserId,
      onMls: !!l?.mlsNumber,
      letThrough: 'reason' in by,
    },
  });
  await dealLine(
    ctx,
    deal,
    `changed the list price from ${money(p.fromCents)} to ${money(p.toCents)}`,
    { eventId },
  );
}

// ---------- commands ----------

export const pricePropose = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.price.propose',
  description:
    'Ask the seller to sign off a new list price in their portal, with its exact words (“Change the list price of 418 Maple Ave from $409,000 to $399,000.”). The new price is used only once they sign.',
  risk: 2,
  input: ListingPriceProposeInput,
  output: ListingPriceProposeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_propose_price_change',
    description:
      'Ask a listing’s seller to sign off a new list price in their portal. Always asks the person first.',
  },
  // Asking the seller reaches their portal: with no signal it waits, and asks again after 30 minutes (board 88). One
  // waits at a time, so a second ask is refused rather than made twice.
  offline: { freshMinutes: FRESH_MINUTES },
  emits: ['realestate.listing.price_proposed', 'realestate.client_task.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireListingSide(deal);
    const address = (await listingAddress(ctx, deal)) ?? deal.name;
    const street = streetOf(address);
    const current = await currentListPrice(ctx, deal.recordId);
    if (!current?.valueCents)
      throw HfosError.rule(
        'realestate_no_list_price',
        409,
        `${street} has no list price yet. Enter it under Key terms first; a change after that goes to the seller to sign off.`,
      );
    if (current.valueCents === input.priceCents)
      throw HfosError.rule(
        'realestate_price_same',
        409,
        `${street} is already listed at ${money(input.priceCents)}. Enter a different price.`,
      );
    const [waiting] = await ctx.tx
      .select({ id: listingPrices.id, toCents: listingPrices.toCents })
      .from(listingPrices)
      .where(
        and(eq(listingPrices.dealRecordId, deal.recordId), eq(listingPrices.state, 'waiting')),
      );
    if (waiting)
      throw HfosError.rule(
        'realestate_price_waiting',
        409,
        `A change to ${money(waiting.toCents)} is already waiting on the seller’s sign-off. Withdraw it first to ask for a different price.`,
      );
    const sellers = await dealClients(ctx, deal.recordId);
    if (!sellers.length)
      throw HfosError.rule(
        'realestate_no_client',
        409,
        `${deal.name} has no seller on it yet. Add the seller under People on the deal, then ask.`,
      );
    const words = `Change the list price of ${street} from ${money(current.valueCents)} to ${money(input.priceCents)}.`;
    const [p] = await ctx.tx
      .insert(listingPrices)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        fromCents: current.valueCents,
        toCents: input.priceCents,
        words,
        note: input.note ?? null,
        proposedBy: actorUserId(ctx),
        proposedAt: changeMoment(ctx.meta),
      })
      .returning({ id: listingPrices.id });
    const [task] = await ctx.tx
      .insert(clientTasks)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: 'sign_off',
        title: 'Sign off the new price',
        detail: 'Once you sign, the new price goes on your listing’s page and on the MLS.',
        signOffWords: words,
        refKind: 'listing_price',
        refId: p!.id,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: clientTasks.id });
    await ctx.tx
      .update(listingPrices)
      .set({ clientTaskId: task!.id })
      .where(eq(listingPrices.id, p!.id));
    await historyLine(ctx, deal, 'price_proposed', {
      before: { price: money(current.valueCents) },
      after: { price: money(input.priceCents) },
      note: input.note ?? null,
    });
    await ctx.emit({
      type: 'realestate.client_task.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { taskId: task!.id, kind: 'sign_off' },
    });
    await ctx.emit({
      type: 'realestate.listing.price_proposed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { priceId: p!.id, fromCents: current.valueCents, toCents: input.priceCents },
    });
    return { priceId: p!.id, taskId: task!.id };
  },
});

export const priceLetThrough = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.price.let_through',
  description:
    'Use a new list price without the seller’s sign-off in the portal, with the reason (“signed the change on paper”). Owners and admins only; kept on the deal’s history.',
  risk: 2,
  input: ListingPriceChangeInput,
  output: ListingPriceChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: PRICE_EVENTS,
  async handler(ctx, input) {
    requireLetThrough(ctx, 'a new price');
    const { p, deal } = await loadPrice(ctx, input.priceId, true);
    requireOpen(deal);
    if (p.state === 'applied') return (await priceOut(ctx, [p]))[0]!;
    if (p.state === 'withdrawn')
      throw HfosError.rule(
        'realestate_price_withdrawn',
        409,
        `The change to ${money(p.toCents)} was withdrawn. Ask for the new price again instead.`,
      );
    if (p.clientTaskId)
      await ctx.tx
        .update(clientTasks)
        .set({
          status: 'canceled',
          canceledReason: `Let through without the portal: ${input.reason}`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(and(eq(clientTasks.id, p.clientTaskId), eq(clientTasks.status, 'open')));
    await applyPrice(ctx, deal, p, { reason: input.reason });
    return (await priceOut(ctx, [(await loadPrice(ctx, p.id)).p]))[0]!;
  },
});

export const priceWithdraw = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.price.withdraw',
  description:
    'Withdraw a price change still waiting on the seller, with why. Its sign-off task leaves their portal; the price stays as it is.',
  risk: 1,
  input: ListingPriceChangeInput,
  output: ListingPriceChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.listing.price_withdrawn'],
  async handler(ctx, input) {
    const { p, deal } = await loadPrice(ctx, input.priceId, true);
    if (p.state === 'withdrawn') return (await priceOut(ctx, [p]))[0]!;
    if (p.state === 'applied')
      throw HfosError.rule(
        'realestate_price_applied',
        409,
        `The price is already ${money(p.toCents)}. To change it again, ask the seller for a new price.`,
      );
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(listingPrices)
      .set({ state: 'withdrawn', withdrawnReason: input.reason, updatedAt: at })
      .where(eq(listingPrices.id, p.id));
    if (p.clientTaskId)
      await ctx.tx
        .update(clientTasks)
        .set({
          status: 'canceled',
          canceledReason: `Price change withdrawn: ${input.reason}`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(and(eq(clientTasks.id, p.clientTaskId), eq(clientTasks.status, 'open')));
    await historyLine(ctx, deal, 'price_withdrawn', {
      after: { price: money(p.toCents) },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.listing.price_withdrawn',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { priceId: p.id, toCents: p.toCents },
    });
    return (await priceOut(ctx, [(await loadPrice(ctx, p.id)).p]))[0]!;
  },
});

/** The seller signed a price change in their portal (client-tasks' completeTask, once it's done). */
export async function priceSignedOff(
  ctx: CommandContext,
  deal: Deal,
  priceId: string,
  personId: string,
): Promise<void> {
  const { p } = await loadPrice(ctx, priceId, true);
  if (p.state !== 'waiting') return;
  await applyPrice(ctx, deal, p, { personId });
}

// ---------- the query ----------

export const listingPricesGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.listing.prices',
  description:
    'A listing’s price: the one in use, a change waiting on the seller’s sign-off, and every change asked for.',
  input: ListingInput,
  output: ListingPricesOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_listing_prices',
    description: 'A listing’s price now, and its changes with the seller’s sign-offs.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireListingSide(deal);
    const list = await ctx.tx
      .select()
      .from(listingPrices)
      .where(eq(listingPrices.dealRecordId, deal.recordId))
      .orderBy(desc(listingPrices.proposedAt), desc(listingPrices.id));
    const out = await priceOut(ctx, list);
    const current = await currentListPrice(ctx, deal.recordId);
    const shown = feedbackSummary(
      (
        await ctx.tx
          .select({ state: showings.state, feedback: showings.feedback })
          .from(showings)
          .where(eq(showings.dealRecordId, deal.recordId))
      ).map((r) => ({ state: r.state, feedback: (r.feedback as ShowingFeedback | null) ?? null })),
    );
    return {
      dealId: deal.recordId,
      currentCents: current?.valueCents ?? null,
      waiting: out.find((p) => p.state === 'waiting') ?? null,
      history: out,
      showings: {
        showings: shown.showings,
        answered: shown.answered,
        averageInterest: shown.averageInterest,
        priceHigh: shown.price.high,
        words: `${shown.words}${shown.price.high ? ` · ${shown.price.high} said the price was high` : ''}`,
      },
    };
  },
});

export const priceQueries = [listingPricesGet] as const;
export const priceCommands = [pricePropose, priceLetThrough, priceWithdraw] as const;
