/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3; decisions 8 and 16 to 18).
 *
 * Once a month the worker works out what a business owes its partners (`partner.payout_build`): what's free to pay
 * out that no payout has taken, for each partner owed at least the smallest payout whose bank is set up at Stripe.
 * It charges the business's card for that and Stripe's fees on HandsFreeOS's own Stripe account, then pays each
 * partner by a transfer tied to the charge, writing down what came back (`partner.payout_record_charge`,
 * `partner.payout_record_transfer`). A declined card is tried again on the usage wallet's ladder (six hours, a day,
 * three days); when it gives up, what was owed waits for next month's payout. The worker also keeps the card a
 * business puts on (`partner.payout_record_card`) and each partner's Stripe account
 * (`partner.payout_record_account`). Those are `actors: ['system']`, so no browser reaches them.
 *
 * A person with money.manage may take the card off (`partner.payout_forget_card`). Staff open payouts for one
 * business at a time (`partner.set_payouts_open`): nothing is charged before. Postgres holds the same split
 * (`private.guard_partner_payout_billing`).
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext, QueryContext } from '../kernel/types';
import { afterDecline } from '../money/wallet-ladders';
import {
  planPayout,
  payoutTotals,
  TAX_FORM_FEE_CENTS,
  taxFormThresholdCents,
} from '../partners/payouts';
import { PAYOUT_WORDS } from '../partners/payout-words';
import {
  PartnerPayoutBuildInput,
  PartnerPayoutBuildOutput,
  PartnerPayoutCardOutput,
  PartnerPayoutForgetCardInput,
  PartnerPayoutGiveBackInput,
  PartnerPayoutGiveBackOutput,
  PartnerPayoutRecordAccountInput,
  PartnerPayoutRecordAccountOutput,
  PartnerPayoutRecordCardInput,
  PartnerPayoutRecordChargeInput,
  PartnerPayoutRecordChargeOutput,
  PartnerPayoutRecordTransferInput,
  PartnerPayoutRecordTransferOutput,
  PartnerSetPayoutsOpenInput,
  PartnerSetPayoutsOpenOutput,
  type PartnerPayoutCard,
  type PayoutLineStatus,
  type PayoutStatus,
} from '../schemas/partner-payouts';
import { loadPartnerSettings } from './partners';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const onPlatform = () => ({ kind: 'platform' as const });

const iso = (v: Date | string) => new Date(v).toISOString();

export type BillingRow = {
  opened_at: Date | string | null;
  customer_ref: string | null;
  method_token: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_expiry_month: number | null;
  card_expiry_year: number | null;
  last_month: string | null;
};

/** The business's partner payout billing, held until the command ends. Null when payouts were never opened. */
async function billingOf(ctx: CommandContext): Promise<BillingRow | null> {
  const [row] = await rows<BillingRow>(
    ctx.tx,
    sql`select opened_at, customer_ref, method_token, card_brand, card_last4, card_expiry_month,
          card_expiry_year, last_month::text as last_month
        from app.partner_payout_billing where workspace_id = ${ctx.scope.workspaceId}
        for update`,
  );
  return row ?? null;
}

export const payoutCardOf = (b: BillingRow | null): PartnerPayoutCard | null =>
  b?.method_token && b.card_last4
    ? {
        brand: b.card_brand ?? 'Card',
        last4: b.card_last4,
        expiryMonth: b.card_expiry_month,
        expiryYear: b.card_expiry_year,
      }
    : null;

/**
 * A commission (`c`) no payout has taken: one with no line, or whose line was cancelled when its charge failed.
 */
export const COMMISSION_NOT_IN_PAYOUT = sql.raw(
  `(c.payout_line_id is null or exists (select 1 from app.partner_payout_lines fl
     where fl.id = c.payout_line_id and fl.status = 'cancelled'))`,
);
/** A commission (`c`) whose payment has a dispute open: it waits until that's settled. */
export const COMMISSION_DISPUTED = sql.raw(
  `exists (select 1 from app.payment_disputes d where d.payment_id = c.payment_id and d.status = 'open')`,
);

