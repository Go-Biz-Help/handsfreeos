import { DatabaseSync } from 'node:sqlite';

import { KeptFiles, type SqlValue, type SyncSql } from '../kept-files';
import { keptStore } from '../kept-store';

/** The phone's kept files on in-memory SQLite, as tests open them. */
export function memoryKeptFiles(now?: () => number): { kept: KeptFiles; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  const db: SyncSql = {
    run: (sql, params: readonly SqlValue[] = []) => void sqlite.prepare(sql).run(...params),
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      sqlite.prepare(sql).all(...params) as T[],
  };
  return { kept: new KeptFiles(db, now), sqlite };
}

/** Opens a person's kept files for a test, as their copy opening does; closing them is `keptStore.closing`. */
export function openMemoryKeptFiles(userId: string, now?: () => number): KeptFiles {
  const { kept, sqlite } = memoryKeptFiles(now);
  keptStore.opened(userId, { files: kept, close: () => sqlite.close() });
  return kept;
}
