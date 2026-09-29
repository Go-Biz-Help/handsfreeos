import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DnsLookup } from '../src/email/dns';
import { createPostmark } from '../src/email/postmark';

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
const dns = (answers: {
  txt?: string[][] | Error;
  cname?: string[] | Error;
  mx?: string[] | Error;
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
    if (answers.mx instanceof Error) throw answers.mx;
    return (answers.mx ?? []).map((exchange) => ({ exchange }));
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
  it('finds Postmark among its MX records, however DNS writes the name', async () => {
    expect(
      await domains(dns({ mx: ['aspmx.l.google.com', 'INBOUND.POSTMARKAPP.COM.'] })).receives(
        'lonestarhvac.com',
      ),
    ).toBe(true);
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
