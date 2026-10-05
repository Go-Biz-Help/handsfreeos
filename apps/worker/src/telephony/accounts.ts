import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { asWorker, type Db, type Tx } from '@hfos/db/client';
import { telephonyAccounts, workspaces } from '@hfos/db/schema';
import type { Sealer } from '../crypto';
import { errorMessage } from '../outbox';
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
    voiceOutboundUrl: `${publicUrl}/webhooks/twilio/voice/outbound`,
  };
}

type AccountRow = typeof telephonyAccounts.$inferSelect;

export function openAccount(row: AccountRow, sealer: Sealer): ProviderAccount | null {
  if (!row.accountSid || !row.authTokenEnc) return null;
  return {
    id: row.id,
    sid: row.accountSid,
    authToken: sealer.open(row.authTokenEnc),
    messagingServiceSid: row.messagingServiceSid,
    apiKeySid: row.apiKeySid,
    apiKeySecret: row.apiKeySecretEnc ? sealer.open(row.apiKeySecretEnc) : null,
    twimlAppSid: row.twimlAppSid,
  };
}

/**
 * The workspace's subaccount with its secrets opened, or null before the first number is bought — and null
 * once phone & texting is turned off: a closed subaccount can do nothing, and its secrets are wiped.
 */
export async function loadAccount(
  tx: Tx,
  workspaceId: string,
  sealer: Sealer,
): Promise<ProviderAccount | null> {
  const [row] = await tx
    .select()
    .from(telephonyAccounts)
    .where(eq(telephonyAccounts.workspaceId, workspaceId));
  return row && row.status !== 'closed' ? openAccount(row, sealer) : null;
}

/**
 * The workspace's subaccount, messaging service, and what browser calls need (an API key and a TwiML app),
 * created on first use. Each step commits on its own: something the provider created is never forgotten
 * because a later step failed, and the next attempt carries on from there.
 */
export async function ensureAccount(
  deps: AccountDeps,
  scope: TenantScope,
): Promise<ProviderAccount> {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => asWorker(deps.db, scope, fn);
  let [row] = await run((tx) =>
    tx.select().from(telephonyAccounts).where(eq(telephonyAccounts.workspaceId, scope.workspaceId)),
  );
  // A business that turned phone & texting off has a closed subaccount behind it, and Twilio never reopens one:
  // turning it back on (or buying a number) makes a fresh subaccount, with everything made inside the old one
  // forgotten along with it.
  if (!row?.accountSid || row.status === 'closed') {
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
      messagingServiceSid: null,
      apiKeySid: null,
      apiKeySecretEnc: null,
      twimlAppSid: null,
      lastError: null,
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
  let account = openAccount(row, deps.sealer);
  if (!account) throw new Error('telephony account has no credentials');
  const ready =
    !!account.messagingServiceSid &&
    !!account.apiKeySid &&
    !!account.apiKeySecret &&
    !!account.twimlAppSid;
  if (ready && row.status === 'active') return account;

  const rowId = row.id;
  const save = (set: Partial<typeof telephonyAccounts.$inferInsert>) =>
    run((tx) => tx.update(telephonyAccounts).set(set).where(eq(telephonyAccounts.id, rowId)));
  const urls = webhookUrls(deps.publicUrl);
  const tag = scope.workspaceId.slice(0, 8);
  if (!account.messagingServiceSid) {
    const serviceSid = await deps.telephony.createMessagingService(account, {
      friendlyName: `HandsFreeOS ${tag}`,
      inboundUrl: urls.smsUrl,
      statusCallbackUrl: urls.smsStatusUrl,
    });
    await save({ messagingServiceSid: serviceSid });
    account = { ...account, messagingServiceSid: serviceSid };
  }
  // Browser calls: the subaccount's own key signs the tokens, and a TwiML app places the calls.
  if (!account.apiKeySid || !account.apiKeySecret) {
    const key = await deps.telephony.createApiKey(account, `HandsFreeOS calls ${tag}`);
    await save({ apiKeySid: key.sid, apiKeySecretEnc: deps.sealer.seal(key.secret) });
    account = { ...account, apiKeySid: key.sid, apiKeySecret: key.secret };
  }
  if (!account.twimlAppSid) {
    const appSid = await deps.telephony.createTwimlApp(account, {
      friendlyName: `HandsFreeOS calls ${tag}`,
      voiceUrl: urls.voiceOutboundUrl,
      statusCallbackUrl: urls.voiceStatusUrl,
    });
    await save({ twimlAppSid: appSid });
    account = { ...account, twimlAppSid: appSid };
  }
  await save({ status: 'active', lastError: null });
  return account;
}

/**
 * The key browser call tokens are signed with, made again when Twilio no longer has it: somebody deleted it in
 * the Twilio console, and Twilio refuses every token it signs. Twilio is asked each time a browser asks for a
 * token. When Twilio can't say, the key we hold is used, as before.
 */
export async function liveCallingKey(
  deps: Pick<AccountDeps, 'db' | 'telephony' | 'sealer'> & { readonly log: Logger },
  workspaceId: string,
  account: ProviderAccount,
): Promise<{ sid: string; secret: string }> {
  if (!account.apiKeySid || !account.apiKeySecret) throw new Error('browser calls are not set up');
  const held = { sid: account.apiKeySid, secret: account.apiKeySecret };
  try {
    if (await deps.telephony.hasApiKey(account, held.sid)) return held;
  } catch (e) {
    deps.log.warn(
      { workspaceId, err: errorMessage(e) },
      'could not ask Twilio about the calling key',
    );
    return held;
  }
  // The same name ensureAccount gives it, so the console shows which business it belongs to.
  const key = await deps.telephony.createApiKey(
    account,
    `HandsFreeOS calls ${workspaceId.slice(0, 8)}`,
  );
  await asWorker(deps.db, { workspaceId }, (tx) =>
    tx
      .update(telephonyAccounts)
      .set({ apiKeySid: key.sid, apiKeySecretEnc: deps.sealer.seal(key.secret) })
      .where(eq(telephonyAccounts.id, account.id)),
  );
  deps.log.warn({ workspaceId }, 'the calling key was gone from Twilio, so a new one was made');
  return key;
}
