/**
 * A deal's commission (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Deals"; Chris, 2026-09-30): agreed as a rate
 * of the price or a flat amount, less any credit given back to the client, and the agent's share of that under the
 * brokerage split. The final amount is set by owners and admins once it's paid, and never worked out. In cents, with
 * core's rounding (money/totals.ts). Browser-safe and pure.
 */
import { BASIS_POINTS, roundHalfUp } from '../../money/totals';

export interface CommissionTerms {
  /** Basis points of the price: 250 is 2.5%. */
  readonly rateBp: number | null;
  /** A flat amount instead of a rate. */
  readonly flatCents: number | null;
  /** Given back to the client from it. */
  readonly creditCents: number;
  /** The agent's share, in basis points of what's left: 7000 is 70%. */
  readonly splitBp: number | null;
}

export interface CommissionNow {
  /** Before the credit: the flat amount, or the rate of the price once there is one. */
  readonly grossCents: number | null;
  /** What the business expects to be paid. */
  readonly expectedCents: number | null;
  /** The agent's share of that, under the split. */
  readonly agentShareCents: number | null;
}

export function commissionOf(terms: CommissionTerms, priceCents: number | null): CommissionNow {
  const gross =
    terms.flatCents !== null
      ? terms.flatCents
      : terms.rateBp !== null && priceCents !== null
        ? roundHalfUp((priceCents * terms.rateBp) / BASIS_POINTS)
        : null;
  const expected = gross === null ? null : Math.max(0, gross - terms.creditCents);
  return {
    grossCents: gross,
    expectedCents: expected,
    agentShareCents:
      expected === null || terms.splitBp === null
        ? null
        : roundHalfUp((expected * terms.splitBp) / BASIS_POINTS),
  };
}
