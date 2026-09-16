/**
 * What the worker does with a payment provider's event, once the HTTP route has checked its signature, stored
 * it under our own name for it and routed it to the business it belongs to (http/money.ts).
 *
 * Everything here is written to be **repeatable and out of order**. A provider retries for days, replays
 * happen, and Stripe and Square both deliver "succeeded" and "processing" in whichever order suits them. That
 * is safe because a payment's status only ever moves forward (`invoice.record_payment`, and a database guard
 * behind it), and because the invoice's paid amount is recounted from its payments rather than added up as
 * they arrive. So a late event is kept quietly, and nothing can un-pay an invoice.
 *
 * A webhook only ever **confirms**. A declined card came back from the call that made it, in the customer's
 * own request — Square has no "payment failed" event at all, so anything waiting for one would hang.
 */
import {
  executeCommand,
  invoiceRecordPayment,
  paymentConnectionRevoked,
  paymentRecordRefund,
  subscriptionRecordCycle,
} from '@hfos/core/server';
import { eq } from 'drizzle-orm';
import { asWorker, rows, sql } from '@hfos/db/client';
import { paymentConnections } from '@hfos/db/schema';
import type { DeliveryContext, DeliveryProcessor, ProcessorMap } from '../deliveries';
import { errorMessage } from '../outbox';
import { accountFor, paymentConnectionUsable } from '../payments/index';
import {
  isPaymentProvider,
  type PaymentEvent,
  type PaymentMethodKind,
  type PaymentProviderName,
} from '../payments/provider';
import { systemActor, workerMeta, type TenantScope } from '../services';
import {
  disputeFactsOf,
  paymentFactsOf,
  refundFactsOf,
  subscriptionFactsOf,
  subscriptionOutcomeOf,
} from './webhook-events';

/**
 * The event, read back from the exact bytes the provider sent with **the provider's own parser** — the same
 * one the route used to route it. The envelope stored beside them is the fallback, so a delivery from an older
 * shape still finds its business.
 */
function eventOf(ctx: DeliveryContext, provider: PaymentProviderName): PaymentEvent | null {
  const p = (ctx.delivery.params ?? {}) as Record<string, unknown>;
  const body = typeof p['body'] === 'string' ? p['body'] : null;
  const parsed = body ? (ctx.payments.providers[provider]?.webhooks.parse(body) ?? null) : null;
  if (parsed) return parsed;
  const type = typeof p['type'] === 'string' ? p['type'] : '';
  if (!type) return null;
  return {
    id: typeof p['id'] === 'string' && p['id'] ? p['id'] : ctx.delivery.dedupeKey,
    type,
    accountRef: typeof p['accountRef'] === 'string' && p['accountRef'] ? p['accountRef'] : null,
    createdAt: typeof p['createdAt'] === 'string' && p['createdAt'] ? p['createdAt'] : null,
    data: {},
  };
}

function providerOf(ctx: DeliveryContext): PaymentProviderName | null {
  return isPaymentProvider(ctx.delivery.provider) ? ctx.delivery.provider : null;
}

function tenant(ctx: DeliveryContext): TenantScope | null {
  const { workspaceId, organizationId } = ctx.delivery;
  return workspaceId && organizationId ? { workspaceId, organizationId } : null;
}

/** What the route resolved: the event, its provider, and the business it belongs to. */
interface Routed {
  readonly event: PaymentEvent;
  readonly provider: PaymentProviderName;
  readonly scope: TenantScope;
}

function routed(ctx: DeliveryContext): Routed | null {
  const provider = providerOf(ctx);
  const scope = tenant(ctx);
  if (!provider || !scope) return null;
  const event = eventOf(ctx, provider);
  return event ? { event, provider, scope } : null;
}

/** The connection rows for the account the event happened in, the live one first. */
async function connectionsForAccount(ctx: DeliveryContext, r: Routed) {
  if (!r.event.accountRef) return [];
  return asWorker(ctx.db, r.scope, (tx) =>
    rows<{ connection_id: string }>(
      tx,
      sql`select connection_id
          from private.payment_connection_by_account(${r.provider}, ${r.event.accountRef})`,
    ),
  );
}

