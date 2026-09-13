/**
 * Short signed links for customers: change or cancel a booking (`/m/…`) and claim a waitlist offer (`/w/…`).
 *
 * A link is `${WEB_URL}/m/<public_ref><code>`: the booking's 8-character public reference (random, unique,
 * not secret; migration 0018) and a 10-character code, the first ten base62 characters of an HMAC-SHA256
 * over `${attendeeId}:${manageVersion}` (`waitlist:${entryId}` for offers). Nothing secret is stored:
 * raising an attendee's manage_version retires every link sent before it.
 *
 * The HMAC key is derived from WORKER_ENCRYPTION_KEY. Codes signed with a previous key
 * (WORKER_ENCRYPTION_KEYS_PREVIOUS, the way `createSealer` opens old values) still verify, and codes are
 * compared in constant time with every key tried.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { appointmentAttendees, waitlistEntries } from '@hfos/db/schema';
import { parseKey } from '../crypto';
import type { TenantScope } from '../services';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_REF_LENGTH = 8;
export const CODE_LENGTH = 10;
const REF_RE = /^[0-9A-Za-z]{8}$/;
const TOKEN_RE = /^[0-9A-Za-z]{18}$/;
/** Separates this key from every other use of WORKER_ENCRYPTION_KEY. */
const PURPOSE = 'hfos:booking-links:v1';
/** How far back a code is recognized as an older version's (a "this link is out of date" page). */
const STALE_LOOKBACK = 50;

/** The web address links point at and the keys that sign them (current first, then previous ones). */
export interface BookingLinks {
  readonly webUrl: string;
  readonly keys: readonly Buffer[];
}

export function createBookingLinks(opts: {
  webUrl: string;
  key: string;
  previousKeys?: readonly string[];
}): BookingLinks {
  const derive = (k: string) => createHmac('sha256', parseKey(k)).update(PURPOSE).digest();
  return {
    webUrl: opts.webUrl.replace(/\/+$/, ''),
    keys: [derive(opts.key), ...(opts.previousKeys ?? []).map(derive)],
  };
}

