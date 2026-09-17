import { describe, heldWords, loadNames, refusalWords } from './describe';
import type { Outbox, OutboxRow } from './outbox';
import { blockersOf, outcomeOf, parseIds, type Answer, type Outcome } from './rules';
import type { CommandRequest } from './send';
import type { Settled } from './uploader';
import { TOO_OLD_WORDS, type VersionGate } from './version-gate';

/**
 * Photos on their own track, so a big upload never holds up the queue of changes: each photo taken or picked on the
 * phone is kept in app storage until HandsFreeOS confirms it, then goes in three steps, each safe to repeat:
 *
 *   1. `file.begin_upload` with the phone's own file id (its receipt makes a repeat return the same place);
 *   2. the upload to Storage at that place: one request (which an iPhone finishes in the background), or for a file
 *      over 6 MB a resumable upload in 6 MB pieces that carries on from the last piece Storage has;
 *   3. `file.confirm`, after which the photo's file is deleted and the changes waiting for it are released.
 *
 * Anything that fails is tried again on its own, a little later each time, whenever the app is open with signal.
 */

/** Files bigger than this upload in pieces and resume where they stopped (Supabase's resumable uploads). */
export const RESUMABLE_OVER = 6 * 1024 * 1024;
/** Supabase takes resumable uploads in pieces of exactly 6 MB. */
export const PIECE_BYTES = 6 * 1024 * 1024;
/** How long a photo waits before its next try, failure after failure. */
export const PHOTO_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000];
/** Times a photo is uploaded again when HandsFreeOS says it never arrived, before it's refused. */
export const UPLOAD_ROUNDS = 2;

export type PhotoStep = 'begin' | 'upload' | 'confirm';

export interface PhotoRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly file_id: string;
  readonly record_type: string;
  readonly record_id: string;
  readonly file_name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly local_name: string;
  readonly taken_at: string;
  readonly step: PhotoStep;
  readonly begin_command_id: string;
  readonly confirm_command_id: string;
  readonly bucket: string | null;
  readonly object_path: string | null;
  readonly bytes_sent: number;
  readonly resume_url: string | null;
  readonly tries: number;
  readonly next_try_at: string | null;
  readonly upload_rounds: number;
}

/** What came back from Storage: a status and body, or nothing (no signal). */
export type StorageAnswer =
  | {
      readonly reached: true;
      readonly status: number;
      readonly body: string;
      readonly offset?: number | null;
      readonly location?: string | null;
    }
  | { readonly reached: false; readonly message: string };

/** How the phone talks to Storage and reads its files. */
export interface PhotoTransport {
  /** Uploads the whole file in one request (an iPhone carries on while the app is in the background). */
  uploadWhole(
    request: {
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly localName: string;
      readonly mimeType: string;
    },
    onProgress: (sent: number) => void,
  ): Promise<StorageAnswer>;
  /** Starts a resumable upload; `location` is where it carries on. */
  createResumable(request: {
    readonly url: string;
    readonly headers: Record<string, string>;
  }): Promise<StorageAnswer>;
  /** How much of a resumable upload Storage has (`offset`), or a status saying it's gone. */
  resumableOffset(request: {
    readonly url: string;
    readonly headers: Record<string, string>;
  }): Promise<StorageAnswer>;
  /** Sends one piece; `offset` is how much Storage has after it. */
  sendPiece(request: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly offset: number;
    readonly bytes: Uint8Array<ArrayBuffer>;
  }): Promise<StorageAnswer>;
  readPiece(localName: string, offset: number, length: number): Uint8Array<ArrayBuffer>;
  exists(localName: string): boolean;
  remove(localName: string): void;
}

export interface PhotoTrackDeps {
  readonly outbox: Outbox;
  readonly send: (request: CommandRequest) => Promise<Answer>;
  readonly refreshSession: () => Promise<void>;
  readonly token: () => Promise<string | null>;
  /** Supabase's address and the app's publishable key, for Storage. */
  readonly storage: { readonly url: string; readonly key: string };
  readonly transport: PhotoTransport;
  readonly gate: VersionGate;
  readonly now: () => number;
  readonly newId: () => string;
  /** Signed in, unlocked, with signal and the copy open. */
  readonly canRun: () => boolean;
  readonly settled?: (event: Settled) => void;
  /** Live progress for the screens: bytes sent of the total. */
  readonly progress?: (id: string, sent: number, total: number) => void;
  /** Test builds: a pause between pieces, so a flow can close the app halfway. */
  readonly pauseBetweenPieces?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Base64 of a short text (resumable upload metadata: bucket, path, type). */
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** Storage's answer when the object is already there: an earlier try finished. */
const alreadyThere = (answer: StorageAnswer) =>
  answer.reached &&
  (answer.status === 409 || answer.status === 400) &&
  /KeyAlreadyExists|already exists|Duplicate/i.test(answer.body);

export class PhotoTrack {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private wake: unknown = null;

