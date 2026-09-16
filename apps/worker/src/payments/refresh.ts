/**
 * Keeping a connected account signed in, and telling the provider when a business disconnects one.
 *
 * **Square's token expires after 30 days.** That makes a refresh job mandatory, and it makes a refresh job that
 * quietly dies the worst kind of bug in this milestone: a business's payments would stop a month later with
 * nothing on screen to say why. So there are two:
 * - `payments.refresh`, one per connection, weekly (and at once when a token has under three days left). It
 *   renews the token, seals it again, and backs off the way the calendar's refresh does, asking for a reconnect
 *   on `invalid_grant`.
 * - `payments.plan`, one for the whole server, hourly. It re-arms any active connection whose refresh time has
 *   passed — including one whose own job exhausted its retries and is sitting there `failed`, which the
 *   per-connection dedupe key would otherwise never replace.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { executeCommand, paymentConnectionFail, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { paymentConnections } from '@hfos/db/schema';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import {
  accountFor,
  openPaymentTokens,
  paymentConnectionUsable,
  type PaymentConnectionRow,
} from './index';
import { PaymentAuthError, PaymentError, PAYMENT_NAME, type PaymentProviderName } from './provider';

export const PAYMENT_JOBS = {
  refresh: 'payments.refresh',
  plan: 'payments.plan',
} as const;

export const PAYMENT_PLAN_KEY = 'payments:plan';
export const refreshJobKey = (connectionId: string): string =>
  `${PAYMENT_JOBS.refresh}:${connectionId}`;

const HOUR = 60 * 60_000;
/** Failed refreshes in a row before the account shows as not working (it keeps trying). */
const FAILURES_BEFORE_ERROR = 5;
const MAX_WAIT_MS = 6 * HOUR;
/** Signed in and in use, maybe failing lately; not waiting on a reconnect. */
const USABLE = ['active', 'error'] as const;

/** When a connection should next be looked at: its weekly slot, or sooner if the token lapses before that. */
export function nextRefreshAt(
  expiresAt: string | null,
  everyMs: number,
  aheadMs: number,
  now = Date.now(),
): Date | null {
  // Stripe's access never lapses (our own key plus an account header), so it needs no refresh at all.
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  const weekly = now + everyMs;
  if (!Number.isFinite(expiry)) return new Date(weekly);
  return new Date(Math.max(now, Math.min(weekly, expiry - aheadMs)));
}

/** Brings a connection's refresh forward (a new connection, a renewal that worked, the hourly re-arm). */
export async function schedulePaymentRefresh(
  tx: Tx,
  scope: TenantScope,
  connectionId: string,
  at: Date,
): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: PAYMENT_JOBS.refresh,
      dedupeKey: refreshJobKey(connectionId),
      runAt: at,
      payload: { connectionId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

async function failConnection(
  s: WorkerServices,
  scope: TenantScope,
  c: PaymentConnectionRow,
  reason: 'reauth_required' | 'error',
  message: string,
): Promise<void> {
  await executeCommand(
    s.db,
    paymentConnectionFail,
    {
      workspaceId: scope.workspaceId,
      connectionId: c.id,
      reason,
      message: message.slice(0, 2000),
    },
    systemActor(scope),
    workerMeta(),
  );
}

const lostAccess = (c: PaymentConnectionRow) =>
  `${PAYMENT_NAME[c.provider as PaymentProviderName] ?? c.provider} stopped accepting HandsFreeOS’s sign-in for ${
    c.displayName ?? c.label ?? 'this account'
  }.`;

/**
 * One connection's sign-in, kept alive. Square's token is renewed and sealed again; Stripe's needs nothing, so
 * the job clears its schedule and stops.
 */
export const paymentsRefresh: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const connectionId = String(ctx.job.payload['connectionId'] ?? '');
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx.select().from(paymentConnections).where(eq(paymentConnections.id, connectionId)),
  );
  // Disconnected, waiting on a reconnect, or never signed in: nothing until that changes.
  if (!c || !paymentConnectionUsable(c)) return;
  const provider = ctx.payments.providers[c.provider as PaymentProviderName];
  if (!provider) return;
  const { refreshEveryMs, refreshAheadMs } = ctx.payments;
  const current = openPaymentTokens(ctx.sealer, c.tokenEnc!);
  if (!current.expiresAt) {
    // Stripe: there is nothing to renew, so stop asking.
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(paymentConnections)
        .set({ nextRefreshAt: null })
        .where(eq(paymentConnections.id, c.id)),
    );
    return;
  }
  const dueAt = Date.parse(current.expiresAt) - refreshAheadMs;
  // Not close enough to lapse yet: wait for the earlier of its weekly slot and its three-day margin.
  if (
    Number.isFinite(dueAt) &&
    dueAt > ctx.now + 1_000 &&
    (c.nextRefreshAt?.getTime() ?? 0) > ctx.now + 1_000
  )
    return { rescheduleAt: new Date(Math.min(dueAt, c.nextRefreshAt!.getTime())) };

  try {
    const next = await provider.refreshTokens(current);
    const at = nextRefreshAt(next.expiresAt, refreshEveryMs, refreshAheadMs, ctx.now);
    const stored = await asWorker(ctx.db, scope, async (tx) => {
      const changed = await tx
        .update(paymentConnections)
        .set({
          tokenEnc: ctx.sealer.seal(JSON.stringify(next)),
          tokenKeyId: ctx.sealer.keyId,
          tokenExpiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
          nextRefreshAt: at,
          status: 'active',
          failures: 0,
          lastError: null,
        })
        // A disconnect while we were renewing cleared the tokens, and they stay cleared.
        .where(
          and(eq(paymentConnections.id, c.id), inArray(paymentConnections.status, [...USABLE])),
        )
        .returning({ id: paymentConnections.id });
      return changed.length > 0;
    });
    return stored && at ? { rescheduleAt: at } : undefined;
  } catch (e) {
    if (e instanceof PaymentAuthError) {
      // Stops here: the owners get one email, and the refresh starts again when they reconnect.
      await failConnection(ctx, scope, c, 'reauth_required', lostAccess(c));
      return;
    }
    const failures = c.failures + 1;
    const message = errorMessage(e);
    ctx.log.warn({ connectionId: c.id, failures, err: message }, 'a payment token refresh failed');
    const wait =
      e instanceof PaymentError && e.retryAfterMs
        ? e.retryAfterMs
        : Math.min(MAX_WAIT_MS, HOUR * 2 ** Math.min(failures - 1, 5));
    const at = new Date(ctx.now + wait);
    // The command counts the failure when it escalates, so exactly one of the two writes it.
    const escalate = failures >= FAILURES_BEFORE_ERROR && c.status !== 'error';
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(paymentConnections)
        .set({
          ...(escalate ? {} : { failures }),
          lastError: message.slice(0, 2000),
          nextRefreshAt: at,
        })
        .where(
          and(eq(paymentConnections.id, c.id), inArray(paymentConnections.status, [...USABLE])),
        ),
    );
    if (escalate) await failConnection(ctx, scope, c, 'error', message);
    return { rescheduleAt: at };
  }
};

