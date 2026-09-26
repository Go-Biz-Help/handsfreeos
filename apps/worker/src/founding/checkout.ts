/**
 * Paying for a founding seat (0093): the worker's half.
 *
 * It is the refunds loop (`money/refunds.ts`) with Stripe Checkout in the middle. A person presses Pay, which
 * writes a `pending` checkout in their own name (`founding.start_checkout`) and nothing else; an event queues
 * a **job** that asks Stripe for the page and records it (`founding.record_checkout_opened`); and Stripe's
 * own event, arriving at our own account's webhook, records the money (`founding.record_checkout_paid`), which
 * is what turns the seat on. The page is a job and not an outbox handler for the reason every provider call
 * is: it can be refused, throttled or simply unanswered, and a job retries one thing with backoff.
 *
 * **The money is only ever believed from Stripe's signed event.** Somebody arriving back on the success page
 * proves nothing — anybody can type that address — so the page only waits and reads.
 *
 * **Our own account.** Every call here is `platform`: no seller's account on it, so the money lands in
 * HandsFreeOS's balance. The events come to a destination of their own (Stripe's "Your account"), signed with
 * a secret of their own, because the Connect endpoint routes by the business an event happened in and ours
 * happen in nobody's.
 */
import {
  executeCommand,
  foundingRecordCheckoutClosed,
  foundingRecordCheckoutOpened,
  foundingRecordCheckoutPaid,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { DeliveryProcessor, ProcessorMap } from '../deliveries';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { PaymentError, PlatformUnsupportedError, type CheckoutEvent } from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const FOUNDING_JOBS = {
  /** One checkout: ask Stripe for its page. */
  checkout: 'founding.checkout',
  /** Global, hourly: reservations that ran out go back (private.founding_expire_reservations). */
  expire: 'founding.expire',
  /** One paid checkout: tell the website's analytics, so the payment is credited to what brought them (opinly.ts). */
  purchase: 'founding.report_purchase',
} as const;

export const FOUNDING_EXPIRE_KEY = 'sweep:founding_reservations';
export const checkoutJobKey = (checkoutId: string): string =>
  `${FOUNDING_JOBS.checkout}:${checkoutId}`;
export const purchaseJobKey = (checkoutId: string): string =>
  `${FOUNDING_JOBS.purchase}:${checkoutId}`;

/** The webhook delivery kind a checkout event is stored under, beside Stripe's Connect kinds. */
export const FOUNDING_CHECKOUT_KIND = 'founding_checkout';

const HOUR = 60 * 60_000;

/** A person pressed Pay on a new checkout: the page is made by a job, so it retries on its own. */
export const onFoundingCheckoutRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const checkoutId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !checkoutId) return;
  await scheduleJob(ctx.tx, {
    kind: FOUNDING_JOBS.checkout,
    dedupeKey: checkoutJobKey(checkoutId),
    runAt: new Date(),
    payload: { checkoutId, correlationId: ctx.event.correlationId },
    workspaceId,
    organizationId,
  });
};

type CheckoutRow = {
  id: string;
  status: string;
  amount_cents: number;
  offer_name: string;
  email: string | null;
};

async function closeCheckout(
  ctx: Parameters<JobHandler>[0],
  scope: TenantScope,
  checkoutId: string,
  status: 'expired' | 'failed',
  problem: string,
): Promise<void> {
  await executeCommand(
    ctx.db,
    foundingRecordCheckoutClosed,
    { workspaceId: scope.workspaceId, checkoutId, status, problem },
    systemActor(scope),
    workerMeta(),
  );
}

