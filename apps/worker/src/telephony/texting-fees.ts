/**
 * What registering for texting costs a business (0105): the worker's half.
 *
 * A registration's fees, or a month of an approved campaign, arrive as `texting_fee.due`. A **job** collects
 * each one: charged to the card the business paid a texting fee with before, or else a Stripe page (Checkout, in
 * our own account) the business pays on, which keeps the card. What happened is recorded through
 * `texting_fee.record_outcome`; a paid registration fee lets its 10DLC steps go to the carriers
 * (`advanceRegistrations` holds them back until then). The money is only ever believed from Stripe: the charge's
 * own answer, or the page's signed event.
 *
 * A card that says no is not tried again: the business is emailed, and pays on a page with another card, which
 * becomes the one charged from then on. An hourly sweep finds each approved campaign whose next month has started
 * (`private.texting_months_due`) and writes that month's fee, one per month, however often it runs.
 *
 * **Paying online switched off** (no Stripe on this server) never strands a registration: its fee is recorded as
 * waived, said so in the logs, and the registration goes ahead. Charging nothing beats texting nothing. HandsFreeOS's
 * own business (`workspaces.is_platform`) is never charged: core gives it no fees, and one it has anyway is waived.
 */
import {
  executeCommand,
  formatUtcDate,
  money,
  scheduleJob,
  textingFeeChargeMonth,
  textingFeeRecordOutcome,
  textingFeeRecordPage,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { DeliveryProcessor, ProcessorMap } from '../deliveries';
import { textingFeeFailedEmail } from '../emails/templates';
import { advanceRegistrations, managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { PaymentError, PlatformUnsupportedError, type CheckoutEvent } from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const TEXTING_FEE_JOBS = {
  /** One fee: charge the kept card, or make a page. */
  collect: 'texting_fee.collect',
  /** One fee the card said no to: a page to pay it with another card. */
  page: 'texting_fee.page',
  /** Global, hourly: whose campaign month has started. */
  months: 'texting_fee.months',
} as const;

export const TEXTING_MONTHS_KEY = 'sweep:texting_months';

/** The webhook delivery kind a texting fee's checkout event is stored under. */
export const TEXTING_FEE_CHECKOUT_KIND = 'texting_fee_checkout';

const HOUR = 60 * 60_000;

type FeeRow = {
  id: string;
  purpose: 'registration' | 'month';
  status: string;
  lines: { key: string; name: string; cents: number }[];
  amount_cents: number;
  period_start: string | Date | null;
  session_ref: string | null;
  business: string;
  email: string | null;
  /** The card a texting fee was paid with before, and its customer: what this one is charged to. */
  card_ref: string | null;
  customer_ref: string | null;
  /** HandsFreeOS's own business, which is never charged. */
  ours: boolean;
};

const feeRow = (ctx: { db: Db }, scope: TenantScope, id: string) =>
  asWorker(ctx.db, scope, (tx) =>
    rows<FeeRow>(
      tx,
      sql`select f.id, f.purpose::text as purpose, f.status::text as status, f.lines, f.amount_cents,
            f.period_start, f.session_ref, w.name as business, w.is_platform as ours,
            coalesce(u.email::text, (
              select o.email::text from app.workspace_memberships m join app.users o on o.id = m.user_id
              where m.workspace_id = f.workspace_id and m.role = 'owner' order by m.created_at limit 1)) as email,
            k.card_ref, k.customer_ref
          from app.texting_fees f
          join app.workspaces w on w.id = f.workspace_id
          left join app.users u on u.id = f.requested_by
          left join lateral (
            select p.card_ref, p.customer_ref from app.texting_fees p
            where p.workspace_id = f.workspace_id and p.status = 'paid' and p.card_ref is not null
            order by p.paid_at desc limit 1) k on true
          where f.id = ${id}::uuid and f.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );

const record = (
  ctx: { db: Db },
  scope: TenantScope,
  textingFeeId: string,
  outcome: {
    status: 'paid' | 'failed' | 'waived';
    paymentRef?: string | null;
    paidCents?: number | null;
    customerRef?: string | null;
    cardRef?: string | null;
    problem?: string | null;
  },
) =>
  executeCommand(
    ctx.db,
    textingFeeRecordOutcome,
    {
      workspaceId: scope.workspaceId,
      textingFeeId,
      status: outcome.status,
      paymentRef: outcome.paymentRef ?? null,
      paidCents: outcome.paidCents ?? null,
      customerRef: outcome.customerRef ?? null,
      cardRef: outcome.cardRef ?? null,
      problem: outcome.problem ?? null,
    },
    systemActor(scope),
    workerMeta(),
  );

const scheduleFor =
  (kind: string): EventHandler =>
  async (ctx) => {
    const { workspaceId, organizationId } = ctx.scope;
    const textingFeeId = ctx.event.entityId;
    if (!workspaceId || !organizationId || !textingFeeId) return;
    await scheduleJob(ctx.tx, {
      kind,
      dedupeKey: `${kind}:${textingFeeId}:${ctx.event.id}`,
      runAt: new Date(),
      payload: { textingFeeId },
      workspaceId,
      organizationId,
    });
  };

/** A fee is owed: collecting it is a job, so it retries on its own. */
export const onTextingFeeDue: EventHandler = scheduleFor(TEXTING_FEE_JOBS.collect);
/** Somebody asked to pay with another card: the page is a job too. */
export const onTextingFeePageRequested: EventHandler = scheduleFor(TEXTING_FEE_JOBS.page);

/** What the page and the receipt call it. */
const productName = (f: FeeRow) =>
  f.purpose === 'month'
    ? `Texting campaign for ${f.business}: the month from ${f.period_start ? formatUtcDate(new Date(f.period_start)) : 'approval'}`
    : `Texting registration for ${f.business}`;

/**
 * A page to pay the fee on. Stripe's idempotency is keyed on the page it replaces, so a retry makes the same
 * page, and a page asked for after one ran out is a new one.
 */
async function makePage(ctx: JobContext, scope: TenantScope, f: FeeRow): Promise<void> {
  const back = (outcome: 'paid' | 'cancelled') =>
    `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting?fees=${outcome}`;
  const page = await ctx.payments.providers.stripe.platform.createCheckout({
    kind: 'texting_fee',
    checkoutId: f.id,
    amountCents: Number(f.amount_cents),
    productName: productName(f),
    description:
      'Passed on at cost from The Campaign Registry and the carriers. This card is kept for later texting fees.',
    lines: f.lines.map((l) => ({ name: l.name, description: null, amountCents: Number(l.cents) })),
    saveCard: true,
    successUrl: back('paid'),
    cancelUrl: back('cancelled'),
    customerEmail: f.email,
    metadata: { workspace_id: scope.workspaceId, organization_id: scope.organizationId },
    idempotencyKey: `texting-fee-checkout-${f.id}-${f.session_ref ?? 'first'}`,
  });
  await executeCommand(
    ctx.db,
    textingFeeRecordPage,
    {
      workspaceId: scope.workspaceId,
      textingFeeId: f.id,
      sessionRef: page.sessionRef,
      url: page.url,
      expiresAt: page.expiresAt,
    },
    systemActor(scope),
    workerMeta(),
  );
}

/** The page could not be made: said on the fee, so the business sees it and can ask again. */
const pageTrouble = 'The payment page couldn’t be made. Try again in a little while.';

/** HandsFreeOS's own business: let through uncharged, so its registration goes to the carriers. */
const waiveOurs = (ctx: { db: Db }, scope: TenantScope, f: FeeRow) =>
  record(ctx, scope, f.id, {
    status: 'waived',
    problem: 'HandsFreeOS’s own business isn’t charged for texting.',
  });

/** One fee: the kept card when there is one, or a page. Safe to run again: only a `pending` fee is collected. */
export const collectTextingFee: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const textingFeeId = String(ctx.job.payload['textingFeeId'] ?? '');
  if (!textingFeeId) return;
  const [f] = await feeRow(ctx, scope, textingFeeId);
  if (!f || f.status !== 'pending') return;
  if (f.ours) {
    await waiveOurs(ctx, scope, f);
    return;
  }
  const platform = ctx.payments.providers.stripe.platform;
  if (!platform.webhooks.configured) {
    ctx.log.warn(
      { textingFeeId },
      'a texting fee went uncharged: STRIPE_PLATFORM_WEBHOOK_SECRET is not set on the worker',
    );
    await record(ctx, scope, f.id, {
      status: 'waived',
      problem: 'Paying online isn’t switched on, so this wasn’t charged.',
    });
    return;
  }

  try {
    if (f.card_ref) {
      const result = await platform.charge({
        amountCents: Number(f.amount_cents),
        method: 'card',
        sourceToken: f.card_ref,
        customerRef: f.customer_ref,
        description: productName(f),
        metadata: { texting_fee_id: f.id, workspace_id: scope.workspaceId },
        // The fee itself: however often this runs, it is charged once.
        idempotencyKey: `texting-fee-${f.id}`,
      });
      if (result.status === 'succeeded') {
        await record(ctx, scope, f.id, {
          status: 'paid',
          paymentRef: result.providerPaymentId,
          paidCents: result.amountCents,
          customerRef: f.customer_ref,
          cardRef: f.card_ref,
        });
        return;
      }
      if (result.status !== 'failed') return { rescheduleAt: new Date(Date.now() + HOUR) };
      // The card said no: the business hears why, and a page is ready to pay with another card.
      await record(ctx, scope, f.id, {
        status: 'failed',
        paymentRef: result.providerPaymentId,
        problem: result.failureMessage ?? 'The card was declined.',
      });
    }
    await makePage(ctx, scope, f);
  } catch (e) {
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      ctx.log.warn({ textingFeeId, err: errorMessage(e) }, 'a texting fee could not be collected');
      await record(ctx, scope, f.id, { status: 'failed', problem: pageTrouble });
      return;
    }
    throw e;
  }
};

/**
 * A page for a fee the card said no to, or whose page ran out. For HandsFreeOS's own business, asked for from any
 * unpaid fee (`texting_fee.pay`), the fee is let through instead: one made before it was marked as ours.
 */
export const pageTextingFee: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const textingFeeId = String(ctx.job.payload['textingFeeId'] ?? '');
  if (!textingFeeId) return;
  const [f] = await feeRow(ctx, scope, textingFeeId);
  if (f?.ours && ['pending', 'open', 'failed'].includes(f.status)) {
    await waiveOurs(ctx, scope, f);
    return;
  }
  if (!f || f.status !== 'failed') return;
  try {
    await makePage(ctx, scope, f);
  } catch (e) {
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      ctx.log.warn({ textingFeeId, err: errorMessage(e) }, 'a texting fee page could not be made');
      // Said on the fee, so the person asking sees why rather than waiting.
      await record(ctx, scope, f.id, { status: 'failed', problem: pageTrouble });
      return;
    }
    throw e;
  }
};

/** What a stored checkout event means for a texting fee. Only `paid` is the money in. */
function feeCheckoutOutcome(
  e: CheckoutEvent,
): { kind: 'paid' } | { kind: 'failed'; problem: string } | null {
  switch (e.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return e.paymentStatus === 'paid' ? { kind: 'paid' } : null;
    case 'checkout.session.expired':
      return {
        kind: 'failed',
        problem: 'The payment page ran out before it was paid, so nothing was charged.',
      };
    case 'checkout.session.async_payment_failed':
      return { kind: 'failed', problem: 'The payment didn’t go through, so nothing was charged.' };
    default:
      return null;
  }
}

export const textingFeeCheckoutOutcome = feeCheckoutOutcome;

/**
 * One checkout event, stored and routed by the webhook (http/founding.ts) to the business the fee is for. Paid
 * is believed whichever page it came from; a page that ran out only counts while it is still the fee's page.
 */
export const onTextingFeeCheckoutEvent: DeliveryProcessor = async (ctx) => {
  const p = (ctx.delivery.params ?? {}) as Record<string, unknown>;
  const body = typeof p['body'] === 'string' ? p['body'] : '';
  const platform = ctx.payments.providers.stripe.platform;
  const event = platform.webhooks.checkout(body);
  const outcome = event ? feeCheckoutOutcome(event) : null;
  if (!event?.textingFeeId || !outcome) return 'ignored';
  const scope = tenantOf({
    workspaceId: ctx.delivery.workspaceId,
    organizationId: ctx.delivery.organizationId,
  });
  if (outcome.kind === 'failed') {
    const [f] = await feeRow(ctx, scope, event.textingFeeId);
    if (!f || f.session_ref !== event.sessionRef) return 'ignored';
    await record(ctx, scope, f.id, { status: 'failed', problem: outcome.problem });
    return;
  }
  const card = await platform.checkoutCard(event.sessionRef);
  await record(ctx, scope, event.textingFeeId, {
    status: 'paid',
    paymentRef: event.paymentRef,
    paidCents: event.amountTotal,
    customerRef: card.customerRef ?? event.customerRef,
    cardRef: card.cardRef,
  });
};

/** Hourly: whose campaign month has started. A month is written once, however often this runs. */
export const planTextingMonths: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      workspace_id: string;
      organization_id: string;
      registration_id: string;
      month_index: number;
      period_start: string | Date;
    }>(tx, sql`select * from private.texting_months_due(200)`),
  );
  for (const d of due) {
    const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
    await executeCommand(
      ctx.db,
      textingFeeChargeMonth,
      {
        workspaceId: d.workspace_id,
        registrationId: d.registration_id,
        monthIndex: Number(d.month_index),
        periodStart: new Date(d.period_start).toISOString(),
      },
      systemActor(scope),
      workerMeta(),
    );
  }
  if (due.length) ctx.log.info({ due: due.length }, 'texting campaign months owed');
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

/** Paid, or let through: a registration's 10DLC steps go to the carriers now. */
export const onTextingFeePaid: EventHandler = async (ctx) => {
  const purpose = (ctx.event.payload as { purpose?: string }).purpose;
  if (purpose !== 'registration') return;
  await advanceRegistrations(ctx, tenantOf(ctx.scope), {
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
};

/** The card said no, or the page ran out: owners and admins hear, with where to pay. */
export const onTextingFeeFailed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [f] = await feeRow(ctx, scope, ctx.event.entityId!);
  if (!f) return;
  const p = ctx.event.payload as { problem?: string | null };
  const mail = textingFeeFailedEmail({
    business: f.business,
    amount: money(Number(f.amount_cents)),
    month: f.purpose === 'month',
    reason: p.problem ?? 'The card was declined.',
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting`,
  });
  for (const m of await managers(ctx.tx, scope.workspaceId))
    await ctx.mailer.send({ to: m.email, ...mail });
};

export const textingFeeJobs: JobMap = {
  [TEXTING_FEE_JOBS.collect]: collectTextingFee,
  [TEXTING_FEE_JOBS.page]: pageTextingFee,
  [TEXTING_FEE_JOBS.months]: planTextingMonths,
};

export const textingFeeProcessors: ProcessorMap = {
  [`stripe:${TEXTING_FEE_CHECKOUT_KIND}`]: onTextingFeeCheckoutEvent,
};
