/**
 * Outlook and Microsoft 365 mailboxes through Microsoft Graph: delegated OAuth with PKCE on the `common`
 * endpoint (work, school and personal accounts), delta queries on Inbox and Sent Items, replies through
 * createReply so Outlook threads them, and change notifications on the Inbox as an accelerator.
 */
import type { EmailAttachment } from '../email/transport';
import {
  MailboxAuthError,
  MailboxError,
  oauthFailure,
  parties,
  party,
  providerJson,
  type MailboxProvider,
  type MailFile,
  type SyncedEmail,
  type TokenSet,
} from './provider';

const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Full URIs for Graph scopes; Mail.Read too, because subscriptions want a read scope. */
const SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
];
const REQUIRED = ['Mail.ReadWrite', 'Mail.Send'];
const SELECT =
  'internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,body,receivedDateTime,sentDateTime,hasAttachments,isDraft';
const FOLDERS = [
  ['inbox', 'inbound'],
  ['sentitems', 'outbound'],
] as const;
/** Graph takes attachments under 3 MB in one request; bigger ones go through an upload session. */
const SMALL_FILE = 3 * 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id: string;
  '@removed'?: unknown;
  isDraft?: boolean;
  internetMessageId?: string;
  conversationId?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  subject?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
}
interface DeltaPage {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}
interface FolderState {
  next?: string;
  delta?: string;
}

const toParty = (r?: GraphRecipient) => party(r?.emailAddress?.address, r?.emailAddress?.name);

