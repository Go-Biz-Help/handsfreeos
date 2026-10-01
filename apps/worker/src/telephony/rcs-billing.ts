/**
 * Paying for RCS (0104): the worker's half.
 *
 * The founding seat's checkout (founding/checkout.ts) with a year on the end of it. A person presses Pay, which
 * writes a `pending` request in their own name (`rcs_request.submit`) and nothing else; an event queues a **job**
 * that asks Stripe for the page and records it (`rcs_request.record_opened`); and Stripe's own event, arriving at
 * our own account's webhook, records the money (`rcs_request.record_paid`), which opens the support ticket
 * HandsFreeOS makes the sender from. The money is only ever believed from that signed event.
 *
 * **The page keeps the card**, and a year later the renewal is charged to it here: an hourly sweep finds whose
 * year is up (`private.rcs_renewals_due`) and queues one job each, which charges and records what the card said
 * (`rcs_request.record_renewal`). A refused card is not tried again: support is told on a ticket and sorts it
 * out with the business, and RCS stays on meanwhile. Every charge is keyed on the request and the year it is for,
 * so a retry, or a sweep that runs twice, charges once.
 */
import {
  executeCommand,
  formatUtcDate,
  money,
  RCS_FIRST_YEAR_LINES,
  RCS_RENEWAL_LINES,
  rcsRequestRecordClosed,
  rcsRequestRecordOpened,
  rcsRequestRecordPaid,
  rcsRequestRecordRenewal,
  rcsRequestRecordRenewalPage,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { DeliveryProcessor, ProcessorMap } from '../deliveries';
import { rcsPaidEmail, rcsRenewalFailedEmail, rcsRenewedEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { PaymentError, PlatformUnsupportedError, type CheckoutEvent } from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const RCS_BILLING_JOBS = {
  /** One request: ask Stripe for its page. */
  checkout: 'rcs_request.checkout',
  /** After a refused renewal: the page to pay it on with another card. */
  renewalCheckout: 'rcs_request.renewal_checkout',
  /** Global, hourly: whose paid year is up. */
  renewals: 'rcs_request.renewals',
  /** One request's renewal, charged to the card it kept. */
  renew: 'rcs_request.renew',
} as const;

export const RCS_RENEWALS_KEY = 'sweep:rcs_renewals';

/** The webhook delivery kind an RCS checkout event is stored under, beside the founding seats'. */
export const RCS_CHECKOUT_KIND = 'rcs_checkout';

const HOUR = 60 * 60_000;

/** "Oct 1, 2027", the way the ticket and the card say it. */
const longDate = (iso: string | Date) => formatUtcDate(new Date(iso));

type RequestRow = {
  id: string;
  status: string;
  first_year_cents: number;
  yearly_cents: number;
  brand: Record<string, unknown>;
  paid_through: string | null;
  stopped_at: string | null;
  renewal_failed_at: string | null;
  customer_ref: string | null;
  card_ref: string | null;
  ticket_number: number | string | null;
  business: string;
  email: string | null;
};

const requestRow = (ctx: { db: Db }, scope: TenantScope, id: string) =>
  asWorker(ctx.db, scope, (tx) =>
    rows<RequestRow>(
      tx,
      sql`select r.id, r.status::text as status, r.first_year_cents, r.yearly_cents, r.brand,
            r.paid_through, r.stopped_at, r.renewal_failed_at, r.customer_ref, r.card_ref, r.ticket_number,
            w.name as business, u.email::text as email
          from app.rcs_requests r
          join app.workspaces w on w.id = r.workspace_id
          left join app.users u on u.id = r.requested_by
          where r.id = ${id}::uuid and r.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );

const settingsLink = (webUrl: string, workspaceId: string) =>
  `${webUrl}/app/w/${workspaceId}/settings/texting#rcs`;

async function closeRequest(
  ctx: Parameters<JobHandler>[0],
  scope: TenantScope,
  rcsRequestId: string,
  status: 'expired' | 'failed',
  problem: string,
): Promise<void> {
  await executeCommand(
    ctx.db,
    rcsRequestRecordClosed,
    { workspaceId: scope.workspaceId, rcsRequestId, status, problem },
    systemActor(scope),
    workerMeta(),
  );
}

/** A person pressed Pay on a new request: the page is made by a job, so it retries on its own. */
export const onRcsRequestSubmitted: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const rcsRequestId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !rcsRequestId) return;
  await scheduleJob(ctx.tx, {
    kind: RCS_BILLING_JOBS.checkout,
    dedupeKey: `${RCS_BILLING_JOBS.checkout}:${rcsRequestId}`,
    runAt: new Date(),
    payload: { rcsRequestId },
    workspaceId,
    organizationId,
  });
};

/** One request's page, made at Stripe and written down. Safe to run again: only a `pending` one is touched. */
export const runRcsCheckout: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const rcsRequestId = String(ctx.job.payload['rcsRequestId'] ?? '');
  if (!rcsRequestId) return;
  const [r] = await requestRow(ctx, scope, rcsRequestId);
  if (!r || r.status !== 'pending') return;

  const platform = ctx.payments.providers.stripe.platform;
  // Without the webhook secret the page could be paid and nobody would ever hear of it, so it is not made.
  if (!platform.webhooks.configured) {
    ctx.log.warn(
      { rcsRequestId },
      'an RCS checkout was asked for, but STRIPE_PLATFORM_WEBHOOK_SECRET is not set on the worker',
    );
    await closeRequest(
      ctx,
      scope,
      rcsRequestId,
      'failed',
      'Paying online isn’t switched on yet, so nothing was charged. Ask HandsFreeOS support to set up RCS for you.',
    );
    return;
  }

  const firstYear = Number(r.first_year_cents);
  const lines = RCS_FIRST_YEAR_LINES.map((l) => ({
    name: l.name,
    description: l.detail,
    amountCents: l.cents,
  }));
  const back = (outcome: 'paid' | 'cancelled') =>
    `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting?rcs=${outcome}#rcs`;
  try {
    const page = await platform.createCheckout({
      kind: 'rcs_request',
      checkoutId: rcsRequestId,
      amountCents: firstYear,
      productName: `RCS for ${r.business}: the first year`,
      description: `Then ${money(Number(r.yearly_cents))} a year for the carriers’ brand vetting and upkeep, charged to this card. You can stop it renewing in Settings.`,
      // The lines the business was shown, when the price is still the one it was sold at.
      ...(lines.reduce((n, l) => n + l.amountCents, 0) === firstYear ? { lines } : {}),
      saveCard: true,
      successUrl: back('paid'),
      cancelUrl: back('cancelled'),
      customerEmail: r.email,
      metadata: { workspace_id: scope.workspaceId, organization_id: scope.organizationId },
      // Stable per request: a retry after Stripe answered but before we wrote it down gets the same page.
      idempotencyKey: `rcs-checkout-${rcsRequestId}`,
    });
    await executeCommand(
      ctx.db,
      rcsRequestRecordOpened,
      {
        workspaceId: scope.workspaceId,
        rcsRequestId,
        sessionRef: page.sessionRef,
        url: page.url,
        expiresAt: page.expiresAt,
      },
      systemActor(scope),
      workerMeta(),
    );
  } catch (e) {
    // Stripe isn't set up on this server, or said no to the request itself: the person is told, not left waiting.
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      ctx.log.warn(
        { rcsRequestId, err: errorMessage(e) },
        'an RCS checkout page could not be made',
      );
      await closeRequest(
        ctx,
        scope,
        rcsRequestId,
        'failed',
        'The payment page couldn’t be made, so nothing was charged. Try again in a little while.',
      );
      return;
    }
    throw e;
  }
};

