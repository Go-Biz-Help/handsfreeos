/**
 * What a business paid HandsFreeOS for its plan, and what its affiliate earns on it (20261027014200,
 * HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 2). Server-only: the founding commands call it in their own
 * transaction, so a payment is kept, and its share earned, with the write that records it, or not at all.
 *
 * **Who earns.** The affiliate the business is credited to, while they're approved: a paused or ended one earns
 * nothing on new payments, though the business's 12 months still run. Only what the business pays after it was
 * credited counts, and only for the months or years that start in its first 12 months (decision 2), counted from the
 * start of its first one. Their share is their own, or everyone's (decision 1), of what was actually paid (decision
 * 15), free to pay out 30 days later (decision 8).
 *
 * **A refund** takes back the same share of what went back, never more than was earned on that payment, and it
 * comes off with what it takes from. One the bank turns down after it went through gives it back, once.
 *
 * No events of their own: the business's own payment or refund is its event, and what an affiliate earns isn't the
 * business's to read in its history. The commissions are kept as they happened, never changed, so they are the record.
 */
import { rows, sql } from '@hfos/db/client';
import type { CommandContext } from '../kernel/types';
import { commissionCents, payableAt } from '../partners/rules';
import { AFFILIATE_MONTHS } from './words';

/** One payment a business made for its plan. */
export interface PlanPaymentInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly offerId: string | null;
  /** The first payment on a checkout page, a renewal charged to the card kept, or one paid on a page of its own. */
  readonly how: 'checkout' | 'renewal' | 'renewal_page';
  readonly checkoutId: string | null;
  /** Stripe's `pi_…`. A payment with none can't be refunded through us, so it isn't kept. */
  readonly paymentRef: string | null;
  readonly amountCents: number;
  /** The start of the month or year it pays for. */
  readonly periodFrom: Date;
  readonly paidAt: Date;
}

/** A month count on from a date, the way the database adds `interval '12 months'`. */
function monthsAfter(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Keeps a plan payment and earns its business's affiliate their share. Once per payment: a payment already kept
 * answers what it was kept as and earns nothing more.
 */
export async function notePlanPayment(
  ctx: CommandContext,
  p: PlanPaymentInput,
): Promise<{ paymentId: string; commissionId: string | null } | null> {
  if (!p.paymentRef || !(p.amountCents > 0)) return null;
  const [kept] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into platform.plan_payments
          (organization_id, workspace_id, offer_id, how, checkout_id, payment_ref, amount_cents, period_from,
           paid_at)
        values (${p.organizationId}, ${p.workspaceId}, ${p.offerId}, ${p.how}, ${p.checkoutId},
          ${p.paymentRef}, ${p.amountCents}, ${p.periodFrom.toISOString()}::timestamptz,
          ${p.paidAt.toISOString()}::timestamptz)
        on conflict (payment_ref) do nothing
        returning id`,
  );
  if (!kept) return null;
  return { paymentId: kept.id, commissionId: await earnOn(ctx, kept.id, p) };
}

async function earnOn(
  ctx: CommandContext,
  paymentId: string,
  p: PlanPaymentInput,
): Promise<string | null> {
  const [sent] = await rows<{
    affiliate_id: string;
    status: string;
    rate_bp: number;
    referred_at: Date | string;
    first_from: Date | string;
  }>(
    ctx.tx,
    sql`select a.id as affiliate_id, a.status, coalesce(a.rate_bp, s.rate_bp) as rate_bp, r.referred_at,
          (select min(q.period_from) from platform.plan_payments q
           where q.organization_id = r.organization_id) as first_from
        from platform.affiliate_referrals r
        join platform.affiliates a on a.id = r.affiliate_id
        cross join platform.affiliate_settings s
        where r.organization_id = ${p.organizationId}`,
  );
  if (!sent || sent.status !== 'approved') return null;
  // Only what they pay after they were sent counts, and only in their first 12 months.
  if (p.paidAt < new Date(sent.referred_at)) return null;
  if (p.periodFrom >= monthsAfter(new Date(sent.first_from), AFFILIATE_MONTHS)) return null;
  const amountCents = commissionCents(p.amountCents, sent.rate_bp);
  if (amountCents <= 0) return null;
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into platform.affiliate_commissions
          (affiliate_id, organization_id, payment_id, kind, base_cents, rate_bp, amount_cents, earned_at,
           payable_at)
        values (${sent.affiliate_id}, ${p.organizationId}, ${paymentId}, 'earned', ${p.amountCents},
          ${sent.rate_bp}, ${amountCents}, ${p.paidAt.toISOString()}::timestamptz,
          ${payableAt(p.paidAt).toISOString()}::timestamptz)
        on conflict (payment_id) where kind = 'earned' do nothing
        returning id`,
  );
  return row?.id ?? null;
}

