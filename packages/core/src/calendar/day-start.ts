/**
 * Where each person's day starts (docs/outreach.md, decision 179): the address they set out from, which times the
 * drive to their first visit of a day on a calendar that leaves time to drive between visits. Their own when they
 * set one (app.day_starts, read by them and by owners and admins only), the business's address otherwise.
 * Server-side: it reads the database.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { dayStarts } from '@hfos/db/schema';
import { businessPostalAddress } from '../campaigns/postal-address';
import type { DayStartShown } from '../schemas/calendar';

/** The business's address on one line, for a map: "12 Oak St, Suite 4, Austin, TX 78701". Null when it has none. */
export async function businessStartAddress(tx: Tx, workspaceId: string): Promise<string | null> {
  const lines = await businessPostalAddress(tx, workspaceId);
  return (
    lines
      ?.split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(', ') || null
  );
}

/** Each person's own start address, as far as the reader may see it (RLS); people with none are left out. */
export async function ownDayStarts(
  tx: Tx,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const found = await tx
    .select({ userId: dayStarts.userId, address: dayStarts.address })
    .from(dayStarts)
    .where(and(eq(dayStarts.workspaceId, workspaceId), inArray(dayStarts.userId, [...userIds])));
  return new Map(found.map((r) => [r.userId, r.address]));
}

/** Where each person's day starts: their own address, else the business's (null when neither is known). */
export async function dayStartAddresses(
  tx: Tx,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const own = await ownDayStarts(tx, workspaceId, userIds);
  const business = await businessStartAddress(tx, workspaceId);
  return new Map(userIds.map((u) => [u, own.get(u) ?? business]));
}

export async function dayStartShown(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<DayStartShown> {
  const own = await ownDayStarts(tx, workspaceId, [userId]);
  return {
    userId,
    address: own.get(userId) ?? null,
    businessAddress: await businessStartAddress(tx, workspaceId),
  };
}
