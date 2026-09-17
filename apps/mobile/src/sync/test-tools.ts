import { open } from '@op-engineering/op-sqlite';
import { PowerSyncDatabase } from '@powersync/react-native';
import * as Crypto from 'expo-crypto';

import { AppSchema } from './app-schema';
import { deviceFiles } from './device-files';
import { copyFileName } from './files';
import { phoneCopy } from './index';
import { newKey, rawKeyForm } from './keys';

/**
 * Test builds only (This phone's copy): pretend time has passed, check the file is really locked, and measure the two
 * ways of giving SQLCipher its key. Nothing here is reachable in a store build.
 */

const MICROS_PER_DAY = 24 * 60 * 60 * 1_000_000;

/**
 * As if the phone had been put away for `days`: moves the copy's last completed sync and every subscription's expiry
 * and last sync back that far, the way PowerSync's own clock would see them. Disconnects first, so the sync service
 * can't move them forward again until "Connect" or the app's next start.
 */
export async function ageCopy(days: number): Promise<void> {
  await phoneCopy.holdOffline(true);
  await phoneCopy.withOpenCopy(async (db) => {
    const shift = Math.round(days * MICROS_PER_DAY);
    await db.writeTransaction(async (tx) => {
      await tx.execute('UPDATE ps_sync_state SET last_synced_at = last_synced_at - ?', [shift]);
      await tx.execute(
        `UPDATE ps_stream_subscriptions SET expires_at = expires_at - ?, last_synced_at = last_synced_at - ?
           WHERE expires_at IS NOT NULL OR last_synced_at IS NOT NULL`,
        [shift, shift],
      );
    });
    // PowerSync reads these when it's offline; make it read them again now.
    await (db as { resolveOfflineSyncStatus?: () => Promise<void> }).resolveOfflineSyncStatus?.();
  });
}

/** Opens the person's file with no key, as anyone who copied it off the phone would. */
export async function openWithoutKey(userId: string): Promise<string> {
  const db = open({ name: copyFileName(userId), location: deviceFiles.folder });
  try {
    const result = await db.execute('SELECT count(*) AS n FROM sqlite_master');
    return `Opened without the key: ${String(result.rows[0]?.n)} tables. Not encrypted!`;
  } catch (error) {
    return `Won’t open without its key: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    db.close();
  }
}

export interface KeyFormTimes {
  /** One SQLite connection, opened and read. */
  readonly connectionMs: number;
  /** PowerSync opening the database: its six connections and schema check. */
  readonly powerSyncMs: number;
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function removeScratch(name: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) deviceFiles.remove(`${name}${suffix}`);
}

async function timeOpening(key: string, label: string): Promise<KeyFormTimes> {
  const name = `hfos-measure-${label}.db`;
  removeScratch(name);
  const database = {
    dbFilename: name,
    dbLocation: deviceFiles.folder,
    sqliteOptions: { encryptionKey: key },
  };
  try {
    // The first open writes PowerSync's tables; it isn't what a person waits for each time.
    const first = new PowerSyncDatabase({ schema: AppSchema, database });
    await first.init();
    await first.close();
    const connections: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const db = open({ name, location: deviceFiles.folder, encryptionKey: key });
      await db.execute('SELECT count(*) AS n FROM sqlite_master');
      connections.push(performance.now() - started);
      db.close();
    }
    const opens: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const db = new PowerSyncDatabase({ schema: AppSchema, database });
      await db.init();
      opens.push(performance.now() - started);
      await db.close();
    }
    return {
      connectionMs: Math.round(median(connections)),
      powerSyncMs: Math.round(median(opens)),
    };
  } finally {
    removeScratch(name);
  }
}

/** The raw key (`x'…'`, what the app uses) against the passphrase form, on scratch files with a throwaway key. */
export async function compareKeyForms(): Promise<{ raw: KeyFormTimes; passphrase: KeyFormTimes }> {
  const key = newKey(Crypto.getRandomBytes);
  const raw = await timeOpening(rawKeyForm(key), 'raw');
  const passphrase = await timeOpening(key, 'passphrase');
  return { raw, passphrase };
}
