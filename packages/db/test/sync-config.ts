/**
 * Reads apps/sync/sync-config.yaml for the tests: its streams, their lookups (CTEs) and every query, with the
 * columns each selects and the filter each applies. The config keeps one query per line (a comment at its top says
 * why), which is what makes this reading possible without a YAML parser in the test's dependencies.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface SyncQuery {
  readonly stream: string;
  /** The source table in app. */
  readonly table: string;
  /** The table's alias in the query (AS …), if any: also the client table's name. */
  readonly alias: string | null;
  /** The client table its rows land in. */
  readonly output: string;
  /** Output column name → the source columns it is made from. */
  readonly select: ReadonlyMap<string, readonly string[]>;
  /** Output column name → its expression, as written. */
  readonly expressions: ReadonlyMap<string, string>;
  /** `INNER JOIN json_each(table.column) AS x INNER JOIN cte ON x.value = cte.column`, when it has one. */
  readonly join: { readonly arrayColumn: string; readonly cte: string } | null;
  readonly where: string;
  /** A stream's lookup rather than a query that sends rows. */
  readonly cte: boolean;
  /** For a lookup: its name. */
  readonly name: string | null;
  /** The whole query as written. */
  readonly text: string;
}

export const syncConfigFile = fileURLToPath(
  new URL('../../../apps/sync/sync-config.yaml', import.meta.url),
);

const KEYWORDS = new Set([
  'and',
  'or',
  'in',
  'is',
  'not',
  'null',
  'true',
  'false',
  'as',
  'inner',
  'join',
  'on',
]);

/** The source columns an expression reads: identifiers outside string literals, parameters and functions. */
export function identifiersOf(expression: string): string[] {
  return (
    expression
      .replace(/'[^']*'/g, ' ')
      .replace(/(auth\.user_id|subscription\.parameter|json_each)\s*\([^)]*\)/g, ' ')
      .match(/"?[a-z_][a-z0-9_]*"?(\.[a-z_][a-z0-9_]*)?/g) ?? []
  )
    .map((t) => t.replaceAll('"', ''))
    .map((t) => (t.includes('.') ? t.split('.')[1]! : t))
    .filter((t) => !KEYWORDS.has(t));
}

export function readSyncConfig(text = readFileSync(syncConfigFile, 'utf8')): {
  streams: string[];
  queries: SyncQuery[];
} {
  const streams: string[] = [];
  const queries: SyncQuery[] = [];
  let stream = '';
  let inStreams = false;
  for (const raw of text.split('\n')) {
    if (/^streams:\s*$/.test(raw)) inStreams = true;
    const header = /^ {2}([a-z0-9_]+):\s*$/.exec(raw);
    if (inStreams && header) {
      stream = header[1]!;
      streams.push(stream);
      continue;
    }
    const line = raw.trim();
    const m = /^(- |query: |([a-z_]+): )(SELECT .+)$/.exec(line);
    if (!m) continue;
    const cte = m[1] !== '- ' && m[1] !== 'query: ';
    const q =
      /^SELECT (.+?) FROM app\.([a-z_]+)(?: AS ([a-z_]+))?(?: INNER JOIN json_each\([a-z_]+\.([a-z_]+)\) AS [a-z_]+ INNER JOIN ([a-z_]+) ON .+?)?(?: WHERE (.+))?$/.exec(
        m[3]!,
      );
    if (!q) throw new Error(`Can't read this query: ${line}`);
    const select = new Map<string, string[]>();
    const expressions = new Map<string, string>();
    for (const item of q[1]!.split(/,\s*/).map((s) => s.trim())) {
      const alias = / AS ([a-z_]+)$/.exec(item);
      const expr = alias ? item.slice(0, alias.index) : item;
      const name = alias ? alias[1]! : identifiersOf(expr)[0]!;
      select.set(name, identifiersOf(expr));
      expressions.set(name, expr);
    }
    queries.push({
      stream,
      table: q[2]!,
      alias: q[3] ?? null,
      output: q[3] ?? q[2]!,
      select,
      expressions,
      join: q[4] ? { arrayColumn: q[4], cte: q[5]! } : null,
      where: q[6] ?? '',
      cte,
      name: cte ? m[2]! : null,
      text: m[3]!,
    });
  }
  return { streams, queries };
}
