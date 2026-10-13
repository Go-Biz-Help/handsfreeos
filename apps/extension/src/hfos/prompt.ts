/**
 * Signing in with a prompt on the person's phone or in HandsFreeOS (20261027002900, README "Signing in with a
 * prompt"), in the background worker. The panel shows the number; this keeps the request's secret and asks the worker
 * whether the right number was picked.
 *
 * - **Start:** the email goes to the worker's public door, which answers the same whether or not it has an account:
 *   a request id, the number to show, the secret, and when it runs out (2 minutes).
 * - **The secret** stays here, in the extension's session storage (gone when the browser closes), never in the panel
 *   and never in HandsFreeOS: only its hash is kept there, and collecting the answer needs it. One prompt at a time.
 * - **Collect:** waiting, refused (a wrong number was picked, or "That wasn't me"), expired, or approved with a
 *   one-time token, redeemed here with Supabase Auth (`verifyOtp` with the token's hash) for this extension's own
 *   sign-in. The token is used once and kept nowhere.
 */
import { EXTENSION_SIGN_IN_STATUS_WORDS } from '@hfos/core/extension-sign-in';
import { config } from './config';

const PROMPT_KEY = 'hfos.prompt';

/** The request under way: kept with its secret until it's answered or runs out. */
interface Kept {
  readonly requestId: string;
  readonly secret: string;
  readonly expiresAt: string;
}

/** What went wrong, in the person's words; the caller turns it into the panel's problem. */
export class PromptRefused extends Error {}

const NO_CONNECTION = 'Couldn’t reach HandsFreeOS. Check your internet connection, then try again.';

/** Session storage where Chrome has it (memory only), else the extension's own. */
const area = (): chrome.storage.StorageArea => chrome.storage.session ?? chrome.storage.local;

async function keep(kept: Kept | null): Promise<void> {
  if (kept) await area().set({ [PROMPT_KEY]: kept });
  else await area().remove(PROMPT_KEY);
}

async function kept(): Promise<Kept | null> {
  const found: unknown = (await area().get(PROMPT_KEY))[PROMPT_KEY];
  const k = found as Kept | null | undefined;
  return k && typeof k.requestId === 'string' && typeof k.secret === 'string' ? k : null;
}

/** The browser's name, for "Signing in to the extension on Chrome?". */
export function browserName(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Brave/.test(userAgent)) return 'Brave';
  return 'Chrome';
}

async function post(path: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  if (!config.workerUrl)
    throw new PromptRefused(
      'This build of the extension can’t send a prompt. Use an emailed code instead.',
    );
  let response: Response;
  try {
    response = await fetchImpl(`${config.workerUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PromptRefused(NO_CONNECTION);
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) return json;
  const said = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
  throw new PromptRefused(
    typeof said === 'string'
      ? said
      : 'The prompt couldn’t be sent. Try again, or use an emailed code.',
  );
}

/** Sends a prompt for this email; answers the number to show. Any earlier prompt here is forgotten. */
export async function startPrompt(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ requestId: string; number: number; expiresAt: string }> {
  const said = (await post(
    '/public/extension-sign-in/start',
    { email, browser: browserName(navigator.userAgent) },
    fetchImpl,
  )) as Partial<Record<'requestId' | 'number' | 'secret' | 'expiresAt', unknown>> | null;
  const { requestId, number, secret, expiresAt } = said ?? {};
  if (
    typeof requestId !== 'string' ||
    typeof number !== 'number' ||
    typeof secret !== 'string' ||
    typeof expiresAt !== 'string'
  )
    throw new PromptRefused('Something went wrong. Try again, or use an emailed code.');
  await keep({ requestId, secret, expiresAt });
  return { requestId, number, expiresAt };
}

/**
 * Whether the prompt was answered. Approved: `redeem` signs in with the token's hash. Anything that ends it forgets
 * the secret. A prompt this extension didn't start (or already finished) is expired.
 */
export async function checkPrompt(
  requestId: string,
  redeem: (tokenHash: string) => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): Promise<'waiting' | 'refused' | 'expired' | 'signed-in'> {
  const k = await kept();
  if (!k || k.requestId !== requestId) return 'expired';
  const answer = (await post(
    '/public/extension-sign-in/collect',
    { requestId, secret: k.secret },
    fetchImpl,
  )) as { status?: unknown; tokenHash?: unknown } | null;
  const status = answer?.status;
  if (status === 'refused' || status === 'expired') {
    await keep(null);
    return status;
  }
  if (status !== 'approved' || typeof answer?.tokenHash !== 'string') return 'waiting';
  await keep(null);
  await redeem(answer.tokenHash);
  return 'signed-in';
}

/** What the panel says for a prompt that's waiting or can't go on. */
export const PROMPT_WORDS = EXTENSION_SIGN_IN_STATUS_WORDS;
