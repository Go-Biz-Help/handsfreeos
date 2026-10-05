import { randomBytes } from 'node:crypto';

import type { AbstractPowerSyncDatabase, SyncStatus } from '@powersync/common';

import type { SessionState } from '@/lib/auth/session';

import { copyFileName, keptFilesName, type CopyFiles } from '../files';
import { documentName } from '../kept-files';
import { keptStore } from '../kept-store';
import { CopyKeys, keyName, type SecretStore } from '../keys';
import {
  CopyRefused,
  CopyUnreadable,
  PhoneCopy,
  RETRY_DELAY_MS,
  type OpenDatabase,
} from '../phone-copy';
import { KEPT_TTL_S, OPEN_TTL_S } from '../rules';
import { BUSINESS_STREAM, RECORDS_STREAM } from '../subscriptions';

import { memoryKeptFiles } from './memory-kept-files';

/**
 * The copy's rules through `PhoneCopy` itself, with a stand-in for the Keychain, the files on the phone and PowerSync
 * on op-sqlite (a file only its own key opens): what's deleted when, which key opens what, what's subscribed for how
 * long, and when it connects.
 */

const DALE = '11111111-1111-4111-8111-111111111111';
const MARCO = '22222222-2222-4222-8222-222222222222';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUMMIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENCRYPTED = new Uint8Array(16).fill(0x9c);

class Watch {
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  fire() {
    for (const listener of this.listeners) listener();
  }
}

class FakeDb {
  readonly subscribed: { businessId: string; ttl: number | undefined }[] = [];
  readonly released: string[] = [];
  connects = 0;
  disconnects = 0;
  closed = false;
  options: { retryDelayMs?: number } | null = null;
  currentStatus = { connected: false, connecting: false, syncStreams: [] } as unknown as SyncStatus;

  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}

  registerListener() {
    return () => undefined;
  }
  async getAll() {
    return [];
  }
  async connect(_connector: unknown, options: { retryDelayMs?: number }) {
    this.connects++;
    this.options = options;
    this.log.push(`connect ${this.name}`);
  }
  async disconnect() {
    this.disconnects++;
    this.log.push(`disconnect ${this.name}`);
  }
  async close() {
    this.closed = true;
    this.log.push(`close ${this.name}`);
  }
  /** Every stream subscribed, with its business and how long: a business's two go together (round six). */
  readonly streams: string[] = [];
  syncStream(name: string, params: { workspace_id: string }) {
    return {
      subscribe: async (options?: { ttl?: number }) => {
        this.streams.push(`${name} ${params.workspace_id} ${options?.ttl}`);
        // The business's own stream stands for both in the rest of these tests.
        if (name === BUSINESS_STREAM) {
          this.subscribed.push({ businessId: params.workspace_id, ttl: options?.ttl });
          this.log.push(`subscribe ${params.workspace_id} ${options?.ttl}`);
        }
        return {
          unsubscribe: () => {
            this.streams.push(`release ${name} ${params.workspace_id}`);
            if (name !== BUSINESS_STREAM) return;
            this.released.push(params.workspace_id);
            this.log.push(`release ${params.workspace_id}`);
          },
        };
      },
    };
  }
}

