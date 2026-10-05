import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { telephonyAccounts } from '@hfos/db/schema';
import type { Sealer } from '../crypto';
import { ProviderError, type TelephonyProvider } from './provider';

export interface TokenDeps {
  readonly db: Db;
  readonly telephony: TelephonyProvider;
  readonly sealer: Sealer;
  readonly log: Logger;
}

/** How long a token Twilio just confirmed stands when the only doubt about it is a webhook whose signature failed. */
const CONFIRMED_FOR_MS = 60_000;

/** Per provider: the token Twilio last confirmed for each subaccount, and when. */
const confirmed = new WeakMap<TelephonyProvider, Map<string, { token: string; at: number }>>();

function confirmedBy(telephony: TelephonyProvider) {
  let byAccount = confirmed.get(telephony);
  if (!byAccount) confirmed.set(telephony, (byAccount = new Map()));
  return byAccount;
}

/**
 * A business's subaccount Auth Token, read again from Twilio and saved when it changed. Somebody can rotate it in
 * the Twilio console. Twilio then refuses everything signed in with the copy the worker sealed when it made the
 * subaccount, and signs the business's webhooks with a token the worker doesn't have. The master account can
 * still read the current one. Returns the new token, or null when it hadn't changed, isn't one of our
 * subaccounts, or Twilio couldn't be asked.
 *
 * A webhook whose signature failed is `unproven`: anybody can send one, so Twilio is asked about it at most once
 * a minute per token we hold. A refusal from Twilio itself is always worth asking about.
 */
export async function renewSubaccountToken(
  deps: TokenDeps,
  accountSid: string,
  opts: { readonly unproven?: boolean } = {},
): Promise<string | null> {
  if (accountSid === deps.telephony.masterAccountSid) return null;
  const [row] = await asWorker(deps.db, {}, (tx) =>
    rows<{ workspace_id: string; status: string; auth_token_enc: string | null }>(
      tx,
      sql`select workspace_id, status::text as status, auth_token_enc
          from private.telephony_account_lookup(${accountSid})`,
    ),
  );
  if (!row?.auth_token_enc || row.status === 'closed') return null;
  const held = deps.sealer.open(row.auth_token_enc);
  const byAccount = confirmedBy(deps.telephony);
  const last = byAccount.get(accountSid);
  if (opts.unproven && last?.token === held && Date.now() - last.at < CONFIRMED_FOR_MS) return null;
  let current: string | null;
  try {
    current = await deps.telephony.subaccountToken(accountSid);
  } catch (e) {
    deps.log.warn(
      { workspaceId: row.workspace_id, err: e instanceof Error ? e.message : String(e) },
      'could not ask Twilio for the subaccount’s auth token',
    );
    byAccount.set(accountSid, { token: held, at: Date.now() });
    return null;
  }
  if (!current || current === held) {
    byAccount.set(accountSid, { token: held, at: Date.now() });
    return null;
  }
  await asWorker(deps.db, { workspaceId: row.workspace_id }, (tx) =>
    tx
      .update(telephonyAccounts)
      .set({ authTokenEnc: deps.sealer.seal(current), keyId: deps.sealer.keyId })
      .where(eq(telephonyAccounts.accountSid, accountSid)),
  );
  byAccount.delete(accountSid);
  deps.log.warn(
    { workspaceId: row.workspace_id },
    'the subaccount’s auth token was changed in Twilio, so the new one was saved',
  );
  return current;
}

/**
 * After a failure: when Twilio refused a business's own sign-in (401), its token may have been rotated in the
 * console, so the current one is saved before the retry. Never throws.
 */
export async function renewAfterRefusal(deps: TokenDeps, e: unknown): Promise<void> {
  if (!(e instanceof ProviderError) || e.httpStatus !== 401 || !e.accountSid) return;
  try {
    await renewSubaccountToken(deps, e.accountSid);
  } catch (err) {
    deps.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not renew a refused subaccount token',
    );
  }
}
