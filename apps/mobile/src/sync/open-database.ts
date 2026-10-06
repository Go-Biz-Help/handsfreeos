import { isSQLCipher, open, type DB, type Scalar } from '@op-engineering/op-sqlite';
import { PowerSyncDatabase, type PowerSyncLogger } from '@powersync/react-native';
import { Directory, File } from 'expo-file-system';

import { AppSchema } from './app-schema';
import { photosFolderUri } from './device-files';
import { copyFileName, isPlainSqlite, keptFilesName, type CopyFiles } from './files';
import { KeptFiles, type SyncSql } from './kept-files';
import type { OpenKeptFiles } from './kept-store';
import { rawKeyForm } from './keys';
import { CopyRefused, CopyUnreadable, type OpenedDatabase } from './phone-copy';

/**
 * Opens a person's copy, refusing to open or write anything unless it's really encrypted (spike 1a: with the op-sqlite
 * switch in the wrong package.json, iOS built plain SQLite and ignored the key without a word):
 *   1. the build has SQLCipher, and `PRAGMA cipher_version` answers on a first connection with the key;
 *   2. that connection can read the file, or the key isn't this file's;
 *   3. a file already there doesn't start with "SQLite format 3";
 *   4. PowerSync opens it, and the file still doesn't once PowerSync has written its tables.
 * A copy that fails 1, 3 or 4 is never used, and the app says this phone can't keep a protected copy.
 */
export async function openCopyDatabase(input: {
  readonly userId: string;
  readonly key: string;
  readonly files: CopyFiles;
  readonly logger: PowerSyncLogger;
}): Promise<OpenedDatabase> {
  const { files } = input;
  const name = copyFileName(input.userId);
  const encryptionKey = rawKeyForm(input.key);
  const started = performance.now();
  if (!isSQLCipher())
    throw new CopyRefused('no-sqlcipher', 'This build’s SQLite has no SQLCipher.');

  const probe = open({ name, location: files.folder, encryptionKey });
  let cipherVersion = '';
  try {
    const version = await probe.execute('PRAGMA cipher_version');
    cipherVersion = String(version.rows[0]?.cipher_version ?? '');
    if (!cipherVersion)
      throw new CopyRefused('no-sqlcipher', 'PRAGMA cipher_version gave nothing: plain SQLite.');
    try {
      await probe.execute('SELECT count(*) AS n FROM sqlite_master');
    } catch (error) {
      throw new CopyUnreadable(error instanceof Error ? error.message : String(error));
    }
  } finally {
    probe.close();
  }
  if (isPlainSqlite(files.header(name)))
    throw new CopyRefused('plain-file', 'The copy on the phone is plain SQLite.');

  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: name, dbLocation: files.folder, sqliteOptions: { encryptionKey } },
    logger: input.logger,
  });
  try {
    await db.init();
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  if (isPlainSqlite(files.header(name))) {
    await db.close();
    throw new CopyRefused('plain-file', 'PowerSync wrote plain SQLite.');
  }
  let kept: OpenKeptFiles;
  try {
    kept = openKeptFiles({ userId: input.userId, key: input.key, files });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return { db, kept, cipherVersion, openMs: Math.round(performance.now() - started) };
}

const sqlOf = (db: DB): SyncSql => ({
  run: (sql, params = []) => void db.executeSync(sql, params as Scalar[]),
  all: <T>(sql: string, params: readonly unknown[] = []) =>
    db.executeSync(sql, params as Scalar[]).rows as T[],
});

/** Deletes the files database and SQLite's files beside it. */
function removeKeptFiles(files: CopyFiles, name: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) files.remove(`${name}${suffix}`);
}

/**
 * Opens the files a person's phone keeps (`kept-files.ts`), with their copy's key and the same checks: SQLCipher
 * answers, and the file isn't plain SQLite. A file the key doesn't open is started again (its key was replaced, so
 * nobody can read it). Photos an earlier build kept as plain files move in, and their folder goes.
 */
export function openKeptFiles(input: {
  readonly userId: string;
  readonly key: string;
  readonly files: CopyFiles;
}): OpenKeptFiles {
  const { files } = input;
  const name = keptFilesName(input.userId);
  const encryptionKey = rawKeyForm(input.key);
  const connect = (): DB => {
    const db = open({ name, location: files.folder, encryptionKey });
    try {
      const version = db.executeSync('PRAGMA cipher_version');
      if (!String(version.rows[0]?.cipher_version ?? ''))
        throw new CopyRefused('no-sqlcipher', 'PRAGMA cipher_version gave nothing: plain SQLite.');
      db.executeSync('SELECT count(*) AS n FROM sqlite_master');
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  let db: DB;
  try {
    db = connect();
  } catch (error) {
    if (error instanceof CopyRefused) throw error;
    removeKeptFiles(files, name);
    db = connect();
  }
  try {
    const kept = new KeptFiles(sqlOf(db));
    if (isPlainSqlite(files.header(name)))
      throw new CopyRefused('plain-file', 'The phone’s kept files are plain SQLite.');
    moveOldPhotos(kept, input.userId);
    return { files: kept, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

const TYPES: Record<string, string> = { jpg: 'image/jpeg', m4a: 'audio/mp4' };

/** Photos and voice notes an earlier build kept as plain files: into the kept files, then deleted. */
function moveOldPhotos(kept: KeptFiles, userId: string) {
  const folder = new Directory(photosFolderUri(userId));
  if (!folder.exists) return;
  for (const entry of folder.list()) {
    if (!(entry instanceof File)) continue;
    if (!kept.has(entry.name))
      kept.put(entry.name, 'waiting', entry.bytesSync(), {
        mimeType: TYPES[entry.name.split('.').pop() ?? ''] ?? null,
      });
    entry.delete();
  }
  folder.delete();
}