function phone(options: { sqlcipher?: boolean } = {}) {
  const log: string[] = [];
  const secrets = new Map<string, string>();
  const store: SecretStore = {
    get: async (name) => secrets.get(name) ?? null,
    set: async (name, value) => void secrets.set(name, value),
    delete: async (name) => void secrets.delete(name),
  };
  const onDisk = new Map<string, { key: string }>();
  const files: CopyFiles = {
    folder: '/library',
    list: () => [...onDisk.keys()],
    remove: (name) => {
      if (onDisk.delete(name)) log.push(`delete ${name}`);
    },
    header: (name) => (onDisk.has(name) ? ENCRYPTED : null),
  };
  const dbs: FakeDb[] = [];
  const openDatabase: OpenDatabase = async ({ userId, key }) => {
    const name = copyFileName(userId);
    if (options.sqlcipher === false) {
      onDisk.set(name, { key });
      throw new CopyRefused('no-sqlcipher', 'PRAGMA cipher_version gave nothing');
    }
    const file = onDisk.get(name);
    if (file && file.key !== key) throw new CopyUnreadable('file is not a database');
    onDisk.set(name, { key });
    onDisk.set(`${name}-wal`, { key });
    onDisk.set(keptFilesName(userId), { key });
    log.push(`open ${name}`);
    const db = new FakeDb(name, log);
    dbs.push(db);
    const { kept } = memoryKeptFiles();
    return {
      db: db as unknown as AbstractPowerSyncDatabase,
      kept: { files: kept, close: () => void log.push(`close ${keptFilesName(userId)}`) },
      cipherVersion: '4.14.0 community',
      openMs: 40,
    };
  };

  let state: SessionState = { status: 'signedOut', ended: false };
  const sessionWatch = new Watch();
  let online = true;
  const networkWatch = new Watch();
  let locked = false;
  const lockWatch = new Watch();
  const appActive = new Watch();
  const choices = new Watch();
  const kept = new Map<string, string[]>();
  let waiting = 0;
  let registry: string[] = [];
  const queue = {
    opened: [] as string[],
    closed: [] as { userId: string; hadCopy: boolean }[],
    connected: 0,
  };

  const copy = new PhoneCopy({
    keys: new CopyKeys(store, (n) => new Uint8Array(randomBytes(n))),
    files,
    openDatabase,
    keyRegistry: { read: () => registry, write: (ids) => void (registry = ids) },
    session: {
      getState: () => state,
      subscribe: sessionWatch.subscribe,
      accessToken: async () => 'token',
      refreshNow: async () => undefined,
    },
    network: { online: () => online, subscribe: networkWatch.subscribe },
    lock: { isLocked: () => locked, subscribe: lockWatch.subscribe },
    appActive: { subscribe: appActive.subscribe },
    choices,
    keptBusinesses: (userId) => kept.get(userId) ?? [],
    changes: {
      opened: (_db, userId) => void queue.opened.push(userId),
      // The queue counts from the open copy; a copy that never opened gives the last count.
      closing: async (db, userId) => {
        queue.closed.push({ userId, hadCopy: db !== null });
        return waiting;
      },
      upload: async () => undefined,
      connected: () => void (queue.connected += 1),
    },
    kept: keptStore,
    syncUrl: 'http://sync.test',
    appVersion: '1.0.0',
  });

  const settle = async () => {
    for (;;) {
      const queue = copy.settled();
      await queue;
      if (queue === copy.settled()) return;
    }
  };

  return {
    copy,
    log,
    secrets,
    onDisk,
    dbs,
    settle,
    registry: () => registry,
    signIn: async (userId: string) => {
      state = {
        status: 'signedIn',
        person: { userId, email: `${userId}@test`, name: null },
        expiresAt: 0,
      };
      sessionWatch.fire();
      await settle();
    },
    signOut: async () => {
      state = { status: 'signedOut', ended: false };
      sessionWatch.fire();
      await settle();
    },
    setOnline: async (value: boolean) => {
      online = value;
      networkWatch.fire();
      await settle();
    },
    setLocked: async (value: boolean) => {
      locked = value;
      lockWatch.fire();
      await settle();
    },
    keep: async (userId: string, ids: string[]) => {
      kept.set(userId, ids);
      choices.fire();
      await settle();
    },
    setWaiting: (n: number) => void (waiting = n),
    queue,
    returnToApp: async () => {
      appActive.fire();
      await settle();
    },
  };
}

const file = copyFileName;

describe('opening a person’s copy', () => {
  it('makes a new key and opens a new copy for the first person to sign in', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const state = p.copy.getSnapshot().state;
    expect(state).toMatchObject({
      status: 'open',
      userId: DALE,
      report: { keyForm: 'raw', newKey: true, othersDeleted: 0, cipherVersion: '4.14.0 community' },
    });
    expect(p.secrets.get(keyName(DALE))).toMatch(/^[0-9a-f]{64}$/);
    expect([...p.onDisk.keys()]).toEqual([file(DALE), `${file(DALE)}-wal`, keptFilesName(DALE)]);
    expect(p.registry()).toEqual([DALE]);
  });

  it('refuses without SQLCipher, deleting what it wrote, and never opens', async () => {
    const p = phone({ sqlcipher: false });
    p.copy.start();
    await p.signIn(DALE);
    expect(p.copy.getSnapshot().state).toEqual({
      status: 'refused',
      userId: DALE,
      reason: 'no-sqlcipher',
    });
    expect(p.onDisk.size).toBe(0);
    expect(p.dbs).toHaveLength(0);
  });

  it('starts a copy again, with a new key, when its key doesn’t open it', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    p.setWaiting(1);
    await p.signOut();
    // The Keychain entry changed under it (restored from somewhere else).
    p.secrets.set(keyName(DALE), 'f'.repeat(64));
    await p.signIn(DALE);
    expect(p.copy.getSnapshot().state).toMatchObject({ status: 'open', report: { newKey: true } });
    expect(p.onDisk.get(file(DALE))!.key).toBe(p.secrets.get(keyName(DALE)));
    expect(p.secrets.get(keyName(DALE))).not.toBe('f'.repeat(64));
  });
});

