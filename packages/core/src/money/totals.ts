/**
 * The arithmetic every screen, email and customer page trusts. Pure and total: the same input always gives the
 * same cents, and nothing here throws. Browser-safe.
 *
 * The rules, in order:
 * 1. A line is `roundHalfUp(quantity × unitPriceCents)` less its own discount, never below zero.
 * 2. A document discount is shared across the lines in proportion to their subtotals, the odd pennies going to
 *    the largest line, **before** tax.
 * 3. Tax is one rounding step for the whole document: `roundHalfUp(taxable base × rate / 10,000)`. Rounding each
 *    line would drift a penny or two away from what the lines add up to.
 * 4. `total = subtotal + tax`, `balance = total − paid + refunded`.
 *
 * Money is integer cents (USD). Quantities are the only decimals: up to three places.
 */

/** A quantity's decimal places: 2.125 hours is as fine as it gets. */
export const QUANTITY_PLACES = 3;
const QUANTITY_SCALE = 1000;

/** 100% in basis points. A rate of 825 bp is 8.25%. */
export const BASIS_POINTS = 10_000;

const finite = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

/**
 * To the nearest whole number, halves away from zero: 2.5 → 3, −2.5 → −3. Every rounding in the money core
 * goes through here, so a total never depends on how a number was reached.
 */
export function roundHalfUp(value: number): number {
  const v = finite(value);
  return (v < 0 ? -Math.round(-v) : Math.round(v)) || 0;
}

/** Cents as stored: a whole number (a fractional cent rounds to the nearest one). */
const whole = (value: number | null | undefined): number => roundHalfUp(finite(value));

/** A quantity in thousandths: 2.5 → 2500. Negative quantities count as none; finer than a thousandth rounds. */
export function quantityThousandths(quantity: number | null | undefined): number {
  return Math.max(0, roundHalfUp(finite(quantity) * QUANTITY_SCALE));
}

/** `quantity × unitPrice`, rounded to the cent once. Exact for quantities of up to three decimal places. */
export function lineAmountCents(quantity: number, unitPriceCents: number): number {
  return roundHalfUp((quantityThousandths(quantity) * whole(unitPriceCents)) / QUANTITY_SCALE);
}

/** One line of an estimate or invoice. */
export interface MoneyLine {
  /** Up to three decimal places; less than none counts as none. */
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** Money off this line. It never takes the line below zero. */
  readonly discountCents?: number;
  /**
   * Sales tax applies to this line. Taxable unless it says otherwise, as `invoice_lines.taxable` is: the
   * catalogue's own flag decides it when a line is added, and labour is the line a business marks off.
   */
  readonly taxable?: boolean;
}

/** A discount on the whole document: none, a percentage of the lines, or a flat amount. */
export interface DocumentDiscount {
  readonly kind: 'none' | 'percent' | 'amount';
  /** For 'percent', in basis points: 1,000 is 10%. */
  readonly percentBp?: number;
  /** For 'amount', in cents. */
  readonly amountCents?: number;
}

/** What a business asks for up front: none, a percentage of the total, or a flat amount. */
export interface DepositTerms {
  readonly kind: 'none' | 'percent' | 'amount';
  /** For 'percent', in basis points: 2,500 is 25%. */
  readonly percentBp?: number;
  /** For 'amount', in cents. */
  readonly amountCents?: number;
}

export const NO_DISCOUNT: DocumentDiscount = { kind: 'none' };
export const NO_DEPOSIT: DepositTerms = { kind: 'none' };

export interface TotalsInput {
  readonly lines: readonly MoneyLine[];
  readonly discount?: DocumentDiscount;
  /** Sales tax in basis points, snapshotted onto the document when it's sent. */
  readonly taxRateBp?: number;
  /** What has been paid so far (cash and card alike). */
  readonly paidCents?: number;
  /** What has been given back. */
  readonly refundedCents?: number;
  readonly deposit?: DepositTerms;
}

export interface LineTotals {
  /** `quantity × unitPrice`, rounded. */
  readonly amountCents: number;
  /** The line's own discount, as much of it as the line could take. */
  readonly discountCents: number;
  /** `amount − its own discount`. */
  readonly subtotalCents: number;
  /** Its share of the document discount. */
  readonly allocatedCents: number;
  /** `subtotal − its share`: what tax is worked out on. */
  readonly netCents: number;
  readonly taxable: boolean;
}

export interface DocumentTotals {
  readonly lines: readonly LineTotals[];
  /** The lines added up, before the document discount. */
  readonly lineSubtotalCents: number;
  /** The document discount actually taken (never more than the lines come to). */
  readonly discountCents: number;
  /** `lineSubtotal − discount`. */
  readonly subtotalCents: number;
  /** The taxable lines' share of the subtotal. */
  readonly taxableBaseCents: number;
  readonly taxRateBp: number;
  readonly taxCents: number;
  readonly totalCents: number;
  /** What's asked for up front; never more than the total. */
  readonly depositCents: number;
  readonly paidCents: number;
  readonly refundedCents: number;
  /** What's still owed: `total − paid + refunded`. */
  readonly balanceCents: number;
}

/** A line's own subtotal: `roundHalfUp(quantity × unitPrice)` less its discount, never below zero. */
export function lineSubtotalCents(line: MoneyLine): number {
  const amount = lineAmountCents(line.quantity, line.unitPriceCents);
  const off = Math.max(0, whole(line.discountCents));
  return Math.max(0, amount - Math.min(off, Math.max(0, amount)));
}

