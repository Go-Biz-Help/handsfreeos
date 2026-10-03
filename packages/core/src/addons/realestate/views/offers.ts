/**
 * A deal's offers from a phone's copy (Real Estate round six): every offer and counter, as `realestate.offers`
 * answers it (ops/offers.ts), and a listing's offers side by side with the seller's estimate for each, as
 * `realestate.offers.compare` does (ops/offer-compare.ts), worked out from the rows the phone keeps with the same pure
 * `offer-words.ts` and `net.ts`. The clock's words read the business's time zone, which the phone passes in.
 * `packages/core/test/addons/realestate-phone-offers.test.ts` holds both to the server's answer.
 *
 * A deal kept as its summary (someone who sees every deal, not on this one) has no offers on the phone: null, and they
 * wait for signal. The seller's choices name the seller by first name, which the copy doesn't keep apart from the
 * last: until it does, the first word of their name.
 *
 * Browser-safe and pure.
 */
import type { z } from 'zod';
import { netFiguresOf, netSheetOut, type NetSheetRow } from '../net';
import {
  agentFirstNameOf,
  compareRows,
  offerOut,
  type LoanType,
  type OfferDocumentRow,
  type OfferRow,
  type OfferStatus,
  type OfferVersionRow,
} from '../offer-words';
import type { OffersCompareOutput, OffersOutput } from '../schemas';
import { byTimeAsc, byTimeDesc, num, str, yesNo } from './columns';
import { holdsWhole, isoOr } from './deal-facts';
import { byText, iso, type RealestateCopy } from './synced';

export type OffersView = z.infer<typeof OffersOutput>;
export type OffersCompareView = z.infer<typeof OffersCompareOutput>;

/** The deal's offers and every version of each, as the server reads them. */
function offerRowsOf(copy: RealestateCopy, dealId: string) {
  const offers = copy
    .rows('offers', dealId)
    .map(({ id, data: o }): OfferRow => ({
      id,
      number: num(o.number) ?? 0,
      homeId: str(o.home_id),
      buyerNames: str(o.buyer_names),
      status: str(o.status) as OfferStatus,
      theirAgentName: str(o.their_agent_name),
      theirBrokerage: str(o.their_brokerage),
      theirEmail: str(o.their_email),
      theirPhone: str(o.their_phone),
      acceptedVersionId: str(o.accepted_version_id),
      endedAt: isoOr(o.ended_at),
      endedReason: str(o.ended_reason),
      sharedVersionId: str(o.shared_version_id),
      sharedAt: isoOr(o.shared_at),
    }))
    .sort((a, b) => b.number - a.number);
  const versions = copy
    .rows('offer_versions', dealId)
    .map(({ id, data: v }): OfferVersionRow => ({
      id,
      offerId: str(v.offer_id) ?? '',
      number: num(v.number) ?? 0,
      side: str(v.side) as OfferVersionRow['side'],
      at: isoOr(v.at) ?? iso(0),
      priceCents: num(v.price_cents) ?? 0,
      emdCents: num(v.emd_cents),
      emdDays: num(v.emd_days),
      sellerCreditCents: num(v.seller_credit_cents) ?? 0,
      inspectionDays: num(v.inspection_days),
      loanType: str(v.loan_type) as LoanType | null,
      financingDays: num(v.financing_days),
      appraisalContingency: yesNo(v.appraisal_contingency),
      closingDate: str(v.closing_date),
      otherTerms: str(v.other_terms),
      downPaymentPct: num(v.down_payment_pct),
      homeSaleContingency: yesNo(v.home_sale_contingency),
      escalationCapCents: num(v.escalation_cap_cents),
      escalationStepCents: num(v.escalation_step_cents),
      possession: str(v.possession),
      buyerAgentFeeBp: num(v.buyer_agent_fee_bp),
      buyerAgentFeeCents: num(v.buyer_agent_fee_cents),
      respondBy: isoOr(v.respond_by),
      note: str(v.note),
    }))
    .sort((a, b) => a.number - b.number);
  return { offers, versions };
}

