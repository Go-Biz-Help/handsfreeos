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
 *
 * **The $97 spot is paid by the month** (20261027012700), by the same page, sweep and job: only the period differs,
 * and the database decides it. A spot a business bought itself from the plan page gets a page that lapses in
 * `SELF_SERVE_PAGE_MINUTES`, because its spot is only held for an hour while it pays.
 *
 * **A code** (20261027014300) takes its discount off the page and the renewals while it lasts
 * (`private.founding_charge_cents`), or makes the page a free trial: Stripe's page in its setup mode, which charges
 * nothing and keeps the card. The spot turns on, and the same sweep charges the card when the trial ends.
 *
 * **Every plan's own free trial** (20261027027000) is the same page: the database puts the days on the checkout. When
 * a spot turns on with a trial, a job is set for `TRIAL_ENDING_DAYS` before it ends, which emails the owners and admins
 * when the card is charged and what, unless the trial was stopped or is over by then.
 */
import {
  affiliateCodePriceWords,
  executeCommand,
  foundingLongDay,
  foundingRecordCheckoutClosed,
  foundingRecordCheckoutOpened,
  foundingRecordCheckoutPaid,
  foundingRecordRefund,
  foundingRecordRenewal,
  money,
  scheduleJob,
  TRIAL_ENDING_DAYS,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { DeliveryProcessor, ProcessorMap } from '../deliveries';
import {
  foundingRenewalFailedEmail,
  foundingRenewedEmail,
  foundingTrialEndingEmail,
} from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { foundingContact, queueOpinlyEventFrom, visitorIdFor } from '../opinly';
import { errorMessage } from '../outbox';
import { PaymentError, PlatformUnsupportedError, type CheckoutEvent } from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import {
  billingJobs,
  chargePlanCards,
  describePlanCards,
  keyDay,
  planCards,
  STRIPE_LEAST_CENTS,
  type CardTry,
} from './billing';

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
  /** One free trial: its business is told, a few days before it ends, when the card is charged (20261027027000). */
  trialEnding: 'founding.trial_ending',
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
/** A refund of a plan payment, from our own account's webhook (20261027014200). */
export const PLAN_REFUND_KIND = 'plan_refund';

const HOUR = 60 * 60_000;

/**
 * How long Stripe keeps a page open for a spot a business is buying for itself. Stripe takes 30 minutes to a day; the
 * spot is held an hour (`private.founding_buy`), and a few minutes over Stripe's least keeps clocks from disagreeing.
 */
export const SELF_SERVE_PAGE_MINUTES = 45;

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
  /** Set on a page paying a refused renewal: the month or year it renews. */
  renewal_for: string | Date | null;
  requested_by: string | null;
  email: string | null;
  /** The business is buying this spot itself, from the plan page (20261027012700). */
  self_serve: boolean;
  /** Bought with a code (20261027014300): the price before it, what comes off each payment, and for how long. */
  full_cents: number | null;
  discount_cents: number;
  discount_months: number | null;
  /** A free trial: the page only keeps the card, and `amount_cents` is charged when it ends. */
  trial_days: number | null;
};

