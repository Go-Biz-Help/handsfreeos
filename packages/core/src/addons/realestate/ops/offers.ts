/**
 * Offers and counters, step 10 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"). Chris
 * decided: the terms live here, the contract elsewhere.
 *
 * - **Every version is kept as it was sent**: ours (the offer, a counter) and the seller's counters, each with its
 *   terms, the time it must be answered by, and the uploaded document it is. Who answers next follows the newest.
 * - **The clock**: the worker raises an alert two hours before a version's deadline, at it, and an hour after if
 *   nobody recorded an answer (`realestate.offer_clock`), and arms it again when the add-on comes back on.
 * - **Answered**: accepted, its terms go to the deal's key dates through `realestate.term.enter`, unconfirmed, for a
 *   person to check against the signed contract, and a deal at Offer or Negotiation moves to Under contract.
 *   Declined, expired or withdrawn with no other offer still out, the deal takes the lost path
 *   (`realestate.deal.record_offer_lost`).
 * - **The client** sees a version's one-page summary in their portal once it's shared, never the team's notes.
 */
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { addDays } from '../../../calendar/engine/zoned';
import { fmtAt, localDayOf } from '../../../calendar/when';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { money } from '../../../money/format';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import {
  clockWords,
  LIVE_OFFER_STATUSES,
  LOAN_TYPES,
  offerSummary,
  type OfferStatus,
} from '../offer-words';
import {
  OfferAddVersionInput,
  OfferAddVersionOutput,
  OfferAttachDocumentInput,
  OfferChangeOutput,
  OfferInput,
  OfferRespondInput,
  OffersInput,
  OffersOutput,
  OfferStartInput,
  OfferStartOutput,
  OfferWithdrawInput,
  type OfferTermsIn,
} from '../schemas';
import { LISTING_STAGES, stageAfterEvent } from '../states';
import { documents, homes, offers, offerVersions } from '../tables';
import {
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireOpen,
  timeZoneOf,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { dealMoveStage, dealOfferLost, dealRecordEvent, dealSetFacts } from './deals';
import { loadHome } from './homes';
import { listingAddress } from './listing';
import { ensureContingencies } from './risk';
import { termEnter } from './terms';
import { addProof, documentProof, PROOF_EVENTS } from './proof-hooks';
import type { z } from 'zod';

type Offer = typeof offers.$inferSelect;
type Version = typeof offerVersions.$inferSelect;
type Terms = z.output<typeof OfferTermsIn>;

const isLive = (s: OfferStatus) => LIVE_OFFER_STATUSES.includes(s);

async function loadOffer(ctx: Ctx, offerId: string, lock = false): Promise<Offer> {
  const q = ctx.tx
    .select()
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.workspaceId, ctx.scope.workspaceId!)));
  const [o] = lock ? await q.for('update') : await q;
  if (!o)
    throw HfosError.notFound(
      'That offer isn’t there anymore, or you’re not on its deal. Refresh the deal’s offers.',
    );
  return o;
}

async function versionsOf(ctx: Ctx, offerIds: readonly string[]): Promise<Version[]> {
  if (!offerIds.length) return [];
  return ctx.tx
    .select()
    .from(offerVersions)
    .where(inArray(offerVersions.offerId, [...offerIds]))
    .orderBy(asc(offerVersions.number));
}

/** Where an offer is: one of a buyer's homes, or (round three) the listing itself. */
async function placeOf(ctx: Ctx, o: Offer, deal: Deal): Promise<string> {
  if (o.homeId) return (await loadHome(ctx, o.homeId)).address;
  return (await listingAddress(ctx, deal)) ?? deal.name;
}

function requireLive(o: Offer, address: string): void {
  if (!isLive(o.status))
    throw HfosError.rule(
      'realestate_offer_ended',
      409,
      `The offer on ${address} was ${o.status}, so it doesn’t change any more. Start a new offer on it instead.`,
    );
}

