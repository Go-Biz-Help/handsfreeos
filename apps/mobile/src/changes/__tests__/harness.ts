import type { GateStore } from '../version-gate';
import { Changes, type ChangesDeps } from '../controller';
import type { PhotoTransport, StorageAnswer } from '../photos';
import type { Answer } from '../rules';
import type { CommandRequest } from '../send';
import { TryAgainInPlace } from '../uploader';

import { FakePowerSync } from './fake-powersync';

/**
 * A phone and an API for the queue's tests: the queue on real SQLite, a clock that moves only when a test moves it,
 * PowerSync's upload loop (in-place tries 3 seconds apart, as the app sets it), and an API that keeps a receipt for
 * every command id, so a repeat returns the first answer as the real one does.
 */

export const DALE = '11111111-1111-4111-8111-111111111111';
export const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const MARIA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** 3:00 PM in Houston on the canvas's day. */
export const START = Date.parse('2026-09-16T20:00:00.000Z');

export type Script = (request: CommandRequest, server: FakeApi) => Answer | undefined;

export const refusal = (
  status: number,
  disposition: 'final' | 'ask' | 'retry' | undefined,
  message: string,
  extra: Record<string, unknown> = {},
): Answer => ({
  reached: true,
  status,
  body: {
    error: { code: 'rule_violation', message, ...(disposition ? { disposition } : {}), ...extra },
  },
});

export const noSignal: Answer = { reached: false, message: 'Network request failed' };

/** The API: a receipt per command id, and scripted answers a test puts in front. */
export class FakeApi {
  readonly requests: CommandRequest[] = [];
  /** Commands that ran, by command id: what ran and its answer. */
  readonly receipts = new Map<string, { name: string; input: string; output: unknown }>();
  private readonly scripts: Script[] = [];
  private counter = 0;

  /** Answers the next matching request with this; a script that returns undefined lets it through. */
  script(script: Script): void {
    this.scripts.push(script);
  }

  /** Answers every matching request this way until the script is removed. */
  always(script: Script): () => void {
    const wrapped: Script = (request, server) => {
      const answer = script(request, server);
      if (answer) this.scripts.unshift(wrapped);
      return answer;
    };
    this.scripts.push(wrapped);
    return () => {
      const i = this.scripts.indexOf(wrapped);
      if (i >= 0) this.scripts.splice(i, 1);
    };
  }

  /** Runs a command as the API would: a repeat of a command id returns its first answer. */
  apply(request: CommandRequest): Answer {
    const earlier = this.receipts.get(request.commandId);
    if (earlier) {
      if (earlier.name !== request.name || earlier.input !== request.input)
        return refusal(
          409,
          'final',
          'This change got mixed up with a different one the app sent earlier, so it wasn’t done. Make the change again.',
          {
            rule: 'command_id_reused',
          },
        );
      return { reached: true, status: 200, body: earlier.output };
    }
    const input = JSON.parse(request.input) as Record<string, unknown>;
    this.counter += 1;
    const output =
      request.name === 'file.begin_upload'
        ? {
            fileId: input.id,
            bucket: 'attachments',
            objectPath: `${String(input.workspaceId)}/person/${String(input.recordId)}/${String(input.id)}/${String(input.name)}`,
          }
        : request.name === 'file.confirm'
          ? { fileId: input.fileId, sizeBytes: 1, mimeType: 'image/jpeg' }
          : { ok: true, n: this.counter };
    this.receipts.set(request.commandId, { name: request.name, input: request.input, output });
    return { reached: true, status: 200, body: output };
  }

  readonly send = async (request: CommandRequest): Promise<Answer> => {
    this.requests.push(request);
    for (let i = 0; i < this.scripts.length; i++) {
      const script = this.scripts[i]!;
      const answer = script(request, this);
      if (answer) {
        this.scripts.splice(i, 1);
        return answer;
      }
    }
    return this.apply(request);
  };

  /** The names of the commands that ran, in order. */
  ran(): string[] {
    return [...this.receipts.values()].map((r) => r.name);
  }

