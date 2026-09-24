/**
 * The unsubscribe link every campaign email carries (CAN-SPAM), in two forms:
 *
 * - the page, `${origin}/u/<token>`, in the email's footer: it says whose email it is and has one button,
 *   because mail scanners open links and a GET must never unsubscribe anybody;
 * - the one-click address, `${WORKER_PUBLIC_URL}/public/unsubscribe/<token>`, in the `List-Unsubscribe` header
 *   (RFC 8058), which a mail app posts to when its own "Unsubscribe" button is pressed.
 *
 * The token is the campaign recipient's id (32 hex characters) and a 16-character code, the first sixteen base62
 * characters of an HMAC-SHA256 over that id with a key derived from WORKER_ENCRYPTION_KEY for this purpose only.
 * Nothing secret is stored. Codes signed with a previous key (WORKER_ENCRYPTION_KEYS_PREVIOUS) still verify, and
 * codes are compared in constant time with every key tried.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { parseKey } from '../crypto';
import type { TenantScope } from '../services';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_LENGTH = 16;
const TOKEN_RE = /^[0-9a-f]{32}[0-9A-Za-z]{16}$/;
/** Separates this key from every other use of WORKER_ENCRYPTION_KEY. */
const PURPOSE = 'hfos:unsubscribe-links:v1';

/** The web address the page is on and the keys that sign the links (current first, then previous ones). */
export interface UnsubscribeLinks {
  readonly webUrl: string;
  readonly publicUrl: string;
  readonly keys: readonly Buffer[];
}

export function createUnsubscribeLinks(opts: {
  webUrl: string;
  publicUrl: string;
  key: string;
  previousKeys?: readonly string[];
}): UnsubscribeLinks {
  const derive = (k: string) => createHmac('sha256', parseKey(k)).update(PURPOSE).digest();
  return {
    webUrl: opts.webUrl.replace(/\/+$/, ''),
    publicUrl: opts.publicUrl.replace(/\/+$/, ''),
    keys: [derive(opts.key), ...(opts.previousKeys ?? []).map(derive)],
  };
}

function sign(key: Buffer, recipientId: string): string {
  let n = BigInt(`0x${createHmac('sha256', key).update(recipientId).digest('hex')}`);
  let out = '';
  while (out.length < CODE_LENGTH) {
    out += ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

const hexOf = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuidOf = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** The part of both links after `/u/` or `/public/unsubscribe/`. */
export function unsubscribeToken(links: UnsubscribeLinks, recipientId: string): string {
  const id = uuidOf(hexOf(recipientId));
  return hexOf(id) + sign(links.keys[0]!, id);
}

/** The page in the footer, on the business's own domain when one is serving (`publicOrigin`). */
export const unsubscribePageUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, '')}/u/${token}`;

/** The address a mail app's own button posts to. */
export const oneClickUrl = (links: UnsubscribeLinks, token: string): string =>
  `${links.publicUrl}/public/unsubscribe/${token}`;

/** The recipient id a token names when its code is right, else null. Every key is tried. */
export function verifyUnsubscribeToken(links: UnsubscribeLinks, token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const id = uuidOf(token.slice(0, 32));
  const given = Buffer.from(token.slice(32));
  let ok = false;
  for (const key of links.keys) if (timingSafeEqual(Buffer.from(sign(key, id)), given)) ok = true;
  return ok ? id : null;
}

export interface UnsubscribeTarget {
  readonly recipientId: string;
  readonly campaignId: string;
  readonly scope: TenantScope;
  /** The address the email went to. */
  readonly address: string | null;
  readonly businessName: string;
}

/** Who a link unsubscribes, or null when the link is wrong or its campaign email is gone. */
export async function resolveUnsubscribeToken(
  db: Db,
  links: UnsubscribeLinks,
  token: string,
): Promise<UnsubscribeTarget | null> {
  const recipientId = verifyUnsubscribeToken(links, token);
  if (!recipientId) return null;
  const [row] = await asWorker(db, {}, (tx) =>
    rows<{
      recipient_id: string;
      campaign_id: string;
      workspace_id: string;
      organization_id: string;
      address: string | null;
      business_name: string;
    }>(tx, sql`select * from private.campaign_unsubscribe_lookup(${recipientId}::uuid)`),
  );
  if (!row) return null;
  return {
    recipientId: row.recipient_id,
    campaignId: row.campaign_id,
    scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
    address: row.address,
    businessName: row.business_name,
  };
}

/** An address as a person may see it on a page anyone with the link can open: `j•••@example.com`. */
export function maskAddress(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}
