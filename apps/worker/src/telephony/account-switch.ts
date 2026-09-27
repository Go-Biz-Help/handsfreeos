/**
 * Phone & texting on or off: making or closing a business's own Twilio subaccount when a person presses the
 * switch (`telephony.enable` / `telephony.disable`).
 *
 * **On** is `ensureAccount` — the same subaccount, messaging service, API key and TwiML app the first number
 * would have made — done now, so the Account SID is there to give HighLevel or Twilio before any number is.
 *
 * **Off** closes the subaccount with the master account, for good. The command already refused while anything
 * was in it; this asks again the moment before closing, because a number can be bought or a transfer started
 * in between, and a subaccount closed with a number in it is a number released. When something has turned up,
 * the account stays on and the business is told why. Closed, its secrets are wiped: nothing can open it again,
 * and `ensureAccount` makes a fresh subaccount if phone & texting is turned back on.
 *
 * Provider calls are jobs, never outbox handlers, like every other carrier call here.
 */
import {
  executeCommand,
  phoneAccountBlockers,
  scheduleJob,
  telephonyAccountChanged,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { telephonyAccounts } from '@hfos/db/schema';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { ensureAccount } from './accounts';

export const ACCOUNT_JOBS = {
  open: 'telephony.account_open',
  close: 'telephony.account_close',
} as const;

function queue(kind: string) {
  return async (ctx: HandlerContext): Promise<void> => {
    const { workspaceId, organizationId } = ctx.scope;
    if (!workspaceId || !organizationId) return;
    await scheduleJob(ctx.tx, {
      kind,
      dedupeKey: `${kind}:${workspaceId}`,
      runAt: new Date(),
      payload: { correlationId: ctx.event.correlationId },
      workspaceId,
      organizationId,
    });
  };
}

export const onTelephonyEnableRequested: EventHandler = queue(ACCOUNT_JOBS.open);
export const onTelephonyDisableRequested: EventHandler = queue(ACCOUNT_JOBS.close);

/** Says what came of it, so the page and the audit log both hear. */
const tell = (
  services: WorkerServices,
  scope: TenantScope,
  input: { status: 'active' | 'closed'; accountSid: string | null; problem: string | null },
) =>
  executeCommand(
    services.db,
    telephonyAccountChanged,
    { workspaceId: scope.workspaceId, ...input },
    systemActor(scope),
    workerMeta(),
  );

export const accountOpen: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  // Failures retry with the job's backoff: a carrier that did not answer is not a reason to give up on "on".
  const account = await ensureAccount(ctx, scope);
  await tell(ctx, scope, { status: 'active', accountSid: account.sid, problem: null });
};

export const accountClose: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [row, blockers] = await asWorker(
    ctx.db,
    scope,
    async (tx) =>
      [
        (
          await tx
            .select()
            .from(telephonyAccounts)
            .where(eq(telephonyAccounts.workspaceId, scope.workspaceId))
        )[0],
        await phoneAccountBlockers(tx, scope.workspaceId),
      ] as const,
  );
  if (!row?.accountSid || row.status === 'closed') {
    await tell(ctx, scope, { status: 'closed', accountSid: null, problem: null });
    return;
  }
  if (blockers.length) {
    const problem = `Phone & texting was left on. ${blockers.join(' ')}`;
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(telephonyAccounts)
        .set({ lastError: problem })
        .where(eq(telephonyAccounts.id, row.id)),
    );
    ctx.log.warn({ workspaceId: scope.workspaceId }, 'phone & texting was not turned off: in use');
    await tell(ctx, scope, { status: 'active', accountSid: row.accountSid, problem });
    return;
  }
  await ctx.telephony.closeSubaccount(row.accountSid);
  // The account SID stays, as the record of which account this business had; everything that could open it
  // or act in it goes.
  await asWorker(ctx.db, scope, (tx) =>
    tx
      .update(telephonyAccounts)
      .set({
        status: 'closed',
        authTokenEnc: null,
        apiKeySid: null,
        apiKeySecretEnc: null,
        messagingServiceSid: null,
        twimlAppSid: null,
        lastError: null,
      })
      .where(eq(telephonyAccounts.id, row.id)),
  );
  ctx.log.info({ workspaceId: scope.workspaceId }, 'phone & texting turned off: subaccount closed');
  await tell(ctx, scope, { status: 'closed', accountSid: row.accountSid, problem: null });
};

export const phoneAccountJobs: JobMap = {
  [ACCOUNT_JOBS.open]: accountOpen,
  [ACCOUNT_JOBS.close]: accountClose,
};
