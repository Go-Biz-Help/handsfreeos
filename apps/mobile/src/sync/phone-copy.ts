import {
  LogLevels,
  type AbstractPowerSyncDatabase,
  type PowerSyncLogger,
  type SyncOptions,
  type SyncStatus,
} from '@powersync/common';

import type { SessionState } from '@/lib/auth/session';

import { CopyConnector, type ConnectorSession } from './connector';
import { peopleWithCopies, removeCopy, type CopyFiles } from './files';
import type { CopyKeys } from './keys';
import { beforeOpening, onSignOut, wantedBusinesses } from './rules';
import {
  BUSINESS_STREAM,
  BusinessSubscriptions,
  businessParameters,
  readBusinessSubscriptions,
  type BusinessStreams,
} from './subscriptions';

/**
 * The phone's own copy of the businesses a person works in: one encrypted database per person, opened when they're
 * signed in, kept in step by PowerSync while they have signal and the app is unlocked, and deleted by the plan's rules.
 *
 * Everything that opens, closes or deletes a copy runs one step at a time, so a copy is always closed before another
 * person's opens (PowerSync shares its sync locks by file name) and nothing is deleted while it's open.
 */

/** PowerSync retries a sync that failed after this long (its own default is 5 s): a dropped connection comes back
 * quickly without hammering a service that's down. Signal coming back and returning to the app reconnect at once. */
export const RETRY_DELAY_MS = 3_000;

export type RefusalReason = 'no-sqlcipher' | 'plain-file';

/** This phone can't keep a protected copy: SQLCipher isn't in the build, or the file on disk isn't encrypted. */
export class CopyRefused extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

/** The key doesn't open the file on the phone. */
export class CopyUnreadable extends Error {}

export interface OpenedDatabase {
  readonly db: AbstractPowerSyncDatabase;
  /** SQLCipher's `PRAGMA cipher_version`. */
  readonly cipherVersion: string;
  /** From starting to open the file to PowerSync being ready: the startup check and PowerSync's six connections. */
  readonly openMs: number;
}

export type OpenDatabase = (input: {
  readonly userId: string;
  readonly key: string;
}) => Promise<OpenedDatabase>;

/** What happened when this person's copy opened. */
export interface OpenReport {
  readonly cipherVersion: string;
  readonly keyForm: 'raw';
  readonly openMs: number;
  /** A new key: there was no copy for the old one to open (a first sign-in here, or a reinstall), or it didn't open it. */
  readonly newKey: boolean;
  /** Other people whose copies were deleted and keys replaced before this one opened. */
  readonly othersDeleted: number;
  readonly openedAt: number;
}

export type PhoneCopyState =
  | { readonly status: 'closed' }
  | { readonly status: 'opening'; readonly userId: string }
  | {
      readonly status: 'open';
      readonly userId: string;
      readonly db: AbstractPowerSyncDatabase;
      readonly report: OpenReport;
    }
  | { readonly status: 'refused'; readonly userId: string; readonly reason: RefusalReason }
  | { readonly status: 'failed'; readonly userId: string; readonly message: string };

export interface PhoneCopySnapshot {
  readonly state: PhoneCopyState;
  /** PowerSync's own status while a copy is open. */
  readonly sync: SyncStatus | null;
  /** The business on screen now. */
  readonly openBusiness: string | null;
  /** The last moment the copy was known to be in step with HandsFreeOS: as it lost its connection, or its last sync. */
  readonly inStepAt: number | null;
  /** Test builds: kept away from the sync service by "Disconnect". */
  readonly heldOffline: boolean;
}

interface Watchable {
  subscribe(listener: () => void): () => void;
}

