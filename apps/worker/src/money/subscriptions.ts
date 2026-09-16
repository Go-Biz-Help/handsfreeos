/**
 * A maintenance plan and the provider that actually bills it (M9, step 13).
 *
 * The cycles run at Stripe Billing and Square Subscriptions, because that is where the retries, the card
 * updater and the SCA re-authentication live. What is here is the piece in the middle: a person starts, pauses,
 * resumes or cancels a plan, and the provider is made to match.
 *
 * It is written as a **reconcile**, not as four commands. One job per plan, armed by every one of those events,
 * reads the plan as it stands right now and makes the provider agree with it. Two plans' worth of events
 * arriving out of order, a retry, a pause pressed while the set-up call was still in flight — all of them end
 * in the same place, because the job never replays an instruction, it only closes a gap.
 *
 * Two things this has to say out loud, because they are the customer's experience:
 * - **Square cancels at the end of the paid period.** Its API has no other kind of cancel, so a Square plan
 *   keeps billing once more after the button is pressed. The plan page says so before it is pressed.
 * - **A plan on a disconnected account keeps billing at the provider.** Nothing here can stop it: the tokens
 *   are gone on purpose. `subscriptionCycleJob` marks it `unmanaged` and the page says what to do.
 *
 * `recordPlanCycle` is the other half: a cycle the provider billed becomes an invoice and a payment here, so a
 * plan's money sits in the same ledger as every other dollar the business takes.
 */
import {
  executeCommand,
  invoiceCreate,
  invoiceRecordPayment,
  invoiceSend,
  money,
  scheduleJob,
  subscriptionRecordCycle,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { accountByExternalId } from '../payments/index';
import {
  isPaymentProvider,
  PaymentAuthError,
  PaymentError,
  type PaymentAccount,
  type PaymentProviderName,
  type SubscriptionResult,
} from '../payments/provider';
import { clientIdFor } from '../booking/deliver';
import { systemActor, workerMeta, type TenantScope, type WorkerServices } from '../services';
import { deliver, messageWorld } from './jobs';
import { planUrlFor } from './links';
import { planCardEmail, planCardText } from './messages';

/** Two job kinds: "make the provider match this plan", and "send the customer their link". */
export const PLAN_JOBS = {
  sync: 'subscription.sync',
  cardMessage: 'subscription.card_message',
} as const;

export const planSyncKey = (subscriptionId: string): string => `money-plan-sync:${subscriptionId}`;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A plan's local date, as the provider's instants come back. */
const asDate = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/** Our three intervals over the provider's two: a quarter is three months. */
function providerInterval(
  interval: string,
  count: number,
): { interval: 'month' | 'year'; count: number } {
  if (interval === 'year') return { interval: 'year', count };
  if (interval === 'quarter') return { interval: 'month', count: count * 3 };
  return { interval: 'month', count };
}

interface PlanRow extends Record<string, unknown> {
  id: string;
  status: string;
  plan_name: string;
  price_cents: number;
  interval: string;
  interval_count: number;
  taxable: boolean;
  includes: unknown;
  person_id: string;
  lead_id: string | null;
  connection_id: string | null;
  provider: string | null;
  external_subscription_id: string | null;
  customer_ref: string | null;
  method_token: string | null;
  card_requested_at: Date | string | null;
  started_on: string | null;
  current_period_start: string | null;
  connection_provider: string | null;
  connection_status: string | null;
  external_account_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
}

const PLAN_SELECT = sql`select s.id, s.status::text as status, s.plan_name,
      s.price_cents::float8 as price_cents, s.interval::text as interval, s.interval_count, s.taxable,
      s.includes, s.person_id, s.lead_id, s.connection_id, s.provider::text as provider, s.external_subscription_id,
      s.customer_ref, s.method_token, s.card_requested_at,
      s.started_on::text as started_on, s.current_period_start::text as current_period_start,
      pc.provider::text as connection_provider, pc.status::text as connection_status,
      pc.external_account_id,
      nullif(btrim(concat_ws(' ', pe.first_name, pe.last_name)), '') as customer_name,
      pe.email::text as customer_email, pe.phone as customer_phone
    from app.subscriptions s
    left join app.payment_connections pc on pc.id = s.connection_id
    left join app.people pe on pe.id = s.person_id`;

async function planById(
  db: Db,
  scope: TenantScope,
  subscriptionId: string,
): Promise<PlanRow | null> {
  const [row] = await asWorker(db, scope, (tx) =>
    rows<PlanRow>(
      tx,
      sql`${PLAN_SELECT} where s.workspace_id = ${scope.workspaceId} and s.id = ${subscriptionId}::uuid`,
    ),
  );
  return row ?? null;
}

/**
 * A plan changed here: the provider is made to match, in its own job. A provider call can be refused,
 * throttled or simply unanswered, and a job retries one thing with backoff rather than replaying an event's
 * every handler.
 */
export const onPlanChanged: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const subscriptionId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !subscriptionId) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: PLAN_JOBS.sync,
      dedupeKey: planSyncKey(subscriptionId),
      runAt: new Date(),
      payload: { subscriptionId, correlationId: ctx.event.correlationId },
      workspaceId,
      organizationId,
    },
    { pullEarlier: true },
  );
};

