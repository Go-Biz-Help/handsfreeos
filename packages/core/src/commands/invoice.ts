/**
 * Invoices, and the payments against them.
 *
 * An invoice is written and rewritten wholesale while it is a draft and freezes when it is sent, exactly as an
 * estimate does: the next number comes from `app.document_counters` inside the send transaction, and from then
 * on the number, the tax, the totals and the lines are that invoice's for life.
 *
 * **Nobody writes what an invoice has been paid.** `amount_paid_cents`, `amount_refunded_cents`, `paid_at` and
 * the paid and partly-paid statuses are recounted by `private.money_roll_up_invoice()` from the payments and
 * refunds that succeeded, under a row lock, every time one lands. So a person recording cash and the worker
 * recording a card both do the same thing — write a payment row — and the invoice follows on its own. That is
 * also why a mistaken payment is refunded rather than edited. **A refund gives money back and never puts it
 * back on the bill** (0053): a refunded invoice stays paid, and billing again is a void and a new invoice.
 *
 * A payment's status only ever moves forward, so a webhook delivered out of order can never un-pay an invoice.
 * `processing` is the days a bank transfer takes: an invoice with one is never overdue, it is paying.
 */
import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import type { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { invoices, payments, paymentConnections } from '@hfos/db/schema';
import { requirePerson, workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { FRESH_MINUTES } from '../mobile';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import { accountForPerson, assertAccountUsable } from './payment-connection';
import {
  TERMS_WORDS,
  canPaymentMove,
  dueDateFor,
  invoiceIsOverdue,
  invoiceMoveProblem,
  invoiceVoidBlock,
  money,
  owedWording,
  type InvoiceStatus,
  type PaymentStatus,
} from '../money/index';
import {
  DocumentRecordViewInput,
  DocumentViewOutput,
  InvoiceCreateInput,
  InvoiceMarkOverdueInput,
  InvoiceOverdueOutput,
  InvoiceRecordCashPaymentInput,
  InvoiceRecordPaymentInput,
  InvoiceSendInput,
  InvoiceStateOutput,
  InvoiceUpdateInput,
  InvoiceVoidInput,
  PaymentStateOutput,
} from '../schemas/money';
import {
  allocateDocumentNumber,
  assertDraft,
  assertRevision,
  businessToday,
  presentOnly,
  draftOf,
  isoAt,
  moneyIso,
  linesFor,
  loadMoneySettings,
  requireInvoice,
  totalsColumns,
  writeLines,
  type InvoiceRow,
} from './money-shared';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const stateOut = (row: InvoiceRow, changed: boolean) => ({
  invoiceId: row.id,
  status: row.status,
  number: row.number,
  revision: Math.round(Number(row.revision)),
  totalCents: Number(row.total_cents),
  balanceCents: Number(row.balance_cents),
  dueOn: row.due_on,
  changed,
});

/** What the invoice is about, on every event: the workflow triggers find the customer through `personId`. */
const subjectOf = (row: InvoiceRow) => ({
  invoiceId: row.id,
  personId: row.person_id,
  leadId: row.lead_id,
  attendeeId: row.attendee_id,
  estimateId: row.estimate_id,
  subscriptionId: row.subscription_id,
  number: row.number,
  totalCents: Number(row.total_cents),
  balanceCents: Number(row.balance_cents),
});

const nameOf = (row: InvoiceRow) => row.number ?? row.title ?? 'Invoice';

/** What a second go at the same thing is told; `invoiceMoveProblem` says nothing about standing still. */
const ALREADY: Readonly<Record<InvoiceStatus, string>> = {
  draft: 'That invoice is already a draft.',
  sent: 'That invoice has already gone out. Void it and reissue to send it again.',
  partly_paid: 'That invoice is already partly paid.',
  paid: 'That invoice is already paid.',
  overdue: 'That invoice is already overdue.',
  void: 'That invoice is already void.',
};

function assertMove(row: InvoiceRow, to: InvoiceStatus): void {
  if (row.status === to) throw HfosError.rule('invoice_not_open', 409, ALREADY[to]);
  const problem = invoiceMoveProblem(row.status, to);
  if (problem) throw HfosError.rule('invoice_not_open', 409, problem);
}

/** The account new invoices are paid into, when the caller doesn't name one. */
async function defaultConnection(ctx: CommandContext): Promise<string | null> {
  const [c] = await ctx.tx
    .select({ id: paymentConnections.id })
    .from(paymentConnections)
    .where(
      and(
        eq(paymentConnections.workspaceId, ctx.scope.workspaceId!),
        eq(paymentConnections.isDefault, true),
        eq(paymentConnections.status, 'active'),
      ),
    )
    .limit(1);
  return c?.id ?? null;
}

/**
 * The account a new invoice is paid into (0102). A person bills only into an account they may use: the one they
 * named, or else the default when it is theirs to use, or the first one that is. What the business raises on its
 * own — a deposit, a plan's cycle, the AI teammate's bill once an owner has said yes — takes the one named, else
 * the default, as it always has.
 */
async function accountOf(ctx: CommandContext, named: string | null | undefined) {
  if (ctx.actor.type !== 'human') return named ?? (await defaultConnection(ctx));
  if (!named) return accountForPerson(ctx, ctx.actor.userId);
  await assertAccountUsable(ctx, ctx.actor.userId, named);
  return named;
}

/**
 * The invoice as it stands after a payment or a refund landed, and the events that go with the change. The
 * roll-up has already recounted it by the time this reads it back.
 */
async function announcePayment(
  ctx: CommandContext,
  invoiceId: string,
  before: InvoiceRow,
  payment: {
    id: string;
    amountCents: number;
    method: string;
    provider: string | null;
    status: PaymentStatus;
    failureCode?: string | null;
    by: 'person' | 'provider';
    reference?: string | null;
  },
): Promise<InvoiceRow> {
  const after = await requireInvoice(ctx, invoiceId);
  const type =
    payment.status === 'failed'
      ? 'payment.failed'
      : payment.status === 'succeeded'
        ? 'payment.recorded'
        : 'payment.updated';
  await ctx.emit({
    type,
    entityType: 'payment',
    entityId: payment.id,
    payload: {
      ...subjectOf(after),
      paymentId: payment.id,
      amountCents: payment.amountCents,
      method: payment.method,
      provider: payment.provider,
      status: payment.status,
      failureCode: payment.failureCode ?? null,
      by: payment.by,
      reference: payment.reference ?? null,
    },
    before: { balance: money(Number(before.balance_cents)), status: before.status },
    after: {
      invoice: nameOf(after),
      amount: money(payment.amountCents),
      by: payment.method,
      status: payment.status,
      balance: money(Number(after.balance_cents)),
    },
  });
  // The roll-up settled it: this is the event businesses automate their thank-yous on.
  if (after.status === 'paid' && before.status !== 'paid')
    await ctx.emit({
      type: 'invoice.paid',
      entityType: 'invoice',
      entityId: after.id,
      payload: { ...subjectOf(after), paidAt: moneyIso(after.paid_at) },
      before: { status: before.status, balance: money(Number(before.balance_cents)) },
      after: { invoice: nameOf(after), status: 'paid', paid: money(Number(after.total_cents)) },
    });
  return after;
}

// ---------- writing one ----------

/**
 * A new draft invoice. `by` is who it is from (its assignee unless one is named, and who created it): a person,
 * the person who approved the AI teammate's bill (M18), or nobody for one the system raises.
 */
export async function createInvoice(
  ctx: CommandContext,
  input: z.infer<typeof InvoiceCreateInput>,
  by: string | null,
) {
  const ws = ctx.scope.workspaceId!;
  await requirePerson(ctx.tx, ws, input.personId);
  const settings = await loadMoneySettings(ctx.tx, ws);
  const draft = draftOf(input.lines, settings, { discount: input.discount });
  const [row] = await ctx.tx
    .insert(invoices)
    .values({
      workspaceId: ws,
      publicRef: dsql`private.new_public_ref()`,
      personId: input.personId,
      leadId: input.leadId ?? null,
      assigneeUserId: input.assigneeUserId ?? by,
      title: input.title ?? null,
      notes: input.notes ?? (settings.notes.invoice || null),
      estimateId: input.estimateId ?? null,
      attendeeId: input.attendeeId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      purpose: input.purpose,
      origin: input.origin,
      connectionId: await accountOf(ctx, input.connectionId),
      dueOn: input.dueOn ?? null,
      terms: input.terms ?? TERMS_WORDS[settings.terms],
      ...totalsColumns(draft),
      createdBy: by,
    })
    .returning({ id: invoices.id });
  if (!row) throw HfosError.forbidden();
  await writeLines(ctx, 'invoice', row.id, input.lines);
  const fresh = await requireInvoice(ctx, row.id);
  await ctx.emit({
    type: 'invoice.created',
    entityType: 'invoice',
    entityId: fresh.id,
    payload: { ...subjectOf(fresh), purpose: input.purpose, origin: input.origin },
    after: {
      total: money(Number(fresh.total_cents)),
      lines: input.lines.length,
      for: input.purpose,
    },
  });
  return stateOut(fresh, true);
}

export const invoiceCreate = defineCommand({
  name: 'invoice.create',
  description:
    'Start an invoice for a customer: its lines, a discount, what it is for and which connected account it is paid into. It stays a draft until it is sent. A deposit at booking, a plan’s cycle and a quick payment all make one of these.',
  risk: 1,
  input: InvoiceCreateInput,
  output: InvoiceStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['invoice.created'],
  // The booking deposit and a plan's cycle raise an invoice of their own. A workflow is deliberately not on
  // this list: there is no "bill this" step yet, and an invoice a workflow raises on its own is its own
  // decision, not a side effect of this one. `money_origin` keeps 'workflow' for the day it arrives.
  actors: ['human', 'system'],
  async handler(ctx, input) {
    return createInvoice(ctx, input, ctx.actor.type === 'human' ? ctx.actor.userId : null);
  },
});

export const invoiceUpdate = defineCommand({
  name: 'invoice.update',
  description:
    'Save a draft invoice: its header and all of its lines at once, against the revision you loaded. A sent invoice can’t be edited — void it and reissue, so it says the same thing next year.',
  risk: 1,
  input: InvoiceUpdateInput,
  output: InvoiceStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['invoice.updated'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireInvoice(ctx, input.invoiceId);
    assertDraft(before, 'invoice');
    assertRevision(before, input.baseRevision, {
      command: 'invoice.create',
      input: presentOnly({
        workspaceId: input.workspaceId,
        personId: input.personId,
        leadId: input.leadId,
        assigneeUserId: input.assigneeUserId,
        title: input.title,
        notes: input.notes,
        lines: input.lines,
        discount: input.discount,
        connectionId: input.connectionId,
        dueOn: input.dueOn,
        terms: input.terms,
      }),
    });
    if (input.personId !== before.person_id)
      throw HfosError.rule(
        'money_document_person',
        409,
        'An invoice stays with the customer it was written for. Make a new one instead.',
      );
    if (input.connectionId && input.connectionId !== before.connection_id)
      await assertAccountUsable(ctx, requireHuman(ctx).userId, input.connectionId);
    const settings = await loadMoneySettings(ctx.tx, ctx.scope.workspaceId!);
    const draft = draftOf(input.lines, settings, { discount: input.discount });
    await ctx.tx
      .update(invoices)
      .set({
        leadId: input.leadId ?? null,
        assigneeUserId: input.assigneeUserId ?? before.assignee_user_id,
        title: input.title ?? null,
        notes: input.notes ?? null,
        connectionId: input.connectionId ?? before.connection_id,
        dueOn: input.dueOn ?? null,
        terms: input.terms ?? before.terms,
        ...totalsColumns(draft),
      })
      .where(eq(invoices.id, before.id));
    await writeLines(ctx, 'invoice', before.id, input.lines);
    const fresh = await requireInvoice(ctx, before.id);
    await ctx.emit({
      type: 'invoice.updated',
      entityType: 'invoice',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), lines: input.lines.length },
      before: { total: money(Number(before.total_cents)) },
      after: { total: money(Number(fresh.total_cents)), lines: input.lines.length },
    });
    return stateOut(fresh, true);
  },
});