/** A document on the deal, to be a version's. */
async function requireDealDocument(ctx: Ctx, deal: Deal, documentId: string): Promise<void> {
  const [doc] = await ctx.tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.dealRecordId, deal.recordId)));
  if (!doc)
    throw HfosError.notFound(
      `That document isn’t on ${deal.name}. Upload the contract to the deal’s documents first, then pick it.`,
    );
}

async function insertVersion(
  ctx: CommandContext,
  o: Pick<Offer, 'id' | 'workspaceId' | 'dealRecordId'>,
  number: number,
  side: 'us' | 'them',
  input: {
    terms: Terms;
    respondBy?: string | null | undefined;
    at?: string | undefined;
    documentId?: string | undefined;
    note?: string | undefined;
  },
): Promise<Version> {
  const t = input.terms;
  const [v] = await ctx.tx
    .insert(offerVersions)
    .values({
      workspaceId: o.workspaceId,
      dealRecordId: o.dealRecordId,
      offerId: o.id,
      number,
      side,
      at: input.at ? new Date(input.at) : changeMoment(ctx.meta),
      priceCents: t.priceCents,
      emdCents: t.emdCents,
      emdDays: t.emdDays,
      sellerCreditCents: t.sellerCreditCents,
      inspectionDays: t.inspectionDays,
      loanType: t.loanType,
      financingDays: t.financingDays,
      appraisalContingency: t.appraisalContingency,
      closingDate: t.closingDate,
      otherTerms: t.otherTerms,
      downPaymentPct: t.downPaymentPct === null ? null : String(t.downPaymentPct),
      homeSaleContingency: t.homeSaleContingency,
      escalationCapCents: t.escalationCapCents,
      escalationStepCents: t.escalationStepCents,
      possession: t.possession,
      buyerAgentFeeBp: t.buyerAgentFeeBp,
      buyerAgentFeeCents: t.buyerAgentFeeCents,
      respondBy: input.respondBy ? new Date(input.respondBy) : null,
      note: input.note ?? null,
      createdBy: actorUserId(ctx),
    })
    .returning();
  if (input.documentId)
    await ctx.tx
      .update(documents)
      .set({ offerVersionId: v!.id, updatedAt: new Date() })
      .where(eq(documents.id, input.documentId));
  return v!;
}

/** What the worker's clock needs, on the event. */
const clockPayload = (o: Offer, v: Version, deal: Deal, address: string) => ({
  offerId: o.id,
  versionId: v.id,
  number: v.number,
  side: v.side,
  respondBy: v.respondBy?.toISOString() ?? null,
  address,
  ownerUserId: deal.ownerUserId,
  name: deal.name,
});

// ---------- commands ----------

