import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCAL_TABLES } from '@/changes/tables';

import { syncedTables } from '../schema';

/**
 * Every piece of SQL the app runs, checked against what the phone actually has.
 *
 * **The phone's copy is SQLite, and a query it can't answer doesn't say so.** A function SQLite doesn't have, or a
 * column the Sync Streams don't carry, makes PowerSync's live query return nothing — no error anywhere a screen
 * would notice. Money read "No invoices yet" on a phone holding six invoices (`btrim`, which is Postgres's), and an
 * appointment showed no customer on a visit that had one (`appointment_attendees.reminder_state`, which isn't in the
 * stream). Both shipped in step 16 and both were invisible until a screenshot.
 *
 * So this reads the app's own source rather than a list someone has to remember to add to: every screen's SQL is
 * covered the day it lands, whoever writes it.
 */

const SRC = join(__dirname, '..', '..');

/** Every `.ts` and `.tsx` under `src`, tests aside. */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__'));
}

/** The string and template literals in a file that read like SQL. */
function statements(text: string): string[] {
  const out: string[] = [];
  for (const [literal] of text.matchAll(/`[^`]*`|'[^'\n]*'/g)) {
    const sql = literal.slice(1, -1);
    if (/\bselect\b[\s\S]*\bfrom\b/i.test(sql) || /^\s*(insert|update|delete)\s+/i.test(sql))
      out.push(sql);
  }
  return out;
}

const SQL: (readonly [string, string])[] = sources().flatMap((file) =>
  statements(readFileSync(join(SRC, file), 'utf8')).map(
    (sql, i) => [`${file} #${i + 1}`, sql] as const,
  ),
);

/** Postgres's own, with the SQLite word to use instead. */
const POSTGRES_ONLY: readonly (readonly [RegExp, string])[] = [
  [/\bbtrim\s*\(/i, 'trim('],
  [/\bilike\b/i, 'lower(x) LIKE lower(y)'],
  [/::[a-z]/i, 'nothing at all — a synced column is already text'],
  [/\bnow\s*\(\s*\)/i, 'a parameter carrying the moment'],
  [/\bstring_agg\s*\(/i, 'group_concat('],
  [/\bcardinality\s*\(/i, 'json_array_length('],
  [/\bgreatest\s*\(/i, 'max('],
  [/\bleast\s*\(/i, 'min('],
  [/\bany\s*\(/i, 'IN (…)'],
  [/\binterval\s+'/i, 'a parameter carrying the moment'],
  [/\bcurrent_(date|timestamp)\b/i, 'a parameter carrying the moment'],
];

const TABLES: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({ ...syncedTables, ...LOCAL_TABLES }).map(([name, table]) => [
    name,
    new Set(['id', ...table.columns.map((c) => c.name)]),
  ]),
);

/** What follows a table name without being its alias. */
const KEYWORDS = new Set([
  'where',
  'on',
  'join',
  'left',
  'inner',
  'order',
  'group',
  'union',
  'limit',
  'set',
  'values',
]);

/** `FROM people p`, `JOIN users u ON …`, `FROM outbox` — the tables a query reads, by the alias it calls them. */
export function aliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const source =
    /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z][a-z0-9_]*))?/gi;
  for (const [, table, alias] of sql.matchAll(source)) {
    const name = table!.toLowerCase();
    if (!TABLES[name]) continue;
    out.set(alias && !KEYWORDS.has(alias.toLowerCase()) ? alias.toLowerCase() : name, name);
  }
  return out;
}

/** The two checks themselves, so a scan that quietly stops catching anything is caught. */
const postgresOnlyIn = (sql: string): string[] =>
  POSTGRES_ONLY.filter(([pattern]) => pattern.test(sql)).map(([pattern]) => String(pattern));

const missingColumnsIn = (sql: string): string[] => {
  const byAlias = aliases(sql);
  const missing: string[] = [];
  for (const [, alias, column] of sql.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g)) {
    const table = byAlias.get(alias!.toLowerCase());
    if (table && !TABLES[table]!.has(column!)) missing.push(`${table}.${column}`);
  }
  return missing;
};

describe('the SQL the app runs on the phone’s copy', () => {
  it('catches the two mistakes step 16 shipped', () => {
    // Money's list, as it first went out: `btrim` is Postgres's, and SQLite answered nothing at all.
    expect(
      postgresOnlyIn("SELECT nullif(btrim(p.first_name), '') FROM people p WHERE p.id = ?"),
    ).toHaveLength(1);
    // The appointment's seats, as they first went out: the stream doesn't carry `reminder_state`.
    expect(
      missingColumnsIn('SELECT t.id, t.reminder_state FROM appointment_attendees t WHERE t.id = ?'),
    ).toEqual(['appointment_attendees.reminder_state']);
    // And it leaves a good query alone.
    expect(postgresOnlyIn('SELECT trim(p.first_name) FROM people p')).toEqual([]);
    expect(missingColumnsIn('SELECT t.id, t.status FROM appointment_attendees t')).toEqual([]);
  });

  it('is found in more than a handful of files, so the scan is worth something', () => {
    expect(SQL.length).toBeGreaterThan(40);
    expect(new Set(SQL.map(([where]) => where.split(' #')[0])).size).toBeGreaterThan(6);
  });

  it.each(SQL)('%s uses nothing SQLite doesn’t have', (_where, sql) => {
    expect({ sql, found: postgresOnlyIn(sql) }).toMatchObject({ found: [] });
  });

  it.each(SQL)('%s names only columns the phone’s copy has', (_where, sql) => {
    expect({ sql, missing: missingColumnsIn(sql) }).toMatchObject({ missing: [] });
  });
});