/** Sends a draft invoice: its number, its due date, when it went, and the worker's text or email with the link. */
export async function sendInvoice(ctx: CommandContext, input: z.infer<typeof InvoiceSendInput>) {
  const ws = ctx.scope.workspaceId!;
  const before = await requireInvoice(ctx, input.invoiceId);
  assertMove(before, 'sent');
  const lines = (await linesFor(ctx.tx, 'invoice', [before.id])).get(before.id) ?? [];
  if (!lines.length)
    throw HfosError.rule('money_document_empty', 409, 'Add a line before sending it.');
  const settings = await loadMoneySettings(ctx.tx, ws);
  const tz = await workspaceTimezone(ctx.tx, ws);
  const { number } = await allocateDocumentNumber(ctx.tx, ws, 'invoice', settings);
  const dueOn = before.due_on ?? dueDateFor(settings.terms, businessToday(tz));
  await ctx.tx
    .update(invoices)
    .set({
      status: 'sent',
      number,
      dueOn,
      terms: before.terms ?? TERMS_WORDS[settings.terms],
      sentAt: dsql`now()`,
    })
    .where(eq(invoices.id, before.id));
  const fresh = await requireInvoice(ctx, before.id);
  await ctx.emit({
    type: 'invoice.sent',
    entityType: 'invoice',
    entityId: fresh.id,
    payload: {
      ...subjectOf(fresh),
      publicRef: fresh.public_ref,
      linkVersion: fresh.link_version,
      channels: input.channels,
      message: input.message,
      dueOn,
      connectionId: fresh.connection_id,
    },
    before: { status: before.status },
    after: {
      invoice: number,
      total: money(Number(fresh.total_cents)),
      due: dueOn,
      sentBy: input.channels.join(', '),
    },
  });
  return stateOut(fresh, true);
}