/**
 * A document discount shared across lines in proportion to their subtotals: each line gets its whole pennies,
 * and the remainder goes to the largest line (the first of them, when two are the same). Lines worth nothing get
 * nothing. The shares always add up to the discount.
 */
export function allocateDiscount(subtotals: readonly number[], discountCents: number): number[] {
  const shares = subtotals.map(() => 0);
  const base = subtotals.reduce((sum, s) => sum + Math.max(0, s), 0);
  const total = Math.min(Math.max(0, whole(discountCents)), base);
  if (total === 0 || base === 0) return shares;
  let given = 0;
  for (let i = 0; i < subtotals.length; i++) {
    const share = Math.floor((total * Math.max(0, subtotals[i] ?? 0)) / base);
    shares[i] = share;
    given += share;
  }
  const remainder = total - given;
  if (remainder > 0) {
    let largest = 0;
    for (let i = 1; i < subtotals.length; i++)
      if (Math.max(0, subtotals[i] ?? 0) > Math.max(0, subtotals[largest] ?? 0)) largest = i;
    shares[largest] = (shares[largest] ?? 0) + remainder;
  }
  return shares;
}

/** What a document discount comes to against the lines: a percentage of them, or the amount, capped at the lines. */
export function discountCentsOf(
  discount: DocumentDiscount | undefined,
  linesTotalCents: number,
): number {
  const base = Math.max(0, whole(linesTotalCents));
  if (!discount || discount.kind === 'none') return 0;
  const asked =
    discount.kind === 'percent'
      ? roundHalfUp((base * clampBp(discount.percentBp)) / BASIS_POINTS)
      : Math.max(0, whole(discount.amountCents));
  return Math.min(asked, base);
}

const clampBp = (bp: number | null | undefined): number =>
  Math.min(BASIS_POINTS, Math.max(0, roundHalfUp(finite(bp))));

/** Tax: one rounding step for the document, never on a line. */
export function taxCentsOf(taxableBaseCents: number, taxRateBp: number): number {
  const base = Math.max(0, whole(taxableBaseCents));
  return roundHalfUp((base * clampBp(taxRateBp)) / BASIS_POINTS);
}

/** What's still owed: `total − paid + refunded`. A credit shows as a negative balance. */
export function balanceCents(totalCents: number, paidCents: number, refundedCents: number): number {
  return whole(totalCents) - whole(paidCents) + whole(refundedCents);
}

/**
 * The deposit on a total: a percentage of it, or the amount. Never more than the total — `depositProblem` says
 * so before anything is saved, and this keeps the arithmetic honest either way.
 */
export function depositCentsOf(terms: DepositTerms | undefined, totalCents: number): number {
  const total = Math.max(0, whole(totalCents));
  if (!terms || terms.kind === 'none') return 0;
  const asked =
    terms.kind === 'percent'
      ? roundHalfUp((total * clampBp(terms.percentBp)) / BASIS_POINTS)
      : Math.max(0, whole(terms.amountCents));
  return Math.min(asked, total);
}

/** Why a deposit can't be asked for on this total, in a sentence, or null. */
export function depositProblem(terms: DepositTerms | undefined, totalCents: number): string | null {
  if (!terms || terms.kind === 'none') return null;
  const total = Math.max(0, whole(totalCents));
  if (terms.kind === 'percent') {
    const bp = roundHalfUp(finite(terms.percentBp));
    if (bp <= 0) return 'Set how much of the total the deposit is.';
    if (bp > BASIS_POINTS) return 'A deposit can’t be more than the whole total.';
    return null;
  }
  const amount = whole(terms.amountCents);
  if (amount <= 0) return 'Set how much the deposit is.';
  if (amount > total) return 'A deposit can’t be more than the total.';
  return null;
}

/** Every figure on a document, from its lines. */
export function computeTotals(input: TotalsInput): DocumentTotals {
  const lines = input.lines ?? [];
  const subtotals = lines.map(lineSubtotalCents);
  const lineSubtotal = subtotals.reduce((sum, s) => sum + s, 0);
  const discount = discountCentsOf(input.discount, lineSubtotal);
  const shares = allocateDiscount(subtotals, discount);
  const detailed: LineTotals[] = lines.map((line, i) => {
    const amount = lineAmountCents(line.quantity, line.unitPriceCents);
    const subtotal = subtotals[i] ?? 0;
    const allocated = shares[i] ?? 0;
    return {
      amountCents: amount,
      discountCents: amount - subtotal,
      subtotalCents: subtotal,
      allocatedCents: allocated,
      netCents: subtotal - allocated,
      taxable: line.taxable !== false,
    };
  });
  const subtotal = lineSubtotal - discount;
  const taxableBase = detailed.reduce((sum, l) => (l.taxable ? sum + l.netCents : sum), 0);
  const taxRateBp = clampBp(input.taxRateBp);
  const tax = taxCentsOf(taxableBase, taxRateBp);
  const total = subtotal + tax;
  const paid = Math.max(0, whole(input.paidCents));
  const refunded = Math.max(0, whole(input.refundedCents));
  return {
    lines: detailed,
    lineSubtotalCents: lineSubtotal,
    discountCents: discount,
    subtotalCents: subtotal,
    taxableBaseCents: taxableBase,
    taxRateBp,
    taxCents: tax,
    totalCents: total,
    depositCents: depositCentsOf(input.deposit, total),
    paidCents: paid,
    refundedCents: refunded,
    balanceCents: balanceCents(total, paid, refunded),
  };
}