export const offerStart = defineAddonCommand(realestateAddon, {
  name: 'realestate.offer.start',
  description:
    'Record an offer as it was sent: on a buyer deal, one we made on one of their homes; on a listing, one a buyer made on it. Its terms, who it’s with, and when it must be answered by. The contract itself is uploaded as one of the deal’s documents.',
  risk: 1,
  input: OfferStartInput,
  output: OfferStartOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_record_offer',
    description:
      'Record an offer: one sent on a buyer’s home, or one received on a listing, with its terms and deadline.',
  },
  emits: [
    'realestate.offer.version_added',
    'realestate.deal.event_recorded',
    'realestate.deal.facts_changed',
    ...PROOF_EVENTS,
  ],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const listing = deal.side === 'listing';
    let address: string;
    let homeId: string | null = null;
    if (listing) {
      // A buyer's offer on our listing: it's on the listing itself.
      address = (await listingAddress(ctx, deal)) ?? deal.name;
    } else {
      if (!input.homeId)
        throw HfosError.validation(
          [{ path: 'homeId', message: 'Pick the home the offer is on.' }],
          'Pick the home the offer is on.',
        );
      const home = await loadHome(ctx, input.homeId);
      if (home.dealRecordId !== deal.recordId || home.status === 'removed')
        throw HfosError.notFound(
          `That home isn’t on ${deal.name}. Add it to the deal’s homes first, then record the offer.`,
        );
      const [live] = await ctx.tx
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.homeId, home.id), inArray(offers.status, [...LIVE_OFFER_STATUSES])));
      if (live)
        throw HfosError.rule(
          'realestate_offer_live',
          409,
          `There’s already an offer out on ${home.address}. Add the counter to it instead.`,
        );
      address = home.address;
      homeId = home.id;
    }
    if (input.documentId) await requireDealDocument(ctx, deal, input.documentId);
    const [last] = await ctx.tx
      .select({ n: max(offers.number) })
      .from(offers)
      .where(eq(offers.dealRecordId, deal.recordId));
    const [offer] = await ctx.tx
      .insert(offers)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        homeId,
        number: (last?.n ?? 0) + 1,
        buyerNames: listing ? (input.buyerNames ?? null) : null,
        // Ours waits on them; theirs, on a listing, waits on us.
        status: listing ? 'waiting_us' : 'waiting_them',
        theirAgentName: input.theirAgentName ?? null,
        theirBrokerage: input.theirBrokerage ?? null,
        theirEmail: input.theirEmail ?? null,
        theirPhone: input.theirPhone ?? null,
        createdBy: actorUserId(ctx),
      })
      .returning();
    const v = await insertVersion(ctx, offer!, 1, listing ? 'them' : 'us', input);
    if (homeId)
      await ctx.tx
        .update(homes)
        .set({ status: 'offered', updatedAt: new Date() })
        .where(
          and(eq(homes.id, homeId), inArray(homes.status, ['saved', 'shortlisted', 'toured'])),
        );
    await historyLine(ctx, deal, listing ? 'offer_received' : 'offer_made', {
      after: {
        address,
        price: money(v.priceCents),
        number: offer!.number,
        buyers: input.buyerNames ?? null,
      },
    });
    if (listing) {
      // Two or more out at once: the listing has multiple offers, said first so S-42 opens with this one.
      const live = await ctx.tx
        .select({ id: offers.id })
        .from(offers)
        .where(
          and(
            eq(offers.dealRecordId, deal.recordId),
            inArray(offers.status, [...LIVE_OFFER_STATUSES]),
          ),
        );
      const fresh = await loadDeal(ctx, deal.recordId);
      if (live.length >= 2 && !fresh.facts.includes('multiple_offers'))
        await executeCommandWithin(ctx, dealSetFacts, {
          workspaceId: deal.workspaceId,
          dealId: deal.recordId,
          facts: [...fresh.facts, 'multiple_offers'],
        });
      // S-40 "Receive offer" and the rest of the offer duties open with each offer received.
      await executeCommandWithin(ctx, dealRecordEvent, {
        workspaceId: deal.workspaceId,
        dealId: deal.recordId,
        event: 'offer_received',
        note: `Offer ${offer!.number}${input.buyerNames ? ` from ${input.buyerNames}` : ''} at ${money(v.priceCents)}`,
      });
      await addProof(
        ctx,
        await loadDeal(ctx, deal.recordId),
        { keys: ['S-40', 'S-41'] },
        {
          kind: 'record',
          refKind: 'offer',
          refId: offer!.id,
          body: `Offer ${offer!.number}${input.buyerNames ? ` from ${input.buyerNames}` : ''} at ${money(v.priceCents)}`,
        },
      );
    } else
      // B-11 "Write offer" (B-16 for another): linked to it; its signed document is the proof.
      await addProof(
        ctx,
        deal,
        { keys: ['B-11', 'B-16'] },
        {
          kind: 'record',
          refKind: 'offer',
          refId: offer!.id,
          body: `Offer ${offer!.number} on ${address} at ${money(v.priceCents)}`,
        },
      );
    if (input.documentId) await documentProof(ctx, deal, input.documentId);
    await ctx.emit({
      type: 'realestate.offer.version_added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: clockPayload(offer!, v, deal, address),
    });
    return { offerId: offer!.id, versionId: v.id, number: offer!.number };
  },
});