/** A partner's 1099 for a year that ended, that no payout has charged Stripe's fee for yet. */
export interface TaxFormDue {
  readonly accountRef: string;
  readonly partnerId: string | null;
  readonly taxYear: number;
  readonly paidCents: number;
}

/**
 * The 1099s a payout in this month charges Stripe's fees for (stage 5): each partner account the business paid at
 * least the year's threshold in a calendar year before this month's, by when each transfer was paid, and that no
 * payout has charged for yet. Live money only: a payout made with a test key files nothing.
 */
export async function taxFormsDue(
  ctx: Pick<CommandContext | QueryContext, 'tx'>,
  workspaceId: string,
  month: string,
  livemode: boolean,
): Promise<TaxFormDue[]> {
  if (!livemode) return [];
  const yearStarts = `${month.slice(0, 4)}-01-01T00:00:00Z`;
  const paid = await rows<{
    account_ref: string;
    tax_year: number;
    paid_cents: string | number;
    partner_id: string | null;
  }>(
    ctx.tx,
    sql`select l.account_ref, extract(year from l.paid_at at time zone 'UTC')::int as tax_year,
          sum(l.amount_cents) as paid_cents,
          (array_agg(l.partner_id order by l.paid_at desc) filter (where l.partner_id is not null))[1]
            as partner_id
        from app.partner_payout_lines l join app.partner_payouts p on p.id = l.payout_id
        where l.workspace_id = ${workspaceId} and l.status = 'paid' and p.livemode
          and l.paid_at >= '2026-01-01T00:00:00Z'::timestamptz and l.paid_at < ${yearStarts}::timestamptz
          and not exists (select 1 from app.partner_tax_forms f
            where f.workspace_id = l.workspace_id and f.account_ref = l.account_ref
              and f.tax_year = extract(year from l.paid_at at time zone 'UTC')::int)
        group by l.account_ref, extract(year from l.paid_at at time zone 'UTC')
        order by tax_year, l.account_ref`,
  );
  return paid
    .map((r) => ({
      accountRef: r.account_ref,
      partnerId: r.partner_id,
      taxYear: Number(r.tax_year),
      paidCents: Number(r.paid_cents),
    }))
    .filter((f) => f.paidCents >= taxFormThresholdCents(f.taxYear));
}

// ---------- what a person does ----------

export const partnerPayoutForgetCard = defineCommand({
  name: 'partner.payout_forget_card',
  description:
    'Take the card off partner payouts. Nothing more is charged to it; what partners are owed waits until a card is back on.',
  risk: 3,
  input: PartnerPayoutForgetCardInput,
  output: PartnerPayoutCardOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['partner.payout_card_forgotten'],
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [b] = await rows<BillingRow & { provider: string | null }>(
      ctx.tx,
      sql`select opened_at, provider::text as provider, customer_ref, method_token, card_brand, card_last4,
            card_expiry_month, card_expiry_year, last_month::text as last_month
          from app.partner_payout_billing where workspace_id = ${ws} for update`,
    );
    if (!b?.method_token) return { card: null };
    // Cleared here, so it's never charged again, whether or not Stripe can be reached right now.
    await ctx.tx.execute(
      sql`update app.partner_payout_billing set method_token = null, card_brand = null, card_last4 = null,
            card_expiry_month = null, card_expiry_year = null
          where workspace_id = ${ws}`,
    );
    await ctx.emit({
      type: 'partner.payout_card_forgotten',
      entityType: 'partner_payout_billing',
      entityId: ws,
      payload: { provider: b.provider },
      before: { card: b.card_last4 },
      after: { card: null },
    });
    return { card: null };
  },
});