/** One checkout's page, made at Stripe and written down. Safe to run again: only a `pending` one is touched. */
export const runFoundingCheckout: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const checkoutId = String(ctx.job.payload['checkoutId'] ?? '');
  if (!checkoutId) return;
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    rows<CheckoutRow>(
      tx,
      sql`select c.id, c.status::text as status, c.amount_cents, o.name as offer_name,
            u.email::text as email
          from platform.founding_checkouts c
          join platform.founding_offers o on o.id = c.offer_id
          left join app.users u on u.id = c.requested_by
          where c.id = ${checkoutId}::uuid and c.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );
  // Already made (a retry after the write), closed, or paid: nothing to do.
  if (!c || c.status !== 'pending') return;

  const platform = ctx.payments.providers.stripe.platform;
  // Without the webhook secret the page could be paid and nobody would ever hear of it, so it is not made.
  if (!platform.webhooks.configured) {
    ctx.log.warn(
      { checkoutId },
      'a founding checkout was asked for, but STRIPE_PLATFORM_WEBHOOK_SECRET is not set on the worker',
    );
    await closeCheckout(
      ctx,
      scope,
      checkoutId,
      'failed',
      'Paying online is not switched on yet. Your seat is still held — we will be in touch.',
    );
    return;
  }

  const back = (outcome: 'paid' | 'cancel') =>
    `${ctx.webUrl}/founding/checkout/${checkoutId}?back=${outcome}`;
  try {
    const page = await platform.createCheckout({
      checkoutId,
      amountCents: Number(c.amount_cents),
      productName: `HandsFreeOS — ${c.offer_name}`,
      description:
        'Paid once. HandsFreeOS for one business for as long as it exists. Texts, calls and AI are billed for what you use.',
      successUrl: back('paid'),
      cancelUrl: back('cancel'),
      customerEmail: c.email,
      metadata: { workspace_id: scope.workspaceId, organization_id: scope.organizationId },
      // Stable per checkout: a retry after Stripe answered but before we wrote it down gets the same page.
      idempotencyKey: `founding-checkout-${checkoutId}`,
    });
    await executeCommand(
      ctx.db,
      foundingRecordCheckoutOpened,
      {
        workspaceId: scope.workspaceId,
        checkoutId,
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
        { checkoutId, err: errorMessage(e) },
        'a founding checkout page could not be made',
      );
      await closeCheckout(
        ctx,
        scope,
        checkoutId,
        'failed',
        'The payment page could not be made. Your seat is still held — try again in a little while.',
      );
      return;
    }
    ctx.log.warn(
      { checkoutId, err: errorMessage(e) },
      'a founding checkout page was not made; trying again',
    );
    throw e;
  }
};

/**
 * A seat was paid for (`founding.paid`, said once per checkout, stranded or not: the money is in either way). The
 * report is a job for the reason the page is: Opinly can be down or slow, and a job retries one thing with backoff
 * rather than holding up the event. Nothing is queued without a key.
 */
export const onFoundingPaid: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const checkoutId = ctx.event.entityId;
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const paidCents = Number(payload['paidCents'] ?? 0);
  if (!ctx.opinly || !workspaceId || !organizationId || !checkoutId || !(paidCents > 0)) return;
  await scheduleJob(ctx.tx, {
    kind: FOUNDING_JOBS.purchase,
    dedupeKey: purchaseJobKey(checkoutId),
    runAt: new Date(),
    payload: { checkoutId, paidCents, offerId: payload['offerId'] ?? null },
    workspaceId,
    organizationId,
  });
};

/**
 * One paid seat, reported to Opinly as a `purchase` of what Stripe actually took. The checkout is the dedup key, so
 * a retry is still one purchase.
 *
 * The address is the one the application was made with on the website, because that is the one the website matched
 * to the visit (the pixel is not in the app, so there is no browser id to send): somebody who pays from an account
 * with another address is still credited to the ad that brought them. A seat staff gave out with no application
 * falls back to the address of whoever paid.
 */
export const reportFoundingPurchase: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const checkoutId = String(ctx.job.payload['checkoutId'] ?? '');
  const paidCents = Number(ctx.job.payload['paidCents'] ?? 0);
  const offerId = ctx.job.payload['offerId'];
  if (!ctx.opinly || !checkoutId || !(paidCents > 0)) return;
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ email: string | null }>(
      tx,
      sql`select coalesce(
              (select a.email::text from platform.founding_applications a
                where a.grant_id = c.grant_id order by a.created_at limit 1),
              u.email::text) as email
          from platform.founding_checkouts c
          left join app.users u on u.id = c.requested_by
          where c.id = ${checkoutId}::uuid and c.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );
  if (!c) return;
  await ctx.opinly.track(
    'purchase',
    {
      value: paidCents / 100,
      currency: 'USD',
      ...(typeof offerId === 'string' ? { offer: offerId } : {}),
    },
    { externalEventId: checkoutId, ...(c.email ? { email: c.email } : {}) },
  );
};