/** The account a plan bills through, with its sealed token opened. Null means "nothing connected for it". */
async function accountFor(
  ctx: { db: Db; sealer: WorkerServices['sealer'] },
  scope: TenantScope,
  plan: PlanRow,
): Promise<{ provider: PaymentProviderName; account: PaymentAccount } | null> {
  const name = plan.provider ?? plan.connection_provider;
  if (!name || !isPaymentProvider(name) || !plan.external_account_id) return null;
  const found = await accountByExternalId(
    ctx.db,
    scope,
    { provider: name, externalAccountId: plan.external_account_id },
    ctx.sealer,
  );
  return found ? { provider: name, account: found.account } : null;
}

/** What the provider said, written down here. A plan we have already cancelled is never re-opened by it. */
async function record(
  db: Db,
  scope: TenantScope,
  subscriptionId: string,
  state: SubscriptionResult,
  outcome: 'activated' | 'ended',
  provider: PaymentProviderName,
): Promise<void> {
  await executeCommand(
    db,
    subscriptionRecordCycle,
    {
      workspaceId: scope.workspaceId,
      subscriptionId,
      outcome,
      provider,
      externalSubscriptionId: state.providerSubscriptionId,
      currentPeriodStart: asDate(state.currentPeriodStart),
      currentPeriodEnd: asDate(state.currentPeriodEnd),
      nextBillingOn: outcome === 'ended' ? null : asDate(state.currentPeriodEnd),
      endedOn: outcome === 'ended' ? asDate(state.cancelAt ?? state.currentPeriodEnd) : null,
    },
    systemActor(scope),
    workerMeta(),
  );
}

/**
 * One plan, made to match at the provider. Safe to run again and in any order, because it only ever reads the
 * plan as it is now and closes the gap:
 *
 * | here | there | what happens |
 * |---|---|---|
 * | draft or active, no provider plan yet | nothing | it is created, and the plan goes live |
 * | paused | running | paused there |
 * | active or past due | paused | resumed there |
 * | cancelled | running | cancelled there (Square: at the end of the period it has been paid for) |
 * | unmanaged | anything | left alone — the tokens are gone, and only reconnecting brings it back |
 */
