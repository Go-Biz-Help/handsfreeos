/**
 * Maintenance plans a customer is on.
 *
 * The cycles run at the provider — Stripe Billing and Square Subscriptions — because that is where the retries,
 * the card-updater services and the SCA re-authentication live, and those decide whether a plan keeps earning.
 * What is here is our mirror of one: the plan **as it was sold**, so repricing the catalogue never reprices a
 * customer, plus where it is in its cycle.
 *
 * So a person starts, pauses, resumes and cancels, and each of those is recorded and handed to the worker to
 * carry out at the provider; `subscription.record_cycle` is the worker coming back — the plan is live, a cycle
 * billed, a card failed, it ended, or the account it billed through is gone and it is `unmanaged`: still billing
 * at the provider, no longer driven by us, and the plan page says so.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { plans, subscriptions } from '@hfos/db/schema';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { money } from '../money/index';
import {
  SubscriptionCancelInput,
  SubscriptionRecordCycleInput,
  SubscriptionRefInput,
  SubscriptionStartInput,
  SubscriptionStateOutput,
} from '../schemas/money';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type SubscriptionLite = {
  id: string;
  status: string;
  plan_name: string;
  price_cents: number;
  person_id: string;
  lead_id: string | null;
  connection_id: string | null;
  external_subscription_id: string | null;
  next_billing_on: string | null;
};

async function requireSubscription(
  ctx: CommandContext,
  subscriptionId: string,
): Promise<SubscriptionLite> {
  const [row] = await rows<SubscriptionLite>(
    ctx.tx,
    sql`select s.id, s.status::text as status, s.plan_name, s.price_cents::float8 as price_cents,
          s.person_id, s.lead_id, s.connection_id, s.external_subscription_id,
          s.next_billing_on::text as next_billing_on
        from app.subscriptions s
        where s.workspace_id = ${ctx.scope.workspaceId!} and s.id = ${subscriptionId}::uuid
        for no key update of s`,
  );
  if (!row) throw HfosError.notFound('That plan isn’t there.');
  return row;
}

const stateOut = (row: SubscriptionLite, changed: boolean) => ({
  subscriptionId: row.id,
  status: row.status as never,
  nextBillingOn: row.next_billing_on,
  changed,
});

const subjectOf = (row: SubscriptionLite) => ({
  subscriptionId: row.id,
  personId: row.person_id,
  leadId: row.lead_id,
  planName: row.plan_name,
  priceCents: Number(row.price_cents),
  connectionId: row.connection_id,
});

/** A plan whose account was disconnected is nobody's to drive: it is left alone until it is reconnected. */
function assertManaged(row: SubscriptionLite, what: string): void {
  if (row.status === 'unmanaged')
    throw HfosError.rule(
      'subscription_unmanaged',
      409,
      `This plan is still billing at the provider, but the account it bills through is disconnected. Reconnect it to ${what} here, or ${what} it at the provider.`,
    );
}

export const subscriptionStart = defineCommand({
  name: 'subscription.start',
  description:
    'Put a customer on a maintenance plan. The plan is copied as it is sold today, so repricing the catalogue never reprices them. It starts as a draft; the worker sets it up at the provider and the first cycle makes it live.',
  risk: 3,
  input: SubscriptionStartInput,
  output: SubscriptionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['subscription.started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    await requirePerson(ctx.tx, ws, input.personId);
    const [catalogue] = input.planId
      ? await ctx.tx.select().from(plans).where(eq(plans.id, input.planId))
      : [];
    if (input.planId && !catalogue)
      throw HfosError.validation([{ path: 'planId', message: 'Pick a plan in this workspace.' }]);
    const planName = input.planName ?? catalogue?.name;
    if (!planName)
      throw HfosError.validation([{ path: 'planName', message: 'Name the plan being sold.' }]);
    const [row] = await ctx.tx
      .insert(subscriptions)
      .values({
        workspaceId: ws,
        publicRef: sql`private.new_public_ref()`,
        planId: catalogue?.id ?? null,
        planName,
        priceCents: input.priceCents ?? Number(catalogue?.priceCents ?? 0),
        interval: input.interval ?? catalogue?.interval ?? 'month',
        intervalCount: input.intervalCount ?? catalogue?.intervalCount ?? 1,
        taxable: input.taxable ?? catalogue?.taxable ?? true,
        includes: input.includes ?? catalogue?.includes ?? [],
        personId: input.personId,
        leadId: input.leadId ?? null,
        connectionId: input.connectionId ?? null,
        startedOn: input.startedOn ?? null,
        createdBy: me,
      })
      .returning({ id: subscriptions.id });
    if (!row) throw HfosError.forbidden();
    const fresh = await requireSubscription(ctx, row.id);
    await ctx.emit({
      type: 'subscription.started',
      entityType: 'subscription',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), startedOn: input.startedOn ?? null },
      after: { plan: planName, price: money(Number(fresh.price_cents)), status: 'draft' },
    });
    return stateOut(fresh, true);
  },
});