export const offerAddVersion = defineAddonCommand(realestateAddon, {
  name: 'realestate.offer.add_version',
  description:
    'Record the next version of an open offer, as it was sent: the seller’s counter, or ours. Who answers next, and by when, follows it.',
  risk: 1,
  input: OfferAddVersionInput,
  output: OfferAddVersionOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_record_counter',
    description:
      'Record a counteroffer on an open offer (the seller’s or ours), with its terms and deadline.',
  },
  emits: ['realestate.offer.version_added', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const o = await loadOffer(ctx, input.offerId, true);
    const deal = await loadDeal(ctx, o.dealRecordId);
    requireOpen(deal);
    const address = await placeOf(ctx, o, deal);
    requireLive(o, address);
    if (input.documentId) await requireDealDocument(ctx, deal, input.documentId);
    const [last] = await ctx.tx
      .select({ n: max(offerVersions.number) })
      .from(offerVersions)
      .where(eq(offerVersions.offerId, o.id));
    const v = await insertVersion(ctx, o, (last?.n ?? 0) + 1, input.side, input);
    const status: OfferStatus = input.side === 'us' ? 'waiting_them' : 'waiting_us';
    await ctx.tx.update(offers).set({ status, updatedAt: new Date() }).where(eq(offers.id, o.id));
    await historyLine(ctx, deal, 'offer_countered', {
      after: {
        address: address,
        price: money(v.priceCents),
        side: v.side,
        number: v.number,
        listing: deal.side === 'listing',
      },
    });
    if (input.documentId) await documentProof(ctx, deal, input.documentId);
    await ctx.emit({
      type: 'realestate.offer.version_added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: clockPayload(o, v, deal, address),
    });
    return { offerId: o.id, versionId: v.id, number: v.number, status };
  },
});

export const offerAttachDocument = defineAddonCommand(realestateAddon, {
  name: 'realestate.offer.attach_document',
  description:
    'Say which of the deal’s uploaded documents an offer’s version is: the contract or counter as signed.',
  risk: 1,
  input: OfferAttachDocumentInput,
  output: OfferChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [...PROOF_EVENTS],
  async handler(ctx, input) {
    const [v] = await ctx.tx
      .select()
      .from(offerVersions)
      .where(
        and(
          eq(offerVersions.id, input.versionId),
          eq(offerVersions.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!v) throw HfosError.notFound('That offer isn’t there anymore. Refresh the deal’s offers.');
    const o = await loadOffer(ctx, v.offerId);
    const deal = await loadDeal(ctx, o.dealRecordId);
    await requireDealDocument(ctx, deal, input.documentId);
    await ctx.tx
      .update(documents)
      .set({ offerVersionId: v.id, updatedAt: new Date() })
      .where(eq(documents.id, input.documentId));
    await documentProof(ctx, deal, input.documentId);
    return { offerId: o.id, status: o.status, termsEntered: 0, dealStage: null };
  },
});

/** The deal's other offers still out, besides this one. */
async function othersLive(ctx: Ctx, o: Offer): Promise<number> {
  const list = await ctx.tx
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.dealRecordId, o.dealRecordId),
        inArray(offers.status, [...LIVE_OFFER_STATUSES]),
      ),
    );
  return list.filter((x) => x.id !== o.id).length;
}

/** No offer is out any more: a deal at Offer or Negotiation takes the lost path. */
async function lostPath(
  ctx: CommandContext,
  o: Offer,
  deal: Deal,
  reason: string,
): Promise<string | null> {
  if ((await othersLive(ctx, o)) > 0) return null;
  const fresh = await loadDeal(ctx, deal.recordId);
  if (!stageAfterEvent(fresh.side, 'offer_lost', fresh.stage) || fresh.outcome) return null;
  const r = await executeCommandWithin(ctx, dealOfferLost, {
    workspaceId: deal.workspaceId,
    dealId: deal.recordId,
    reason,
  });
  return r.output.stage;
}

