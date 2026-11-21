/**
 * Paying for paid add-ons, the worker's half (20261027028500, the owner's picks of 2026-11-17).
 *
 * - **The hourly sweep** (`addon_billing.sweep`): subscriptions whose stop came, or whose payment never went through
 *   after its last daily retry, end (`private.addon_end_lapsed`); every month due and every retry due gets a charge
 *   job (`private.addon_charges_due`); and every paid add-on still running that nobody pays for and HandsFreeOS
 *   doesn't give is turned off (`private.addon_unpaid_running`, then `addon_billing.turn_off`), its data kept.
 * - **A charge** goes through the plan's cards in turn, the default first (`chargePlanCards`), keyed on the business,
 *   the add-on, the month and the try, so a job that runs twice charges once. What it did is recorded by
 *   `addon_billing.record_charge`.
 * - **Straight away:** an add-on added with no trial left is charged at once; a card added while a payment is owed
 *   tries it again at once; a gift taken back is looked at by the sweep at once.
 * - **The emails:** a payment that failed, an add-on turned off, and a few days before a trial or a gift ends.
 */
import {
  ADDON_CATALOG,
  ADDON_ENDING_DAYS,
  addonBillingRecordCharge,
  addonBillingTurnOff,
  addonOffAfterFailure,
  addonPriceOf,
  executeCommand,
  findAddon,
  foundingLongDay,
  money,
  scheduleJob,
  type Catalog,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { addonChargeFailedEmail, addonEndingEmail, addonTurnedOffEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { PaymentError, PlatformUnsupportedError } from '../payments/provider';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { chargePlanCards, keyDay, planCards, STRIPE_LEAST_CENTS } from './billing';

export const ADDON_BILLING_JOBS = {
  /** Global, hourly: ends what lapsed, queues what's due, turns off what nobody pays for. */
  sweep: 'addon_billing.sweep',
  /** One add-on's month, or a retry of it, charged to the cards in turn. */
  charge: 'addon_billing.charge',
  /** The email a few days before a trial or a gift ends. */
  ending: 'addon_billing.ending',
} as const;

export const ADDON_BILLING_SWEEP_KEY = 'sweep:addon_billing';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const addonChargeJobKey = (
  workspaceId: string,
  addonId: string,
  dueAt: string,
  attempt: number,
): string =>
  `${ADDON_BILLING_JOBS.charge}:${workspaceId}:${addonId}:${new Date(dueAt).toISOString()}:${attempt}`;

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** The paid add-ons' ids: only the code knows what costs. */
export const paidAddonIds = (catalog: Catalog = ADDON_CATALOG): string[] =>
  catalog.filter((m) => addonPriceOf(m)).map((m) => m.id);

const addonsLink = (ctx: { webUrl: string }, workspaceId: string) =>
  `${ctx.webUrl}/app/w/${workspaceId}/add-ons`;
const billingLink = (ctx: { webUrl: string }, workspaceId: string) =>
  `${ctx.webUrl}/app/w/${workspaceId}/settings/usage`;

async function businessName(ctx: Pick<JobContext, 'db'>, scope: TenantScope): Promise<string> {
  const [w] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${scope.workspaceId}::uuid`,
    ),
  );
  return w?.name ?? 'your business';
}

async function mailManagers(
  ctx: Pick<JobContext, 'db' | 'mailer'>,
  scope: TenantScope,
  mail: { subject: string; text: string; html: string },
): Promise<void> {
  const to = await asWorker(ctx.db, scope, (tx) => managers(tx, scope.workspaceId));
  for (const m of to) await ctx.mailer.send({ to: m.email, ...mail });
}

// ---------- the sweep ----------

/** Turns off one paid add-on nobody pays for, through the kernel, which checks again. */
async function turnOff(
  ctx: Pick<JobContext, 'db' | 'log'>,
  row: { workspace_id: string; organization_id: string; addon_id: string; reason: string },
): Promise<boolean> {
  const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
  const reason = row.reason === 'stopped' || row.reason === 'unpaid' ? row.reason : 'gift';
  try {
    const out = await executeCommand(
      ctx.db,
      addonBillingTurnOff,
      { workspaceId: row.workspace_id, addonId: row.addon_id, reason },
      systemActor(scope),
      workerMeta(),
    );
    return out.output.turnedOff;
  } catch (e) {
    ctx.log.warn(
      { workspaceId: row.workspace_id, addonId: row.addon_id, err: errorMessage(e) },
      'an unpaid add-on could not be turned off',
    );
    return false;
  }
}

export const sweepAddonBilling: JobHandler = async (ctx) => {
  const [ended] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ n: number }>(tx, sql`select private.addon_end_lapsed() as n`),
  );
  if (Number(ended?.n ?? 0) > 0)
    ctx.log.info({ subscriptions: Number(ended?.n) }, 'add-on subscriptions that lapsed ended');

  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{
      workspace_id: string;
      organization_id: string;
      addon_id: string;
      due_at: string | Date;
      attempt: number;
    }>(tx, sql`select * from private.addon_charges_due(200)`),
  );
  for (const d of due) {
    const dueAt = iso(d.due_at)!;
    const attempt = Number(d.attempt ?? 0);
    await asWorker(
      ctx.db,
      { workspaceId: d.workspace_id, organizationId: d.organization_id },
      (tx) =>
        scheduleJob(tx, {
          kind: ADDON_BILLING_JOBS.charge,
          dedupeKey: addonChargeJobKey(d.workspace_id, d.addon_id, dueAt, attempt),
          runAt: new Date(),
          payload: { addonId: d.addon_id, dueAt, attempt },
          workspaceId: d.workspace_id,
          organizationId: d.organization_id,
        }),
    );
  }
  if (due.length) ctx.log.info({ due: due.length }, 'add-on charges and retries queued');

  const paid = paidAddonIds();
  if (paid.length) {
    const unpaid = await asWorker(ctx.db, {}, (tx) =>
      rows<{ workspace_id: string; organization_id: string; addon_id: string; reason: string }>(
        tx,
        sql`select * from private.addon_unpaid_running(${`{${paid.join(',')}}`}::text[], 100)`,
      ),
    );
    let off = 0;
    for (const u of unpaid) if (await turnOff(ctx, u)) off += 1;
    if (off) ctx.log.info({ addons: off }, 'paid add-ons nobody pays for turned off');
  }
  return { rescheduleAt: new Date(Date.now() + HOUR) };
};

// ---------- one charge ----------

/**
 * One add-on's month, or a daily retry of it, charged to the cards in turn. Nothing is charged when it's no longer the
 * charge that's due: paid already, turned off, stopped, given free, or another try came first.
 */
export const chargeAddon: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const addonId = String(ctx.job.payload['addonId'] ?? '');
  const dueAt = String(ctx.job.payload['dueAt'] ?? '');
  const attempt = Number(ctx.job.payload['attempt'] ?? 0) || 0;
  if (!addonId || !dueAt) return;
  const [s] = await asWorker(ctx.db, scope, (tx) =>
    rows<{
      status: string;
      price_cents: number;
      next_charge_at: string | Date | null;
      stop_at: string | Date | null;
      retry_count: number;
      gifted: boolean;
      running: boolean;
      business: string;
    }>(
      tx,
      sql`select s.status, s.price_cents, s.next_charge_at, s.stop_at, s.retry_count,
            private.addon_gifted(s.workspace_id, s.addon_id) as gifted,
            exists (select 1 from app.addon_installations i where i.workspace_id = s.workspace_id
                      and i.addon_id = s.addon_id and i.state in ('installing', 'enabled')) as running,
            w.name as business
          from app.addon_subscriptions s join app.workspaces w on w.id = s.workspace_id
          where s.workspace_id = ${scope.workspaceId}::uuid and s.addon_id = ${addonId}`,
    ),
  );
  const failed = s?.status === 'past_due';
  if (
    !s ||
    s.gifted ||
    !s.running ||
    s.stop_at ||
    s.status === 'ended' ||
    iso(s.next_charge_at) !== new Date(dueAt).toISOString() ||
    (attempt === 0) === failed ||
    (failed && attempt !== Number(s.retry_count) + 1)
  )
    return;
  // A charge only becomes due when its day has come.
  if (Date.parse(dueAt) > Date.now()) return { rescheduleAt: new Date(Date.parse(dueAt)) };

  const record = (input: {
    outcome: 'paid' | 'failed';
    paymentRef?: string | null;
    paidCents?: number | null;
    cardId?: string | null;
    problem?: string | null;
    cards?: { cardId: string; ok: boolean; problem: string | null }[];
  }) =>
    executeCommand(
      ctx.db,
      addonBillingRecordCharge,
      {
        workspaceId: scope.workspaceId,
        addonId,
        dueAt,
        attempt,
        outcome: input.outcome,
        paymentRef: input.paymentRef ?? null,
        paidCents: input.paidCents ?? null,
        cardId: input.cardId ?? null,
        problem: input.problem ?? null,
        cards: input.cards ?? [],
        random: Math.random(),
      },
      systemActor(scope),
      workerMeta(),
    );

  const amount = Number(s.price_cents);
  if (amount < STRIPE_LEAST_CENTS) return void (await record({ outcome: 'paid', paidCents: 0 }));
  const name = findAddon(ADDON_CATALOG, addonId)?.name ?? addonId;
  const cards = await planCards(ctx.db, scope);
  try {
    const charged = await chargePlanCards(ctx, {
      cards,
      amountCents: amount,
      description: `HandsFreeOS — ${name}: a month for ${s.business}`,
      metadata: { workspace_id: scope.workspaceId, addon_id: addonId, period_from: dueAt },
      // The business, the add-on, the month, the try and the card: however often this runs, each is charged once.
      keyFor: (i) => `addon-${scope.workspaceId}-${addonId}-${keyDay(dueAt)}-r${attempt}-${i}`,
    });
    if (charged.status === 'succeeded')
      await record({
        outcome: 'paid',
        paymentRef: charged.result.providerPaymentId,
        paidCents: charged.result.amountCents,
        cardId: charged.tries.find((t) => t.ok)?.cardId ?? null,
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

// ---------- straight away ----------

/** A paid add-on was added: charged at once with no trial left, and told before its trial ends. */
export const onAddonBillingStarted: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const p = (ctx.event.payload ?? {}) as {
    addonId?: string;
    chargeNow?: boolean;
    nextChargeAt?: string | null;
    trialEndsAt?: string | null;
    status?: string;
  };
  if (!workspaceId || !organizationId || !p.addonId) return;
  if (p.chargeNow && p.nextChargeAt)
    await scheduleJob(ctx.tx, {
      kind: ADDON_BILLING_JOBS.charge,
      dedupeKey: addonChargeJobKey(workspaceId, p.addonId, p.nextChargeAt, 0),
      runAt: new Date(),
      payload: { addonId: p.addonId, dueAt: p.nextChargeAt, attempt: 0 },
      workspaceId,
      organizationId,
    });
  if (p.status === 'trial' && p.trialEndsAt)
    await scheduleEnding(ctx.tx, {
      workspaceId,
      organizationId,
      addonId: p.addonId,
      kind: 'trial',
      endsAt: p.trialEndsAt,
    });
};

/** A card was added while an add-on's payment is owed: it's tried again at once, as the next retry. */
export const onCardAddedRetryAddons: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  const owed = await rows<{ addon_id: string; next_charge_at: string | Date; retry_count: number }>(
    ctx.tx,
    sql`select addon_id, next_charge_at, retry_count from app.addon_subscriptions
        where workspace_id = ${workspaceId}::uuid and status = 'past_due' and next_charge_at is not null`,
  );
  for (const o of owed) {
    const dueAt = iso(o.next_charge_at)!;
    const attempt = Number(o.retry_count) + 1;
    await scheduleJob(ctx.tx, {
      kind: ADDON_BILLING_JOBS.charge,
      dedupeKey: addonChargeJobKey(workspaceId, o.addon_id, dueAt, attempt),
      runAt: new Date(),
      payload: { addonId: o.addon_id, dueAt, attempt },
      workspaceId,
      organizationId,
    });
  }
};

/** A gift was taken back: the sweep looks at once, rather than within the hour. */
export const onGiftTakenBack: EventHandler = async (ctx) => {
  await scheduleJob(
    ctx.tx,
    {
      kind: ADDON_BILLING_JOBS.sweep,
      dedupeKey: ADDON_BILLING_SWEEP_KEY,
      runAt: new Date(),
      payload: {},
      workspaceId: null,
      organizationId: null,
    },
    { pullEarlier: true },
  );
};

/** A gift with an end date: its business is told a few days before. */
export const onGiftGiven: EventHandler = async (ctx) => {
  const p = (ctx.event.payload ?? {}) as {
    workspaceId?: string;
    organizationId?: string | null;
    addonId?: string;
    freeUntil?: string | null;
  };
  if (!p.workspaceId || !p.organizationId || !p.addonId || !p.freeUntil) return;
  await asWorker(ctx.db, { workspaceId: p.workspaceId, organizationId: p.organizationId }, (tx) =>
    scheduleEnding(tx, {
      workspaceId: p.workspaceId!,
      organizationId: p.organizationId!,
      addonId: p.addonId!,
      kind: 'gift',
      endsAt: p.freeUntil!,
    }),
  );
};

async function scheduleEnding(
  tx: Parameters<typeof scheduleJob>[0],
  e: {
    workspaceId: string;
    organizationId: string;
    addonId: string;
    kind: 'trial' | 'gift';
    endsAt: string;
  },
): Promise<void> {
  const endsAt = new Date(e.endsAt).toISOString();
  if (Date.parse(endsAt) <= Date.now()) return;
  await scheduleJob(tx, {
    kind: ADDON_BILLING_JOBS.ending,
    dedupeKey: `${ADDON_BILLING_JOBS.ending}:${e.workspaceId}:${e.addonId}:${e.kind}:${endsAt}`,
    runAt: new Date(Math.max(Date.now(), Date.parse(endsAt) - ADDON_ENDING_DAYS * DAY)),
    payload: { addonId: e.addonId, kind: e.kind, endsAt },
    workspaceId: e.workspaceId,
    organizationId: e.organizationId,
  });
}

// ---------- the emails ----------

/**
 * A few days before a trial or a gift ends: what happens then. Nothing is sent when it's no longer that trial or
 * gift, it's set to turn off already, or the add-on isn't on.
 */
export const sendAddonEnding: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const addonId = String(ctx.job.payload['addonId'] ?? '');
  const kind = ctx.job.payload['kind'] === 'gift' ? 'gift' : 'trial';
  const endsAt = String(ctx.job.payload['endsAt'] ?? '');
  const price = addonPriceOf(findAddon(ADDON_CATALOG, addonId));
  if (!addonId || !endsAt || !price || Date.parse(endsAt) <= Date.now()) return;
  const [s] = await asWorker(ctx.db, scope, (tx) =>
    rows<{
      running: boolean;
      free_until: string | Date | null;
      status: string | null;
      trial_ends_at: string | Date | null;
      next_charge_at: string | Date | null;
      stop_at: string | Date | null;
      business: string;
    }>(
      tx,
      sql`select exists (select 1 from app.addon_installations i where i.workspace_id = w.id
                           and i.addon_id = ${addonId} and i.state = 'enabled') as running,
            (select g.free_until from platform.addon_grants g
              where g.workspace_id = w.id and g.addon_id = ${addonId}) as free_until,
            s.status, s.trial_ends_at, s.next_charge_at, s.stop_at, w.name as business
          from app.workspaces w
          left join app.addon_subscriptions s on s.workspace_id = w.id and s.addon_id = ${addonId}
          where w.id = ${scope.workspaceId}::uuid`,
    ),
  );
  if (!s?.running) return;
  let keeps = false;
  if (kind === 'trial') {
    if (
      s.status !== 'trial' ||
      s.stop_at ||
      iso(s.trial_ends_at) !== new Date(endsAt).toISOString()
    )
      return;
  } else {
    if (iso(s.free_until) !== new Date(endsAt).toISOString()) return;
    keeps = s.status === 'active' && !s.stop_at && s.next_charge_at !== null;
  }
  const name = findAddon(ADDON_CATALOG, addonId)?.name ?? addonId;
  await mailManagers(
    ctx,
    scope,
    addonEndingEmail({
      business: s.business,
      addon: name,
      kind,
      ends: foundingLongDay(endsAt),
      price: money(price.monthlyCents),
      keeps,
      link: addonsLink(ctx, scope.workspaceId),
    }),
  );
};

/** The owners and admins hear that a payment failed, or that an add-on turned off on its own. */
export const onAddonBillingNews: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = (ctx.event.payload ?? {}) as {
    addonId?: string;
    name?: string;
    problem?: string;
    amountCents?: number;
    failedAt?: string;
    reason?: 'stopped' | 'unpaid' | 'gift';
  };
  if (!scope.workspaceId || !p.addonId) return;
  const name = p.name ?? findAddon(ADDON_CATALOG, p.addonId)?.name ?? p.addonId;
  const business = await businessName(ctx, scope);
  const price = addonPriceOf(findAddon(ADDON_CATALOG, p.addonId));
  const mail =
    ctx.event.eventType === 'addon_billing.charge_failed'
      ? addonChargeFailedEmail({
          business,
          addon: name,
          amount: money(Number(p.amountCents ?? price?.monthlyCents ?? 0)),
          reason: p.problem ?? 'The card was declined.',
          offOn: foundingLongDay(addonOffAfterFailure(p.failedAt ?? new Date().toISOString())),
          link: billingLink(ctx, scope.workspaceId),
        })
      : addonTurnedOffEmail({
          business,
          addon: name,
          reason: p.reason ?? 'gift',
          price: price ? money(price.monthlyCents) : null,
          link: addonsLink(ctx, scope.workspaceId),
        });
  await mailManagers(ctx, scope, mail);
};

export const addonBillingJobs: JobMap = {
  [ADDON_BILLING_JOBS.sweep]: sweepAddonBilling,
  [ADDON_BILLING_JOBS.charge]: chargeAddon,
  [ADDON_BILLING_JOBS.ending]: sendAddonEnding,
};

/** A business's own events: its add-on started paying, a charge was refused or it turned off, a card was added. */
export const addonBillingHandlers = {
  'addon_billing.started': onAddonBillingStarted,
  'addon_billing.charge_failed': onAddonBillingNews,
  'addon_billing.turned_off': onAddonBillingNews,
  'billing.card_added': onCardAddedRetryAddons,
} as const;

/** Staff's, which belong to no business: a gift given or taken back. */
export const addonGiftHandlers = {
  'addon_grant.given': [onGiftGiven],
  'addon_grant.taken_back': [onGiftTakenBack],
} as const;
