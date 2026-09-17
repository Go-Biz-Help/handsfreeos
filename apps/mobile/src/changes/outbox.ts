import { parseIds, SENT_KEPT_MS, type ChangeState } from './rules';

/**
 * The outbox on the phone's database: every change a person makes, with where it stands, read and written in SQL on
 * the person's own copy. The uploader and the photo track settle changes here; screens read it.
 */

/** What the outbox needs of a database or a transaction: PowerSync's own methods. */
export interface SqlRunner {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

/** One entry in PowerSync's upload queue. */
export interface CrudEntryLike {
  readonly id: string;
  readonly table: string;
  readonly op: string;
  readonly opData?: Record<string, unknown>;
}

export interface CrudTransactionLike {
  readonly crud: readonly CrudEntryLike[];
  complete(): Promise<void>;
}

export interface OutboxDb extends SqlRunner {
  writeTransaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
  getNextCrudTransaction(): Promise<CrudTransactionLike | null>;
}

export type Track = 'queue' | 'photo';

export interface OutboxRow {
  readonly id: string;
  readonly command_id: string;
  readonly name: string;
  readonly workspace_id: string;
  readonly input: string;
  readonly made_at: string;
  readonly depends_on: string;
  readonly track: Track;
  readonly state: ChangeState;
  readonly reason: string | null;
  readonly disposition: string | null;
  readonly rule: string | null;
  readonly answer: string | null;
  readonly attempts: number;
  readonly revision: number;
  readonly confirmed_at: string | null;
  readonly seq: number;
  readonly queued_at: string;
  readonly settled_at: string;
  readonly sent_at: string | null;
}

export interface NewChange {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  /** JSON, exactly as it will be sent. */
  readonly input: string;
  readonly madeAt: string;
  readonly dependsOn: readonly string[];
  readonly track: Track;
}

export interface Settle {
  readonly state: ChangeState;
  readonly reason?: string | null;
  readonly disposition?: string | null;
  readonly rule?: string | null;
  readonly answer?: unknown;
}

const json = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

/** Every state but sent: the changes still on their way, or waiting for the person. */
export const UNSENT_SQL = `state != 'sent'`;

export class Outbox {
  constructor(
    readonly db: OutboxDb,
    private readonly now: () => number,
  ) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Adds a change inside the person's own local transaction: its outbox row, and (for the upload queue) its entry in
   * PowerSync's queue. The caller writes the optimistic rows in the same transaction.
   */
  async add(tx: SqlRunner, change: NewChange): Promise<void> {
    const at = this.iso();
    const next = await tx.getOptional<{ seq: number | null }>('SELECT max(seq) AS seq FROM outbox');
    const seq = (next?.seq ?? 0) + 1;
    await tx.execute(
      `INSERT INTO outbox (id, command_id, name, workspace_id, input, made_at, depends_on, track, state, attempts,
         revision, seq, queued_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0, 0, ?, ?, ?)`,
      [
        change.id,
        change.id,
        change.name,
        change.workspaceId,
        change.input,
        change.madeAt,
        JSON.stringify(change.dependsOn),
        change.track,
        seq,
        at,
        at,
      ],
    );
    if (change.track === 'queue')
      await tx.execute('INSERT INTO commands (id, name) VALUES (?, ?)', [change.id, change.name]);
  }

  get(id: string, runner: SqlRunner = this.db): Promise<OutboxRow | null> {
    return runner.getOptional<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
  }

  /** The changes with these ids, as they stand. */
  async states(ids: readonly string[], runner: SqlRunner = this.db): Promise<OutboxRow[]> {
    if (ids.length === 0) return [];
    return runner.getAll<OutboxRow>(
      `SELECT * FROM outbox WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [...ids],
    );
  }

  async settle(id: string, to: Settle, runner: SqlRunner = this.db): Promise<void> {
    const at = this.iso();
    await runner.execute(
      `UPDATE outbox SET state = ?, reason = ?, disposition = ?, rule = ?, answer = ?, settled_at = ?,
         sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
       WHERE id = ?`,
      [
        to.state,
        to.reason ?? null,
        to.disposition ?? null,
        to.rule ?? null,
        json(to.answer),
        at,
        to.state,
        at,
        id,
      ],
    );
  }

  /** On its way: counts the try. */
  async sending(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE outbox SET state = 'sending', attempts = attempts + 1, settled_at = ? WHERE id = ?`,
      [this.iso(), id],
    );
  }

  /** Sends later under another id: the API kept an earlier try of this change with different details. */
  async newCommandId(id: string, commandId: string): Promise<void> {
    await this.db.execute('UPDATE outbox SET command_id = ? WHERE id = ?', [commandId, id]);
  }