/** The accepted version's terms, entered on the deal for a person to confirm. */
async function enterTerms(
  ctx: CommandContext,
  deal: Deal,
  v: Version,
  acceptedOn: string,
): Promise<number> {
  const doc = await ctx.tx
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.offerVersionId, v.id))
    .orderBy(desc(documents.version))
    .limit(1);
  const base = {
    workspaceId: deal.workspaceId,
    dealId: deal.recordId,
    // The offer itself is the contract's terms, a counter is a counter's: on a buyer deal ours are the offers, on a
    // listing (round three) the buyer's first version is.
    source: (deal.side === 'listing' ? v.number === 1 : v.side === 'us')
      ? ('contract' as const)
      : ('counter' as const),
    confirm: false,
    note: `From the accepted offer (version ${v.number}). Check it against the signed contract.`,
    ...(doc[0] ? { documentId: doc[0].id } : {}),
  };
  const entries: Record<string, unknown>[] = [
    { key: 'acceptance', date: acceptedOn },
    { key: 'price', cents: v.priceCents },
    ...(v.emdCents !== null ? [{ key: 'emd_amount', cents: v.emdCents }] : []),
    ...(v.emdDays !== null ? [{ key: 'emd_due', date: addDays(acceptedOn, v.emdDays) }] : []),
    ...(v.sellerCreditCents > 0 ? [{ key: 'seller_credit', cents: v.sellerCreditCents }] : []),
    ...(v.inspectionDays
      ? [{ key: 'inspection_end', date: addDays(acceptedOn, v.inspectionDays) }]
      : []),
    ...(v.loanType ? [{ key: 'loan_type', text: LOAN_TYPES[v.loanType] }] : []),
    ...(v.financingDays !== null
      ? [{ key: 'financing_end', date: addDays(acceptedOn, v.financingDays) }]
      : []),
    ...(v.closingDate ? [{ key: 'closing', date: v.closingDate }] : []),
  ];
  // Its contingencies are tracked from here, whatever their dates turn out to be (round four).
  await ensureContingencies(ctx, deal, [
    ...(v.inspectionDays ? [{ kind: 'inspection' as const, source: 'offer' as const }] : []),
    ...(v.financingDays !== null ? [{ kind: 'financing' as const, source: 'offer' as const }] : []),
    ...(v.appraisalContingency ? [{ kind: 'appraisal' as const, source: 'offer' as const }] : []),
    ...(v.homeSaleContingency ? [{ kind: 'home_sale' as const, source: 'offer' as const }] : []),
  ]);
  for (const e of entries) await executeCommandWithin(ctx, termEnter, { ...base, ...e });
  return entries.length;
}

