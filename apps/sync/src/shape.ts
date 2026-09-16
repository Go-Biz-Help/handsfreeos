/**
 * What each synced table looks like to a phone: the client tables every stream in sync-config.yaml fills, their
 * columns, and each column's type in the database. Two things read it:
 *   - the phone's contract (packages/core/test/mobile-contract.test.ts), which records every stream's tables so an
 *     old app build never finds a column gone or changed: a change like that means a new stream version instead;
 *   - the sync scenarios (apps/sync/test), whose Node client declares exactly these tables, as the app will.
 *
 * The config is read by the DB suite's own reader (packages/db/test/sync-config.ts), so both agree on every query.
 */
import { rows, sql, type Db } from '@hfos/db/client';
import { readSyncConfig } from '../../../packages/db/test/sync-config';

export { syncConfigFile } from '../../../packages/db/test/sync-config';

/** Stream names carry their version, so a change an old build can't take is a new stream beside the old one. */
export const VERSIONED_STREAM = /^[a-z][a-z0-9_]*_v[1-9]\d*$/;

export interface SyncedColumn {
  readonly name: string;
  /** The column of the source table it copies, or null when the stream makes it (a synthesized id). */
  readonly source: string | null;
  /** As written in the query. */
  readonly expression: string;
}

export interface SyncedTable {
  readonly stream: string;
  /** The client table on the phone (a query's alias, else its source table). */
  readonly table: string;
  /** The source table in app. */
  readonly sourceTable: string;
  readonly columns: readonly SyncedColumn[];
}

const PLAIN_COLUMN = /^(?:[a-z_][a-z0-9_]*\.)?"?([a-z_][a-z0-9_]*)"?$/;

/** Every stream's client tables and their columns, in the order the queries name them. */
export function syncedTableShapes(configText?: string): SyncedTable[] {
  const { queries } = readSyncConfig(configText);
  const tables = new Map<
    string,
    { stream: string; table: string; sourceTable: string; columns: Map<string, SyncedColumn> }
  >();
  for (const q of queries) {
    if (q.cte) continue;
    const key = `${q.stream}.${q.output}`;
    const entry = tables.get(key) ?? {
      stream: q.stream,
      table: q.output,
      sourceTable: q.table,
      columns: new Map<string, SyncedColumn>(),
    };
    for (const [name, expression] of q.expressions) {
      if (entry.columns.has(name)) continue;
      const plain = PLAIN_COLUMN.exec(expression.trim());
      if (!plain && !expression.includes('||'))
        throw new Error(
          `${key}.${name}: can't tell what type "${expression}" gives a phone. Teach apps/sync/src/shape.ts.`,
        );
      entry.columns.set(name, { name, source: plain ? plain[1]! : null, expression });
    }
    tables.set(key, entry);
  }
  return [...tables.values()]
    .map((t) => ({ ...t, columns: [...t.columns.values()] }))
    .sort((a, b) => `${a.stream}.${a.table}`.localeCompare(`${b.stream}.${b.table}`));
}

/** Streams whose names don't end in a version (`_v1`). */
export function unversionedStreams(configText?: string): string[] {
  return readSyncConfig(configText).streams.filter((s) => !VERSIONED_STREAM.test(s));
}

/** Every column of every table in app, as "table.column" → its type (without length limits: widening one is safe). */
export async function appColumnTypes(db: Db): Promise<Map<string, string>> {
  const found = await rows<{ table_name: string; column_name: string; type: string }>(
    db,
    sql`select c.relname as table_name, a.attname as column_name, format_type(a.atttypid, null) as type
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`,
  );
  return new Map(found.map((r) => [`${r.table_name}.${r.column_name}`, r.type]));
}

/** A column's type as a phone gets it: a synthesized value is text; a copied column has its database type. */
function typeOf(table: SyncedTable, column: SyncedColumn, types: Map<string, string>): string {
  if (column.source === null) return 'text';
  const type = types.get(`${table.sourceTable}.${column.source}`);
  if (!type)
    throw new Error(
      `${table.stream}.${table.table}.${column.name}: app.${table.sourceTable} has no column ${column.source}`,
    );
  return type;
}

export interface TableContract {
  readonly columns: Readonly<Record<string, string>>;
}

/** The contract's `tables`: "stream.table" → its columns and their database types. */
export async function syncedTables(
  db: Db,
  configText?: string,
): Promise<Record<string, TableContract>> {
  const types = await appColumnTypes(db);
  return Object.fromEntries(
    syncedTableShapes(configText).map((t) => [
      `${t.stream}.${t.table}`,
      { columns: Object.fromEntries(t.columns.map((c) => [c.name, typeOf(t, c, types)])) },
    ]),
  );
}

/** The SQLite type PowerSync gives a database type on the phone (docs: sync/types). */
export function sqliteTypeOf(type: string): 'text' | 'integer' | 'real' {
  if (type.endsWith('[]')) return 'text';
  if (['smallint', 'integer', 'bigint', 'boolean'].includes(type)) return 'integer';
  if (['real', 'double precision'].includes(type)) return 'real';
  return 'text';
}

/** Every client table a phone declares, across all streams: its columns (apart from id) and their SQLite types. */
export async function clientTables(
  db: Db,
  configText?: string,
): Promise<Map<string, Map<string, 'text' | 'integer' | 'real'>>> {
  const types = await appColumnTypes(db);
  const out = new Map<string, Map<string, 'text' | 'integer' | 'real'>>();
  for (const t of syncedTableShapes(configText)) {
    const columns = out.get(t.table) ?? new Map<string, 'text' | 'integer' | 'real'>();
    for (const c of t.columns)
      if (c.name !== 'id') columns.set(c.name, sqliteTypeOf(typeOf(t, c, types)));
    out.set(t.table, columns);
  }
  return out;
}
