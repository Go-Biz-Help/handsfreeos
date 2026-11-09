/**
 * Billing for a founding plan, the worker's half (20261027023600, the owner's call of 2026-11-08).
 *
 * - **Every charge goes through the cards in turn:** the default first, then each backup, oldest first. The first that
 *   goes through pays; each decline is written on its card. A renewal, a daily retry, a press of Try my cards now and
 *   a later payment day all charge this way (`chargePlanCards`).
 * - **A later payment day** is charged by a job of its own (`billing.pay_day`), and the date moves only once it's
 *   paid (`billing.record_pay_day`).
 * - **A removed card** is forgotten at Stripe too, by a job, so a slow answer retries on its own.
 * - **Cards kept before 20261027023600** have no brand or last four here; the hourly sweep asks Stripe for them.
 * - **More time answered** by staff: the owners and admins are emailed.
 */
import {
  billingRecordCard,
  billingRecordPayDay,
  executeCommand,
  formatUtcDate,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { planMoreTimeEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { PaymentError, PlatformUnsupportedError, type PaymentResult } from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const BILLING_JOBS = {
  /** A later payment day: charge the days it adds, then move the date. */
  payDay: 'billing.pay_day',
  /** A removed card: Stripe forgets it too. */
  forgetCard: 'billing.forget_card',
} as const;

/** Stripe won't charge less than 50¢. A charge that small is let off rather than refused. */
export const STRIPE_LEAST_CENTS = 50;

export type PlanCard = {
  /** Null for the card on the plan when it has no row in `app.plan_cards` (a plan from before them). */
  id: string | null;
  customer_ref: string;
  card_ref: string;
  is_default: boolean;
};

/** The plan's cards in the order they're charged: the default, then the backups, oldest first. */
export async function planCards(db: Db, scope: TenantScope): Promise<PlanCard[]> {
  const cards = await asWorker(db, scope, (tx) =>
    rows<PlanCard>(
      tx,
      sql`select id, customer_ref, card_ref, is_default from app.plan_cards
          where workspace_id = ${scope.workspaceId}::uuid
          order by is_default desc, created_at, id`,
    ),
  );
  if (cards.length) return cards;
  // A plan whose card was kept before cards had rows of their own.
  const [legacy] = await asWorker(db, scope, (tx) =>
    rows<{ customer_ref: string | null; card_ref: string | null }>(
      tx,
      sql`select stripe_customer_id as customer_ref, stripe_card_id as card_ref
          from app.workspace_plans where workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );
  return legacy?.card_ref && legacy.customer_ref
    ? [{ id: null, customer_ref: legacy.customer_ref, card_ref: legacy.card_ref, is_default: true }]
    : [];
}

export type CardTry = { cardId: string; ok: boolean; problem: string | null };

export type CardsCharged =
  | { status: 'succeeded'; result: PaymentResult; tries: CardTry[] }
  | { status: 'processing'; tries: CardTry[] }
  | { status: 'failed'; problem: string; tries: CardTry[] };

/** What a run of declines says: the one card's reason, or that every card was declined and the default's reason. */
export function declinedWords(problems: readonly string[]): string {
  if (problems.length === 0) return 'There was no card kept to charge it to.';
  if (problems.length === 1) return problems[0]!;
  const first = problems[0]!.replace(/\.$/, '');
  return `Your default card and ${problems.length - 1} backup ${problems.length === 2 ? 'card were' : 'cards were'} all declined. Your default card: ${first}.`;
}

/**
 * Charges `amountCents` to the cards in turn until one goes through. A decline moves on to the next card; a card
 * Stripe no longer knows is a decline too. A provider that didn't answer throws, so the job retries the whole run
 * with the same keys, and a card that already went through answers the same payment.
 */
export async function chargePlanCards(
  ctx: Pick<JobContext, 'payments'>,
  input: {
    cards: readonly PlanCard[];
    amountCents: number;
    description: string;
    metadata: Record<string, string>;
    /** The idempotency key for the card at `index`: stable for one try, different for the next. */
    keyFor: (index: number, card: PlanCard) => string;
  },
): Promise<CardsCharged> {
  const tries: CardTry[] = [];
  const problems: string[] = [];
  const platform = ctx.payments.providers.stripe.platform;
  for (const [index, card] of input.cards.entries()) {
    let result: PaymentResult;
    try {
      result = await platform.charge({
        amountCents: input.amountCents,
        method: 'card',
        sourceToken: card.card_ref,
        customerRef: card.customer_ref,
        description: input.description,
        metadata: { ...input.metadata, ...(card.id ? { plan_card_id: card.id } : {}) },
        idempotencyKey: input.keyFor(index, card),
      });
    } catch (e) {
      if (e instanceof PaymentError && e.permanent) {
        const problem = errorMessage(e);
        problems.push(problem);
        if (card.id) tries.push({ cardId: card.id, ok: false, problem: problem.slice(0, 500) });
        continue;
      }
      throw e;
    }
    if (result.status === 'succeeded') {
      if (card.id) tries.push({ cardId: card.id, ok: true, problem: null });
      return { status: 'succeeded', result, tries };
    }
    if (result.status === 'failed') {
      const problem = result.failureMessage ?? 'The card was declined.';
      problems.push(problem);
      if (card.id) tries.push({ cardId: card.id, ok: false, problem: problem.slice(0, 500) });
      continue;
    }
    // Still settling: the job looks again later, with the same keys, which ask after the same payment.
    return { status: 'processing', tries };
  }
  return { status: 'failed', problem: declinedWords(problems), tries };
}

/** "20261205": a day in a key. */
export const keyDay = (iso: string | Date): string =>
  new Date(iso).toISOString().slice(0, 10).replaceAll('-', '');

// ---------- a later payment day ----------

export const payDayJobKey = (workspaceId: string, to: string): string =>
  `${BILLING_JOBS.payDay}:${workspaceId}:${new Date(to).toISOString()}`;

/** Somebody picked a later payment day: its charge is a job, so it retries on its own. */
export const onPayDayChangeRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const payload = (ctx.event.payload ?? {}) as { to?: string };
  if (!workspaceId || !organizationId || !payload.to) return;
  await scheduleJob(ctx.tx, {
    kind: BILLING_JOBS.payDay,
    dedupeKey: payDayJobKey(workspaceId, payload.to),
    runAt: new Date(),
    payload: { to: payload.to },
    workspaceId,
    organizationId,
  });
};

export const chargePayDay: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const to = String(ctx.job.payload['to'] ?? '');
  if (!to) return;
  const [p] = await asWorker(ctx.db, scope, (tx) =>
    rows<{
      pay_day_change_to: Date | string | null;
      pay_day_change_cents: number | null;
      pay_day_change_asked_at: Date | string | null;
      business: string;
      offer_name: string | null;
      grant_id: string | null;
    }>(
      tx,
      sql`select p.pay_day_change_to, p.pay_day_change_cents, p.pay_day_change_asked_at, w.name as business,
            o.name as offer_name, p.grant_id
          from app.workspace_plans p
          join app.workspaces w on w.id = p.workspace_id
          left join platform.founding_grants g on g.id = p.grant_id
          left join platform.founding_offers o on o.id = g.offer_id
          where p.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );
  // Answered already, or another day was picked since.
  if (
    !p?.pay_day_change_to ||
    new Date(p.pay_day_change_to).toISOString() !== new Date(to).toISOString()
  )
    return;

  const record = (input: {
    outcome: 'paid' | 'failed';
    paymentRef?: string | null;
    paidCents?: number | null;
    problem?: string | null;
    cards?: CardTry[];
  }) =>
    executeCommand(
      ctx.db,
      billingRecordPayDay,
      {
        workspaceId: scope.workspaceId,
        to,
        outcome: input.outcome,
        paymentRef: input.paymentRef ?? null,
        paidCents: input.paidCents ?? null,
        problem: input.problem ?? null,
        cards: input.cards ?? [],
      },
      systemActor(scope),
      workerMeta(),
    );

  const cents = Number(p.pay_day_change_cents ?? 0);
  if (cents < STRIPE_LEAST_CENTS) return void (await record({ outcome: 'paid', paidCents: 0 }));

  const cards = await planCards(ctx.db, scope);
  const asked = Math.floor(
    new Date(p.pay_day_change_asked_at ?? Date.now()).getTime() / 1000,
  ).toString(36);
  try {
    const charged = await chargePlanCards(ctx, {
      cards,
      amountCents: cents,
      description: `HandsFreeOS — ${p.offer_name ?? 'founding spot'}: a new payment date for ${p.business}`,
      metadata: {
        workspace_id: scope.workspaceId,
        ...(p.grant_id ? { founding_grant_id: p.grant_id } : {}),
      },
      keyFor: (i) => `payday-${scope.workspaceId}-${keyDay(to)}-${asked}-${i}`,
    });
    if (charged.status === 'processing')
      return { rescheduleAt: new Date(Date.now() + 15 * 60_000) };
    if (charged.status === 'succeeded')
      await record({
        outcome: 'paid',
        paymentRef: charged.result.providerPaymentId,
        paidCents: charged.result.amountCents,
        cards: charged.tries,
      });
    else await record({ outcome: 'failed', problem: charged.problem, cards: charged.tries });
  } catch (e) {
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      await record({ outcome: 'failed', problem: errorMessage(e) });
      return;
    }
    throw e;
  }
};

// ---------- a removed card ----------

export const onPlanCardRemoved: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const payload = (ctx.event.payload ?? {}) as { customerRef?: string; cardRef?: string };
  if (!workspaceId || !organizationId || !payload.cardRef || !payload.customerRef) return;
  await scheduleJob(ctx.tx, {
    kind: BILLING_JOBS.forgetCard,
    dedupeKey: `${BILLING_JOBS.forgetCard}:${ctx.event.id}`,
    runAt: new Date(),
    payload: { customerRef: payload.customerRef, cardRef: payload.cardRef },
    workspaceId,
    organizationId,
  });
};

export const forgetPlanCard: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const cardRef = String(ctx.job.payload['cardRef'] ?? '');
  const customerRef = String(ctx.job.payload['customerRef'] ?? '');
  if (!cardRef || !customerRef) return;
  // Put back since (added again from Stripe's page): it stays.
  const [still] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from app.plan_cards
          where workspace_id = ${scope.workspaceId}::uuid and card_ref = ${cardRef}`,
    ),
  );
  if (Number(still?.n ?? 0) > 0) return;
  // The usage balance may charge the same card: it isn't forgotten while the balance still has it.
  const [wallet] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from app.usage_wallets
          where workspace_id = ${scope.workspaceId}::uuid and method_token = ${cardRef}`,
    ),
  );
  if (Number(wallet?.n ?? 0) > 0) return;
  try {
    await ctx.payments.providers.stripe.platform.forgetMethod({ customerRef, token: cardRef });
  } catch (e) {
    // Already gone at Stripe, or Stripe isn't set up here: nothing more to do.
    if (e instanceof PlatformUnsupportedError || (e instanceof PaymentError && e.permanent)) {
      ctx.log.warn(
        { err: errorMessage(e) },
        'a removed plan card could not be forgotten at Stripe',
      );
      return;
    }
    throw e;
  }
};