/** The deal's offers, newest first; null when the phone doesn't hold the deal whole. */
export function offersOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: {
    readonly userId: string | null;
    readonly now: number;
    /** The business's time zone, for when each is due. */
    readonly timeZone: string;
  },
): OffersView | null {
  const deal = copy.deals.get(dealId);
  if (!deal || !holdsWhole(copy, dealId, ctx.userId)) return null;
  const { offers, versions } = offerRowsOf(copy, dealId);
  const addresses = new Map(copy.rows('homes', dealId).map((h) => [h.id, str(h.data.address)]));
  // A listing's offers are on the listing itself: its home's address.
  const home = copy.homes.get(dealId);
  const listingAt = offers.some((o) => !o.homeId)
    ? ((home ? copy.record(home) : null) ?? deal.name)
    : deal.name;
  const documents = [...copy.rows('documents', dealId)]
    .sort((a, b) => byTimeAsc(a.data.created_at, b.data.created_at) || byText(a.id, b.id))
    .map(({ id, data: d }): OfferDocumentRow => ({
      id,
      title: str(d.title) ?? '',
      status: str(d.status) ?? 'draft',
      lineageId: str(d.lineage_id) ?? '',
      version: num(d.version) ?? 0,
      offerVersionId: str(d.offer_version_id),
    }));
  const agentFirstName = agentFirstNameOf(deal.ownerUserId ? copy.user(deal.ownerUserId) : null);
  return {
    offers: offers.flatMap((o) => {
      const mine = versions.filter((v) => v.offerId === o.id);
      // An offer and its versions arrive together; until then, it waits.
      if (!mine.length) return [];
      const address = (o.homeId ? addresses.get(o.homeId) : null) ?? listingAt;
      return [
        offerOut(o, address, mine, documents, {
          agentFirstName,
          timeZone: ctx.timeZone,
          now: ctx.now,
        }),
      ];
    }),
  };
}

/** A listing's offers side by side; null on a buyer deal, or when the phone doesn't hold the listing whole. */
export function offersCompareOfCopy(
  copy: RealestateCopy,
  dealId: string,
  ctx: { readonly userId: string | null },
): OffersCompareView | null {
  const deal = copy.deals.get(dealId);
  if (!deal || deal.data.side !== 'listing' || !holdsWhole(copy, dealId, ctx.userId)) return null;
  const sheets = copy
    .rows('net_sheets', dealId)
    .map(({ data: s }): NetSheetRow => ({
      version: num(s.version) ?? 0,
      payoffCents: num(s.payoff_cents) ?? 0,
      listingFeeBp: num(s.listing_fee_bp),
      listingFeeCents: num(s.listing_fee_cents),
      titleEscrowCents: num(s.title_escrow_cents) ?? 0,
      transferTaxBp: num(s.transfer_tax_bp) ?? 0,
      otherCents: num(s.other_cents) ?? 0,
      otherNote: str(s.other_note),
      note: str(s.note),
      savedAt: isoOr(s.saved_at) ?? iso(0),
      savedBy: str(s.saved_by),
    }))
    .sort((a, b) => b.version - a.version);
  const figures = sheets.map((s) => netSheetOut(s, s.savedBy ? copy.user(s.savedBy) : null));
  const { offers, versions } = offerRowsOf(copy, dealId);
  const [shared] = [...copy.rows('offer_comparisons', dealId)].sort(
    (a, b) => byTimeDesc(a.data.shared_at, b.data.shared_at) || byText(b.id, a.id),
  );
  const clients = new Set(
    (copy.linksTo.get(dealId) ?? [])
      .filter((l) => l.addonKey === 'realestate_client' && l.personId)
      .map((l) => l.personId!),
  );
  return {
    dealId,
    figures: figures[0] ?? null,
    figureHistory: figures.slice(1),
    rows: compareRows(offers, versions, netFiguresOf(sheets[0])),
    shared: shared ? { comparisonId: shared.id, at: isoOr(shared.data.shared_at) ?? iso(0) } : null,
    choices: [...copy.rows('offer_choices', dealId)]
      .sort((a, b) => byTimeDesc(a.data.at, b.data.at) || byText(b.id, a.id))
      .map(({ data: c }) => {
        const person = str(c.person_id) ?? '';
        return {
          offerId: str(c.offer_id) ?? '',
          name: clients.has(person)
            ? (copy.personPlain(person) ?? '').split(' ')[0]!
            : 'The seller',
          choice: str(c.choice) as OffersCompareView['choices'][number]['choice'],
          words: str(c.words),
          at: isoOr(c.at) ?? iso(0),
        };
      }),
  };
}
