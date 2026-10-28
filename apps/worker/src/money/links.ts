/**
 * Short signed links for customers: approve an estimate (`/e/…`), pay an invoice (`/i/…`), and put a card on a
 * maintenance plan (`/p/…`).
 *
 * The same shape as the booking manage link (booking/links.ts), because the same things are true of it: the
 * link goes out by text and email, mail scanners open it, and nothing about it may be guessable. A link is
 * `${WEB_URL}/e/<public_ref><code>`: the document's 8-character public reference (random, unique, not secret;
 * migration 0045) and a 10-character code, the first ten base62 characters of an HMAC-SHA256 over
 * `${documentId}:${linkVersion}`. **Nothing secret is stored** — raising a document's `link_version` retires
 * every link already sent for it.
 *
 * Estimates and invoices have **their own derived keys** (`hfos:estimate-links:v1` and
 * `hfos:invoice-links:v1`), beside the booking one, so a code that opens an estimate can never open the invoice
 * that happens to share its reference and version. Codes signed with a previous key
 * (WORKER_ENCRYPTION_KEYS_PREVIOUS, the way `createSealer` opens old values) still verify, and codes are
 * compared in constant time with every key tried.
 *
 * A code that matches an **earlier** version is `stale`, not invalid: the customer was sent a newer link, and
 * the page can say so instead of pretending the document never existed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { estimates, invoices } from '@hfos/db/schema';
import { CODE_LENGTH, parseLinkToken, PUBLIC_REF_LENGTH } from '../booking/links';
import { parseKey } from '../crypto';
import { linksOn, publicOrigin } from '../hosting/origin';
import type { TenantScope } from '../services';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const REF_RE = /^[0-9A-Za-z]{8}$/;
/** Separates these keys from the booking links' and from every other use of WORKER_ENCRYPTION_KEY. */
const PURPOSE = {
  estimate: 'hfos:estimate-links:v1',
  invoice: 'hfos:invoice-links:v1',
  plan: 'hfos:plan-links:v1',
} as const;
/** A signer's link to a document they were sent to sign (documents/links.ts), and the codes that open it. */
const SIGNING_PURPOSE = 'hfos:document-signing-links:v1';
/** How far back a code is recognized as an older version's (a "this link is out of date" page). */
const STALE_LOOKBACK = 50;

/**
 * Which of the customer's money pages a link is for. The path is `/e/`, `/i/` or `/p/`, and each has its own
 * derived key, so a code that opens an estimate can never open the invoice or the plan that happen to share its
 * reference and version. A plan's version is its `pay_version`, not a `link_version`.
 */
export type MoneyDocumentKind = 'estimate' | 'invoice' | 'plan';

/** Where money links point, and the keys that sign each kind (current first, then previous ones). */
export interface MoneyLinks {
  readonly webUrl: string;
  readonly keys: Readonly<Record<MoneyDocumentKind, readonly Buffer[]>>;
  /** The keys that sign a signer's link to a document (`/d/…`), beside the money pages' own. */
  readonly signing: readonly Buffer[];
}

export function createMoneyLinks(opts: {
  webUrl: string;
  key: string;
  previousKeys?: readonly string[];
}): MoneyLinks {
  const derive = (purpose: string) => (k: string) =>
    createHmac('sha256', parseKey(k)).update(purpose).digest();
  const keysFor = (kind: MoneyDocumentKind) => [
    derive(PURPOSE[kind])(opts.key),
    ...(opts.previousKeys ?? []).map(derive(PURPOSE[kind])),
  ];
  return {
    webUrl: opts.webUrl.replace(/\/+$/, ''),
    keys: { estimate: keysFor('estimate'), invoice: keysFor('invoice'), plan: keysFor('plan') },
    signing: [
      derive(SIGNING_PURPOSE)(opts.key),
      ...(opts.previousKeys ?? []).map(derive(SIGNING_PURPOSE)),
    ],
  };
}