describe('wiping', () => {
  it('deletes the copy and its key when someone signs out with nothing waiting', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    await p.signOut();
    expect(p.dbs[0]!.closed).toBe(true);
    expect(p.onDisk.size).toBe(0);
    expect(p.secrets.has(keyName(DALE))).toBe(false);
    expect(p.registry()).toEqual([]);
    expect(p.log.indexOf(`close ${file(DALE)}`)).toBeLessThan(
      p.log.indexOf(`delete ${file(DALE)}`),
    );
  });

  it('opens the files the phone keeps with the copy, and at sign-out lets documents go but keeps photos waiting', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const kept = keptStore.of(DALE);
    kept.put('f1.jpg', 'waiting', new Uint8Array(10));
    kept.put(documentName('d1'), 'document', new Uint8Array(10));
    p.setWaiting(1);
    await p.signOut();
    expect(keptStore.current()).toBeNull();
    expect(kept.list().map((f) => f.name)).toEqual(['f1.jpg']);
    // Closed before the copy, and kept on the phone with it.
    expect(p.log.indexOf(`close ${keptFilesName(DALE)}`)).toBeLessThan(
      p.log.indexOf(`close ${file(DALE)}`),
    );
    expect(p.onDisk.has(keptFilesName(DALE))).toBe(true);
  });

  it('keeps the copy and its key, encrypted, when changes are waiting, and opens them again for that person', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const key = p.secrets.get(keyName(DALE));
    p.setWaiting(3);
    await p.signOut();
    expect(p.onDisk.has(file(DALE))).toBe(true);
    expect(p.secrets.get(keyName(DALE))).toBe(key);
    // The queue ran on Dale's copy, and counted what's waiting from it before it closed.
    expect(p.queue.opened).toEqual([DALE]);
    expect(p.queue.closed).toEqual([{ userId: DALE, hadCopy: true }]);
    expect(p.log.indexOf(`close ${file(DALE)}`)).toBeGreaterThan(-1);
    await p.signIn(DALE);
    expect(p.copy.getSnapshot().state).toMatchObject({
      status: 'open',
      report: { newKey: false, othersDeleted: 0 },
    });
    expect(p.secrets.get(keyName(DALE))).toBe(key);
    // Signing in again opens the same queue, which sends what waited.
    expect(p.queue.opened).toEqual([DALE, DALE]);
  });

  it('deletes everyone else’s copy and replaces their key before another person’s copy opens', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const daleKey = p.secrets.get(keyName(DALE));
    p.setWaiting(3);
    await p.signOut();
    p.setWaiting(0);
    await p.signIn(MARCO);
    expect(p.copy.getSnapshot().state).toMatchObject({
      status: 'open',
      userId: MARCO,
      report: { newKey: true, othersDeleted: 1 },
    });
    // Dale's kept files went with his copy.
    expect([...p.onDisk.keys()].sort()).toEqual([
      file(MARCO),
      `${file(MARCO)}-wal`,
      keptFilesName(MARCO),
    ]);
    expect(p.secrets.has(keyName(DALE))).toBe(false);
    expect(p.secrets.get(keyName(MARCO))).not.toBe(daleKey);
    expect(p.registry()).toEqual([MARCO]);
    // Dale's copy was closed before anything of his was deleted, and before Marco's opened.
    const order = (entry: string) => p.log.indexOf(entry);
    expect(order(`close ${file(DALE)}`)).toBeLessThan(order(`delete ${file(DALE)}`));
    expect(order(`delete ${file(DALE)}`)).toBeLessThan(order(`open ${file(MARCO)}`));
  });

  it('replaces a key this phone kept for someone whose copy is already gone', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    p.setWaiting(3);
    await p.signOut();
    p.onDisk.clear();
    await p.signIn(MARCO);
    expect(p.secrets.has(keyName(DALE))).toBe(false);
  });

  it('finds no copy after a reinstall, and replaces the key the Keychain kept', async () => {
    const p = phone();
    const stale = 'a'.repeat(64);
    p.secrets.set(keyName(DALE), stale);
    p.copy.start();
    await p.signIn(DALE);
    expect(p.copy.getSnapshot().state).toMatchObject({ status: 'open', report: { newKey: true } });
    expect(p.secrets.get(keyName(DALE))).not.toBe(stale);
    expect(p.onDisk.get(file(DALE))!.key).toBe(p.secrets.get(keyName(DALE)));
  });
});

