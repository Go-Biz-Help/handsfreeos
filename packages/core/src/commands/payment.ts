/**
 * Refunds. A mistaken payment is given back, never edited away: the money moved, and the ledger has to say so.
 *
 * A person asks for the refund; the worker calls the provider and records what came back. That is the database's
 * own rule — `authenticated` may insert a refund only as `pending`, in their own name, with nothing the provider
 * decides filled in — and it is why there are two commands here.
 *
 * **Refunds survive a disconnect.** Credentials resolve by (business, provider, account id), not by the
 * connection row, so reconnecting the same account restores the ability to refund every old payment. Until it is
 * reconnected this refuses in plain words rather than failing at the provider, so the button can say "reconnect
 * the account, or refund it in Stripe" instead of showing an error nobody can act on.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { refunds } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { canRefundMove, isManualPaymentMethod, money, type RefundStatus } from '../money/index';
import { PaymentRecordRefundInput, PaymentRefundInput, RefundStateOutput } from '../schemas/money';
import { requireInvoice } from './money-shared';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type RefundablePayment = {
  id: string;
  invoice_id: string;
  amount_cents: number;
  method: string;
  provider: string | null;
  status: string;
  connection_id: string | null;
  connection_status: string | null;
  external_account_id: string | null;
  refunded_cents: number;
  invoice_number: string | null;
};

/** The payment, what is still refundable on it, and where its account stands today. */
async function requirePayment(ctx: CommandContext, paymentId: string): Promise<RefundablePayment> {
  const [row] = await rows<RefundablePayment>(
    ctx.tx,
    sql`select p.id, p.invoice_id, p.amount_cents::float8 as amount_cents, p.method::text as method,
          p.provider::text as provider, p.status::text as status, p.connection_id,
          c.status::text as connection_status, c.external_account_id,
          coalesce((select sum(r.amount_cents) from app.refunds r
            where r.payment_id = p.id and r.status in ('pending', 'succeeded')), 0)::float8 as refunded_cents,
          i.number as invoice_number
        from app.payments p
        join app.invoices i on i.id = p.invoice_id
        left join app.payment_connections c on c.id = p.connection_id
        -- No row lock: people are not granted UPDATE on app.payments at all (a mistake is refunded, never
        -- edited), and the refund's own unique idempotency key is what stops a double-click.
        where p.workspace_id = ${ctx.scope.workspaceId!} and p.id = ${paymentId}::uuid`,
  );
  if (!row) throw HfosError.notFound('That payment isn’t there.');
  return row;
}

/**
 * The account this refund would go through. A disconnected connection is not the end of it: the same account
 * reconnected is a new row, and the credentials are found by (provider, account id). Only when nothing is
 * connected for that account is there nothing to do.
 */
async function connectionForRefund(
  ctx: CommandContext,
  p: RefundablePayment,
): Promise<string | null> {
  if (!p.provider) return null;
  if (p.connection_status && p.connection_status !== 'disconnected') return p.connection_id;
  const [live] = p.external_account_id
    ? await rows<{ id: string }>(
        ctx.tx,
        sql`select c.id from app.payment_connections c
            where c.workspace_id = ${ctx.scope.workspaceId!} and c.provider::text = ${p.provider}
              and c.external_account_id = ${p.external_account_id} and c.status <> 'disconnected'
            order by c.status = 'active' desc, c.created_at desc
            limit 1`,
      )
    : [];
  if (live) return live.id;
  throw HfosError.rule(
    'payment_connection_not_connected',
    409,
    `That ${p.provider === 'square' ? 'Square' : 'Stripe'} account isn’t connected any more. Reconnect it and try again, or refund it at the provider.`,
  );
}

