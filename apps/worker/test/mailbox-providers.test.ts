/**
 * The real Outlook and Gmail providers against recorded responses: no network, no accounts. What they send
 * (URLs, PKCE, scopes, bodies) and how they read what comes back (paging, errors, MIME) is what's checked.
 */
import { describe, expect, it } from 'vitest';
import { addressList, createGmailMailbox } from '../src/mailbox/gmail';
import { createGraphMailbox } from '../src/mailbox/graph';
import { MailboxAuthError, MailboxError, type TokenSet } from '../src/mailbox/provider';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
type Route = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recorded(routes: Route[]) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const b = init.body;
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body:
        typeof b === 'string'
          ? b
          : b instanceof URLSearchParams
            ? b.toString()
            : b instanceof Uint8Array
              ? Buffer.from(b).toString('utf8')
              : '',
    };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return json({ error: { code: 'NotRecorded' } }, 404);
  }) as typeof fetch;
  return { f, calls };
}

/** The error a call that should be refused threw. */
const refusedWith = (p: Promise<unknown>): Promise<MailboxError> =>
  p.then(
    () => {
      throw new Error('it should have been refused');
    },
    (e: unknown) => e as MailboxError,
  );

const tokens: TokenSet = {
  accessToken: 'access-example',
  refreshToken: 'refresh-example',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scopes: [],
};

