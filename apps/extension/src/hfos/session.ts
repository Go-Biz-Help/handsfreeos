/**
 * The extension's sign-in to HandsFreeOS and every call it makes there, in the background worker (./messages.ts).
 * Signing in works as on the phone: an emailed code or a password, for an account that already exists. The sign-in
 * is kept in the extension's own storage and refreshed when a call needs it. Every request says it's the extension
 * and which build; every save also says which save it is and when it was done, as the phone's do. The steps the
 * person takes on Facebook go through here too (./noting.ts).
 *
 * It saves only to businesses where Social Outreach is on and the person may use it: HandsFreeOS refuses the rest
 * (`addon_inactive`), and the panel then asks for the account again, which leaves that business out.
 */
import { createApiClient, isApiErrorBody, type ApiClient } from '@hfos/api-client';
import { APP_HEADERS, EXTENSION_CLIENT } from '@hfos/core/mobile';
import { GoTrueClient, isAuthError, isAuthRetryableFetchError } from '@supabase/auth-js';
import { canSignIn, config } from './config';
import {
  BUSINESS_KEY,
  PLACE_KEY,
  type Account,
  type Business,
  type Drafts,
  type JoinAnswerOutput,
  type LikePickOutput,
  type HfosAnswer,
  type HfosAsk,
  type HfosValues,
  type Problem,
} from './messages';
import { checkPrompt, PromptRefused, startPrompt } from './prompt';
import { outreachBusinesses } from './saves';

/**
 * The asks answered here: the panel's sign-in, and the jobs' calls (../jobs/), which only the background makes.
 * Working on its own is ../auto/run.ts's, Waiting for you ./waiting.ts's, and the ask under way ../asks/run.ts's.
 */
export type SessionAsk = Exclude<
  HfosAsk,
  {
    readonly type:
      | 'hfos-auto'
      | 'hfos-auto-start'
      | 'hfos-auto-stop'
      | 'hfos-send-ok'
      | 'hfos-send-skip'
      | 'hfos-waiting'
      | 'hfos-need-clear'
      | 'hfos-request-aside'
      | 'hfos-here'
      | 'hfos-ask-reply'
      | 'hfos-ask-stop';
  }
>;

const SESSION_KEY = 'hfos.session';
/** How long the person's businesses are taken as they were, before HandsFreeOS is asked again. */
const ME_FOR_MS = 60_000;

const NO_CONNECTION = 'Couldn’t reach HandsFreeOS. Check your internet connection, then try again.';

export class Refused extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message);
  }
}

function refuse(message: string, more: Partial<Problem> = {}): Refused {
  return new Refused({ message, rule: null, status: null, recheck: false, ...more });
}

