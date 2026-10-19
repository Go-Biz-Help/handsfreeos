/**
 * Keeping a wallet in funds (M16, step 6): the loop from "the balance ran low" to "the card was charged".
 *
 * It is the **refunds loop exactly** (`money/refunds.ts`), for the same reasons: an event decides whether to
 * start, a command writes the intent, a **job** makes the provider call with backoff, and a second command
 * records what came back. A provider call is never an outbox handler — it can be refused, throttled or simply
 * unanswered, and a job retries one thing rather than replaying every handler an event has.
 *
 * **A decline is a return value, not an exception.** `result.status === 'failed'` is the card saying no, which
 * is an answer the ladder acts on; only a provider that could not be reached throws and lets the job's own
 * backoff try again. Getting that backwards would retry a stolen card every few minutes until the bank blocked
 * us, or treat a network blip as a dead card and suspend a business that was fine.
 *
 * **Nothing here runs unless `WALLET_MODE=on`.** In shadow the ledger fills up and no card is ever touched,
 * which is the whole point of a shadow week. A top-up somebody pressed then is cancelled, not left waiting.
 */
import {
  afterDecline,
  executeCommand,
  nextEscalation,
  walletRecordRecharge,
  walletStartRecharge,
  walletSuspend,
  type Escalation,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { topUpRaisedEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { accountByExternalId } from '../payments/index';
import { PlatformUnsupportedError, type PaymentProviderName } from '../payments/provider';
import { scheduleJob } from '@hfos/core/server';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const RECHARGE_JOBS = {
  /** One business: call the provider for a top-up already written `pending`. */
  charge: 'wallet.recharge',
  /** Global, hourly: arms one sweep per business. */
  plan: 'wallet.plan',
  /** One business, hourly: the safety net behind every lost event and exhausted job. */
  sweep: 'wallet.sweep',
} as const;

export const RECHARGE_PLAN_KEY = 'wallet:plan';
export const rechargeJobKey = (rechargeId: string): string => `wallet-recharge:${rechargeId}`;
export const walletSweepKey = (workspaceId: string): string => `wallet-sweep:${workspaceId}`;

const HOUR_MS = 3_600_000;
const PLAN_CHUNK = 500;
const THIRTY_DAYS_MS = 30 * 86_400_000;

type WalletRow = {
  workspace_id: string;
  organization_id: string;
  balance_cents: number | string;
  floor_cents: number | string;
  topup_cents: number | string;
  auto_topup: boolean;
  method_token: string | null;
  customer_ref: string | null;
  provider: string | null;
  suspended_at: Date | null;
  paused_until: Date | null;
  escalation_step: number;
  recharges_in_window: number;
  window_started_at: Date | null;
  last_recharge_at: Date | null;
  pending_recharges: number;
  spent_30d_cents: number | string;
  stage: string;
  workspace_created_at: Date;
};

/** Everything deciding whether and how much to top up, in one read. */
async function walletFor(
  ctx: { db: Parameters<typeof asWorker>[0] },
  scope: TenantScope,
): Promise<WalletRow | null> {
  const [w] = await asWorker(ctx.db, scope, (tx) =>
    rows<WalletRow>(
      tx,
      sql`select w.workspace_id, w.organization_id, w.balance_cents, w.floor_cents, w.topup_cents,
            w.auto_topup, w.method_token, w.customer_ref, w.provider::text as provider,
            w.suspended_at, w.paused_until, w.escalation_step, w.recharges_in_window,
            w.window_started_at, w.last_recharge_at,
            (select count(*) from app.wallet_recharges r
              where r.workspace_id = w.workspace_id and r.status = 'pending') as pending_recharges,
            coalesce((select sum(abs(l.amount_cents)) from app.usage_ledger l
              where l.workspace_id = w.workspace_id and l.kind = 'spend'
                and l.occurred_at > now() - interval '30 days'), 0) as spent_30d_cents,
            ws.created_at as workspace_created_at, w.stage::text as stage
          from app.usage_wallets w join app.workspaces ws on ws.id = w.workspace_id
          where w.workspace_id = ${scope.workspaceId}`,
    ),
  );
  return w ?? null;
}

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

/** Whether this wallet should be topped up now, and for how much. */
export function decideRecharge(w: WalletRow, now: number): Escalation | null {
  // Its agency pays for what it uses: its card, if it has one, is never charged for it.
  if (w.stage === 'agency') return null;
  if (!w.auto_topup || !w.method_token || w.suspended_at) return null;
  if (w.pending_recharges > 0) return null;
  const paused = ms(w.paused_until);
  if (paused !== null && paused > now) return null;
  if (Number(w.balance_cents) > Number(w.floor_cents)) return null;
  return nextEscalation({
    state: {
      step: w.escalation_step,
      recharges: w.recharges_in_window,
      windowStartedAt: ms(w.window_started_at),
      lastRechargeAt: ms(w.last_recharge_at),
    },
    topupCents: Number(w.topup_cents),
    spent30dCents: Number(w.spent_30d_cents),
    workspaceCreatedAt: w.workspace_created_at.getTime(),
    now,
  });
}

/**
 * The balance crossed its floor. Deciding here rather than in the job keeps the job about one thing — calling
 * the provider — and means a wallet that should not be charged never gets a job at all.
 */
export const onWalletLow: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  if (ctx.wallet.mode !== 'on') return;
  const scope: TenantScope = { workspaceId, organizationId };
  await startRecharge(ctx, scope, Date.now());
};

/**
 * Somebody pressed Top up now (`wallet.top_up`): the charge is queued as a job, as a top-up the balance starts
 * itself is, for the same reason a refund is. Before this nothing picked the press up, so the card was never
 * charged, and the waiting top-up refused every one after it, automatic ones too (one may wait per business).
 * The balance's own top-ups are queued where they start, with the notice a raised amount needs, so only a press
 * is queued here.
 */
export const onTopUpPressed: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const rechargeId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !rechargeId) return;
  if ((ctx.event.payload as { manual?: unknown } | null)?.manual !== true) return;
  await scheduleJob(ctx.tx, {
    kind: RECHARGE_JOBS.charge,
    dedupeKey: rechargeJobKey(rechargeId),
    runAt: new Date(),
    payload: { rechargeId, warnFirst: false },
    workspaceId,
    organizationId,
  });
};

