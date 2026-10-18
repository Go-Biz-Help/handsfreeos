/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3), for whoever holds `partners.manage`: whether
 * payouts are open, the card they're charged to, the next payout as it stands now (who it would pay, who waits and
 * why, and what it would charge), and each month's payout with its statement. The next payout is worked out as
 * `partner.payout_build` works it out, from live payments only.
 */
import { rows, sql } from '@hfos/db/client';
import {
  COMMISSION_DISPUTED,
  COMMISSION_NOT_IN_PAYOUT,
  payoutCardOf,
  type BillingRow,
} from '../commands/partner-payouts';
import { loadPartnerSettings, PERSON_NAME } from '../commands/partners';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import { PAYOUT_WORDS } from '../partners/payout-words';
import { nextPayoutMonth, payoutTotals, planPayout } from '../partners/payouts';
import {
  PartnerPayoutGetInput,
  PartnerPayoutGetOutput,
  PartnerPayoutsInput,
  PartnerPayoutsOutput,
  PlatformPartnerPayoutsGetInput,
  PlatformPartnerPayoutsGetOutput,
  type PartnerPayoutLineOut,
  type PartnerPayoutOut,
  type PayoutLineStatus,
  type PayoutStatus,
} from '../schemas/partner-payouts';
import type { PartnerGetOutput } from '../schemas/partners';
import type { z } from 'zod';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v ? iso(v) : null);

type PayoutRow = {
  id: string;
  month: string;
  livemode: boolean;
  status: PayoutStatus;
  owed_cents: string | number;
  account_fees_cents: string | number;
  payout_fees_cents: string | number;
  card_fee_cents: string | number;
  charge_cents: string | number;
  card_brand: string | null;
  card_last4: string | null;
  partners: number;
  attempts: number;
  next_try_at: Date | string | null;
  failure_message: string | null;
  charged_at: Date | string | null;
  paid_at: Date | string | null;
  failed_at: Date | string | null;
  created_at: Date | string;
};

const PAYOUT_COLUMNS = sql.raw(
  `p.id, p.month::text as month, p.livemode, p.status, p.owed_cents, p.account_fees_cents, p.payout_fees_cents,
   p.card_fee_cents, p.charge_cents, p.card_brand, p.card_last4,
   (select count(*)::int from app.partner_payout_lines l where l.payout_id = p.id) as partners,
   p.attempts, p.next_try_at, p.failure_message, p.charged_at, p.paid_at, p.failed_at, p.created_at`,
);

function payoutOut(r: PayoutRow): PartnerPayoutOut {
  return {
    payoutId: r.id,
    month: r.month,
    livemode: r.livemode,
    status: r.status,
    totals: {
      owedCents: Number(r.owed_cents),
      accountFeesCents: Number(r.account_fees_cents),
      payoutFeesCents: Number(r.payout_fees_cents),
      cardFeeCents: Number(r.card_fee_cents),
      chargeCents: Number(r.charge_cents),
    },
    card: r.card_last4 ? { brand: r.card_brand ?? 'Card', last4: r.card_last4 } : null,
    partners: r.partners,
    attempts: r.attempts,
    nextTryAt: r.status === 'charging' ? isoOrNull(r.next_try_at) : null,
    failureMessage: r.failure_message,
    chargedAt: isoOrNull(r.charged_at),
    paidAt: isoOrNull(r.paid_at),
    failedAt: isoOrNull(r.failed_at),
    createdAt: iso(r.created_at),
  };
}

type LineRow = {
  id: string;
  partner_id: string | null;
  name: string | null;
  amount_cents: string | number;
  account_fee_cents: string | number;
  payout_fee_cents: string | number;
  status: PayoutLineStatus;
  held_reason: string | null;
  paid_at: Date | string | null;
};

const lineOut = (l: LineRow): PartnerPayoutLineOut => ({
  lineId: l.id,
  partnerId: l.partner_id,
  name: l.name ?? PAYOUT_WORDS.line.deleted,
  amountCents: Number(l.amount_cents),
  accountFeeCents: Number(l.account_fee_cents),
  payoutFeeCents: Number(l.payout_fee_cents),
  status: l.status,
  heldReason: l.held_reason,
  paidAt: isoOrNull(l.paid_at),
});

