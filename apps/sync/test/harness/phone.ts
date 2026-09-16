/**
 * A phone, played by PowerSync's Node client against the real local service and the real API.
 *
 * It keeps its own SQLite copy of what the streams send (the tables and columns come from sync-config.yaml, as the
 * app's schema will), and every change made on it follows the plan's outbox ("The queue keeps order without
 * jamming"):
 *   - One change is one local transaction: its optimistic rows, one row in `commands` (the only thing uploaded)
 *     and its own row in `outbox`, which is local and the truth for anything held, refused, asked about or waiting.
 *   - The uploader sends one command per transaction with the app's headers: its client and build, the command's
 *     id, when it was done and when it was sent by the phone's own clock (which may be wrong), and when "Still
 *     send?" was answered.
 *   - Applied: done. `final`: completed, and the refusal kept in the outbox with its reason. `ask`: completed and
 *     kept for the person's answer, then sent again under the same id.
 *   - Network and server errors (and `retry` answers) are retried in place, which is PowerSync trying the upload
 *     again, for up to a minute; then the change is set aside to retry later, so the phone keeps receiving everyone
 *     else's changes (nothing new downloads while a change waits in PowerSync's queue).
 *   - A change that depends on one that is held, refused, asked about or waiting is held too, and never sent.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_CLIENT, APP_HEADERS } from '@hfos/core';
import { signInTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import {
  column,
  createConsoleLogger,
  LogLevels,
  PowerSyncDatabase,
  Schema,
  SyncStreamConnectionMethod,
  Table,
  type AbstractPowerSyncDatabase,
  type SyncStreamSubscription,
  type Transaction,
} from '@powersync/node';
import { clientTables } from '../../src/shape';
import type { RunningApi } from './api';
import { SYNC_URL } from './sync-url';

/** The app build the phones say they are. */
export const APP_VERSION = '1.0.0';
/** How long the app retries a change in place before setting it aside. */
export const RETRY_IN_PLACE_MS = 60_000;

/** Where a change stands on the phone. */
export type OutboxState = 'waiting' | 'applied' | 'refused' | 'ask' | 'held' | 'retry';

export interface OutboxItem {
  /** The command's id. */
  readonly id: string;
  readonly name: string;
  /** JSON. */
  readonly input: string;
  /** JSON: the ids of the changes it waits for. */
  readonly depends_on: string;
  /** When it was done, by the phone's clock. */
  readonly occurred_at: string;
  readonly confirmed_at: string | null;
  readonly state: OutboxState;
  /** Why it's held, refused, asked about or waiting. */
  readonly reason: string | null;
  /** JSON: the command's output, or the refusal's body. */
  readonly answer: string | null;
  readonly attempts: number;
  readonly first_tried_at: string | null;
  /** The order the person made changes in. */
  readonly seq: number;
}

/** A request the uploader made: status 0 never reached the API; `lost` reached it, but its answer never came back. */
export interface SentRequest {
  readonly commandId: string;
  readonly name: string;
  readonly status: number;
  readonly lost: boolean;
  readonly at: number;
}

export interface PhoneOptions {
  readonly api: RunningApi;
  readonly user: TestUser;
  /** For file names and logs. */
  readonly label: string;
  /** The phone's clock minus the real time, in ms: an hour fast is 3_600_000. */
  readonly clockSkewMs?: number;
  /** The app's minute, shortened for a test that waits it out. */
  readonly retryInPlaceMs?: number;
}

interface Upload {
  readonly id: string;
  readonly name: string;
  readonly input: string;
  readonly dependsOn: readonly string[];
  readonly occurredAt: string;
  readonly confirmedAt: string | null;
}

type Result = {
  readonly kind: 'applied' | 'final' | 'ask' | 'retry';
  readonly reason: string | null;
  readonly body: unknown;
};

const BLOCKING: readonly OutboxState[] = ['held', 'refused', 'ask', 'retry'];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HFOS_SYNC_TRACE=1 prints what each phone's uploader does. */
const trace = (label: string, ...what: unknown[]) => {
  if (process.env.HFOS_SYNC_TRACE)
    console.log(new Date().toISOString().slice(11, 23), label, ...what);
};