/** The extension's own storage, which the pages it reads can't open. */
const storage = {
  async getItem(key: string): Promise<string | null> {
    const found = await chrome.storage.local.get(key);
    const value: unknown = found[key];
    return typeof value === 'string' ? value : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};

let client: GoTrueClient | null = null;

/**
 * Supabase Auth, kept by the background alone, the way supabase-js sets it up: only the sign-in, since everything
 * else goes through the API. It refreshes the sign-in when a call finds it about to run out.
 */
function auth(): GoTrueClient {
  client ??= new GoTrueClient({
    url: `${config.supabaseUrl}/auth/v1`,
    headers: {
      Authorization: `Bearer ${config.supabasePublishableKey}`,
      apikey: config.supabasePublishableKey,
    },
    storage,
    storageKey: SESSION_KEY,
    persistSession: true,
    // A background worker sleeps when idle, so no timer: each call refreshes the sign-in when it needs to.
    autoRefreshToken: false,
    detectSessionInUrl: false,
  });
  return client;
}

/** The signed-in person's token, refreshed first when it's about to run out; null when nobody is signed in. */
export async function token(): Promise<string | null> {
  const { data, error } = await auth().getSession();
  if (error && isAuthRetryableFetchError(error)) throw refuse(NO_CONNECTION);
  return data.session?.access_token ?? null;
}

let hfos: ApiClient | null = null;

export function api(): ApiClient {
  if (hfos) return hfos;
  hfos = createApiClient({ baseUrl: config.apiUrl, getToken: token });
  hfos.use({
    onRequest({ request }) {
      request.headers.set(APP_HEADERS.client, EXTENSION_CLIENT);
      request.headers.set(APP_HEADERS.appVersion, chrome.runtime.getManifest().version);
      // A save is done the moment it's sent: a fresh id each time, since a second press is a second asking. A step
      // noted on Facebook brings its own id and moment, kept while it waits to be sent (./noting.ts).
      if (request.url.includes('/v1/commands/')) {
        const now = new Date().toISOString();
        if (!request.headers.has(APP_HEADERS.commandId))
          request.headers.set(APP_HEADERS.commandId, crypto.randomUUID());
        if (!request.headers.has(APP_HEADERS.occurredAt))
          request.headers.set(APP_HEADERS.occurredAt, now);
        request.headers.set(APP_HEADERS.sentAt, now);
      }
      return request;
    },
  });
  return hfos;
}

/** Who's signed in and where they can save, as HandsFreeOS last said. */
let me: {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly businesses: readonly Business[];
  readonly at: number;
} | null = null;

const businessName = (id: string) =>
  me?.businesses.find((b) => b.id === id)?.name ?? 'this business';

/** Who's signed in and the business they save to. */
export interface Place {
  readonly userId: string;
  readonly businessId: string;
}

const isPlace = (value: unknown): value is Place =>
  typeof (value as Place | null)?.userId === 'string' &&
  typeof (value as Place | null)?.businessId === 'string';

/** The place last kept, so it's written only when it changes. */
let placeKept: string | undefined;

/** Keeps where the person saves, for when HandsFreeOS can't be reached to say; forgets it when they sign out. */
async function keepPlace(place: Place | null): Promise<void> {
  const json = JSON.stringify(place);
  if (json === placeKept) return;
  if (place) await chrome.storage.local.set({ [PLACE_KEY]: place });
  else await chrome.storage.local.remove(PLACE_KEY);
  placeKept = json;
}

/** An answer from HandsFreeOS, or what went wrong in words for the person. */
export async function call<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
  workspaceId?: string,
): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await request;
  } catch (error) {
    throw error instanceof Refused ? error : refuse(NO_CONNECTION);
  }
  if (result.data !== undefined && result.response.ok) return result.data;
  const status = result.response.status;
  const said = isApiErrorBody(result.error) ? result.error.error : null;
  const rule = said?.rule ?? null;
  if (status === 401) {
    await signOutHere();
    throw refuse('Your HandsFreeOS sign-in ended. Sign in again to keep saving.', {
      status,
      recheck: true,
    });
  }
  if (rule === 'addon_inactive')
    throw refuse(
      `Social Outreach is off for ${workspaceId ? businessName(workspaceId) : 'this business'}. An owner can turn it on in Add-ons.`,
      { status, rule, recheck: true },
    );
  if (said) throw refuse(said.message, { status, rule, recheck: status === 403 });
  throw refuse('Something went wrong in HandsFreeOS. Try again in a minute.', { status });
}

async function signOutHere(): Promise<void> {
  me = null;
  await keepPlace(null).catch(() => undefined);
  await auth()
    .signOut({ scope: 'local' })
    .catch(() => undefined);
}

export async function account(fresh = false): Promise<Account> {
  if (!canSignIn()) return { signedIn: false, canSignIn: false, webUrl: config.webUrl };
  const { data, error } = await auth().getSession();
  // A sign-in that needed refreshing and couldn't be is still a sign-in: HandsFreeOS is only out of reach.
  if (error && isAuthRetryableFetchError(error)) throw refuse(NO_CONNECTION);
  const session = data.session;
  if (!session) {
    me = null;
    await keepPlace(null);
    return { signedIn: false, canSignIn: true, webUrl: config.webUrl };
  }
  const stale = !me || me.userId !== session.user.id || Date.now() - me.at > ME_FOR_MS;
  if (fresh || stale) {
    const found = await call(api().POST('/v1/queries/account.me', { body: {} }));
    me = {
      userId: found.user.id,
      email: found.user.email,
      name: found.user.fullName,
      businesses: outreachBusinesses(found.workspaces),
      at: Date.now(),
    };
  }
  // A sign-out while HandsFreeOS was asked: say signed out rather than show someone gone.
  if (!me) return { signedIn: false, canSignIn: true, webUrl: config.webUrl };
  const picked: unknown = (await chrome.storage.local.get(BUSINESS_KEY))[BUSINESS_KEY];
  const business = me.businesses.find((b) => b.id === picked) ?? me.businesses[0] ?? null;
  await keepPlace(business && { userId: me.userId, businessId: business.id });
  return {
    signedIn: true,
    email: me.email,
    name: me.name,
    businesses: me.businesses,
    businessId: business?.id ?? null,
    webUrl: config.webUrl,
  };
}