/** Somebody asked to pay a refused renewal with another card: the page is made by a job too. */
export const onRcsRenewalPageRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const rcsRequestId = ctx.event.entityId;
  const forPaidThrough = (ctx.event.payload as { forPaidThrough?: string }).forPaidThrough;
  if (!workspaceId || !organizationId || !rcsRequestId || !forPaidThrough) return;
  await scheduleJob(ctx.tx, {
    kind: RCS_BILLING_JOBS.renewalCheckout,
    dedupeKey: `${RCS_BILLING_JOBS.renewalCheckout}:${rcsRequestId}:${forPaidThrough}`,
    runAt: new Date(),
    payload: { rcsRequestId, forPaidThrough },
    workspaceId,
    organizationId,
  });
};

/**
 * The page a business pays a refused renewal on, with another card it keeps for next year. Nothing is written
 * when Stripe can't make it: the person is told on the card, and can press Pay again.
 */
export const runRcsRenewalCheckout: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const rcsRequestId = String(ctx.job.payload['rcsRequestId'] ?? '');
  const forPaidThrough = String(ctx.job.payload['forPaidThrough'] ?? '');
  if (!rcsRequestId || !forPaidThrough) return;
  const [r] = await requestRow(ctx, scope, rcsRequestId);
  if (
    !r ||
    r.status !== 'paid' ||
    !r.renewal_failed_at ||
    !r.paid_through ||
    new Date(r.paid_through).toISOString() !== forPaidThrough
  )
    return;
  const platform = ctx.payments.providers.stripe.platform;
  if (!platform.webhooks.configured) {
    ctx.log.warn({ rcsRequestId }, 'an RCS renewal page was asked for, but paying online is off');
    return;
  }
  const yearly = Number(r.yearly_cents);
  const lines = RCS_RENEWAL_LINES.map((l) => ({
    name: l.name,
    description: l.detail,
    amountCents: l.cents,
  }));
  const back = (outcome: 'paid' | 'cancelled') =>
    `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting?rcs=${outcome === 'paid' ? 'renewed' : 'cancelled'}#rcs`;
  try {
    const page = await platform.createCheckout({
      kind: 'rcs_request',
      checkoutId: rcsRequestId,
      amountCents: yearly,
      productName: `RCS for ${r.business}: another year`,
      description: `Paid through ${longDate(yearAfterIso(forPaidThrough))}. This card is charged next year.`,
      ...(lines.reduce((n, l) => n + l.amountCents, 0) === yearly ? { lines } : {}),
      saveCard: true,
      successUrl: back('paid'),
      cancelUrl: back('cancelled'),
      customerEmail: r.email,
      metadata: {
        workspace_id: scope.workspaceId,
        organization_id: scope.organizationId,
        rcs_renewal_for: forPaidThrough,
      },
      idempotencyKey: `rcs-renewal-checkout-${rcsRequestId}-${forPaidThrough}`,
    });
    await executeCommand(
      ctx.db,
      rcsRequestRecordRenewalPage,
      {
        workspaceId: scope.workspaceId,
        rcsRequestId,
        forPaidThrough,
        sessionRef: page.sessionRef,
        url: page.url,
      },
      systemActor(scope),
      workerMeta(),
    );
  } catch (e) {
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      ctx.log.warn({ rcsRequestId, err: errorMessage(e) }, 'an RCS renewal page could not be made');
      return;
    }
    throw e;
  }
};