  sent(name?: string): CommandRequest[] {
    return name ? this.requests.filter((r) => r.name === name) : this.requests;
  }
}

export function memoryStore(): GateStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const fire = () => listeners.forEach((l) => l());
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key, value) => {
      values.set(key, value);
      fire();
    },
    remove: (key) => {
      values.delete(key);
      fire();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

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

/** Storage and the phone's photos, in memory. */
export class FakeStorage implements PhotoTransport {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly objects = new Map<string, number>();
  readonly resumable = new Map<string, { path: string; length: number; offset: number }>();
  readonly requests: string[] = [];
  /** Requests to fail with no signal, by kind ("whole", "create", "head", "piece"). */
  failNext: string[] = [];
  /** Pieces to accept before losing signal, for an upload stopped halfway. */
  piecesBeforeCut: number | null = null;

  private cut(kind: string): StorageAnswer | null {
    const i = this.failNext.indexOf(kind);
    if (i < 0) return null;
    this.failNext.splice(i, 1);
    return { reached: false, message: 'Network request failed' };
  }

  keep(localName: string, size: number) {
    this.files.set(localName, new Uint8Array(size));
  }

  async uploadWhole(
    request: { url: string; localName: string },
    onProgress: (sent: number) => void,
  ): Promise<StorageAnswer> {
    this.requests.push(`whole ${request.url}`);
    const cut = this.cut('whole');
    if (cut) return cut;
    const path = request.url.split('/storage/v1/object/')[1]!;
    if (this.objects.has(path))
      return {
        reached: true,
        status: 400,
        body: '{"statusCode":"409","error":"Duplicate","code":"KeyAlreadyExists"}',
      };
    const size = this.files.get(request.localName)!.length;
    onProgress(size);
    this.objects.set(path, size);
    return { reached: true, status: 200, body: '{}' };
  }

  async createResumable(request: {
    url: string;
    headers: Record<string, string>;
  }): Promise<StorageAnswer> {
    this.requests.push('create');
    const cut = this.cut('create');
    if (cut) return cut;
    const location = `http://storage.test/resumable/${this.resumable.size + 1}`;
    const metadata = Object.fromEntries(
      request.headers['upload-metadata']!.split(',').map((pair) => {
        const [key, value] = pair.split(' ');
        return [key, atob(value!)];
      }),
    );
    this.resumable.set(location, {
      path: `${metadata.bucketName}/${metadata.objectName}`,
      length: Number(request.headers['upload-length']),
      offset: 0,
    });
    return { reached: true, status: 201, body: '', location };
  }

  async resumableOffset(request: { url: string }): Promise<StorageAnswer> {
    this.requests.push('head');
    const cut = this.cut('head');
    if (cut) return cut;
    const upload = this.resumable.get(request.url);
    return upload
      ? { reached: true, status: 200, body: '', offset: upload.offset }
      : { reached: true, status: 404, body: '' };
  }

  async sendPiece(request: {
    url: string;
    offset: number;
    bytes: Uint8Array;
  }): Promise<StorageAnswer> {
    this.requests.push(`piece ${request.offset}`);
    const cut = this.cut('piece');
    if (cut) return cut;
    if (this.piecesBeforeCut !== null) {
      if (this.piecesBeforeCut === 0) {
        this.piecesBeforeCut = null;
        return { reached: false, message: 'Network request failed' };
      }
      this.piecesBeforeCut -= 1;
    }
    const upload = this.resumable.get(request.url)!;
    if (request.offset !== upload.offset) return { reached: true, status: 409, body: 'offset' };
    upload.offset += request.bytes.length;
    if (upload.offset >= upload.length) this.objects.set(upload.path, upload.length);
    return { reached: true, status: 204, body: '', offset: upload.offset };
  }

  readPiece(localName: string, offset: number, length: number) {
    return this.files.get(localName)!.slice(offset, offset + length);
  }

  exists(localName: string) {
    return this.files.has(localName);
  }

  remove(localName: string) {
    this.files.delete(localName);
  }
}

export interface Phone {
  readonly db: FakePowerSync;
  readonly api: FakeApi;
  readonly storage: FakeStorage;
  readonly changes: Changes;
  readonly clock: { now: number };
  readonly store: ReturnType<typeof memoryStore>;
  readonly refreshes: { count: number };
  readonly timers: { at: number; run: () => void }[];
  /** PowerSync's upload loop, until the queue is empty: in-place tries 3 seconds apart. Returns how many tries in place. */
  sync(): Promise<number>;
  /** Moves the clock on, running any timer due. */
  advance(ms: number): Promise<void>;
  setOnline(online: boolean): void;
  setVersion(version: string): void;
  returnToApp(): void;
  /** The outbox row for a change. */
  row(id: string): Record<string, unknown> & { state: string; reason: string | null };
  /** Waits for the photo track and any counting to finish. */
  settle(): Promise<void>;
}

export function phone(options: Partial<ChangesDeps> & { online?: boolean } = {}): Phone {
  const db = new FakePowerSync();
  const api = new FakeApi();
  const storage = new FakeStorage();
  const clock = { now: START };
  const store = memoryStore();
  const refreshes = { count: 0 };
  let online = options.online ?? true;
  const network = new Watch();
  const appActive = new Watch();
  let version = '1.0.0';
  let ids = 0;
  const timers: { at: number; run: () => void }[] = [];
  const changes = new Changes({
    send: api.send,
    session: {
      accessToken: async () => 'token',
      refreshNow: async () => {
        refreshes.count += 1;
      },
    },
    network: { online: () => online, subscribe: network.subscribe },
    lock: { isLocked: () => false, subscribe: () => () => undefined },
    appActive: { subscribe: appActive.subscribe },
    store,
    appVersion: () => version,
    newId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
    },
    now: () => clock.now,
    storage: { url: 'http://supabase.test', key: 'sb_publishable_test' },
    photoTransport: () => storage,
    removePhotoFile: (_userId, name) => storage.remove(name),
    setTimer: (run, ms) => {
      const timer = { at: clock.now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const i = timers.indexOf(timer as never);
      if (i >= 0) timers.splice(i, 1);
    },
    ...options,
  });
  changes.start();
  changes.opened(db, DALE);

  // A business on the phone: Lone Star in Houston, its quiet hours 8 PM to 8 AM, and Maria.
  db.sqlite
    .prepare(
      `INSERT INTO workspaces (id, name, timezone, settings) VALUES (?, 'Lone Star HVAC & Roofing', 'America/Chicago', ?)`,
    )
    .run(
      LONE_STAR,
      JSON.stringify({
        telephony: { quietHours: { enabled: true, start: '20:00', end: '08:00' } },
      }),
    );
  db.sqlite
    .prepare(
      `INSERT INTO people (id, workspace_id, first_name, last_name) VALUES (?, ?, 'Maria', 'Lopez')`,
    )
    .run(MARIA, LONE_STAR);
  db.sqlite.exec('DELETE FROM ps_crud');

  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await (
        changes as unknown as { attached: { photos: { idle(): Promise<void> } } | null }
      ).attached?.photos.idle();
    }
    await changes.refresh();
  };

  return {
    db,
    api,
    storage,
    changes,
    clock,
    store,
    refreshes,
    timers,
    async sync() {
      let inPlace = 0;
      for (let i = 0; i < 500; i++) {
        try {
          await changes.upload(db);
          await settle();
          return inPlace;
        } catch (error) {
          if (!(error instanceof TryAgainInPlace)) throw error;
          inPlace += 1;
          // PowerSync waits its retry delay, then tries the same upload again.
          clock.now += 3_000;
        }
      }
      throw new Error('The upload queue never emptied.');
    },
    async advance(ms) {
      clock.now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at))
        if (timer.at <= clock.now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
      await settle();
    },
    setOnline(next) {
      online = next;
      network.fire();
    },
    setVersion(next) {
      version = next;
      store.set('version-changed', next);
    },
    returnToApp() {
      appActive.fire();
    },
    row(id) {
      return db.rows<{ state: string; reason: string | null }>(
        'SELECT * FROM outbox WHERE id = ?',
        [id],
      )[0]!;
    },
    settle,
  };
}
