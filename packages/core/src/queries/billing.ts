/**
 * Reading billing for a founding plan (20261027023600).
 *
 * - `billing.status` is what **everyone** in the business may know: whether a payment failed, and whether they can
 *   fix it. The failed-payment page reads it on every screen, on the web and the phone.
 * - `billing.get` is Settings → Billing: the plan, its next payment, its cards and what's owed. For whoever manages
 *   money; the cards themselves are hidden from everyone else by the database.
 * - `billing.pay_day_quote` is what moving the payment day would cost or give back, before anybody presses.
 * - `platform.billing.business` is the same for staff, on a business's page in Admin, with its requests for more time.
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import { payDayRefusalMessage } from '../commands/billing';
import {
  BillingGetInput,
  BillingGetOutput,
  BillingPayDayQuoteInput,
  BillingPayDayQuoteOutput,
  BillingStatusInput,
  BillingStatusOutput,
  PlatformBillingBusinessInput,
  PlatformBillingBusinessOutput,
} from '../schemas/billing';

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const isoDay = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined
    ? null
    : typeof d === 'string'
      ? d.slice(0, 10)
      : d.toISOString().slice(0, 10);

type PlanRow = {
  plan: 'founding_free' | 'founding_lifetime' | 'monthly' | null;
  status: string | null;
  price_cents: number | null;
  offer_name: string | null;
  current_period_end: Date | string | null;
  renewal_stopped_at: Date | string | null;
  renewal_problem: string | null;
  renewal_failed_at: Date | string | null;
  next_retry_at: Date | string | null;
  more_time_until: Date | string | null;
  charge_cents: number | null;
  pay_day_credit_cents: number | null;
  pay_day_change_to: Date | string | null;
  pay_day_change_cents: number | null;
  pay_day_change_problem: string | null;
  trial_ends_at: Date | string | null;
};

async function planOf(
  ctx: QueryContext,
  workspaceId: string,
): Promise<(PlanRow & { grant_active: boolean }) | undefined> {
  const [p] = await rows<PlanRow>(
    ctx.tx,
    // The grant is never theirs to read, so whether the seat is still theirs comes from private.plan_offer_name.
    sql`select p.plan::text as plan, p.status::text as status, p.price_cents,
          private.plan_offer_name(p.workspace_id) as offer_name,
          p.current_period_end, p.renewal_stopped_at, p.renewal_problem, p.renewal_failed_at, p.next_retry_at,
          p.more_time_until, p.pay_day_credit_cents, p.pay_day_change_to, p.pay_day_change_cents,
          p.pay_day_change_problem,
          greatest(p.price_cents
                   - case when p.discount_cents > 0
                           and (p.discount_until is null or p.current_period_end < p.discount_until)
                          then p.discount_cents else 0 end
                   - p.pay_day_credit_cents, 0) as charge_cents,
          case when p.trial_ends_at > now() and p.renewal_count = 0 then p.trial_ends_at end as trial_ends_at
        from app.workspace_plans p
        where p.workspace_id = ${workspaceId}::uuid`,
  );
  return p && { ...p, grant_active: p.offer_name !== null };
}

type RequestRow = {
  id: string;
  status: 'pending' | 'granted' | 'declined';
  pay_by: Date | string;
  granted_until: Date | string | null;
  created_at: Date | string;
  answered_at: Date | string | null;
};

/** What's owed, if anything: a payment that failed and hasn't been paid since. */
async function owedOf(
  ctx: QueryContext,
  workspaceId: string,
  p: (PlanRow & { grant_active: boolean }) | undefined,
) {
  if (!p?.renewal_failed_at || p.status !== 'past_due' || !p.grant_active) return null;
  const [req] = await rows<RequestRow>(
    ctx.tx,
    sql`select id, status::text as status, pay_by::text as pay_by, granted_until::text as granted_until,
          created_at, answered_at
        from app.plan_time_requests
        where workspace_id = ${workspaceId}::uuid and created_at >= ${iso(p.renewal_failed_at)}::timestamptz
        order by created_at desc limit 1`,
  );
  const moreTime =
    p.more_time_until && new Date(p.more_time_until) > new Date() ? p.more_time_until : null;
  return {
    failedAt: iso(p.renewal_failed_at)!,
    amountCents: Number(p.charge_cents ?? 0),
    problem: p.renewal_problem,
    nextRetryAt: moreTime ? null : iso(p.next_retry_at),
    moreTimeUntil: iso(moreTime),
    timeRequest: req
      ? {
          id: req.id,
          status: req.status,
          payBy: isoDay(req.pay_by)!,
          grantedUntil: isoDay(req.granted_until),
          askedAt: iso(req.created_at)!,
          answeredAt: iso(req.answered_at),
        }
      : null,
  };
}

