import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Fetching an address someone typed in (a business's website to scan, a workflow's outgoing webhook) without
 * letting it reach inside our own network. Only https, no user name or password in the address, and every
 * address the host name resolves to must be public. The check runs inside the connection's own DNS lookup, so a
 * name can't resolve to a public address for the check and a private one for the connection. Redirects are
 * followed by hand, and each one is checked again.
 */

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'not_https'
  | 'blocked_address'
  | 'other_host'
  | 'too_many_redirects'
  | 'timeout'
  | 'network';

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: SafeFetchErrorCode,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchInit {
  readonly method?: 'GET' | 'HEAD' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** For the whole request, redirects included (default 10 s). */
  readonly timeoutMs?: number;
  /** Bytes of body kept; the rest is dropped and `truncated` set (default 2 MB). */
  readonly maxBytes?: number;
  /** Redirects followed (default 5). A POST never follows one: the 3xx comes back as the response. */
  readonly maxRedirects?: number;
  /** Redirects must stay on the starting site; hosts that differ only by a leading `www.` count as one site. */
  readonly sameHost?: boolean;
}

export interface SafeResponse {
  readonly status: number;
  /** Lower-case names; repeated headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  /** The body as UTF-8 text, cut at `maxBytes`. */
  readonly body: string;
  /** Where the last redirect ended up. */
  readonly finalUrl: string;
  readonly truncated: boolean;
}

export type SafeFetch = (url: string, init?: SafeFetchInit) => Promise<SafeResponse>;

export type Resolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface SafeFetchPolicy {
  /**
   * Tests only: exact origins (`http://127.0.0.1:43210`) that may use plain http on a loopback address, for
   * fixture sites. Never filled from the environment.
   */
  readonly testOrigins?: readonly string[];
  /** Tests only: stands in for DNS. */
  readonly resolve?: Resolver;
}

const USER_AGENT = 'HandsFreeOS/1.0 (+https://handsfreeos.com)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, where cloud metadata lives
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and the old IPv4-compatible form
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 23], // IETF assignments, Teredo included
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

// A public host never publishes an IPv4-mapped IPv6 address. This rule lives apart and is checked only for IPv6
// addresses, because BlockList also compares plain IPv4 addresses with IPv4-mapped rules: in `blocked` it would
// block every IPv4 address.
const mappedIpv4 = new BlockList();
mappedIpv4.addSubnet('::ffff:0:0', 96, 'ipv6');

/** True for any address we must never connect to, and for anything that isn't an IP address at all. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, 'ipv4');
  if (family === 6) return mappedIpv4.check(bare, 'ipv6') || blocked.check(bare, 'ipv6');
  return true;
}

function checkUrl(raw: string, trusted: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('That is not a web address.', 'invalid_url');
  }
  if (trusted.has(url.origin)) return url;
  if (url.protocol !== 'https:')
    throw new SafeFetchError('Only https:// addresses can be fetched.', 'not_https');
  if (url.username || url.password)
    throw new SafeFetchError(
      'Addresses with a user name or password in them are not allowed.',
      'invalid_url',
    );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host))
      throw new SafeFetchError(`${host} is a private address.`, 'blocked_address');
  } else if (!host.includes('.')) {
    // One-word names ("intranet", "localhost") only mean something inside a private network.
    throw new SafeFetchError('Use the full web address, like example.com.', 'invalid_url');
  }
  return url;
}

function noAddress(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${hostname} has no address.`), { code: 'ENOTFOUND' });
}

/** The connection's own DNS lookup: refuses the host when any address it resolves to is private. */
function guardedLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.some((a) => isBlockedAddress(a.address)))
          return callback(
            new SafeFetchError(`${hostname} points to a private address.`, 'blocked_address'),
            '',
          );
        const family =
          options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const usable =
          family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        const first = usable[0];
        if (!first) return callback(noAddress(hostname), '');
        if (options.all)
          return callback(
            null,
            usable.map((a) => ({ address: a.address, family: a.family })),
          );
        callback(null, first.address, first.family);
      },
      (e: NodeJS.ErrnoException) => callback(e, ''),
    );
  };
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}

function asSafeError(e: unknown): SafeFetchError {
  if (e instanceof SafeFetchError) return e;
  const code = (e as { code?: unknown }).code;
  const detail = typeof code === 'string' ? code : e instanceof Error ? e.message : String(e);
  return new SafeFetchError(`Could not reach the site (${detail}).`, 'network');
}

function fetchOnce(
  url: URL,
  init: SafeFetchInit,
  method: 'GET' | 'HEAD' | 'POST',
  lookup: LookupFunction | undefined,
  deadline: number,
  maxBytes: number,
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const fail = (e: unknown) =>
      settle(() => {
        req?.destroy();
        reject(asSafeError(e));
      });
    const timer = setTimeout(
      () => fail(new SafeFetchError('The site took too long to answer.', 'timeout')),
      Math.max(0, deadline - Date.now()),
    );

    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-encoding': 'identity',
    };
    for (const [name, value] of Object.entries(init.headers ?? {}))
      headers[name.toLowerCase()] = value;
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
    const options: RequestOptions = {
      method,
      headers,
      agent: false,
      ...(lookup ? { lookup } : {}),
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    try {
      req = send(url, options, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (truncated: boolean) =>
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: flatten(res.headers),
              body: Buffer.concat(chunks).toString('utf8'),
              finalUrl: url.toString(),
              truncated,
            }),
          );
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            size = maxBytes;
            done(true);
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => done(false));
        res.on('error', fail);
        res.on('close', () =>
          fail(new SafeFetchError('The site closed the connection early.', 'network')),
        );
      });
      req.on('error', fail);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    } catch (e) {
      fail(e);
    }
  });
}

export function createSafeFetch(policy: SafeFetchPolicy = {}): SafeFetch {
  const trusted = new Set(policy.testOrigins ?? []);
  const lookup = guardedLookup(policy.resolve ?? ((host) => dnsLookup(host, { all: true })));
  return async (raw, init = {}) => {
    const method = init.method ?? 'GET';
    const deadline = Date.now() + (init.timeoutMs ?? 10_000);
    const maxBytes = init.maxBytes ?? 2 * 1024 * 1024;
    const maxRedirects = method === 'POST' ? 0 : (init.maxRedirects ?? 5);
    const site = (host: string) => host.toLowerCase().replace(/^www\./, '');
    let url = checkUrl(raw, trusted);
    const home = site(url.hostname);
    for (let redirects = 0; ; redirects++) {
      const res = await fetchOnce(
        url,
        init,
        method,
        trusted.has(url.origin) ? undefined : lookup,
        deadline,
        maxBytes,
      );
      const location = res.headers['location'];
      if (!REDIRECTS.has(res.status) || !location || maxRedirects === 0) return res;
      if (redirects >= maxRedirects)
        throw new SafeFetchError('The site redirected too many times.', 'too_many_redirects');
      let target: string;
      try {
        target = new URL(location, url).toString();
      } catch {
        throw new SafeFetchError(
          'The site redirected to an address that makes no sense.',
          'invalid_url',
        );
      }
      const next = checkUrl(target, trusted);
      if (init.sameHost && site(next.hostname) !== home)
        throw new SafeFetchError(
          `The site sent us on to ${next.hostname}, which is a different site.`,
          'other_host',
        );
      url = next;
    }
  };
}
