/**
 * What Settings → Texting & calls reads from the worker about a business's own phone account: whether Phone & texting
 * is on, and the RCS senders in it. Said once, for its routes and for the Assistant, which reads them as the person
 * through the worker as the screen does (the worker holds the provider keys). The caller checks `channels.manage`.
 */
import { asWorker } from '@hfos/db/client';
import { scheduledJobs, telephonyAccounts } from '@hfos/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { ACCOUNT_JOBS } from '../telephony/account-switch';
import { loadAccount } from '../telephony/accounts';
import type { HttpDeps } from './common';

/**
 * Phone & texting on or off, and the business's own Twilio Account SID while it is on: what HighLevel or Twilio asks
 * for to move a number here, beside HandsFreeOS's parent account's. Both are identifiers, never keys.
 */
export async function phoneAccountOf(
  deps: Pick<HttpDeps, 'httpDb' | 'telephony'>,
  workspaceId: string,
) {
  const [row, opening] = await asWorker(
    deps.httpDb,
    { workspaceId },
    async (tx) =>
      [
        (
          await tx
            .select({
              status: telephonyAccounts.status,
              accountSid: telephonyAccounts.accountSid,
              lastError: telephonyAccounts.lastError,
              updatedAt: telephonyAccounts.updatedAt,
            })
            .from(telephonyAccounts)
            .where(eq(telephonyAccounts.workspaceId, workspaceId))
        )[0],
        // The latest press of On: the account is only written once Twilio has made it, so until then this is
        // what knows it is turning on, or why it gave up.
        (
          await tx
            .select({
              status: scheduledJobs.status,
              payload: scheduledJobs.payload,
              finishedAt: scheduledJobs.finishedAt,
            })
            .from(scheduledJobs)
            .where(
              and(
                eq(scheduledJobs.workspaceId, workspaceId),
                eq(scheduledJobs.kind, ACCOUNT_JOBS.open),
              ),
            )
            .orderBy(desc(scheduledJobs.createdAt))
            .limit(1)
        )[0],
      ] as const,
  );
  const open = !!row && row.status !== 'closed';
  // Gave up since the account last changed: nothing made it on since, by the switch or by buying a number.
  const gaveUp =
    opening?.status === 'failed' &&
    row?.status !== 'active' &&
    (!row || !opening.finishedAt || opening.finishedAt > row.updatedAt);
  const state =
    row?.status === 'active'
      ? 'on'
      : opening?.status === 'pending'
        ? 'turning_on'
        : gaveUp
          ? 'off'
          : open
            ? 'turning_on'
            : 'off';
  const problem = (opening?.payload as { problem?: unknown } | undefined)?.problem;
  return {
    state,
    accountSid: state !== 'off' && open ? row.accountSid : null,
    // HandsFreeOS's own parent account, which every business's sits under. HighLevel's move form asks for
    // it beside the sub-account's. An identifier like the other, never a key.
    parentAccountSid: deps.telephony.masterAccountSid,
    lastError: gaveUp
      ? typeof problem === 'string'
        ? problem
        : 'Phone & texting couldn’t be turned on: Twilio, our phone carrier, kept refusing. Try again in a few minutes, or ask HandsFreeOS support.'
      : state === 'off'
        ? null
        : (row?.lastError ?? null),
  } as const;
}

/**
 * The RCS senders in the business's own Twilio account (0103), for Settings to offer before anything is connected.
 * Twilio makes senders only in its console, so this is how a business sees the one it made, and, when there is none,
 * which account to make it in.
 */
export async function rcsSendersOf(
  deps: Pick<HttpDeps, 'httpDb' | 'telephony' | 'sealer'>,
  workspaceId: string,
) {
  const account = await asWorker(deps.httpDb, { workspaceId }, (tx) =>
    loadAccount(tx, workspaceId, deps.sealer),
  );
  if (!account) return { accountSid: null, senders: [] };
  const senders = await deps.telephony.listRcsSenders(account);
  return {
    accountSid: account.sid,
    senders: senders.map((x) => ({
      sid: x.sid,
      senderId: x.senderId,
      displayName: x.displayName,
      state: x.state,
      providerStatus: x.providerStatus,
    })),
  };
}