describe('what’s subscribed', () => {
  it('subscribes kept businesses for 30 days before it connects, and the open one for 10 minutes while there’s signal', async () => {
    const p = phone();
    p.copy.start();
    await p.keep(DALE, [LONE_STAR]);
    await p.signIn(DALE);
    const db = p.dbs[0]!;
    expect(db.subscribed).toEqual([{ businessId: LONE_STAR, ttl: KEPT_TTL_S }]);
    // Its records come with it, for as long (records_v1, beside business_v1).
    expect(db.streams).toEqual([
      `${BUSINESS_STREAM} ${LONE_STAR} ${KEPT_TTL_S}`,
      `${RECORDS_STREAM} ${LONE_STAR} ${KEPT_TTL_S}`,
    ]);
    expect(p.log.indexOf(`subscribe ${LONE_STAR} ${KEPT_TTL_S}`)).toBeLessThan(
      p.log.indexOf(`connect ${file(DALE)}`),
    );
    const leave = p.copy.openBusiness(SUMMIT);
    await p.settle();
    expect(db.subscribed.at(-1)).toEqual({ businessId: SUMMIT, ttl: OPEN_TTL_S });
    leave();
    await p.settle();
    expect(db.released).toEqual([SUMMIT]);
  });

  it('doesn’t subscribe an open business that isn’t kept with no signal', async () => {
    const p = phone();
    p.copy.start();
    await p.setOnline(false);
    await p.signIn(DALE);
    p.copy.openBusiness(SUMMIT);
    await p.settle();
    expect(p.dbs[0]!.subscribed).toEqual([]);
  });

  it('shortens a business to 10 minutes before letting it go when it stops being kept, and renews it when kept again', async () => {
    const p = phone();
    p.copy.start();
    await p.keep(DALE, [LONE_STAR, SUMMIT]);
    await p.signIn(DALE);
    const db = p.dbs[0]!;
    await p.keep(DALE, [LONE_STAR]);
    expect(db.subscribed.slice(-1)).toEqual([{ businessId: SUMMIT, ttl: OPEN_TTL_S }]);
    expect(db.released.filter((id) => id === SUMMIT)).toHaveLength(2);
    await p.keep(DALE, [LONE_STAR, SUMMIT]);
    expect(db.subscribed.at(-1)).toEqual({ businessId: SUMMIT, ttl: KEPT_TTL_S });
  });

  it('keeps an open business on the short time while it’s open, and the long one once it’s kept', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const db = p.dbs[0]!;
    p.copy.openBusiness(SUMMIT);
    await p.settle();
    await p.keep(DALE, [SUMMIT]);
    expect(db.subscribed).toEqual([
      { businessId: SUMMIT, ttl: OPEN_TTL_S },
      { businessId: SUMMIT, ttl: KEPT_TTL_S },
    ]);
    expect(db.released).toEqual([SUMMIT]);
  });
});

describe('connecting', () => {
  it('connects when signed in, unlocked and online, retrying after a few seconds', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const db = p.dbs[0]!;
    expect(db.connects).toBe(1);
    expect(db.options).toMatchObject({ retryDelayMs: RETRY_DELAY_MS });
    expect(RETRY_DELAY_MS).toBeLessThan(5000);
    // Nothing changes: no second connection.
    await p.setOnline(true);
    expect(db.connects).toBe(1);
  });

  it('disconnects with no signal (or the test switch), while locked, and for Disconnect; connects again after', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const db = p.dbs[0]!;
    await p.setOnline(false);
    expect(db.disconnects).toBe(1);
    await p.setOnline(true);
    expect(db.connects).toBe(2);
    await p.setLocked(true);
    expect(db.disconnects).toBe(2);
    await p.setLocked(false);
    expect(db.connects).toBe(3);
    await p.copy.holdOffline(true);
    expect(db.disconnects).toBe(3);
    await p.copy.holdOffline(false);
    expect(db.connects).toBe(4);
  });

  it('waits for the lock before it connects a copy opened at start', async () => {
    const p = phone();
    await p.setLocked(true);
    p.copy.start();
    await p.signIn(DALE);
    expect(p.dbs[0]!.connects).toBe(0);
    await p.setLocked(false);
    expect(p.dbs[0]!.connects).toBe(1);
  });

  it('reconnects at once on returning to the app when it isn’t connected', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    const db = p.dbs[0]!;
    await p.returnToApp();
    expect(db.connects).toBe(2);
    db.currentStatus = {
      connected: true,
      connecting: false,
      syncStreams: [],
    } as unknown as SyncStatus;
    await p.returnToApp();
    expect(db.connects).toBe(2);
  });

  it('disconnects and closes on sign-out', async () => {
    const p = phone();
    p.copy.start();
    await p.signIn(DALE);
    await p.signOut();
    expect(p.dbs[0]!.disconnects).toBe(1);
    expect(p.copy.getSnapshot().state).toEqual({ status: 'closed' });
  });
});