export const paymentRefund = defineCommand({
  name: 'payment.refund',
  description:
    'Give money back on a payment, all of it or part. The worker calls the provider and records what came back; the invoice recounts itself. Refused when the account it was taken through is no longer connected — reconnect it, or refund it at the provider.',
  risk: 3,
  input: PaymentRefundInput,
  output: RefundStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['refund.requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const p = await requirePayment(ctx, input.paymentId);
    if (p.status !== 'succeeded')
      throw HfosError.rule(
        'payment_not_settled',
        409,
        p.status === 'processing'
          ? 'That payment is still on its way. Wait until it lands, then refund it.'
          : 'That payment never landed, so there’s nothing to give back.',
      );
    const refundable = Math.max(0, Number(p.amount_cents) - Number(p.refunded_cents));
    const amount = input.amountCents ?? refundable;
    if (refundable <= 0)
      throw HfosError.rule(
        'refund_over_balance',
        409,
        'That payment has already been refunded in full.',
      );
    if (amount > refundable)
      throw HfosError.rule(
        'refund_over_balance',
        409,
        `Only ${money(refundable)} of that payment can still be refunded.`,
      );
    const connectionId = await connectionForRefund(ctx, p);
    const manual = isManualPaymentMethod(p.method as never);
    const before = await requireInvoice(ctx, p.invoice_id);
    // A person may only ask: pending, in their own name, with nothing the provider decides filled in.
    const [row] = await ctx.tx
      .insert(refunds)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        paymentId: p.id,
        invoiceId: p.invoice_id,
        amountCents: amount,
        reason: input.reason ?? null,
        provider: (p.provider ?? null) as never,
        connectionId,
        status: 'pending',
        requestedBy: me,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: refunds.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'refund.requested',
      entityType: 'refund',
      entityId: row.id,
      payload: {
        refundId: row.id,
        paymentId: p.id,
        invoiceId: p.invoice_id,
        personId: before.person_id,
        amountCents: amount,
        provider: p.provider,
        connectionId,
        // Cash and cheques have no provider to call: the worker settles these straight away.
        manual,
        reason: input.reason ?? null,
      },
      after: {
        invoice: p.invoice_number ?? 'Invoice',
        refund: money(amount),
        of: money(Number(p.amount_cents)),
        reason: input.reason ?? null,
      },
    });
    return {
      refundId: row.id,
      paymentId: p.id,
      invoiceId: p.invoice_id,
      amountCents: amount,
      status: 'pending' as const,
      manual,
    };
  },
});

export const paymentRecordRefund = defineCommand({
  name: 'payment.record_refund',
  description:
    'Worker: what the provider said about a refund (and, for cash or a cheque, that it was handed back). Its status only moves forward, and the invoice recounts itself once it succeeds.',
  risk: 1,
  input: PaymentRecordRefundInput,
  output: RefundStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['refund.recorded', 'refund.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const [r] = await rows<{
      id: string;
      payment_id: string;
      invoice_id: string;
      amount_cents: number;
      status: string;
      method: string;
    }>(
      ctx.tx,
      sql`select r.id, r.payment_id, r.invoice_id, r.amount_cents::float8 as amount_cents,
            r.status::text as status, p.method::text as method
          from app.refunds r join app.payments p on p.id = r.payment_id
          where r.workspace_id = ${ctx.scope.workspaceId!} and r.id = ${input.refundId}::uuid
          for no key update of r`,
    );
    if (!r) throw HfosError.notFound('That refund isn’t there.');
    const from = r.status as RefundStatus;
    const manual = isManualPaymentMethod(r.method as never);
    const same = (changed: boolean, status: RefundStatus) => ({
      refundId: r.id,
      paymentId: r.payment_id,
      invoiceId: r.invoice_id,
      amountCents: Number(r.amount_cents),
      status,
      manual,
    });
    // A late callback is kept quietly, as the database guard does.
    if (from !== input.status && !canRefundMove(from, input.status)) return same(false, from);
    const before = await requireInvoice(ctx, r.invoice_id);
    await ctx.tx
      .update(refunds)
      .set({
        status: input.status,
        providerRefundId: input.providerRefundId,
        providerStatus: input.providerStatus,
        failureCode: input.status === 'failed' ? input.failureCode : null,
        refundedAt:
          input.status === 'succeeded'
            ? input.refundedAt
              ? new Date(input.refundedAt)
              : new Date()
            : null,
      })
      .where(eq(refunds.id, r.id));
    if (from !== input.status) {
      const after = await requireInvoice(ctx, r.invoice_id);
      await ctx.emit({
        type: input.status === 'failed' ? 'refund.failed' : 'refund.recorded',
        entityType: 'refund',
        entityId: r.id,
        payload: {
          refundId: r.id,
          paymentId: r.payment_id,
          invoiceId: r.invoice_id,
          personId: after.person_id,
          amountCents: Number(r.amount_cents),
          status: input.status,
          failureCode: input.failureCode,
        },
        before: { balance: money(Number(before.balance_cents)) },
        after: {
          invoice: after.number ?? 'Invoice',
          refunded: money(Number(r.amount_cents)),
          status: input.status,
          balance: money(Number(after.balance_cents)),
        },
      });
    }
    return same(from !== input.status, input.status);
  },
});

export const paymentCommands = [paymentRefund, paymentRecordRefund] as const;
