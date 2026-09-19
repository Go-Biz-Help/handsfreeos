/**
 * Local and test mailboxes. Signing in is a page on the worker itself (PKCE is checked like the real thing),
 * and each account's mail lives in memory: tests and the browser specs deliver mail into it, and what
 * HandsFreeOS sends lands in the account's Sent folder, so the next sync sees it the way Outlook would.
 * Nothing here looks like a secret: the tokens name the account and say they're fake.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  MailboxAuthError,
  MailboxError,
  pkceChallenge,
  type MailboxProvider,
  type MailboxProviderName,
  type MailFile,
  type MailParty,
  type SyncedEmail,
  type TokenSet,
} from './provider';

type StoredEmail = Omit<SyncedEmail, 'attachments'> & {
  readonly seq: number;
  readonly files: MailFile[];
};

export interface FakeDelivery {
  readonly from: MailParty;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | null;
  readonly to?: readonly MailParty[];
  readonly files?: readonly MailFile[];
  readonly messageIdHeader?: string;
  readonly inReplyTo?: string | null;
}

export interface FakeMailboxes {
  readonly providers: Record<MailboxProviderName, MailboxProvider>;
  /** Someone emails the account. Returns the provider's id for it. */
  deliver(account: string, email: FakeDelivery): string;
  /** What the account sent through HandsFreeOS. */
  sent(account: string): readonly StoredEmail[];
  /** The account's next refresh fails the way a revoked sign-in does. */
  revoke(account: string): void;
}

const enc = (s: string) => Buffer.from(s).toString('base64url');
const dec = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const HOUR = 3_600_000;
const SCOPES: Record<MailboxProviderName, string[]> = {
  microsoft: ['offline_access', 'User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send'],
  google: ['gmail.readonly', 'gmail.send'],
};

export function createFakeMailboxes(opts: { publicUrl: string }): FakeMailboxes {
  const boxes = new Map<string, StoredEmail[]>();
  const revoked = new Set<string>();
  let seq = 0;
  const box = (account: string) => {
    const key = account.toLowerCase();
    let list = boxes.get(key);
    if (!list) boxes.set(key, (list = []));
    return list;
  };
  const tokens = (provider: MailboxProviderName, email: string): TokenSet => ({
    accessToken: `fake-access.${enc(email)}.${randomBytes(6).toString('hex')}`,
    refreshToken: `fake-refresh.${enc(email)}`,
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    scopes: SCOPES[provider],
  });
  const emailOf = (token: string) => {
    const [kind, who] = token.split('.');
    if (!kind?.startsWith('fake-') || !who) throw new MailboxError('Not a fake token.', 401);
    return dec(who);
  };

  const provider = (name: MailboxProviderName): MailboxProvider => ({
    name,
    configured: true,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        state,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
      });
      return `${opts.publicUrl}/oauth/fake/${name}/authorize?${q}`;
    },
    async exchangeCode({ code, codeVerifier }) {
      const [prefix, body] = code.split('.');
      if (prefix !== 'fakecode' || !body) throw new MailboxAuthError('Bad code.', 'invalid_grant');
      const c = JSON.parse(dec(body)) as { email: string; challenge: string; provider: string };
      if (c.provider !== name || c.challenge !== pkceChallenge(codeVerifier))
        throw new MailboxAuthError('The code verifier does not match.', 'invalid_grant');
      return tokens(name, c.email);
    },
    async refresh(current) {
      const email = emailOf(current.refreshToken ?? '');
      if (revoked.delete(email.toLowerCase()))
        throw new MailboxAuthError('The sign-in was revoked.', 'invalid_grant');
      return tokens(name, email);
    },
    async account(accessToken) {
      const email = emailOf(accessToken);
      return { email, displayName: null };
    },
    missingScopes: () => [],
    async sync(accessToken, cursor) {
      const from = Number(cursor['seq'] ?? 0);
      const list = box(emailOf(accessToken)).filter((e) => e.seq > from);
      const last = list.reduce((n, e) => Math.max(n, e.seq), from);
      return {
        emails: list.map(({ files, ...e }) => ({ ...e, attachments: async () => files })),
        cursor: { seq: last },
        more: false,
      };
    },
    async send(accessToken, email) {
      const account = emailOf(accessToken);
      const n = ++seq;
      // Outlook assigns its own Message-ID; Gmail keeps the one we built.
      const header =
        name === 'microsoft'
          ? `<fake-${n}-${randomUUID().slice(0, 8)}@outlook.fake>`
          : email.messageIdHeader;
      const id = `fake-${name}-sent-${n}`;
      box(account).push({
        seq: n,
        providerMessageId: id,
        direction: 'outbound',
        messageIdHeader: header,
        inReplyTo: email.inReplyTo,
        references: [...email.references],
        threadId: email.threadId ?? `fake-thread-${n}`,
        from: { address: account, name: email.from.name },
        to: email.to.map((address) => ({ address, name: null })),
        cc: email.cc.map((address) => ({ address, name: null })),
        subject: email.subject,
        text: email.text,
        html: null,
        occurredAt: new Date().toISOString(),
        automatic: false,
        hasAttachments: email.attachments.length > 0,
        files: email.attachments.map((a) => ({
          name: a.name,
          contentType: a.contentType,
          content: a.content,
          contentId: a.contentId ?? null,
        })),
      });
      return { providerMessageId: id, messageIdHeader: header, threadId: email.threadId };
    },
    ...(name === 'microsoft'
      ? {
          notifications: {
            async subscribe(_token: string, input: { expiresAt: Date }) {
              return { id: `fake-sub-${randomUUID()}`, expiresAt: input.expiresAt.toISOString() };
            },
            async renew(_token: string, subscriptionId: string, expiresAt: Date) {
              return { id: subscriptionId, expiresAt: expiresAt.toISOString() };
            },
          },
        }
      : {}),
  });

  return {
    providers: { microsoft: provider('microsoft'), google: provider('google') },
    deliver(account, email) {
      const n = ++seq;
      const id = `fake-inbox-${n}`;
      const files = [...(email.files ?? [])];
      box(account).push({
        seq: n,
        providerMessageId: id,
        direction: 'inbound',
        messageIdHeader: email.messageIdHeader ?? `<${randomUUID()}@customer.fake>`,
        inReplyTo: email.inReplyTo ?? null,
        references: email.inReplyTo ? [email.inReplyTo] : [],
        threadId: `fake-thread-${n}`,
        from: email.from,
        to: email.to ? [...email.to] : [{ address: account.toLowerCase(), name: null }],
        cc: [],
        subject: email.subject,
        text: email.text,
        html: email.html ?? null,
        occurredAt: new Date().toISOString(),
        automatic: false,
        hasAttachments: files.length > 0,
        files,
      });
      return id;
    },
    sent: (account) => box(account).filter((e) => e.direction === 'outbound'),
    revoke(account) {
      revoked.add(account.toLowerCase());
    },
  };
}

/**
 * The fake sign-in's authorization code: who signed in and the PKCE challenge, so the exchange can check it.
 *
 * The provider is a plain string because one stand-in page now serves mailboxes, calendars and the places
 * public reviews come from, and Facebook is none of the first two.
 */
export const fakeCode = (provider: string, email: string, challenge: string): string =>
  `fakecode.${enc(JSON.stringify({ email: email.trim().toLowerCase(), challenge, provider }))}`;