/** The digest as a base62 number, least significant digit first, cut to `length` characters. */
export function base62(bytes: Buffer, length: number): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (out.length < length) {
    out += ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

const sign = (key: Buffer, message: string): string =>
  base62(createHmac('sha256', key).update(message).digest(), CODE_LENGTH);

const documentMessage = (documentId: string, linkVersion: number) => `${documentId}:${linkVersion}`;

/** True when `code` was signed for `message` by any of that kind's keys; every key is tried, so timing says nothing. */
function matches(
  links: MoneyLinks,
  kind: MoneyDocumentKind,
  code: string,
  message: string,
): boolean {
  if (code.length !== CODE_LENGTH) return false;
  const given = Buffer.from(code);
  let ok = false;
  for (const key of links.keys[kind])
    if (timingSafeEqual(Buffer.from(sign(key, message)), given)) ok = true;
  return ok;
}

function ref(publicRef: string): string {
  if (!REF_RE.test(publicRef)) throw new Error(`Not a public reference: ${publicRef}`);
  return publicRef;
}

/** The path a kind's links live under: `/e/<token>`, `/i/<token>` and `/p/<token>`. */
export const MONEY_LINK_PATH: Readonly<Record<MoneyDocumentKind, string>> = {
  estimate: 'e',
  invoice: 'i',
  plan: 'p',
};

export interface MoneyLink {
  readonly publicRef: string;
  readonly documentId: string;
  readonly linkVersion: number;
}

/** `<public_ref><code>`: the part of the link after /e/ or /i/. */
export function documentToken(links: MoneyLinks, kind: MoneyDocumentKind, link: MoneyLink): string {
  return (
    ref(link.publicRef) +
    sign(links.keys[kind][0]!, documentMessage(link.documentId, link.linkVersion))
  );
}

/** The customer's page for one document: `${WEB_URL}/e/<token>` or `${WEB_URL}/i/<token>`. */
export function documentUrl(links: MoneyLinks, kind: MoneyDocumentKind, link: MoneyLink): string {
  return `${links.webUrl}/${MONEY_LINK_PATH[kind]}/${documentToken(links, kind, link)}`;
}

export const estimateToken = (links: MoneyLinks, link: MoneyLink): string =>
  documentToken(links, 'estimate', link);
export const estimateUrl = (links: MoneyLinks, link: MoneyLink): string =>
  documentUrl(links, 'estimate', link);
export const invoiceToken = (links: MoneyLinks, link: MoneyLink): string =>
  documentToken(links, 'invoice', link);
export const invoiceUrl = (links: MoneyLinks, link: MoneyLink): string =>
  documentUrl(links, 'invoice', link);
export const planUrl = (links: MoneyLinks, link: MoneyLink): string =>
  documentUrl(links, 'plan', link);

export function verifyDocumentCode(
  links: MoneyLinks,
  kind: MoneyDocumentKind,
  code: string,
  documentId: string,
  linkVersion: number,
): boolean {
  return matches(links, kind, code, documentMessage(documentId, linkVersion));
}

export type MoneyTokenResult =
  | {
      readonly status: 'ok';
      readonly kind: MoneyDocumentKind;
      readonly documentId: string;
      readonly linkVersion: number;
      readonly publicRef: string;
      readonly scope: TenantScope;
    }
  /** Signed for an earlier version: the document was reissued after this link was sent. */
  | {
      readonly status: 'stale';
      readonly kind: MoneyDocumentKind;
      readonly documentId: string;
      readonly scope: TenantScope;
    }
  | { readonly status: 'invalid' };

type LookupRow = {
  estimate_id?: string;
  invoice_id?: string;
  subscription_id?: string;
  workspace_id: string;
  organization_id: string;
  /** A document's `link_version`; a plan's own version is its `pay_version` (migration 0048). */
  link_version?: number;
  pay_version?: number;
};

/**
 * Finds and checks one of the customer's money links: the worker-only lookup by reference (which knows nothing
 * of RLS), then the HMAC against the document's current `link_version`, then the last few versions so an old
 * link is told apart from a forged one.
 */
export async function resolveDocumentToken(
  db: Db,
  links: MoneyLinks,
  kind: MoneyDocumentKind,
  token: string,
): Promise<MoneyTokenResult> {
  const parsed = parseLinkToken(token);
  if (!parsed) return { status: 'invalid' };
  const lookup =
    kind === 'estimate'
      ? sql`select * from private.estimate_link_lookup(${parsed.publicRef})`
      : kind === 'invoice'
        ? sql`select * from private.invoice_link_lookup(${parsed.publicRef})`
        : sql`select * from private.subscription_link_lookup(${parsed.publicRef})`;
  const [row] = await asWorker(db, {}, (tx) => rows<LookupRow>(tx, lookup));
  const documentId = row?.estimate_id ?? row?.invoice_id ?? row?.subscription_id;
  const version = row?.link_version ?? row?.pay_version;
  if (!row || !documentId || !version) return { status: 'invalid' };
  const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
  if (verifyDocumentCode(links, kind, parsed.code, documentId, version))
    return {
      status: 'ok',
      kind,
      documentId,
      linkVersion: version,
      publicRef: parsed.publicRef,
      scope,
    };
  const oldest = Math.max(1, version - STALE_LOOKBACK);
  for (let v = version - 1; v >= oldest; v--)
    if (verifyDocumentCode(links, kind, parsed.code, documentId, v))
      return { status: 'stale', kind, documentId, scope };
  return { status: 'invalid' };
}

export const resolveEstimateToken = (db: Db, links: MoneyLinks, token: string) =>
  resolveDocumentToken(db, links, 'estimate', token);
export const resolveInvoiceToken = (db: Db, links: MoneyLinks, token: string) =>
  resolveDocumentToken(db, links, 'invoice', token);
export const resolvePlanToken = (db: Db, links: MoneyLinks, token: string) =>
  resolveDocumentToken(db, links, 'plan', token);

/**
 * An estimate's current link, read inside its workspace's scope (the text and email that send it).
 *
 * On the business's own domain once one is serving (M17). The workspace comes off the row this already
 * reads, the way `manageUrlFor` does, so no caller can pass the wrong one.
 */
export async function estimateUrlFor(
  tx: Tx,
  links: MoneyLinks,
  estimateId: string,
): Promise<string | null> {
  const [e] = await tx
    .select({
      publicRef: estimates.publicRef,
      linkVersion: estimates.linkVersion,
      workspaceId: estimates.workspaceId,
    })
    .from(estimates)
    .where(eq(estimates.id, estimateId));
  if (!e) return null;
  const on = linksOn(links, await publicOrigin(tx, e.workspaceId, links.webUrl));
  return estimateUrl(on, {
    publicRef: e.publicRef,
    documentId: estimateId,
    linkVersion: e.linkVersion,
  });
}

/**
 * A plan's current link, read inside its workspace's scope: the page the customer puts a card on, and the same
 * page they change it on later. Signed over `pay_version`, so raising that retires every link already sent.
 */
export async function planUrlFor(
  tx: Tx,
  links: MoneyLinks,
  subscriptionId: string,
): Promise<string | null> {
  const [s] = await rows<{ public_ref: string; pay_version: number; workspace_id: string }>(
    tx,
    sql`select public_ref, pay_version, workspace_id from app.subscriptions where id = ${subscriptionId}`,
  );
  if (!s) return null;
  const on = linksOn(links, await publicOrigin(tx, s.workspace_id, links.webUrl));
  return planUrl(on, {
    publicRef: s.public_ref,
    documentId: subscriptionId,
    linkVersion: s.pay_version,
  });
}

/** An invoice's current link, read inside its workspace's scope (the invoice, the reminders, the receipt). */
export async function invoiceUrlFor(
  tx: Tx,
  links: MoneyLinks,
  invoiceId: string,
): Promise<string | null> {
  const [i] = await tx
    .select({
      publicRef: invoices.publicRef,
      linkVersion: invoices.linkVersion,
      workspaceId: invoices.workspaceId,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!i) return null;
  const on = linksOn(links, await publicOrigin(tx, i.workspaceId, links.webUrl));
  return invoiceUrl(on, {
    publicRef: i.publicRef,
    documentId: invoiceId,
    linkVersion: i.linkVersion,
  });
}

export { PUBLIC_REF_LENGTH, CODE_LENGTH };