export const invoiceSend = defineCommand({
  name: 'invoice.send',
  description:
    'Send an invoice to the customer. It takes the next number, works out its due date from the business’s terms if it hasn’t got one, stamps when it went out and freezes. The worker sends the text or the email with the link they pay on.',
  risk: 2,
  input: InvoiceSendInput,
  output: InvoiceStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['invoice.sent'],
  actors: ['human', 'system'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    return sendInvoice(ctx, input);
  },
});

export const invoiceVoid = defineCommand({
  name: 'invoice.void',
  description:
    'Withdraw an invoice. Its number is kept and never used again. Money paid on it is refunded first — the money moved, and the ledger has to say so — and once everything paid has been given back it can be voided and a new invoice sent in its place.',
  risk: 2,
  input: InvoiceVoidInput,
  output: InvoiceStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['invoice.voided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const before = await requireInvoice(ctx, input.invoiceId);
    if (before.status === 'void') return stateOut(before, false);
    assertMove(before, 'void');
    const paid = Number(before.amount_paid_cents);
    const refunded = Number(before.amount_refunded_cents);
    const [refunding] = await rows<{ pending: boolean }>(
      ctx.tx,
      sql`select exists (select 1 from app.refunds r
            where r.invoice_id = ${before.id}::uuid and r.status = 'pending') as pending`,
    );
    const block = invoiceVoidBlock({
      paidCents: paid,
      refundedCents: refunded,
      hasProcessingPayment: before.settling,
      hasPendingRefund: refunding?.pending === true,
    });
    // Until the money stops moving nobody knows what the invoice holds, so neither answer below is safe yet.
    if (block === 'money_moving')
      throw HfosError.rule(
        'invoice_money_moving',
        409,
        before.settling
          ? 'A payment on this invoice is still on its way. Once it lands, refund it, then void the invoice.'
          : 'A refund on this invoice is still on its way back. Void it once the refund has gone through.',
      );
    if (block === 'money_held')
      throw HfosError.rule(
        'invoice_has_payments',
        409,
        refunded > 0
          ? `${money(paid - refunded)} paid against this invoice hasn’t been given back. Refund it instead.`
          : `${money(paid)} has been paid against this invoice. Refund it instead.`,
      );
    await ctx.tx
      .update(invoices)
      .set({
        status: 'void',
        voidedAt: dsql`now()`,
        voidedBy: me,
        voidReason: input.reason ?? null,
      })
      .where(eq(invoices.id, before.id));
    const fresh = await requireInvoice(ctx, before.id);
    await ctx.emit({
      type: 'invoice.voided',
      entityType: 'invoice',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), reason: input.reason ?? null },
      before: { status: before.status },
      after: { invoice: nameOf(fresh), status: 'void', reason: input.reason ?? null },
    });
    return stateOut(fresh, true);
  },
});