/** Writes the `pending` row and arms the job that will call the provider. Returns what it started, if anything. */
async function startRecharge(
  ctx: Parameters<EventHandler>[0] | Parameters<JobHandler>[0],
  scope: TenantScope,
  now: number,
): Promise<string | null> {
  const w = await walletFor(ctx, scope);
  if (!w) return null;
  const decided = decideRecharge(w, now);
  if (!decided) return null;

  // The key is written before the provider hears anything, and handed to it unchanged. Stripe refuses a reused
  // key with different parameters, which is exactly the protection wanted: each retry is a new row and key.
  const idempotencyKey = `wallet-topup:${scope.workspaceId}:${decided.windowStartedAt}:${decided.recharges}`;
  try {
    const { output } = await executeCommand(
      ctx.db,
      walletStartRecharge,
      {
        workspaceId: scope.workspaceId,
        amountCents: decided.amountCents,
        escalationStep: decided.step,
        requestedBy: null,
        idempotencyKey,
      },
      systemActor(scope),
      workerMeta(),
    );
    await asWorker(ctx.db, scope, (tx) =>
      scheduleJob(tx, {
        kind: RECHARGE_JOBS.charge,
        dedupeKey: rechargeJobKey(output.rechargeId),
        runAt: new Date(now),
        payload: { rechargeId: output.rechargeId, warnFirst: decided.warnFirst },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      }),
    );
    return output.rechargeId;
  } catch (e) {
    // One already going through, or no card any more: both are answers, not failures.
    ctx.log.info({ err: e, workspaceId: scope.workspaceId }, 'no top-up started');
    return null;
  }
}

type RechargeRow = {
  id: string;
  status: string;
  amount_cents: number | string;
  method_token: string | null;
  customer_ref: string | null;
  provider: string | null;
  declines_in_row: number;
  topup_cents: number | string;
  recharges_in_window: number;
};