/** A year on from an ISO date, the way the command moves `paid_through`. */
const yearAfterIso = (iso: string) => {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
};

/** What a stored checkout event means for an RCS request. Only `paid` is the money in. */
export function rcsCheckoutOutcome(
  e: CheckoutEvent,
): { kind: 'paid' } | { kind: 'closed'; status: 'expired' | 'failed'; problem: string } | null {
  switch (e.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return e.paymentStatus === 'paid' ? { kind: 'paid' } : null;
    case 'checkout.session.expired':
      return {
        kind: 'closed',
        status: 'expired',
        problem:
          'The payment page ran out before it was paid, so nothing was charged. Ask for RCS again whenever you’re ready.',
      };
    case 'checkout.session.async_payment_failed':
      return {
        kind: 'closed',
        status: 'failed',
        problem:
          'The payment didn’t go through, so nothing was charged. Try again with another card.',
      };
    default:
      return null;
  }
}

/**
 * One checkout event, stored and routed by the webhook (http/founding.ts) to the business the request is for.
 * Repeatable and out of order: the commands only move a request forward, and a second "paid" is `already`.
 */
export const onRcsCheckoutEvent: DeliveryProcessor = async (ctx) => {
  const p = (ctx.delivery.params ?? {}) as Record<string, unknown>;
  const body = typeof p['body'] === 'string' ? p['body'] : '';
  const platform = ctx.payments.providers.stripe.platform;
  const event = platform.webhooks.checkout(body);
  const outcome = event ? rcsCheckoutOutcome(event) : null;
  if (!event?.rcsRequestId || !outcome) return 'ignored';
  const scope = tenantOf({
    workspaceId: ctx.delivery.workspaceId,
    organizationId: ctx.delivery.organizationId,
  });

  // A refused renewal, paid on a page of its own with another card: that year renews, on that card.
  if (event.renewalFor) {
    // A page that ran out or failed changes nothing: the renewal is still waiting, and Pay makes another.
    if (outcome.kind === 'closed') return 'ignored';
    const card = await platform.checkoutCard(event.sessionRef);
    await executeCommand(
      ctx.db,
      rcsRequestRecordRenewal,
      {
        workspaceId: scope.workspaceId,
        rcsRequestId: event.rcsRequestId,
        forPaidThrough: event.renewalFor,
        outcome: 'renewed',
        paymentRef: event.paymentRef,
        paidCents: event.amountTotal,
        customerRef: card.customerRef ?? event.customerRef,
        cardRef: card.cardRef,
      },
      systemActor(scope),
      workerMeta(),
    );
    return;
  }

  if (outcome.kind === 'closed') {
    await executeCommand(
      ctx.db,
      rcsRequestRecordClosed,
      {
        workspaceId: scope.workspaceId,
        rcsRequestId: event.rcsRequestId,
        status: outcome.status,
        problem: outcome.problem,
      },
      systemActor(scope),
      workerMeta(),
    );
    return;
  }
  // The card the renewal is charged to isn't on the event: Stripe is asked. If it can't say, the year is still
  // paid for; support bills the renewal by hand, and the ticket says so.
  let card: { customerRef: string | null; cardRef: string | null } = {
    customerRef: event.customerRef,
    cardRef: null,
  };
  try {
    card = await platform.checkoutCard(event.sessionRef);
  } catch (e) {
    if (!(e instanceof PaymentError && e.permanent)) throw e;
    ctx.log.warn(
      { rcsRequestId: event.rcsRequestId, err: errorMessage(e) },
      'an RCS payment kept no card that Stripe would show us',
    );
  }
  await executeCommand(
    ctx.db,
    rcsRequestRecordPaid,
    {
      workspaceId: scope.workspaceId,
      rcsRequestId: event.rcsRequestId,
      sessionRef: event.sessionRef,
      paymentRef: event.paymentRef,
      paidCents: event.amountTotal ?? 0,
      customerRef: card.customerRef ?? event.customerRef,
      cardRef: card.cardRef,
    },
    systemActor(scope),
    workerMeta(),
  );
};

