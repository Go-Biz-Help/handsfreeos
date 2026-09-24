/**
 * The address a business's customers see (M17).
 *
 * Every public link we hand out — a form, a payment link, an estimate, an invoice, a plan, the booking page, a
 * change-or-cancel link, a waitlist offer, the chat widget — has to be on the business's own domain once one
 * is working, or they get a branded page full of unbranded links, which reads as a broken setup
 * rather than a half-finished feature.
 *
 * **The path never changes, only the origin.** `brandedHostProxy` serves every one of those paths on a
 * branded domain unaltered, which is what makes this a one-line swap at each call site instead of a second
 * set of link builders: `https://go.lonestarhvac.com/i/AbCd1234…` is the same link as
 * `https://handsfreeos.com/i/AbCd1234…`, and a link already sent on either name keeps working.
 *
 * **Not the app.** `/app/…` links go to the business's own team and stay on our address; the proxy redirects
 * them off a branded domain anyway. Only the pages a customer opens move.
 */
import { eq } from 'drizzle-orm';
import { brandedDomains } from '@hfos/db/schema';
import type { Tx } from '@hfos/db/client';

/**
 * Long enough that sending a hundred reminders is one read, short enough that a domain that has just gone
 * live starts being used within the minute. The cost of being stale either way is a working link on the
 * other name, so this can be generous.
 */
const TTL_MS = 60_000;

interface Cached {
  readonly origin: string | null;
  readonly at: number;
}
const cache = new Map<string, Cached>();

/**
 * Forget what was cached, so the next read goes to the database.
 *
 * Called whenever the worker itself changes a domain's state. It matters most in one direction: a domain
 * that has just been **removed** would otherwise go on being used for up to a minute, and a link built on a
 * name that no longer resolves is a dead link, where the other direction — a new domain taking a minute to
 * be picked up — only means a link on our own address, which works.
 */
export function forgetPublicOrigin(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/**
 * `https://go.lonestarhvac.com` when this workspace's domain is verified and its certificate is issued,
 * and null otherwise. `tx` must already be scoped to the workspace — RLS is what makes the row the right
 * one, so this never takes a workspace id it could get wrong.
 */
async function servingOrigin(tx: Tx, workspaceId: string): Promise<string | null> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.origin;
  const [row] = await tx
    .select({
      domain: brandedDomains.domain,
      status: brandedDomains.status,
      certificateReady: brandedDomains.certificateReady,
    })
    .from(brandedDomains)
    .where(eq(brandedDomains.workspaceId, workspaceId));
  const origin =
    row && row.status === 'verified' && row.certificateReady ? `https://${row.domain}` : null;
  cache.set(workspaceId, { origin, at: Date.now() });
  return origin;
}

/**
 * The origin to build this workspace's public links on: its own domain when one is serving, ours otherwise.
 *
 * A database that is unreachable or a row that cannot be read gives our own address rather than throwing —
 * a confirmation text that goes out on the wrong name is a much smaller failure than one that does not go.
 */
export async function publicOrigin(tx: Tx, workspaceId: string, ours: string): Promise<string> {
  try {
    return (await servingOrigin(tx, workspaceId)) ?? ours;
  } catch {
    return ours;
  }
}

/** A links object pointed at a different origin. The signing keys are untouched: a link is a link. */
export function linksOn<T extends { readonly webUrl: string }>(links: T, origin: string): T {
  return origin === links.webUrl ? links : { ...links, webUrl: origin.replace(/\/+$/, '') };
}