// ---------- money landing ----------

/** An invoice money can be taken against: out, not void, and something still owed. */
function assertPayable(row: InvoiceRow): void {
  if (row.status === 'void')
    throw HfosError.rule('invoice_voided', 409, 'That invoice was voided.');
  if (row.status === 'draft')
    throw HfosError.rule('invoice_not_sent', 409, 'Send the invoice before taking payment on it.');
  if (Number(row.balance_cents) <= 0)
    throw HfosError.rule('invoice_settled', 409, 'That invoice is already paid.');
}

export const invoiceRecordCashPayment = defineCommand({
  name: 'invoice.record_cash_payment',
  description:
    'Record money taken off the system: cash, a cheque, or another way. It lands as a payment in your name and the invoice recounts itself — nobody marks an invoice paid by hand.',
  risk: 2,
  input: InvoiceRecordCashPaymentInput,
  output: PaymentStateOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['payment.recorded', 'invoice.paid'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const before = await requireInvoice(ctx, input.invoiceId);
    assertPayable(before);
    const owed = Number(before.balance_cents);
    if (input.amountCents > owed)
      throw HfosError.rule(
        'payment_over_balance',
        409,
        `That’s more than the ${owedWording(owed)}. Record what was actually taken.`,
      );
    // The insert policy allows a person only this: an off-system method, succeeded, in their own name.
    const [row] = await ctx.tx
      .insert(payments)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        invoiceId: before.id,
        amountCents: input.amountCents,
        method: input.method,
        status: 'succeeded',
        // Taken when the person recorded it (on a phone, perhaps before it had signal), unless they said when.
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : changeMoment(ctx.meta),
        recordedBy: me,
      })
      .returning({ id: payments.id });
    if (!row) throw HfosError.forbidden();
    const after = await announcePayment(ctx, before.id, before, {
      id: row.id,
      amountCents: input.amountCents,
      method: input.method,
      provider: null,
      status: 'succeeded',
      by: 'person',
      reference: input.reference ?? null,
    });
    return {
      paymentId: row.id,
      invoiceId: after.id,
      status: 'succeeded' as const,
      amountCents: input.amountCents,
      invoiceStatus: after.status,
      invoiceBalanceCents: Number(after.balance_cents),
      changed: true,
    };
  },
});

