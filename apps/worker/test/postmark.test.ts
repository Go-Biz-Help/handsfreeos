import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DnsLookup } from '../src/email/dns';
import { createPostmark } from '../src/email/postmark';
import { replyToOf } from '../src/processors/postmark';
import { INBOUND_REFUSALS } from '../src/email/transport';

/**
 * Postmark's domain checks against a recorded fetch and a stand-in DNS. Postmark keeps DKIM "verified" once it
 * ever was, even after the record is removed, so the records are looked up too. Tokens here are made up.
 */
const DOMAIN = {
  ID: 4410123,
  Name: 'lonestarhvac.example',
  DKIMVerified: true,
  DKIMHost: '20260912pm._domainkey.lonestarhvac.example',
  DKIMTextValue: 'k=rsa;p=fake0dkim0public0part0for0tests',
  DKIMPendingHost: '',
  DKIMPendingTextValue: '',
  ReturnPathDomain: 'pm-bounces.lonestarhvac.example',
  ReturnPathDomainVerified: true,
  ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
};

/** Every Domains API call answers with the domain; returns the calls in order. */
function mockPostmark(domain: typeof DOMAIN = DOMAIN): string[] {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push(
        `${init.method ?? 'GET'} ${new URL(String(input)).pathname} ${headers['X-Postmark-Account-Token']}`,
      );
      return new Response(JSON.stringify(domain), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

const dnsError = (code: string) => Object.assign(new Error(`queryTxt ${code}`), { code });
type Mx = string | { exchange: string; priority: number };
function mxOf(answer: Mx[] | Error | undefined) {
  if (answer instanceof Error) throw answer;
  return (answer ?? []).map((r) => (typeof r === 'string' ? { exchange: r, priority: 10 } : r));
}
const dns = (answers: {
  txt?: string[][] | Error;
  cname?: string[] | Error;
  mx?: Mx[] | Error;
  /** What the domain's own name servers say now; the same as the resolver unless a test says otherwise. */
  mxNow?: Mx[] | Error;
}): DnsLookup => ({
  async txt() {
    if (answers.txt instanceof Error) throw answers.txt;
    return answers.txt ?? [];
  },
  async cname() {
    if (answers.cname instanceof Error) throw answers.cname;
    return answers.cname ?? [];
  },
  async mx() {
    return mxOf(answers.mx);
  },
  async mxNow() {
    return mxOf(answers.mxNow ?? answers.mx);
  },
});
const domains = (lookup: DnsLookup) =>
  createPostmark({
    serverToken: 'server-token-test',
    accountToken: 'account-token-test',
    stream: 'outbound',
    dns: lookup,
  }).domains;
const PUBLISHED_DKIM = 'fake0dkim0public0part0for0tests';

describe('checking a workspace domain', () => {
  it('asks Postmark to look again, then finds both records in DNS', async () => {
    const seen = mockPostmark();
    // The TXT record as a DNS provider may split it, with a version tag; the CNAME in capitals with its dot.
    const state = await domains(
      dns({ txt: [['v=DKIM1; k=rsa; ', `p=${PUBLISHED_DKIM}`]], cname: ['PM.MTASV.NET.'] }),
    ).verify('4410123');
    expect(state).toMatchObject({
      providerDomainId: '4410123',
      dkimVerified: true,
      returnPathVerified: true,
    });
    expect(seen).toEqual([
      'PUT /domains/4410123/verifyDkim account-token-test',
      'PUT /domains/4410123/verifyReturnPath account-token-test',
      'GET /domains/4410123 account-token-test',
    ]);
  });

  it('notices records gone from DNS, though Postmark still calls DKIM verified', async () => {
    mockPostmark();
    expect(
      await domains(dns({ txt: dnsError('ENOTFOUND'), cname: ['pm.mtasv.net'] })).verify('4410123'),
    ).toMatchObject({ dkimVerified: false, returnPathVerified: true });
    // Another key at the host is not the one Postmark signs with; a host without a CNAME has none.
    expect(
      await domains(dns({ txt: [['k=rsa; p=SOMEOTHERKEY']], cname: dnsError('ENODATA') })).verify(
        '4410123',
      ),
    ).toMatchObject({ dkimVerified: false, returnPathVerified: false });
  });

  it('trusts Postmark when DNS does not answer, and never passes what Postmark has not verified', async () => {
    mockPostmark();
    expect(
      await domains(dns({ txt: dnsError('ETIMEOUT'), cname: dnsError('ESERVFAIL') })).verify(
        '4410123',
      ),
    ).toMatchObject({ dkimVerified: true, returnPathVerified: true });
    mockPostmark({ ...DOMAIN, DKIMVerified: false, ReturnPathDomainVerified: false });
    expect(
      await domains(dns({ txt: [[`k=rsa;p=${PUBLISHED_DKIM}`]], cname: ['pm.mtasv.net'] })).verify(
        '4410123',
      ),
    ).toMatchObject({ dkimVerified: false, returnPathVerified: false });
  });
});

describe('whether a domain receives here (M19)', () => {
  it('finds Postmark as its MX record, however DNS writes the name', async () => {
    expect(
      await domains(dns({ mx: ['INBOUND.POSTMARKAPP.COM.'] })).receives('lonestarhvac.com'),
    ).toBe(true);
    // A backup record the mail only falls back to doesn't stop it.
    expect(
      await domains(
        dns({
          mx: [
            { exchange: 'inbound.postmarkapp.com', priority: 10 },
            { exchange: 'mx.backup.example', priority: 50 },
          ],
        }),
      ).receives('lonestarhvac.com'),
    ).toBe(true);
  });

  // The old host's records left beside ours still get the mail, so receiving waits until they're gone.
  it('says no while the old host’s MX records come first or beside ours', async () => {
    const old = (priority: number) => [
      { exchange: 'aspmx.l.google.com', priority: 1 },
      { exchange: 'alt1.aspmx.l.google.com', priority: 5 },
      { exchange: 'inbound.postmarkapp.com', priority },
    ];
    expect(await domains(dns({ mx: old(10) })).receives('lonestarhvac.com')).toBe(false);
    expect(await domains(dns({ mx: old(1) })).receives('lonestarhvac.com')).toBe(false);
    expect(await domains(dns({ mx: old(0) })).receives('lonestarhvac.com')).toBe(true);
  });

  // A resolver keeps the old records for as long as they said to (a day, at some DNS hosts). A business that had
  // just deleted its old host's records, and clicked Check now, was told ours wasn't there.
  it('goes by the domain’s own name servers, not by records a resolver still remembers', async () => {
    const remembered = [
      { exchange: 'mx10.oldhost.example', priority: 10 },
      { exchange: 'mx20.oldhost.example', priority: 20 },
      { exchange: 'inbound.postmarkapp.com', priority: 10 },
    ];
    expect(
      await domains(dns({ mx: remembered, mxNow: ['inbound.postmarkapp.com'] })).receives(
        'lonestarhvac.com',
      ),
    ).toBe(true);
    // And the other way: the MX moved away a minute ago, though a resolver still remembers ours.
    expect(
      await domains(
        dns({ mx: ['inbound.postmarkapp.com'], mxNow: ['aspmx.l.google.com'] }),
      ).receives('lonestarhvac.com'),
    ).toBe(false);
  });

  // The guided setup's last step lists the old mail records still to delete, from what `hosts` kept.
  it('keeps a domain’s mail records as its own name servers give them now', async () => {
    const remembered = [
      { exchange: 'mx10.oldhost.example', priority: 10 },
      { exchange: 'inbound.postmarkapp.com', priority: 10 },
    ];
    const found = await createPostmark({
      serverToken: 'server-token-test',
      accountToken: 'account-token-test',
      stream: 'outbound',
      dns: dns({ mx: remembered, mxNow: ['inbound.postmarkapp.com'] }),
      nameServers: async () => ['ns1.siteground.net'],
    }).domains.hosts('lonestarhvac.com');
    expect(found).toMatchObject({
      mx: ['inbound.postmarkapp.com'],
      mxRecords: [{ exchange: 'inbound.postmarkapp.com', priority: 10 }],
      ns: ['ns1.siteground.net'],
      missing: false,
    });
  });

  it('says no when the MX points elsewhere or there is none', async () => {
    expect(await domains(dns({ mx: ['aspmx.l.google.com'] })).receives('lonestarhvac.com')).toBe(
      false,
    );
    expect(await domains(dns({ mx: dnsError('ENODATA') })).receives('lonestarhvac.com')).toBe(
      false,
    );
  });

  it('says nothing when DNS does not answer', async () => {
    expect(
      await domains(dns({ mx: dnsError('ETIMEOUT') })).receives('lonestarhvac.com'),
    ).toBeNull();
  });
});

describe('whose domain it is (M19)', () => {
  it('finds the claim’s token at _hfos-verify, and says nothing when DNS does not answer', async () => {
    const seen: string[] = [];
    const lookup: DnsLookup = {
      ...dns({}),
      async txt(host) {
        seen.push(host);
        return [['some-other-token'], ['c0ffee', 'feed']];
      },
    };
    expect(await domains(lookup).owns('lonestarhvac.com', 'c0ffeefeed')).toBe(true);
    expect(await domains(lookup).owns('lonestarhvac.com', 'not-ours')).toBe(false);
    expect(seen[0]).toBe('_hfos-verify.lonestarhvac.com');
    expect(
      await domains(dns({ txt: dnsError('ETIMEOUT') })).owns('lonestarhvac.com', 'c0ffeefeed'),
    ).toBeNull();
  });
});

describe('a receiving domain’s server (M19)', () => {
  const HOOK = 'https://postmark:secret@hooks.example.com/webhooks/postmark/inbound';
  const inbound = () =>
    createPostmark({
      serverToken: 'server-token-test',
      accountToken: 'account-token-test',
      stream: 'outbound',
      dns: dns({}),
      inboundHookUrl: HOOK,
    }).domains;
  /** Answers by "METHOD /path": a body and a status, or Postmark's error shape. */
  function mockServers(answers: Record<string, { status?: number; body: unknown }>) {
    const seen: { route: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const route = `${init.method ?? 'GET'} ${url.pathname}`;
        seen.push({
          route: `${route}${url.search}`,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const a = answers[route] ?? { status: 404, body: { ErrorCode: 404, Message: 'Not found' } };
        return new Response(JSON.stringify(a.body), {
          status: a.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return seen;
  }

  it('makes a server that only receives, posting to our webhook', async () => {
    const seen = mockServers({ 'POST /servers': { body: { ID: 90210, Name: 'Inbound · x' } } });
    expect(await inbound().openInbound('lonestarhvac.com')).toBe('90210');
    expect(seen).toEqual([
      {
        route: 'POST /servers',
        body: {
          Name: 'Inbound · lonestarhvac.com',
          Color: 'Green',
          DeliveryType: 'Live',
          InboundDomain: 'lonestarhvac.com',
          InboundHookUrl: HOOK,
          InboundSpamThreshold: 15,
          RawEmailEnabled: false,
          SmtpApiActivated: false,
        },
      },
    ]);
  });

  it('finds the server again by its name, hooking it back up', async () => {
    const seen = mockServers({
      'POST /servers': {
        status: 422,
        body: { ErrorCode: 603, Message: 'This server name already exists.' },
      },
      'GET /servers': {
        body: {
          TotalCount: 2,
          Servers: [
            { ID: 1, Name: 'Inbound · lonestarhvac.com.au' },
            { ID: 2, Name: 'Inbound · lonestarhvac.com' },
          ],
        },
      },
      'PUT /servers/2': { body: { ID: 2 } },
    });
    expect(await inbound().openInbound('lonestarhvac.com')).toBe('2');
    expect(seen.map((c) => c.route)).toEqual([
      'POST /servers',
      `GET /servers?count=100&offset=0&name=${encodeURIComponent('Inbound · lonestarhvac.com')}`,
      'PUT /servers/2',
    ]);
    expect(seen[2]!.body).toMatchObject({
      InboundDomain: 'lonestarhvac.com',
      InboundHookUrl: HOOK,
    });
  });

  it('passes on a refusal Postmark will repeat, by its code', async () => {
    mockServers({
      'POST /servers': {
        status: 422,
        body: { ErrorCode: 602, Message: 'The specified inbound domain is already registered.' },
      },
    });
    await expect(inbound().openInbound('lonestarhvac.com')).rejects.toMatchObject({
      code: '602',
      permanent: true,
    });
    // Until the domain's MX points at Postmark: the handler treats it as waiting (INBOUND_REFUSALS.noMx).
    mockServers({
      'POST /servers': {
        status: 422,
        body: {
          ErrorCode: 610,
          Message: 'We could not find an MX record pointing to the expected domain.',
        },
      },
    });
    await expect(inbound().openInbound('lonestarhvac.com')).rejects.toMatchObject({
      code: INBOUND_REFUSALS.noMx,
      permanent: true,
    });
  });

  it('removes the server, or unhooks it where the account may not remove servers', async () => {
    let seen = mockServers({ 'DELETE /servers/2': { body: { ErrorCode: 0, Message: 'Removed' } } });
    await inbound().closeInbound('2');
    expect(seen.map((c) => c.route)).toEqual(['DELETE /servers/2']);
    seen = mockServers({
      'DELETE /servers/2': {
        status: 422,
        body: { ErrorCode: 604, Message: 'You do not have permission to delete servers.' },
      },
      'PUT /servers/2': { body: { ID: 2 } },
    });
    await inbound().closeInbound('2');
    expect(seen).toEqual([
      { route: 'DELETE /servers/2', body: undefined },
      { route: 'PUT /servers/2', body: { InboundDomain: '', InboundHookUrl: '' } },
    ]);
  });
});

describe('the Reply-To of mail that came in', () => {
  it('takes the first address and its name, however the header writes them', () => {
    expect(replyToOf('Dana Rivera <Dana@Example.com>')).toEqual({
      address: 'dana@example.com',
      name: 'Dana Rivera',
    });
    expect(replyToOf('"Rivera, Dana" <dana@example.com>, lee@example.com')).toEqual({
      address: 'dana@example.com',
      name: 'Rivera, Dana',
    });
    expect(replyToOf('dana@example.com, lee@example.com')).toEqual({
      address: 'dana@example.com',
      name: null,
    });
    expect(replyToOf('<dana@example.com>')).toEqual({ address: 'dana@example.com', name: null });
  });

  it('is nothing when there is no address in it', () => {
    expect(replyToOf(undefined)).toBeNull();
    expect(replyToOf('')).toBeNull();
    expect(replyToOf('[your-email]')).toBeNull();
  });
});

describe('how long Postmark has to answer', () => {
  it('is limited on every call, so a call that hangs is given up and tried again', async () => {
    const limits: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
        limits.push(init.signal);
        return new Response(JSON.stringify(DOMAIN), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await domains(dns({})).verify(String(DOMAIN.ID));
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) expect(limit).toBeInstanceOf(AbortSignal);
  });
});
