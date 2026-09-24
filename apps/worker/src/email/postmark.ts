/**
 * Postmark over plain HTTPS: sending with the server token, workspace domains with the account token.
 */
import { cnameInDns, dkimInDns, systemDns, type DnsLookup } from './dns';
import {
  EmailError,
  mailbox,
  type DomainState,
  type EmailDomains,
  type EmailTransport,
} from './transport';

const API = 'https://api.postmarkapp.com';

interface Token {
  readonly header: 'X-Postmark-Server-Token' | 'X-Postmark-Account-Token';
  readonly value: string;
}

/** 4xx answers about the request (a bad address, a stopped recipient) are permanent; auth, throttling and outages retry. */
async function call<T>(
  token: Token,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      [token.header]: token.value,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
  if (!res.ok || (json.ErrorCode ?? 0) !== 0) {
    const permanent =
      res.status === 422 ||
      (res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status));
    throw new EmailError(
      json.Message ?? `Postmark answered ${res.status}`,
      String(json.ErrorCode ?? res.status),
      permanent,
      res.status,
    );
  }
  return json as T;
}

interface PostmarkDomain {
  ID: number;
  Name: string;
  DKIMVerified: boolean;
  DKIMHost: string;
  DKIMTextValue: string;
  DKIMPendingHost: string;
  DKIMPendingTextValue: string;
  ReturnPathDomain: string;
  ReturnPathDomainVerified: boolean;
  ReturnPathDomainCNAMEValue: string;
}

/** The records to show: a new or rotating DKIM key is the pending one. */
const stateOf = (d: PostmarkDomain): DomainState => ({
  providerDomainId: String(d.ID),
  dkimHost: d.DKIMPendingHost || d.DKIMHost || null,
  dkimValue: d.DKIMPendingTextValue || d.DKIMTextValue || null,
  returnPathHost: d.ReturnPathDomain || null,
  returnPathValue: d.ReturnPathDomainCNAMEValue || 'pm.mtasv.net',
  dkimVerified: !!d.DKIMVerified,
  returnPathVerified: !!d.ReturnPathDomainVerified,
});

/**
 * Postmark keeps DKIM "verified" once it ever was, even after the record is removed, so what it calls verified
 * is looked up in DNS too (the key that signs now, not a pending one). Only a definite "not there" turns a check
 * off; a lookup that fails trusts Postmark.
 */
async function confirmedInDns(d: PostmarkDomain, dns: DnsLookup): Promise<DomainState> {
  const state = stateOf(d);
  const [dkim, returnPath] = await Promise.all([
    state.dkimVerified && d.DKIMHost && d.DKIMTextValue
      ? dkimInDns(dns, d.DKIMHost, d.DKIMTextValue)
      : null,
    state.returnPathVerified && d.ReturnPathDomain
      ? cnameInDns(dns, d.ReturnPathDomain, d.ReturnPathDomainCNAMEValue || 'pm.mtasv.net')
      : null,
  ]);
  return {
    ...state,
    dkimVerified: state.dkimVerified && dkim !== false,
    returnPathVerified: state.returnPathVerified && returnPath !== false,
  };
}

export function createPostmark(opts: {
  serverToken: string;
  accountToken: string | null;
  stream: string;
  /** The Broadcasts stream campaign email goes on; null until one is set up in Postmark. */
  broadcastStream?: string | null;
  /** DNS lookups for the domain checks (the system resolver unless a test passes its own). */
  dns?: DnsLookup;
}): { transport: EmailTransport; domains: EmailDomains } {
  const server: Token = { header: 'X-Postmark-Server-Token', value: opts.serverToken };
  const account = (): Token => {
    if (!opts.accountToken)
      throw new EmailError('POSTMARK_ACCOUNT_TOKEN is not set', 'no_account_token', false);
    return { header: 'X-Postmark-Account-Token', value: opts.accountToken };
  };
  const dns = opts.dns ?? systemDns;
  const getDomain = async (id: string) =>
    stateOf(await call<PostmarkDomain>(account(), 'GET', `/domains/${id}`));

  return {
    transport: {
      name: 'postmark',
      async send(email) {
        if (email.bulk && !opts.broadcastStream)
          throw new EmailError('POSTMARK_BROADCAST_STREAM is not set', 'broadcast_not_ready', true);
        const res = await call<{ MessageID: string }>(server, 'POST', '/email', {
          From: mailbox(email.from.name, email.from.address),
          To: email.to.join(', '),
          ...(email.cc.length > 0 ? { Cc: email.cc.join(', ') } : {}),
          ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
          Subject: email.subject,
          TextBody: email.text,
          HtmlBody: email.html,
          // Our own Message-ID and thread headers, so replies find their conversation.
          Headers: [
            { Name: 'Message-ID', Value: email.messageIdHeader },
            ...(email.inReplyTo ? [{ Name: 'In-Reply-To', Value: email.inReplyTo }] : []),
            ...(email.references.length > 0
              ? [{ Name: 'References', Value: email.references.join(' ') }]
              : []),
            ...(email.headers ?? []).map((h) => ({ Name: h.name, Value: h.value })),
          ],
          Metadata: email.metadata,
          MessageStream: email.bulk ? opts.broadcastStream : opts.stream,
          TrackOpens: false,
          TrackLinks: 'None',
          ...(email.attachments.length > 0
            ? {
                Attachments: email.attachments.map((a) => ({
                  Name: a.name,
                  Content: a.content.toString('base64'),
                  ContentType: a.contentType,
                  ...(a.contentId ? { ContentID: `cid:${a.contentId}` } : {}),
                })),
              }
            : {}),
        });
        return { providerMessageId: res.MessageID, messageIdHeader: email.messageIdHeader };
      },
    },
    domains: {
      async create(domain) {
        try {
          return stateOf(
            await call<PostmarkDomain>(account(), 'POST', '/domains', {
              Name: domain,
              ReturnPathDomain: `pm-bounces.${domain}`,
            }),
          );
        } catch (e) {
          // 512: already created (a retry after a crash). Find it by name instead.
          if (!(e instanceof EmailError && e.code === '512')) throw e;
          const list = await call<{ Domains: { ID: number; Name: string }[] }>(
            account(),
            'GET',
            '/domains?count=500&offset=0',
          );
          const found = list.Domains.find((d) => d.Name.toLowerCase() === domain.toLowerCase());
          if (!found) throw e;
          return getDomain(String(found.ID));
        }
      },
      get: getDomain,
      async verify(id) {
        for (const step of ['verifyDkim', 'verifyReturnPath'])
          try {
            await call(account(), 'PUT', `/domains/${id}/${step}`);
          } catch (e) {
            // Records not in DNS yet: the state below says which.
            if (!(e instanceof EmailError && e.permanent)) throw e;
          }
        return confirmedInDns(await call<PostmarkDomain>(account(), 'GET', `/domains/${id}`), dns);
      },
      async remove(id) {
        try {
          await call(account(), 'DELETE', `/domains/${id}`);
        } catch (e) {
          if (!(e instanceof EmailError && (e.code === '510' || e.httpStatus === 404))) throw e;
        }
      },
    },
  };
}