/**
 * Open partner payouts for one business, or close them (staff). Per business with no global form, as the usage
 * wallet's stages are: payouts open after Chris has checked the terms, and one business at a time. Closing them stops
 * what hasn't been charged yet; a payout already charged still pays its partners. The SQL behind it checks
 * `platform.partner_payouts.manage` for itself.
 */
export const partnerSetPayoutsOpen = defineCommand({
  name: 'partner.set_payouts_open',
  description:
    'Support: open partner payouts for one business, so HandsFreeOS charges its card each month and pays its partners, or close them.',
  risk: 4,
  input: PartnerSetPayoutsOpenInput,
  output: PartnerSetPayoutsOpenOutput,
  permission: 'platform.partner_payouts.manage',
  scope: onPlatform,
  emits: ['partner.payouts_open_changed'],
  async handler(ctx, input) {
    const [row] = await rows<{ was_open: boolean; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_partner_payouts_open(${input.workspaceId}::uuid, ${input.open})`,
    );
    if (!row)
      throw HfosError.notFound(
        'That business isn’t there anymore. It may have been deleted. Refresh Businesses and pick it again.',
      );
    if (row.changed)
      await ctx.emit({
        type: 'partner.payouts_open_changed',
        entityType: 'partner_payout_billing',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, open: input.open, reason: input.reason },
        before: { open: row.was_open },
        after: { open: input.open, why: input.reason },
      });
    return {
      workspaceId: input.workspaceId,
      wasOpen: row.was_open,
      open: input.open,
      changed: row.changed,
    };
  },
});

// ---------- what the worker writes ----------

export const partnerPayoutRecordCard = defineCommand({
  name: 'partner.payout_record_card',
  description:
    'Worker: a card was put on partner payouts. What Stripe handed back is written down: its customer, its token, and the brand, last four and expiry. Never a card number. A payout waiting to try the card again tries the new one at once.',
  risk: 1,
  input: PartnerPayoutRecordCardInput,
  output: PartnerPayoutCardOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.payout_card_saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const before = await billingOf(ctx);
    await ctx.tx.execute(
      sql`insert into app.partner_payout_billing (workspace_id, organization_id, provider, customer_ref, method_token,
            card_brand, card_last4, card_expiry_month, card_expiry_year, card_saved_at)
          select ${ws}, w.organization_id, ${input.provider}::app.payment_provider, ${input.customerRef},
            ${input.methodToken}, ${input.cardBrand}, ${input.cardLast4}, ${input.cardExpiryMonth}::smallint,
            ${input.cardExpiryYear}::smallint, now()
          from app.workspaces w where w.id = ${ws}
          on conflict (workspace_id) do update set provider = excluded.provider, customer_ref = excluded.customer_ref,
            method_token = excluded.method_token, card_brand = excluded.card_brand,
            card_last4 = excluded.card_last4, card_expiry_month = excluded.card_expiry_month,
            card_expiry_year = excluded.card_expiry_year, card_saved_at = excluded.card_saved_at`,
    );
    // A payout waiting on a declined card tries this one at once.
    await ctx.tx.execute(
      sql`update app.partner_payouts set next_try_at = now()
          where workspace_id = ${ws} and status = 'charging' and next_try_at > now()`,
    );
    const after = await billingOf(ctx);
    await ctx.emit({
      type: 'partner.payout_card_saved',
      entityType: 'partner_payout_billing',
      entityId: ws,
      payload: { provider: input.provider },
      before: { card: before?.card_last4 ?? null },
      after: { card: after?.card_last4 ?? null },
    });
    return { card: payoutCardOf(after) };
  },
});

export const partnerPayoutRecordAccount = defineCommand({
  name: 'partner.payout_record_account',
  description:
    'Worker: what Stripe says of a partner’s account, when it’s made and whenever it changes: whether they finished Stripe’s form, whether Stripe can send their money to their bank, and what Stripe still needs.',
  risk: 0,
  input: PartnerPayoutRecordAccountInput,
  output: PartnerPayoutRecordAccountOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.payout_account_updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [partner] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.partners where workspace_id = ${ws} and id = ${input.partnerId} for update`,
    );
    if (!partner)
      throw HfosError.notFound('That partner isn’t there anymore. Refresh your Partners list.');
    const [was] = await rows<{ ready: boolean }>(
      ctx.tx,
      sql`select payouts_enabled and transfers_active as ready from app.partner_payout_accounts
          where partner_id = ${input.partnerId}`,
    );
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into app.partner_payout_accounts (workspace_id, partner_id, account_ref, livemode,
            details_submitted, payouts_enabled, transfers_active, disabled_reason, due)
          values (${ws}, ${input.partnerId}, ${input.accountRef}, ${input.livemode}, ${input.detailsSubmitted},
            ${input.payoutsEnabled}, ${input.transfersActive}, ${input.disabledReason},
            array(select jsonb_array_elements_text(${JSON.stringify(input.due)}::jsonb)))
          on conflict (partner_id) do update set account_ref = excluded.account_ref,
            livemode = excluded.livemode, details_submitted = excluded.details_submitted,
            payouts_enabled = excluded.payouts_enabled, transfers_active = excluded.transfers_active,
            disabled_reason = excluded.disabled_reason, due = excluded.due
          returning id`,
    );
    const ready = input.payoutsEnabled && input.transfersActive;
    const becameReady = ready && !was?.ready;
    if (!was || was.ready !== ready)
      await ctx.emit({
        type: 'partner.payout_account_updated',
        entityType: 'partner',
        entityId: input.partnerId,
        payload: { partnerId: input.partnerId, ready, becameReady },
        before: { ready: was?.ready ?? null },
        after: { ready },
      });
    return { accountId: row!.id, ready, becameReady };
  },
});

export const partnerPayoutBuild = defineCommand({
  name: 'partner.payout_build',
  description:
    'Worker: work out this month’s partner payout. Each partner owed at least the smallest payout, whose bank is set up, gets a line: what’s free to pay out that no payout has taken, less what was taken back. Stripe’s fees go on their own lines, and the card is charged for it all. Once a month: a month already worked out is left as it was.',
  risk: 1,
  input: PartnerPayoutBuildInput,
  output: PartnerPayoutBuildOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.payout_built'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const none = (
      outcome: 'already' | 'not_open' | 'no_card' | 'nothing',
      payoutId: string | null = null,
    ) => ({
      payoutId,
      outcome,
      chargeCents: 0,
      partners: 0,
    });
    const billing = await billingOf(ctx);
    if (!billing?.opened_at) return none('not_open');
    if (!billing.method_token) return none('no_card');
    if (billing.last_month && billing.last_month >= input.month) {
      const [made] = await rows<{ id: string }>(
        ctx.tx,
        sql`select id from app.partner_payouts where workspace_id = ${ws} and month = ${input.month}::date`,
      );
      return none('already', made?.id ?? null);
    }
    // This month is worked out from here on, paid or not: once a month.
    await ctx.tx.execute(
      sql`update app.partner_payout_billing set last_month = ${input.month}::date where workspace_id = ${ws}`,
    );

    const settings = await loadPartnerSettings(ctx, ws);
    // What each partner is owed, commission by commission so the lines take exactly what was added up: free to pay
    // out, no payout's yet, not held by a dispute, and taken in the same mode as the worker's Stripe key.
    const owed = await rows<{
      id: string;
      partner_id: string;
      amount_cents: string | number;
      account_ref: string | null;
      ready: boolean;
    }>(
      ctx.tx,
      sql`select c.id, c.partner_id, c.amount_cents, a.account_ref,
            coalesce(a.payouts_enabled and a.transfers_active and a.livemode = ${input.livemode}, false) as ready
          from app.partner_commissions c
          left join app.partner_payout_accounts a on a.partner_id = c.partner_id
          where c.workspace_id = ${ws} and c.payable_at <= now() and c.test = ${!input.livemode}
            and ${COMMISSION_NOT_IN_PAYOUT} and not ${COMMISSION_DISPUTED}
          for update of c`,
    );
    const byPartner = new Map<
      string,
      { owedCents: number; accountRef: string | null; ready: boolean; ids: string[] }
    >();
    for (const c of owed) {
      const p = byPartner.get(c.partner_id) ?? {
        owedCents: 0,
        accountRef: c.account_ref,
        ready: c.ready,
        ids: [],
      };
      p.owedCents += Number(c.amount_cents);
      p.ids.push(c.id);
      byPartner.set(c.partner_id, p);
    }
    const plan = planPayout({
      partners: [...byPartner].map(([partnerId, p]) => ({
        partnerId,
        owedCents: p.owedCents,
        bankReady: p.ready && p.accountRef !== null,
      })),
      smallestPayoutCents: settings.smallestPayoutCents,
    });
    if (!plan.paid.length) return none('nothing');

    // Stripe's fees for the partners' 1099s of a year that ended ride on the first payout after it.
    const forms = await taxFormsDue(ctx, ws, input.month, input.livemode);
    const totals = payoutTotals(
      plan.paid.map((p) => p.owedCents),
      forms.length,
    );
    const [payout] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into app.partner_payouts (workspace_id, organization_id, month, livemode, owed_cents,
            account_fees_cents, payout_fees_cents, tax_forms_cents, card_fee_cents, charge_cents, card_brand,
            card_last4)
          values (${ws}, ${ctx.scope.organizationId}, ${input.month}::date, ${input.livemode}, ${totals.owedCents},
            ${totals.accountFeesCents}, ${totals.payoutFeesCents}, ${totals.taxFormsCents}, ${totals.cardFeeCents},
            ${totals.chargeCents}, ${billing.card_brand}, ${billing.card_last4})
          returning id`,
    );
    for (const f of forms)
      await ctx.tx.execute(
        sql`insert into app.partner_tax_forms (workspace_id, account_ref, partner_id, tax_year, paid_cents,
              fee_cents, payout_id)
            values (${ws}, ${f.accountRef}, ${f.partnerId}, ${f.taxYear}, ${f.paidCents}, ${TAX_FORM_FEE_CENTS},
              ${payout!.id})`,
      );
    for (const [i, p] of plan.paid.entries()) {
      const mine = byPartner.get(p.partnerId)!;
      const fees = totals.lines[i]!;
      const [line] = await rows<{ id: string }>(
        ctx.tx,
        sql`insert into app.partner_payout_lines (workspace_id, payout_id, partner_id, account_ref, amount_cents,
              account_fee_cents, payout_fee_cents)
            values (${ws}, ${payout!.id}, ${p.partnerId}, ${mine.accountRef}, ${fees.amountCents},
              ${fees.accountFeeCents}, ${fees.payoutFeeCents})
            returning id`,
      );
      await ctx.tx.execute(
        sql`update app.partner_commissions set payout_line_id = ${line!.id}
            where workspace_id = ${ws} and id = any(${`{${mine.ids.join(',')}}`}::uuid[])`,
      );
    }
    await ctx.emit({
      type: 'partner.payout_built',
      entityType: 'partner_payout',
      entityId: payout!.id,
      payload: {
        payoutId: payout!.id,
        month: input.month,
        chargeCents: totals.chargeCents,
        partners: plan.paid.length,
        taxForms: forms.length,
      },
      after: {
        charge: `${(totals.chargeCents / 100).toFixed(2)}`,
        partners: plan.paid.length,
        taxForms: forms.length,
      },
    });
    return {
      payoutId: payout!.id,
      outcome: 'built' as const,
      chargeCents: totals.chargeCents,
      partners: plan.paid.length,
    };
  },
});