  constructor(private readonly deps: PhotoTrackDeps) {}

  /** Starts a pass over the photos waiting, or asks for another once this one ends. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** Waits for the pass under way. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped = true;
    if (this.wake !== null) (this.deps.clearTimer ?? clearTimeout)(this.wake as never);
    this.wake = null;
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.stopped || !this.deps.canRun()) return;
      const now = new Date(this.deps.now()).toISOString();
      const next = await this.deps.outbox.db.getOptional<OutboxRow & { photo_id: string }>(
        `SELECT o.*, p.id AS photo_id FROM outbox o JOIN photo_uploads p ON p.id = o.id
         WHERE o.track = 'photo' AND o.state IN ('waiting', 'sending')
           AND (p.next_try_at IS NULL OR p.next_try_at <= ?)
         ORDER BY o.seq LIMIT 1`,
        [now],
      );
      if (!next) {
        await this.scheduleWake();
        return;
      }
      await this.handle(next);
    }
  }

  /** Wakes up for the next photo waiting out its retry. */
  private async scheduleWake(): Promise<void> {
    const soonest = await this.deps.outbox.db.getOptional<{ at: string | null }>(
      `SELECT min(p.next_try_at) AS at FROM photo_uploads p JOIN outbox o ON o.id = p.id
       WHERE o.state IN ('waiting', 'sending') AND p.next_try_at IS NOT NULL`,
    );
    if (!soonest?.at || this.stopped) return;
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as never));
    const set = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
    if (this.wake !== null) clear(this.wake);
    this.wake = set(
      () => {
        this.wake = null;
        this.kick();
      },
      Math.max(250, Date.parse(soonest.at) - this.deps.now()),
    );
  }

  private photo(id: string): Promise<PhotoRow | null> {
    return this.deps.outbox.db.getOptional<PhotoRow>('SELECT * FROM photo_uploads WHERE id = ?', [
      id,
    ]);
  }

  private async update(id: string, patch: Partial<Record<keyof PhotoRow, unknown>>): Promise<void> {
    const keys = Object.keys(patch);
    await this.deps.outbox.db.execute(
      `UPDATE photo_uploads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map((k) => patch[k as keyof PhotoRow]), id],
    );
  }

  private emit(event: Settled) {
    this.deps.settled?.(event);
  }

  private async handle(row: OutboxRow): Promise<void> {
    const { outbox } = this.deps;
    const ids = parseIds(row.depends_on);
    if (ids.length > 0) {
      const found = await outbox.states(ids);
      const blockers = blockersOf(
        ids,
        found.map((r) => ({ id: r.id, state: r.state })),
      );
      if (blockers.length > 0) {
        const byId = new Map(found.map((r) => [r.id, r]));
        const rows = blockers.map((b) => byId.get(b.id) ?? null);
        const names = await loadNames(
          outbox.db,
          rows.filter((r): r is OutboxRow => r !== null),
        );
        await outbox.settle(row.id, {
          state: 'held',
          reason: heldWords(rows.map((r) => ({ words: r ? describe(r, names) : null }))),
        });
        this.emit({ kind: 'held', row });
        return;
      }
    }
    if (this.deps.gate.tooOld()) {
      await outbox.settle(row.id, {
        state: 'retry',
        reason: TOO_OLD_WORDS,
        rule: 'upgrade_required',
      });
      this.emit({ kind: 'aside', row });
      return;
    }
    const photo = await this.photo(row.id);
    if (!photo) {
      await outbox.settle(row.id, {
        state: 'refused',
        reason: 'The photo isn’t on this phone any more.',
      });
      this.emit({ kind: 'refused', row });
      return;
    }
    if (row.state !== 'sending') await outbox.sending(row.id);
    if (photo.step === 'begin') await this.begin(row, photo);
    else if (photo.step === 'upload') await this.upload(row, photo);
    else await this.confirm(row, photo);
  }

  private async command(request: CommandRequest): Promise<Outcome> {
    const outcome = outcomeOf(await this.deps.send(request));
    if (outcome.kind !== 'unauthorized') return outcome;
    await this.deps.refreshSession().catch(() => undefined);
    const again = outcomeOf(await this.deps.send(request));
    return again.kind === 'unauthorized'
      ? { kind: 'retry', message: 'Your sign-in is being checked, so it tries again.', body: null }
      : again;
  }

  /** Settles what a command's answer means for the photo, when it isn't a success. */
  private async notDone(
    row: OutboxRow,
    outcome: Exclude<Outcome, { kind: 'sent' }>,
  ): Promise<void> {
    const { outbox } = this.deps;
    if (outcome.kind === 'too_old') {
      this.deps.gate.markTooOld(outcome.minVersion);
      await outbox.settle(row.id, {
        state: 'retry',
        reason: TOO_OLD_WORDS,
        rule: 'upgrade_required',
      });
      this.emit({ kind: 'aside', row });
      return;
    }
    if (outcome.kind === 'refused' || outcome.kind === 'ask') {
      await outbox.settle(row.id, {
        state: 'refused',
        reason: refusalWords(outcome.body, outcome.message),
        disposition: outcome.kind === 'ask' ? 'ask' : 'final',
        rule: outcome.rule,
        answer: outcome.body,
      });
      this.emit({ kind: 'refused', row });
      return;
    }
    await this.later(
      row,
      outcome.kind === 'retry' ? outcome.message : 'Your sign-in is being checked.',
    );
  }

  /** Tries again later: a little longer after each failure in a row. */
  private async later(row: OutboxRow, message: string): Promise<void> {
    const photo = await this.photo(row.id);
    const tries = (photo?.tries ?? 0) + 1;
    const wait = PHOTO_RETRY_MS[Math.min(tries - 1, PHOTO_RETRY_MS.length - 1)]!;
    await this.update(row.id, {
      tries,
      next_try_at: new Date(this.deps.now() + wait).toISOString(),
    });
    await this.deps.outbox.db.execute(
      `UPDATE outbox SET state = 'waiting', reason = ? WHERE id = ?`,
      [message, row.id],
    );
  }

  private async begin(row: OutboxRow, photo: PhotoRow): Promise<void> {
    const outcome = await this.command({
      name: 'file.begin_upload',
      commandId: photo.begin_command_id,
      input: row.input,
      madeAt: photo.taken_at,
      confirmedAt: null,
    });
    if (outcome.kind !== 'sent') return this.notDone(row, outcome);
    const place = outcome.output as { bucket?: string; objectPath?: string };
    if (!place?.bucket || !place.objectPath)
      return this.later(row, 'HandsFreeOS didn’t say where the photo goes.');
    await this.update(row.id, {
      step: 'upload',
      bucket: place.bucket,
      object_path: place.objectPath,
      tries: 0,
      next_try_at: null,
    });
  }

  private async storageHeaders(): Promise<Record<string, string> | null> {
    const token = await this.deps.token().catch(() => null);
    return token ? { authorization: `Bearer ${token}`, apikey: this.deps.storage.key } : null;
  }

  private async upload(row: OutboxRow, photo: PhotoRow): Promise<void> {
    const { transport } = this.deps;
    if (!transport.exists(photo.local_name)) {
      await this.deps.outbox.settle(row.id, {
        state: 'refused',
        reason: 'The photo isn’t on this phone any more, so it can’t be uploaded.',
      });
      this.emit({ kind: 'refused', row });
      return;
    }
    const headers = await this.storageHeaders();
    if (!headers || !photo.bucket || !photo.object_path)
      return this.later(row, 'No sign-in to upload it with yet.');
    const done =
      photo.size_bytes > RESUMABLE_OVER
        ? await this.resumable(row, photo, headers)
        : await this.whole(row, photo, headers);
    if (done === 'uploaded')
      await this.update(row.id, {
        step: 'confirm',
        bytes_sent: photo.size_bytes,
        tries: 0,
        next_try_at: null,
      });
  }

  private async whole(
    row: OutboxRow,
    photo: PhotoRow,
    headers: Record<string, string>,
  ): Promise<'uploaded' | 'later'> {
    const url = `${this.deps.storage.url}/storage/v1/object/${photo.bucket}/${encodePath(photo.object_path!)}`;
    const answer = await this.deps.transport.uploadWhole(
      {
        url,
        headers: { ...headers, 'content-type': photo.mime_type, 'x-upsert': 'false' },
        localName: photo.local_name,
        mimeType: photo.mime_type,
      },
      (sent) => this.deps.progress?.(row.id, sent, photo.size_bytes),
    );
    if ((answer.reached && answer.status >= 200 && answer.status < 300) || alreadyThere(answer))
      return 'uploaded';
    await this.storageTrouble(row, answer);
    return 'later';
  }

  private async storageTrouble(row: OutboxRow, answer: StorageAnswer): Promise<void> {
    if (answer.reached && (answer.status === 401 || answer.status === 403))
      await this.deps.refreshSession().catch(() => undefined);
    await this.later(
      row,
      answer.reached
        ? `The upload stopped (${answer.status}). It carries on by itself.`
        : 'No signal for the upload. It carries on by itself.',
    );
  }

  private async resumable(
    row: OutboxRow,
    photo: PhotoRow,
    auth: Record<string, string>,
  ): Promise<'uploaded' | 'later'> {
    const { transport } = this.deps;
    const headers = { ...auth, 'tus-resumable': '1.0.0' };
    let url = photo.resume_url;
    let offset = 0;
    if (url) {
      const where = await transport.resumableOffset({ url, headers });
      if (
        where.reached &&
        where.status >= 200 &&
        where.status < 300 &&
        typeof where.offset === 'number'
      )
        offset = where.offset;
      else if (where.reached && (where.status === 404 || where.status === 410)) url = null;
      else {
        await this.storageTrouble(row, where);
        return 'later';
      }
    }
    if (!url) {
      const created = await transport.createResumable({
        url: `${this.deps.storage.url}/storage/v1/upload/resumable`,
        headers: {
          ...headers,
          'upload-length': String(photo.size_bytes),
          'upload-metadata': [
            `bucketName ${b64(photo.bucket!)}`,
            `objectName ${b64(photo.object_path!)}`,
            `contentType ${b64(photo.mime_type)}`,
            `cacheControl ${b64('3600')}`,
          ].join(','),
          'x-upsert': 'false',
        },
      });
      if (alreadyThere(created)) return 'uploaded';
      if (!created.reached || created.status !== 201 || !created.location) {
        await this.storageTrouble(row, created);
        return 'later';
      }
      url = created.location;
      offset = 0;
      await this.update(row.id, { resume_url: url, bytes_sent: 0 });
    }
    this.deps.progress?.(row.id, offset, photo.size_bytes);
    while (offset < photo.size_bytes) {
      if (this.stopped) return 'later';
      const bytes = transport.readPiece(photo.local_name, offset, PIECE_BYTES);
      const sent = await transport.sendPiece({
        url,
        headers: { ...headers, 'content-type': 'application/offset+octet-stream' },
        offset,
        bytes,
      });
      if (!sent.reached || sent.status >= 300 || typeof sent.offset !== 'number') {
        await this.storageTrouble(row, sent);
        return 'later';
      }
      offset = sent.offset;
      await this.update(row.id, { bytes_sent: offset });
      this.deps.progress?.(row.id, offset, photo.size_bytes);
      const pause = this.deps.pauseBetweenPieces?.() ?? 0;
      if (pause > 0 && offset < photo.size_bytes) await sleep(pause);
    }
    return 'uploaded';
  }

  private async confirm(row: OutboxRow, photo: PhotoRow): Promise<void> {
    const { outbox } = this.deps;
    const input = JSON.stringify({ workspaceId: photo.workspace_id, fileId: photo.file_id });
    const outcome = await this.command({
      name: 'file.confirm',
      commandId: photo.confirm_command_id,
      input,
      madeAt: photo.taken_at,
      confirmedAt: null,
    });
    if (outcome.kind === 'sent') {
      await outbox.settle(row.id, { state: 'sent', answer: outcome.output });
      this.deps.transport.remove(photo.local_name);
      const released = await outbox.release(row.id);
      this.emit({ kind: 'sent', row, released });
      return;
    }
    // Storage doesn't have it after all: upload it again, and confirm under a new id (the refusal was kept).
    if (
      outcome.kind === 'refused' &&
      outcome.rule === 'file_not_uploaded' &&
      photo.upload_rounds < UPLOAD_ROUNDS
    ) {
      await this.update(row.id, {
        step: 'upload',
        confirm_command_id: this.deps.newId(),
        upload_rounds: photo.upload_rounds + 1,
        resume_url: null,
        bytes_sent: 0,
      });
      return;
    }
    return this.notDone(row, outcome);
  }
}