/** A partner's bank at Stripe, as the screens show it. */
export const payoutAccountOut = (a: {
  details_submitted: boolean;
  payouts_enabled: boolean;
  transfers_active: boolean;
  disabled_reason: string | null;
  due_count: number;
}) => ({
  ready: a.payouts_enabled && a.transfers_active,
  detailsSubmitted: a.details_submitted,
  needsMore: a.due_count > 0 || (!!a.disabled_reason && !(a.payouts_enabled && a.transfers_active)),
});

/** A partner's bank and their part of each payout, for their page under Settings → Partners. */
export async function payoutsOfPartner(
  ctx: QueryContext,
  partnerId: string,
): Promise<z.output<typeof PartnerGetOutput>['payouts']> {
  const ws = ctx.scope.workspaceId!;
  const [account] = await rows<{
    details_submitted: boolean;
    payouts_enabled: boolean;
    transfers_active: boolean;
    disabled_reason: string | null;
    due_count: number;
  }>(
    ctx.tx,
    sql`select details_submitted, payouts_enabled, transfers_active, disabled_reason,
          cardinality(due) as due_count
        from app.partner_payout_accounts where workspace_id = ${ws} and partner_id = ${partnerId}`,
  );
  const lines = await rows<LineRow & { payout_id: string; month: string; livemode: boolean }>(
    ctx.tx,
    sql`select l.id, l.partner_id, null::text as name, l.amount_cents, l.account_fee_cents, l.payout_fee_cents,
          l.status, l.held_reason, l.paid_at, l.payout_id, p.month::text as month, p.livemode
        from app.partner_payout_lines l join app.partner_payouts p on p.id = l.payout_id
        where l.workspace_id = ${ws} and l.partner_id = ${partnerId}
        order by p.month desc, l.created_at desc
        limit 60`,
  );
  return {
    account: account ? payoutAccountOut(account) : null,
    lines: lines.map((l) => ({
      ...lineOut(l),
      name: '',
      payoutId: l.payout_id,
      month: l.month,
      livemode: l.livemode,
    })),
  };
}

/** The next payout as it stands now: what each partner is owed of live payments, and whether their bank is set up. */
async function nextPayoutOf(ctx: QueryContext, billing: BillingRow | null) {
  const ws = ctx.scope.workspaceId!;
  const settings = await loadPartnerSettings(ctx, ws);
  const owed = await rows<{
    partner_id: string;
    name: string;
    owed: string | number;
    ready: boolean;
  }>(
    ctx.tx,
    sql`select c.partner_id, ${PERSON_NAME} as name, sum(c.amount_cents) as owed,
          coalesce(bool_or(a.payouts_enabled and a.transfers_active and a.livemode), false) as ready
        from app.partner_commissions c
        join app.partners pa on pa.id = c.partner_id
        join app.people pp on pp.id = pa.person_id
        left join app.partner_payout_accounts a on a.partner_id = c.partner_id
        where c.workspace_id = ${ws} and c.payable_at <= now() and not c.test
          and ${COMMISSION_NOT_IN_PAYOUT} and not ${COMMISSION_DISPUTED}
        group by c.partner_id, pp.first_name, pp.last_name, pp.email
        order by sum(c.amount_cents) desc, c.partner_id`,
  );
  const names = new Map(owed.map((o) => [o.partner_id, o.name]));
  const plan = planPayout({
    partners: owed.map((o) => ({
      partnerId: o.partner_id,
      owedCents: Number(o.owed),
      bankReady: o.ready,
    })),
    smallestPayoutCents: settings.smallestPayoutCents,
  });
  const totals = payoutTotals(plan.paid.map((p) => p.owedCents));
  const [ws_] = await rows<{ timezone: string | null }>(
    ctx.tx,
    sql`select timezone from app.workspaces where id = ${ws}`,
  );
  const when = nextPayoutMonth({
    now: new Date(),
    timeZone: ws_?.timezone,
    lastMonth: billing?.last_month ?? null,
  });
  return {
    month: when.month,
    soon: when.soon,
    lines: plan.paid.map((p) => ({
      partnerId: p.partnerId,
      name: names.get(p.partnerId) ?? '',
      amountCents: p.owedCents,
    })),
    waiting: plan.waiting.map((p) => ({
      partnerId: p.partnerId,
      name: names.get(p.partnerId) ?? '',
      owedCents: p.owedCents,
      why: p.why,
    })),
    totals: {
      owedCents: totals.owedCents,
      accountFeesCents: totals.accountFeesCents,
      payoutFeesCents: totals.payoutFeesCents,
      cardFeeCents: totals.cardFeeCents,
      chargeCents: totals.chargeCents,
    },
  };
}