export function createGraphMailbox(opts: {
  clientId: string | null;
  clientSecret: string | null;
  fetch?: typeof fetch;
}): MailboxProvider {
  const f = opts.fetch ?? fetch;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.clientId || !opts.clientSecret)
      throw new MailboxError('Outlook isn’t set up on this server yet.', null, true);
    const res = await f(`${LOGIN}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: SCOPES.join(' '),
        ...params,
      }),
    });
    if (!res.ok) return oauthFailure('Microsoft', res);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      // A minute early, so a sync never starts with a token about to lapse.
      expiresAt: new Date(Date.now() + Math.max(60, body.expires_in - 60) * 1000).toISOString(),
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
    };
  }

  // Several preferences in one Prefer header, comma-separated (RFC 7240). Immutable ids survive folder moves,
  // so Sent Items and our own sends match up.
  async function api<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await f(path.startsWith('https://') ? path : `${GRAPH}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        prefer: 'IdType="ImmutableId", odata.maxpagesize=25',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    return providerJson<T>('Outlook', res);
  }

  async function attachmentsOf(accessToken: string, id: string): Promise<MailFile[]> {
    const list = await api<{
      value?: {
        id: string;
        name?: string;
        contentType?: string;
        size?: number;
        contentId?: string;
        '@odata.type'?: string;
      }[];
    }>(
      accessToken,
      `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline,contentId`,
    );
    const files: MailFile[] = [];
    for (const a of list.value ?? []) {
      // Files only: attached emails and cloud links have no bytes to keep.
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || (a.size ?? 0) > MAX_FILE)
        continue;
      const res = await f(
        `${GRAPH}/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(a.id)}/$value`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) await providerJson('Outlook', res);
      files.push({
        name: a.name || 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        content: Buffer.from(await res.arrayBuffer()),
        contentId: a.contentId?.replace(/^<|>$/g, '') || null,
      });
      if (files.length >= 20) break;
    }
    return files;
  }

  function toEmail(
    accessToken: string,
    m: GraphMessage,
    direction: 'inbound' | 'outbound',
  ): SyncedEmail | null {
    const from = toParty(m.from);
    if (!from) return null;
    const html = m.body?.contentType === 'html' ? (m.body.content ?? null) : null;
    const text = m.body?.contentType === 'text' ? (m.body.content ?? null) : null;
    return {
      providerMessageId: m.id,
      direction,
      messageIdHeader: m.internetMessageId ?? null,
      // Delta doesn't give In-Reply-To; the conversation id and the address thread it instead.
      inReplyTo: null,
      references: [],
      threadId: m.conversationId ?? null,
      from,
      to: parties((m.toRecipients ?? []).map(toParty)),
      cc: parties((m.ccRecipients ?? []).map(toParty)),
      subject: m.subject ?? null,
      text,
      html,
      occurredAt:
        (direction === 'outbound' ? m.sentDateTime : m.receivedDateTime) ??
        new Date().toISOString(),
      automatic: false,
      // hasAttachments leaves out inline pictures; those show up as cid: in the HTML.
      hasAttachments: !!m.hasAttachments || /src=["']?cid:/i.test(html ?? ''),
      attachments: () => attachmentsOf(accessToken, m.id),
    };
  }

  async function attach(accessToken: string, draftId: string, a: EmailAttachment): Promise<void> {
    const base = `/me/messages/${encodeURIComponent(draftId)}/attachments`;
    if (a.content.length < SMALL_FILE) {
      await api(accessToken, base, {
        method: 'POST',
        body: JSON.stringify({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.name,
          contentType: a.contentType,
          contentBytes: a.content.toString('base64'),
          ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
        }),
      });
      return;
    }
    const session = await api<{ uploadUrl: string }>(accessToken, `${base}/createUploadSession`, {
      method: 'POST',
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: 'file',
          name: a.name,
          size: a.content.length,
          contentType: a.contentType,
        },
      }),
    });
    // Ranges under 4 MB each, and no Authorization header: the upload URL carries its own.
    for (let start = 0; start < a.content.length; start += SMALL_FILE) {
      const end = Math.min(start + SMALL_FILE, a.content.length);
      const res = await f(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end - 1}/${a.content.length}`,
        },
        body: new Uint8Array(a.content.subarray(start, end)),
      });
      if (!res.ok) await providerJson('Outlook', res);
    }
  }

  return {
    name: 'microsoft',
    configured: !!(opts.clientId && opts.clientSecret),
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: opts.clientId ?? '',
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${LOGIN}/authorize?${q}`;
    },
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    async refresh(current) {
      if (!current.refreshToken)
        throw new MailboxAuthError(
          'There is no refresh token to renew the sign-in.',
          'invalid_grant',
        );
      // Microsoft hands back a new refresh token every time; the old one is thrown away with the old seal.
      const next = await token({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    },
    async account(accessToken) {
      const me = await api<{
        mail?: string | null;
        userPrincipalName?: string;
        displayName?: string;
      }>(accessToken, '/me?$select=mail,userPrincipalName,displayName');
      const email = (me.mail || me.userPrincipalName || '').trim().toLowerCase();
      if (!email.includes('@'))
        throw new MailboxError('Microsoft didn’t say which mailbox this is.', null, true);
      return { email, displayName: me.displayName?.trim() || null };
    },
    missingScopes: (granted) =>
      REQUIRED.filter((s) => !granted.some((g) => g.toLowerCase().endsWith(s.toLowerCase()))),
    async sync(accessToken, cursor, since) {
      const emails: SyncedEmail[] = [];
      const next: Record<string, unknown> = { ...cursor };
      let more = false;
      for (const [folder, direction] of FOLDERS) {
        const state = (cursor[folder] ?? {}) as FolderState;
        const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
        const start = `/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${filter}`;
        let page: DeltaPage;
        try {
          page = await api<DeltaPage>(accessToken, state.next ?? state.delta ?? start);
        } catch (e) {
          // An expired delta token means starting the folder over; replays land on the rows we have.
          const expired =
            e instanceof MailboxError &&
            (e.status === 410 ||
              e.status === 404 ||
              (e.status === 400 && /syncstatenotfound|resyncrequired/i.test(e.message)));
          if (!expired || (!state.next && !state.delta)) throw e;
          page = await api<DeltaPage>(accessToken, start);
        }
        for (const m of page.value ?? []) {
          if (m['@removed'] || m.isDraft) continue;
          const email = toEmail(accessToken, m, direction);
          if (email) emails.push(email);
        }
        if (page['@odata.nextLink']) {
          next[folder] = { next: page['@odata.nextLink'] };
          more = true;
        } else if (page['@odata.deltaLink']) next[folder] = { delta: page['@odata.deltaLink'] };
      }
      return { emails, cursor: next, more };
    },
    async send(accessToken, e) {
      const recipients = (list: readonly string[]) =>
        list.map((address) => ({ emailAddress: { address } }));
      const message = {
        subject: e.subject,
        body: { contentType: 'HTML', content: e.html },
        toRecipients: recipients(e.to),
        ccRecipients: recipients(e.cc),
      };
      type Draft = { id: string; internetMessageId?: string; conversationId?: string };
      const fresh = () =>
        api<Draft>(accessToken, '/me/messages', { method: 'POST', body: JSON.stringify(message) });
      let draft: Draft;
      if (e.replyToProviderMessageId) {
        try {
          const reply = await api<Draft>(
            accessToken,
            `/me/messages/${encodeURIComponent(e.replyToProviderMessageId)}/createReply`,
            { method: 'POST', body: JSON.stringify({}) },
          );
          draft = await api<Draft>(accessToken, `/me/messages/${encodeURIComponent(reply.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(message),
          });
        } catch (err) {
          // The customer's message was deleted or moved out of reach: a new email instead.
          if (!(err instanceof MailboxError && err.status === 404)) throw err;
          draft = await fresh();
        }
      } else draft = await fresh();
      for (const a of e.attachments) await attach(accessToken, draft.id, a);
      await api(accessToken, `/me/messages/${encodeURIComponent(draft.id)}/send`, {
        method: 'POST',
      });
      return {
        providerMessageId: draft.id,
        messageIdHeader: draft.internetMessageId ?? e.messageIdHeader,
        threadId: draft.conversationId ?? null,
      };
    },
    notifications: {
      async subscribe(accessToken, input) {
        const s = await api<{ id: string; expirationDateTime: string }>(
          accessToken,
          '/subscriptions',
          {
            method: 'POST',
            body: JSON.stringify({
              changeType: 'created',
              notificationUrl: input.notificationUrl,
              lifecycleNotificationUrl: input.lifecycleUrl,
              resource: "me/mailFolders('inbox')/messages",
              expirationDateTime: input.expiresAt.toISOString(),
              clientState: input.clientState,
              latestSupportedTlsVersion: 'v1_2',
            }),
          },
        );
        return { id: s.id, expiresAt: s.expirationDateTime };
      },
      async renew(accessToken, subscriptionId, expiresAt) {
        const s = await api<{ id?: string; expirationDateTime?: string }>(
          accessToken,
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
          },
        );
        return {
          id: s.id ?? subscriptionId,
          expiresAt: s.expirationDateTime ?? expiresAt.toISOString(),
        };
      },
    },
  };
}
