import { eq } from 'drizzle-orm';
import { asWorker, type Db, type Tx } from '@hfos/db/client';
import { telephonyAccounts, workspaces } from '@hfos/db/schema';
import type { Sealer } from '../crypto';
import type { TenantScope } from '../services';
import type { ProviderAccount, TelephonyProvider, WebhookUrls } from './provider';

export interface AccountDeps {
  readonly db: Db;
  readonly telephony: TelephonyProvider;
  readonly sealer: Sealer;
  readonly publicUrl: string;
}

/** Where the provider reaches the worker. Built from WORKER_PUBLIC_URL, never from a request's Host header. */
export function webhookUrls(publicUrl: string): WebhookUrls {
  return {
    smsUrl: `${publicUrl}/webhooks/twilio/messaging/inbound`,
    smsStatusUrl: `${publicUrl}/webhooks/twilio/messaging/status`,
    voiceUrl: `${publicUrl}/webhooks/twilio/voice/inbound`,
    voiceStatusUrl: `${publicUrl}/webhooks/twilio/voice/status`,
  };
}

type AccountRow = typeof telephonyAccounts.$inferSelect;

function openAccount(row: AccountRow, sealer: Sealer): ProviderAccount | null {
  if (!row.accountSid || !row.authTokenEnc) return null;
  return {
    id: row.id,
    sid: row.accountSid,
    authToken: sealer.open(row.authTokenEnc),
    messagingServiceSid: row.messagingServiceSid,
  };
}

/** The workspace's subaccount with its token opened, or null before the first number is bought. */
export async function loadAccount(
  tx: Tx,
  workspaceId: string,
  sealer: Sealer,
): Promise<ProviderAccount | null> {
  const [row] = await tx
    .select()
    .from(telephonyAccounts)
    .where(eq(telephonyAccounts.workspaceId, workspaceId));
  return row ? openAccount(row, sealer) : null;
}

/**
 * The workspace's subaccount and messaging service, created on first use. Each step commits on its own:
 * a subaccount the provider created is never forgotten because a later step failed.
 */
export async function ensureAccount(
  deps: AccountDeps,
  scope: TenantScope,
): Promise<ProviderAccount> {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => asWorker(deps.db, scope, fn);
  let [row] = await run((tx) =>
    tx.select().from(telephonyAccounts).where(eq(telephonyAccounts.workspaceId, scope.workspaceId)),
  );
  if (!row?.accountSid) {
    const [ws] = await run((tx) =>
      tx
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, scope.workspaceId)),
    );
    const sub = await deps.telephony.createSubaccount(
      `HandsFreeOS ${ws?.name ?? 'workspace'} ${scope.workspaceId.slice(0, 8)}`.slice(0, 64),
    );
    const sealed = {
      accountSid: sub.sid,
      authTokenEnc: deps.sealer.seal(sub.authToken),
      keyId: deps.sealer.keyId,
      webhookBaseUrl: deps.publicUrl,
      status: 'provisioning' as const,
    };
    [row] = await run((tx) =>
      tx
        .insert(telephonyAccounts)
        .values({ workspaceId: scope.workspaceId, provider: deps.telephony.name, ...sealed })
        .onConflictDoUpdate({ target: telephonyAccounts.workspaceId, set: sealed })
        .returning(),
    );
  }
  if (!row) throw new Error('telephony account not visible in its own workspace');
  const account = openAccount(row, deps.sealer);
  if (!account) throw new Error('telephony account has no credentials');
  if (account.messagingServiceSid && row.status === 'active') return account;
  const urls = webhookUrls(deps.publicUrl);
  const serviceSid =
    account.messagingServiceSid ??
    (await deps.telephony.createMessagingService(account, {
      friendlyName: `HandsFreeOS ${scope.workspaceId.slice(0, 8)}`,
      inboundUrl: urls.smsUrl,
      statusCallbackUrl: urls.smsStatusUrl,
    }));
  await run((tx) =>
    tx
      .update(telephonyAccounts)
      .set({ messagingServiceSid: serviceSid, status: 'active', lastError: null })
      .where(eq(telephonyAccounts.id, row.id)),
  );
  return { ...account, messagingServiceSid: serviceSid };
}