type PayoutRow = {
  id: string;
  status: PayoutStatus;
  attempts: number;
  next_try_at: Date | string | null;
  charge_cents: string | number;
};

async function payoutOf(ctx: CommandContext, payoutId: string): Promise<PayoutRow> {
  const [row] = await rows<PayoutRow>(
    ctx.tx,
    sql`select id, status, attempts, next_try_at, charge_cents from app.partner_payouts
        where workspace_id = ${ctx.scope.workspaceId} and id = ${payoutId}
        for update`,
  );
  if (!row) throw HfosError.notFound('That payout isn’t there anymore.');
  return row;
}

export const partnerPayoutRecordCharge = defineCommand({
  name: 'partner.payout_record_charge',
  description:
    'Worker: what one try at charging the business’s card for a payout came to. Charged, its partners are paid next. Declined, it’s tried again on the usage wallet’s ladder (six hours, a day, three days); when the ladder gives up, or payouts were closed or the card taken off, what was owed waits for next month’s payout.',
  risk: 1,
  input: PartnerPayoutRecordChargeInput,
  output: PartnerPayoutRecordChargeOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.payout_charged', 'partner.payout_declined', 'partner.payout_failed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const p = await payoutOf(ctx, input.payoutId);
    const tryAt = p.next_try_at ? iso(p.next_try_at) : null;
    // A try recorded already, or a payout past its charge: told again, nothing changes.
    if (p.status !== 'charging' || input.attempt <= p.attempts)
      return {
        status: p.status,
        nextTryAt: p.status === 'charging' ? tryAt : null,
        recorded: false,
      };

    const card = input.cardLast4
      ? sql`, card_brand = ${input.cardBrand}, card_last4 = ${input.cardLast4}`
      : sql``;
    if (input.outcome === 'succeeded') {
      await ctx.tx.execute(
        sql`update app.partner_payouts set status = 'paying', attempts = ${input.attempt}, charged_at = now(),
              next_try_at = null, payment_ref = ${input.paymentRef}, charge_ref = ${input.chargeRef},
              failure_code = null, failure_message = null ${card}
            where id = ${p.id}`,
      );
      await ctx.emit({
        type: 'partner.payout_charged',
        entityType: 'partner_payout',
        entityId: p.id,
        payload: { payoutId: p.id, chargeCents: Number(p.charge_cents) },
        after: { status: 'paying' },
      });
      return { status: 'paying' as const, nextTryAt: null, recorded: true };
    }

    const message =
      input.outcome === 'stopped'
        ? input.stoppedBy === 'closed'
          ? PAYOUT_WORDS.stopped.closed
          : PAYOUT_WORDS.stopped.noCard
        : (input.failureMessage ?? PAYOUT_WORDS.declined);
    const next =
      input.outcome === 'declined'
        ? afterDecline({
            declinesInRow: p.attempts,
            failureCode: input.failureCode,
            failureMessage: input.failureMessage,
            now: Date.now(),
          })
        : null;
    if (next?.kind === 'retry') {
      const at = new Date(next.at).toISOString();
      await ctx.tx.execute(
        sql`update app.partner_payouts set attempts = ${input.attempt}, next_try_at = ${at}::timestamptz,
              payment_ref = coalesce(${input.paymentRef}, payment_ref), failure_code = ${input.failureCode},
              failure_message = ${message} ${card}
            where id = ${p.id}`,
      );
      await ctx.emit({
        type: 'partner.payout_declined',
        entityType: 'partner_payout',
        entityId: p.id,
        payload: {
          payoutId: p.id,
          attempt: input.attempt,
          nextTryAt: at,
          chargeCents: Number(p.charge_cents),
          failureMessage: message,
        },
        after: { status: 'charging', nextTry: at },
      });
      return { status: 'charging' as const, nextTryAt: at, recorded: true };
    }

    // Given up: the lines are cancelled, and what they held is free to pay out in next month's payout.
    const reason = next?.kind === 'suspend' ? next.reason : message;
    await ctx.tx.execute(
      sql`update app.partner_payouts set status = 'failed', attempts = greatest(attempts, ${input.attempt}),
            failed_at = now(), next_try_at = null, payment_ref = coalesce(${input.paymentRef}, payment_ref),
            failure_code = ${input.failureCode ?? input.stoppedBy}, failure_message = ${reason.slice(0, 500)} ${card}
          where id = ${p.id}`,
    );
    await ctx.tx.execute(
      sql`update app.partner_payout_lines set status = 'cancelled' where payout_id = ${p.id} and status = 'pending'`,
    );
    await ctx.tx.execute(
      sql`update app.partner_commissions c set payout_line_id = null
          from app.partner_payout_lines l
          where l.id = c.payout_line_id and l.payout_id = ${p.id} and c.workspace_id = ${ws}`,
    );
    // Nothing was charged for its 1099s either: the next payout charges for them.
    await ctx.tx.execute(sql`delete from app.partner_tax_forms where payout_id = ${p.id}`);
    await ctx.emit({
      type: 'partner.payout_failed',
      entityType: 'partner_payout',
      entityId: p.id,
      payload: {
        payoutId: p.id,
        chargeCents: Number(p.charge_cents),
        failureMessage: reason,
        stoppedBy: input.outcome === 'stopped' ? input.stoppedBy : null,
      },
      after: { status: 'failed' },
    });
    return { status: 'failed' as const, nextTryAt: null, recorded: true };
  },
});