/** Hourly: whose paid year is up. One job each, keyed on the year, so a sweep that runs twice queues one. */
export const planRcsRenewals: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      rcs_request_id: string;
      workspace_id: string;
      organization_id: string;
      paid_through: string | Date;
    }>(tx, sql`select * from private.rcs_renewals_due(200)`),
  );
  for (const d of due) {
    const forPaidThrough = new Date(d.paid_through).toISOString();
    await asWorker(
      ctx.db,
      { workspaceId: d.workspace_id, organizationId: d.organization_id },
      (tx) =>
        scheduleJob(tx, {
          kind: RCS_BILLING_JOBS.renew,
          dedupeKey: `${RCS_BILLING_JOBS.renew}:${d.rcs_request_id}:${forPaidThrough}`,
          runAt: new Date(),
          payload: { rcsRequestId: d.rcs_request_id, forPaidThrough },
          workspaceId: d.workspace_id,
          organizationId: d.organization_id,
        }),
    );
  }
  if (due.length) ctx.log.info({ due: due.length }, 'RCS renewals queued');
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

/** One year's renewal, charged to the card the first payment kept. */
export const renewRcs: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const rcsRequestId = String(ctx.job.payload['rcsRequestId'] ?? '');
  const forPaidThrough = String(ctx.job.payload['forPaidThrough'] ?? '');
  if (!rcsRequestId || !forPaidThrough) return;
  const [r] = await requestRow(ctx, scope, rcsRequestId);
  // Stopped, already renewed, or waiting on support since this was queued: nothing to charge.
  if (
    !r ||
    r.status !== 'paid' ||
    r.stopped_at ||
    r.renewal_failed_at ||
    !r.paid_through ||
    new Date(r.paid_through).toISOString() !== forPaidThrough
  )
    return;

  const record = (input: {
    outcome: 'renewed' | 'failed';
    paymentRef?: string | null;
    paidCents?: number | null;
    problem?: string | null;
  }) =>
    executeCommand(
      ctx.db,
      rcsRequestRecordRenewal,
      {
        workspaceId: scope.workspaceId,
        rcsRequestId,
        forPaidThrough,
        outcome: input.outcome,
        paymentRef: input.paymentRef ?? null,
        paidCents: input.paidCents ?? null,
        problem: input.problem ?? null,
      },
      systemActor(scope),
      workerMeta(),
    );

  if (!r.card_ref)
    return void (await record({
      outcome: 'failed',
      problem: 'There was no card kept to charge it to.',
    }));
  const amountCents = Number(r.yearly_cents);
  try {
    const result = await ctx.payments.providers.stripe.platform.charge({
      amountCents,
      method: 'card',
      sourceToken: r.card_ref,
      customerRef: r.customer_ref,
      description: `RCS for ${r.business}: a year of ${RCS_RENEWAL_LINES.map((l) => l.name.toLowerCase()).join(' and ')}`,
      metadata: { rcs_request_id: rcsRequestId, workspace_id: scope.workspaceId },
      // The request and the year: however often this runs, that year is charged once.
      idempotencyKey: `rcs-renewal-${rcsRequestId}-${forPaidThrough}`,
    });
    if (result.status === 'succeeded')
      await record({
        outcome: 'renewed',
        paymentRef: result.providerPaymentId,
        paidCents: result.amountCents,
      });
    else if (result.status === 'failed')
      await record({
        outcome: 'failed',
        paymentRef: result.providerPaymentId,
        problem: result.failureMessage ?? 'The card was declined.',
      });
    // Still settling: look again in an hour, with the same key, which asks after the same payment.
    else return { rescheduleAt: new Date(Date.now() + HOUR) };
  } catch (e) {
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      await record({ outcome: 'failed', problem: errorMessage(e) });
      return;
    }
    throw e;
  }
};

