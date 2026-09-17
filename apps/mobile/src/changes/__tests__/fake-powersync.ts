import { DatabaseSync } from 'node:sqlite';

import type { Table } from '@powersync/common';

import { AppSchema } from '@/sync/app-schema';

import type { CrudTransactionLike, OutboxDb, SqlRunner } from '../outbox';

/**
 * PowerSync's database as the queue uses it, on real SQLite (Node's own): every table in the app's schema, the
 * local-only ones stored and never uploaded, `commands` insert-only (an insert goes straight to the upload queue and
 * isn't kept), and changes to synced tables recorded in the upload queue with the transaction they were made in. The
 * upload queue gives one transaction at a time, oldest first, and completing it removes it and everything before it.
 * Writes take turns, as PowerSync's one write connection does.
 */
export class FakePowerSync implements OutboxDb {
  readonly sqlite = new DatabaseSync(':memory:');
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private inTransaction = false;

  constructor() {
    const s = this.sqlite;
    s.exec(`CREATE TABLE ps_crud (id INTEGER PRIMARY KEY AUTOINCREMENT, tx_id INTEGER, data TEXT)`);
    s.exec(`CREATE TABLE ps_tx (current INTEGER)`);
    s.exec(`INSERT INTO ps_tx (current) VALUES (0)`);
    for (const table of AppSchema.tables as Table[]) {
      const name = table.name;
      const columns = table.columns.map((c) => c.name);
      if (table.insertOnly) {
        s.exec(
          `CREATE VIEW ${name} AS SELECT NULL AS id, ${columns.map((c) => `NULL AS ${c}`).join(', ')} WHERE 0`,
        );
        s.exec(`CREATE TRIGGER ${name}_insert INSTEAD OF INSERT ON ${name} BEGIN
          INSERT INTO ps_crud (tx_id, data) VALUES ((SELECT current FROM ps_tx),
            json_object('op', 'PUT', 'type', '${name}', 'id', NEW.id,
              'data', json_object(${columns.map((c) => `'${c}', NEW.${c}`).join(', ')})));
        END`);
        continue;
      }
      const typed = table.columns.map((c) => `${c.name} ${c.type ?? ''}`);
      s.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ${typed.join(', ')})`);
      if (table.localOnly) continue;
      const op = (kind: string, row: 'NEW' | 'OLD') =>
        `INSERT INTO ps_crud (tx_id, data) VALUES ((SELECT current FROM ps_tx),
           json_object('op', '${kind}', 'type', '${name}', 'id', ${row}.id))`;
      s.exec(`CREATE TRIGGER ${name}_put AFTER INSERT ON ${name} BEGIN ${op('PUT', 'NEW')}; END`);
      s.exec(
        `CREATE TRIGGER ${name}_patch AFTER UPDATE ON ${name} BEGIN ${op('PATCH', 'NEW')}; END`,
      );
      s.exec(
        `CREATE TRIGGER ${name}_delete AFTER DELETE ON ${name} BEGIN ${op('DELETE', 'OLD')}; END`,
      );
    }
  }

  private runner(): SqlRunner {
    return {
      execute: async (sql, params = []) => this.run(sql, params),
      getAll: async <T>(sql: string, params: unknown[] = []) => this.all<T>(sql, params),
      getOptional: async <T>(sql: string, params: unknown[] = []) =>
        (this.all<T>(sql, params)[0] ?? null) as T | null,
    };
  }

  private args(params: unknown[]) {
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p)) as (
      string | number | null
    )[];
  }

  private run(sql: string, params: unknown[]) {
    const result = this.sqlite.prepare(sql).run(...this.args(params));
    return { rowsAffected: Number(result.changes) };
  }

  private all<T>(sql: string, params: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...this.args(params)) as T[];
  }

  /** Runs writes one after another. */
  private write<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(work, work);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    if (/^\s*(select|with)\b/i.test(sql)) return { rows: this.all(sql, params) };
    return this.write(async () => {
      this.sqlite.exec('UPDATE ps_tx SET current = current + 1');
      const result = this.run(sql, params);
      this.notify();
      return result;
    });
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.all<T>(sql, params);
  }

  async getOptional<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.all<T>(sql, params)[0] ?? null) as T | null;
  }

  writeTransaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.write(async () => {
      if (this.inTransaction) throw new Error('A write transaction is already open.');
      this.inTransaction = true;
      this.sqlite.exec('BEGIN IMMEDIATE');
      this.sqlite.exec('UPDATE ps_tx SET current = current + 1');
      try {
        const result = await callback(this.runner());
        this.sqlite.exec('COMMIT');
        this.notify();
        return result;
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        this.inTransaction = false;
      }
    });
  }

  async getNextCrudTransaction(): Promise<CrudTransactionLike | null> {
    const first = this.sqlite.prepare('SELECT id, tx_id FROM ps_crud ORDER BY id LIMIT 1').get() as
      { id: number; tx_id: number } | undefined;
    if (!first) return null;
    const rows = this.sqlite
      .prepare('SELECT id, data FROM ps_crud WHERE tx_id = ? ORDER BY id')
      .all(first.tx_id) as { id: number; data: string }[];
    const last = rows[rows.length - 1]!.id;
    return {
      crud: rows.map((row) => {
        const entry = JSON.parse(row.data) as {
          op: string;
          type: string;
          id: string;
          data?: Record<string, unknown>;
        };
        return { id: entry.id, table: entry.type, op: entry.op, opData: entry.data };
      }),
      complete: () =>
        this.write(async () => {
          this.sqlite.prepare('DELETE FROM ps_crud WHERE id <= ?').run(last);
        }),
    };
  }

  onChange(handler: { onChange: () => void | Promise<void> }): () => void {
    const listener = () => void handler.onChange();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What waits in the upload queue: each entry's table and id, oldest first. */
  queue(): { table: string; id: string; op: string }[] {
    return (
      this.sqlite.prepare('SELECT data FROM ps_crud ORDER BY id').all() as { data: string }[]
    ).map((row) => {
      const entry = JSON.parse(row.data) as { type: string; id: string; op: string };
      return { table: entry.type, id: entry.id, op: entry.op };
    });
  }

  /** Rows of a table, straight from SQLite. */
  rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.all<T>(sql, params);
  }
}
