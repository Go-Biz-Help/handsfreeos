import { useQuery } from '@powersync/react-native';
import * as Crypto from 'expo-crypto';

/**
 * Recent searches on the phone (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision 17): kept in the phone's own
 * encrypted database (`search_recent`, local-only, never sent), by person and business, at most 8 each. The copy is
 * the signed-in person's own file, and every row names who typed it besides, so a phone two people use never shows
 * one the other's searches.
 */

/** Searches kept a person, a business. */
export const RECENT_KEPT = 8;

export interface RecentSearch {
  readonly id: string;
  readonly q: string;
  readonly at: string;
}

/** Just what recent searches ask of the phone's database. */
export interface RecentDb {
  execute(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export const RECENT_SQL = `
  SELECT id, q, at FROM search_recent WHERE workspace_id = ? AND user_id = ? ORDER BY at DESC LIMIT ${RECENT_KEPT}`;

/** A person's recent searches in a business, newest first. */
export function useRecentSearches(workspaceId: string, userId: string): readonly RecentSearch[] {
  return useQuery<RecentSearch>(RECENT_SQL, [workspaceId, userId]).data;
}

/** Keeps a search at the top of the list: the same words searched again move up, and the oldest past 8 go. */
export async function rememberSearch(
  db: RecentDb,
  who: { readonly workspaceId: string; readonly userId: string },
  typed: string,
): Promise<void> {
  const q = typed.trim().slice(0, 120);
  if (q.length < 2) return;
  await db.execute(
    'DELETE FROM search_recent WHERE workspace_id = ? AND user_id = ? AND lower(q) = lower(?)',
    [who.workspaceId, who.userId, q],
  );
  await db.execute(
    'INSERT INTO search_recent (id, workspace_id, user_id, q, at) VALUES (?, ?, ?, ?, ?)',
    [Crypto.randomUUID(), who.workspaceId, who.userId, q, new Date().toISOString()],
  );
  await db.execute(
    `DELETE FROM search_recent WHERE workspace_id = ? AND user_id = ? AND id NOT IN (
       SELECT r.id FROM search_recent r WHERE r.workspace_id = ? AND r.user_id = ?
       ORDER BY r.at DESC LIMIT ${RECENT_KEPT})`,
    [who.workspaceId, who.userId, who.workspaceId, who.userId],
  );
}

/** Clears a person's recent searches in a business. */
export async function clearRecentSearches(
  db: RecentDb,
  who: { readonly workspaceId: string; readonly userId: string },
): Promise<void> {
  await db.execute('DELETE FROM search_recent WHERE workspace_id = ? AND user_id = ?', [
    who.workspaceId,
    who.userId,
  ]);
}