/** One top-up, carried out. Safe to run again: a row that is no longer `pending` is left alone. */
export const runRecharge: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const rechargeId = String(ctx.job.payload['rechargeId'] ?? '');
  if (!rechargeId) return;

  const [row] = await asWorker(ctx.db, scope, (tx) =>
    rows<RechargeRow>(
      tx,
      sql`select r.id, r.status::text as status, r.amount_cents, w.method_token, w.customer_ref,
            w.provider::text as provider, w.declines_in_row, w.topup_cents, w.recharges_in_window
          from app.wallet_recharges r join app.usage_wallets w on w.workspace_id = r.workspace_id
          where r.workspace_id = ${scope.workspaceId} and r.id = ${rechargeId}::uuid`,
    ),
  );
  if (!row || row.status !== 'pending') return;

  // With the wallet not on, no card is charged. The top-up is cancelled rather than left waiting, because a
  // waiting one refuses every top-up after it.
  if (ctx.wallet.mode !== 'on') {
    await record(ctx, scope, rechargeId, {
      status: 'cancelled',
      failureMessage: 'Top-ups are switched off right now, so the card wasn’t charged.',
    });
    return;
  }

  if (!row.method_token || !row.provider) {
    await record(ctx, scope, rechargeId, {
      status: 'cancelled',
      failureMessage: 'There is no card on this wallet any more.',
    });
    return;
  }
  const provider = ctx.payments.providers[row.provider as PaymentProviderName];
  if (!provider?.platform.supported) {
    await record(ctx, scope, rechargeId, {
      status: 'cancelled',
      failureMessage: new PlatformUnsupportedError(row.provider as PaymentProviderName).message,
    });
    return;
  }

  const amountCents = Number(row.amount_cents);
  // Before the card, not after. The terms say a raised top-up comes with notice, so this has to go out even
  // when the charge then fails — and a mailer that is down must not stop a business being funded, so it is
  // logged and the charge goes ahead.
  if (ctx.job.payload['warnFirst'] === true)
    await tellThemItWentUp(
      ctx,
      scope,
      amountCents,
      Number(row.topup_cents),
      row.recharges_in_window,
    );

  const result = await provider.platform.charge({
    amountCents,
    method: 'card',
    sourceToken: row.method_token,
    idempotencyKey: `wallet-topup:${rechargeId}`,
    description: 'HandsFreeOS usage top-up',
    customerRef: row.customer_ref,
    metadata: { workspace_id: scope.workspaceId, recharge_id: rechargeId },
  });

  // `processing` is a bank transfer, which a wallet never uses; anything but succeeded is the card saying no.
  const succeeded = result.status === 'succeeded';
  await record(ctx, scope, rechargeId, {
    status: succeeded ? 'succeeded' : 'failed',
    provider: row.provider as PaymentProviderName,
    providerPaymentId: result.providerPaymentId,
    failureCode: result.failureCode,
    failureMessage: result.failureMessage,
  });
  if (succeeded) return;

  // The card said no. Where the ladder goes next is decided in core, so it can be read and tested on its own.
  const next = afterDecline({
    declinesInRow: row.declines_in_row,
    failureCode: result.failureCode,
    failureMessage: result.failureMessage,
    now: ctx.now,
  });
  if (next.kind === 'suspend') {
    await executeCommand(
      ctx.db,
      walletSuspend,
      { workspaceId: scope.workspaceId, reason: next.reason },
      systemActor(scope),
      workerMeta(),
    );
    return;
  }
  // Waiting is written on the wallet rather than left to the job's retries: the job is about one provider
  // call, and a card that said no is not a call that failed.
  await asWorker(ctx.db, scope, (tx) =>
    tx.execute(
      sql`update app.usage_wallets set paused_until = ${new Date(next.at).toISOString()}::timestamptz
          where workspace_id = ${scope.workspaceId}`,
    ),
  );
};