export const invoiceRecordPayment = defineCommand({
  name: 'invoice.record_payment',
  description:
    'Worker: what a provider said about a payment. The row is found by its id, the provider’s id or the idempotency key, or created; its status only ever moves forward, so a callback delivered out of order can never un-pay an invoice.',
  risk: 1,
  input: InvoiceRecordPaymentInput,
  output: PaymentStateOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['payment.recorded', 'payment.updated', 'payment.failed', 'invoice.paid'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const before = await requireInvoice(ctx, input.invoiceId);
    if (before.status === 'void')
      throw HfosError.rule('invoice_voided', 409, 'That invoice was voided.');
    const existing = await findPayment(ctx, input);
    const receivedAt =
      input.status === 'succeeded'
        ? input.receivedAt
          ? new Date(input.receivedAt)
          : new Date()
        : null;

    if (!existing) {
      const [row] = await ctx.tx
        .insert(payments)
        .values({
          workspaceId: ws,
          invoiceId: before.id,
          amountCents: input.amountCents,
          method: input.method,
          provider: input.provider,
          connectionId: input.connectionId,
          providerPaymentId: input.providerPaymentId,
          providerStatus: input.providerStatus,
          status: input.status,
          failureCode: input.status === 'failed' ? input.failureCode : null,
          feeCents: input.feeCents,
          netCents: input.netCents,
          receivedAt,
          // Only a card has these, and only the provider can say what they are.
          cardBrand: input.method === 'card' ? input.cardBrand : null,
          cardLast4: input.method === 'card' ? input.cardLast4 : null,
          idempotencyKey: input.idempotencyKey,
        })
        .returning({ id: payments.id });
      if (!row) throw HfosError.internal();
      const after = await announcePayment(ctx, before.id, before, {
        id: row.id,
        amountCents: input.amountCents,
        method: input.method,
        provider: input.provider,
        status: input.status,
        failureCode: input.failureCode,
        by: 'provider',
      });
      return {
        paymentId: row.id,
        invoiceId: after.id,
        status: input.status,
        amountCents: input.amountCents,
        invoiceStatus: after.status,
        invoiceBalanceCents: Number(after.balance_cents),
        changed: true,
      };
    }

    const from = existing.status as PaymentStatus;
    // A late callback is kept quietly rather than raising: the worker's delivery must not retry forever.
    if (from !== input.status && !canPaymentMove(from, input.status)) {
      const after = await requireInvoice(ctx, before.id);
      return {
        paymentId: existing.id,
        invoiceId: after.id,
        status: from,
        amountCents: Number(existing.amount_cents),
        invoiceStatus: after.status,
        invoiceBalanceCents: Number(after.balance_cents),
        changed: false,
      };
    }
    await ctx.tx
      .update(payments)
      .set({
        status: input.status,
        providerStatus: input.providerStatus ?? existing.provider_status,
        providerPaymentId: input.providerPaymentId ?? existing.provider_payment_id,
        connectionId: input.connectionId ?? existing.connection_id,
        failureCode: input.status === 'failed' ? input.failureCode : null,
        feeCents: input.feeCents ?? existing.fee_cents,
        netCents: input.netCents ?? existing.net_cents,
        // A later callback fills these in if the first answer had not yet; it never blanks them.
        cardBrand: input.cardBrand ?? existing.card_brand,
        cardLast4: input.cardLast4 ?? existing.card_last4,
        // A raw read gives timestamps back as strings, so the kept one has to become a Date again.
        receivedAt:
          input.status === 'succeeded'
            ? existing.received_at
              ? new Date(existing.received_at)
              : receivedAt
            : null,
      })
      .where(eq(payments.id, existing.id));
    const changed = from !== input.status;
    const after = changed
      ? await announcePayment(ctx, before.id, before, {
          id: existing.id,
          amountCents: Number(existing.amount_cents),
          method: existing.method,
          provider: existing.provider,
          status: input.status,
          failureCode: input.failureCode,
          by: 'provider',
        })
      : await requireInvoice(ctx, before.id);
    return {
      paymentId: existing.id,
      invoiceId: after.id,
      status: input.status,
      amountCents: Number(existing.amount_cents),
      invoiceStatus: after.status,
      invoiceBalanceCents: Number(after.balance_cents),
      changed,
    };
  },
});

