/**
 * Billing for a founding plan (20261027023600, the owner's call of 2026-11-08): its cards, its payment day, paying a
 * failed payment now, and asking for more time.
 *
 * - **Cards.** One list pays the plan and refills the usage balance (the owner's 5a). Adding one is the worker's
 *   (`billing.record_card`, or `wallet.record_card` from the phone's Balance), after Stripe's own page: the card is
 *   typed there and never reaches us. Choosing the default and removing one are the business's, through functions that
 *   check `money.manage` themselves, because nobody in a business writes its plan. The default card is copied onto the
 *   plan, where the code before this read it, and onto the balance.
 * - **The payment day.** `private.plan_pay_day_quote` works out what moving it costs or gives back, once, for the
 *   screens and for the change itself. Earlier happens at once; later waits on its charge, which the worker makes
 *   (`billing.record_pay_day`).
 * - **Paying now** queues the same charge the daily retry makes, through every card in turn.
 * - **More time** opens a support ticket in the person's own name, and staff answer it (`billing.answer_more_time`).
 */
import { rows, sql } from '@hfos/db/client';
import { notePlanPayment } from '../affiliates/earn';
import { BILLING_WORDS } from '../billing/words';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  BillingAnswerMoreTimeInput,
  BillingAnswerMoreTimeOutput,
  BillingAskMoreTimeInput,
  BillingAskMoreTimeOutput,
  BillingCardRefInput,
  BillingCardWriteOutput,
  BillingChangePayDayInput,
  BillingChangePayDayOutput,
  BillingPayNowInput,
  BillingPayNowOutput,
  BillingRecordCardInput,
  BillingRecordCardOutput,
  BillingRecordPayDayInput,
  BillingRecordPayDayOutput,
} from '../schemas/billing';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const onPlatform = () => ({ kind: 'platform' as const });

/** The database's `detail` on a refusal, on the innermost cause, the walk the kernel's translateDbError makes. */
function detailOf(err: unknown): string {
  let pg: unknown = err;
  while (pg instanceof Error && pg.cause instanceof Error) pg = pg.cause;
  return (pg as { detail?: string })?.detail ?? '';
}

/** What a payment-day refusal says. Exported for `billing.pay_day_quote`, which says it before anybody presses. */
export function payDayRefusalMessage(rule: string): string {
  switch (rule) {
    case 'plan_pay_day_no_plan':
      return 'This business has no plan that renews by card, so it has no payment date to change.';
    case 'plan_pay_day_not_renewing':
      return 'Your plan is set not to renew, so there’s no next payment to move. Press Keep it renewing first.';
    case 'plan_pay_day_past_due':
      return 'Your last payment didn’t go through. Pay it first, then you can change your payment date.';
    case 'plan_pay_day_trial':
      return 'Your free trial is still running, and your first payment is the day it ends. You can change the date after that.';
    case 'plan_pay_day_busy':
      return 'Your card is being charged for the last date you picked. Wait a minute, then look again.';
    case 'plan_pay_day_same':
      return 'That’s already your payment date. Pick another day.';
    case 'plan_pay_day_too_soon':
      return 'That day is too soon. Pick a day from tomorrow on.';
    case 'plan_pay_day_too_late':
      return 'That’s more than a whole month or year away. Pick a day sooner.';
    default:
      return 'Your payment date can’t move to that day. Pick another.';
  }
}

const PAY_DAY_STATUS: Record<string, number> = { plan_pay_day_no_plan: 404 };

