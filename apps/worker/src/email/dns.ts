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
  /** The mail servers a domain's MX records name, and their preference (lowest is tried first). */
  mx(host: string): Promise<MxRecord[]>;
  /**
   * The same, as the domain's own name servers give them this minute. `mx` asks a resolver that keeps each answer
   * for as long as the record said to (a day, at some DNS hosts), so a record changed a minute ago still reads as
   * the old one there.
   */
  mxNow(host: string): Promise<MxRecord[]>;
}

export interface MxRecord {
  exchange: string;
  priority?: number;
}

export const systemDns: DnsLookup = {
  txt: (host) => dns.resolveTxt(host),
  cname: (host) => dns.resolveCname(host),
  mx: (host) => dns.resolveMx(host),
  mxNow: (host) => mxAtSource(host),
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

/** What asking a domain's own name servers takes; a test passes its own. */
export interface SourceDns {
  /** A zone's name servers, by name. */
  ns(zone: string): Promise<string[]>;
  /** A name server's addresses. */
  addresses(host: string): Promise<string[]>;
  /** The host's MX records, asked of these servers (by address) and nobody else. */
  mxAt(servers: string[], host: string): Promise<MxRecord[]>;
  /** The usual resolver, for when the name servers can't be asked. */
  mx(host: string): Promise<MxRecord[]>;
}

/** Name servers asked, of the few a domain lists: each answers for the whole zone. */
const NAME_SERVERS_ASKED = 4;
/** How long the name servers get before the usual resolver is asked instead. */
const SOURCE_DEADLINE_MS = 6000;

/**
 * The host's MX records, asked of these servers (by address) and nobody else. Servers that never answer are given
 * up on together at the deadline: each one's tries in turn would take half a minute.
 */
export async function mxFromServers(
  servers: string[],
  host: string,
  deadlineMs = SOURCE_DEADLINE_MS,
): Promise<MxRecord[]> {
  const direct = new dns.Resolver({ timeout: 1500, tries: 2 });
  direct.setServers(servers);
  const late = setTimeout(() => direct.cancel(), deadlineMs);
  try {
    return await direct.resolveMx(host);
  } finally {
    clearTimeout(late);
  }
}

const systemSource: SourceDns = {
  ns: (zone) => dns.resolveNs(zone),
  addresses: (host) => dns.resolve4(host),
  mxAt: (servers, host) => mxFromServers(servers, host),
  mx: (host) => dns.resolveMx(host),
};

/**
 * The addresses of the name servers that hold a host's records: its own when it is a zone, or else those of the
 * nearest name above it that is (mail.acme.com's records are kept by acme.com's servers). Never a bare ending such
 * as "com", whose servers hold no business's records. [] when they can't be found.
 */
async function sourceServers(host: string, src: SourceDns): Promise<string[]> {
  for (let zone = hostName(host); zone.includes('.'); zone = zone.slice(zone.indexOf('.') + 1)) {
    const names = await lookUp(() => src.ns(zone));
    if (names === null) return [];
    if (names.length === 0) continue;
    const found = await Promise.all(
      names.slice(0, NAME_SERVERS_ASKED).map((name) => lookUp(() => src.addresses(name))),
    );
    return found.flatMap((addresses) => addresses ?? []);
  }
  return [];
}

/**
 * A domain's MX records as its own name servers give them now, past every resolver's cache. A business that just
 * replaced its MX records and clicked Check now was told the new one wasn't there, for as long as the resolver here
 * kept the old ones (up to a day): the old host's record beside ours reads as mail still going there. Only records
 * the name servers give are taken from them. When they can't be found, don't answer or give none, the usual
 * resolver is asked, as before: a server that no longer holds the domain can say "none" too.
 */
export async function mxAtSource(
  domain: string,
  src: SourceDns = systemSource,
): Promise<MxRecord[]> {
  const servers = await sourceServers(domain, src);
  if (servers.length > 0) {
    const found = await src.mxAt(servers, domain).catch(() => []);
    if (found.length > 0) return found;
  }
  return src.mx(domain);
}

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

/**
 * Whether the domain's mail goes to the host: true, false, or null when DNS did not answer. Mail goes to the MX
 * records with the lowest preference, so the host has to be the only name there. One record naming it beside the old
 * host's (Google's at 1, ours at 10, say) used to count, and then receiving turned on while every reply still went
 * to the old mailbox, with no Reply-To on our mail any more to bring them back. The records are the ones the
 * domain's own name servers give now (`mxNow`), so deleting the old host's shows at the next look.
 */
export async function mxInDns(
  lookup: DnsLookup,
  domain: string,
  exchange: string,
): Promise<boolean | null> {
  const found = await lookUp(() => lookup.mxNow(domain));
  if (found === null) return null;
  if (found.length === 0) return false;
  const first = Math.min(...found.map((r) => r.priority ?? 0));
  return found
    .filter((r) => (r.priority ?? 0) === first)
    .every((r) => hostName(r.exchange) === hostName(exchange));
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