const checkoutRow = (ctx: { db: Db }, scope: TenantScope, checkoutId: string) =>
  asWorker(ctx.db, scope, (tx) =>
    rows<CheckoutRow>(
      tx,
      sql`select c.id, c.status::text as status, c.amount_cents, o.id as offer_id, o.name as offer_name,
            case when o.paid_yearly then 'yearly' else o.billing end as billing, c.renewal_for,
            c.requested_by::text as requested_by, u.email::text as email, g.self_serve,
            c.full_cents, c.discount_cents, c.discount_months, c.trial_days
          from platform.founding_checkouts c
          join platform.founding_offers o on o.id = c.offer_id
          join platform.founding_grants g on g.id = c.grant_id
          left join app.users u on u.id = c.requested_by
          where c.id = ${checkoutId}::uuid and c.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );

/** What one payment pays for: a month, a year, or nothing more (a seat paid once). */
const periodOf = (billing: string): 'month' | 'year' | null =>
  billing === 'monthly' ? 'month' : billing === 'yearly' ? 'year' : null;

/**
 * A month or a year on from an ISO date, the way the database moves `current_period_end` (Postgres keeps a month on
 * the 31st to the month's last day, and so does this).
 */
const periodAfter = (iso: string | Date, period: 'month' | 'year'): string => {
  const d = new Date(iso);
  const day = d.getUTCDate();
  if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString();
};

/**
 * What Stripe's page says the money is for: a seat paid once, a first month or year, a renewal paid with another
 * card, or a free trial, with what a code takes off.
 */
function checkoutWords(c: CheckoutRow): { productName: string; description: string } {
  const price = money(Number(c.amount_cents));
  const period = periodOf(c.billing);
  if (c.renewal_for)
    return {
      productName: `HandsFreeOS — ${c.offer_name}: another ${period ?? 'year'}`,
      description: `Paid through ${foundingLongDay(periodAfter(c.renewal_for, period ?? 'year'))}. This card is charged ${price} next ${period ?? 'year'}; you can stop it renewing in Settings → Billing & Usage.`,
    };
  // With a code, the whole deal: "14 days free, then $77.60 a month for the first 3 months, then $97 a month".
  const deal =
    c.full_cents !== null && period
      ? affiliateCodePriceWords({
          fullCents: Number(c.full_cents),
          discountCents: Number(c.discount_cents),
          discountMonths: c.discount_months,
          trialDays: c.trial_days,
          billing: period === 'month' ? 'monthly' : 'yearly',
        })
      : null;
  if (c.trial_days && period) {
    // The trial starts when the page is done, within the hour it's held for.
    const ends = foundingLongDay(new Date(Date.now() + c.trial_days * 86_400_000).toISOString());
    return {
      productName: `HandsFreeOS — ${c.offer_name}: ${c.trial_days} days free`,
      description: `Nothing is charged today: ${deal ?? `${c.trial_days} days free`}. This card is charged ${price} when the trial ends, on ${ends}, unless you stop it renewing first in Settings → Billing & Usage.`,
    };
  }
  if (period)
    return {
      productName: `HandsFreeOS — ${c.offer_name}: the first ${period}`,
      description: deal
        ? `HandsFreeOS for one business: ${deal}, charged to this card; you can stop it renewing in Settings → Billing & Usage. Texts, calls and AI are billed for what you use.`
        : `HandsFreeOS for one business. Then ${price} a ${period}, charged to this card; you can stop it renewing in Settings → Billing & Usage. Texts, calls and AI are billed for what you use.`,
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
      'Paying online is not switched on yet. Your spot is still held — we will be in touch.',
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
      // A spot paid by the month or the year keeps the card, for the next renewal charged without them there.
      ...(periodOf(c.billing) || c.renewal_for ? { saveCard: true } : {}),
      // A free trial's page charges nothing and only keeps the card (20261027014300).
      ...(c.trial_days && !c.renewal_for ? { setupOnly: true } : {}),
      // A spot the business is buying itself is held for an hour, so its page closes well inside that.
      ...(c.self_serve && !c.renewal_for
        ? { expiresAt: new Date(Date.now() + SELF_SERVE_PAGE_MINUTES * 60_000).toISOString() }
        : {}),
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
        'The payment page could not be made. Try again in a little while.',
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
 * Hourly: whose paid month or year is up, and whose failed payment is due its daily retry (20261027023600), one job
 * each, keyed on the seat, the period and the try, so a sweep that runs twice queues one; the seats somebody stopped
 * renewing, whose time is over, go back; and cards kept before they had details are described.
 */
export const planFoundingRenewals: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      grant_id: string;
      workspace_id: string;
      organization_id: string;
      paid_through: string | Date;
      attempt: number;
    }>(tx, sql`select * from private.plan_charges_due(200)`),
  );
  for (const d of due) {
    const forPaidThrough = new Date(d.paid_through).toISOString();
    const attempt = Number(d.attempt ?? 0);
    await asWorker(
      ctx.db,
      { workspaceId: d.workspace_id, organizationId: d.organization_id },
      (tx) =>
        scheduleJob(tx, {
          kind: FOUNDING_JOBS.renew,
          dedupeKey:
            attempt === 0
              ? renewJobKey(d.grant_id, forPaidThrough)
              : `${renewJobKey(d.grant_id, forPaidThrough)}:try${attempt}`,
          runAt: new Date(),
          payload: { grantId: d.grant_id, forPaidThrough, attempt },
          workspaceId: d.workspace_id,
          organizationId: d.organization_id,
        }),
    );
  }
  if (due.length) ctx.log.info({ due: due.length }, 'founding seat renewals and retries queued');
  const [ended] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ n: number }>(tx, sql`select private.founding_end_stopped_years() as n`),
  );
  if (Number(ended?.n ?? 0) > 0)
    ctx.log.info({ seats: Number(ended?.n) }, 'founding seats that stopped renewing went back');
  const described = await describePlanCards(ctx);
  if (described) ctx.log.info({ cards: described }, 'plan cards described');
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

/** Somebody pressed Try my cards now: the same charge a retry makes, as a job of its own (20261027023600). */
export const onPayNowRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const payload = (ctx.event.payload ?? {}) as { grantId?: string; forPaidThrough?: string };
  if (!workspaceId || !organizationId || !payload.grantId || !payload.forPaidThrough) return;
  await scheduleJob(ctx.tx, {
    kind: FOUNDING_JOBS.renew,
    dedupeKey: `${renewJobKey(payload.grantId, payload.forPaidThrough)}:now:${ctx.event.id}`,
    runAt: new Date(),
    payload: {
      grantId: payload.grantId,
      forPaidThrough: payload.forPaidThrough,
      attempt: 'now',
      nonce: ctx.event.id.replaceAll('-', '').slice(0, 6),
    },
    workspaceId,
    organizationId,
  });
};

type PlanRow = {
  grant_id: string | null;
  grant_status: string | null;
  /** How the seat's offer is paid: `monthly` or `yearly` renew. */
  billing: string | null;
  current_period_end: string | Date | null;
  price_cents: number;
  /** What the month or year due costs: the price, less a code's discount while it lasts (20261027014300). */
  charge_cents: number;
  stripe_customer_id: string | null;
  stripe_card_id: string | null;
  renewal_stopped_at: string | Date | null;
  renewal_failed_at: string | Date | null;
  retry_count: number;
  more_time_until: string | Date | null;
  business: string;
  offer_name: string | null;
  /** While a free trial runs: when it ends and the first charge is due (20261027014300). */
  trial_ends_at: string | Date | null;
  renewal_count: number;
};

const planRow = (ctx: { db: Db }, scope: TenantScope) =>
  asWorker(ctx.db, scope, (tx) =>
    rows<PlanRow>(
      tx,
      sql`select p.grant_id, g.status::text as grant_status,
            case when o.paid_yearly then 'yearly' else o.billing end as billing,
            p.current_period_end, p.price_cents, private.founding_charge_cents(p.workspace_id) as charge_cents,
            p.stripe_customer_id, p.stripe_card_id, p.renewal_stopped_at, p.renewal_failed_at,
            p.retry_count, p.more_time_until, w.name as business, o.name as offer_name,
            p.trial_ends_at, p.renewal_count
          from app.workspace_plans p
          join app.workspaces w on w.id = p.workspace_id
          left join platform.founding_grants g on g.id = p.grant_id
          left join platform.founding_offers o on o.id = g.offer_id
          where p.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );

/**
 * One seat's month or year, charged to its cards in turn: the default, then each backup (20261027023600). `attempt` is
 * 0 for the first try, a daily retry's number, or `now` for somebody pressing Try my cards now.
 */
export const renewFoundingSeat: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const grantId = String(ctx.job.payload['grantId'] ?? '');
  const forPaidThrough = String(ctx.job.payload['forPaidThrough'] ?? '');
  const rawAttempt = ctx.job.payload['attempt'];
  const attempt: number | 'now' = rawAttempt === 'now' ? 'now' : Number(rawAttempt ?? 0) || 0;
  const nonce = String(ctx.job.payload['nonce'] ?? 'x').slice(0, 6);
  if (!grantId || !forPaidThrough) return;
  const [p] = await planRow(ctx, scope);
  const failed = !!p?.renewal_failed_at;
  // Revoked, stopped, already renewed, or not the try that's due any more: nothing to charge.
  if (
    !p ||
    p.grant_id !== grantId ||
    p.grant_status !== 'active' ||
    p.renewal_stopped_at ||
    !p.current_period_end ||
    new Date(p.current_period_end).toISOString() !== forPaidThrough ||
    (attempt === 0 && failed) ||
    (attempt !== 0 && !failed) ||
    (typeof attempt === 'number' && attempt > 0 && attempt !== Number(p.retry_count) + 1) ||
    (attempt !== 'now' &&
      p.more_time_until !== null &&
      new Date(p.more_time_until).getTime() > Date.now())
  )
    return;

  const record = (input: {
    outcome: 'renewed' | 'failed';
    paymentRef?: string | null;
    paidCents?: number | null;
    problem?: string | null;
    cards?: CardTry[];
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
        attempt,
        cards: input.cards ?? [],
        random: Math.random(),
      },
      systemActor(scope),
      workerMeta(),
    );

  // Moving the payment day earlier can leave next to nothing to pay: Stripe won't take under 50¢, so it's let off.
  const amount = Number(p.charge_cents);
  if (amount < STRIPE_LEAST_CENTS) return void (await record({ outcome: 'renewed', paidCents: 0 }));

  const cards = await planCards(ctx.db, scope);
  const tag = attempt === 'now' ? `n${nonce}` : `r${attempt}`;
  try {
    const charged = await chargePlanCards(ctx, {
      cards,
      amountCents: amount,
      description: `HandsFreeOS — ${p.offer_name ?? 'founding spot'}: another ${periodOf(p.billing ?? '') ?? 'year'} for ${p.business}`,
      metadata: { founding_grant_id: grantId, workspace_id: scope.workspaceId },
      // The seat, the period, the try and the card: however often this runs, each is charged once. The first card's
      // first try keeps the key it had before backups, so a job running across the deploy charges once too.
      keyFor: (i) =>
        attempt === 0 && i === 0
          ? `founding-renewal-${grantId}-${forPaidThrough}`
          : `plan-${grantId}-${keyDay(forPaidThrough)}-${tag}-${i}`,
    });
    if (charged.status === 'succeeded')
      await record({
        outcome: 'renewed',
        paymentRef: charged.result.providerPaymentId,
        paidCents: charged.result.amountCents,
        cards: charged.tries,
      });
    else if (charged.status === 'failed')
      await record({ outcome: 'failed', problem: charged.problem, cards: charged.tries });
    // Still settling: look again in an hour, with the same keys, which ask after the same payment.
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
  const link = `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/usage`;
  const offer = p.offer_name ?? 'founding';
  const period = periodOf(p.billing ?? '') ?? 'year';
  const mail =
    ctx.event.eventType === 'founding.renewed'
      ? foundingRenewedEmail({
          business: p.business,
          offer,
          paid: money(Number(payload.paidCents ?? p.charge_cents)),
          until: foundingLongDay(payload.paidThrough ?? iso(p.current_period_end)),
          link,
          period,
        })
      : foundingRenewalFailedEmail({
          business: p.business,
          offer,
          amount: money(Number(payload.amountCents ?? p.charge_cents)),
          reason: payload.problem ?? 'The card was declined.',
          link,
          period,
        });
  for (const m of await managers(ctx.tx, scope.workspaceId))
    await ctx.mailer.send({ to: m.email, ...mail });
};

const iso = (d: string | Date | null): string | null => (d ? new Date(d).toISOString() : null);

export const trialEndingJobKey = (grantId: string, endsAt: string): string =>
  `${FOUNDING_JOBS.trialEnding}:${grantId}:${endsAt}`;

/**
 * A spot turned on (20261027027000): with a free trial, its business is told `TRIAL_ENDING_DAYS` before it ends. One
 * job, keyed on the spot and the day the trial ends, so a second word of the same spot sets it once.
 */
export const onFoundingClaimed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const grantId = ctx.event.entityId;
  if (!grantId || !scope.workspaceId) return;
  const [p] = await rows<{ trial_ends_at: string | Date | null; renewal_count: number }>(
    ctx.tx,
    sql`select trial_ends_at, renewal_count from app.workspace_plans
        where workspace_id = ${scope.workspaceId}::uuid and grant_id = ${grantId}::uuid`,
  );
  if (!p?.trial_ends_at || Number(p.renewal_count) > 0) return;
  const endsAt = new Date(p.trial_ends_at).toISOString();
  const runAt = new Date(Math.max(Date.now(), Date.parse(endsAt) - TRIAL_ENDING_DAYS * 24 * HOUR));
  await scheduleJob(ctx.tx, {
    kind: FOUNDING_JOBS.trialEnding,
    dedupeKey: trialEndingJobKey(grantId, endsAt),
    runAt,
    payload: { grantId, endsAt },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

/**
 * The email a few days before a free trial ends: when the card is charged, what, and how to stop it. Nothing is sent
 * when the trial is no longer that one: the spot went back or moved, it was set not to renew, or it's already over.
 */
export const sendTrialEnding: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const grantId = String(ctx.job.payload['grantId'] ?? '');
  const endsAt = String(ctx.job.payload['endsAt'] ?? '');
  if (!grantId || !endsAt) return;
  const [p] = await planRow(ctx, scope);
  if (
    !p ||
    p.grant_id !== grantId ||
    p.grant_status !== 'active' ||
    p.renewal_stopped_at ||
    Number(p.renewal_count) > 0 ||
    iso(p.trial_ends_at) !== endsAt ||
    Date.parse(endsAt) <= Date.now()
  )
    return;
  const mail = foundingTrialEndingEmail({
    business: p.business,
    offer: p.offer_name ?? 'founding',
    amount: money(Number(p.charge_cents)),
    ends: foundingLongDay(endsAt),
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/usage`,
    period: periodOf(p.billing ?? '') ?? 'year',
  });
  const to = await asWorker(ctx.db, scope, (tx) => managers(tx, scope.workspaceId));
  for (const m of to) await ctx.mailer.send({ to: m.email, ...mail });
};

export const foundingJobs: JobMap = {
  ...billingJobs,
  [FOUNDING_JOBS.checkout]: runFoundingCheckout,
  [FOUNDING_JOBS.expire]: expireFoundingReservations,
  [FOUNDING_JOBS.purchase]: reportFoundingPurchase,
  [FOUNDING_JOBS.renewals]: planFoundingRenewals,
  [FOUNDING_JOBS.renew]: renewFoundingSeat,
  [FOUNDING_JOBS.trialEnding]: sendTrialEnding,
};

/**
 * What a stored checkout event means, in our words. Only `paid` is the money in, or `no_payment_required` on a free
 * trial's page; a completed page for a payment still settling says `unpaid` and waits for `async_payment_succeeded`.
 */
export function checkoutOutcome(
  e: CheckoutEvent,
): { kind: 'paid' } | { kind: 'closed'; status: 'expired' | 'failed'; problem: string } | null {
  switch (e.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      // `no_payment_required` is a free trial's page, which only kept the card: the database turns the spot on only
      // for a trial's checkout, and only with a card (20261027014300).
      return e.paymentStatus === 'paid' || e.paymentStatus === 'no_payment_required'
        ? { kind: 'paid' }
        : null;
    case 'checkout.session.expired':
      return {
        kind: 'closed',
        status: 'expired',
        problem: 'The payment page ran out before it was paid. Nothing was taken.',
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

/**
 * A refund of a plan payment, made in Stripe's dashboard, or what became of it: kept, and the affiliate's share of it
 * taken back, or given back when the bank turns it down (founding.record_refund). Repeatable and out of order: a
 * refund only moves forward.
 */
export const onPlanRefundEvent: DeliveryProcessor = async (ctx) => {
  const p = (ctx.delivery.params ?? {}) as Record<string, unknown>;
  const body = typeof p['body'] === 'string' ? p['body'] : '';
  const event = ctx.payments.providers.stripe.platform.webhooks.refund(body);
  if (!event) return 'ignored';
  const scope = tenantOf({
    workspaceId: ctx.delivery.workspaceId,
    organizationId: ctx.delivery.organizationId,
  });
  const done = await executeCommand(
    ctx.db,
    foundingRecordRefund,
    {
      workspaceId: scope.workspaceId,
      paymentRef: event.paymentRef,
      refundRef: event.refundRef,
      amountCents: event.amountCents,
      status: event.status,
      refundedAt: event.refundedAt,
    },
    systemActor(scope),
    workerMeta(),
  );
  if (done.output.outcome === 'ignored') return 'ignored';
};

export const foundingProcessors: ProcessorMap = {
  [`stripe:${FOUNDING_CHECKOUT_KIND}`]: onFoundingCheckoutEvent,
  [`stripe:${PLAN_REFUND_KIND}`]: onPlanRefundEvent,
};