export const subscriptionPause = defineCommand({
  name: 'subscription.pause',
  description:
    'Pause a plan: nothing is billed until it is resumed. The worker pauses it at the provider too.',
  risk: 2,
  input: SubscriptionRefInput,
  output: SubscriptionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['subscription.paused'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireSubscription(ctx, input.subscriptionId);
    if (before.status === 'paused') return stateOut(before, false);
    assertManaged(before, 'pause');
    if (before.status !== 'active' && before.status !== 'past_due')
      throw HfosError.rule(
        'subscription_not_active',
        409,
        'Only a plan that is billing can be paused.',
      );
    await ctx.tx
      .update(subscriptions)
      .set({ status: 'paused', pausedAt: new Date() })
      .where(eq(subscriptions.id, before.id));
    const fresh = await requireSubscription(ctx, before.id);
    await ctx.emit({
      type: 'subscription.paused',
      entityType: 'subscription',
      entityId: fresh.id,
      payload: subjectOf(fresh),
      before: { status: before.status },
      after: { plan: fresh.plan_name, status: 'paused' },
    });
    return stateOut(fresh, true);
  },
});

export const subscriptionResume = defineCommand({
  name: 'subscription.resume',
  description: 'Start a paused plan billing again, from the next cycle.',
  risk: 2,
  input: SubscriptionRefInput,
  output: SubscriptionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['subscription.resumed'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireSubscription(ctx, input.subscriptionId);
    if (before.status === 'active') return stateOut(before, false);
    assertManaged(before, 'resume');
    if (before.status !== 'paused')
      throw HfosError.rule('subscription_not_paused', 409, 'Only a paused plan can be resumed.');
    await ctx.tx
      .update(subscriptions)
      .set({ status: 'active', pausedAt: null })
      .where(eq(subscriptions.id, before.id));
    const fresh = await requireSubscription(ctx, before.id);
    await ctx.emit({
      type: 'subscription.resumed',
      entityType: 'subscription',
      entityId: fresh.id,
      payload: subjectOf(fresh),
      before: { status: 'paused' },
      after: { plan: fresh.plan_name, status: 'active' },
    });
    return stateOut(fresh, true);
  },
});

export const subscriptionCancel = defineCommand({
  name: 'subscription.cancel',
  description:
    'End a plan. The worker cancels it at the provider, so nothing is billed again; what has already been billed stays on the ledger.',
  risk: 3,
  input: SubscriptionCancelInput,
  output: SubscriptionStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['subscription.cancelled'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireSubscription(ctx, input.subscriptionId);
    if (before.status === 'cancelled') return stateOut(before, false);
    await ctx.tx
      .update(subscriptions)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: input.reason ?? null,
        pausedAt: null,
        nextBillingOn: null,
      })
      .where(eq(subscriptions.id, before.id));
    const fresh = await requireSubscription(ctx, before.id);
    await ctx.emit({
      type: 'subscription.cancelled',
      entityType: 'subscription',
      entityId: fresh.id,
      payload: {
        ...subjectOf(fresh),
        reason: input.reason ?? null,
        // A plan whose account went is cancelled here only: there is nothing left to tell the provider.
        wasUnmanaged: before.status === 'unmanaged',
      },
      before: { status: before.status },
      after: { plan: fresh.plan_name, status: 'cancelled', reason: input.reason ?? null },
    });
    return stateOut(fresh, true);
  },
});

