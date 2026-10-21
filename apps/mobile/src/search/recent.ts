import { RECENT_SEARCHES_KEPT, recentSearchText, sameSearch } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as Crypto from 'expo-crypto';

/**
 * Recent searches on the phone (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision 17): kept in the phone's own
 * encrypted database (`search_recent`, local-only, never sent), by person and business, by core's one rule as the web
 * keeps its own (at most 8, the same words searched again moving up). The copy is the signed-in person's own file, and
 * every row names who typed it besides, so a phone two people use never shows one the other's searches.
 */

/** Searches kept a person, a business: core's. */
export const RECENT_KEPT = RECENT_SEARCHES_KEPT;

export interface RecentSearch {
  readonly id: string;
  readonly q: string;
  readonly at: string;
}

/** Just what recent searches ask of the phone's database. */
export interface RecentDb {
  execute(sql: string, parameters?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
}

export const RECENT_SQL = `
  SELECT id, q, at FROM search_recent WHERE workspace_id = ? AND user_id = ? ORDER BY at DESC LIMIT ${RECENT_KEPT}`;

/** A person's recent searches in a business, newest first. */
export function useRecentSearches(workspaceId: string, userId: string): readonly RecentSearch[] {
  return useQuery<RecentSearch>(RECENT_SQL, [workspaceId, userId]).data;
}

/**
 * Keeps a search at the top of the list: the same words searched again move up, whatever their case or accents
 * (core's `sameSearch`, which SQLite's `lower` couldn't do), and the oldest past 8 go.
 */
export async function rememberSearch(
  db: RecentDb,
  who: { readonly workspaceId: string; readonly userId: string },
  typed: string,
): Promise<void> {
  const q = recentSearchText(typed);
  if (!q) return;
  const was = await db.getAll<{ id: string; q: string }>(
    'SELECT id, q FROM search_recent WHERE workspace_id = ? AND user_id = ? ORDER BY at DESC',
    [who.workspaceId, who.userId],
  );
  const kept = new Set(
    was
      .filter((r) => !sameSearch(r.q, q))
      .slice(0, RECENT_KEPT - 1)
      .map((r) => r.id),
  );
  const gone = was.filter((r) => !kept.has(r.id)).map((r) => r.id);
  if (gone.length)
    await db.execute(
      `DELETE FROM search_recent WHERE id IN (${gone.map(() => '?').join(', ')})`,
      gone,
    );
  await db.execute(
    'INSERT INTO search_recent (id, workspace_id, user_id, q, at) VALUES (?, ?, ?, ?, ?)',
    [Crypto.randomUUID(), who.workspaceId, who.userId, q, new Date().toISOString()],
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
