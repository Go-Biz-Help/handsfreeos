/**
 * Estimating (docs/contractor.md, "Costs and estimates"): what an estimate costs to do, the profit and margin in each
 * of its options, and whether it needs an owner's or admin's OK before it's sent (the owner's decision 6). Pure and
 * browser-safe: the builder shows these figures as someone types, and the server works out the same ones before it
 * lets an estimate go.
 */

import { roundHalfUp as cents } from '../../money/totals';

/** What a line is, for costing: people's time, things bought, or anything else (a permit, a dumpster). */
export const COST_KINDS = ['labor', 'material', 'other'] as const;
export type CostKind = (typeof COST_KINDS)[number];

/** How a price list item is costed until someone says: a service by the hour, a fee as other, the rest bought. */
export const defaultCostKind = (productKind: string | null | undefined): CostKind =>
  productKind === 'service' ? 'labor' : productKind === 'fee' ? 'other' : 'material';

/** The lowest margin a new business starts with: 20% (decision 6). */
export const DEFAULT_MIN_MARGIN_BP = 2_000;
/** The markup a new line starts with: 50% over cost. */
export const DEFAULT_MARKUP_BP = 5_000;

export interface CostedLine {
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly discountCents: number;
  readonly kind: CostKind;
  /** What one unit costs the business: an hour of labor, one of a material. Null when nobody has said. */
  readonly unitCostCents: number | null;
}

/** What a line costs to do: its quantity at its unit cost. */
export const lineCostCents = (l: Pick<CostedLine, 'quantity' | 'unitCostCents'>): number =>
  cents(l.quantity * (l.unitCostCents ?? 0));

/** The price that puts a markup on a cost: $40 at 50% is $60. */
export const priceFromMarkup = (unitCostCents: number, markupBp: number): number =>
  cents(unitCostCents * (1 + markupBp / 10_000));

/** The markup a price is over its cost, in basis points; null when there's no cost to mark up. */
export const markupBpOf = (unitPriceCents: number, unitCostCents: number | null): number | null =>
  unitCostCents && unitCostCents > 0
    ? Math.round(((unitPriceCents - unitCostCents) / unitCostCents) * 10_000)
    : null;

/** A share of a price as a margin, in basis points: 2,500 is 25%. Null when the price is nothing. */
export const marginBpOf = (priceCents: number, costCents: number): number | null =>
  priceCents > 0 ? Math.round(((priceCents - costCents) / priceCents) * 10_000) : null;

/** One option of an estimate, costed: what it sells for, what it costs, and what's left. */
export interface OptionCosting {
  /** Its price before tax, after any discount: what the business keeps. */
  readonly priceCents: number;
  readonly laborCents: number;
  readonly materialsCents: number;
  readonly otherCents: number;
  readonly costCents: number;
  /** Hours of labor: its labor lines' quantities. */
  readonly laborHours: number;
  readonly profitCents: number;
  readonly marginBp: number | null;
  /** Labor and material lines nobody has put a cost on, so the margin can't be trusted. */
  readonly uncosted: number;
}

/**
 * Costs one option. `priceCents` is its subtotal after the discount and before tax (core's `subtotalCents`): tax is
 * the state's, not the business's.
 */
export function costOption(lines: readonly CostedLine[], priceCents: number): OptionCosting {
  const sum = (kind: CostKind) =>
    lines.filter((l) => l.kind === kind).reduce((n, l) => n + lineCostCents(l), 0);
  const laborCents = sum('labor');
  const materialsCents = sum('material');
  const otherCents = sum('other');
  const costCents = laborCents + materialsCents + otherCents;
  const hours = lines.filter((l) => l.kind === 'labor').reduce((n, l) => n + l.quantity, 0);
  return {
    priceCents,
    laborCents,
    materialsCents,
    otherCents,
    costCents,
    laborHours: Math.round(hours * 100) / 100,
    profitCents: priceCents - costCents,
    marginBp: marginBpOf(priceCents, costCents),
    uncosted: lines.filter((l) => l.kind !== 'other' && !(l.unitCostCents && l.unitCostCents > 0))
      .length,
  };
}

/** Why an estimate waits for an OK: an option under the lowest margin, or lines with no cost to check. */
export type OkReason = 'margin' | 'uncosted';

export interface MarginCheck {
  /** The thinnest option: the one the check is about. */
  readonly lowest: { readonly name: string | null; readonly marginBp: number | null } | null;
  readonly minMarginBp: number;
  readonly uncosted: number;
  /** Null when it can go out as it is. */
  readonly needsOk: OkReason | null;
}

/**
 * Checks an estimate against the business's lowest margin. Every option counts, since the customer may pick any:
 * one under the lowest margin, or with a labor or material line nobody put a cost on, waits for an owner or admin.
 */
export function checkMargin(
  options: readonly { readonly name: string | null; readonly costing: OptionCosting }[],
  minMarginBp: number,
): MarginCheck {
  const rated = options.filter((o) => o.costing.marginBp !== null);
  const thinnest = rated.reduce<(typeof rated)[number] | null>(
    (low, o) => (!low || o.costing.marginBp! < low.costing.marginBp! ? o : low),
    null,
  );
  const uncosted = options.reduce((n, o) => n + o.costing.uncosted, 0);
  const under = !!thinnest && thinnest.costing.marginBp! < minMarginBp;
  return {
    lowest: thinnest ? { name: thinnest.name, marginBp: thinnest.costing.marginBp } : null,
    minMarginBp,
    uncosted,
    needsOk: under ? 'margin' : uncosted > 0 ? 'uncosted' : null,
  };
}

/** "18.5%" from basis points, to one decimal place when it isn't whole. */
export const marginWords = (bp: number): string =>
  `${(Math.round(bp / 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
