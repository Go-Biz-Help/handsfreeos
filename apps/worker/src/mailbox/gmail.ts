/**
 * Gmail through the Gmail API: OAuth with offline access and PKCE, a first sync over recent mail and then
 * `history.list` polling (no Pub/Sub push this milestone), and sends as raw MIME in the customer's thread.
 * Gmail opens to clients after Google's restricted-scope review; until then it's for Chris's own account.
 */
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { isAutomatic, messageIds } from '../email/render';
import {
  MailboxAuthError,
  MailboxError,
  oauthFailure,
  party,
  providerJson,
  type MailboxProvider,
  type MailFile,
  type MailParty,
  type SyncedEmail,
  type TokenSet,
} from './provider';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD =
  'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
const PAGE = 25;
const MAX_FILE = 25 * 1024 * 1024;

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}
interface Cursor {
  historyId?: string;
  pageToken?: string;
  backfill?: { startHistoryId: string; pageToken?: string | null };
}

const headerOf = (headers: readonly GmailHeader[] | undefined, name: string): string | null =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/** "Mike Johnson" <mike@x.com>, pat@y.com: commas inside quoted names don't split. */
export function addressList(value: string | null): MailParty[] {
  if (!value) return [];
  const out: MailParty[] = [];
  for (const piece of value.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(piece);
    const p = m ? party(m[2], m[1]) : party(piece.trim(), null);
    if (p) out.push(p);
  }
  return out.slice(0, 50);
}

const decode = (data: string | undefined) =>
  data ? Buffer.from(data, 'base64url') : Buffer.alloc(0);

/** The first plain and HTML bodies, and the parts that are files. */
function walk(
  part: GmailPart | undefined,
  found: { text?: string; html?: string; files: GmailPart[] },
) {
  if (!part) return found;
  const disposition = headerOf(part.headers, 'Content-Disposition') ?? '';
  if (part.filename && (part.body?.attachmentId || part.body?.data)) found.files.push(part);
  else if (
    part.mimeType === 'text/plain' &&
    !/attachment/i.test(disposition) &&
    found.text === undefined
  )
    found.text = decode(part.body?.data).toString('utf8');
  else if (
    part.mimeType === 'text/html' &&
    !/attachment/i.test(disposition) &&
    found.html === undefined
  )
    found.html = decode(part.body?.data).toString('utf8');
  for (const p of part.parts ?? []) walk(p, found);
  return found;
}