export const offerRecordResponse = defineAddonCommand(realestateAddon, {
  name: 'realestate.offer.record_response',
  description:
    'Record how an offer was answered: accepted (its terms go to the deal’s key dates to confirm, and the deal moves to Under contract), declined, or passed with no answer. With no other offer out, a lost offer takes the deal back to Touring.',
  risk: 2,
  input: OfferRespondInput,
  output: OfferChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_record_offer_answer',
    description: 'Record that an offer was accepted, declined or expired. Asks the person first.',
  },
  emits: ['realestate.offer.answered', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const o = await loadOffer(ctx, input.offerId, true);
    const deal = await loadDeal(ctx, o.dealRecordId, { lock: true });
    requireOpen(deal);
    const address = await placeOf(ctx, o, deal);
    requireLive(o, address);
    const versions = await versionsOf(ctx, [o.id]);
    const v = input.versionId
      ? versions.find((x) => x.id === input.versionId)
      : versions[versions.length - 1];
    if (!v)
      throw HfosError.notFound('That version isn’t on this offer. Refresh the deal’s offers.');
    const at = input.at ? new Date(input.at) : changeMoment(ctx.meta);
    const tz = await timeZoneOf(ctx);
    let termsEntered = 0;
    let dealStage: string | null = null;
    await ctx.tx
      .update(offers)
      .set({
        status: input.outcome,
        acceptedVersionId: input.outcome === 'accepted' ? v.id : null,
        endedAt: at,
        endedReason: input.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(offers.id, o.id));
    await historyLine(ctx, deal, 'offer_answered', {
      after: {
        address: address,
        outcome: input.outcome,
        price: money(v.priceCents),
        number: v.number,
      },
      note: input.note ?? null,
    });
    const listing = deal.side === 'listing';
    if (input.outcome === 'accepted') {
      termsEntered = await enterTerms(ctx, deal, v, localDayOf(at.getTime(), tz));
      const fresh = await loadDeal(ctx, deal.recordId);
      // A listing's offer can be taken before it's on the market (coming soon, or sold before it's listed).
      const where = (LISTING_STAGES as readonly string[]).indexOf(fresh.stage);
      const beforeContract = listing
        ? where >= LISTING_STAGES.indexOf('signed') &&
          where < LISTING_STAGES.indexOf('under_contract')
        : fresh.stage === 'offer' || fresh.stage === 'negotiation';
      if (beforeContract) {
        const moved = await executeCommandWithin(ctx, dealMoveStage, {
          workspaceId: deal.workspaceId,
          dealId: deal.recordId,
          stage: 'under_contract',
          note: `The offer on ${address} was accepted.`,
        });
        dealStage = moved.output.stage;
      }
      // B-17 "Ratify accepted offer" (S-48 "Ratify contract" on a listing): linked to it; the signed contract and
      // confirmed acceptance are its proof.
      await addProof(
        ctx,
        await loadDeal(ctx, deal.recordId),
        { keys: listing ? ['S-48'] : ['B-17'] },
        {
          kind: 'record',
          refKind: 'offer',
          refId: o.id,
          body: `Accepted: version ${v.number} on ${address} at ${money(v.priceCents)}`,
        },
      );
    } else if (listing) {
      // A listing stays on the market: another offer may come.
    } else {
      const why =
        input.outcome === 'declined'
          ? `The seller declined the offer on ${address}.`
          : `The offer on ${address} passed with no answer.`;
      dealStage = await lostPath(ctx, o, deal, why);
      // B-13 "Record lost offer and outcome".
      await addProof(
        ctx,
        deal,
        { keys: ['B-13'] },
        {
          kind: 'note',
          body: `${why} Last version ${v.number}: ${money(v.priceCents)}.${input.note ? ` ${input.note}` : ''}`,
        },
      );
    }
    await ctx.emit({
      type: 'realestate.offer.answered',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { offerId: o.id, versionId: v.id, outcome: input.outcome, termsEntered },
    });
    return { offerId: o.id, status: input.outcome, termsEntered, dealStage };
  },
});

export const offerWithdraw = defineAddonCommand(realestateAddon, {
  name: 'realestate.offer.withdraw',
  description:
    'Withdraw an open offer, with the reason. With no other offer out, the deal goes back to Touring.',
  risk: 2,
  input: OfferWithdrawInput,
  output: OfferChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.offer.answered', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const o = await loadOffer(ctx, input.offerId, true);
    const deal = await loadDeal(ctx, o.dealRecordId, { lock: true });
    requireOpen(deal);
    const address = await placeOf(ctx, o, deal);
    requireLive(o, address);
    await ctx.tx
      .update(offers)
      .set({
        status: 'withdrawn',
        endedAt: changeMoment(ctx.meta),
        endedReason: input.reason,
        updatedAt: new Date(),
      })
      .where(eq(offers.id, o.id));
    await historyLine(ctx, deal, 'offer_answered', {
      after: { address: address, outcome: 'withdrawn', listing: deal.side === 'listing' },
      note: input.reason,
    });
    const why = `The offer on ${address} was withdrawn: ${input.reason}`;
    // On a listing it's the buyer who withdrew theirs, and the listing stays on the market.
    const dealStage = deal.side === 'listing' ? null : await lostPath(ctx, o, deal, why);
    if (deal.side !== 'listing')
      await addProof(ctx, deal, { keys: ['B-13'] }, { kind: 'note', body: why });
    await ctx.emit({
      type: 'realestate.offer.answered',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { offerId: o.id, outcome: 'withdrawn', termsEntered: 0 },
    });
    return { offerId: o.id, status: 'withdrawn' as const, termsEntered: 0, dealStage };
  },
});