/** The payment row this event is about: found by the provider's own id, inside the event's business. */
async function ourPayment(ctx: DeliveryContext, r: Routed, providerPaymentId: string | null) {
  if (!providerPaymentId) return null;
  const [row] = await asWorker(ctx.db, r.scope, (tx) =>
    rows<{
      id: string;
      invoice_id: string;
      amount_cents: number;
      method: string;
      connection_id: string | null;
      status: string;
    }>(
      tx,
      sql`select p.id, p.invoice_id, p.amount_cents::float8 as amount_cents, p.method::text as method,
            p.connection_id, p.status::text as status
          from app.payments p
          where p.workspace_id = ${r.scope.workspaceId} and p.provider::text = ${r.provider}
            and p.provider_payment_id = ${providerPaymentId}
          limit 1`,
    ),
  );
  return row ?? null;
}

// ---------- payments ----------

/**
 * A payment landed, is on its way, or was refused. The row we wrote before calling the provider is found by
 * the provider's own id; a payment taken somewhere else (the provider's own dashboard, a plan's cycle) is
 * created from the invoice we told the provider about.
 */
const onPaymentEvent: DeliveryProcessor = async (ctx) => {
  const r = routed(ctx);
  if (!r) return 'ignored';
  const facts = paymentFactsOf(r.provider, r.event);
  if (!facts.status || facts.status === 'requires_payment') return 'ignored';
  const ours = await ourPayment(ctx, r, facts.providerPaymentId);
  // A replay, or an event confirming what the call that made the payment already told us: taken, and dropped.
  if (ours && ours.status === facts.status) return 'ignored';
  const invoiceId = ours?.invoice_id ?? facts.invoiceId;
  if (!invoiceId) {
    ctx.log.info(
      { provider: r.provider, type: r.event.type, providerPaymentId: facts.providerPaymentId },
      'a payment event that names no invoice of ours',
    );
    return 'ignored';
  }
  const [connection] = await connectionsForAccount(ctx, r);
  await executeCommand(
    ctx.db,
    invoiceRecordPayment,
    {
      workspaceId: r.scope.workspaceId,
      invoiceId,
      ...(ours ? { paymentId: ours.id } : {}),
      amountCents: ours ? Number(ours.amount_cents) : (facts.amountCents ?? 0),
      method: (ours?.method ?? 'card') as PaymentMethodKind,
      provider: r.provider,
      connectionId: ours?.connection_id ?? connection?.connection_id ?? null,
      providerPaymentId: facts.providerPaymentId,
      providerStatus: facts.providerStatus,
      status: facts.status,
      failureCode: facts.failureCode,
      receivedAt: facts.status === 'succeeded' ? facts.receivedAt : null,
    },
    systemActor(r.scope),
    workerMeta(),
  );
};

/**
 * Money given back. Ours is already recorded by the refund it answered (money/refunds.ts), so this is the
 * provider confirming it — or correcting it, if the bank later refused. A refund raised in the provider's own
 * dashboard has no row here and is left alone: reconciling those is deferred, on purpose.
 */
const onRefundEvent: DeliveryProcessor = async (ctx) => {
  const r = routed(ctx);
  if (!r) return 'ignored';
  const facts = refundFactsOf(r.provider, r.event);
  if (!facts.status) return 'ignored';
  const [ours] = await asWorker(ctx.db, r.scope, (tx) =>
    rows<{ id: string; status: string }>(
      tx,
      sql`select rf.id, rf.status::text as status
          from app.refunds rf
          left join app.payments p on p.id = rf.payment_id
          where rf.workspace_id = ${r.scope.workspaceId}
            and (
              (${facts.providerRefundId}::text is not null
                 and rf.provider_refund_id = ${facts.providerRefundId}::text)
              or (${facts.providerPaymentId}::text is not null
                 and p.provider_payment_id = ${facts.providerPaymentId}::text
                 and rf.status = 'pending'))
          order by rf.created_at desc
          limit 1`,
    ),
  );
  if (!ours) {
    ctx.log.info(
      { provider: r.provider, providerRefundId: facts.providerRefundId },
      'a refund the provider knows about and we never asked for',
    );
    return 'ignored';
  }
  await executeCommand(
    ctx.db,
    paymentRecordRefund,
    {
      workspaceId: r.scope.workspaceId,
      refundId: ours.id,
      status: facts.status,
      providerRefundId: facts.providerRefundId,
      providerStatus: facts.status,
      refundedAt: facts.refundedAt,
    },
    systemActor(r.scope),
    workerMeta(),
  );
};

