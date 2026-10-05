/**
 * A listing's offers side by side, step 8 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"). Chris decided (2026-10-01): side by side, with what the seller would take home from each.
 *
 * - **The figures** for the seller's estimate (what's owed on the mortgage, the listing fee, title and escrow, transfer
 *   tax, other costs) are the agent's, each save kept (`net_sheets`). Each offer's own price, credit and agent's fee
 *   come from its newest version. It's an estimate (pure `net.ts`), and says so. S-42 and X-04's proof.
 * - **Sharing** puts what the seller sees in their portal as it is then (`offer_comparisons`): each open offer's
 *   terms in words, its estimate, and the figures used. S-43's proof.
 * - **The seller's choice** on an offer (accept, counter, decline, or let's talk), in their words, is kept and the
 *   agent hears about it. It tells the agent what they want; it accepts nothing. The contract is signed elsewhere.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireCustomer } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import { netFiguresOf, netSheetOut, SELLER_CHOICES, type NetFigures } from '../net';
import { compareRows, LIVE_OFFER_STATUSES } from '../offer-words';
import {
  ListingInput,
  NetSheetSaveInput,
  NetSheetSaveOutput,
  OffersCompareOutput,
  OffersShareComparisonOutput,
  PortalOfferChoiceInput,
  PortalOfferChoiceOutput,
  type CompareRowOut,
} from '../schemas';
import { netSheets, offerChoices, offerComparisons, offers, offerVersions } from '../tables';
import {
  actorUserId,
  dealClients,
  historyLine,
  idUnavailable,
  inWorkspace,
  loadDeal,
  requireOpen,
  userNames,
  withPhoneId,
  type Ctx,
  type Deal,
} from './common';
import { listingAddress, requireListingSide } from './listing';
import { addProof, PROOF_EVENTS } from './proof-hooks';

type Sheet = typeof netSheets.$inferSelect;

async function sheetsOf(ctx: Ctx, dealId: string): Promise<Sheet[]> {
  return ctx.tx
    .select()
    .from(netSheets)
    .where(eq(netSheets.dealRecordId, dealId))
    .orderBy(desc(netSheets.version));
}

/** Each open offer's version that counts, side by side, with the seller's estimate for it. */
async function compareRowsOf(ctx: Ctx, deal: Deal, f: NetFigures): Promise<CompareRowOut[]> {
  const list = await ctx.tx
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.dealRecordId, deal.recordId),
        inArray(offers.status, [...LIVE_OFFER_STATUSES, 'accepted']),
      ),
    );
  if (!list.length) return [];
  const versions = await ctx.tx
    .select()
    .from(offerVersions)
    .where(
      inArray(
        offerVersions.offerId,
        list.map((o) => o.id),
      ),
    );
  return compareRows(list, versions, f);
}

async function figuresOut(ctx: Ctx, list: readonly Sheet[]) {
  const names = await userNames(
    ctx,
    list.map((s) => s.savedBy),
  );
  return list.map((s) => netSheetOut(s, s.savedBy ? (names.get(s.savedBy) ?? null) : null));
}

// ---------- the team's ----------