export const runPlanSync: JobHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  const scope: TenantScope = { workspaceId, organizationId };
  const subscriptionId = String(ctx.job.payload['subscriptionId'] ?? '');
  if (!subscriptionId) return;
  const plan = await planById(ctx.db, scope, subscriptionId);
  // Gone, or nobody's to drive: an unmanaged plan is still billing at the provider with tokens we destroyed.
  if (!plan || plan.status === 'unmanaged') return;

  const found = await accountFor(ctx, scope, plan);
  if (!found) {
    // A plan with nowhere to bill stays a draft and says so on its page; it is not an error to retry forever.
    if (!plan.external_subscription_id) {
      ctx.log.info(
        { subscriptionId, connectionId: plan.connection_id },
        'a plan has no connected account to bill through yet',
      );
      return;
    }
    ctx.log.warn(
      { subscriptionId, accountRef: plan.external_account_id },
      'a plan could not be matched at the provider: that account is not connected',
    );
    return;
  }
  const { provider, account } = found;
  const api = ctx.payments.providers[provider];
  if (!api?.configured) return;
  const later = (ms: number) => ({ rescheduleAt: new Date(ctx.now + ms) });

  try {
    // ---- not at the provider yet: make it ----
    if (!plan.external_subscription_id) {
      if (plan.status === 'cancelled') return;
      if (plan.connection_status !== 'active') return later(HOUR);
      /**
       * **A plan is never created before there is a card to bill.** Neither provider will bill a customer they
       * have no card for, and creating it anyway would either fail there or quietly bill a card left over from
       * an old job. It waits on the customer's own page instead, and `subscription.card_saved` brings it here.
       */
      if (!plan.method_token || !plan.customer_ref) {
        ctx.log.info({ subscriptionId }, 'a plan is waiting on the customer to put a card on it');
        return;
      }
      const every = providerInterval(plan.interval, plan.interval_count);
      const state = await api.subscriptions.create(account, {
        customerRef: plan.customer_ref,
        // The card the customer put on their own page: the provider's token for it, never a number.
        methodToken: plan.method_token,
        amountCents: Math.round(Number(plan.price_cents)),
        interval: every.interval,
        intervalCount: every.count,
        name: plan.plan_name,
        startAt: plan.started_on ? `${plan.started_on}T00:00:00.000Z` : null,
        idempotencyKey: `plan-${plan.id}`,
        metadata: { subscriptionId: plan.id, workspaceId: scope.workspaceId },
      });
      await record(ctx.db, scope, plan.id, state, 'activated', provider);
      // It exists now; anything else the plan asks for (a pause pressed while this ran) is the next pass.
      return later(0);
    }

    const providerPlanId = plan.external_subscription_id;
    const state = await api.subscriptions.get(account, { providerSubscriptionId: providerPlanId });

    // ---- cancelled here: end it there ----
    if (plan.status === 'cancelled') {
      if (state.status === 'cancelled') return;
      // Square has no immediate cancel: its API ends a plan at the end of the period already paid for, so
      // `atPeriodEnd: false` is honoured as "at period end" there. The plan page says so before the press.
      await api.subscriptions.cancel(account, {
        providerSubscriptionId: providerPlanId,
        atPeriodEnd: false,
      });
      return;
    }

    // ---- paused here: pause it there ----
    if (plan.status === 'paused') {
      if (state.status === 'paused') return;
      const paused = await api.subscriptions.pause(account, {
        providerSubscriptionId: providerPlanId,
        resumeAt: null,
      });
      ctx.log.debug({ subscriptionId, providerStatus: paused.providerStatus }, 'a plan was paused');
      return;
    }

    // ---- billing here: it should be billing there ----
    if (state.status === 'paused') {
      const live = await api.subscriptions.resume(account, {
        providerSubscriptionId: providerPlanId,
      });
      await record(ctx.db, scope, plan.id, live, 'activated', provider);
      return;
    }
    if (state.status === 'cancelled') {
      await record(ctx.db, scope, plan.id, state, 'ended', provider);
      return;
    }
    // Already agreeing. The cycle job (money/jobs.ts) is what keeps watching it from here.
    return;
  } catch (e) {
    if (e instanceof PaymentAuthError) {
      // The sign-in needs renewing, and payments/refresh.ts owns that. Try again once it has had its go.
      ctx.log.warn({ subscriptionId, provider }, 'a plan could not be matched: reconnect needed');
      return later(6 * HOUR);
    }
    if (e instanceof PaymentError && e.permanent) {
      ctx.log.warn(
        { subscriptionId, provider, err: errorMessage(e) },
        'the provider refused a change to a plan',
      );
      return later(DAY);
    }
    throw e;
  }
};