/** The notice the terms promise, to the people who can act on it. Never a reason not to charge. */
async function tellThemItWentUp(
  ctx: Parameters<JobHandler>[0],
  scope: TenantScope,
  amountCents: number,
  chosenCents: number,
  recharges: number,
): Promise<void> {
  try {
    const recipients = await asWorker(ctx.db, scope, async (tx) => {
      const [ws] = await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${scope.workspaceId}`,
      );
      return { business: ws?.name ?? 'your business', to: await managers(tx, scope.workspaceId) };
    });
    if (recipients.to.length === 0) return;
    const mail = topUpRaisedEmail({
      business: recipients.business,
      amountCents,
      chosenCents,
      recharges: Math.max(recharges, 2),
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/usage`,
    });
    for (const r of recipients.to) await ctx.mailer.send({ to: r.email, ...mail });
  } catch (e) {
    ctx.log.error(
      { err: e, workspaceId: scope.workspaceId },
      'could not send the raised top-up notice',
    );
  }
}

async function record(
  ctx: Parameters<JobHandler>[0],
  scope: TenantScope,
  rechargeId: string,
  input: {
    status: 'succeeded' | 'failed' | 'cancelled';
    provider?: PaymentProviderName | null;
    providerPaymentId?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  },
): Promise<void> {
  await executeCommand(
    ctx.db,
    walletRecordRecharge,
    {
      workspaceId: scope.workspaceId,
      rechargeId,
      status: input.status,
      provider: input.provider ?? null,
      providerPaymentId: input.providerPaymentId ?? null,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
    },
    systemActor(scope),
    workerMeta(),
  );
}

// ---------- the safety net ----------

/**
 * Hourly, for the whole server: every business's wallet sweep waiting, spread over the hour. The same shape as
 * `money.plan`, and there for the same reason — an event that was lost, or a job that exhausted its retries,
 * would otherwise leave a business unable to send a text with a working card on file and nobody looking.
 */
export const planWallets: JobHandler = async (ctx) => {
  if (ctx.wallet.mode !== 'on') return { rescheduleAt: new Date(ctx.now + HOUR_MS) };
  const from = new Date(ctx.now).toISOString();
  await asWorker(ctx.db, {}, async (tx) => {
    // Through a function: the worker's own policy on usage_wallets shows only the business in scope, and here
    // there is none, so reading the table found no wallet and no sweep was ever armed. It lists only the wallets
    // that could need a top-up: with a card, switched on, not suspended, and not paid for by the agency.
    const list = await rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.wallets_to_top_up()`,
    );
    for (let i = 0; i < list.length; i += PLAN_CHUNK)
      for (const b of list.slice(i, i + PLAN_CHUNK))
        await tx.execute(
          sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
              values (${b.organization_id}, ${b.workspace_id}, ${RECHARGE_JOBS.sweep},
                ${walletSweepKey(b.workspace_id)},
                ${from}::timestamptz
                  + (abs(hashtext(${b.workspace_id}::text)::bigint) % ${HOUR_MS}::bigint)
                    * interval '1 millisecond',
                '{}'::jsonb)
              on conflict do nothing`,
        );
  });
  return { rescheduleAt: new Date(ctx.now + HOUR_MS) };
};

/** One business, hourly: top up if it should have been topped up and wasn't. */
export const sweepWallet: JobHandler = async (ctx) => {
  if (ctx.wallet.mode !== 'on') return;
  const scope = tenantOf(ctx.scope);
  await startRecharge(ctx, scope, ctx.now);
};

export const RECHARGE_JOB_HANDLERS: JobMap = {
  [RECHARGE_JOBS.charge]: runRecharge,
  [RECHARGE_JOBS.plan]: planWallets,
  [RECHARGE_JOBS.sweep]: sweepWallet,
};

/** How long a wallet's 30-day spend window is, for anything else that needs to agree with the ceiling. */
export const SPEND_WINDOW_MS = THIRTY_DAYS_MS;

/** For the bootstrap, which arms the first plan. */
export const nextWalletPlanAt = (now: number): Date => new Date(now + HOUR_MS);

/** Whether the account behind a wallet's card still exists, for the sweep to skip a disconnected one. */
export const walletAccountStillThere = accountByExternalId;