/**
 * Who's signed in and the business they save to, for the steps noted in the background: null when either is none.
 * While HandsFreeOS can't be reached to say, it's where their steps last went, until they sign out.
 */
export async function savingTo(): Promise<Place | null> {
  if (!canSignIn()) return null;
  try {
    const now = await account();
    return now.signedIn && now.businessId && me
      ? { userId: me.userId, businessId: now.businessId }
      : null;
  } catch {
    const kept: unknown = (await chrome.storage.local.get(PLACE_KEY))[PLACE_KEY];
    return isPlace(kept) ? kept : null;
  }
}

// ----------------------------------------------------------------------------------- Supabase Auth's refusals

const codeOf = (error: unknown) =>
  isAuthError(error) && typeof error.code === 'string' ? error.code : null;
const noConnection = (error: unknown) =>
  isAuthRetryableFetchError(error) || error instanceof TypeError;
const BANNED = 'This account can’t sign in. Ask the business’s owner.';
const TOO_MANY = 'Too many tries. Wait a minute, then try again.';

function sendCodeWords(error: unknown): string {
  if (noConnection(error)) return NO_CONNECTION;
  switch (codeOf(error)) {
    case 'otp_disabled':
    case 'signup_disabled':
    case 'user_not_found':
      return 'There’s no HandsFreeOS account for that email. New accounts start on the web.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'A code was sent a moment ago. Wait a minute, then send another.';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Check the email address.';
    case 'user_banned':
      return BANNED;
    default:
      return 'The code couldn’t be sent. Try again.';
  }
}

function checkCodeWords(error: unknown): string {
  if (noConnection(error)) return NO_CONNECTION;
  switch (codeOf(error)) {
    case 'otp_expired':
      return 'That code isn’t right, or it has expired. Check the email, or send another code.';
    case 'over_request_rate_limit':
      return TOO_MANY;
    case 'user_banned':
      return BANNED;
    default:
      return 'That code didn’t work. Send another code and try again.';
  }
}

function passwordWords(error: unknown): string {
  if (noConnection(error)) return NO_CONNECTION;
  switch (codeOf(error)) {
    case 'invalid_credentials':
      return 'That email and password don’t match. Try again, or email yourself a code.';
    case 'email_not_confirmed':
      return 'Confirm your email first. Check your inbox for the link.';
    case 'over_request_rate_limit':
      return TOO_MANY;
    case 'user_banned':
      return BANNED;
    default:
      return 'Signing in didn’t work. Try again.';
  }
}

// ------------------------------------------------------------------------------------------------- answering