export const subscriptionRecordCycle = defineCommand({
  name: 'subscription.record_cycle',
  description:
    'Worker: what the provider did with a plan — it is live, a cycle billed (with the invoice it raised), a card failed, it ended, or the account it bills through is gone and it is now unmanaged.',
  risk: 1,
  input: SubscriptionRecordCycleInput,
  output: SubscriptionStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: [
    'subscription.activated',
    'subscription.billed',
    'subscription.payment_failed',
    'subscription.ended',
    'subscription.unmanaged',
  ],
  actors: ['system'],
  async handler(ctx, input) {
    const before = await requireSubscription(ctx, input.subscriptionId);
    if (input.outcome !== 'ended' && input.outcome !== 'unmanaged' && before.status === 'cancelled')
      throw HfosError.rule('subscription_cancelled', 409, 'That plan was cancelled.');
    const status =
      input.outcome === 'failed'
        ? 'past_due'
        : input.outcome === 'ended'
          ? 'cancelled'
          : input.outcome === 'unmanaged'
            ? 'unmanaged'
            : 'active';
    const type =
      input.outcome === 'activated'
        ? 'subscription.activated'
        : input.outcome === 'billed'
          ? 'subscription.billed'
          : input.outcome === 'failed'
            ? 'subscription.payment_failed'
            : input.outcome === 'ended'
              ? 'subscription.ended'
              : 'subscription.unmanaged';
    // `failed_cycles` counts up from its own column, so the whole update goes through raw SQL.
    await rows(
      ctx.tx,
      sql`update app.subscriptions set
            status = ${status}::app.subscription_status,
            external_subscription_id = coalesce(${input.externalSubscriptionId}, external_subscription_id),
            current_period_start = coalesce(${input.currentPeriodStart}::date, current_period_start),
            current_period_end = coalesce(${input.currentPeriodEnd}::date, current_period_end),
            next_billing_on = ${
              input.outcome === 'ended'
                ? sql`null`
                : sql`coalesce(${input.nextBillingOn}::date, next_billing_on)`
            },
            ended_on = coalesce(${input.endedOn}::date, ended_on),
            paused_at = null,
            cancelled_at = ${
              input.outcome === 'ended' ? sql`coalesce(cancelled_at, now())` : sql`null`
            },
            cancel_reason = ${
              input.outcome === 'ended'
                ? sql`coalesce(cancel_reason, ${input.message ?? 'Ended at the provider'})`
                : sql`null`
            },
            failed_cycles = ${
              input.outcome === 'failed' ? sql`least(failed_cycles + 1, 1000)` : sql`0`
            },
            last_error = ${
              input.outcome === 'failed' || input.outcome === 'unmanaged'
                ? sql`${input.message}`
                : sql`null`
            }
          where workspace_id = ${ctx.scope.workspaceId!} and id = ${before.id}`,
    );
    const fresh = await requireSubscription(ctx, before.id);
    await ctx.emit({
      type,
      entityType: 'subscription',
      entityId: fresh.id,
      payload: {
        ...subjectOf(fresh),
        outcome: input.outcome,
        invoiceId: input.invoiceId,
        nextBillingOn: fresh.next_billing_on,
        message: input.message,
      },
      before: { status: before.status },
      after: {
        plan: fresh.plan_name,
        status: fresh.status,
        ...(input.outcome === 'billed' ? { billed: money(Number(fresh.price_cents)) } : {}),
        ...(input.message ? { note: input.message } : {}),
      },
    });
    return stateOut(fresh, before.status !== fresh.status);
  },
});

export const subscriptionCommands = [
  subscriptionStart,
  subscriptionPause,
  subscriptionResume,
  subscriptionCancel,
  subscriptionRecordCycle,
] as const;