/** The digest as a base62 number, least significant digit first, cut to `length` characters. */
function base62(bytes: Buffer, length: number): string {
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
const manageMessage = (attendeeId: string, manageVersion: number) =>
  `${attendeeId}:${manageVersion}`;
const waitlistMessage = (entryId: string) => `waitlist:${entryId}`;

/** True when `code` was signed for `message` by any of the keys; every key is tried, so timing says nothing. */
function matches(links: BookingLinks, code: string, message: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  const given = Buffer.from(code);
  let ok = false;
  for (const key of links.keys)
    if (timingSafeEqual(Buffer.from(sign(key, message)), given)) ok = true;
  return ok;
}

function ref(publicRef: string): string {
  if (!REF_RE.test(publicRef)) throw new Error(`Not a public reference: ${publicRef}`);
  return publicRef;
}

export interface ManageLink {
  readonly publicRef: string;
  readonly attendeeId: string;
  readonly manageVersion: number;
}
export interface WaitlistLink {
  readonly publicRef: string;
  readonly entryId: string;
}

/** `<public_ref><code>`: the part of the link after /m/. */
export function manageToken(links: BookingLinks, link: ManageLink): string {
  return (
    ref(link.publicRef) + sign(links.keys[0]!, manageMessage(link.attendeeId, link.manageVersion))
  );
}
/** The change-or-cancel page for a booking: `${WEB_URL}/m/<public_ref><code>`. */
export function manageUrl(links: BookingLinks, link: ManageLink): string {
  return `${links.webUrl}/m/${manageToken(links, link)}`;
}
/** `<public_ref><code>`: the part of the link after /w/. */
export function waitlistToken(links: BookingLinks, link: WaitlistLink): string {
  return ref(link.publicRef) + sign(links.keys[0]!, waitlistMessage(link.entryId));
}
/** A waitlist offer's page: `${WEB_URL}/w/<public_ref><code>`. */
export function waitlistUrl(links: BookingLinks, link: WaitlistLink): string {
  return `${links.webUrl}/w/${waitlistToken(links, link)}`;
}

/** Splits a link's token into its reference and code, or null when it can't be one. */
export function parseLinkToken(token: string): { publicRef: string; code: string } | null {
  if (!TOKEN_RE.test(token)) return null;
  return { publicRef: token.slice(0, PUBLIC_REF_LENGTH), code: token.slice(PUBLIC_REF_LENGTH) };
}

export function verifyManageCode(
  links: BookingLinks,
  code: string,
  attendeeId: string,
  manageVersion: number,
): boolean {
  return matches(links, code, manageMessage(attendeeId, manageVersion));
}

export function verifyWaitlistCode(links: BookingLinks, code: string, entryId: string): boolean {
  return matches(links, code, waitlistMessage(entryId));
}

export type ManageTokenResult =
  | {
      readonly status: 'ok';
      readonly attendeeId: string;
      readonly manageVersion: number;
      readonly publicRef: string;
      readonly scope: TenantScope;
    }
  /** Signed for an earlier version: the booking changed after this link was sent. */
  | { readonly status: 'stale'; readonly attendeeId: string; readonly scope: TenantScope }
  | { readonly status: 'invalid' };

/** Finds and checks a change-or-cancel link (the worker's lookup, then the HMAC against manage_version). */
export async function resolveManageToken(
  db: Db,
  links: BookingLinks,
  token: string,
): Promise<ManageTokenResult> {
  const parsed = parseLinkToken(token);
  if (!parsed) return { status: 'invalid' };
  const [row] = await asWorker(db, {}, (tx) =>
    rows<{
      attendee_id: string;
      workspace_id: string;
      organization_id: string;
      manage_version: number;
    }>(tx, sql`select * from private.booking_manage_lookup(${parsed.publicRef})`),
  );
  if (!row) return { status: 'invalid' };
  const scope = { workspaceId: row.workspace_id, organizationId: row.organization_id };
  if (verifyManageCode(links, parsed.code, row.attendee_id, row.manage_version))
    return {
      status: 'ok',
      attendeeId: row.attendee_id,
      manageVersion: row.manage_version,
      publicRef: parsed.publicRef,
      scope,
    };
  const oldest = Math.max(1, row.manage_version - STALE_LOOKBACK);
  for (let v = row.manage_version - 1; v >= oldest; v--)
    if (verifyManageCode(links, parsed.code, row.attendee_id, v))
      return { status: 'stale', attendeeId: row.attendee_id, scope };
  return { status: 'invalid' };
}

export type WaitlistTokenResult =
  | {
      readonly status: 'ok';
      readonly entryId: string;
      readonly publicRef: string;
      readonly scope: TenantScope;
    }
  | { readonly status: 'invalid' };

/** Finds and checks a waitlist offer link. */
export async function resolveWaitlistToken(
  db: Db,
  links: BookingLinks,
  token: string,
): Promise<WaitlistTokenResult> {
  const parsed = parseLinkToken(token);
  if (!parsed) return { status: 'invalid' };
  const [row] = await asWorker(db, {}, (tx) =>
    rows<{ entry_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select * from private.waitlist_offer_lookup(${parsed.publicRef})`,
    ),
  );
  if (!row || !verifyWaitlistCode(links, parsed.code, row.entry_id)) return { status: 'invalid' };
  return {
    status: 'ok',
    entryId: row.entry_id,
    publicRef: parsed.publicRef,
    scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
  };
}

/** A booking's current change-or-cancel link, read inside its workspace's scope (confirmations, reminders). */
export async function manageUrlFor(
  tx: Tx,
  links: BookingLinks,
  attendeeId: string,
): Promise<string | null> {
  const [a] = await tx
    .select({
      publicRef: appointmentAttendees.publicRef,
      manageVersion: appointmentAttendees.manageVersion,
    })
    .from(appointmentAttendees)
    .where(eq(appointmentAttendees.id, attendeeId));
  return a
    ? manageUrl(links, { publicRef: a.publicRef, attendeeId, manageVersion: a.manageVersion })
    : null;
}

/** A waitlist entry's offer link, read inside its workspace's scope (the offer text and email). */
export async function waitlistUrlFor(
  tx: Tx,
  links: BookingLinks,
  entryId: string,
): Promise<string | null> {
  const [e] = await tx
    .select({ publicRef: waitlistEntries.publicRef })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, entryId));
  return e ? waitlistUrl(links, { publicRef: e.publicRef, entryId }) : null;
}
