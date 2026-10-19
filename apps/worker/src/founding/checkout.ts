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
 *
 * **The $497 seat is paid by the year** (20261027009500), the way RCS is (telephony/rcs-billing.ts). The page keeps
 * the card; an hourly sweep finds whose year is up (`private.founding_renewals_due`) and queues one job each, which
 * charges it and records what the card said (`founding.record_renewal`). A refused card is not tried again: the
 * business is told, and pays that year on a founding checkout of its own with another card. The seat stays on
 * meanwhile. The same sweep gives back the seats somebody stopped renewing, once their year is up. Every charge is
 * keyed on the seat and the year it is for, so a retry, or a sweep that runs twice, charges once.
 */
import {
  executeCommand,
  foundingLongDay,
  foundingPrice,
  foundingRecordCheckoutClosed,
  foundingRecordCheckoutOpened,
  foundingRecordCheckoutPaid,
  foundingRecordRenewal,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { DeliveryProcessor, ProcessorMap } from '../deliveries';
import { foundingRenewalFailedEmail, foundingRenewedEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { foundingContact, queueOpinlyEventFrom, visitorIdFor } from '../opinly';
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
  /** Global, hourly: whose paid year is up, and the seats somebody stopped renewing whose year is over. */
  renewals: 'founding.renewals',
  /** One seat's year, charged to the card its first payment kept. */
  renew: 'founding.renew',
} as const;

export const FOUNDING_EXPIRE_KEY = 'sweep:founding_reservations';
export const FOUNDING_RENEWALS_KEY = 'sweep:founding_renewals';
export const renewJobKey = (grantId: string, forPaidThrough: string): string =>
  `${FOUNDING_JOBS.renew}:${grantId}:${forPaidThrough}`;
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
  offer_id: string;
  offer_name: string;
  billing: string;
  /** Set on a page paying a refused renewal: the year it renews. */
  renewal_for: string | Date | null;
  requested_by: string | null;
  email: string | null;
};

