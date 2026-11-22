/**
 * Where an address is, as the worker found it on a map once and kept it (app.geocodes, apps/worker/src/geo). Server
 * only: the table is the worker's, so only commands that run as the worker (a manage link, the AI teammate) read it.
 */
import { createHash } from 'node:crypto';
import { rows, sql, type Tx } from '@hfos/db/client';

/** The key an address is kept under: the same text, however it is spaced or capitalised, is one lookup. */
export const geocodeKey = (address: string): string =>
  createHash('sha256').update(address.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');

/**
 * The map point of an address the worker already looked up, or null when it never did. A booked visit keeps its
 * address and ZIP but not the point, so a calendar that serves a distance or a drawn area reads it back from here
 * when the visit is moved.
 */
export async function keptPoint(
  tx: Tx,
  address: string | null | undefined,
): Promise<{ lat: number; lng: number } | null> {
  if (!address?.trim()) return null;
  const [kept] = await rows<{ lat: number | string; lng: number | string }>(
    tx,
    sql`select lat, lng from app.geocodes where query_hash = ${geocodeKey(address)}`,
  );
  return kept ? { lat: Number(kept.lat), lng: Number(kept.lng) } : null;
}
