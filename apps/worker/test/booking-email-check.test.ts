/**
 * The booking page's check on a typed email's domain: refused only when DNS says the domain takes no mail (no such
 * domain, a null MX, or no MX and no address), and let through whenever DNS can't say. No database.
 */
import { HfosError } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { emailDomainOf, refuseUndeliverableEmail } from '../src/booking/email-check';
import { mailDomainCanReceive, type MailDnsLookup } from '../src/email/dns';

const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
const NO_DOMAIN = dnsError('ENOTFOUND');
const NO_RECORDS = dnsError('ENODATA');

type Answer<T> = T[] | Error | 'hang';
const dns = (answers: {
  mx?: Answer<string>;
  a?: Answer<string>;
  aaaa?: Answer<string>;
}): MailDnsLookup & { asked: string[] } => {
  const asked: string[] = [];
  const answer = async <T>(kind: string, host: string, a: Answer<T> | undefined): Promise<T[]> => {
    asked.push(`${kind} ${host}`);
    if (a === 'hang') return new Promise<T[]>(() => {});
    if (a instanceof Error) throw a;
    if (a === undefined) throw NO_RECORDS;
    return a;
  };
  return {
    asked,
    mx: async (host) =>
      (await answer('mx', host, answers.mx)).map((exchange) => ({ exchange: String(exchange) })),
    a: (host) => answer('a', host, answers.a),
    aaaa: (host) => answer('aaaa', host, answers.aaaa),
  };
};

describe('whether a domain can take mail', () => {
  it('says yes for a domain with a mail server, without asking for addresses', async () => {
    const lookup = dns({ mx: ['mx.example.net'] });
    expect(await mailDomainCanReceive(lookup, 'shop.test')).toBe(true);
    expect(lookup.asked).toEqual(['mx shop.test']);
  });

  it('falls back to the domain’s own address when it has no MX record', async () => {
    expect(await mailDomainCanReceive(dns({ a: ['192.0.2.10'] }), 'shop.test')).toBe(true);
    expect(await mailDomainCanReceive(dns({ aaaa: ['2001:db8::1'] }), 'shop.test')).toBe(true);
  });

  it('says no for a domain that doesn’t exist', async () => {
    const lookup = dns({ mx: NO_DOMAIN, a: NO_DOMAIN, aaaa: NO_DOMAIN });
    expect(await mailDomainCanReceive(lookup, 'fullspecteumlighttherqpy.com')).toBe(false);
  });

  it('says no for a domain with no MX record and no address', async () => {
    expect(await mailDomainCanReceive(dns({}), 'parked.test')).toBe(false);
  });

  it('says no for a null MX, the domain’s own word that it takes no mail', async () => {
    expect(await mailDomainCanReceive(dns({ mx: [''] }), 'nomail.test')).toBe(false);
    expect(await mailDomainCanReceive(dns({ mx: ['.'] }), 'nomail.test')).toBe(false);
  });

  it('can’t say when DNS fails or is slow', async () => {
    expect(await mailDomainCanReceive(dns({ mx: dnsError('ESERVFAIL') }), 'shop.test')).toBeNull();
    expect(
      await mailDomainCanReceive(dns({ a: dnsError('ETIMEOUT'), aaaa: NO_RECORDS }), 'shop.test'),
    ).toBeNull();
    expect(await mailDomainCanReceive(dns({ mx: 'hang' }), 'shop.test', 20)).toBeNull();
  });
});

describe('the domain of a typed email', () => {
  it('reads it the way DNS asks about it', () => {
    expect(emailDomainOf(' Lynn.Combs@FullSpectrum.COM. ')).toBe('fullspectrum.com');
    expect(emailDomainOf('a@b@shop.test')).toBe('shop.test');
    expect(emailDomainOf('jo@bücher.example')).toBe('xn--bcher-kva.example');
  });

  it('leaves anything not shaped like an address to core', () => {
    for (const typed of [null, undefined, '', 'lynn', '@shop.test', 'lynn@localhost', 'a@b c.test'])
      expect(emailDomainOf(typed)).toBeNull();
  });
});

describe('refusing an email on the booking page', () => {
  it('refuses a typo’s domain on the email field, naming it as typed', async () => {
    const lookup = dns({ mx: NO_DOMAIN, a: NO_DOMAIN, aaaa: NO_DOMAIN });
    const err = await refuseUndeliverableEmail(
      lookup,
      'lynn.combs@FullSpecteumLightTherqpy.com',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HfosError);
    const e = err as HfosError;
    expect(e).toMatchObject({ code: 'validation', status: 400, rule: 'email_domain_not_found' });
    const [field] = e.details as { path: string; message: string }[];
    expect(field!.path).toBe('email');
    expect(field!.message).toContain('FullSpecteumLightTherqpy.com');
    expect(field!.message).toContain('Check the spelling');
  });

  it('lets the booking through when the domain takes mail, DNS can’t say, or there’s nothing to check', async () => {
    await expect(
      refuseUndeliverableEmail(dns({ mx: ['mx.shop.test'] }), 'jo@shop.test'),
    ).resolves.toBeUndefined();
    await expect(
      refuseUndeliverableEmail(dns({ mx: dnsError('ETIMEOUT') }), 'jo@shop.test'),
    ).resolves.toBeUndefined();
    const lookup = dns({ mx: NO_DOMAIN, a: NO_DOMAIN, aaaa: NO_DOMAIN });
    await expect(refuseUndeliverableEmail(lookup, null)).resolves.toBeUndefined();
    await expect(refuseUndeliverableEmail(lookup, 'not an email')).resolves.toBeUndefined();
    // With the check off (every environment but production), nothing is asked.
    await expect(refuseUndeliverableEmail(undefined, 'jo@nowhere.test')).resolves.toBeUndefined();
    expect(lookup.asked).toEqual([]);
  });
});