export const partnerPayoutRecordTransfer = defineCommand({
  name: 'partner.payout_record_transfer',
  description:
    'Worker: what sending one partner their part of a charged payout came to. Paid, they’re told; held, Stripe wouldn’t take it for them yet, and it’s sent once their account can take it. A payout is paid once every partner on it is.',
  risk: 1,
  input: PartnerPayoutRecordTransferInput,
  output: PartnerPayoutRecordTransferOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.payout_line_paid', 'partner.payout_line_held', 'partner.payout_paid'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [line] = await rows<{
      id: string;
      payout_id: string;
      partner_id: string | null;
      amount_cents: string | number;
      status: PayoutLineStatus;
      payout_status: PayoutStatus;
    }>(
      ctx.tx,
      sql`select l.id, l.payout_id, l.partner_id, l.amount_cents, l.status, p.status as payout_status
          from app.partner_payout_lines l join app.partner_payouts p on p.id = l.payout_id
          where l.workspace_id = ${ws} and l.id = ${input.lineId}
          for update of l, p`,
    );
    if (!line) throw HfosError.notFound('That payout line isn’t there anymore.');
    // Only a charged payout's lines are sent, and a line is paid once.
    if (line.payout_status !== 'paying' || line.status === 'paid' || line.status === 'cancelled')
      return { status: line.status, payoutStatus: line.payout_status, recorded: false };

    if (input.outcome === 'held') {
      const reason = input.heldReason ?? PAYOUT_WORDS.heldReason;
      await ctx.tx.execute(
        sql`update app.partner_payout_lines set status = 'held', held_reason = ${reason} where id = ${line.id}`,
      );
      if (line.status !== 'held')
        await ctx.emit({
          type: 'partner.payout_line_held',
          entityType: 'partner_payout_line',
          entityId: line.id,
          payload: { lineId: line.id, payoutId: line.payout_id, partnerId: line.partner_id },
          after: { status: 'held' },
        });
      return { status: 'held' as const, payoutStatus: line.payout_status, recorded: true };
    }

    if (!input.transferRef)
      throw HfosError.validation([
        { path: 'transferRef', message: 'A paid line needs the transfer that paid it.' },
      ]);
    await ctx.tx.execute(
      sql`update app.partner_payout_lines set status = 'paid', transfer_ref = ${input.transferRef},
            paid_at = now(), held_reason = null, account_ref = coalesce(${input.accountRef}, account_ref)
          where id = ${line.id}`,
    );
    await ctx.emit({
      type: 'partner.payout_line_paid',
      entityType: 'partner_payout_line',
      entityId: line.id,
      payload: {
        lineId: line.id,
        payoutId: line.payout_id,
        partnerId: line.partner_id,
        amountCents: Number(line.amount_cents),
      },
      after: { status: 'paid' },
    });
    const paid = await paidWhenDone(ctx, line.payout_id);
    return {
      status: 'paid' as const,
      payoutStatus: paid ? ('paid' as const) : ('paying' as const),
      recorded: true,
    };
  },
});