/** A refund that went through takes back the affiliate's share of it, never more than they earned on the payment. */
export async function takeBackOnRefund(ctx: CommandContext, refundId: string): Promise<boolean> {
  const [refund] = await rows<{
    payment_id: string;
    amount_cents: number;
    status: string;
    refunded_at: Date | string;
  }>(
    ctx.tx,
    sql`select payment_id, amount_cents, status, refunded_at from platform.plan_refunds where id = ${refundId}`,
  );
  if (!refund || refund.status !== 'succeeded') return false;
  const [earned] = await rows<{
    affiliate_id: string;
    organization_id: string | null;
    amount_cents: string | number;
    rate_bp: number;
    payable_at: Date | string;
  }>(
    ctx.tx,
    sql`select affiliate_id, organization_id, amount_cents, rate_bp, payable_at
        from platform.affiliate_commissions
        where payment_id = ${refund.payment_id} and kind = 'earned'
        for update`,
  );
  if (!earned) return false;
  const [since] = await rows<{ cents: string | number }>(
    ctx.tx,
    sql`select coalesce(sum(amount_cents), 0) as cents from platform.affiliate_commissions
        where payment_id = ${refund.payment_id} and kind in ('taken_back', 'given_back')`,
  );
  const left = Number(earned.amount_cents) + Number(since?.cents ?? 0);
  const back = Math.min(commissionCents(Number(refund.amount_cents), earned.rate_bp), left);
  if (back <= 0) return false;
  const at = new Date(refund.refunded_at);
  // It comes off what it takes back from: while that still waits its 30 days, so does this.
  const payable = new Date(Math.max(at.getTime(), new Date(earned.payable_at).getTime()));
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into platform.affiliate_commissions
          (affiliate_id, organization_id, payment_id, refund_id, kind, base_cents, rate_bp, amount_cents,
           earned_at, payable_at)
        values (${earned.affiliate_id}, ${earned.organization_id}, ${refund.payment_id}, ${refundId},
          'taken_back', ${refund.amount_cents}, ${earned.rate_bp}, ${-back}, ${at.toISOString()}::timestamptz,
          ${payable.toISOString()}::timestamptz)
        on conflict do nothing
        returning id`,
  );
  return !!row;
}

/**
 * A refund the customer's bank turned down after it went through: the money is ours again, and so is the
 * affiliate's share of it. Commissions are kept as they happened, so the take-back stays and one of its own gives it
 * back, once, free to pay out when the take-back was.
 */
export async function giveBackOnRefund(ctx: CommandContext, refundId: string): Promise<boolean> {
  const [taken] = await rows<{
    affiliate_id: string;
    organization_id: string | null;
    payment_id: string;
    base_cents: string | number;
    rate_bp: number;
    amount_cents: string | number;
    payable_at: Date | string;
  }>(
    ctx.tx,
    sql`select affiliate_id, organization_id, payment_id, base_cents, rate_bp, amount_cents, payable_at
        from platform.affiliate_commissions
        where refund_id = ${refundId} and kind = 'taken_back'`,
  );
  if (!taken) return false;
  const back = -Number(taken.amount_cents);
  const [row] = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into platform.affiliate_commissions
          (affiliate_id, organization_id, payment_id, refund_id, kind, base_cents, rate_bp, amount_cents,
           earned_at, payable_at)
        values (${taken.affiliate_id}, ${taken.organization_id}, ${taken.payment_id}, ${refundId}, 'given_back',
          ${taken.base_cents}, ${taken.rate_bp}, ${back}, now(), ${new Date(taken.payable_at).toISOString()}::timestamptz)
        on conflict do nothing
        returning id`,
  );
  return !!row;
}