/**
 * Hourly, for the whole server: every active connection whose refresh time has passed gets its job back. A
 * pending one is only pulled earlier; one that exhausted its retries and is sitting `failed` gets a new row,
 * because the dedupe index only counts pending ones. This is the safety net that stops a 30-day silent outage.
 *
 * It goes business by business because the empty scope sees no business's rows — `payment_connections`' service
 * policy is `workspace_id = private.system_scope_workspace()`, so a global read comes back empty. The list of
 * businesses comes from `private.workspace_timezones()`, the definer function the Action Center's hourly plan
 * already uses for the same reason. One business's problem never stops the rest.
 */
export const paymentsPlan: JobHandler = async (ctx) => {
  const businesses = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.workspace_timezones()`,
    ),
  );
  for (const b of businesses) {
    const scope = { workspaceId: b.workspace_id, organizationId: b.organization_id };
    try {
      await asWorker(ctx.db, scope, (tx) =>
        tx.execute(
          sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
              select ${scope.organizationId}::uuid, pc.workspace_id, ${PAYMENT_JOBS.refresh},
                ${`${PAYMENT_JOBS.refresh}:`}::text || pc.id::text, now(),
                jsonb_build_object('connectionId', pc.id)
              from app.payment_connections pc
              where pc.workspace_id = ${scope.workspaceId}::uuid
                and pc.status = 'active' and pc.token_enc is not null
                and pc.next_refresh_at is not null
                and pc.next_refresh_at <= now() + interval '5 minutes'
              on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
              do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at)`,
        ),
      );
    } catch (e) {
      ctx.log.warn(
        { workspaceId: scope.workspaceId, err: errorMessage(e) },
        'could not re-arm a business’s payment token refreshes',
      );
    }
  }
  return { rescheduleAt: new Date(ctx.now + HOUR) };
};

export const paymentJobs: JobMap = {
  [PAYMENT_JOBS.refresh]: paymentsRefresh,
  [PAYMENT_JOBS.plan]: paymentsPlan,
};

/**
 * A business disconnected an account: tell the provider too, so our access really is gone and not merely
 * forgotten. Both revokes authenticate as **the platform** and need only the account id, which is what makes
 * this possible after the fact — the connection's sealed token was destroyed on the way out, on purpose.
 *
 * A provider that refuses is logged and nothing more: the disconnect has already happened here, and making it
 * fail would leave a business connected to an account it asked to leave.
 */
export async function tellProviderDisconnected(
  s: WorkerServices,
  c: Pick<PaymentConnectionRow, 'id' | 'provider' | 'externalAccountId'>,
): Promise<boolean> {
  const provider = s.payments.providers[c.provider as PaymentProviderName];
  if (!provider || !c.externalAccountId) return false;
  try {
    await provider.revokeAccess({ externalAccountId: c.externalAccountId });
    return true;
  } catch (e) {
    s.log.warn(
      { connectionId: c.id, provider: c.provider, err: errorMessage(e) },
      'the provider was not told the account was disconnected',
    );
    return false;
  }
}

/** The account as a call would use it, or null when there is no usable sign-in left. */
export function accountOfConnection(s: WorkerServices, c: PaymentConnectionRow) {
  if (!paymentConnectionUsable(c)) return null;
  try {
    return accountFor(s.sealer, c);
  } catch {
    return null;
  }
}