function asRefusal(err: unknown): never {
  const detail = detailOf(err);
  if (detail === 'plan_billing_not_yours')
    throw HfosError.forbidden(
      'Only someone who manages money in this business can change its billing. Ask an owner to give you that in Settings → Permissions, or to do it for you.',
      'plan_billing_not_yours',
    );
  if (detail === 'plan_card_missing')
    throw HfosError.rule(
      'plan_card_missing',
      404,
      'That card isn’t on this business anymore. Refresh Settings → Billing & Usage to see the cards it has.',
    );
  if (detail === 'plan_card_is_default')
    throw HfosError.rule(
      'plan_card_is_default',
      409,
      'That’s your default card, so it can’t be removed. Make another card the default first, then remove this one.',
    );
  if (detail === 'plan_card_last_one')
    throw HfosError.rule(
      'plan_card_last_one',
      409,
      'That’s the only card on this business, and your plan renews on it, so it stays. Add another card first, or stop your plan renewing.',
    );
  if (detail.startsWith('plan_pay_day_'))
    throw HfosError.rule(detail, PAY_DAY_STATUS[detail] ?? 409, payDayRefusalMessage(detail));
  if (detail === 'plan_more_time_nothing_owed')
    throw HfosError.rule(
      'plan_more_time_nothing_owed',
      409,
      'Your payments are up to date, so there’s nothing to ask more time for.',
    );
  if (detail === 'plan_more_time_bad_date')
    throw HfosError.rule(
      'plan_more_time_bad_date',
      400,
      'Pick a day from tomorrow to 30 days from now.',
    );
  if (detail === 'plan_more_time_waiting')
    throw HfosError.rule(
      'plan_more_time_waiting',
      409,
      'You’ve already asked for more time, and we haven’t answered yet. We’ll email you as soon as we do.',
    );
  throw err;
}

const cardName = (c: { card_brand: string | null; card_last4: string | null }) =>
  c.card_last4 ? `${c.card_brand ?? 'Card'} ending ${c.card_last4}` : 'The card you paid with';

/** Writes what each card said when it was charged: a decline is kept on the card, a payment clears it. */
export async function noteCardTries(
  ctx: CommandContext,
  workspaceId: string,
  tries: readonly { cardId: string; ok: boolean; problem: string | null }[],
): Promise<void> {
  for (const t of tries)
    await ctx.tx.execute(
      t.ok
        ? sql`update app.plan_cards set last_declined_at = null, last_decline = null
              where id = ${t.cardId}::uuid and workspace_id = ${workspaceId}::uuid`
        : sql`update app.plan_cards set last_declined_at = now(), last_decline = ${t.problem ?? 'Declined.'}
              where id = ${t.cardId}::uuid and workspace_id = ${workspaceId}::uuid`,
    );
}

/**
 * The card a paid founding page kept becomes the plan's default card (a first payment, or a renewal paid with another
 * card). Its brand and last four come later, from the worker asking Stripe.
 */
export async function keepCheckoutCard(
  ctx: CommandContext,
  workspaceId: string,
  customerRef: string | null,
  cardRef: string | null,
): Promise<void> {
  if (!customerRef || !cardRef) return;
  await ctx.tx.execute(
    sql`update app.plan_cards set is_default = false
        where workspace_id = ${workspaceId}::uuid and is_default and card_ref <> ${cardRef}`,
  );
  await ctx.tx.execute(
    sql`insert into app.plan_cards (workspace_id, organization_id, customer_ref, card_ref, is_default)
        select w.id, w.organization_id, ${customerRef}, ${cardRef}, true
        from app.workspaces w where w.id = ${workspaceId}::uuid
        on conflict (workspace_id, card_ref) do update set is_default = true, customer_ref = excluded.customer_ref`,
  );
  await ctx.tx.execute(sql`select private.plan_sync_default_card(${workspaceId}::uuid)`);
}

// ---------- the cards ----------

