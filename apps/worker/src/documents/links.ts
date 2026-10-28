/**
 * A signer's private link to a document they were sent to sign: `${WEB_URL}/d/<public_ref><code>` (answer 11a).
 *
 * The same shape as the money pages' links (money/links.ts): the signer row's 8-character public reference
 * (random, unique, not secret) and a 10-character code, the first ten base62 characters of an HMAC-SHA256 over
 * `${signerId}:${linkVersion}` with a key of its own (`hfos:document-signing-links:v1`). **Nothing secret is
 * stored**, and raising a signer's `link_version` retires every link already sent to them. Codes signed with a
 * previous key still open, and every key is tried, in constant time.
 *
 * The 6-digit code a signer can be asked for first is kept only as an HMAC with the same key, so nobody who can
 * read the table can try the million codes against it.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { CODE_LENGTH, parseLinkToken } from '../booking/links';
import { linksOn, publicOrigin } from '../hosting/origin';
import { base62, type MoneyLinks } from '../money/links';
import type { TenantScope } from '../services';

const REF_RE = /^[0-9A-Za-z]{8}$/;
/** How far back a code is recognized as an older version's (a "this link is out of date" page). */
const STALE_LOOKBACK = 20;

export const SIGNING_LINK_PATH = 'd';

const sign = (key: Buffer, message: string): string =>
  base62(createHmac('sha256', key).update(message).digest(), CODE_LENGTH);

const signerMessage = (signerId: string, linkVersion: number) => `${signerId}:${linkVersion}`;

export interface SignerLink {
  readonly publicRef: string;
  readonly signerId: string;
  readonly linkVersion: number;
}

/** `<public_ref><code>`: the part of the link after /d/. */
export function signerToken(links: MoneyLinks, link: SignerLink): string {
  if (!REF_RE.test(link.publicRef)) throw new Error(`Not a public reference: ${link.publicRef}`);
  return link.publicRef + sign(links.signing[0]!, signerMessage(link.signerId, link.linkVersion));
}

export const signerUrl = (links: MoneyLinks, link: SignerLink): string =>
  `${links.webUrl}/${SIGNING_LINK_PATH}/${signerToken(links, link)}`;

function matches(links: MoneyLinks, code: string, message: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  const given = Buffer.from(code);
  let ok = false;
  for (const key of links.signing)
    if (timingSafeEqual(Buffer.from(sign(key, message)), given)) ok = true;
  return ok;
}

export type SignerTokenResult =
  | {
      readonly status: 'ok';
      readonly signerId: string;
      readonly documentId: string;
      readonly scope: TenantScope;
    }
  /** Signed for an earlier version: they were sent a newer link. */
  | { readonly status: 'stale'; readonly scope: TenantScope }
  | { readonly status: 'invalid' };

/**
 * Finds and checks a signer's link: the worker-only lookup by reference (which knows nothing of RLS), then the HMAC
 * against the signer's current `link_version`, then the last few versions so an old link is told apart from a
 * forged one.
 */
export async function resolveSignerToken(
  db: Db,
  links: MoneyLinks,
  token: string,
): Promise<SignerTokenResult> {
  const parsed = parseLinkToken(token);
  if (!parsed) return { status: 'invalid' };
  const [row] = await asWorker(db, {}, (tx) =>
    rows<{
      signer_id: string;
      document_id: string;
      link_version: number;
      workspace_id: string;
      organization_id: string;
    }>(tx, sql`select * from private.document_signer_lookup(${parsed.publicRef})`),
  );
  if (!row) return { status: 'invalid' };
  const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
  if (matches(links, parsed.code, signerMessage(row.signer_id, row.link_version)))
    return { status: 'ok', signerId: row.signer_id, documentId: row.document_id, scope };
  for (let v = row.link_version - 1; v >= Math.max(1, row.link_version - STALE_LOOKBACK); v--)
    if (matches(links, parsed.code, signerMessage(row.signer_id, v)))
      return { status: 'stale', scope };
  return { status: 'invalid' };
}

/** A signer's current link, read inside the business's scope, on its own domain once one is serving. */
export async function signerUrlFor(
  tx: Tx,
  links: MoneyLinks,
  signerId: string,
): Promise<string | null> {
  const [s] = await rows<{ public_ref: string; link_version: number; workspace_id: string }>(
    tx,
    sql`select public_ref, link_version, workspace_id from app.document_signers where id = ${signerId}`,
  );
  if (!s) return null;
  const on = linksOn(links, await publicOrigin(tx, s.workspace_id, links.webUrl));
  return signerUrl(on, { publicRef: s.public_ref, signerId, linkVersion: s.link_version });
}

/** A fresh 6-digit code, with a leading zero as likely as any other digit. */
export const newSigningCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** The code as it's kept: an HMAC with the signing key, over the signer it was sent to. */
export const signingCodeHash = (links: MoneyLinks, signerId: string, code: string): string =>
  createHmac('sha256', links.signing[0]!).update(`code:${signerId}:${code}`).digest('hex');