/**
 * The customer's bank took the money back. There is nowhere to put a dispute in M9 — and marking the payment
 * failed would un-pay an invoice that really was paid — so the delivery row **is** the record, and it is
 * logged loudly enough for a person to find. Turning it into something the business is told about belongs
 * with the rest of the money messages.
 */
const onDisputeEvent: DeliveryProcessor = async (ctx) => {
  const r = routed(ctx);
  if (!r) return 'ignored';
  const facts = disputeFactsOf(r.event);
  ctx.log.warn(
    {
      workspaceId: r.scope.workspaceId,
      provider: r.provider,
      type: r.event.type,
      providerPaymentId: facts.providerPaymentId,
      amountCents: facts.amountCents,
      reason: facts.reason,
      state: facts.state,
    },
    'a payment was disputed: the business needs to answer it at the provider',
  );
};

// ---------- plans ----------

/** ISO instants become the local dates a plan's periods are kept in. */
const asDate = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/** The plan a provider id names, in this business. */
async function ourSubscription(ctx: DeliveryContext, r: Routed, externalId: string | null) {
  if (!externalId) return null;
  const [row] = await asWorker(ctx.db, r.scope, (tx) =>
    rows<{ id: string; status: string }>(
      tx,
      sql`select s.id, s.status::text as status from app.subscriptions s
          where s.workspace_id = ${r.scope.workspaceId}
            and s.external_subscription_id = ${externalId}
          limit 1`,
    ),
  );
  return row ?? null;
}

/** A plan billed a cycle, or its card was refused. Both providers say so about the plan, not the invoice. */
function cycleProcessor(outcome: 'billed' | 'failed'): DeliveryProcessor {
  return async (ctx) => {
    const r = routed(ctx);
    if (!r) return 'ignored';
    const facts = subscriptionFactsOf(r.event);
    const plan = await ourSubscription(ctx, r, facts.providerSubscriptionId);
    if (!plan) return 'ignored';
    await executeCommand(
      ctx.db,
      subscriptionRecordCycle,
      {
        workspaceId: r.scope.workspaceId,
        subscriptionId: plan.id,
        outcome,
        externalSubscriptionId: facts.providerSubscriptionId,
        currentPeriodStart: asDate(facts.currentPeriodStart),
        currentPeriodEnd: asDate(facts.currentPeriodEnd),
        nextBillingOn: asDate(facts.currentPeriodEnd),
        message:
          outcome === 'failed'
            ? 'The card on this plan was refused when the provider billed it.'
            : null,
      },
      systemActor(r.scope),
      workerMeta(),
    );
  };
}

/** The plan itself changed at the provider: it went live, it fell behind, or it ended there. */
const onSubscriptionChanged: DeliveryProcessor = async (ctx) => {
  const r = routed(ctx);
  if (!r) return 'ignored';
  const facts = subscriptionFactsOf(r.event);
  const outcome = subscriptionOutcomeOf(facts.providerStatus);
  if (!outcome) return 'ignored';
  const plan = await ourSubscription(ctx, r, facts.providerSubscriptionId);
  // A plan we cancelled here is cancelled: the provider saying so again changes nothing.
  if (!plan || plan.status === 'cancelled') return 'ignored';
  await executeCommand(
    ctx.db,
    subscriptionRecordCycle,
    {
      workspaceId: r.scope.workspaceId,
      subscriptionId: plan.id,
      outcome,
      externalSubscriptionId: facts.providerSubscriptionId,
      currentPeriodStart: asDate(facts.currentPeriodStart),
      currentPeriodEnd: asDate(facts.currentPeriodEnd),
      nextBillingOn: outcome === 'ended' ? null : asDate(facts.currentPeriodEnd),
      endedOn: outcome === 'ended' ? asDate(facts.cancelAt ?? r.event.createdAt) : null,
      message: outcome === 'ended' ? 'Ended at the provider.' : null,
    },
    systemActor(r.scope),
    workerMeta(),
  );
};