export const billingRecordCard = defineCommand({
  name: 'billing.record_card',
  description:
    'Worker: a card was put on the plan from Stripe’s page, or Stripe told us the brand and last four of one already on it. The first card is the default.',
  risk: 2,
  input: BillingRecordCardInput,
  output: BillingRecordCardOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['billing.card_added'],
  async handler(ctx, input) {
    const [ws] = await rows<{ organization_id: string; has_default: boolean }>(
      ctx.tx,
      sql`select w.organization_id,
            exists (select 1 from app.plan_cards c where c.workspace_id = w.id and c.is_default) as has_default
          from app.workspaces w where w.id = ${input.workspaceId}::uuid`,
    );
    if (!ws) throw HfosError.notFound('That business isn’t there anymore.');
    const makeDefault = input.makeDefault || !ws.has_default;
    if (makeDefault)
      await ctx.tx.execute(
        sql`update app.plan_cards set is_default = false
            where workspace_id = ${input.workspaceId}::uuid and is_default and card_ref <> ${input.cardRef}`,
      );
    const [card] = await rows<{ id: string; is_default: boolean; inserted: boolean }>(
      ctx.tx,
      sql`insert into app.plan_cards (workspace_id, organization_id, customer_ref, card_ref, card_brand, card_last4,
            card_expiry_month, card_expiry_year, is_default, added_by)
          values (${input.workspaceId}::uuid, ${ws.organization_id}::uuid, ${input.customerRef}, ${input.cardRef},
            ${input.brand}, ${input.last4}, ${input.expiryMonth}, ${input.expiryYear}, ${makeDefault},
            ${input.addedBy}::uuid)
          on conflict (workspace_id, card_ref) do update
            set customer_ref = excluded.customer_ref,
                card_brand = coalesce(excluded.card_brand, app.plan_cards.card_brand),
                card_last4 = coalesce(excluded.card_last4, app.plan_cards.card_last4),
                card_expiry_month = coalesce(excluded.card_expiry_month, app.plan_cards.card_expiry_month),
                card_expiry_year = coalesce(excluded.card_expiry_year, app.plan_cards.card_expiry_year),
                is_default = app.plan_cards.is_default or excluded.is_default
          returning id, is_default, (xmax = 0) as inserted`,
    );
    if (!card) throw HfosError.internal();
    if (card.is_default)
      await ctx.tx.execute(sql`select private.plan_sync_default_card(${input.workspaceId}::uuid)`);
    if (card.inserted)
      await ctx.emit({
        type: 'billing.card_added',
        entityType: 'plan_card',
        entityId: card.id,
        payload: { workspaceId: input.workspaceId, isDefault: card.is_default },
        after: {
          card: cardName({ card_brand: input.brand, card_last4: input.last4 }),
          default: card.is_default ? 'yes' : 'no',
        },
      });
    return {
      workspaceId: input.workspaceId,
      cardId: card.id,
      isDefault: card.is_default,
      outcome: card.inserted ? ('added' as const) : ('updated' as const),
    };
  },
});

export const billingSetDefaultCard = defineCommand({
  name: 'billing.set_default_card',
  description:
    'Make one of the business’s cards the default: the one its HandsFreeOS plan is charged to first and its usage balance refills from. The old default becomes a backup.',
  risk: 2,
  input: BillingCardRefInput,
  output: BillingCardWriteOutput,
  // Whoever manages what the business pays us, as on Settings → Billing & Usage.
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['billing.default_card_changed'],
  async handler(ctx, input) {
    const [done] = await rows<{ card_id: string; changed: boolean }>(
      ctx.tx,
      sql`select * from private.plan_card_set_default(${input.workspaceId}::uuid, ${input.cardId}::uuid)`,
    ).catch(asRefusal);
    if (!done) throw HfosError.internal();
    if (done.changed) {
      const [c] = await rows<{ card_brand: string | null; card_last4: string | null }>(
        ctx.tx,
        sql`select card_brand, card_last4 from app.plan_cards where id = ${input.cardId}::uuid`,
      );
      await ctx.emit({
        type: 'billing.default_card_changed',
        entityType: 'plan_card',
        entityId: input.cardId,
        payload: { workspaceId: input.workspaceId },
        after: { default: c ? cardName(c) : 'another card' },
      });
    }
    return { workspaceId: input.workspaceId, cardId: input.cardId, changed: done.changed };
  },
});

export const billingRemoveCard = defineCommand({
  name: 'billing.remove_card',
  description:
    'Take a card off the business, so it’s never charged again for the plan or the balance. The default can’t be removed while there are others (make another the default first), nor while a paid plan renews on it.',
  risk: 3,
  input: BillingCardRefInput,
  output: BillingCardWriteOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['billing.card_removed'],
  async handler(ctx, input) {
    const [gone] = await rows<{
      customer_ref: string;
      card_ref: string;
      card_brand: string | null;
      card_last4: string | null;
    }>(
      ctx.tx,
      sql`select * from private.plan_card_remove(${input.workspaceId}::uuid, ${input.cardId}::uuid)`,
    ).catch(asRefusal);
    if (!gone) throw HfosError.internal();
    // The worker tells Stripe to forget it too, unless another of the business's cards rows still uses it.
    await ctx.emit({
      type: 'billing.card_removed',
      entityType: 'plan_card',
      entityId: input.cardId,
      payload: {
        workspaceId: input.workspaceId,
        customerRef: gone.customer_ref,
        cardRef: gone.card_ref,
      },
      before: { card: cardName(gone) },
    });
    return { workspaceId: input.workspaceId, cardId: input.cardId, changed: true };
  },
});

