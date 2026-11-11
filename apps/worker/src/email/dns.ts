/**
 * Looks up a workspace domain's sending records ourselves. Postmark keeps DKIM "verified" once it ever was, even
 * after the record is removed from DNS, so a record that is gone only shows up here. Also where a receiving
 * domain's MX points (M19), which only DNS can tell. And whether a customer's email domain can take mail at all,
 * for the booking page (a typo there sends every confirmation and reminder nowhere).
 */
import { promises as dns } from 'node:dns';

export interface DnsLookup {
  /** TXT records at a host, each as the strings it was split into. */
  txt(host: string): Promise<string[][]>;
  cname(host: string): Promise<string[]>;
  /** The mail servers a domain's MX records name. */
  mx(host: string): Promise<{ exchange: string }[]>;
}

export const systemDns: DnsLookup = {
  txt: (host) => dns.resolveTxt(host),
  cname: (host) => dns.resolveCname(host),
  mx: (host) => dns.resolveMx(host),
};

/** What the check on a customer's email needs: the domain's MX records, then its addresses (mail's fallback). */
export interface MailDnsLookup {
  mx(host: string): Promise<{ exchange: string }[]>;
  a(host: string): Promise<string[]>;
  aaaa(host: string): Promise<string[]>;
}

/** Short tries, as a customer is waiting on the page. */
const quick = new dns.Resolver({ timeout: 1500, tries: 2 });

export const mailDns: MailDnsLookup = {
  mx: (host) => quick.resolveMx(host),
  a: (host) => quick.resolve4(host),
  aaaa: (host) => quick.resolve6(host),
};

/** Answers that mean the record is not there. Anything else (a timeout, a failing server) means nobody can tell. */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA']);

/** The records at a host: [] when DNS says there are none, null when DNS did not answer. */
async function lookUp<T>(fn: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await fn();
  } catch (e) {
    return ABSENT.has(String((e as { code?: unknown }).code ?? '')) ? [] : null;
  }
}

/** The public key of a DKIM record (`p=`), without spaces; the whole record when it has no key part. */
const dkimKey = (record: string) =>
  (/(?:^|;)\s*p=([^;]*)/i.exec(record)?.[1] ?? record).replace(/\s+/g, '');

const hostName = (host: string) => host.trim().toLowerCase().replace(/\.+$/, '');

/** Whether the DKIM key is published at the host: true, false, or null when DNS did not answer. */
export async function dkimInDns(
  lookup: DnsLookup,
  host: string,
  value: string,
): Promise<boolean | null> {
  const found = await lookUp(() => lookup.txt(host));
  if (found === null) return null;
  const want = dkimKey(value);
  return found.some((chunks) => dkimKey(chunks.join('')) === want);
}

/** Whether the host is a CNAME for the target: true, false, or null when DNS did not answer. */
export async function cnameInDns(
  lookup: DnsLookup,
  host: string,
  target: string,
): Promise<boolean | null> {
  const found = await lookUp(() => lookup.cname(host));
  if (found === null) return null;
  return found.some((t) => hostName(t) === hostName(target));
}

/** Whether a TXT record at the host is exactly the token: true, false, or null when DNS did not answer. */
export async function tokenInDns(
  lookup: DnsLookup,
  host: string,
  token: string,
): Promise<boolean | null> {
  const found = await lookUp(() => lookup.txt(host));
  if (found === null) return null;
  return found.some((chunks) => chunks.join('').trim() === token);
}

/** Whether one of the domain's MX records names the host: true, false, or null when DNS did not answer. */
export async function mxInDns(
  lookup: DnsLookup,
  domain: string,
  exchange: string,
): Promise<boolean | null> {
  const found = await lookUp(() => lookup.mx(domain));
  if (found === null) return null;
  return found.some((r) => hostName(r.exchange) === hostName(exchange));
}

/**
 * Whether mail to an address at this domain can arrive: true, false, or null when DNS did not answer in time.
 * False only when DNS says so: no such domain, a "null MX" (the domain says it takes no mail), or no MX record and
 * no address to fall back on (RFC 5321). Anything slower than the deadline is null, so nobody waits on it.
 */
export async function mailDomainCanReceive(
  lookup: MailDnsLookup,
  domain: string,
  deadlineMs = 3000,
): Promise<boolean | null> {
  const check = async (): Promise<boolean | null> => {
    const mx = await lookUp(() => lookup.mx(domain));
    if (mx === null) return null;
    // A null MX is one record naming "." (RFC 7505), which Node reads as an empty name.
    if (mx.length > 0) return mx.some((r) => hostName(r.exchange) !== '');
    const [a, aaaa] = await Promise.all([
      lookUp(() => lookup.a(domain)),
      lookUp(() => lookup.aaaa(domain)),
    ]);
    if ((a?.length ?? 0) + (aaaa?.length ?? 0) > 0) return true;
    return a === null || aaaa === null ? null : false;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  try {
    return await Promise.race([check(), late]);
  } finally {
    clearTimeout(timer);
  }
}