export const offerShareSummary = defineAddonCommand(realestateAddon, {
  name: 'realestate.offer.share_summary',
  description:
    'Put the newest version of an offer in the client’s portal as a one-page summary in plain words. The team’s notes never show.',
  risk: 2,
  input: OfferInput,
  output: OfferChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_share_offer_summary',
    description:
      'Share an offer’s one-page summary with the client in their portal. Asks the person first.',
  },
  emits: ['realestate.offer.shared'],
  async handler(ctx, input) {
    const o = await loadOffer(ctx, input.offerId, true);
    const deal = await loadDeal(ctx, o.dealRecordId);
    requireOpen(deal);
    if (deal.side === 'listing')
      throw HfosError.rule(
        'realestate_offer_summary_buyer',
        409,
        'A listing’s offers go to the seller side by side. Use Share with the seller on Offers.',
      );
    const address = await placeOf(ctx, o, deal);
    const versions = await versionsOf(ctx, [o.id]);
    const v =
      o.status === 'accepted'
        ? versions.find((x) => x.id === o.acceptedVersionId)!
        : versions.at(-1)!;
    if (o.sharedVersionId === v.id)
      return { offerId: o.id, status: o.status, termsEntered: 0, dealStage: null };
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(offers)
      .set({ sharedVersionId: v.id, sharedBy: actorUserId(ctx), sharedAt: at, updatedAt: at })
      .where(eq(offers.id, o.id));
    await historyLine(ctx, deal, 'offer_shared', {
      after: { address: address, number: v.number },
    });
    await ctx.emit({
      type: 'realestate.offer.shared',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { offerId: o.id, versionId: v.id },
    });
    return { offerId: o.id, status: o.status, termsEntered: 0, dealStage: null };
  },
});

// ---------- the query ----------