// ---------- paying now ----------

export const billingPayNow = defineCommand({
  name: 'billing.pay_now',
  description:
    'Try the business’s cards again now for the HandsFreeOS payment that didn’t go through: the default first, then each backup. The worker charges them; ask billing.status for the answer.',
  risk: 3,
  input: BillingPayNowInput,
  output: BillingPayNowOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['billing.pay_now_requested'],
  async handler(ctx, input) {
    const [plan] = await rows<{
      grant_id: string | null;
      current_period_end: Date | string | null;
      renewal_failed_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select grant_id, current_period_end, renewal_failed_at
          from app.workspace_plans where workspace_id = ${input.workspaceId}::uuid`,
    );
    if (!plan?.grant_id || !plan.current_period_end || !plan.renewal_failed_at)
      return { workspaceId: input.workspaceId, outcome: 'nothing_owed' as const };
    await ctx.emit({
      type: 'billing.pay_now_requested',
      entityType: 'workspace_plan',
      entityId: input.workspaceId,
      payload: {
        grantId: plan.grant_id,
        forPaidThrough: new Date(plan.current_period_end).toISOString(),
      },
    });
    return { workspaceId: input.workspaceId, outcome: 'trying' as const };
  },
});

// ---------- the payment day ----------

export const billingChangePayDay = defineCommand({
  name: 'billing.change_pay_day',
  description:
    'Move the day the business’s HandsFreeOS plan is paid. A later day costs the days it adds, charged now to its cards; an earlier day takes the days given up off the next payment. Ask billing.pay_day_quote first to see what it costs.',
  risk: 3,
  input: BillingChangePayDayInput,
  output: BillingChangePayDayOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['billing.pay_day_moved', 'billing.pay_day_change_requested'],
  async handler(ctx, input) {
    const [done] = await rows<{
      outcome: 'moved' | 'charging';
      kind: 'later' | 'earlier';
      cents: number;
      paid_through: Date | string;
      new_paid_through: Date | string;
    }>(
      ctx.tx,
      sql`select * from private.plan_change_pay_day(${input.workspaceId}::uuid, ${input.day}::date)`,
    ).catch(asRefusal);
    if (!done) throw HfosError.internal();
    const from = new Date(done.paid_through);
    const to = new Date(done.new_paid_through);
    if (done.outcome === 'moved')
      await ctx.emit({
        type: 'billing.pay_day_moved',
        entityType: 'workspace_plan',
        entityId: input.workspaceId,
        payload: { from: from.toISOString(), to: to.toISOString(), creditCents: done.cents },
        before: { pays: from.toISOString().slice(0, 10) },
        after: { pays: to.toISOString().slice(0, 10), off_next: (done.cents / 100).toFixed(2) },
      });
    else
      await ctx.emit({
        type: 'billing.pay_day_change_requested',
        entityType: 'workspace_plan',
        entityId: input.workspaceId,
        payload: { from: from.toISOString(), to: to.toISOString(), cents: done.cents },
      });
    return {
      workspaceId: input.workspaceId,
      outcome: done.outcome,
      kind: done.kind,
      cents: Number(done.cents),
      newPaidThrough: to.toISOString(),
    };
  },
});

export const billingRecordPayDay = defineCommand({
  name: 'billing.record_pay_day',
  description:
    'Worker: what charging a later payment day did. Paid moves the date; refused leaves it, and says why on Settings → Billing & Usage.',
  risk: 3,
  input: BillingRecordPayDayInput,
  output: BillingRecordPayDayOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['billing.pay_day_moved', 'billing.pay_day_change_failed'],
  async handler(ctx, input) {
    const workspaceId = input.workspaceId;
    const [plan] = await rows<{
      current_period_end: Date | string | null;
      pay_day_change_to: Date | string | null;
      grant_id: string | null;
      offer_id: string | null;
      organization_id: string;
    }>(
      ctx.tx,
      sql`select p.current_period_end, p.pay_day_change_to, p.grant_id, p.organization_id,
            (select g.offer_id from platform.founding_grants g where g.id = p.grant_id) as offer_id
          from app.workspace_plans p where p.workspace_id = ${workspaceId}::uuid for update of p`,
    );
    if (
      !plan?.pay_day_change_to ||
      new Date(plan.pay_day_change_to).toISOString() !== new Date(input.to).toISOString()
    )
      return { workspaceId, outcome: 'already' as const };
    await noteCardTries(ctx, workspaceId, input.cards);
    const from = plan.current_period_end ? new Date(plan.current_period_end) : null;
    if (input.outcome === 'paid') {
      await ctx.tx.execute(
        sql`update app.workspace_plans
               set current_period_end = pay_day_change_to, pay_day_change_to = null, pay_day_change_cents = null,
                   pay_day_change_asked_at = null, pay_day_change_asked_by = null, pay_day_change_problem = null
             where workspace_id = ${workspaceId}::uuid`,
      );
      await ctx.emit({
        type: 'billing.pay_day_moved',
        entityType: 'workspace_plan',
        entityId: workspaceId,
        payload: {
          from: from?.toISOString() ?? null,
          to: new Date(input.to).toISOString(),
          paidCents: input.paidCents,
          paymentRef: input.paymentRef,
        },
        before: { pays: from ? from.toISOString().slice(0, 10) : '' },
        after: {
          pays: new Date(input.to).toISOString().slice(0, 10),
          paid: ((input.paidCents ?? 0) / 100).toFixed(2),
        },
      });
      // Plan money like any other: kept for refunds and its affiliate's share. It pays for the days from the old date.
      if (input.paymentRef && (input.paidCents ?? 0) > 0 && from) {
        await notePlanPayment(ctx, {
          organizationId: plan.organization_id,
          workspaceId,
          offerId: plan.offer_id,
          how: 'renewal',
          checkoutId: null,
          paymentRef: input.paymentRef,
          amountCents: input.paidCents ?? 0,
          periodFrom: from,
          paidAt: new Date(),
        });
      }
      return { workspaceId, outcome: 'moved' as const };
    }
    const problem = input.problem ?? 'The card was declined.';
    await ctx.tx.execute(
      sql`update app.workspace_plans
             set pay_day_change_to = null, pay_day_change_cents = null, pay_day_change_asked_at = null,
                 pay_day_change_asked_by = null, pay_day_change_problem = ${problem}
           where workspace_id = ${workspaceId}::uuid`,
    );
    await ctx.emit({
      type: 'billing.pay_day_change_failed',
      entityType: 'workspace_plan',
      entityId: workspaceId,
      payload: { to: new Date(input.to).toISOString(), problem },
      after: { reason: problem.slice(0, 200) },
    });
    return { workspaceId, outcome: 'refused' as const };
  },
});

// ---------- more time ----------

export const billingAskMoreTime = defineCommand({
  name: 'billing.ask_more_time',
  description:
    'Ask HandsFreeOS for more time to pay a plan payment that didn’t go through, with the day the business thinks it can pay by (up to 30 days out). Opens a support ticket; staff answer it case by case.',
  risk: 2,
  input: BillingAskMoreTimeInput,
  output: BillingAskMoreTimeOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['support_ticket.opened', 'billing.more_time_asked'],
  async handler(ctx, input) {
    const [facts] = await rows<{
      business: string;
      charge_cents: number | null;
      problem: string | null;
    }>(
      ctx.tx,
      sql`select w.name as business,
            (select greatest(p.price_cents
                     - case when p.discount_cents > 0
                             and (p.discount_until is null or p.current_period_end < p.discount_until)
                            then p.discount_cents else 0 end - p.pay_day_credit_cents, 0)
               from app.workspace_plans p where p.workspace_id = w.id) as charge_cents,
            (select p.renewal_problem from app.workspace_plans p where p.workspace_id = w.id) as problem
          from app.workspaces w where w.id = ${input.workspaceId}::uuid`,
    );
    if (!facts) throw HfosError.notFound('That business isn’t there anymore.');
    const subject = BILLING_WORDS.ticketSubject(facts.business);
    const body = BILLING_WORDS.ticketBody({
      business: facts.business,
      payBy: input.payBy,
      amountCents: Number(facts.charge_cents ?? 0),
      problem: facts.problem,
      note: input.note,
    });
    const [made] = await rows<{ request_id: string; ticket_id: string; ticket_number: string }>(
      ctx.tx,
      sql`select * from private.plan_ask_more_time(${input.workspaceId}::uuid, ${input.payBy}::date,
            ${input.note}, ${subject}, ${body})`,
    ).catch(asRefusal);
    if (!made) throw HfosError.internal();
    await ctx.emit({
      type: 'support_ticket.opened',
      entityType: 'support_ticket',
      entityId: made.ticket_id,
      payload: { number: Number(made.ticket_number), channel: 'in_app' },
    });
    await ctx.emit({
      type: 'billing.more_time_asked',
      entityType: 'plan_time_request',
      entityId: made.request_id,
      payload: { workspaceId: input.workspaceId, payBy: input.payBy, ticketId: made.ticket_id },
      after: { pay_by: input.payBy },
    });
    return {
      workspaceId: input.workspaceId,
      requestId: made.request_id,
      ticketNumber: Number(made.ticket_number),
    };
  },
});

export const billingAnswerMoreTime = defineCommand({
  name: 'billing.answer_more_time',
  description:
    'Staff: give a business the more time it asked for to pay its HandsFreeOS plan (its own day, or another), or say no. Granted, the failed-payment page goes away and its cards are tried again on that day. Staff only.',
  risk: 3,
  input: BillingAnswerMoreTimeInput,
  output: BillingAnswerMoreTimeOutput,
  permission: 'platform.founding.manage',
  scope: onPlatform,
  emits: ['billing.more_time_answered'],
  async handler(ctx, input) {
    const [req] = await rows<{
      id: string;
      workspace_id: string;
      organization_id: string;
      status: string;
      pay_by: string;
    }>(
      ctx.tx,
      sql`select id, workspace_id, organization_id, status::text as status, pay_by::text as pay_by
          from app.plan_time_requests where id = ${input.requestId}::uuid for update`,
    );
    if (!req)
      throw HfosError.notFound('That request isn’t there anymore. Refresh the business’s page.');
    if (req.status !== 'pending')
      throw HfosError.rule(
        'plan_more_time_answered',
        409,
        `That request was already ${req.status === 'granted' ? 'granted' : 'turned down'}. Refresh the business’s page.`,
      );
    const until = input.grant ? (input.until ?? req.pay_by) : null;
    if (until) {
      const today = new Date().toISOString().slice(0, 10);
      if (until <= today)
        throw HfosError.rule(
          'plan_more_time_bad_date',
          400,
          'Pick a day from tomorrow on to give them until.',
        );
    }
    const staffId = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    await ctx.tx.execute(
      sql`update app.plan_time_requests
             set status = ${input.grant ? 'granted' : 'declined'}::app.plan_time_request_status,
                 granted_until = ${until}::date, answered_by = ${staffId}::uuid, answered_at = now()
           where id = ${req.id}::uuid`,
    );
    if (until)
      // No page and no retries until that day; then its cards are tried that day, and daily after, as if it had
      // just failed (retries count from the day before, so day 1 is that day).
      await ctx.tx.execute(
        sql`update app.workspace_plans
               set more_time_until = ${until}::date::timestamptz,
                   retry_from = ${until}::date::timestamptz - interval '1 day',
                   retry_count = 0,
                   next_retry_at = ${until}::date::timestamptz + (random() * interval '12 hours')
             where workspace_id = ${req.workspace_id}::uuid and renewal_failed_at is not null`,
      );
    await ctx.emit({
      type: 'billing.more_time_answered',
      entityType: 'plan_time_request',
      entityId: req.id,
      // Staff act on HandsFreeOS, not inside the business, so the event is HandsFreeOS's; the worker reads the
      // business from the payload to email its owners (as founding.revoked does).
      payload: {
        workspaceId: req.workspace_id,
        organizationId: req.organization_id,
        granted: input.grant,
        until,
      },
      after: { answer: input.grant ? `granted until ${until}` : 'declined' },
    });
    return {
      requestId: req.id,
      workspaceId: req.workspace_id,
      status: input.grant ? ('granted' as const) : ('declined' as const),
      grantedUntil: until,
    };
  },
});

export const billingCommands = [
  billingRecordCard,
  billingSetDefaultCard,
  billingRemoveCard,
  billingPayNow,
  billingChangePayDay,
  billingRecordPayDay,
  billingAskMoreTime,
  billingAnswerMoreTime,
];