  /**
   * Puts changes back in the queue, in the order they were made, each under its own id at the back of the queue. A
   * confirmed change carries when the person said yes; a fixed one, what it now sends. Changes already waiting
   * their turn stay where they are.
   */
  async requeue(
    ids: readonly string[],
    options: { readonly confirmedAt?: string; readonly input?: string } = {},
    runner?: SqlRunner,
  ): Promise<string[]> {
    const run = async (tx: SqlRunner) => {
      const rows = (await this.states(ids, tx)).sort((a, b) => a.seq - b.seq);
      const queued: string[] = [];
      for (const row of rows) {
        const edited = options.input !== undefined && options.input !== row.input;
        if (row.state === 'sent') continue;
        if ((row.state === 'waiting' || row.state === 'sending') && !edited) {
          if (options.confirmedAt)
            await tx.execute('UPDATE outbox SET confirmed_at = ? WHERE id = ?', [
              options.confirmedAt,
              row.id,
            ]);
          continue;
        }
        const at = this.iso();
        await tx.execute(
          `UPDATE outbox SET state = 'waiting', reason = NULL, disposition = NULL, rule = NULL, answer = NULL,
             attempts = 0, queued_at = ?, settled_at = ?, confirmed_at = coalesce(?, confirmed_at),
             input = coalesce(?, input), revision = revision + ?
           WHERE id = ?`,
          [at, at, options.confirmedAt ?? null, options.input ?? null, edited ? 1 : 0, row.id],
        );
        if (row.track === 'queue')
          await tx.execute('INSERT INTO commands (id, name) VALUES (?, ?)', [row.id, row.name]);
        else
          await tx.execute('UPDATE photo_uploads SET tries = 0, next_try_at = NULL WHERE id = ?', [
            row.id,
          ]);
        queued.push(row.id);
      }
      return queued;
    };
    return runner ? run(runner) : this.db.writeTransaction(run);
  }

  /** The changes that wait directly on this one, held until it goes through. */
  directDependants(id: string, runner: SqlRunner = this.db): Promise<OutboxRow[]> {
    return runner.getAll<OutboxRow>(
      `SELECT o.* FROM outbox o, json_each(o.depends_on) d
       WHERE d.value = ? AND o.state != 'sent' ORDER BY o.seq`,
      [id],
    );
  }

  /** Every change that waits on this one, all the way down the chain, in the order they were made. */
  async dependants(id: string, runner: SqlRunner = this.db): Promise<OutboxRow[]> {
    const found = new Map<string, OutboxRow>();
    let frontier = [id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const from of frontier)
        for (const row of await this.directDependants(from, runner))
          if (!found.has(row.id) && row.id !== id) {
            found.set(row.id, row);
            next.push(row.id);
          }
      frontier = next;
    }
    return [...found.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * A change went through: the held changes that were waiting only on it (or on it and others already sent) go back in
   * the queue, in order. Their own dependants follow once they go.
   */
  async release(id: string): Promise<string[]> {
    return this.db.writeTransaction(async (tx) => {
      const held = (await this.directDependants(id, tx)).filter((row) => row.state === 'held');
      const ready: string[] = [];
      for (const row of held) {
        const deps = parseIds(row.depends_on);
        if (deps.length === 0) {
          ready.push(row.id);
          continue;
        }
        const unsent = await tx.getOptional<{ n: number }>(
          `SELECT count(*) AS n FROM outbox WHERE state != 'sent' AND id IN (${deps.map(() => '?').join(', ')})`,
          deps,
        );
        const missing = await tx.getOptional<{ n: number }>(
          `SELECT ? - count(*) AS n FROM outbox WHERE id IN (${deps.map(() => '?').join(', ')})`,
          [deps.length, ...deps],
        );
        if ((unsent?.n ?? 0) === 0 && (missing?.n ?? 0) === 0) ready.push(row.id);
      }
      return this.requeue(ready, {}, tx);
    });
  }

  /** Deletes changes from the phone (the person discarded them), with their photos' rows. */
  async discard(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const marks = ids.map(() => '?').join(', ');
    await this.db.writeTransaction(async (tx) => {
      await tx.execute(`DELETE FROM photo_uploads WHERE id IN (${marks})`, [...ids]);
      await tx.execute(`DELETE FROM outbox WHERE id IN (${marks})`, [...ids]);
    });
  }

  /** How many changes haven't gone through: waiting, on their way, held, asked about, refused or set aside. */
  async unsentCount(runner: SqlRunner = this.db): Promise<number> {
    const row = await runner.getOptional<{ n: number }>(
      `SELECT count(*) AS n FROM outbox WHERE ${UNSENT_SQL}`,
    );
    return row?.n ?? 0;
  }

  /** The changes set aside to send again later, in the order they were made. */
  async setAside(track?: Track): Promise<OutboxRow[]> {
    return this.db.getAll<OutboxRow>(
      `SELECT * FROM outbox WHERE state = 'retry' ${track ? 'AND track = ?' : ''} ORDER BY seq`,
      track ? [track] : [],
    );
  }

  /** Clears sent changes older than a day. */
  async prune(): Promise<void> {
    const before = new Date(this.now() - SENT_KEPT_MS).toISOString();
    await this.db.execute(`DELETE FROM outbox WHERE state = 'sent' AND sent_at < ?`, [before]);
  }
}