/** Polls until `check` gives something, and says how long that took. */
export async function eventually<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return { value, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out after ${timeoutMs} ms: ${label}`);
    await sleep(50);
  }
}

let schema: Promise<Schema> | null = null;

/** The phone's schema: every client table the streams fill, typed as PowerSync types them, and the outbox. */
function phoneSchema(): Promise<Schema> {
  schema ??= clientTables(testDbs().admin.db).then((tables) => {
    const typed = { text: column.text, integer: column.integer, real: column.real };
    const synced = Object.fromEntries(
      [...tables].map(([name, columns]) => [
        name,
        new Table(Object.fromEntries([...columns].map(([c, t]) => [c, typed[t]]))),
      ]),
    );
    const change = {
      name: column.text,
      input: column.text,
      depends_on: column.text,
      occurred_at: column.text,
      confirmed_at: column.text,
    };
    return new Schema({
      ...synced,
      commands: new Table(change, { insertOnly: true }),
      outbox: new Table(
        {
          ...change,
          state: column.text,
          reason: column.text,
          answer: column.text,
          attempts: column.integer,
          first_tried_at: column.text,
          seq: column.integer,
          updated_at: column.text,
        },
        { localOnly: true },
      ),
    });
  });
  return schema;
}

let changes = 0;

export class Phone {
  /** Every request the uploader made, in order. */
  readonly sent: SentRequest[] = [];
  /** Trouble between this phone and the API (the sync service is unaffected). */
  readonly network = { apiUnreachable: false, loseResponses: 0 };
  private token: string | null = null;
  private readonly subscriptions: SyncStreamSubscription[] = [];

  private constructor(
    readonly options: PhoneOptions,
    readonly db: AbstractPowerSyncDatabase,
    private readonly dir: string,
  ) {}

  static async open(options: PhoneOptions): Promise<Phone> {
    const name = `${options.label}-${randomUUID().slice(0, 8)}`;
    const dir = join(tmpdir(), 'hfos-sync-scenarios', name);
    mkdirSync(dir, { recursive: true });
    const db = new PowerSyncDatabase({
      schema: await phoneSchema(),
      // The file name must differ per database: the Node SDK keys its process-wide sync and upload locks by it,
      // so two phones both called phone.sqlite would take turns to sync, and the second would never connect.
      database: { dbFilename: `${name}.sqlite`, dbLocation: dir },
      logger: createConsoleLogger({
        minLevel: process.env.HFOS_SYNC_TRACE === 'sdk' ? LogLevels.debug : LogLevels.error,
        prefix: `PowerSync (${options.label})`,
      }),
    });
    await db.init();
    return new Phone(options, db, dir);
  }

  /** The phone's own clock. */
  now(): Date {
    return new Date(Date.now() + (this.options.clockSkewMs ?? 0));
  }

  private async accessToken(): Promise<string> {
    this.token ??= await signInTestUser(this.options.user);
    return this.token;
  }

  /** Signal: syncs, and sends what's waiting. */
  async online(): Promise<void> {
    await this.db.connect(
      {
        fetchCredentials: async () => ({ endpoint: SYNC_URL, token: await this.accessToken() }),
        uploadData: (db) => this.upload(db),
      },
      {
        connectionMethod: SyncStreamConnectionMethod.HTTP,
        retryDelayMs: 250,
        crudUploadThrottleMs: 20,
      },
    );
  }

  /** No signal. */
  async offline(): Promise<void> {
    await this.db.disconnect();
  }

  /** Keeps a business on the phone (`business_v1`, one subscription per business). */
  async keepOffline(workspaceId: string): Promise<void> {
    this.subscriptions.push(
      await this.db.syncStream('business_v1', { workspace_id: workspaceId }).subscribe(),
    );
  }

  /** Online, with every business kept on it downloaded once. */
  async synced(): Promise<void> {
    await this.db.waitForFirstSync();
    for (const s of this.subscriptions) await s.waitForFirstSync();
  }

  /**
   * The person does something: its optimistic rows, its command and its outbox row, in one local transaction.
   * `doneAt` is by the phone's clock (a change written a while ago). Returns the command's id.
   */
  async change(
    name: string,
    input: Record<string, unknown>,
    options: {
      readonly optimistic?: (tx: Transaction) => Promise<unknown>;
      readonly dependsOn?: readonly string[];
      readonly doneAt?: Date;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const occurredAt = (options.doneAt ?? this.now()).toISOString();
    const body = JSON.stringify(input);
    const dependsOn = JSON.stringify(options.dependsOn ?? []);
    await this.db.writeTransaction(async (tx) => {
      await options.optimistic?.(tx);
      await tx.execute(
        'INSERT INTO commands (id, name, input, depends_on, occurred_at) VALUES (?, ?, ?, ?, ?)',
        [id, name, body, dependsOn, occurredAt],
      );
      await tx.execute(
        `INSERT INTO outbox (id, name, input, depends_on, occurred_at, state, attempts, seq, updated_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', 0, ?, ?)`,
        [id, name, body, dependsOn, occurredAt, ++changes, this.now().toISOString()],
      );
    });
    return id;
  }

  /** A change sent again under its own id, at the back of the queue. */
  private async resend(item: OutboxItem, confirmedAt: string | null): Promise<void> {
    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `INSERT INTO commands (id, name, input, depends_on, occurred_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [item.id, item.name, item.input, item.depends_on, item.occurred_at, confirmedAt],
      );
      await tx.execute(
        `UPDATE outbox SET state = 'waiting', confirmed_at = ?, reason = NULL, answer = NULL, attempts = 0,
           first_tried_at = NULL, updated_at = ? WHERE id = ?`,
        [confirmedAt, this.now().toISOString(), item.id],
      );
    });
  }

  /** "Still send?" — yes. */
  async stillSend(commandId: string): Promise<void> {
    const item = await this.item(commandId);
    if (item?.state !== 'ask') throw new Error(`${commandId} isn't waiting for an answer`);
    await this.resend(item, this.now().toISOString());
  }

  /** Sends again, in the order they were made, the changes set aside to retry later. */
  async retryLater(): Promise<void> {
    const waiting = await this.db.getAll<OutboxItem>(
      `SELECT * FROM outbox WHERE state = 'retry' ORDER BY seq`,
    );
    for (const item of waiting) await this.resend(item, item.confirmed_at);
  }

  async item(commandId: string): Promise<OutboxItem | null> {
    return this.db.getOptional<OutboxItem>('SELECT * FROM outbox WHERE id = ?', [commandId]);
  }

  /** Waits until the change has settled in the outbox in this state, and gives it. */
  async settled(commandId: string, state: OutboxState, timeoutMs = 20_000): Promise<OutboxItem> {
    const { value } = await eventually(
      `${this.options.label}: ${commandId} ${state}`,
      async () => {
        const item = await this.item(commandId);
        if (item && item.state !== 'waiting' && item.state !== state)
          throw new Error(
            `${item.name} is ${item.state}, not ${state}: ${item.reason} ${item.answer}`,
          );
        return item?.state === state ? item : null;
      },
      timeoutMs,
    );
    return value;
  }

  /** One row of a table on the phone. */
  async row<T = Record<string, unknown>>(table: string, id: string): Promise<T | null> {
    return this.db.getOptional<T>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.getAll<T>(sql, params);
  }

  /** Nothing waits in PowerSync's upload queue. */
  async queueEmpty(): Promise<boolean> {
    return (await this.db.getUploadQueueStats()).count === 0;
  }

  async close(): Promise<void> {
    for (const s of this.subscriptions) s.unsubscribe();
    await this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private async upload(db: AbstractPowerSyncDatabase): Promise<void> {
    const label = this.options.label;
    trace(label, 'uploadData called');
    for (;;) {
      const tx = await db.getNextCrudTransaction();
      trace(
        label,
        'next transaction',
        tx?.transactionId,
        tx?.crud.map((e) => `${e.op} ${e.table}`),
      );
      if (!tx) return;
      const command = tx.crud.find((e) => e.table === 'commands');
      if (!command?.opData) {
        // Only local rows changed: nothing for the server.
        await tx.complete();
        continue;
      }
      const d = command.opData;
      const upload: Upload = {
        id: command.id,
        name: String(d.name),
        input: String(d.input),
        dependsOn: JSON.parse(String(d.depends_on ?? '[]')) as string[],
        occurredAt: String(d.occurred_at),
        confirmedAt: typeof d.confirmed_at === 'string' ? d.confirmed_at : null,
      };
      const blockers = upload.dependsOn.length
        ? await db.getAll<{ name: string; state: OutboxState }>(
            `SELECT name, state FROM outbox WHERE id IN (${upload.dependsOn.map(() => '?').join(', ')})
               AND state IN (${BLOCKING.map(() => '?').join(', ')})`,
            [...upload.dependsOn, ...BLOCKING],
          )
        : [];
      if (blockers.length) {
        const on = blockers.map((b) => `${b.name} (${b.state})`).join(', ');
        await this.settle(db, upload.id, 'held', `Waiting on ${on}`, null);
        await tx.complete();
        continue;
      }
      const result = await this.send(upload);
      if (result.kind === 'retry') {
        const row = await db.get<{ first_tried_at: string | null }>(
          'SELECT first_tried_at FROM outbox WHERE id = ?',
          [upload.id],
        );
        const first = row.first_tried_at ? Date.parse(row.first_tried_at) : Date.now();
        await db.execute(
          'UPDATE outbox SET attempts = attempts + 1, first_tried_at = ?, reason = ? WHERE id = ?',
          [new Date(first).toISOString(), result.reason, upload.id],
        );
        // Thrown: PowerSync tries this upload again shortly, in place, and nothing new downloads meanwhile.
        if (Date.now() - first < (this.options.retryInPlaceMs ?? RETRY_IN_PLACE_MS))
          throw new Error(`${upload.name} will be tried again: ${result.reason}`);
        await this.settle(db, upload.id, 'retry', result.reason, result.body);
        await tx.complete();
        continue;
      }
      const state =
        result.kind === 'applied' ? 'applied' : result.kind === 'ask' ? 'ask' : 'refused';
      trace(label, 'answer', upload.name, state);
      await this.settle(db, upload.id, state, result.reason, result.body);
      trace(label, 'outbox updated');
      await tx.complete();
      trace(label, 'completed');
    }
  }

  private async settle(
    db: AbstractPowerSyncDatabase,
    id: string,
    state: OutboxState,
    reason: string | null,
    answer: unknown,
  ): Promise<void> {
    await db.execute(
      'UPDATE outbox SET state = ?, reason = ?, answer = ?, updated_at = ? WHERE id = ?',
      [
        state,
        reason,
        answer === null || answer === undefined ? null : JSON.stringify(answer),
        this.now().toISOString(),
        id,
      ],
    );
  }

  private async send(upload: Upload): Promise<Result> {
    const record = (status: number, lost = false) =>
      this.sent.push({ commandId: upload.id, name: upload.name, status, lost, at: Date.now() });
    if (this.network.apiUnreachable) {
      record(0);
      return { kind: 'retry', reason: 'The API can’t be reached', body: null };
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      'content-type': 'application/json',
      [APP_HEADERS.client]: APP_CLIENT,
      [APP_HEADERS.appVersion]: APP_VERSION,
      [APP_HEADERS.commandId]: upload.id,
      [APP_HEADERS.occurredAt]: upload.occurredAt,
      [APP_HEADERS.sentAt]: this.now().toISOString(),
    };
    if (upload.confirmedAt) headers[APP_HEADERS.confirmedAt] = upload.confirmedAt;
    let res: Response;
    try {
      res = await fetch(`${this.options.api.url}/v1/commands/${upload.name}`, {
        method: 'POST',
        headers,
        body: upload.input,
      });
    } catch (e) {
      record(0);
      return { kind: 'retry', reason: `No answer: ${(e as Error).message}`, body: null };
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; disposition?: string };
    } | null;
    if (this.network.loseResponses > 0) {
      // It reached the API and ran; the answer is lost on the way back.
      this.network.loseResponses -= 1;
      record(res.status, true);
      return { kind: 'retry', reason: 'The answer never arrived', body: null };
    }
    record(res.status);
    if (res.ok) return { kind: 'applied', reason: null, body };
    const error = body?.error;
    if (res.status === 401) this.token = null;
    if (res.status >= 500 || !error?.disposition || error.disposition === 'retry')
      return { kind: 'retry', reason: `${res.status}: ${error?.message ?? 'no answer'}`, body };
    return {
      kind: error.disposition === 'ask' ? 'ask' : 'final',
      reason: error.message ?? `Refused (${res.status})`,
      body,
    };
  }
}