// ---------- the account itself ----------

/**
 * The provider changed what the account can do — a seller finished onboarding, or lost a capability. What the
 * customer's page offers comes straight off this, so it is read again from the provider rather than guessed
 * from the event.
 */
const onAccountUpdated: DeliveryProcessor = async (ctx) => {
  const r = routed(ctx);
  if (!r) return 'ignored';
  const [found] = await connectionsForAccount(ctx, r);
  if (!found) return 'ignored';
  const [connection] = await asWorker(ctx.db, r.scope, (tx) =>
    tx.select().from(paymentConnections).where(eq(paymentConnections.id, found.connection_id)),
  );
  if (!connection || !paymentConnectionUsable(connection)) return 'ignored';
  const provider = ctx.payments.providers[r.provider];
  if (!provider?.configured) return 'ignored';
  try {
    const capabilities = await provider.capabilities(accountFor(ctx.sealer, connection));
    await asWorker(ctx.db, r.scope, (tx) =>
      tx
        .update(paymentConnections)
        .set({ capabilities: sql`${JSON.stringify(capabilities)}::jsonb` })
        .where(eq(paymentConnections.id, connection.id)),
    );
  } catch (e) {
    // The account's sign-in is the refresh job's business, not this event's.
    ctx.log.warn(
      { connectionId: connection.id, err: errorMessage(e) },
      'could not read what a payment account can do after the provider said it changed',
    );
    return 'ignored';
  }
};

/**
 * The seller ended it at the provider: Stripe's deauthorize, Square's revoke. The connection is disconnected
 * here too and the owners hear once — and every old payment through that account can be refunded again the
 * moment the same account is reconnected, because credentials resolve by account id and not by this row.
 */
const onConnectionRevoked: DeliveryProcessor = async (ctx) => {
  const r = routed(ctx);
  if (!r) return 'ignored';
  const found = await connectionsForAccount(ctx, r);
  if (!found.length) return 'ignored';
  let acted = false;
  for (const { connection_id: connectionId } of found) {
    const [connection] = await asWorker(ctx.db, r.scope, (tx) =>
      tx.select().from(paymentConnections).where(eq(paymentConnections.id, connectionId)),
    );
    if (!connection || connection.status === 'disconnected') continue;
    await executeCommand(
      ctx.db,
      paymentConnectionRevoked,
      {
        workspaceId: r.scope.workspaceId,
        connectionId,
        reason: r.provider === 'stripe' ? ('deauthorized' as const) : ('revoked' as const),
        message: `${r.provider === 'stripe' ? 'Stripe' : 'Square'} says this account no longer allows HandsFreeOS to take payments.`,
      },
      systemActor(r.scope),
      workerMeta(),
    );
    acted = true;
  }
  return acted ? undefined : 'ignored';
};

/**
 * `provider:kind` → what to do. The kinds are our own (money/webhook-events.ts), so this table reads in one
 * vocabulary rather than in Stripe's and Square's.
 */
function processorsFor(provider: PaymentProviderName): ProcessorMap {
  return {
    [`${provider}:payment.succeeded`]: onPaymentEvent,
    [`${provider}:payment.processing`]: onPaymentEvent,
    [`${provider}:payment.failed`]: onPaymentEvent,
    [`${provider}:payment.refunded`]: onRefundEvent,
    [`${provider}:payment.disputed`]: onDisputeEvent,
    [`${provider}:invoice.paid`]: cycleProcessor('billed'),
    [`${provider}:invoice.payment_failed`]: cycleProcessor('failed'),
    [`${provider}:subscription.changed`]: onSubscriptionChanged,
    [`${provider}:account.updated`]: onAccountUpdated,
    [`${provider}:payment_connection.revoked`]: onConnectionRevoked,
  };
}

export const paymentProcessors: ProcessorMap = {
  ...processorsFor('stripe'),
  ...processorsFor('square'),
};