export const netSheetSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.net_sheet.save',
  description:
    'Save the figures for a listing’s seller’s estimate: what’s owed on the mortgage, the listing fee, title and escrow, transfer tax and other costs. Each save is kept beside the estimates it made.',
  risk: 1,
  input: NetSheetSaveInput,
  output: NetSheetSaveOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  // A new estimate saves with no signal (board 88), with the phone's id for the save.
  offline: 'anytime',
  emits: ['realestate.net_sheet.saved', ...PROOF_EVENTS],
  async handler(ctx, input) {
    // Sent again after its answer was lost: the save it made.
    if (input.id) {
      const [had] = await ctx.tx
        .select({
          id: netSheets.id,
          dealRecordId: netSheets.dealRecordId,
          version: netSheets.version,
        })
        .from(netSheets)
        .where(and(eq(netSheets.id, input.id), eq(netSheets.workspaceId, ctx.scope.workspaceId!)));
      if (had) {
        if (had.dealRecordId !== input.dealId) throw idUnavailable();
        return { dealId: had.dealRecordId, version: had.version };
      }
    }
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireListingSide(deal);
    const [last] = await sheetsOf(ctx, deal.recordId);
    const version = (last?.version ?? 0) + 1;
    await withPhoneId('net_sheets', () =>
      ctx.tx.insert(netSheets).values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        version,
        payoffCents: input.payoffCents,
        listingFeeBp: input.listingFeeBp,
        listingFeeCents: input.listingFeeCents,
        titleEscrowCents: input.titleEscrowCents,
        transferTaxBp: input.transferTaxBp,
        otherCents: input.otherCents,
        otherNote: input.otherNote,
        note: input.note,
        savedBy: actorUserId(ctx),
        savedAt: changeMoment(ctx.meta),
      }),
    );
    await historyLine(ctx, deal, 'net_sheet', { after: { version } });
    // X-04 "Seller net sheet": the figures, kept.
    await addProof(
      ctx,
      deal,
      { keys: ['X-04'] },
      { kind: 'record', refKind: 'net_sheet', refId: deal.recordId, body: 'The seller’s estimate' },
    );
    await ctx.emit({
      type: 'realestate.net_sheet.saved',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { version },
      broadcast: false,
    });
    return { dealId: deal.recordId, version };
  },
});

export const offersCompare = defineAddonQuery(realestateAddon, {
  name: 'realestate.offers.compare',
  description:
    'A listing’s open offers side by side, newest version of each, with what the seller would take home from each, the figures used, what was last shared with the seller and what they said.',
  input: ListingInput,
  output: OffersCompareOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_compare_offers',
    description:
      'A listing’s offers side by side with the seller’s estimated net for each (an estimate).',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireListingSide(deal);
    const sheets = await sheetsOf(ctx, deal.recordId);
    const figures = await figuresOut(ctx, sheets);
    const [shared] = await ctx.tx
      .select({ id: offerComparisons.id, at: offerComparisons.sharedAt })
      .from(offerComparisons)
      .where(eq(offerComparisons.dealRecordId, deal.recordId))
      .orderBy(desc(offerComparisons.sharedAt), desc(offerComparisons.id))
      .limit(1);
    const said = await ctx.tx
      .select()
      .from(offerChoices)
      .where(eq(offerChoices.dealRecordId, deal.recordId))
      .orderBy(desc(offerChoices.at), desc(offerChoices.id));
    const clients = await dealClients(ctx, deal.recordId);
    return {
      dealId: deal.recordId,
      figures: figures[0] ?? null,
      figureHistory: figures.slice(1),
      rows: await compareRowsOf(ctx, deal, netFiguresOf(sheets[0])),
      shared: shared ? { comparisonId: shared.id, at: shared.at.toISOString() } : null,
      choices: said.map((c) => ({
        offerId: c.offerId,
        name: clients.find((p) => p.id === c.personId)?.firstName ?? 'The seller',
        choice: c.choice,
        words: c.words,
        at: c.at.toISOString(),
      })),
    };
  },
});

