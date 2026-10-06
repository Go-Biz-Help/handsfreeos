/**
 * A business's Facebook Pages and Instagram accounts as the worker uses them (20261025000200): with their sealed
 * tokens opened, which nothing outside the worker ever sees.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { metaAccounts, metaConnections } from '@hfos/db/schema';
import type { Sealer } from '../crypto';

export type MetaAccountRow = typeof metaAccounts.$inferSelect;
export type MetaConnectionRow = typeof metaConnections.$inferSelect;

/** A sealed token, opened; null when there's none, or it was sealed with a key this worker no longer holds. */
export function openToken(sealer: Sealer, sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return sealer.open(sealed);
  } catch {
    return null;
  }
}

/** One Page or Instagram account of this business, and the Page token it answers with. */
export async function loadMetaAccount(
  tx: Tx,
  sealer: Sealer,
  workspaceId: string,
  accountId: string,
): Promise<{ readonly account: MetaAccountRow; readonly pageToken: string | null } | null> {
  const [account] = await tx
    .select()
    .from(metaAccounts)
    .where(and(eq(metaAccounts.id, accountId), eq(metaAccounts.workspaceId, workspaceId)));
  if (!account) return null;
  return { account, pageToken: openToken(sealer, account.tokenEnc) };
}

/**
 * The sign-in that may read this business's ads: connected, allowed `ads_read`, the newest first. Null when nobody
 * here signed in with it.
 */
export async function adsSignIn(
  tx: Tx,
  sealer: Sealer,
  workspaceId: string,
): Promise<{ readonly connection: MetaConnectionRow; readonly userToken: string } | null> {
  const list = await tx
    .select()
    .from(metaConnections)
    .where(
      and(eq(metaConnections.workspaceId, workspaceId), eq(metaConnections.status, 'connected')),
    )
    .orderBy(desc(metaConnections.connectedAt));
  for (const connection of list) {
    if (!connection.scopes.includes('ads_read')) continue;
    const userToken = openToken(sealer, connection.tokenEnc);
    if (userToken) return { connection, userToken };
  }
  return null;
}