type PaymentLookupRow = {
  id: string;
  amount_cents: number;
  method: string;
  provider: string | null;
  connection_id: string | null;
  provider_payment_id: string | null;
  provider_status: string | null;
  status: string;
  fee_cents: number | null;
  net_cents: number | null;
  received_at: Date | null;
  card_brand: string | null;
  card_last4: string | null;
};

/** The row this callback is about: its id, the provider's own id, or the key written before the call. */
async function findPayment(
  ctx: CommandContext,
  input: {
    paymentId?: string;
    provider: string;
    providerPaymentId?: string | null;
    connectionId?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<PaymentLookupRow | null> {
  const ws = ctx.scope.workspaceId!;
  const [row] = await rows<PaymentLookupRow>(
    ctx.tx,
    sql`select p.id, p.amount_cents::float8 as amount_cents, p.method::text as method,
          p.provider::text as provider, p.connection_id, p.provider_payment_id, p.provider_status,
          p.status::text as status, p.fee_cents::float8 as fee_cents, p.net_cents::float8 as net_cents,
          p.received_at, p.card_brand, p.card_last4
        from app.payments p
        where p.workspace_id = ${ws}
          and (
            (${input.paymentId ?? null}::uuid is not null and p.id = ${input.paymentId ?? null}::uuid)
            or (${input.providerPaymentId ?? null}::text is not null
                and p.provider::text = ${input.provider}
                and p.provider_payment_id = ${input.providerPaymentId ?? null}::text)
            or (${input.idempotencyKey ?? null}::text is not null
                and p.idempotency_key = ${input.idempotencyKey ?? null}::text
                and p.connection_id is not distinct from ${input.connectionId ?? null}::uuid))
        order by p.created_at desc
        limit 1
        for no key update of p`,
  );
  return row ?? null;
}

export const invoiceRecordView = defineCommand({
  name: 'invoice.record_view',
  description:
    'Worker: the customer opened their invoice. The first time is kept as well as the latest.',
  risk: 0,
  input: DocumentRecordViewInput,
  output: DocumentViewOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['invoice.viewed'],
  actors: ['system'],
  async handler(ctx, input) {
    const before = await requireInvoice(ctx, input.documentId);
    const first = before.first_viewed_at === null;
    const [row] = await rows<{
      first_viewed_at: Date | string | null;
      last_viewed_at: Date | string;
    }>(
      ctx.tx,
      sql`update app.invoices
          set first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now()
          where id = ${before.id} returning first_viewed_at, last_viewed_at`,
    );
    if (!row) throw HfosError.notFound('That invoice isn’t there.');
    if (first)
      await ctx.emit({
        type: 'invoice.viewed',
        entityType: 'invoice',
        entityId: before.id,
        payload: {
          ...subjectOf(before),
          firstViewedAt: moneyIso(row.first_viewed_at),
        },
        after: { invoice: nameOf(before), opened: true },
      });
    return {
      documentId: before.id,
      firstViewedAt: moneyIso(row.first_viewed_at),
      lastViewedAt: isoAt(row.last_viewed_at),
      changed: first,
    };
  },
});

export const invoiceMarkOverdue = defineCommand({
  name: 'invoice.mark_overdue',
  description:
    'Worker: an invoice is past its due day with money still owed. One with a payment on its way is left alone — a bank transfer takes days to settle, and it is paying, not late.',
  risk: 0,
  input: InvoiceMarkOverdueInput,
  output: InvoiceOverdueOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['invoice.overdue'],
  actors: ['system'],
  async handler(ctx, input) {
    const before = await requireInvoice(ctx, input.invoiceId);
    const skip = (reason: string) => ({
      invoiceId: before.id,
      status: before.status,
      changed: false,
      skipped: reason,
    });
    if (before.status === 'overdue') return skip('already_overdue');
    if (before.status !== 'sent' && before.status !== 'partly_paid') return skip('not_open');
    if (Number(before.balance_cents) <= 0) return skip('nothing_owed');
    if (!before.due_on) return skip('no_due_date');
    // A bank transfer settling is not a late invoice. The detector and this job agree because both ask this.
    if (before.settling) return skip('settling');
    const tz = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    const overdue = invoiceIsOverdue(
      {
        status: before.status,
        dueDate: before.due_on,
        timeZone: tz,
        balanceCents: Number(before.balance_cents),
        hasProcessingPayment: before.settling,
      },
      Date.now(),
    );
    if (!overdue) return skip('not_late');
    await ctx.tx.update(invoices).set({ status: 'overdue' }).where(eq(invoices.id, before.id));
    const fresh = await requireInvoice(ctx, before.id);
    await ctx.emit({
      type: 'invoice.overdue',
      entityType: 'invoice',
      entityId: fresh.id,
      payload: { ...subjectOf(fresh), dueOn: fresh.due_on },
      before: { status: before.status },
      after: {
        invoice: nameOf(fresh),
        status: 'overdue',
        owed: money(Number(fresh.balance_cents)),
        due: fresh.due_on,
      },
    });
    return { invoiceId: fresh.id, status: fresh.status, changed: true, skipped: null };
  },
});

export const invoiceCommands = [
  invoiceCreate,
  invoiceUpdate,
  invoiceSend,
  invoiceVoid,
  invoiceRecordCashPayment,
  invoiceRecordPayment,
  invoiceRecordView,
  invoiceMarkOverdue,
] as const;

/** The list query and the Money tab both order payments this way; kept here so the two never disagree. */
export const PAYMENTS_NEWEST_FIRST = [desc(payments.createdAt), desc(payments.id)] as const;