describe('Outlook (Microsoft Graph)', () => {
  const graph = (routes: Route[]) => {
    const r = recorded(routes);
    return {
      ...r,
      p: createGraphMailbox({
        clientId: 'client-example',
        clientSecret: 'secret-example',
        fetch: r.f,
      }),
    };
  };

  it('asks for mail scopes with PKCE on the common endpoint', () => {
    const { p } = graph([]);
    const url = new URL(
      p.authorizeUrl({ state: 'st', codeChallenge: 'ch', redirectUri: 'https://hooks.example/cb' }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      response_mode: 'query',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
      redirect_uri: 'https://hooks.example/cb',
    });
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).toContain('https://graph.microsoft.com/Mail.Send');
    expect(p.missingScopes(['Mail.Read', 'Mail.ReadWrite'])).toEqual(['Mail.Send']);
  });

  it('keeps the rotated refresh token, and invalid_grant means reconnect', async () => {
    let n = 0;
    const { p, calls } = graph([
      (c) =>
        c.url.endsWith('/token')
          ? n++ === 0
            ? json({
                access_token: 'a2',
                refresh_token: 'r2',
                expires_in: 3599,
                scope: 'Mail.Send',
              })
            : json({ error: 'invalid_grant', error_codes: [70008] }, 400)
          : undefined,
    ]);
    const next = await p.refresh(tokens);
    expect(next).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', scopes: ['Mail.Send'] });
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
    expect(calls[0]!.body).toContain('refresh_token=refresh-example');
    await expect(p.refresh(next)).rejects.toBeInstanceOf(MailboxAuthError);
  });

  it('names Graph’s error code when it refuses', async () => {
    const { p } = graph([
      () => json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403),
    ]);
    const e = await refusedWith(p.account('access-example'));
    expect(e).toMatchObject({ status: 403, permanent: true });
    expect(e.message).toBe('Outlook answered 403 (ErrorAccessDenied): Access is denied.');
  });

  it('a bad client secret is our problem, not a reconnect', async () => {
    const { p } = graph([() => json({ error: 'invalid_client' }, 401)]);
    const e = await p.refresh(tokens).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(MailboxError);
    expect(e).not.toBeInstanceOf(MailboxAuthError);
  });

  it('pages through Inbox and Sent Items deltas, skipping drafts and deletions', async () => {
    const message = (id: string, from: string, extra: Record<string, unknown> = {}) => ({
      id,
      internetMessageId: `<${id}@example.com>`,
      conversationId: 'conv-1',
      from: { emailAddress: { name: 'Pat', address: from } },
      toRecipients: [{ emailAddress: { address: 'owner@business.example' } }],
      subject: 'Water heater',
      body: { contentType: 'html', content: '<p>Tuesday?</p>' },
      receivedDateTime: '2026-09-12T14:00:00Z',
      sentDateTime: '2026-09-12T13:59:00Z',
      hasAttachments: false,
      ...extra,
    });
    const { p, calls } = graph([
      (c) =>
        c.url.includes('/mailFolders/inbox/messages/delta?')
          ? json({
              value: [
                message('m1', 'pat@example.com'),
                message('m2', 'pat@example.com', { isDraft: true }),
                { id: 'gone', '@removed': { reason: 'deleted' } },
              ],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-inbox',
            })
          : undefined,
      (c) =>
        c.url.includes('/mailFolders/sentitems/messages/delta?')
          ? json({
              value: [message('s1', 'owner@business.example')],
              '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-sent',
            })
          : undefined,
      (c) =>
        c.url === 'https://graph.microsoft.com/v1.0/next-inbox'
          ? json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-inbox' })
          : undefined,
      (c) =>
        c.url === 'https://graph.microsoft.com/v1.0/delta-sent'
          ? json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-sent' })
          : undefined,
    ]);
    const since = new Date('2026-08-13T00:00:00Z');
    const first = await p.sync('access-example', {}, since);
    expect(first.more).toBe(true);
    expect(first.emails.map((e) => [e.providerMessageId, e.direction])).toEqual([
      ['m1', 'inbound'],
      ['s1', 'outbound'],
    ]);
    expect(first.emails[0]).toMatchObject({
      messageIdHeader: '<m1@example.com>',
      threadId: 'conv-1',
      from: { address: 'pat@example.com', name: 'Pat' },
      html: '<p>Tuesday?</p>',
    });
    expect(calls[0]!.url).toContain(
      `$filter=${encodeURIComponent('receivedDateTime ge 2026-08-13T00:00:00.000Z')}`,
    );
    expect(calls[0]!.headers['prefer']).toContain('IdType="ImmutableId"');
    expect(first.cursor).toEqual({
      inbox: { next: 'https://graph.microsoft.com/v1.0/next-inbox' },
      sentitems: { delta: 'https://graph.microsoft.com/v1.0/delta-sent' },
    });
    const second = await p.sync('access-example', first.cursor, since);
    expect(second.more).toBe(false);
    expect(second.cursor).toEqual({
      inbox: { delta: 'https://graph.microsoft.com/v1.0/delta-inbox' },
      sentitems: { delta: 'https://graph.microsoft.com/v1.0/delta-sent' },
    });
  });

  it('starts a folder over when its delta token expired', async () => {
    const { p } = graph([
      (c) =>
        c.url === 'https://graph.microsoft.com/v1.0/old-delta'
          ? json({ error: { code: 'SyncStateNotFound' } }, 400)
          : undefined,
      (c) =>
        c.url.includes('/messages/delta?')
          ? json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/fresh' })
          : undefined,
    ]);
    const page = await p.sync(
      'access-example',
      { inbox: { delta: 'https://graph.microsoft.com/v1.0/old-delta' } },
      new Date(),
    );
    expect(page.cursor['inbox']).toEqual({ delta: 'https://graph.microsoft.com/v1.0/fresh' });
  });

  it('replies in the thread: createReply, the body, the files, then send', async () => {
    const { p, calls } = graph([
      (c) =>
        c.url.endsWith('/createReply')
          ? json(
              {
                id: 'draft-1',
                internetMessageId: '<draft-1@outlook.example>',
                conversationId: 'conv-1',
              },
              201,
            )
          : undefined,
      (c) =>
        c.method === 'PATCH'
          ? json({
              id: 'draft-1',
              internetMessageId: '<draft-1@outlook.example>',
              conversationId: 'conv-1',
            })
          : undefined,
      (c) => (c.url.endsWith('/attachments') ? json({ id: 'att-1' }, 201) : undefined),
      (c) => (c.url.endsWith('/send') ? new Response(null, { status: 202 }) : undefined),
    ]);
    const sent = await p.send('access-example', {
      from: { address: 'owner@business.example', name: 'Dale' },
      to: ['pat@example.com'],
      cc: [],
      subject: 'Re: Water heater',
      text: 'Tuesday works.',
      html: '<p>Tuesday works.</p>',
      messageIdHeader: '<ours@mail.handsfreeos.com>',
      inReplyTo: '<m1@example.com>',
      references: ['<m1@example.com>'],
      attachments: [
        { name: 'estimate.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') },
      ],
      replyToProviderMessageId: 'm1',
      threadId: null,
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1.0/me/messages/m1/createReply',
      'PATCH /v1.0/me/messages/draft-1',
      'POST /v1.0/me/messages/draft-1/attachments',
      'POST /v1.0/me/messages/draft-1/send',
    ]);
    expect(JSON.parse(calls[1]!.body)).toMatchObject({
      body: { contentType: 'HTML', content: '<p>Tuesday works.</p>' },
      toRecipients: [{ emailAddress: { address: 'pat@example.com' } }],
    });
    expect(JSON.parse(calls[2]!.body)).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      contentBytes: Buffer.from('pdf').toString('base64'),
    });
    expect(sent).toEqual({
      providerMessageId: 'draft-1',
      messageIdHeader: '<draft-1@outlook.example>',
      threadId: 'conv-1',
    });
  });

  it('subscribes to new Inbox mail with a clientState and a lifecycle URL', async () => {
    const { p, calls } = graph([
      (c) =>
        c.url.endsWith('/subscriptions')
          ? json({ id: 'sub-1', expirationDateTime: '2026-09-15T10:00:00Z' }, 201)
          : undefined,
    ]);
    const sub = await p.notifications!.subscribe('access-example', {
      notificationUrl: 'https://hooks.example/webhooks/graph/notifications',
      lifecycleUrl: 'https://hooks.example/webhooks/graph/lifecycle',
      clientState: 'state-example',
      expiresAt: new Date('2026-09-15T10:00:00Z'),
    });
    expect(sub).toEqual({ id: 'sub-1', expiresAt: '2026-09-15T10:00:00Z' });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      changeType: 'created',
      resource: "me/mailFolders('inbox')/messages",
      clientState: 'state-example',
      lifecycleNotificationUrl: 'https://hooks.example/webhooks/graph/lifecycle',
    });
  });
});