/** The queue of changes made on the phone (`src/changes`), which lives in the person's copy. */
export interface CopyChanges {
  /** The person's copy opened: their queue runs on it. */
  opened(db: AbstractPowerSyncDatabase, userId: string): void;
  /**
   * The copy is closing: how many changes haven't reached HandsFreeOS, counted from it before it closes (or the last
   * count, when it never opened), and the queue stops.
   */
  closing(db: AbstractPowerSyncDatabase | null, userId: string): Promise<number>;
  /** PowerSync's `uploadData`: sends what's in the upload queue. */
  upload(db: AbstractPowerSyncDatabase): Promise<void>;
  /** The copy connected to the sync service. */
  connected(): void;
}

export interface PhoneCopyDeps {
  readonly keys: CopyKeys;
  readonly files: CopyFiles;
  readonly openDatabase: OpenDatabase;
  /** The people this phone has kept a key for, so a key whose copy is already gone can still be replaced. */
  readonly keyRegistry: { read(): string[]; write(userIds: string[]): void };
  readonly session: Watchable & ConnectorSession & { getState(): SessionState };
  readonly network: Watchable & { online(): boolean };
  readonly lock: Watchable & { isLocked(): boolean };
  /** The app coming back to the front. */
  readonly appActive: { subscribe(listener: () => void): () => void };
  /** Changes to the keep switches or the person's list of businesses. */
  readonly choices: Watchable;
  readonly keptBusinesses: (userId: string) => string[];
  /** Changes made on the phone, kept in the copy until they reach HandsFreeOS. */
  readonly changes: CopyChanges;
  readonly syncUrl: string;
  readonly appVersion: string;
  readonly logger?: PowerSyncLogger;
  readonly now?: () => number;
}

export class PhoneCopy {
  private snapshot: PhoneCopySnapshot = {
    state: { status: 'closed' },
    sync: null,
    openBusiness: null,
    inStepAt: null,
    heldOffline: false,
  };
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  /** The person whose copy should be open. */
  private target: string | null = null;
  private subscriptions: BusinessSubscriptions | null = null;
  private stopListening: (() => void) | null = null;
  private connectAsked = false;
  private readonly now: () => number;

  constructor(private readonly deps: PhoneCopyDeps) {
    this.now = deps.now ?? Date.now;
  }

