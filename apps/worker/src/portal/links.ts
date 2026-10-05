/**
 * A client's portal link (Real Estate round two, core): `${origin}/c/<public_ref><code>`. The same shape as the
 * invoice and booking links (money/links.ts, booking/links.ts), for the same reasons: it goes out by email, mail
 * scanners open it, and nothing about it may be guessable. The code is the first ten base62 characters of an
 * HMAC-SHA256 over `${accessId}:${linkVersion}` with its own derived key (`hfos:portal-links:v1`). **Nothing secret
 * is stored**: raising the access's `link_version` (turning it off, or letting them back in) retires every link
 * sent before. A code for an earlier version is `stale`, so the page can say the link was replaced.
 *
 * The link alone never signs anyone in: a new device also needs the code emailed to the address on file.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { CODE_LENGTH, parseLinkToken } from '../booking/links';
import { parseKey } from '../crypto';
import type { TenantScope } from '../services';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PURPOSE = 'hfos:portal-links:v1';
const STALE_LOOKBACK = 50;

export interface PortalLinks {
  readonly webUrl: string;
  /** Current key first, then previous ones (WORKER_ENCRYPTION_KEYS_PREVIOUS). */
  readonly keys: readonly Buffer[];
}

export function createPortalLinks(opts: {
  webUrl: string;
  key: string;
  previousKeys?: readonly string[];
}): PortalLinks {
  const derive = (k: string) => createHmac('sha256', parseKey(k)).update(PURPOSE).digest();
  return {
    webUrl: opts.webUrl.replace(/\/+$/, ''),
    keys: [derive(opts.key), ...(opts.previousKeys ?? []).map(derive)],
  };
}

function base62(bytes: Buffer, length: number): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (out.length < length) {
    out += ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

const sign = (key: Buffer, accessId: string, version: number) =>
  base62(createHmac('sha256', key).update(`${accessId}:${version}`).digest(), CODE_LENGTH);

function matches(links: PortalLinks, code: string, accessId: string, version: number): boolean {
  if (code.length !== CODE_LENGTH) return false;
  const given = Buffer.from(code);
  let ok = false;
  for (const key of links.keys)
    if (timingSafeEqual(Buffer.from(sign(key, accessId, version)), given)) ok = true;
  return ok;
}

export interface PortalLink {
  readonly publicRef: string;
  readonly accessId: string;
  readonly linkVersion: number;
}

/** `<public_ref><code>`: the part after /c/. */
export function portalToken(links: PortalLinks, link: PortalLink): string {
  if (!/^[0-9A-Za-z]{8}$/.test(link.publicRef))
    throw new Error(`Not a public reference: ${link.publicRef}`);
  return link.publicRef + sign(links.keys[0]!, link.accessId, link.linkVersion);
}

/** The client's portal: on the business's own address when one is serving (M17), ours otherwise. */
export function portalUrl(links: PortalLinks, link: PortalLink, origin = links.webUrl): string {
  return `${origin.replace(/\/+$/, '')}/c/${portalToken(links, link)}`;
}

export type PortalTokenResult =
  | {
      readonly status: 'ok';
      readonly accessId: string;
      readonly personId: string;
      readonly linkVersion: number;
      readonly scope: TenantScope;
    }
  /** Signed for an earlier version: they were sent a newer link, or the portal was turned off and on again. */
  | { readonly status: 'stale'; readonly scope: TenantScope }
  /** The business turned the portal off for them. */
  | { readonly status: 'off'; readonly scope: TenantScope }
  | { readonly status: 'invalid' };

type LookupRow = {
  access_id: string;
  workspace_id: string;
  organization_id: string;
  person_id: string;
  link_version: number;
  revoked: boolean;
};

/** Finds and checks a portal link: the worker-only lookup by reference, then the HMAC against its version. */
export async function resolvePortalToken(
  db: Db,
  links: PortalLinks,
  token: string,
): Promise<PortalTokenResult> {
  const parsed = parseLinkToken(token);
  if (!parsed) return { status: 'invalid' };
  const [row] = await asWorker(db, {}, (tx) =>
    rows<LookupRow>(tx, sql`select * from private.portal_link_lookup(${parsed.publicRef})`),
  );
  if (!row) return { status: 'invalid' };
  const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
  if (matches(links, parsed.code, row.access_id, row.link_version)) {
    if (row.revoked) return { status: 'off', scope };
    return {
      status: 'ok',
      accessId: row.access_id,
      personId: row.person_id,
      linkVersion: row.link_version,
      scope,
    };
  }
  for (let v = row.link_version - 1; v >= Math.max(1, row.link_version - STALE_LOOKBACK); v--)
    if (matches(links, parsed.code, row.access_id, v))
      return row.revoked ? { status: 'off', scope } : { status: 'stale', scope };
  return { status: 'invalid' };
}