export function createGmailMailbox(opts: {
  clientId: string | null;
  clientSecret: string | null;
  fetch?: typeof fetch;
}): MailboxProvider {
  const f = opts.fetch ?? fetch;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.clientId || !opts.clientSecret)
      throw new MailboxError('Gmail isn’t set up on this server yet.', null, true);
    const res = await f(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        ...params,
      }),
    });
    if (!res.ok) return oauthFailure('Google', res);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: new Date(Date.now() + Math.max(60, body.expires_in - 60) * 1000).toISOString(),
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
    };
  }

  async function api<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await f(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    return providerJson<T>('Gmail', res);
  }

  async function fileOf(
    accessToken: string,
    messageId: string,
    part: GmailPart,
  ): Promise<MailFile> {
    const content = part.body?.attachmentId
      ? decode(
          (
            await api<{ data?: string }>(
              accessToken,
              `/messages/${messageId}/attachments/${part.body.attachmentId}`,
            )
          ).data,
        )
      : decode(part.body?.data);
    return {
      name: part.filename || 'attachment',
      contentType: part.mimeType || 'application/octet-stream',
      content,
      contentId: headerOf(part.headers, 'Content-ID')?.replace(/^<|>$/g, '') || null,
    };
  }

  function toEmail(accessToken: string, m: GmailMessage): SyncedEmail | null {
    const labels = m.labelIds ?? [];
    if (labels.includes('DRAFT') || labels.includes('CHAT')) return null;
    const headers = m.payload?.headers ?? [];
    const from = addressList(headerOf(headers, 'From'))[0];
    if (!from) return null;
    const body = walk(m.payload, { files: [] });
    const files = body.files.filter((p) => (p.body?.size ?? 0) <= MAX_FILE).slice(0, 20);
    return {
      providerMessageId: m.id,
      direction: labels.includes('SENT') ? 'outbound' : 'inbound',
      messageIdHeader: messageIds(headerOf(headers, 'Message-ID'))[0] ?? null,
      inReplyTo: messageIds(headerOf(headers, 'In-Reply-To'))[0] ?? null,
      references: messageIds(headerOf(headers, 'References')),
      threadId: m.threadId ?? null,
      from,
      to: addressList(headerOf(headers, 'To')),
      cc: addressList(headerOf(headers, 'Cc')),
      subject: headerOf(headers, 'Subject'),
      text: body.text ?? null,
      html: body.html ?? null,
      // internalDate is when Gmail got it: more reliable than the Date header.
      occurredAt: m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date().toISOString(),
      automatic: isAutomatic(headers.map((h) => ({ Name: h.name, Value: h.value }))),
      hasAttachments: files.length > 0,
      attachments: () => Promise.all(files.map((p) => fileOf(accessToken, m.id, p))),
    };
  }

  async function fetchAll(accessToken: string, ids: readonly string[]): Promise<SyncedEmail[]> {
    const out: SyncedEmail[] = [];
    for (const id of ids) {
      try {
        const m = await api<GmailMessage>(accessToken, `/messages/${id}?format=full`);
        const email = toEmail(accessToken, m);
        if (email) out.push(email);
      } catch (e) {
        // Deleted since the history said it arrived.
        if (!(e instanceof MailboxError && e.status === 404)) throw e;
      }
    }
    return out;
  }

  async function sync(accessToken: string, raw: Readonly<Record<string, unknown>>, since: Date) {
    let cursor = raw as Cursor;
    if (!cursor.historyId && !cursor.backfill) {
      // First sync: note where history stands now, then page through recent mail.
      const profile = await api<{ historyId: string }>(accessToken, '/profile');
      cursor = { backfill: { startHistoryId: profile.historyId, pageToken: null } };
    }
    if (cursor.backfill) {
      const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000));
      const q = new URLSearchParams({
        q: `newer_than:${days}d -in:drafts -in:chats`,
        maxResults: String(PAGE),
      });
      if (cursor.backfill.pageToken) q.set('pageToken', cursor.backfill.pageToken);
      const list = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
        accessToken,
        `/messages?${q}`,
      );
      const emails = await fetchAll(
        accessToken,
        (list.messages ?? []).map((m) => m.id),
      );
      return list.nextPageToken
        ? {
            emails,
            cursor: { backfill: { ...cursor.backfill, pageToken: list.nextPageToken } },
            more: true,
          }
        : { emails, cursor: { historyId: cursor.backfill.startHistoryId }, more: false };
    }
    const q = new URLSearchParams({
      startHistoryId: String(cursor.historyId),
      historyTypes: 'messageAdded',
      maxResults: '100',
    });
    if (cursor.pageToken) q.set('pageToken', cursor.pageToken);
    let h: {
      history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
      nextPageToken?: string;
      historyId?: string;
    };
    try {
      h = await api(accessToken, `/history?${q}`);
    } catch (e) {
      // History that old is gone: start over (replays land on the rows we have).
      if (e instanceof MailboxError && e.status === 404) return sync(accessToken, {}, since);
      throw e;
    }
    const ids = [
      ...new Set(
        (h.history ?? [])
          .flatMap((x) => (x.messagesAdded ?? []).map((a) => a.message))
          .filter((m) => !(m.labelIds ?? []).includes('DRAFT'))
          .map((m) => m.id),
      ),
    ];
    const emails = await fetchAll(accessToken, ids);
    return h.nextPageToken
      ? { emails, cursor: { historyId: cursor.historyId, pageToken: h.nextPageToken }, more: true }
      : { emails, cursor: { historyId: h.historyId ?? cursor.historyId }, more: false };
  }

  return {
    name: 'google',
    configured: !!(opts.clientId && opts.clientSecret),
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: opts.clientId ?? '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        // Offline access and a consent screen every time, so a reconnect always brings a refresh token.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${AUTH}?${q}`;
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
      const next = await token({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      // Google keeps the first refresh token unless it sends a new one.
      return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    },
    async account(accessToken) {
      const p = await api<{ emailAddress?: string }>(accessToken, '/profile');
      const email = (p.emailAddress ?? '').trim().toLowerCase();
      if (!email.includes('@'))
        throw new MailboxError('Google didn’t say which mailbox this is.', null, true);
      return { email, displayName: null };
    },
    missingScopes: (granted) => SCOPES.filter((s) => !granted.includes(s)),
    sync,
    async send(accessToken, e) {
      const raw = await new Promise<Buffer>((resolve, reject) =>
        new MailComposer({
          from: { name: e.from.name ?? '', address: e.from.address },
          to: [...e.to],
          cc: [...e.cc],
          subject: e.subject,
          text: e.text,
          html: e.html,
          messageId: e.messageIdHeader,
          ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}),
          ...(e.references.length > 0 ? { references: [...e.references] } : {}),
          attachments: e.attachments.map((a) => ({
            filename: a.name,
            content: a.content,
            contentType: a.contentType,
            ...(a.contentId ? { cid: a.contentId } : {}),
          })),
        })
          .compile()
          .build((err, buf) => (err ? reject(err) : resolve(buf))),
      );
      // The upload endpoint takes up to 35 MB and still carries the thread id.
      const boundary = `hfos-${randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
            e.threadId ? { threadId: e.threadId } : {},
          )}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
        ),
        raw,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const res = await f(UPLOAD, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body: new Uint8Array(body),
      });
      const sent = await providerJson<{ id: string; threadId?: string }>('Gmail', res);
      // Gmail normally keeps our Message-ID; read it back to be sure the synced copy matches this row.
      let header = e.messageIdHeader;
      try {
        const meta = await api<GmailMessage>(
          accessToken,
          `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
        );
        header = messageIds(headerOf(meta.payload?.headers, 'Message-ID'))[0] ?? header;
      } catch {
        // Keep ours.
      }
      return {
        providerMessageId: sent.id,
        messageIdHeader: header,
        threadId: sent.threadId ?? e.threadId,
      };
    },
  };
}
