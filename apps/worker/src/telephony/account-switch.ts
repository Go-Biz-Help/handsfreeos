/**
 * Phone & texting on or off: making or closing a business's own Twilio subaccount when a person presses the
 * switch (`telephony.enable` / `telephony.disable`).
 *
 * **On** is `ensureAccount` — the same subaccount, messaging service, API key and TwiML app the first number
 * would have made — done now, so the Account SID is there to give HighLevel or Twilio before any number is.
 * While the job is still trying, the page says "Turning on…"; when its last try fails, it keeps why in words on
 * the job (`payload.problem`), and the page shows that under the switch.
 *
 * **Off** closes the subaccount with the master account, for good. The command already refused while anything
 * was in it; this asks again the moment before closing, because a number can be bought or a transfer started
 * in between, and a subaccount closed with a number in it is a number released. When something has turned up,
 * the account stays on and the business is told why. Closed, its secrets are wiped: nothing can open it again,
 * and `ensureAccount` makes a fresh subaccount if phone & texting is turned back on.
 *
 * **It also asks Twilio.** What HandsFreeOS has written down is not everything that can be in the account: a
 * number moved in straight through Twilio's or HighLevel's support, with no transfer started here, has no row
 * anywhere, and closing would release it all the same. So the account is listed first, and one that still holds
 * a number stays on. One that cannot be listed stays on too: an account is never closed without looking.
 *
 * Provider calls are jobs, never outbox handlers, like every other carrier call here.
 */
import {
  executeCommand,
  formatPhone,
  phoneAccountBlockers,
  scheduleJob,
  telephonyAccountChanged,
} from '@hfos/core/server';
import { asWorker, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { scheduledJobs, telephonyAccounts } from '@hfos/db/schema';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
import { ensureAccount, loadAccount } from './accounts';
import { ProviderError, type ProviderAccount } from './provider';

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

/** Why turning on kept failing, in words the page shows under the switch once the worker stops trying. */
function openTrouble(ctx: WorkerServices, e: unknown): string {
  const lead = 'Phone & texting couldn’t be turned on:';
  if (e instanceof ProviderError) {
    if (/maximum number of subaccounts/i.test(e.message))
      return `${lead} HandsFreeOS has reached Twilio’s limit on business accounts. Ask HandsFreeOS support to raise it.`;
    if (e.httpStatus === 401 || e.httpStatus === 403)
      return e.accountSid === ctx.telephony.masterAccountSid
        ? `${lead} Twilio, our phone carrier, refused HandsFreeOS’s sign-in. Try again in an hour, or ask HandsFreeOS support.`
        : `${lead} Twilio, our phone carrier, refused your business’s account. Try again in a minute, or ask HandsFreeOS support.`;
    if (e.httpStatus === 429)
      return `${lead} Twilio, our phone carrier, was too busy. Try again in a few minutes.`;
  }
  return `${lead} Twilio, our phone carrier, didn’t answer. Try again in a few minutes.`;
}

export const accountOpen: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  let account: ProviderAccount;
  try {
    account = await ensureAccount(ctx, scope);
  } catch (e) {
    // Failures retry with the job's backoff: a carrier that did not answer is not a reason to give up on "on".
    if (ctx.attempt < MAX_ATTEMPTS) throw e;
    // The last try: why is kept on the job in words, so the page says it instead of quietly showing Off again.
    // The job's own last_error keeps the carrier's words for whoever looks into it.
    ctx.log.warn({ err: errorMessage(e) }, 'phone & texting gave up turning on after the last try');
    const problem = JSON.stringify({ problem: openTrouble(ctx, e) });
    await asWorker(ctx.db, {}, (tx) =>
      tx
        .update(scheduledJobs)
        .set({ payload: sql`${scheduledJobs.payload} || ${problem}::jsonb` })
        .where(eq(scheduledJobs.id, ctx.job.id)),
    );
    throw e;
  }
  await tell(ctx, scope, { status: 'active', accountSid: account.sid, problem: null });
};

/** "(256) 555-0199", "(256) 555-0199 and (713) 555-0101", "(256) 555-0199, (713) 555-0101 and 2 more". */
function numberList(e164s: readonly string[]): string {
  const named = e164s.slice(0, 2).map((n) => formatPhone(n));
  const more = e164s.length - named.length;
  if (more > 0) return `${named.join(', ')} and ${more} more`;
  return named.join(' and ');
}

/**
 * What is still in the business's Twilio account that closing it would release, asked of Twilio itself: a
 * sentence saying so, or null when it is empty. Throws when Twilio cannot be asked.
 */
async function stillInTwilio(ctx: WorkerServices, scope: TenantScope): Promise<string | null> {
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) throw new Error('the Twilio account could not be opened to look inside it');
  const left = await ctx.telephony.listOwnedNumbers(account, { limit: 10 });
  if (!left.length) return null;
  const one = left.length === 1;
  return `Your Twilio account still has ${numberList(left.map((n) => n.e164))} in it, which ${one ? 'isn’t' : 'aren’t'} set up in HandsFreeOS. Closing the account would release ${one ? 'it' : 'them'} for good. Set ${one ? 'it' : 'them'} up under Numbers already in this account, or ask Twilio to move ${one ? 'it' : 'them'} out first.`;
}

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
  const leaveOn = async (problem: string) => {
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(telephonyAccounts)
        .set({ lastError: problem })
        .where(eq(telephonyAccounts.id, row.id)),
    );
    ctx.log.warn({ workspaceId: scope.workspaceId }, 'phone & texting was not turned off: in use');
    await tell(ctx, scope, { status: 'active', accountSid: row.accountSid, problem });
  };
  if (blockers.length) return leaveOn(`Phone & texting was left on. ${blockers.join(' ')}`);

  // Twilio too, because a number nobody here asked for is in none of the blockers above.
  let inTwilio: string | null;
  try {
    inTwilio = await stillInTwilio(ctx, scope);
  } catch (e) {
    ctx.log.warn(
      { workspaceId: scope.workspaceId, err: errorMessage(e) },
      'could not look inside the Twilio account before closing it',
    );
    return leaveOn(
      'Phone & texting was left on, because we couldn’t check your Twilio account for numbers just now. Try again in a minute.',
    );
  }
  if (inTwilio) return leaveOn(`Phone & texting was left on. ${inTwilio}`);

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