// ---------------------------------------------------------------------------
// Asking the customer for a card
// ---------------------------------------------------------------------------

/**
 * The link that starts a plan, sent to the customer the business asked us to send it to.
 *
 * It goes out on the same ladder every other money message uses (money/jobs.ts): a text unless they have said
 * STOP, otherwise an email, held until quiet hours are over, with one client id per plan and reason so a retry
 * can never send it twice. The business can also ask for the link and send it themselves — that is a request
 * with no channels, and this job then does nothing but leave the plan waiting.
 */
export const runPlanCardMessage: JobHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  const scope: TenantScope = { workspaceId, organizationId };
  const subscriptionId = String(ctx.job.payload['subscriptionId'] ?? '');
  const channels = Array.isArray(ctx.job.payload['channels'])
    ? (ctx.job.payload['channels'] as string[])
    : [];
  if (!subscriptionId || channels.length === 0) return;
  const plan = await planById(ctx.db, scope, subscriptionId);
  // Cancelled while the message waited, or a card arrived first: neither is worth a message.
  if (!plan || plan.status === 'cancelled') return;

  const found = await asWorker(ctx.db, scope, async (tx) => {
    const world = await messageWorld(tx, ctx, scope, plan.person_id, ctx.now);
    if (!world) return null;
    return { world, url: await planUrlFor(tx, ctx.moneyLinks, subscriptionId) };
  });
  if (!found?.url) return;
  const { world, url } = found;
  const every = providerInterval(plan.interval, plan.interval_count);
  const content = {
    business: world.business,
    firstName: world.person.first_name.trim(),
    planName: plan.plan_name,
    priceLabel: `${money(Math.round(Number(plan.price_cents)))} ${
      every.interval === 'year'
        ? 'a year'
        : every.count === 1
          ? 'a month'
          : `every ${every.count} months`
    }`,
    includes: Array.isArray(plan.includes)
      ? plan.includes.filter((x): x is string => typeof x === 'string')
      : [],
    url,
    // Changing a card that already works reads differently from a plan that cannot bill at all.
    replacing: !!plan.method_token,
    first: world.reach.firstText,
  };
  const out = await deliver(
    ctx,
    scope,
    world,
    { text: planCardText(content), email: planCardEmail(content) },
    clientIdFor('money-plan-card', subscriptionId, plan.method_token ? 'change' : 'start'),
    workerMeta(null, ctx.job.id),
  );
  if (out.status === 'held') return { rescheduleAt: new Date(out.until) };
  return;
};

/** A person asked the customer for a card: the message is a job, so quiet hours and retries are the usual ones. */
export const onPlanCardRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const subscriptionId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !subscriptionId) return;
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const channels = Array.isArray(payload['channels']) ? payload['channels'] : [];
  if (!channels.length) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: PLAN_JOBS.cardMessage,
      // One per ask: asking again really does send again, which is the whole point of asking again.
      dedupeKey: `${PLAN_JOBS.cardMessage}:${subscriptionId}:${ctx.event.id}`,
      runAt: new Date(),
      payload: { subscriptionId, channels, correlationId: ctx.event.correlationId },
      workspaceId,
      organizationId,
    },
    { pullEarlier: true },
  );
};

export const planJobs: JobMap = {
  [PLAN_JOBS.sync]: runPlanSync,
  [PLAN_JOBS.cardMessage]: runPlanCardMessage,
};

// ---------------------------------------------------------------------------
// A cycle the provider billed, as an invoice and a payment here
// ---------------------------------------------------------------------------

export interface CycleFacts {
  readonly providerPaymentId: string | null;
  readonly amountPaidCents: number | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
}

