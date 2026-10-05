import {
  isCommandName,
  isOnline,
  type CommandName,
  type InputOf,
  type OnlineCommand,
  type OutputOf,
} from './commands';
import { refusedRow, runRefusalHook } from './fixers';
import { Outbox, type OutboxDb, type OutboxRow, type SqlRunner } from './outbox';
import { PhotoTrack, type PhotoTransport } from './photos';
import { RetryLater } from './retry-later';
import { outcomeOf, parseIds, type Answer } from './rules';
import type { CommandRequest } from './send';
import { Uploader, type BusinessClock, type Settled } from './uploader';
import { TOO_OLD_WORDS, VersionGate, type GateStore } from './version-gate';

/**
 * The queue of changes on this phone, for the person whose copy is open: the one way screens make a change
 * (`change`), the uploader PowerSync calls, the photo track, the changes set aside to retry, and the person's answers
 * ("Still send?", quiet hours, fixing and discarding).
 */

export const NEEDS_SIGNAL = 'This needs signal.';

export class ChangeError extends Error {
  constructor(
    /**
     * - `needs-signal`: an online-only command with no signal, or no answer;
     * - `too-old`: this build is too old for the API;
     * - `refused` / `ask`: the API said no, or asks something first (with its body);
     * - `waiting`: it depends on changes that haven't reached HandsFreeOS;
     * - `no-copy`: the person's copy isn't open, so nothing can be kept on the phone;
     * - `failed`: anything else.
     */
    readonly kind:
      'needs-signal' | 'too-old' | 'refused' | 'ask' | 'waiting' | 'no-copy' | 'failed',
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** A local transaction, for a change's optimistic rows. */
export type ChangeTransaction = SqlRunner;

export interface ChangeOptions {
  /**
   * Writes what the person should see at once (the note, the moved lead), in the same local transaction as the change.
   * The rows stay until the change has been handled; then the server's own rows, or none, take their place.
   */
  readonly optimistic?: (tx: ChangeTransaction) => Promise<unknown>;
  /** Changes and photos this one waits for: a lead for a customer made a minute ago, a note about a photo. */
  readonly dependsOn?: readonly string[];
  /**
   * The command id to send it under, instead of a new one: a notification's button carries its own, the same on every
   * phone the push reached. A change already on this phone under that id isn't made again, and the API answers a
   * repeat with the first answer, so pressing a button twice, or on two phones, does it once.
   */
  readonly commandId?: string;
  /** When the person did it, when that wasn't just now (a notification's button pressed before the phone was unlocked). */
  readonly madeAt?: number;
}

export type ChangeResult<N extends CommandName> = [N] extends [OnlineCommand]
  ? { readonly id: string; readonly queued: false; readonly output: OutputOf<N> }
  : { readonly id: string; readonly queued: true };

/** The database a copy opens with: PowerSync's, which also tells when tables change. */
export interface ChangesDb extends OutboxDb {
  onChange?(
    handler: { onChange: () => void | Promise<void> },
    options: { tables: string[]; throttleMs?: number },
  ): () => void;
}

export interface NewPhoto {
  readonly workspaceId: string;
  /** A customer, a company, a lead, or an add-on's record (a Real Estate deal's photos and voice notes). */
  readonly recordType: 'person' | 'company' | 'lead' | 'custom_record';
  readonly recordId: string;
}

export interface KeptPhotoFile {
  readonly localName: string;
  readonly sizeBytes: number;
}

export interface ChangesSnapshot {
  readonly userId: string | null;
  /** Changes not through yet: the strip, Sign out? and the rule that keeps a copy at sign-out. */
  readonly waiting: number;
  /** Changes asked about or refused. */
  readonly needsYou: number;
  /** The API refused this build: nothing is sent until it's updated. */
  readonly tooOld: boolean;
  /** When signal last came back while the app was open. */
  readonly backOnlineAt: number | null;
}

export interface ChangesDeps {
  readonly send: (request: CommandRequest) => Promise<Answer>;
  readonly session: {
    accessToken(): Promise<string | null>;
    refreshNow(): Promise<void>;
  };
  readonly network: { online(): boolean; subscribe(listener: () => void): () => void };
  readonly lock: { isLocked(): boolean; subscribe(listener: () => void): () => void };
  readonly appActive: { subscribe(listener: () => void): () => void };
  /** The phone's small store: the too-old mark and each person's last count. */
  readonly store: GateStore;
  readonly appVersion: () => string;
  readonly newId: () => string;
  readonly now?: () => number;
  readonly storage: { readonly url: string; readonly key: string };
  readonly photoTransport: (userId: () => string | null) => PhotoTransport;
  /** Removes a photo's file once it's discarded. */
  readonly removePhotoFile: (userId: string, localName: string) => void;
  /** The moment quiet hours are judged at in a time zone: now, or a test build's pretended local time. */
  readonly quietHoursMoment?: (timeZone: string) => Date;
  /** Test builds: a pause between pieces of a resumable upload. */
  readonly pauseBetweenPieces?: () => number;
  readonly retryInPlaceMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly log?: (message: string, error?: unknown) => void;
  /**
   * Why no change can be made for this input now, or null: the person is viewing the app as a teammate in its
   * business (20261018000100), where nothing is changed. Asked before anything is kept or sent.
   */
  readonly refuse?: (input: unknown) => string | null;
}

interface Attached {
  readonly db: ChangesDb;
  readonly userId: string;
  readonly outbox: Outbox;
  readonly uploader: Uploader;
  readonly photos: PhotoTrack;
  readonly retry: RetryLater;
  readonly stop: () => void;
}

const lastCountKey = (userId: string) => `changes.waiting.${userId}`;

export class Changes {
  readonly gate: VersionGate;
  private attached: Attached | null = null;
  private snapshot: ChangesSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly progressListeners = new Set<() => void>();
  private progressById = new Map<string, { sent: number; total: number }>();
  private started = false;
  private wasOnline: boolean;
  private readonly now: () => number;

  constructor(private readonly deps: ChangesDeps) {
    this.now = deps.now ?? Date.now;
    this.gate = new VersionGate(deps.store, deps.appVersion, this.now);
    this.wasOnline = deps.network.online();
    this.snapshot = {
      userId: null,
      waiting: 0,
      needsYou: 0,
      tooOld: this.gate.tooOld(),
      backOnlineAt: null,
    };
  }

  // ------------------------------------------------------------------------------------------ for the screens

  readonly getSnapshot = (): ChangesSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ChangesSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (
      next.userId === this.snapshot.userId &&
      next.waiting === this.snapshot.waiting &&
      next.needsYou === this.snapshot.needsYou &&
      next.tooOld === this.snapshot.tooOld &&
      next.backOnlineAt === this.snapshot.backOnlineAt
    )
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Live upload progress for a photo, while this app is uploading it. */
  progressOf(id: string): { sent: number; total: number } | null {
    return this.progressById.get(id) ?? null;
  }

  readonly subscribeProgress = (listener: () => void): (() => void) => {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  };

  /** The last count known for a person, while their copy isn't open. */
  lastKnown(userId: string): number {
    const n = this.deps.store.get<number>(lastCountKey(userId));
    return typeof n === 'number' && n > 0 ? n : 0;
  }

  /** The open copy's database and outbox, for screens and test tools. */
  get open(): { readonly db: ChangesDb; readonly userId: string; readonly outbox: Outbox } | null {
    return this.attached;
  }

  // --------------------------------------------------------------------------------- the copy and the phone

  /** Follows signal, the lock and the app coming back from now on. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.network.subscribe(() => {
      const online = this.deps.network.online();
      if (online && !this.wasOnline) {
        this.update({ backOnlineAt: this.now() });
        this.attached?.uploader.resetWindows();
        void this.retryNow();
      }
      this.wasOnline = online;
    });
    this.deps.lock.subscribe(() => {
      if (!this.deps.lock.isLocked()) this.attached?.photos.kick();
    });
    this.deps.appActive.subscribe(() => {
      // The API may take this build again (its minimum was lowered): the next refusal marks it again.
      if (this.gate.tooOld()) this.gate.clear();
      void this.retryNow();
    });
    this.deps.store.subscribe(() => this.update({ tooOld: this.gate.tooOld() }));
  }

  /** A person's copy opened: their queue runs on it. */
  opened(db: ChangesDb, userId: string): void {
    this.detach();
    const outbox = new Outbox(db, this.now);
    const timers = { setTimer: this.deps.setTimer, clearTimer: this.deps.clearTimer };
    const settled = (event: Settled) => this.settled(event);
    const retry = new RetryLater({
      outbox,
      gate: this.gate,
      online: () => this.deps.network.online(),
      requeued: () => this.attached?.photos.kick(),
      ...timers,
    });
    const uploader = new Uploader({
      outbox,
      send: this.deps.send,
      refreshSession: () => this.deps.session.refreshNow(),
      now: this.now,
      businessClock: businessClockOf,
      quietHoursMoment: this.deps.quietHoursMoment ?? (() => new Date(this.now())),
      gate: this.gate,
      newId: this.deps.newId,
      retryInPlaceMs: this.deps.retryInPlaceMs,
      settled,
      refused: (row) => runRefusalHook(refusedRow(row)),
    });
    const photos = new PhotoTrack({
      outbox,
      send: this.deps.send,
      refreshSession: () => this.deps.session.refreshNow(),
      token: () => this.deps.session.accessToken(),
      storage: this.deps.storage,
      transport: this.deps.photoTransport(() => this.attached?.userId ?? null),
      gate: this.gate,
      now: this.now,
      newId: this.deps.newId,
      canRun: () =>
        this.attached?.db === db && this.deps.network.online() && !this.deps.lock.isLocked(),
      settled,
      progress: (id, sent, total) => {
        this.progressById.set(id, { sent, total });
        for (const listener of this.progressListeners) listener();
      },
      pauseBetweenPieces: this.deps.pauseBetweenPieces,
      ...timers,
    });
    const unwatch =
      db.onChange?.(
        { onChange: () => void this.refresh() },
        { tables: ['outbox'], throttleMs: 50 },
      ) ?? (() => undefined);
    this.attached = {
      db,
      userId,
      outbox,
      uploader,
      photos,
      retry,
      stop: () => {
        unwatch();
        retry.stop();
        photos.stop();
      },
    };
    this.update({ userId, waiting: this.lastKnown(userId), tooOld: this.gate.tooOld() });
    void outbox
      .prune()
      .catch((error: unknown) => this.log('Clearing sent changes', error))
      .then(() => this.refresh());
    photos.kick();
  }

  /**
   * The copy is closing: how many changes haven't gone through (the copy is kept at sign-out if any), and the queue
   * stops. With no copy open, the last count known for the person.
   */
  async closing(db: ChangesDb | null, userId: string): Promise<number> {
    const attached = this.attached;
    let waiting = this.lastKnown(userId);
    if (attached && db && attached.db === db) {
      try {
        waiting = await attached.outbox.unsentCount();
        this.remember(userId, waiting);
      } catch (error) {
        this.log('Counting the changes waiting', error);
      }
    }
    this.detach();
    return waiting;
  }

  private detach() {
    this.attached?.stop();
    this.attached = null;
    this.progressById = new Map();
    this.update({ userId: null, waiting: 0, needsYou: 0 });
  }

  /** PowerSync's `uploadData`. */
  readonly upload = async (db: OutboxDb): Promise<void> => {
    const attached = this.attached;
    if (!attached || attached.db !== db)
      throw new Error('The queue of changes isn’t open on this copy.');
    await attached.uploader.upload(db);
  };

  /** The copy connected to the sync service: every change gets a fresh minute, and set-aside ones go again. */
  connected(): void {
    this.attached?.uploader.resetWindows();
    void this.retryNow();
  }

  /** Sends set-aside changes again now, and wakes the photo track. */
  async retryNow(): Promise<void> {
    const attached = this.attached;
    if (!attached) return;
    await attached.retry
      .now()
      .catch((error: unknown) => this.log('Sending set-aside changes', error));
    attached.photos.kick();
  }

  private settled(event: Settled) {
    const attached = this.attached;
    if (!attached) return;
    if (event.kind === 'sent') {
      attached.retry.sent();
      if (event.released.length > 0) attached.photos.kick();
    } else if (event.kind === 'aside') attached.retry.aside();
    void this.refresh();
  }

  private remember(userId: string, waiting: number) {
    if (waiting > 0) this.deps.store.set(lastCountKey(userId), waiting);
    else this.deps.store.remove(lastCountKey(userId));
  }

  /** Counts again from the outbox. */
  async refresh(): Promise<void> {
    const attached = this.attached;
    if (!attached) return;
    try {
      const row = await attached.db.getOptional<{ waiting: number; needs: number }>(
        `SELECT count(*) AS waiting, coalesce(sum(CASE WHEN state IN ('ask', 'refused') THEN 1 ELSE 0 END), 0) AS needs
         FROM outbox WHERE state != 'sent'`,
      );
      if (this.attached !== attached) return;
      const waiting = row?.waiting ?? 0;
      this.remember(attached.userId, waiting);
      this.update({ waiting, needsYou: row?.needs ?? 0, tooOld: this.gate.tooOld() });
    } catch (error) {
      this.log('Counting the changes waiting', error);
    }
  }

  // ------------------------------------------------------------------------------------------- making changes

  /**
   * Makes a change. A change that can wait (`anytime`, or fresh) is kept on the phone in one local transaction (its
   * optimistic rows, its place in the upload queue and its outbox row) and goes when it can; `queued: true`, with its
   * id for `dependsOn`. An online-only command is never queued: with signal it goes straight to the API, made now, and
   * gives the API's answer; with none it throws "This needs signal." New records carry the phone's own id (`newId`),
   * edits only the details that changed with the `base` values the person saw (`editedOnly`), and tags go one at a time
   * (`record.add_tag`, `record.remove_tag`).
   */
  async change<N extends CommandName>(
    name: N,
    input: InputOf<N>,
    options: ChangeOptions = {},
  ): Promise<ChangeResult<N>> {
    if (!isCommandName(name))
      throw new ChangeError('failed', `${String(name)} isn’t a change this phone can make.`);
    const refused = this.deps.refuse?.(input);
    if (refused) throw new ChangeError('refused', refused);
    const body = JSON.stringify(input);
    if (isOnline(name)) return (await this.sendNow(name, body, options)) as ChangeResult<N>;
    const attached = this.attached;
    if (!attached)
      throw new ChangeError('no-copy', 'This phone’s copy of your business isn’t open yet.');
    const workspaceId = (input as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId !== 'string')
      throw new ChangeError('failed', 'This change doesn’t say which business it’s for.');
    const madeAt = new Date(Math.min(options.madeAt ?? this.now(), this.now())).toISOString();
    const made = await attached.db.writeTransaction(async (tx) => {
      if (options.commandId) {
        // Already on this phone under that command id: a button pressed again does nothing more.
        const existing = await attached.outbox.byCommandId(options.commandId, tx);
        if (existing) return existing.id;
      }
      const id = this.deps.newId();
      await options.optimistic?.(tx);
      await attached.outbox.add(tx, {
        id,
        name,
        workspaceId,
        input: body,
        madeAt,
        dependsOn: options.dependsOn ?? [],
        track: 'queue',
        commandId: options.commandId,
      });
      return id;
    });
    void this.refresh();
    return { id: made, queued: true } as ChangeResult<N>;
  }

  /**
   * Sends a queued change straight away instead of waiting for the sync service's upload queue: a notification's
   * button, pressed while the app is locked or closed. The queue's own rules still apply, and one that can't go now
   * stays in the queue. Resolves with the change as it stands afterwards (null once it's gone from the phone).
   */
  async sendQueuedNow(id: string): Promise<OutboxRow | null> {
    const attached = this.attached;
    if (!attached) return null;
    if (this.deps.network.online()) {
      await attached.uploader
        .sendNow(id)
        .catch((error: unknown) => this.log('Sending a change straight away', error));
    }
    return this.attached === attached ? attached.outbox.get(id) : null;
  }

  private async sendNow(name: CommandName, body: string, options: ChangeOptions) {
    if (!this.deps.network.online()) throw new ChangeError('needs-signal', NEEDS_SIGNAL);
    if (this.gate.tooOld()) throw new ChangeError('too-old', TOO_OLD_WORDS);
    const dependsOn = options.dependsOn ?? [];
    if (dependsOn.length > 0) {
      const found = (await this.attached?.outbox.states(dependsOn)) ?? [];
      if (dependsOn.some((id) => found.find((row) => row.id === id)?.state !== 'sent'))
        throw new ChangeError(
          'waiting',
          'This waits for changes that haven’t reached HandsFreeOS yet. Try again once they have.',
        );
    }
    const request: CommandRequest = {
      name,
      commandId: options.commandId ?? this.deps.newId(),
      input: body,
      madeAt: new Date(Math.min(options.madeAt ?? this.now(), this.now())).toISOString(),
      confirmedAt: null,
    };
    let answer = await this.deps.send(request);
    let outcome = outcomeOf(answer);
    if (outcome.kind === 'unauthorized') {
      await this.deps.session.refreshNow().catch(() => undefined);
      answer = await this.deps.send(request);
      outcome = outcomeOf(answer);
    }
    switch (outcome.kind) {
      case 'sent':
        return { id: request.commandId, queued: false, output: outcome.output };
      case 'too_old':
        this.gate.markTooOld(outcome.minVersion);
        throw new ChangeError('too-old', TOO_OLD_WORDS);
      case 'refused':
        await runRefusalHook({
          id: request.commandId,
          name,
          workspaceId: workspaceOf(body),
          input: body,
          answer: outcome.body,
          row: null,
        }).catch((error: unknown) => this.log('A refusal hook failed', error));
        throw new ChangeError('refused', outcome.message, outcome.body);
      case 'ask':
        throw new ChangeError('ask', outcome.message, outcome.body);
      case 'unauthorized':
        throw new ChangeError('failed', 'Your sign-in needs checking. Try again in a moment.');
      case 'retry':
        throw answer.reached
          ? new ChangeError('failed', outcome.message, outcome.body)
          : new ChangeError('needs-signal', NEEDS_SIGNAL);
    }
  }

  /**
   * Adds a photo already kept in the person's photos folder: its outbox row on the photo track and its upload row, in
   * one local transaction. Returns the change's id, for a note that waits for it.
   */
  async addPhoto(
    photo: NewPhoto,
    file: KeptPhotoFile,
    options: {
      readonly fileId: string;
      readonly dependsOn?: readonly string[];
      readonly name?: string;
      /** What the kept file is: a photo is a JPEG; a voice note recorded on the phone is AAC in an MP4 box. */
      readonly mimeType?: 'image/jpeg' | 'audio/mp4';
    },
  ): Promise<{ readonly id: string }> {
    const refused = this.deps.refuse?.(photo);
    if (refused) throw new ChangeError('refused', refused);
    const attached = this.attached;
    if (!attached)
      throw new ChangeError('no-copy', 'This phone’s copy of your business isn’t open yet.');
    const id = this.deps.newId();
    const takenAt = new Date(this.now()).toISOString();
    const name = options.name ?? photoName(new Date(this.now()));
    const mimeType = options.mimeType ?? 'image/jpeg';
    const input = JSON.stringify({
      workspaceId: photo.workspaceId,
      id: options.fileId,
      recordType: photo.recordType,
      recordId: photo.recordId,
      name,
      mimeType,
      sizeBytes: file.sizeBytes,
    });
    await attached.db.writeTransaction(async (tx) => {
      await attached.outbox.add(tx, {
        id,
        name: 'file.begin_upload',
        workspaceId: photo.workspaceId,
        input,
        madeAt: takenAt,
        dependsOn: options.dependsOn ?? [],
        track: 'photo',
      });
      await tx.execute(
        `INSERT INTO photo_uploads (id, workspace_id, file_id, record_type, record_id, file_name, mime_type, size_bytes,
           local_name, taken_at, step, begin_command_id, confirm_command_id, bytes_sent, tries, upload_rounds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'begin', ?, ?, 0, 0, 0)`,
        [
          id,
          photo.workspaceId,
          options.fileId,
          photo.recordType,
          photo.recordId,
          name,
          mimeType,
          file.sizeBytes,
          file.localName,
          takenAt,
          this.deps.newId(),
          this.deps.newId(),
        ],
      );
    });
    void this.refresh();
    attached.photos.kick();
    return { id };
  }

  // -------------------------------------------------------------------------------------- the person's answers

  private async row(id: string): Promise<OutboxRow> {
    const row = await this.attached?.outbox.get(id);
    if (!row) throw new ChangeError('failed', 'That change isn’t on this phone any more.');
    return row;
  }

  private async requeue(id: string, options: { input?: string; confirm?: boolean }) {
    const attached = this.attached;
    if (!attached)
      throw new ChangeError('no-copy', 'This phone’s copy of your business isn’t open.');
    await attached.outbox.requeue([id], {
      input: options.input,
      confirmedAt: options.confirm ? new Date(this.now()).toISOString() : undefined,
    });
    void this.refresh();
    attached.photos.kick();
  }

  /** "Still send?" Send now: it goes again under its own id, at the back of the queue, with when you said yes. */
  async stillSend(id: string): Promise<void> {
    await this.row(id);
    await this.requeue(id, { confirm: true });
  }

  /** The quiet-hours question: "Send at 8:00 AM" (when quiet hours end) or "Send now". Either says send it. */
  async answerQuietHours(id: string, choice: 'when-quiet-hours-end' | 'now'): Promise<void> {
    const row = await this.row(id);
    const input = JSON.parse(row.input) as Record<string, unknown>;
    delete input.acknowledgeQuietHours;
    delete input.sendAfterQuietHours;
    if (choice === 'now') input.acknowledgeQuietHours = true;
    else input.sendAfterQuietHours = true;
    await this.requeue(id, { input: JSON.stringify(input), confirm: true });
  }

  /** Another question the API asked (a likely duplicate, a booking's warnings, open work): do it anyway. */
  async doItAnyway(id: string): Promise<void> {
    const row = await this.row(id);
    const input = JSON.parse(row.input) as Record<string, unknown>;
    const flag = ANYWAY[row.rule ?? ''];
    if (flag) input[flag] = true;
    await this.requeue(id, { input: JSON.stringify(input), confirm: true });
  }

  /** Fix and try again, or Edit: what the person corrected goes again under the change's own id. */
  async fix(id: string, input: unknown): Promise<void> {
    await this.row(id);
    await this.requeue(id, { input: JSON.stringify(input), confirm: true });
  }

  /** A refused or held photo: try all its steps again. */
  async tryPhotoAgain(id: string): Promise<void> {
    await this.row(id);
    await this.attached?.db.execute(
      `UPDATE photo_uploads SET begin_command_id = CASE WHEN step = 'begin' THEN ? ELSE begin_command_id END,
         confirm_command_id = ?, upload_rounds = 0 WHERE id = ?`,
      [this.deps.newId(), this.deps.newId(), id],
    );
    await this.requeue(id, {});
  }

  /** Every change that waits on this one, all the way down: what discarding it would take with it. */
  async dependantsOf(id: string): Promise<OutboxRow[]> {
    return (await this.attached?.outbox.dependants(id)) ?? [];
  }

  /** Discards changes from the phone (the person was asked about their dependants first). */
  async discard(ids: readonly string[]): Promise<void> {
    const attached = this.attached;
    if (!attached || ids.length === 0) return;
    const photos = await attached.db.getAll<{ local_name: string }>(
      `SELECT local_name FROM photo_uploads WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [...ids],
    );
    await attached.outbox.discard(ids);
    for (const photo of photos) this.deps.removePhotoFile(attached.userId, photo.local_name);
    void this.refresh();
  }

  /** The ids a change waits for. */
  static dependsOn(row: Pick<OutboxRow, 'depends_on'>): string[] {
    return parseIds(row.depends_on);
  }

  private log(message: string, error?: unknown) {
    this.deps.log?.(message, error);
  }
}

/** What the person says yes to, for each question the API can ask about a change. */
const ANYWAY: Record<string, string> = {
  needs_confirmation: 'acknowledgeWarnings',
  duplicate: 'ignoreDuplicates',
  has_open_work: 'force',
  quiet_hours: 'acknowledgeQuietHours',
};

function workspaceOf(input: string): string | null {
  try {
    const value = (JSON.parse(input) as { workspaceId?: unknown }).workspaceId;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** A business's time zone and settings, from its synced row. */
export async function businessClockOf(
  workspaceId: string,
  runner: SqlRunner,
): Promise<BusinessClock | null> {
  const row = await runner.getOptional<{ timezone: string | null; settings: string | null }>(
    'SELECT timezone, settings FROM workspaces WHERE id = ?',
    [workspaceId],
  );
  return row?.timezone ? { timeZone: row.timezone, settings: row.settings } : null;
}

/** A photo's name when the screen gives none: when it was taken on this phone's clock, "Photo 2026-09-16 21.40.05.jpg". */
export function photoName(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return `Photo ${date} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.jpg`;
}
