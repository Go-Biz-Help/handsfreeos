/**
 * Taking a deposit when a customer books (M9 step 10).
 *
 * The rule Chris approved, which everything here exists to keep: **a customer's card is held, not charged,
 * until the time is confirmed**, and if the time goes while they are typing, nothing is taken. So:
 *
 * 1. The booking page takes the time and **holds** it — a real appointment on a real slot, announced to
 *    nobody — and raises the deposit as a **draft invoice** of its own (`purpose: 'deposit'`, `origin:
 *    'booking'`, linked to the seat), so there is one ledger and the invoice for the job can credit it later.
 * 2. The customer pays. A card is **authorised**: the money is held at their bank and nothing has moved.
 * 3. `booking.confirm_deposit` checks the time is still theirs and issues the invoice, in one transaction.
 *    Only once that has stood is the card **captured**.
 * 4. If the time went, the hold is **voided** — nothing was ever taken. A bank transfer cannot be held, so
 *    one on a lost time is **refunded in full, at once**, without anyone asking.
 * 5. A hold nobody pays for runs out after 15 minutes and the time goes back (`booking.deposit_hold`, one job
 *    per seat).
 */
import { randomUUID } from 'node:crypto';
import {
  bookingConfirmDeposit,
  bookingReleaseHold,
  calendarCharge,
  DEPOSIT_HOLD_MINUTES,
  executeCommand,
  HfosError,
  invoiceCreate,
  invoiceRecordPayment,
  loadMoneySettings,
  scheduleJob,
  type BookingCharge,
  type CalendarConfig,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { paymentConnections } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import type { HttpDeps } from '../http/common';
import type { JobHandler } from '../jobs';
import { MONEY_JOBS, refundJobKey } from '../money/refunds';
import { accountFor, paymentConnectionUsable, type PaymentConnectionRow } from '../payments/index';
import {
  declineWording,
  isPaymentProvider,
  PaymentAuthError,
  PaymentError,
  type PaymentCapabilities,
  type PaymentMethodKind,
  type PaymentProviderName,
  type PaymentResult,
  type PaymentState,
} from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export { DEPOSIT_HOLD_MINUTES };

const meta = (): RequestMeta => ({
  correlationId: randomUUID(),
  causationId: null,
  channel: 'booking_page',
});

export const cannotTakePayment = (): HfosError =>
  HfosError.rule(
    'payment_unavailable',
    409,
    'We can’t take a payment right now. Please give us a call and we’ll book you in.',
  );

const providerRefused = (): HfosError =>
  HfosError.rule(
    'payment_provider_error',
    502,
    'The payment couldn’t go through just now. Try again in a minute.',
  );

/** The time went while they were paying. Nothing was taken; the page offers other times. */
export const holdLost = (): HfosError =>
  HfosError.rule(
    'booking_hold_lost',
    409,
    'That time has gone. Nothing was charged — pick another time and we’ll hold that one.',
  );

// ---- What is due now ----

export interface DepositPlan {
  readonly charge: BookingCharge;
  /** What the deposit line is called on the invoice. */
  readonly what: string;
  readonly taxable: boolean;
  /** The account it is paid into; null when none can take it. */
  readonly account: DepositAccount | null;
}

/** What this calendar asks for on this booking, or null when it asks for nothing. */
export async function depositPlan(
  deps: HttpDeps,
  tx: Tx,
  workspaceId: string,
  config: CalendarConfig,
  input: { serviceId: string | null; calendarName: string },
): Promise<DepositPlan | null> {
  // One implementation of "what does this calendar ask for", shared with the AI teammate's guard.
  const due = await calendarCharge(tx, workspaceId, config, input.serviceId);
  if (!due) return null;
  const settings = await loadMoneySettings(tx, workspaceId);
  return {
    charge: due.charge,
    what: due.price.name ?? input.calendarName,
    taxable: due.price.taxable ?? settings.tax.newProductsTaxable,
    account: await depositAccount(deps, tx, workspaceId, config.payments.connectionId, settings),
  };
}

// ---- The account the money lands in ----

export interface PaySession {
  readonly provider: PaymentProviderName;
  readonly flow: 'client_confirm' | 'server_charge';
  /** Stripe's `pk_…`, Square's application id. Public, and safe on a customer's page. */
  readonly publishableKey: string;
  readonly accountId: string;
  readonly locationId: string | null;
}

export interface DepositAccount {
  readonly connection: PaymentConnectionRow;
  readonly session: PaySession;
  readonly methods: readonly PaymentMethodKind[];
}

/**
 * The account this calendar's deposits are paid into: the one it names, else the business's default. As
 * strict as the invoice page's — only a connection that is signed in and usable can take money, and anything
 * else reads to the customer as "we can't take a payment right now", never as a provider error.
 */
export async function depositAccount(
  deps: HttpDeps,
  tx: Tx,
  workspaceId: string,
  connectionId: string | null,
  settings: { bankTransfer: boolean },
): Promise<DepositAccount | null> {
  const list = await tx
    .select()
    .from(paymentConnections)
    .where(eq(paymentConnections.workspaceId, workspaceId));
  const chosen = connectionId
    ? list.find((c) => c.id === connectionId)
    : (list.find((c) => c.isDefault && paymentConnectionUsable(c)) ??
      list.find((c) => paymentConnectionUsable(c)));
  if (!chosen || !paymentConnectionUsable(chosen)) return null;
  if (!isPaymentProvider(chosen.provider)) return null;
  const provider = deps.payments.providers[chosen.provider];
  if (!provider?.configured) return null;
  const caps = (chosen.capabilities ?? {}) as Partial<PaymentCapabilities>;
  const methods: PaymentMethodKind[] = [];
  // Bank transfer leads: it is the cheap rail, and the business can switch it off.
  if (settings.bankTransfer && caps.bankTransfer === true) methods.push('ach');
  if (caps.card === true) methods.push('card');
  if (!methods.length) return null;
  return {
    connection: chosen,
    methods,
    session: {
      provider: chosen.provider,
      flow: provider.flow,
      publishableKey: provider.publishableKey,
      accountId: chosen.externalAccountId ?? '',
      locationId: chosen.locationId,
    },
  };
}

// ---- The deposit invoice ----

export interface DepositInvoice {
  readonly id: string;
  readonly status: string;
  readonly number: string | null;
  readonly amountCents: number;
  readonly paidCents: number;
  readonly connectionId: string | null;
}

/** The deposit raised for one held seat, whatever state it is in. */
export async function invoiceForHold(
  tx: Tx,
  workspaceId: string,
  attendeeId: string,
): Promise<DepositInvoice | null> {
  const [row] = await rows<{
    id: string;
    status: string;
    number: string | null;
    total_cents: number;
    amount_paid_cents: number;
    connection_id: string | null;
  }>(
    tx,
    sql`select id, status::text as status, number, total_cents::float8 as total_cents,
          amount_paid_cents::float8 as amount_paid_cents, connection_id
        from app.invoices
        where workspace_id = ${workspaceId} and attendee_id = ${attendeeId} and origin = 'booking'
        order by created_at
        limit 1`,
  );
  return row
    ? {
        id: row.id,
        status: row.status,
        number: row.number,
        amountCents: Number(row.total_cents),
        paidCents: Number(row.amount_paid_cents),
        connectionId: row.connection_id,
      }
    : null;
}

/**
 * The deposit, as its own draft invoice linked to the seat. A draft on purpose: it is numbered and frozen
 * only when the booking is confirmed, so an invoice with a number is always one that really went out, and a
 * hold nobody paid for leaves a withdrawn draft rather than a gap in the numbering.
 */
export async function raiseDepositInvoice(
  deps: HttpDeps,
  scope: TenantScope,
  input: {
    personId: string;
    attendeeId: string;
    leadId: string | null;
    plan: DepositPlan;
    when: string;
  },
): Promise<string> {
  const { charge, what } = input.plan;
  const full = charge.mode === 'full';
  const { output } = await executeCommand(
    deps.httpDb,
    invoiceCreate,
    {
      workspaceId: scope.workspaceId,
      personId: input.personId,
      leadId: input.leadId,
      attendeeId: input.attendeeId,
      // A deposit is part of the price; the full price is the bill for the visit itself.
      purpose: full ? 'standard' : 'deposit',
      origin: 'booking',
      connectionId: input.plan.account?.connection.id ?? null,
      title: full ? what : `Deposit · ${what}`,
      lines: [
        {
          name: full ? what : `Deposit for ${what}`,
          description: input.when,
          quantity: 1,
          unitLabel: 'each',
          unitPriceCents: charge.amountCents,
          // A deposit is a part payment, not a sale: tax lands on the invoice for the job.
          taxable: full ? input.plan.taxable : false,
        },
      ],
    },
    systemActor(scope),
    meta(),
  );
  return output.invoiceId;
}

// ---- Paying ----

export interface DepositPayContext {
  readonly invoiceId: string;
  readonly attendeeId: string;
  readonly account: DepositAccount;
  readonly amountCents: number;
  readonly method: PaymentMethodKind;
  readonly idempotencyKey: string;
  readonly description: string;
}

/** A provider refusal never reaches the customer in the provider's words. */
export function refused(
  deps: HttpDeps,
  e: unknown,
  scope: TenantScope,
  connectionId: string,
): never {
  if (e instanceof PaymentAuthError) {
    deps.log.warn(
      { workspaceId: scope.workspaceId, connectionId, err: e.message },
      'a deposit could not be taken: the account’s sign-in is gone',
    );
    throw cannotTakePayment();
  }
  if (e instanceof PaymentError) {
    deps.log.warn(
      { workspaceId: scope.workspaceId, connectionId, code: e.code, err: e.message },
      'a deposit was refused by the provider',
    );
    throw e.permanent ? cannotTakePayment() : providerRefused();
  }
  throw e;
}

/** Writes what we know about the payment before and after the provider is called: one press, one charge. */
export async function recordDepositPayment(
  deps: HttpDeps,
  scope: TenantScope,
  ctx: DepositPayContext,
  over: {
    status: PaymentState;
    providerPaymentId?: string | null;
    providerStatus?: string | null;
    failureCode?: string | null;
    feeCents?: number | null;
    netCents?: number | null;
    receivedAt?: string | null;
    cardBrand?: string | null;
    cardLast4?: string | null;
  },
): Promise<{ paymentId: string } | null> {
  try {
    return await writePayment(deps, scope, ctx, over);
  } catch (e) {
    // The hold ran out and its draft was withdrawn while this was in flight. Nothing is owed against a
    // withdrawn document; the money is given back by the caller, which is what the customer cares about.
    if (e instanceof HfosError && e.rule === 'invoice_voided') {
      deps.log.warn(
        { workspaceId: scope.workspaceId, invoiceId: ctx.invoiceId },
        'a deposit landed against a booking whose hold had already gone',
      );
      return null;
    }
    throw e;
  }
}

async function writePayment(
  deps: HttpDeps,
  scope: TenantScope,
  ctx: DepositPayContext,
  over: {
    status: PaymentState;
    providerPaymentId?: string | null;
    providerStatus?: string | null;
    failureCode?: string | null;
    feeCents?: number | null;
    netCents?: number | null;
    receivedAt?: string | null;
    cardBrand?: string | null;
    cardLast4?: string | null;
  },
): Promise<{ paymentId: string }> {
  const { output } = await executeCommand(
    deps.httpDb,
    invoiceRecordPayment,
    {
      workspaceId: scope.workspaceId,
      invoiceId: ctx.invoiceId,
      amountCents: ctx.amountCents,
      method: ctx.method,
      provider: ctx.account.session.provider,
      connectionId: ctx.account.connection.id,
      idempotencyKey: ctx.idempotencyKey,
      providerPaymentId: over.providerPaymentId ?? null,
      providerStatus: over.providerStatus ?? null,
      status: over.status,
      failureCode: over.failureCode ?? null,
      feeCents: over.feeCents ?? null,
      netCents: over.netCents ?? null,
      receivedAt: over.receivedAt ?? null,
      cardBrand: over.cardBrand ?? null,
      cardLast4: over.cardLast4 ?? null,
    },
    systemActor(scope),
    meta(),
  );
  return { paymentId: output.paymentId };
}

/**
 * The money already moved and the time is gone. A card was only ever held, so the hold is let go and nothing
 * is taken. A bank transfer cannot be held — it was charged the moment they pressed — so the whole amount
 * goes back at once, without anyone asking for it.
 */
/**
 * A draft deposit for a time that went, with no money anywhere near it, is withdrawn: nobody owes anything
 * on a booking that never happened. A draft with a bank transfer still settling is left alone — its payment
 * and the refund beside it are the record of money that really moved.
 */
async function withdrawIfEmpty(
  deps: HttpDeps,
  scope: TenantScope,
  invoiceId: string,
): Promise<void> {
  await asWorker(deps.httpDb, scope, (tx) =>
    tx.execute(
      sql`update app.invoices i
          set status = 'void', voided_at = now(),
              void_reason = 'That time went before the booking was confirmed.'
          where i.id = ${invoiceId} and i.workspace_id = ${scope.workspaceId} and i.status = 'draft'
            and not exists (
              select 1 from app.payments p
              where p.invoice_id = i.id and p.status in ('processing', 'succeeded'))`,
    ),
  );
}

export async function undoOnLostSlot(
  deps: HttpDeps,
  scope: TenantScope,
  ctx: DepositPayContext,
  result: PaymentResult | null,
): Promise<{ voided: boolean; refunded: boolean }> {
  // Nothing ever reached the provider: there is only the draft to tidy away.
  if (!result) {
    await withdrawIfEmpty(deps, scope, ctx.invoiceId);
    return { voided: false, refunded: false };
  }
  const provider = deps.payments.providers[ctx.account.session.provider]!;
  let account: ReturnType<typeof accountFor>;
  try {
    account = accountFor(deps.sealer, ctx.account.connection);
  } catch (e) {
    deps.log.error(
      { workspaceId: scope.workspaceId, err: String(e) },
      'a lost time left money with the provider: the account’s sign-in is gone',
    );
    return { voided: false, refunded: false };
  }
  if (result.capturable) {
    try {
      const let_go = await provider.voidAuthorization(account, {
        providerPaymentId: result.providerPaymentId,
        idempotencyKey: `void:${ctx.idempotencyKey}`.slice(0, 64),
      });
      await recordDepositPayment(deps, scope, ctx, {
        status: 'failed',
        providerPaymentId: result.providerPaymentId,
        providerStatus: let_go.providerStatus,
        failureCode: 'slot_taken',
      });
      await withdrawIfEmpty(deps, scope, ctx.invoiceId);
      return { voided: true, refunded: false };
    } catch (e) {
      deps.log.error(
        { workspaceId: scope.workspaceId, err: String(e) },
        'a held card could not be let go after the time went',
      );
      return { voided: false, refunded: false };
    }
  }
  // Nothing was taken at all (a decline, or a card that never went through): there is nothing to give back.
  if (result.status === 'failed') {
    await withdrawIfEmpty(deps, scope, ctx.invoiceId);
    return { voided: false, refunded: false };
  }
  /**
   * A bank transfer was taken the moment they pressed, so the whole amount goes back. The refund is raised
   * here, in full, without anyone asking, and step 5's runner carries it to the provider — which is what makes
   * "at once" true even for money that is still days from landing: it goes back the instant it arrives.
   */
  const reason = 'The time went before the booking was confirmed.';
  const key = `refund:${ctx.idempotencyKey}`.slice(0, 64);
  const [raised] = await asWorker(deps.httpDb, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.refunds
            (workspace_id, payment_id, invoice_id, amount_cents, reason, provider, connection_id,
             status, idempotency_key)
          select ${scope.workspaceId}, p.id, p.invoice_id, ${result.amountCents}, ${reason},
            ${ctx.account.session.provider}::app.payment_provider, ${ctx.account.connection.id},
            'pending'::app.refund_status, ${key}
          from app.payments p
          where p.workspace_id = ${scope.workspaceId} and p.invoice_id = ${ctx.invoiceId}
            and p.provider_payment_id = ${result.providerPaymentId}
          limit 1
          on conflict do nothing
          returning id`,
    ),
  );
  if (!raised) {
    // Already raised (this press answered twice), or the payment row has gone: either way, not twice.
    const [already] = await asWorker(deps.httpDb, scope, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from app.refunds
            where workspace_id = ${scope.workspaceId} and idempotency_key = ${key} limit 1`,
      ),
    );
    if (!already)
      deps.log.error(
        { workspaceId: scope.workspaceId, invoiceId: ctx.invoiceId },
        'a bank deposit on a lost time had no payment row to give back',
      );
    return { voided: false, refunded: !!already };
  }
  await asWorker(deps.httpDb, scope, (tx) =>
    scheduleJob(tx, {
      kind: MONEY_JOBS.refund,
      dedupeKey: refundJobKey(raised.id),
      runAt: new Date(),
      payload: { refundId: raised.id },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    }),
  );
  return { voided: false, refunded: true };
}