/**
 * The invoice and the payment for one cycle the provider billed, so a plan's money lands in the same ledger as
 * everything else the business takes — the customer's receipt, the day's collected figure and next year's
 * accounts all read the same rows.
 *
 * It is raised, numbered and paid in one go and **nothing is sent to ask for it**: the money has already been
 * taken. `invoice.paid` still fires, so the customer gets their receipt from the same place every other one
 * comes from.
 *
 * Safe to run twice: a cycle that already has its invoice here is left alone, and the payment is written under
 * the provider's own payment id, which `invoice.record_payment` finds rather than duplicating.
 */
export async function recordPlanCycle(
  db: Db,
  scope: TenantScope,
  subscriptionId: string,
  facts: CycleFacts,
): Promise<string | null> {
  const plan = await planById(db, scope, subscriptionId);
  if (!plan) return null;
  const amountCents = facts.amountPaidCents ?? Math.round(Number(plan.price_cents));
  if (amountCents <= 0) return null;

  /**
   * One invoice per cycle. A provider retries a webhook for days and replays happen, so the cycle is found by
   * **the provider's own payment id** — the one thing that is the same on every delivery of the same charge.
   * Without one (a provider that named no payment), an invoice raised for this plan in the last hour is taken
   * as the same cycle rather than raising a second.
   */
  const period = facts.currentPeriodStart ?? new Date().toISOString();
  const already = await asWorker(db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`select i.id from app.invoices i
          where i.workspace_id = ${scope.workspaceId} and i.subscription_id = ${subscriptionId}::uuid
            and ${
              facts.providerPaymentId
                ? sql`exists (select 1 from app.payments p
                       where p.invoice_id = i.id
                         and p.provider_payment_id = ${facts.providerPaymentId})`
                : sql`i.created_at >= now() - interval '1 hour'`
            }
          order by i.created_at desc
          limit 1`,
    ),
  );
  const existing = already[0]?.id ?? null;

  const invoiceId =
    existing ??
    (
      await executeCommand(
        db,
        invoiceCreate,
        {
          workspaceId: scope.workspaceId,
          personId: plan.person_id,
          leadId: plan.lead_id,
          subscriptionId,
          connectionId: plan.connection_id,
          purpose: 'subscription' as const,
          origin: 'subscription' as const,
          title: plan.plan_name,
          lines: [
            {
              productId: null,
              name: plan.plan_name,
              description: cycleWording(facts),
              quantity: 1,
              unitLabel: 'each',
              unitPriceCents: amountCents,
              taxable: plan.taxable,
              discountCents: 0,
            },
          ],
        },
        systemActor(scope),
        workerMeta(),
      )
    ).output.invoiceId;

  // Numbering it is what makes it a document rather than a draft. Nobody is told: it is already paid.
  const [state] = await asWorker(db, scope, (tx) =>
    rows<{ status: string }>(
      tx,
      sql`select status::text as status from app.invoices
          where workspace_id = ${scope.workspaceId} and id = ${invoiceId}::uuid`,
    ),
  );
  if (state?.status === 'draft')
    await executeCommand(
      db,
      invoiceSend,
      { workspaceId: scope.workspaceId, invoiceId, channels: [], message: null },
      systemActor(scope),
      workerMeta(),
    );

  await executeCommand(
    db,
    invoiceRecordPayment,
    {
      workspaceId: scope.workspaceId,
      invoiceId,
      amountCents,
      method: 'card' as const,
      provider: (plan.provider ?? plan.connection_provider) as never,
      connectionId: plan.connection_id,
      providerPaymentId: facts.providerPaymentId,
      status: 'succeeded' as const,
      receivedAt: new Date().toISOString(),
      idempotencyKey: `plan-cycle-${subscriptionId}-${facts.providerPaymentId ?? period}`,
    },
    systemActor(scope),
    workerMeta(),
  );
  return invoiceId;
}

/** "For 22 Sep to 22 Oct", when the provider said which period it billed. */
function cycleWording(facts: CycleFacts): string | null {
  const from = asDate(facts.currentPeriodStart);
  const to = asDate(facts.currentPeriodEnd);
  return from && to ? `For ${from} to ${to}` : null;
}