const workspaceScope = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const billingStatus = defineQuery({
  name: 'billing.status',
  description:
    'Whether this business owes HandsFreeOS a plan payment that didn’t go through, and whether you can fix it. The failed-payment page reads it.',
  input: BillingStatusInput,
  output: BillingStatusOutput,
  // Everyone in the business sees the failed-payment page, so everyone may ask.
  permission: 'workspace.read',
  scope: workspaceScope,
  async handler(ctx, input) {
    const p = await planOf(ctx, input.workspaceId);
    const owed = await owedOf(ctx, input.workspaceId, p);
    const canManage = (ctx.scope.workspacePermissions ?? []).includes('money.manage');
    let askWho: string | null = null;
    if (owed && !canManage) {
      const [owner] = await rows<{ name: string | null }>(
        ctx.tx,
        sql`select private.plan_owner_name(${input.workspaceId}::uuid) as name`,
      );
      askWho = owner?.name ?? null;
    }
    return { workspaceId: input.workspaceId, owed, canManage, askWho };
  },
});

export const billingGet = defineQuery({
  name: 'billing.get',
  description:
    'Settings → Billing: the business’s HandsFreeOS plan, when and what its next payment is, its cards (default first, then backups in the order they’re tried) and anything owed.',
  input: BillingGetInput,
  output: BillingGetOutput,
  permission: 'money.manage',
  scope: workspaceScope,
  async handler(ctx, input) {
    const p = await planOf(ctx, input.workspaceId);
    const billed = !!p?.current_period_end && Number(p.price_cents ?? 0) > 0 && p.grant_active;
    const cards = await rows<{
      id: string;
      card_brand: string | null;
      card_last4: string | null;
      card_expiry_month: number | null;
      card_expiry_year: number | null;
      is_default: boolean;
      last_declined_at: Date | string | null;
      last_decline: string | null;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select id, card_brand, card_last4, card_expiry_month, card_expiry_year, is_default, last_declined_at,
            last_decline, created_at
          from app.plan_cards where workspace_id = ${input.workspaceId}::uuid
          order by is_default desc, created_at, id`,
    );
    let payDayBounds: { earliest: string; latest: string } | null = null;
    if (billed) {
      const [q] = await rows<{
        earliest: string | null;
        latest: string | null;
        refusal: string | null;
      }>(
        ctx.tx,
        // Asked with the day it already is: the bounds come back, and the only refusal is why it can't move at all.
        sql`select earliest::text as earliest, latest::text as latest, refusal
            from private.plan_pay_day_quote(${input.workspaceId}::uuid,
              (${iso(p!.current_period_end)}::timestamptz at time zone 'UTC')::date)`,
      );
      if (q?.earliest && q.latest && (q.refusal === null || q.refusal === 'plan_pay_day_same'))
        payDayBounds = { earliest: q.earliest, latest: q.latest };
    }
    const owed = await owedOf(ctx, input.workspaceId, p);
    return {
      workspaceId: input.workspaceId,
      billed,
      offerName: p?.offer_name ?? null,
      plan: p?.plan ?? null,
      priceCents: Number(p?.price_cents ?? 0),
      paidThrough: iso(p?.current_period_end),
      nextChargeCents: Number(p?.charge_cents ?? 0),
      payDayCreditCents: Number(p?.pay_day_credit_cents ?? 0),
      renewing: !!p?.current_period_end && !p.renewal_stopped_at,
      trialEndsAt: iso(p?.trial_ends_at),
      payDayChange:
        p && (p.pay_day_change_to || p.pay_day_change_problem)
          ? {
              to: iso(p.pay_day_change_to),
              cents: p.pay_day_change_cents === null ? null : Number(p.pay_day_change_cents),
              problem: p.pay_day_change_problem,
            }
          : null,
      payDayBounds,
      cards: cards.map((c) => ({
        id: c.id,
        brand: c.card_brand,
        last4: c.card_last4,
        expiryMonth: c.card_expiry_month === null ? null : Number(c.card_expiry_month),
        expiryYear: c.card_expiry_year === null ? null : Number(c.card_expiry_year),
        isDefault: c.is_default,
        lastDeclinedAt: iso(c.last_declined_at),
        lastDecline: c.last_decline,
        addedAt: iso(c.created_at)!,
      })),
      owed,
    };
  },
});

export const billingPayDayQuote = defineQuery({
  name: 'billing.pay_day_quote',
  description:
    'What moving the business’s HandsFreeOS payment day to a given day would do: later costs the days it adds, paid now; earlier takes the days given up off the next payment. Says why when it can’t move there.',
  input: BillingPayDayQuoteInput,
  output: BillingPayDayQuoteOutput,
  permission: 'money.manage',
  scope: workspaceScope,
  async handler(ctx, input) {
    const [q] = await rows<{
      kind: 'later' | 'earlier' | 'same';
      days: number;
      cents: number;
      new_paid_through: Date | string | null;
      earliest: string | null;
      latest: string | null;
      refusal: string | null;
    }>(
      ctx.tx,
      sql`select kind, days, cents, new_paid_through, earliest::text as earliest, latest::text as latest, refusal
          from private.plan_pay_day_quote(${input.workspaceId}::uuid, ${input.day}::date)`,
    );
    if (!q) throw HfosError.internal();
    const p = await planOf(ctx, input.workspaceId);
    const charge = Number(p?.charge_cents ?? 0);
    return {
      kind: q.kind,
      days: Number(q.days),
      cents: Number(q.cents),
      nextChargeCents: q.kind === 'earlier' ? Math.max(charge - Number(q.cents), 0) : charge,
      newPaidThrough: iso(q.new_paid_through),
      earliest: q.earliest,
      latest: q.latest,
      refusal: q.refusal,
      refusalMessage: q.refusal ? payDayRefusalMessage(q.refusal) : null,
    };
  },
});

// ---------- staff ----------

export const platformBillingBusiness = defineQuery({
  name: 'platform.billing.business',
  description:
    'One business’s plan billing, for its page in Admin: anything owed, how many cards it has, and its requests for more time to pay. Staff only.',
  input: PlatformBillingBusinessInput,
  output: PlatformBillingBusinessOutput,
  permission: 'platform.founding.manage',
  scope: () => ({ kind: 'platform' as const }),
  async handler(ctx, input) {
    const p = await planOf(ctx, input.workspaceId);
    const owed = await owedOf(ctx, input.workspaceId, p);
    const [cards] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.plan_cards where workspace_id = ${input.workspaceId}::uuid`,
    );
    const requests = await rows<
      RequestRow & { note: string; ticket_number: number | null; asked_by: string | null }
    >(
      ctx.tx,
      sql`select r.id, r.status::text as status, r.pay_by::text as pay_by, r.granted_until::text as granted_until,
            r.created_at, r.answered_at, r.note, t.number as ticket_number,
            coalesce(nullif(btrim(u.full_name), ''), u.email::text) as asked_by
          from app.plan_time_requests r
          left join platform.tickets t on t.id = r.ticket_id
          left join app.users u on u.id = r.asked_by
          where r.workspace_id = ${input.workspaceId}::uuid
          order by r.created_at desc limit 10`,
    );
    return {
      workspaceId: input.workspaceId,
      owed,
      cardCount: Number(cards?.n ?? 0),
      requests: requests.map((r) => ({
        id: r.id,
        status: r.status,
        payBy: isoDay(r.pay_by)!,
        note: r.note,
        grantedUntil: isoDay(r.granted_until),
        ticketNumber: r.ticket_number === null ? null : Number(r.ticket_number),
        askedBy: r.asked_by,
        askedAt: iso(r.created_at)!,
        answeredAt: iso(r.answered_at),
      })),
    };
  },
});

export const billingQueries = [
  billingStatus,
  billingGet,
  billingPayDayQuote,
  platformBillingBusiness,
];