/** Marks the payout paid once nothing on it waits: every partner paid, or their line given back. */
async function paidWhenDone(ctx: CommandContext, payoutId: string): Promise<boolean> {
  const [left] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from app.partner_payout_lines
        where payout_id = ${payoutId} and status in ('pending', 'held')`,
  );
  if (left?.n) return false;
  await ctx.tx.execute(
    sql`update app.partner_payouts set status = 'paid', paid_at = now() where id = ${payoutId}`,
  );
  await ctx.emit({
    type: 'partner.payout_paid',
    entityType: 'partner_payout',
    entityId: payoutId,
    payload: { payoutId },
    after: { status: 'paid' },
  });
  return true;
}

export const partnerPayoutGiveBack = defineCommand({
  name: 'partner.payout_give_back',
  description:
    'Worker: a line held for a partner deleted for good was given back to the business’s card, refunded from the month’s charge: the line and its two Stripe fees. The line is cancelled, and the payout is paid once nothing else on it waits.',
  risk: 1,
  input: PartnerPayoutGiveBackInput,
  output: PartnerPayoutGiveBackOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['partner.payout_line_given_back', 'partner.payout_paid'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [line] = await rows<{
      id: string;
      payout_id: string;
      partner_id: string | null;
      status: PayoutLineStatus;
      given_back_at: Date | string | null;
      payout_status: PayoutStatus;
    }>(
      ctx.tx,
      sql`select l.id, l.payout_id, l.partner_id, l.status, l.given_back_at, p.status as payout_status
          from app.partner_payout_lines l join app.partner_payouts p on p.id = l.payout_id
          where l.workspace_id = ${ws} and l.id = ${input.lineId}
          for update of l, p`,
    );
    if (!line) throw HfosError.notFound('That payout line isn’t there anymore.');
    // Given back already, or not one to give back: a partner still kept, or a line paid or cancelled.
    if (
      line.given_back_at ||
      line.partner_id !== null ||
      line.payout_status !== 'paying' ||
      (line.status !== 'held' && line.status !== 'pending')
    )
      return { given: false, payoutStatus: line.payout_status };
    await ctx.tx.execute(
      sql`update app.partner_payout_lines set status = 'cancelled', held_reason = null, given_back_at = now(),
            given_back_cents = ${input.amountCents}, refund_ref = ${input.refundRef}
          where id = ${line.id}`,
    );
    await ctx.emit({
      type: 'partner.payout_line_given_back',
      entityType: 'partner_payout_line',
      entityId: line.id,
      payload: { lineId: line.id, payoutId: line.payout_id, amountCents: input.amountCents },
      after: { status: 'cancelled', givenBack: `${(input.amountCents / 100).toFixed(2)}` },
    });
    const paid = await paidWhenDone(ctx, line.payout_id);
    return { given: true, payoutStatus: paid ? ('paid' as const) : line.payout_status };
  },
});

export const partnerPayoutCommands = [
  partnerPayoutForgetCard,
  partnerSetPayoutsOpen,
  partnerPayoutRecordCard,
  partnerPayoutRecordAccount,
  partnerPayoutBuild,
  partnerPayoutRecordCharge,
  partnerPayoutRecordTransfer,
  partnerPayoutGiveBack,
];
