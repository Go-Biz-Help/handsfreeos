import { isSQLCipher, open } from '@op-engineering/op-sqlite';
import { PowerSyncDatabase, type PowerSyncLogger } from '@powersync/react-native';

import { AppSchema } from './app-schema';
import { copyFileName, isPlainSqlite, type CopyFiles } from './files';
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
  return { db, cipherVersion, openMs: Math.round(performance.now() - started) };
}
