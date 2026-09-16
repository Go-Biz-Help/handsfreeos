/**
 * Giving money back. A person asks (`payment.refund`, which only ever writes a `pending` row in their own
 * name); the worker calls the provider and records what came back (`payment.record_refund`). That split is the
 * database's own rule, and this is the piece in the middle.
 *
 * It is a **job**, not an outbox handler, for the same reason every other provider call is: it can be refused,
 * throttled or simply unanswered, and a job retries one thing with backoff instead of replaying every handler
 * an event has.
 *
 * **Refunds survive a disconnect.** The credentials are resolved by (business, provider, account id) —
 * `accountByExternalId`, never the connection row — so reconnecting the same account brings back the ability to
 * refund every payment ever taken through it. When nothing is connected for that account the refund is marked
 * failed in plain words ("reconnect the account, or refund it at the provider") rather than left pending
 * forever or thrown at the provider to fail there.
 */
import {
  executeCommand,
  paymentRecordRefund,
  scheduleJob,
  type RefundStatus,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { accountByExternalId } from '../payments/index';
import {
  PaymentAuthError,
  PaymentError,
  isPaymentProvider,
  type PaymentProviderName,
} from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

/** Money jobs this step owns. Step 6's reminders and cycles join them under the same prefixes. */
export const MONEY_JOBS = { refund: 'payment.refund' } as const;

export const refundJobKey = (refundId: string): string => `${MONEY_JOBS.refund}:${refundId}`;

/** What the account is called when the refund has to say so to a person. */
const providerName = (p: string) => (p === 'square' ? 'Square' : p === 'stripe' ? 'Stripe' : p);

const RECONNECT_FIRST = (provider: string) =>
  `That ${providerName(provider)} account isn’t connected any more, so the refund couldn’t be sent. Reconnect it and try again, or refund it at the provider.`;

/** A person asked for a refund: the provider call is queued, so it retries on its own if it has to. */
export const onRefundRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const refundId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !refundId) return;
  await scheduleJob(ctx.tx, {
    kind: MONEY_JOBS.refund,
    dedupeKey: refundJobKey(refundId),
    runAt: new Date(),
    payload: { refundId, correlationId: ctx.event.correlationId },
    workspaceId,
    organizationId,
  });
};

type RefundRow = {
  id: string;
  status: string;
  amount_cents: number;
  reason: string | null;
  idempotency_key: string | null;
  payment_method: string;
  /** Where the money it gives back has got to: a bank transfer is days from landing. */
  payment_status: string;
  provider: string | null;
  provider_payment_id: string | null;
  /** The account the money was taken into, whether or not that connection still exists. */
  external_account_id: string | null;
};

/** How long a refund waits for a bank transfer to land before asking again. */
const SETTLING_WAIT_MS = 6 * 60 * 60_000;

/** Writes what the provider said (or that there was no provider to ask). */
async function record(
  ctx: { readonly db: Db },
  scope: TenantScope,
  refundId: string,
  input: {
    status: RefundStatus;
    providerRefundId?: string | null;
    providerStatus?: string | null;
    failureCode?: string | null;
    refundedAt?: string | null;
  },
): Promise<void> {
  await executeCommand(
    ctx.db,
    paymentRecordRefund,
    {
      workspaceId: scope.workspaceId,
      refundId,
      status: input.status,
      providerRefundId: input.providerRefundId ?? null,
      providerStatus: input.providerStatus ?? null,
      failureCode: input.failureCode ?? null,
      refundedAt: input.refundedAt ?? null,
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** One refund, carried out. Safe to run again: a refund that is no longer `pending` is left alone. */
export const runRefund: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const refundId = String(ctx.job.payload['refundId'] ?? '');
  if (!refundId) return;
  const [refund] = await asWorker(ctx.db, scope, (tx) =>
    rows<RefundRow>(
      tx,
      sql`select rf.id, rf.status::text as status, rf.amount_cents::float8 as amount_cents, rf.reason,
            rf.idempotency_key, p.method::text as payment_method, p.status::text as payment_status,
            p.provider::text as provider, p.provider_payment_id,
            coalesce(rc.external_account_id, pc.external_account_id) as external_account_id
          from app.refunds rf
          join app.payments p on p.id = rf.payment_id
          left join app.payment_connections rc on rc.id = rf.connection_id
          left join app.payment_connections pc on pc.id = p.connection_id
          where rf.workspace_id = ${scope.workspaceId} and rf.id = ${refundId}::uuid`,
    ),
  );
  // Already answered (a webhook beat us, or this ran before): nothing to do.
  if (!refund || refund.status !== 'pending') return;

  // Cash or a cheque: the money was handed back in the room, and there is no provider to ask.
  if (!refund.provider || !refund.provider_payment_id) {
    await record(ctx, scope, refundId, {
      status: 'succeeded',
      refundedAt: new Date(ctx.now).toISOString(),
    });
    return;
  }
  if (!isPaymentProvider(refund.provider)) return;
  const provider: PaymentProviderName = refund.provider;

  /**
   * The money hasn't landed yet. A bank transfer takes days, and neither provider will give back what it
   * hasn't got — so the refund waits rather than being refused. This is what makes a deposit on a time that
   * went "sent back at once" honest for bank transfers too: it goes the moment the money arrives.
   */
  if (refund.payment_status === 'requires_payment' || refund.payment_status === 'processing') {
    ctx.log.debug(
      { refundId, paymentStatus: refund.payment_status },
      'a refund is waiting for the money it gives back to land',
    );
    return { rescheduleAt: new Date(ctx.now + SETTLING_WAIT_MS) };
  }

  const found = refund.external_account_id
    ? await accountByExternalId(
        ctx.db,
        scope,
        { provider, externalAccountId: refund.external_account_id },
        ctx.sealer,
      )
    : null;
  // Nothing connected for that account any more: say so, rather than fail at the provider or wait forever.
  if (!found) {
    ctx.log.warn(
      { refundId, provider, accountRef: refund.external_account_id },
      'a refund could not be sent: that account is no longer connected',
    );
    await record(ctx, scope, refundId, {
      status: 'failed',
      failureCode: 'account_disconnected',
      providerStatus: RECONNECT_FIRST(provider),
    });
    return;
  }

  try {
    const result = await ctx.payments.providers[provider].refund(found.account, {
      providerPaymentId: refund.provider_payment_id,
      amountCents: Number(refund.amount_cents),
      reason: refund.reason,
      // Stable per refund, so a retry here (or at the provider) gives back the same money once.
      idempotencyKey: refund.idempotency_key ?? refundId,
    });
    await record(ctx, scope, refundId, {
      status: result.status,
      providerRefundId: result.providerRefundId,
      providerStatus: result.providerStatus,
      failureCode: result.failureCode,
      refundedAt: result.status === 'succeeded' ? new Date(ctx.now).toISOString() : null,
    });
  } catch (e) {
    if (e instanceof PaymentAuthError) {
      await record(ctx, scope, refundId, {
        status: 'failed',
        failureCode: 'account_disconnected',
        providerStatus: RECONNECT_FIRST(provider),
      });
      return;
    }
    if (e instanceof PaymentError && e.permanent) {
      await record(ctx, scope, refundId, {
        status: 'failed',
        failureCode: e.code ?? 'refund_refused',
        providerStatus: e.message.slice(0, 200),
      });
      return;
    }
    // Anything else is the provider not answering: the job retries with backoff, the refund stays pending.
    ctx.log.warn({ refundId, err: errorMessage(e) }, 'a refund was not accepted; trying again');
    throw e;
  }
};

export const moneyJobs: JobMap = { [MONEY_JOBS.refund]: runRefund };