export const offersList = defineAddonQuery(realestateAddon, {
  name: 'realestate.offers',
  description:
    'A buyer deal’s offers: each version and counter with its terms and document, who answers next and by when, and the one-page summary the client sees.',
  input: OffersInput,
  output: OffersOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_offers',
    description: 'A buyer deal’s offers and counters, their terms and deadlines.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const tz = await timeZoneOf(ctx);
    const now = Date.now();
    const rowsOf = await ctx.tx
      .select({ o: offers, homeAddress: homes.address })
      .from(offers)
      .leftJoin(homes, eq(homes.id, offers.homeId))
      .where(eq(offers.dealRecordId, deal.recordId))
      .orderBy(desc(offers.number));
    // A listing's offers are on the listing itself.
    const listingAt = rowsOf.some((r) => !r.o.homeId)
      ? ((await listingAddress(ctx, deal)) ?? deal.name)
      : deal.name;
    const list = rowsOf.map((r) => ({ o: r.o, address: r.homeAddress ?? listingAt }));
    const versions = await versionsOf(
      ctx,
      list.map((x) => x.o.id),
    );
    const docs = versions.length
      ? await ctx.tx
          .select({
            id: documents.id,
            title: documents.title,
            status: documents.status,
            lineageId: documents.lineageId,
            version: documents.version,
            offerVersionId: documents.offerVersionId,
          })
          .from(documents)
          .where(eq(documents.dealRecordId, deal.recordId))
      : [];
    /** A version's document as it stands now: the newest version of what was attached. */
    const docOf = (versionId: string) => {
      const attached = docs.filter((d) => d.offerVersionId === versionId);
      if (!attached.length) return null;
      const lineage = attached[0]!.lineageId;
      const newest = docs
        .filter((d) => d.lineageId === lineage && d.status !== 'void')
        .sort((a, b) => b.version - a.version)[0];
      const d = newest ?? attached[0]!;
      return { id: d.id, title: d.title, status: d.status, signed: d.status === 'signed' };
    };
    const owner = await userNames(ctx, [deal.ownerUserId]);
    const agentFirstName = (owner.get(deal.ownerUserId ?? '') ?? 'Your agent').split(/\s+/)[0]!;
    return {
      offers: list.map(({ o, address }) => {
        const vs = versions.filter((v) => v.offerId === o.id);
        const newest = vs.at(-1)!;
        const shown =
          o.status === 'accepted'
            ? (vs.find((v) => v.id === o.acceptedVersionId) ?? newest)
            : newest;
        const respondBy = newest.respondBy?.toISOString() ?? null;
        return {
          id: o.id,
          number: o.number,
          homeId: o.homeId,
          buyerNames: o.buyerNames,
          address,
          status: o.status,
          theirAgentName: o.theirAgentName,
          theirBrokerage: o.theirBrokerage,
          theirEmail: o.theirEmail,
          theirPhone: o.theirPhone,
          versions: vs.map((v) => ({
            id: v.id,
            number: v.number,
            side: v.side,
            at: v.at.toISOString(),
            priceCents: v.priceCents,
            emdCents: v.emdCents,
            emdDays: v.emdDays,
            sellerCreditCents: v.sellerCreditCents,
            inspectionDays: v.inspectionDays,
            loanType: v.loanType,
            financingDays: v.financingDays,
            appraisalContingency: v.appraisalContingency,
            closingDate: v.closingDate,
            otherTerms: v.otherTerms,
            downPaymentPct: v.downPaymentPct === null ? null : Number(v.downPaymentPct),
            homeSaleContingency: v.homeSaleContingency,
            escalationCapCents: v.escalationCapCents,
            escalationStepCents: v.escalationStepCents,
            possession: v.possession,
            buyerAgentFeeBp: v.buyerAgentFeeBp,
            buyerAgentFeeCents: v.buyerAgentFeeCents,
            respondBy: v.respondBy?.toISOString() ?? null,
            note: v.note,
            document: docOf(v.id),
          })),
          acceptedVersionId: o.acceptedVersionId,
          endedAt: o.endedAt?.toISOString() ?? null,
          endedReason: o.endedReason,
          clock: isLive(o.status)
            ? {
                waitingOn: o.status === 'waiting_them' ? ('them' as const) : ('us' as const),
                respondBy,
                words: respondBy
                  ? `Due ${fmtAt(respondBy, tz)} · ${clockWords(respondBy, now)}`
                  : null,
              }
            : null,
          shared:
            o.sharedVersionId && o.sharedAt
              ? {
                  versionId: o.sharedVersionId,
                  at: o.sharedAt.toISOString(),
                  current: o.sharedVersionId === shown.id,
                }
              : null,
          summary: offerSummary(
            {
              number: shown.number,
              side: shown.side,
              respondBy: shown.respondBy?.toISOString() ?? null,
              priceCents: shown.priceCents,
              emdCents: shown.emdCents,
              emdDays: shown.emdDays,
              sellerCreditCents: shown.sellerCreditCents,
              inspectionDays: shown.inspectionDays,
              loanType: shown.loanType,
              financingDays: shown.financingDays,
              appraisalContingency: shown.appraisalContingency,
              closingDate: shown.closingDate,
              otherTerms: shown.otherTerms,
            },
            { address, status: o.status, agentFirstName, timeZone: tz, now },
          ),
        };
      }),
    };
  },
});

export const offerCommands = [
  offerStart,
  offerAddVersion,
  offerAttachDocument,
  offerRecordResponse,
  offerWithdraw,
  offerShareSummary,
] as const;
export const offerQueries = [offersList] as const;