const checkoutRow = (ctx: { db: Db }, scope: TenantScope, checkoutId: string) =>
  asWorker(ctx.db, scope, (tx) =>
    rows<CheckoutRow>(
      tx,
      sql`select c.id, c.status::text as status, c.amount_cents, o.id as offer_id, o.name as offer_name,
            case when o.paid_yearly then 'yearly' else o.billing end as billing, c.renewal_for,
            c.requested_by::text as requested_by, u.email::text as email
          from platform.founding_checkouts c
          join platform.founding_offers o on o.id = c.offer_id
          left join app.users u on u.id = c.requested_by
          where c.id = ${checkoutId}::uuid and c.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );

/** A year on from an ISO date, the way the database moves `current_period_end`. */
const yearAfter = (iso: string | Date): string => {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
};

/** What Stripe's page says the money is for: a seat paid once, a first year, or a renewal paid with another card. */
function checkoutWords(c: CheckoutRow): { productName: string; description: string } {
  const price = foundingPrice(Number(c.amount_cents));
  if (c.renewal_for)
    return {
      productName: `HandsFreeOS — ${c.offer_name}: another year`,
      description: `Paid through ${foundingLongDay(yearAfter(c.renewal_for))}. This card is charged ${price} next year; you can stop it renewing in Settings → Usage & balance.`,
    };
  if (c.billing === 'yearly')
    return {
      productName: `HandsFreeOS — ${c.offer_name}: the first year`,
      description: `HandsFreeOS for one business. Then ${price} a year, charged to this card; you can stop it renewing in Settings → Usage & balance. Texts, calls and AI are billed for what you use.`,
    };
  return {
    productName: `HandsFreeOS — ${c.offer_name}`,
    description:
      'Paid once. HandsFreeOS for one business for as long as it exists. Texts, calls and AI are billed for what you use.',
  };
}

/** What a founding seat looks like to Opinly: one item, priced in dollars. Stripe is always asked in USD. */
const seatProperties = (c: CheckoutRow, cents: number) => {
  const value = cents / 100;
  return {
    value,
    currency: 'USD',
    offer: c.offer_id,
    items: [{ item_id: c.offer_id, item_name: c.offer_name, price: value, quantity: 1 }],
  };
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
  const [c] = await checkoutRow(ctx, scope, checkoutId);
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
      ...checkoutWords(c),
      // A seat paid by the year keeps the card, for next year's renewal charged without them there.
      ...(c.billing === 'yearly' || c.renewal_for ? { saveCard: true } : {}),
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
    // The page exists: somebody is at the till. Told to Opinly when it has a key (opinly.ts); the sale itself is
    // `founding.paid`, below.
    await queueOpinlyEventFrom(ctx, scope, {
      event: 'begin_checkout',
      properties: seatProperties(c, Number(c.amount_cents)),
      externalEventId: `begin_checkout:${checkoutId}`,
      userId: c.requested_by,
      checkoutId,
    });
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
 * to the visit: somebody who pays from an account with another address is still credited to the ad that brought
 * them. A seat staff gave out with no application falls back to the address of whoever paid. When the payer signed
 * up through a website link, the visitor id kept on their sign-in goes too, which matches the visit exactly.
 */
export const reportFoundingPurchase: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const checkoutId = String(ctx.job.payload['checkoutId'] ?? '');
  const paidCents = Number(ctx.job.payload['paidCents'] ?? 0);
  const offerId = ctx.job.payload['offerId'];
  if (!ctx.opinly || !checkoutId || !(paidCents > 0)) return;
  const c = await foundingContact(ctx.db, scope, checkoutId);
  if (!c) return;
  const anonId = await visitorIdFor(ctx, c.requestedBy);
  await ctx.opinly.track(
    'purchase',
    {
      value: paidCents / 100,
      currency: 'USD',
      ...(typeof offerId === 'string' ? { offer: offerId } : {}),
    },
    {
      externalEventId: checkoutId,
      ...(c.email ? { email: c.email } : {}),
      ...(anonId ? { anonId } : {}),
    },
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

/**
 * Hourly: whose paid year is up, one job each, keyed on the seat and the year so a sweep that runs twice queues one;
 * and the seats somebody stopped renewing, whose year is over, go back.
 */
export const planFoundingRenewals: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      grant_id: string;
      workspace_id: string;
      organization_id: string;
      paid_through: string | Date;
    }>(tx, sql`select * from private.founding_renewals_due(200)`),
  );
  for (const d of due) {
    const forPaidThrough = new Date(d.paid_through).toISOString();
    await asWorker(
      ctx.db,
      { workspaceId: d.workspace_id, organizationId: d.organization_id },
      (tx) =>
        scheduleJob(tx, {
          kind: FOUNDING_JOBS.renew,
          dedupeKey: renewJobKey(d.grant_id, forPaidThrough),
          runAt: new Date(),
          payload: { grantId: d.grant_id, forPaidThrough },
          workspaceId: d.workspace_id,
          organizationId: d.organization_id,
        }),
    );
  }
  if (due.length) ctx.log.info({ due: due.length }, 'founding seat renewals queued');
  const [ended] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ n: number }>(tx, sql`select private.founding_end_stopped_years() as n`),
  );
  if (Number(ended?.n ?? 0) > 0)
    ctx.log.info({ seats: Number(ended?.n) }, 'founding seats that stopped renewing went back');
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

type PlanRow = {
  grant_id: string | null;
  grant_status: string | null;
  current_period_end: string | Date | null;
  price_cents: number;
  stripe_customer_id: string | null;
  stripe_card_id: string | null;
  renewal_stopped_at: string | Date | null;
  renewal_failed_at: string | Date | null;
  business: string;
  offer_name: string | null;
};

const planRow = (ctx: { db: Db }, scope: TenantScope) =>
  asWorker(ctx.db, scope, (tx) =>
    rows<PlanRow>(
      tx,
      sql`select p.grant_id, g.status::text as grant_status, p.current_period_end, p.price_cents,
            p.stripe_customer_id, p.stripe_card_id, p.renewal_stopped_at, p.renewal_failed_at,
            w.name as business, o.name as offer_name
          from app.workspace_plans p
          join app.workspaces w on w.id = p.workspace_id
          left join platform.founding_grants g on g.id = p.grant_id
          left join platform.founding_offers o on o.id = g.offer_id
          where p.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );

/** One seat's year, charged to the card the first payment kept. */
export const renewFoundingSeat: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const grantId = String(ctx.job.payload['grantId'] ?? '');
  const forPaidThrough = String(ctx.job.payload['forPaidThrough'] ?? '');
  if (!grantId || !forPaidThrough) return;
  const [p] = await planRow(ctx, scope);
  // Revoked, stopped, already renewed, or waiting on another card since this was queued: nothing to charge.
  if (
    !p ||
    p.grant_id !== grantId ||
    p.grant_status !== 'active' ||
    p.renewal_stopped_at ||
    p.renewal_failed_at ||
    !p.current_period_end ||
    new Date(p.current_period_end).toISOString() !== forPaidThrough
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
      foundingRecordRenewal,
      {
        workspaceId: scope.workspaceId,
        grantId,
        forPaidThrough,
        outcome: input.outcome,
        paymentRef: input.paymentRef ?? null,
        paidCents: input.paidCents ?? null,
        problem: input.problem ?? null,
      },
      systemActor(scope),
      workerMeta(),
    );

  if (!p.stripe_card_id)
    return void (await record({
      outcome: 'failed',
      problem: 'There was no card kept to charge it to.',
    }));
  try {
    const result = await ctx.payments.providers.stripe.platform.charge({
      amountCents: Number(p.price_cents),
      method: 'card',
      sourceToken: p.stripe_card_id,
      customerRef: p.stripe_customer_id,
      description: `HandsFreeOS — ${p.offer_name ?? 'founding seat'}: another year for ${p.business}`,
      metadata: { founding_grant_id: grantId, workspace_id: scope.workspaceId },
      // The seat and the year: however often this runs, that year is charged once.
      idempotencyKey: `founding-renewal-${grantId}-${forPaidThrough}`,
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

/** The business hears what happened to its money: another year paid, or a renewal the card refused. */
export const onFoundingBilled: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [p] = await planRow(ctx, scope);
  if (!p) return;
  const payload = (ctx.event.payload ?? {}) as {
    paidCents?: number | null;
    paidThrough?: string | null;
    problem?: string;
    amountCents?: number;
  };
  const link = `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/usage#founding`;
  const offer = p.offer_name ?? 'founding';
  const mail =
    ctx.event.eventType === 'founding.renewed'
      ? foundingRenewedEmail({
          business: p.business,
          offer,
          paid: foundingPrice(Number(payload.paidCents ?? p.price_cents)),
          until: foundingLongDay(payload.paidThrough ?? iso(p.current_period_end)),
          link,
        })
      : foundingRenewalFailedEmail({
          business: p.business,
          offer,
          amount: foundingPrice(Number(payload.amountCents ?? p.price_cents)),
          reason: payload.problem ?? 'The card was declined.',
          link,
        });
  for (const m of await managers(ctx.tx, scope.workspaceId))
    await ctx.mailer.send({ to: m.email, ...mail });
};

const iso = (d: string | Date | null): string | null => (d ? new Date(d).toISOString() : null);

export const foundingJobs: JobMap = {
  [FOUNDING_JOBS.checkout]: runFoundingCheckout,
  [FOUNDING_JOBS.expire]: expireFoundingReservations,
  [FOUNDING_JOBS.purchase]: reportFoundingPurchase,
  [FOUNDING_JOBS.renewals]: planFoundingRenewals,
  [FOUNDING_JOBS.renew]: renewFoundingSeat,
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
    // The card the yearly renewal is charged to isn't on the event: Stripe is asked. If it can't say, the year is
    // still paid for; next year's renewal finds no card and the business is asked for one.
    let card: { customerRef: string | null; cardRef: string | null } = {
      customerRef: event.customerRef,
      cardRef: null,
    };
    try {
      card = await ctx.payments.providers.stripe.platform.checkoutCard(event.sessionRef);
    } catch (e) {
      if (!(e instanceof PaymentError && e.permanent)) throw e;
      ctx.log.warn(
        { checkoutId: event.checkoutId, err: errorMessage(e) },
        'a founding payment kept no card that Stripe would show us',
      );
    }
    const done = await executeCommand(
      ctx.db,
      foundingRecordCheckoutPaid,
      {
        workspaceId: scope.workspaceId,
        checkoutId: event.checkoutId,
        sessionRef: event.sessionRef,
        paymentRef: event.paymentRef,
        paidCents: event.amountTotal ?? 0,
        customerRef: card.customerRef ?? event.customerRef,
        cardRef: card.cardRef,
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