  readonly getSnapshot = (): PhoneCopySnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<PhoneCopySnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Runs one step after the others; a failure is logged and never stops the next. */
  private run(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step).catch((error: unknown) => {
      this.log('The phone’s copy hit a problem', error);
    });
    this.queue = next;
    return next;
  }

  /** Waits for every step asked for so far. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Follows the sign-in, signal, the lock, the app coming back and the keep switches from now on. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.session.subscribe(() => this.followSession());
    this.deps.network.subscribe(() => void this.run(() => this.refresh()));
    this.deps.lock.subscribe(() => void this.run(() => this.refresh()));
    this.deps.choices.subscribe(() => void this.run(() => this.refresh()));
    this.deps.appActive.subscribe(() => void this.run(() => this.reconnectNow()));
    this.followSession();
  }

  private followSession() {
    const state = this.deps.session.getState();
    if (state.status === 'starting') return;
    const userId = state.status === 'signedIn' ? state.person.userId : null;
    if (userId === this.target) return;
    const signedOut = userId === null;
    this.target = userId;
    void this.run(async () => {
      await this.close(signedOut);
      if (userId) {
        await this.open(userId);
        await this.refresh();
      }
    });
  }

  /** "Try again" after the copy didn't open. */
  retry(): Promise<void> {
    const state = this.snapshot.state;
    if (state.status !== 'failed' || this.target !== state.userId) return this.queue;
    const userId = state.userId;
    return this.run(async () => {
      await this.close(false);
      if (this.target !== userId) return;
      await this.open(userId);
      await this.refresh();
    });
  }

  /** The business on screen, so one that isn't kept still syncs while it's open. Returns the way to leave it. */
  openBusiness(businessId: string): () => void {
    this.update({ openBusiness: businessId });
    void this.run(() => this.refresh());
    return () => {
      if (this.snapshot.openBusiness !== businessId) return;
      this.update({ openBusiness: null });
      void this.run(() => this.refresh());
    };
  }

  private async open(userId: string): Promise<void> {
    const { keys, files, keyRegistry } = this.deps;
    this.update({ state: { status: 'opening', userId }, sync: null, inStepAt: null });
    const ownKey = await keys.read(userId);
    const plan = beforeOpening({
      userId,
      peopleWithCopies: peopleWithCopies(files),
      peopleWithKeys: keyRegistry.read(),
      ownKeyFound: ownKey !== null,
    });
    for (const other of plan.deleteCopiesOf) removeCopy(files, other);
    for (const other of plan.replaceKeysOf) {
      // Replaced before it's deleted, so the old key is gone even if the Keychain keeps the entry.
      await keys.replace(other);
      await keys.remove(other);
    }
    keyRegistry.write([userId]);

    let newKey = plan.newOwnKey || ownKey === null;
    let key = ownKey ?? '';
    if (newKey) {
      removeCopy(files, userId);
      key = await keys.replace(userId);
    }
    let opened: OpenedDatabase;
    try {
      try {
        opened = await this.deps.openDatabase({ userId, key });
      } catch (error) {
        if (!(error instanceof CopyUnreadable)) throw error;
        // Nobody can read a copy its key doesn't open: start it again.
        this.log('The key didn’t open this person’s copy, so it starts again', error);
        removeCopy(files, userId);
        key = await keys.replace(userId);
        newKey = true;
        opened = await this.deps.openDatabase({ userId, key });
      }
    } catch (error) {
      removeCopy(files, userId);
      if (error instanceof CopyRefused) {
        this.log('This phone can’t keep a protected copy', error);
        this.update({ state: { status: 'refused', userId, reason: error.reason } });
      } else {
        this.log('The phone’s copy didn’t open', error);
        this.update({
          state: {
            status: 'failed',
            userId,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    if (this.target !== userId) {
      // Signed out while it opened: the next step closes it.
      this.update({ state: this.openState(userId, opened, newKey, plan.deleteCopiesOf.length) });
      return;
    }
    const { db } = opened;
    this.deps.changes.opened(db, userId);
    this.subscriptions = new BusinessSubscriptions(this.streamsOf(db), this.now);
    this.stopListening = db.registerListener({
      statusChanged: (status) => this.onStatus(status),
    });
    this.update({
      state: this.openState(userId, opened, newKey, plan.deleteCopiesOf.length),
      sync: db.currentStatus,
      inStepAt: db.currentStatus.lastSyncedAt?.getTime() ?? null,
    });
  }

  private openState(
    userId: string,
    opened: OpenedDatabase,
    newKey: boolean,
    othersDeleted: number,
  ): PhoneCopyState {
    return {
      status: 'open',
      userId,
      db: opened.db,
      report: {
        cipherVersion: opened.cipherVersion,
        keyForm: 'raw',
        openMs: opened.openMs,
        newKey,
        othersDeleted,
        openedAt: this.now(),
      },
    };
  }

  private onStatus(status: SyncStatus) {
    const previous = this.snapshot.sync;
    let inStepAt = this.snapshot.inStepAt;
    const lastSynced = status.lastSyncedAt?.getTime() ?? null;
    if (lastSynced !== null && (inStepAt === null || lastSynced > inStepAt)) inStepAt = lastSynced;
    // Losing the connection while in step: it was up to date until now.
    if (previous?.connected && previous.hasSynced && !previous.downloading && !status.connected)
      inStepAt = this.now();
    this.update({ sync: status, inStepAt });
    if (status.connected && !previous?.connected) this.deps.changes.connected();
  }

  /** Closes the open copy; after signing out, deletes it and its key unless changes are waiting. */
  private async close(signedOut: boolean): Promise<void> {
    const state = this.snapshot.state;
    if (state.status === 'closed') return;
    // Counted from the copy itself before it closes: changes waiting keep it at sign-out.
    const waiting = await this.deps.changes
      .closing(state.status === 'open' ? state.db : null, state.userId)
      .catch((error: unknown) => {
        this.log('Counting the changes waiting', error);
        // Unsure: keep the copy rather than lose someone's work.
        return 1;
      });
    this.subscriptions?.releaseAll();
    this.subscriptions = null;
    this.stopListening?.();
    this.stopListening = null;
    this.connectAsked = false;
    if (state.status === 'open') {
      await state.db.disconnect().catch((error: unknown) => this.log('Disconnecting', error));
      await state.db.close().catch((error: unknown) => this.log('Closing the copy', error));
    }
    this.update({ state: { status: 'closed' }, sync: null, inStepAt: null, heldOffline: false });
    if (signedOut && onSignOut(waiting) === 'delete') {
      removeCopy(this.deps.files, state.userId);
      await this.deps.keys.remove(state.userId);
      this.deps.keyRegistry.write(this.deps.keyRegistry.read().filter((id) => id !== state.userId));
    }
  }

  /** Brings the subscriptions and the connection in line with the keep switches, the business open, signal and the lock. */
  private async refresh(): Promise<void> {
    const state = this.snapshot.state;
    if (state.status !== 'open' || !this.subscriptions) return;
    const online = this.deps.network.online();
    await this.subscriptions.apply(
      wantedBusinesses({
        kept: this.deps.keptBusinesses(state.userId),
        open: this.snapshot.openBusiness,
        online,
        held: [...this.subscriptions.holding().keys()],
      }),
    );
    const connect = online && !this.deps.lock.isLocked() && !this.snapshot.heldOffline;
    if (connect && !this.connectAsked) {
      this.connectAsked = true;
      // Not awaited: the first attempt can take as long as the network does, and signing out mustn't wait for it.
      void state.db.connect(this.connector(), this.syncOptions());
    } else if (!connect && this.connectAsked) {
      this.connectAsked = false;
      await state.db.disconnect();
    }
  }

  /** Back in the app: a sync waiting out its retry delay tries again at once. */
  private async reconnectNow(): Promise<void> {
    const state = this.snapshot.state;
    if (state.status !== 'open' || !this.connectAsked) return;
    const status = state.db.currentStatus;
    if (status.connected || status.connecting) return;
    void state.db.connect(this.connector(), this.syncOptions());
  }

  private connector(): CopyConnector {
    return new CopyConnector({
      endpoint: this.deps.syncUrl,
      session: this.deps.session,
      upload: (db) => this.deps.changes.upload(db),
    });
  }

  private syncOptions(): SyncOptions {
    return {
      retryDelayMs: RETRY_DELAY_MS,
      appMetadata: { client: 'mobile', app_version: this.deps.appVersion },
    };
  }

  private streamsOf(db: AbstractPowerSyncDatabase): BusinessStreams {
    return {
      subscribe: (businessId, ttl) =>
        db.syncStream(BUSINESS_STREAM, businessParameters(businessId)).subscribe({ ttl }),
      subscribed: () => readBusinessSubscriptions(db),
    };
  }

  // ------------------------------------------------------------------------------------------- test builds only

  /** "Disconnect" and "Connect" on This phone's copy. */
  holdOffline(held: boolean): Promise<void> {
    this.update({ heldOffline: held });
    return this.run(() => this.refresh());
  }

  /** Runs something against the open copy in turn with everything else (the test tools' database changes). */
  withOpenCopy(
    step: (db: AbstractPowerSyncDatabase, userId: string) => Promise<void>,
  ): Promise<void> {
    return this.run(async () => {
      const state = this.snapshot.state;
      if (state.status === 'open') await step(state.db, state.userId);
    });
  }

  private log(message: string, error?: unknown) {
    this.deps.logger?.log({ level: LogLevels.warn, message, error });
  }
}