export const partnerPayouts = defineQuery({
  name: 'partner.payouts',
  description:
    'How the business pays its partners: whether HandsFreeOS has opened payouts for it, the card they’re charged to, the next payout as it stands now (who it would pay, who waits and why, and what it would charge with Stripe’s fees), and its latest payouts.',
  input: PartnerPayoutsInput,
  output: PartnerPayoutsOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [billing] = await rows<BillingRow>(
      ctx.tx,
      sql`select opened_at, customer_ref, method_token, card_brand, card_last4, card_expiry_month,
            card_expiry_year, last_month::text as last_month
          from app.partner_payout_billing where workspace_id = ${ws}`,
    );
    const payouts = await rows<PayoutRow>(
      ctx.tx,
      sql`select ${PAYOUT_COLUMNS} from app.partner_payouts p
          where p.workspace_id = ${ws}
          order by p.month desc, p.created_at desc
          limit 24`,
    );
    return {
      open: !!billing?.opened_at,
      card: payoutCardOf(billing ?? null),
      next: await nextPayoutOf(ctx, billing ?? null),
      payouts: payouts.map(payoutOut),
    };
  },
});

export const partnerPayoutGet = defineQuery({
  name: 'partner.payout_get',
  description:
    'One month’s partner payout, as its statement: what each partner was owed and whether they’re paid, then Stripe’s fees, each on its own line, and what the card was charged.',
  input: PartnerPayoutGetInput,
  output: PartnerPayoutGetOutput,
  permission: 'partners.manage',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [payout] = await rows<PayoutRow>(
      ctx.tx,
      sql`select ${PAYOUT_COLUMNS} from app.partner_payouts p
          where p.workspace_id = ${ws} and p.id = ${input.payoutId}`,
    );
    if (!payout)
      throw HfosError.notFound('That payout isn’t there anymore. Refresh Settings → Partners.');
    const lines = await rows<LineRow>(
      ctx.tx,
      sql`select l.id, l.partner_id, case when pp.id is null then null else ${PERSON_NAME} end as name,
            l.amount_cents, l.account_fee_cents, l.payout_fee_cents, l.status, l.held_reason, l.paid_at
          from app.partner_payout_lines l
          left join app.partners pa on pa.id = l.partner_id
          left join app.people pp on pp.id = pa.person_id
          where l.workspace_id = ${ws} and l.payout_id = ${payout.id}
          order by l.amount_cents desc, l.created_at, l.id`,
    );
    return { payout: payoutOut(payout), lines: lines.map(lineOut) };
  },
});

/** Staff: whether a business's partner payouts are open, and how they've gone, for its page on /admin. */
export const platformPartnerPayoutsGet = defineQuery({
  name: 'platform.partner_payouts.get',
  description:
    'One business’s partner payouts, for the support desk: whether they’re open, whether there’s a card, how many payouts it has had and how the latest went.',
  input: PlatformPartnerPayoutsGetInput,
  output: PlatformPartnerPayoutsGetOutput,
  permission: 'platform.businesses.read',
  scope: () => ({ kind: 'platform' as const }),
  async handler(ctx, input) {
    const [row] = await rows<{
      open: boolean;
      has_card: boolean;
      payouts: number;
      latest_status: PayoutStatus | null;
    }>(ctx.tx, sql`select * from private.staff_partner_payouts(${input.workspaceId}::uuid)`);
    if (!row)
      throw HfosError.notFound(
        'That business isn’t there anymore. It may have been deleted. Refresh Businesses and pick it again.',
      );
    return {
      workspaceId: input.workspaceId,
      open: row.open,
      hasCard: row.has_card,
      payouts: row.payouts,
      latestStatus: row.latest_status,
    };
  },
});