export const offersShareComparison = defineAddonCommand(realestateAddon, {
  name: 'realestate.offers.share_comparison',
  description:
    'Put a listing’s open offers in the seller’s portal side by side, each with what they’d take home (an estimate), as they are now.',
  risk: 2,
  input: ListingInput,
  output: OffersShareComparisonOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_share_offer_comparison',
    description:
      'Share a listing’s offers side by side with the seller in their portal. Always asks the person first.',
  },
  emits: ['realestate.offers.shared', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    requireListingSide(deal);
    const sheets = await sheetsOf(ctx, deal.recordId);
    const rows = (await compareRowsOf(ctx, deal, netFiguresOf(sheets[0]))).filter(
      (r) => r.status !== 'accepted',
    );
    if (!rows.length)
      throw HfosError.rule(
        'realestate_no_open_offers',
        409,
        `${deal.name} has no open offers to share. Add the offers first, then share them.`,
      );
    const clients = await dealClients(ctx, deal.recordId);
    if (!clients.length)
      throw HfosError.rule(
        'realestate_no_client',
        409,
        `${deal.name} has no seller on it yet. Add the seller under People on the deal, then share.`,
      );
    const address = (await listingAddress(ctx, deal)) ?? deal.name;
    const [c] = await ctx.tx
      .insert(offerComparisons)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        shown: { address, figuresVersion: sheets[0]?.version ?? null, rows },
        sharedBy: actorUserId(ctx),
        sharedAt: changeMoment(ctx.meta),
      })
      .returning({ id: offerComparisons.id });
    await historyLine(ctx, deal, 'offers_shared', { after: { count: rows.length } });
    // S-42 "Compare multiple offers" and S-43 "Explain offers to seller".
    await addProof(
      ctx,
      deal,
      { keys: ['S-42', 'S-43'] },
      {
        kind: 'record',
        refKind: 'offer_comparison',
        refId: c!.id,
        body: `${rows.length} ${rows.length === 1 ? 'offer' : 'offers'} side by side, shared with the seller`,
      },
    );
    await ctx.emit({
      type: 'realestate.offers.shared',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { comparisonId: c!.id, offers: rows.length },
    });
    return { comparisonId: c!.id, offers: rows.length };
  },
});

// ---------- the seller's ----------

export const portalOfferChoice = defineAddonCommand(realestateAddon, {
  name: 'realestate.portal.offer_choice',
  description:
    'The seller says what they want to do about an offer shared with them (accept, counter, decline, or let’s talk), in their words. It tells their agent; it accepts nothing.',
  risk: 1,
  input: PortalOfferChoiceInput,
  output: PortalOfferChoiceOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['realestate.offers.seller_chose'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [c] = await ctx.tx
      .select()
      .from(offerComparisons)
      .where(
        and(
          eq(offerComparisons.id, input.comparisonId),
          eq(offerComparisons.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    const notYours = () =>
      HfosError.notFound('Those offers aren’t in your portal any more. Refresh to see the newest.');
    if (!c) throw notYours();
    const deal = await loadDeal(ctx, c.dealRecordId);
    const clients = await dealClients(ctx, deal.recordId);
    if (!clients.some((p) => p.id === me.personId)) throw notYours();
    requireOpen(deal);
    const shownRows = ((c.shown as { rows?: CompareRowOut[] }).rows ?? []) as CompareRowOut[];
    const row = shownRows.find((r) => r.offerId === input.offerId);
    if (!row) throw notYours();
    const [o] = await ctx.tx
      .select({ status: offers.status })
      .from(offers)
      .where(eq(offers.id, input.offerId));
    if (!o || !LIVE_OFFER_STATUSES.includes(o.status))
      throw HfosError.rule(
        'realestate_offer_ended',
        409,
        'That offer isn’t open any more. Your agent will tell you what happened.',
      );
    const [choice] = await ctx.tx
      .insert(offerChoices)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        comparisonId: c.id,
        offerId: input.offerId,
        personId: me.personId,
        choice: input.choice,
        words: input.words?.trim() || null,
        at: changeMoment(ctx.meta),
      })
      .returning({ id: offerChoices.id });
    const name = clients.find((p) => p.id === me.personId)?.firstName ?? 'The seller';
    await historyLine(ctx, deal, 'seller_chose', {
      after: {
        name,
        choice: input.choice,
        number: row.number,
        buyers: row.buyers,
      },
      note: input.words ?? null,
    });
    await ctx.emit({
      type: 'realestate.offers.seller_chose',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        choiceId: choice!.id,
        offerId: input.offerId,
        choice: input.choice,
        name,
        buyers: row.buyers,
        number: row.number,
        ownerUserId: deal.ownerUserId,
        words: SELLER_CHOICES[input.choice],
      },
    });
    return { choiceId: choice!.id };
  },
});

export const offerCompareQueries = [offersCompare] as const;
export const offerCompareCommands = [
  netSheetSave,
  offersShareComparison,
  portalOfferChoice,
] as const;
