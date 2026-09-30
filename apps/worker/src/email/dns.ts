/**
 * Looks up a workspace domain's sending records ourselves. Postmark keeps DKIM "verified" once it ever was, even
 * after the record is removed from DNS, so a record that is gone only shows up here. Also where a receiving
 * domain's MX points (M19), which only DNS can tell.
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