async function value(ask: SessionAsk): Promise<HfosValues[SessionAsk['type']]> {
  if (ask.type !== 'hfos-account' && !canSignIn())
    throw refuse('This build of the extension can’t sign in to HandsFreeOS.');
  switch (ask.type) {
    case 'hfos-account':
      return account(ask.fresh);
    case 'hfos-send-code': {
      const { error } = await auth().signInWithOtp({
        email: ask.email,
        options: { shouldCreateUser: false },
      });
      if (error) throw refuse(sendCodeWords(error));
      return null;
    }
    case 'hfos-check-code': {
      const { error } = await auth().verifyOtp({
        email: ask.email,
        token: ask.code,
        type: 'email',
      });
      if (error) throw refuse(checkCodeWords(error));
      return account(true);
    }
    case 'hfos-password': {
      const { error } = await auth().signInWithPassword({
        email: ask.email,
        password: ask.password,
      });
      if (error) throw refuse(passwordWords(error));
      return account(true);
    }
    case 'hfos-prompt-start':
      try {
        return await startPrompt(ask.email);
      } catch (error) {
        throw error instanceof PromptRefused ? refuse(error.message) : error;
      }
    case 'hfos-prompt-check': {
      let status: Awaited<ReturnType<typeof checkPrompt>>;
      try {
        status = await checkPrompt(ask.requestId, async (tokenHash) => {
          const { error } = await auth().verifyOtp({ token_hash: tokenHash, type: 'email' });
          if (error) throw refuse(checkCodeWords(error));
        });
      } catch (error) {
        throw error instanceof PromptRefused ? refuse(error.message) : error;
      }
      return status === 'signed-in' ? { status, account: await account(true) } : { status };
    }
    case 'hfos-sign-out':
      await signOutHere();
      return account();
    case 'hfos-pick':
      await chrome.storage.local.set({ [BUSINESS_KEY]: ask.businessId });
      return account();
    case 'hfos-collect-chats':
      return call(
        api().POST('/v1/commands/outreach.chats.collect', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-save-friends':
      return call(
        api().POST('/v1/commands/outreach.friends.save', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-save-download':
      return call(
        api().POST('/v1/commands/outreach.download.save', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-save-groups':
      return call(
        api().POST('/v1/commands/outreach.groups.save', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-save-group':
      return call(
        api().POST('/v1/commands/outreach.group.save', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-groups':
      return call(
        api().POST('/v1/queries/outreach.groups', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-tidy':
      return call(
        api().POST('/v1/queries/outreach.friends.tidy', {
          body: { workspaceId: ask.workspaceId },
        }),
        ask.workspaceId,
      );
    case 'hfos-lists':
      return call(
        api().POST('/v1/queries/outreach.lists', { body: { workspaceId: ask.workspaceId } }),
        ask.workspaceId,
      );
    case 'hfos-lists-saved':
      return call(
        api().POST('/v1/commands/outreach.lists.saved', {
          body: { workspaceId: ask.workspaceId, list: ask.list },
        }),
        ask.workspaceId,
      );
    case 'hfos-friend-end':
      return call(
        api().POST('/v1/commands/outreach.friend.end', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-warning':
      return call(
        api().POST('/v1/commands/outreach.warning.note', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-save-posts':
      return call(
        api().POST('/v1/commands/outreach.posts.save', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-checks-next':
      return call(
        api().POST('/v1/queries/outreach.checks.next', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-check-look':
      return call(
        api().POST('/v1/commands/outreach.check.look', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-groups-to-check':
      return call(
        api().POST('/v1/queries/outreach.groups.to_check', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-group-look':
      return call(
        api().POST('/v1/commands/outreach.group.look', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-joins-next':
      return call(
        api().POST('/v1/queries/outreach.joins.next', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-join-note':
      return call(
        api().POST('/v1/commands/outreach.join.note', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-helpful-ask':
      return call(
        api().POST('/v1/commands/outreach.helpful.ask', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-helpful-next':
      return call(
        api().POST('/v1/queries/outreach.helpful.next', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-helpful-posted':
      return call(
        api().POST('/v1/commands/outreach.helpful.posted', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-helpful-engaged':
      return call(
        api().POST('/v1/commands/outreach.helpful.engaged', { body: ask.input }),
        ask.input.workspaceId,
      );
    case 'hfos-join-answers':
      return call(
        workerPost<JoinAnswerOutput>('/v1/addons/outreach/actions/outreach.join.answer', {
          workspaceId: ask.workspaceId,
          input: ask.input,
        }),
        ask.workspaceId,
      );
    case 'hfos-like-pick':
      return call(
        workerPost<LikePickOutput>('/v1/addons/outreach/actions/outreach.like.pick', {
          workspaceId: ask.workspaceId,
          input: ask.input,
        }),
        ask.workspaceId,
      );
    case 'hfos-draft':
      return call(
        workerPost<Drafts>('/v1/addons/outreach/actions/outreach.today.draft', {
          workspaceId: ask.workspaceId,
          input: ask.input,
        }),
        ask.workspaceId,
      );
  }
}

/**
 * A call to one of Social Outreach's actions on the worker, where the AI is (the AI's drafts), answered in the same
 * shape as an API call so `call` says what went wrong the same way.
 */
async function workerPost<T>(
  path: string,
  body: unknown,
): Promise<{ data?: T; error?: unknown; response: Response }> {
  if (!config.workerUrl) throw refuse('This build of the extension can’t reach the AI.');
  const bearer = await token();
  const response = await fetch(`${config.workerUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => undefined);
  return response.ok ? { data: json as T, response } : { error: json, response };
}

/** The answer to one of the panel's or the jobs' asks. Never throws: what went wrong comes back as a problem. */
export function answer(ask: SessionAsk): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, () => value(ask));
}

/** What `work` came to, as an answer for the panel: what went wrong comes back as a problem. */
export async function answerWith(
  what: HfosAsk['type'],
  work: () => Promise<unknown>,
): Promise<HfosAnswer<unknown>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.problem };
    console.error('HandsFreeOS Social couldn’t answer', what, error);
    return {
      ok: false,
      problem: {
        message: 'Something went wrong. Try again.',
        rule: null,
        status: null,
        recheck: false,
      },
    };
  }
}
