/**
 * Connected mailboxes (Outlook through Microsoft Graph, Gmail through the Gmail API) behind one seam, so the
 * sign-in routes, the sync job and sending never name a provider. A fake stands in locally and in tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { EmailAttachment } from '../email/transport';

export type MailboxProviderName = 'microsoft' | 'google';

/** What a sign-in or a refresh gives us. Sealed as JSON before it touches the database. */
export interface TokenSet {
  readonly accessToken: string;
  /** Microsoft rotates it on every refresh; Google keeps the first one. */
  readonly refreshToken: string | null;
  /** When the access token stops working (ISO). */
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

export interface MailboxAccount {
  readonly email: string;
  readonly displayName: string | null;
}

export interface MailParty {
  readonly address: string;
  readonly name: string | null;
}

export interface MailFile {
  readonly name: string;
  readonly contentType: string;
  readonly content: Buffer;
  /** For images the HTML shows inline (cid:), without angle brackets. */
  readonly contentId: string | null;
}

/** One email the mailbox received or sent, as the sync job files it. */
export interface SyncedEmail {
  /** The provider's own id (Graph's immutable id, Gmail's message id). */
  readonly providerMessageId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly threadId: string | null;
  readonly from: MailParty;
  readonly to: readonly MailParty[];
  readonly cc: readonly MailParty[];
  readonly subject: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly occurredAt: string;
  /** Auto-replies and bulk mail, when the provider shows the headers. */
  readonly automatic: boolean;
  readonly hasAttachments: boolean;
  /** Downloaded only for mail with customers: other mail stays private. */
  attachments(): Promise<MailFile[]>;
}

export interface SyncPage {
  readonly emails: readonly SyncedEmail[];
  /** Where the next page or the next sync starts; stored as is in mailbox_connections.sync_cursor. */
  readonly cursor: Readonly<Record<string, unknown>>;
  /** More pages are waiting right now. */
  readonly more: boolean;
}

export interface MailboxSend {
  readonly from: MailParty;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Ours. Gmail keeps it; Outlook assigns its own (the result says which). */
  readonly messageIdHeader: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly attachments: readonly EmailAttachment[];
  /** The customer's message this answers, by the provider's id: Outlook replies in its thread. */
  readonly replyToProviderMessageId: string | null;
  /** Gmail threads by id (with matching headers and subject). */
  readonly threadId: string | null;
}

export interface MailboxSent {
  readonly providerMessageId: string;
  readonly messageIdHeader: string;
  readonly threadId: string | null;
}

export interface Subscription {
  readonly id: string;
  readonly expiresAt: string;
}

export interface MailboxProvider {
  readonly name: MailboxProviderName;
  /** This server has the provider's OAuth app (client id and secret). */
  readonly configured: boolean;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  account(accessToken: string): Promise<MailboxAccount>;
  /** Scopes the owner left out (Google lets people untick some); the connection needs them all. */
  missingScopes(granted: readonly string[]): string[];
  /** One page of mail since the cursor; an empty cursor starts from `since`. */
  sync(
    accessToken: string,
    cursor: Readonly<Record<string, unknown>>,
    since: Date,
  ): Promise<SyncPage>;
  send(accessToken: string, email: MailboxSend): Promise<MailboxSent>;
  /** Outlook tells us about new mail; Gmail is polled. */
  readonly notifications?: {
    subscribe(
      accessToken: string,
      input: {
        notificationUrl: string;
        lifecycleUrl: string;
        clientState: string;
        expiresAt: Date;
      },
    ): Promise<Subscription>;
    renew(accessToken: string, subscriptionId: string, expiresAt: Date): Promise<Subscription>;
  };
}

/** The provider no longer accepts the sign-in (revoked, expired, password reset): the owner must reconnect. */
export class MailboxAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MailboxAuthError';
  }
}

/**
 * Any other refusal. Permanent ones are recorded (an email that can't go out); the rest retry, after
 * `retryAfterMs` when the provider is throttling.
 */
export class MailboxError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly permanent = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'MailboxError';
  }
}

/** OAuth errors that mean "sign in again". Keyed on the `error` string, never its description. */
const RECONNECT = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
]);

/** Turns a failed OAuth token response into the right error. */
export async function oauthFailure(provider: string, res: Response): Promise<never> {
  let body: { error?: string } = {};
  try {
    body = (await res.json()) as { error?: string };
  } catch {
    // Not JSON: the status says enough.
  }
  const code = body.error ?? `http_${res.status}`;
  if (RECONNECT.has(code))
    throw new MailboxAuthError(
      `${provider} needs the mailbox's owner to sign in again (${code}).`,
      code,
    );
  throw new MailboxError(
    `${provider} refused the sign-in (${code}).`,
    res.status,
    res.status >= 400 && res.status < 500 && code !== 'temporarily_unavailable',
  );
}

/** Reads a provider API response, or throws a MailboxError that says whether to retry. */
export async function providerJson<T>(provider: string, res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 202 || res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
    detail = typeof body.error === 'string' ? body.error : (body.error?.code ?? '');
  } catch {
    // Not JSON.
  }
  const seconds = Number(res.headers.get('retry-after'));
  const transient = [401, 408, 409, 423, 429].includes(res.status) || res.status >= 500;
  throw new MailboxError(
    `${provider} answered ${res.status}${detail ? ` (${detail})` : ''}.`,
    res.status,
    !transient,
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
  );
}

/** A PKCE pair: the verifier stays with us (sealed), the challenge goes to the provider. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/** Lower-cased addresses that look like addresses; everything else is dropped. */
export function party(address: string | null | undefined, name?: string | null): MailParty | null {
  const a = (address ?? '').trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)
    ? { address: a, name: name?.trim() || null }
    : null;
}

export const parties = (list: readonly (MailParty | null)[]): MailParty[] =>
  list.filter((p): p is MailParty => p !== null).slice(0, 50);