/** The business hears what happened to its money: paid, renewed, or a renewal refused. */
export const onRcsBilled: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [r] = await requestRow(ctx, scope, ctx.event.entityId!);
  if (!r) return;
  const p = ctx.event.payload as {
    paidCents?: number | null;
    paidThrough?: string;
    problem?: string;
    ticketNumber?: number;
    paidTwice?: boolean;
  };
  const link = settingsLink(ctx.webUrl, scope.workspaceId);
  let mail;
  if (ctx.event.eventType === 'rcs_request.paid') {
    // Paid twice is support's to sort out (the ticket says refund it); the business already had this email.
    if (p.paidTwice || !r.paid_through) return;
    mail = rcsPaidEmail({
      business: r.business,
      paid: money(p.paidCents ?? Number(r.first_year_cents)),
      renews: money(Number(r.yearly_cents)),
      renewsOn: longDate(r.paid_through),
      ticket: Number(p.ticketNumber ?? r.ticket_number ?? 0),
      link,
    });
  } else if (ctx.event.eventType === 'rcs_request.renewed')
    mail = rcsRenewedEmail({
      business: r.business,
      paid: money(p.paidCents ?? Number(r.yearly_cents)),
      until: longDate(p.paidThrough ?? r.paid_through ?? new Date()),
      link,
    });
  else
    mail = rcsRenewalFailedEmail({
      business: r.business,
      amount: money(Number(r.yearly_cents)),
      reason: p.problem ?? 'The card was declined.',
      ticket: Number(p.ticketNumber ?? 0),
      link,
    });
  for (const m of await managers(ctx.tx, scope.workspaceId))
    await ctx.mailer.send({ to: m.email, ...mail });
};

export const rcsBillingJobs: JobMap = {
  [RCS_BILLING_JOBS.checkout]: runRcsCheckout,
  [RCS_BILLING_JOBS.renewalCheckout]: runRcsRenewalCheckout,
  [RCS_BILLING_JOBS.renewals]: planRcsRenewals,
  [RCS_BILLING_JOBS.renew]: renewRcs,
};

export const rcsBillingProcessors: ProcessorMap = {
  [`stripe:${RCS_CHECKOUT_KIND}`]: onRcsCheckoutEvent,
};