/** Confirms the held time and, only once that has stood, captures the card. */
export async function confirmAndCapture(
  deps: HttpDeps,
  scope: TenantScope,
  ctx: DepositPayContext,
  result: PaymentResult,
): Promise<{ number: string | null; payment: PaymentResult }> {
  // One transaction: the time is still theirs, the deposit invoice is issued, and the booking is announced.
  const { output } = await executeCommand(
    deps.httpDb,
    bookingConfirmDeposit,
    {
      workspaceId: scope.workspaceId,
      attendeeId: ctx.attendeeId,
      invoiceId: ctx.invoiceId,
    },
    systemActor(scope),
    meta(),
  );
  if (!result.capturable) return { number: output.number, payment: result };
  const provider = deps.payments.providers[ctx.account.session.provider]!;
  let taken: PaymentResult;
  try {
    taken = await provider.capture(accountFor(deps.sealer, ctx.account.connection), {
      providerPaymentId: result.providerPaymentId,
      amountCents: ctx.amountCents,
      idempotencyKey: `capture:${ctx.idempotencyKey}`.slice(0, 64),
    });
  } catch (e) {
    // The booking stands and the money is still held: the business is told by the payment sitting unsettled
    // rather than the customer being turned away from a time that is now theirs.
    deps.log.error(
      { workspaceId: scope.workspaceId, invoiceId: ctx.invoiceId, err: String(e) },
      'a confirmed booking’s held card could not be captured',
    );
    return { number: output.number, payment: result };
  }
  return { number: output.number, payment: taken };
}

export const depositFailureWording = declineWording;

// ---- The hold running out ----

/** `booking.deposit_hold`: nobody paid, so the time goes back on the calendar. */
export const depositHoldExpire: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const attendeeId = String(ctx.job.payload['attendeeId'] ?? '');
  if (!attendeeId) return;
  try {
    await executeCommand(
      ctx.db,
      bookingReleaseHold,
      {
        workspaceId: scope.workspaceId,
        attendeeId,
        reason: `The deposit wasn’t paid within ${DEPOSIT_HOLD_MINUTES} minutes.`,
      },
      systemActor(scope),
      workerMeta(null, ctx.job.id),
    );
  } catch (e) {
    // Gone with its appointment or its calendar: there is no time left to give back.
    if (e instanceof HfosError && e.code === 'not_found') return;
    throw e;
  }
};

export const depositJobs: Record<string, JobHandler> = {
  'booking.deposit_hold': depositHoldExpire,
};