describe('Gmail', () => {
  const gmail = (routes: Route[]) => {
    const r = recorded(routes);
    return {
      ...r,
      p: createGmailMailbox({
        clientId: 'client-example',
        clientSecret: 'secret-example',
        fetch: r.f,
      }),
    };
  };
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const full = (id: string, labels: string[], from = 'Pat Customer <pat@example.com>') => ({
    id,
    threadId: 'thread-1',
    labelIds: labels,
    internalDate: String(Date.parse('2026-09-12T14:00:00Z')),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: '"Dale, Owner" <owner@business.example>' },
        { name: 'Subject', value: 'Water heater' },
        { name: 'Message-ID', value: `<${id}@mail.gmail.com>` },
        { name: 'In-Reply-To', value: '<earlier@business.example>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Is Tuesday OK?') } },
        { mimeType: 'text/html', body: { data: b64('<p>Is Tuesday OK?</p>') } },
        {
          mimeType: 'application/pdf',
          filename: 'unit.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="unit.pdf"' }],
          body: { attachmentId: 'att-1', size: 3 },
        },
      ],
    },
  });

  it('asks for offline access with consent, and both mail scopes', () => {
    const { p } = gmail([]);
    const url = new URL(
      p.authorizeUrl({ state: 'st', codeChallenge: 'ch', redirectUri: 'https://hooks.example/cb' }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
    });
    expect(p.missingScopes(['https://www.googleapis.com/auth/gmail.readonly'])).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });

  it('reads addresses with commas inside quoted names', () => {
    expect(
      addressList('"Dale, Owner" <Owner@Business.example>, pat@example.com, not-an-address'),
    ).toEqual([
      { address: 'owner@business.example', name: 'Dale, Owner' },
      { address: 'pat@example.com', name: null },
    ]);
  });

  it('a first sync pages recent mail, then continues from the history it noted', async () => {
    const { p } = gmail([
      (c) =>
        c.url.endsWith('/profile')
          ? json({ historyId: '100', emailAddress: 'o@x.com' })
          : undefined,
      (c) =>
        c.url.includes('/messages?')
          ? json({ messages: [{ id: 'g1' }, { id: 'draft' }] })
          : undefined,
      (c) => (c.url.includes('/messages/g1?') ? json(full('g1', ['INBOX'])) : undefined),
      (c) => (c.url.includes('/messages/draft?') ? json(full('draft', ['DRAFT'])) : undefined),
      (c) =>
        c.url.includes('/messages/g1/attachments/att-1') ? json({ data: b64('pdf') }) : undefined,
    ]);
    const page = await p.sync('access-example', {}, new Date(Date.now() - 30 * 86_400_000));
    expect(page).toMatchObject({ more: false, cursor: { historyId: '100' } });
    expect(page.emails).toHaveLength(1);
    const e = page.emails[0]!;
    expect(e).toMatchObject({
      providerMessageId: 'g1',
      direction: 'inbound',
      messageIdHeader: '<g1@mail.gmail.com>',
      inReplyTo: '<earlier@business.example>',
      threadId: 'thread-1',
      from: { address: 'pat@example.com', name: 'Pat Customer' },
      to: [{ address: 'owner@business.example', name: 'Dale, Owner' }],
      text: 'Is Tuesday OK?',
      html: '<p>Is Tuesday OK?</p>',
      hasAttachments: true,
      occurredAt: '2026-09-12T14:00:00.000Z',
    });
    const files = await e.attachments();
    expect(files).toEqual([
      {
        name: 'unit.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('pdf'),
        contentId: null,
      },
    ]);
  });

  it('history that is too old starts the sync over', async () => {
    const { p, calls } = gmail([
      (c) => (c.url.includes('/history?') ? json({ error: { code: 404 } }, 404) : undefined),
      (c) => (c.url.endsWith('/profile') ? json({ historyId: '200' }) : undefined),
      (c) => (c.url.includes('/messages?') ? json({}) : undefined),
    ]);
    const page = await p.sync('access-example', { historyId: '5' }, new Date());
    expect(page.cursor).toEqual({ historyId: '200' });
    expect(calls.map((c) => new URL(c.url).pathname.split('/').pop())).toEqual([
      'history',
      'profile',
      'messages',
    ]);
  });

  it('a 403 says Google’s reason; its rate limit is waited out, a refusal is not', async () => {
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    const refusal = (reason: string, message: string) =>
      json(
        { error: { code: 403, message, errors: [{ reason }], status: 'PERMISSION_DENIED' } },
        403,
      );
    const { p } = gmail([
      (c) =>
        c.url.includes('/messages?')
          ? refusal('userRateLimitExceeded', `User-rate limit exceeded.  Retry after ${at}`)
          : undefined,
      (c) =>
        c.url.endsWith('/profile')
          ? refusal('insufficientPermissions', 'Request had insufficient authentication scopes.')
          : undefined,
    ]);
    const slow = await refusedWith(
      p.sync('access-example', { backfill: { startHistoryId: '1' } }, new Date()),
    );
    expect(slow).toBeInstanceOf(MailboxError);
    expect(slow).toMatchObject({ status: 403, permanent: false });
    expect(slow.message).toBe(
      `Gmail answered 403 (userRateLimitExceeded): User-rate limit exceeded. Retry after ${at}`,
    );
    expect(slow.retryAfterMs).toBeGreaterThan(9 * 60_000);
    expect(slow.retryAfterMs).toBeLessThanOrEqual(10 * 60_000);
    const refused = await refusedWith(p.account('access-example'));
    expect(refused).toMatchObject({ status: 403, permanent: true, retryAfterMs: null });
    expect(refused.message).toContain('(insufficientPermissions)');
  });

  it('sends raw MIME in the thread with our Message-ID', async () => {
    const { p, calls } = gmail([
      (c) =>
        c.url.startsWith('https://gmail.googleapis.com/upload/')
          ? json({ id: 'sent-1', threadId: 'thread-1' })
          : undefined,
      (c) =>
        c.url.includes('/messages/sent-1?format=metadata')
          ? json({
              id: 'sent-1',
              payload: { headers: [{ name: 'Message-ID', value: '<ours@mail.handsfreeos.com>' }] },
            })
          : undefined,
    ]);
    const sent = await p.send('access-example', {
      from: { address: 'owner@business.example', name: 'Dale' },
      to: ['pat@example.com'],
      cc: [],
      subject: 'Re: Water heater',
      text: 'Tuesday works.',
      html: '<p>Tuesday works.</p>',
      messageIdHeader: '<ours@mail.handsfreeos.com>',
      inReplyTo: '<g1@mail.gmail.com>',
      references: ['<g1@mail.gmail.com>'],
      attachments: [],
      replyToProviderMessageId: null,
      threadId: 'thread-1',
    });
    expect(sent).toEqual({
      providerMessageId: 'sent-1',
      messageIdHeader: '<ours@mail.handsfreeos.com>',
      threadId: 'thread-1',
    });
    const upload = calls[0]!;
    expect(upload.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    expect(upload.body).toContain('{"threadId":"thread-1"}');
    expect(upload.body).toContain('Message-ID: <ours@mail.handsfreeos.com>');
    expect(upload.body).toContain('In-Reply-To: <g1@mail.gmail.com>');
    expect(upload.body).toContain('Subject: Re: Water heater');
  });
});
