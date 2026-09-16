import { open } from '@op-engineering/op-sqlite';
import { column, PowerSyncDatabase, Schema, Table } from '@powersync/react-native';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { Stack } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { postResults } from '@/spike/report';

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

const KEY_NAME = 'spike_db_key';
const PLAIN_HEADER = 'SQLite format 3';
const NOTE = 'Maria Lopez: AC blowing warm air';

/** A random 256-bit key, kept in the keychain (this device only, readable after first unlock). */
async function databaseKey(): Promise<{ key: string; created: boolean }> {
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) return { key: existing, created: false };
  const key = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  await SecureStore.setItemAsync(KEY_NAME, key, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  return { key, created: true };
}

/** The first bytes of a database file: a plain SQLite file starts with "SQLite format 3". */
function header(path: string): string {
  const handle = new File(path.startsWith('file://') ? path : `file://${path}`).open();
  try {
    return String.fromCharCode(...handle.readBytes(15));
  } finally {
    handle.close();
  }
}

/** Opens a database the way the app would and runs one query, so a bad key fails here. */
async function tryOpen(name: string, encryptionKey?: string): Promise<string> {
  const db = open({ name, ...(encryptionKey === undefined ? {} : { encryptionKey }) });
  try {
    const res = await db.execute('SELECT count(*) AS n FROM sqlite_master');
    return `opened, ${String(res.rows[0]?.n)} schema rows`;
  } finally {
    db.close();
  }
}

async function runSteps(): Promise<Step[]> {
  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    const started = Date.now();
    try {
      steps.push({ name, ok: true, detail: await fn(), ms: Date.now() - started });
    } catch (e) {
      steps.push({
        name,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        ms: Date.now() - started,
      });
    }
  };
  let key = '';

  await step('Key from expo-secure-store', async () => {
    const got = await databaseKey();
    key = got.key;
    return `${got.created ? 'created and stored' : 'read back'} a ${key.length / 2}-byte key`;
  });

  await step('SQLCipher is compiled in', async () => {
    const db = open({ name: 'spike-probe.sqlite', encryptionKey: key });
    try {
      const res = await db.execute('PRAGMA cipher_version');
      const version = res.rows[0]?.cipher_version;
      if (!version) throw new Error('PRAGMA cipher_version returned nothing: plain SQLite');
      return `cipher_version ${String(version)}`;
    } finally {
      db.close();
    }
  });

  let path = '';
  await step('Encrypted write and read', async () => {
    const db = open({ name: 'spike-encrypted.sqlite', encryptionKey: key });
    try {
      await db.execute(
        'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)',
      );
      const id = Crypto.randomUUID();
      await db.execute('INSERT INTO notes (id, body) VALUES (?, ?)', [id, NOTE]);
      const read = await db.execute('SELECT body FROM notes WHERE id = ?', [id]);
      const total = await db.execute('SELECT count(*) AS n FROM notes');
      path = db.getDbPath();
      if (read.rows[0]?.body !== NOTE) throw new Error(`read back ${JSON.stringify(read.rows[0])}`);
      return `wrote and read "${NOTE}" (${String(total.rows[0]?.n)} rows in the table)`;
    } finally {
      db.close();
    }
  });

  await step('The file on disk is not plain SQLite', async () => {
    const first = header(path);
    if (first === PLAIN_HEADER) throw new Error('file starts with "SQLite format 3"');
    return `first bytes ${Array.from(first, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')} (${path.split('/').slice(-2).join('/')})`;
  });

  await step('Opening without the key fails', async () => {
    try {
      const outcome = await tryOpen('spike-encrypted.sqlite');
      throw new Error(`UNEXPECTED: ${outcome}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('UNEXPECTED')) throw e;
      return `refused: ${message}`;
    }
  });

  await step('Opening with the wrong key fails', async () => {
    try {
      const outcome = await tryOpen('spike-encrypted.sqlite', 'not-the-key');
      throw new Error(`UNEXPECTED: ${outcome}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('UNEXPECTED')) throw e;
      return `refused: ${message}`;
    }
  });

  await step('Opening with the key again works', async () =>
    tryOpen('spike-encrypted.sqlite', key),
  );

  const AppSchema = new Schema({
    todos: new Table({ description: column.text, created_at: column.text }),
  });
  await step('PowerSync on the encrypted op-sqlite database', async () => {
    const ps = new PowerSyncDatabase({
      schema: AppSchema,
      database: { dbFilename: 'spike-powersync.sqlite', sqliteOptions: { encryptionKey: key } },
    });
    try {
      await ps.init();
      const core = await ps.get<{ v: string }>('SELECT powersync_rs_version() AS v');
      const seen: number[] = [];
      const controller = new AbortController();
      ps.watch(
        'SELECT count(*) AS n FROM todos',
        [],
        { onResult: (r) => seen.push(Number(r.rows?._array[0]?.n)) },
        { signal: controller.signal },
      );
      await ps.execute('INSERT INTO todos (id, description, created_at) VALUES (uuid(), ?, ?)', [
        'Call Maria back about the estimate',
        new Date().toISOString(),
      ]);
      const rows = await ps.getAll<{ id: string; description: string }>(
        'SELECT id, description FROM todos',
      );
      const batch = await ps.getCrudBatch(100);
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();
      return [
        `powersync core ${core.v}`,
        `${rows.length} local todos`,
        `${batch?.crud.length ?? 0} writes waiting to upload (no server connection)`,
        `watch saw counts ${seen.join(' → ') || 'nothing'}`,
        `connected ${String(ps.connected)}`,
      ].join('; ');
    } finally {
      await ps.close();
    }
  });

  await step('The PowerSync file is encrypted too', async () => {
    try {
      const outcome = await tryOpen('spike-powersync.sqlite');
      throw new Error(`UNEXPECTED: ${outcome}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('UNEXPECTED')) throw e;
      return `without the key: ${message}`;
    }
  });

  await step('expo-updates in the same app', async () =>
    JSON.stringify({
      isEnabled: Updates.isEnabled,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      runtimeVersion: Updates.runtimeVersion,
      channel: Updates.channel,
      updateId: Updates.updateId,
    }),
  );

  return steps;
}

export default function Database() {
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    void runSteps().then((s) => {
      setSteps(s);
      void postResults(`database-${Platform.OS}-${__DEV__ ? 'debug' : 'release'}`, { steps: s });
    });
  }, []);

  const passed = steps?.filter((s) => s.ok).length ?? 0;
  return (
    <ScrollView contentContainerStyle={styles.page} testID="database">
      <Stack.Screen options={{ title: 'Encrypted database' }} />
      <Text style={styles.summary} testID="database-summary">
        {steps ? `${passed} of ${steps.length} steps passed` : 'Running…'}
      </Text>
      {steps?.map((s) => (
        <View key={s.name} style={styles.step}>
          <Text style={[styles.status, { color: s.ok ? '#008743' : '#c43335' }]}>
            {s.ok ? 'PASS' : 'FAIL'} · {s.ms} ms
          </Text>
          <Text style={styles.name}>{s.name}</Text>
          <Text style={styles.detail}>{s.detail}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  summary: { fontSize: 20, fontWeight: '700', color: '#191d25' },
  step: {
    gap: 2,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#d2d6dd',
  },
  status: { fontSize: 12, fontWeight: '700' },
  name: { fontSize: 14, color: '#191d25' },
  detail: { fontSize: 12, color: '#5b616a', fontFamily: 'Menlo' },
});