/** Hourly: seats whose reservation ran out, with nothing under way on them, go back (0093). */
export const expireFoundingReservations: JobHandler = async (ctx) => {
  const [row] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ n: number }>(tx, sql`select private.founding_expire_reservations() as n`),
  );
  if (Number(row?.n ?? 0) > 0)
    ctx.log.info({ seats: Number(row?.n) }, 'founding reservations that ran out went back');
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

export const foundingJobs: JobMap = {
  [FOUNDING_JOBS.checkout]: runFoundingCheckout,
  [FOUNDING_JOBS.expire]: expireFoundingReservations,
  [FOUNDING_JOBS.purchase]: reportFoundingPurchase,
};

/**
 * What a stored checkout event means, in our words. Only `paid` is the money in; a completed page for a
 * payment still settling says `unpaid` and waits for `async_payment_succeeded`.
 */
export function checkoutOutcome(
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
        problem: 'The payment page ran out before it was paid. Your seat is still held for now.',
      };
    case 'checkout.session.async_payment_failed':
      return {
        kind: 'closed',
        status: 'failed',
        problem: 'The payment did not go through. Nothing was taken.',
      };
    default:
      return null;
  }
}

/**
 * One checkout event, stored and routed by the HTTP route (http/founding.ts) to the workspace the checkout is
 * for. Repeatable and out of order: the functions behind both commands only move a checkout forward, and a
 * second "paid" is answered `already`.
 */
export const onFoundingCheckoutEvent: DeliveryProcessor = async (ctx) => {
  const p = (ctx.delivery.params ?? {}) as Record<string, unknown>;
  const body = typeof p['body'] === 'string' ? p['body'] : '';
  const event = ctx.payments.providers.stripe.platform.webhooks.checkout(body);
  const outcome = event ? checkoutOutcome(event) : null;
  if (!event?.checkoutId || !outcome) return 'ignored';
  const scope = tenantOf({
    workspaceId: ctx.delivery.workspaceId,
    organizationId: ctx.delivery.organizationId,
  });

  if (outcome.kind === 'paid') {
    const done = await executeCommand(
      ctx.db,
      foundingRecordCheckoutPaid,
      {
        workspaceId: scope.workspaceId,
        checkoutId: event.checkoutId,
        sessionRef: event.sessionRef,
        paymentRef: event.paymentRef,
        paidCents: event.amountTotal ?? 0,
      },
      systemActor(scope),
      workerMeta(),
    );
    if (done.output.outcome === 'no_seat')
      ctx.log.error(
        { checkoutId: event.checkoutId, paymentRef: event.paymentRef },
        'a founding seat was paid for and could not be turned on: refund it or find the seat',
      );
    return;
  }
  await executeCommand(
    ctx.db,
    foundingRecordCheckoutClosed,
    {
      workspaceId: scope.workspaceId,
      checkoutId: event.checkoutId,
      status: outcome.status,
      problem: outcome.problem,
    },
    systemActor(scope),
    workerMeta(),
  );
};

export const foundingProcessors: ProcessorMap = {
  [`stripe:${FOUNDING_CHECKOUT_KIND}`]: onFoundingCheckoutEvent,
};