// ---------- cards kept before they had details ----------

/** Asks Stripe for the brand and last four of up to `limit` cards that have none. Run by the hourly renewals sweep. */
export async function describePlanCards(ctx: JobContext, limit = 50): Promise<number> {
  const platform = ctx.payments.providers.stripe.platform;
  if (!platform.supported) return 0;
  const todo = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      card_id: string;
      workspace_id: string;
      organization_id: string;
      customer_ref: string;
      card_ref: string;
    }>(tx, sql`select * from private.plan_cards_to_describe(${limit})`),
  );
  let described = 0;
  for (const c of todo) {
    const scope = { workspaceId: c.workspace_id, organizationId: c.organization_id };
    try {
      const m = await platform.describeMethod(c.card_ref);
      await executeCommand(
        ctx.db,
        billingRecordCard,
        {
          workspaceId: c.workspace_id,
          customerRef: c.customer_ref,
          cardRef: c.card_ref,
          brand: m.brand ? m.brand.charAt(0).toUpperCase() + m.brand.slice(1) : null,
          last4: m.last4 && /^[0-9]{4}$/.test(m.last4) ? m.last4 : null,
          expiryMonth: m.expiryMonth,
          expiryYear: m.expiryYear,
        },
        systemActor(scope),
        workerMeta(),
      );
      described += 1;
    } catch (e) {
      ctx.log.warn(
        { cardId: c.card_id, err: errorMessage(e) },
        'a plan card could not be described',
      );
    }
  }
  return described;
}

// ---------- more time, answered ----------

export const onMoreTimeAnswered: EventHandler = async (ctx) => {
  const payload = (ctx.event.payload ?? {}) as {
    workspaceId?: string;
    organizationId?: string;
    granted?: boolean;
    until?: string | null;
  };
  if (!payload.workspaceId || !payload.organizationId) return;
  const scope = { workspaceId: payload.workspaceId, organizationId: payload.organizationId };
  // A staff answer is HandsFreeOS's event, not the business's: the business is read in its own scope.
  const { name, to } = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${scope.workspaceId}::uuid`,
    );
    return { name: ws?.name ?? null, to: ws ? await managers(tx, scope.workspaceId) : [] };
  });
  if (!name) return;
  const mail = planMoreTimeEmail({
    business: name,
    granted: !!payload.granted,
    until: payload.until ? formatUtcDate(new Date(`${payload.until}T12:00:00Z`)) : null,
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/usage`,
  });
  for (const m of to) await ctx.mailer.send({ to: m.email, ...mail });
};

export const billingJobs: JobMap = {
  [BILLING_JOBS.payDay]: chargePayDay,
  [BILLING_JOBS.forgetCard]: forgetPlanCard,
};
