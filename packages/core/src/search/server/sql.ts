/**
 * The SQL search's searchers share (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The searchers"), written once.
 *
 * Every read runs as the person under row security, so these only add what row security leaves open, and filter
 * roughly: core's JavaScript ranks what comes back. No condition here asks for a text index: under row security a
 * condition only reaches an index through a leakproof function, and LIKE isn't one (How it works, 2).
 */
import { sql, type SQL } from 'drizzle-orm';
import { barePrefix, type DocumentNumberProbe } from '../../money/numbering';
import { CONTACT_LINES } from '../lines';

/**
 * A customer search may show: not in the Deleted bin, not the name a deleted customer's bills keep, and not the shell
 * a merge leaves. Row security still shows all three (20261027000400), so every read of `app.people` in search adds it.
 */
export const LIVE_PERSON = (alias: string): SQL => {
  const p = sql.raw(alias);
  return sql`(${p}.bin_item_id is null and ${p}.erased_at is null and ${p}.merged_into_id is null)`;
};

/**
 * A line hanging off a record of the business's own kinds reads only when that record does. Tasks, notes, files,
 * appointments and conversations check only sealing, while `custom_records_select` also hides a turned-off add-on's
 * kinds, so each of those reads asks the record itself.
 */
export const RECORD_READS = (column: SQL): SQL =>
  sql`(${column} is null or exists (select 1 from app.custom_records rr where rr.id = ${column}))`;

/**
 * A real Postgres array. Interpolating a list spreads it into one parameter each, which Postgres reads as a row, so
 * the knowledge and money queries build theirs the same way.
 */
export const textArray = (values: readonly string[]): SQL =>
  values.length
    ? sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;

/**
 * Every pattern matches `expr`. With no patterns it is false, never true: `x like all ('{}')` holds for everything,
 * so "--" or "@@" can never match a whole business.
 */
export const likeAll = (expr: SQL, patterns: readonly string[]): SQL =>
  patterns.length ? sql`(${expr} like all (${textArray(patterns)}))` : sql`false`;

/** Accents folded as core folds them (search/fold.ts), the same length as the text. */
export const folded = (expr: SQL): SQL => sql`private.search_fold(${expr})`;

/**
 * A name's words start with every typed word: `' ' || fname like all ('% word%')`. It takes the name already folded,
 * the lateral's `fname`, so a row's name is folded once for every arm that reads it: an accented name costs about
 * 40 µs a fold (stage 1's note), and Postgres doesn't share one fold between two calls.
 */
export const startsAll = (foldedName: SQL, starts: readonly string[]): SQL =>
  likeAll(sql`(' ' || ${foldedName})`, starts);

/**
 * A stored document number is the one typed: the whole of it, or the same counter under the same prefix (a bare
 * number under any), the prefixes compared by their letters and digits alone. Core's `documentNumberMatches` makes
 * the same test on the same strings. A draft has no number.
 */
export const numberMatches = (column: SQL, probe: DocumentNumberProbe | null): SQL => {
  if (!probe) return sql`false`;
  const number = sql`lower(coalesce(${column}, ''))`;
  const whole = sql`${number} = ${probe.text}`;
  if (!probe.counter) return sql`(${whole})`;
  const counter = sql`ltrim(substring(${number} from '[0-9]+$'), '0') = ${probe.counter}`;
  const bare = barePrefix(probe.prefix);
  const prefix =
    bare === ''
      ? sql`true`
      : sql`regexp_replace(regexp_replace(${number}, '[0-9]+$', ''), '[^a-z0-9]', '', 'g') = ${bare}`;
  return sql`(${whole} or (${counter} and ${prefix}))`;
};

/** The digits of a text, for typed digits found inside a number whatever its punctuation. */
export const digitsOf = (expr: SQL): SQL =>
  sql`regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g')`;

/** A real uuid[] parameter, the same way as `textArray`. */
export const uuidArray = (ids: readonly string[]): SQL =>
  ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[]`
    : sql`array[]::uuid[]`;

/**
 * Archived records in a search: in the box and on the page they come back only by their name or title, to go under
 * Archived; with Include archived they fold into their kind; a kind's own page leaves them out unless asked; and the
 * Archived page lists only them, by name or title.
 */
export function archivedRule(
  plan: {
    readonly mode: 'everything' | 'kind';
    readonly includeArchived: boolean;
    readonly archivedOnly: boolean;
  },
  column: SQL,
  byName: SQL,
): SQL {
  if (plan.archivedOnly) return sql`(${column} is not null and ${byName})`;
  if (plan.includeArchived) return sql`true`;
  if (plan.mode === 'kind') return sql`${column} is null`;
  return sql`(${column} is null or ${byName})`;
}

/** The timeline lines that count as being in touch with someone (`CONTACT_LINES`), for an activity aliased `alias`. */
export const contactLines = (alias: string): SQL => {
  const a = sql.raw(alias);
  return sql`(${a}.kind::text = any(${textArray(CONTACT_LINES.kinds)})
    or (${a}.kind = 'system' and ${a}.subtype = any(${textArray(CONTACT_LINES.bookedSubtypes)})))`;
};

/** A window's size: the newest rows it reads at most, and how far back it may reach (null: as far as its rows go). */
export interface WindowSize {
  readonly rows: number;
  readonly days: number | null;
}

/**
 * The windows long text is matched in (How it works, 3): the box's (quick), and the Search page's and a kind's own
 * page's (full). Every business fits wholly in the full windows today.
 */
export const SEARCH_WINDOWS = {
  messages: { quick: { rows: 4_000, days: 180 }, full: { rows: 25_000, days: 1_095 } },
  threads: { quick: { rows: 3_000, days: 180 }, full: { rows: 20_000, days: 1_095 } },
  calls: { quick: { rows: 2_000, days: 180 }, full: { rows: 10_000, days: 1_095 } },
  notes: { quick: { rows: 3_000, days: null }, full: { rows: 20_000, days: null } },
  answers: { quick: { rows: 3_000, days: null }, full: { rows: 20_000, days: null } },
} as const satisfies Record<string, Record<'quick' | 'full', WindowSize>>;

/** One window as a search reads it: its rows, the earliest it reaches, and where Look further back starts it. */
export interface SearchWindow {
  readonly rows: number;
  readonly since: string | null;
  readonly before: string | null;
}

const DAY_MS = 86_400_000;

/** A window for a search: its size at the search's depth, reaching back from now, or from `before`. */
export function windowOf(
  plan: { readonly depth: 'quick' | 'full'; readonly before: string | null },
  which: keyof typeof SEARCH_WINDOWS,
  now = Date.now(),
): SearchWindow {
  const size: WindowSize = SEARCH_WINDOWS[which][plan.depth];
  const from = plan.before ? Date.parse(plan.before) : now;
  return {
    rows: size.rows,
    since: size.days === null ? null : new Date(from - size.days * DAY_MS).toISOString(),
    before: plan.before,
  };
}

/** Rows at or before where Look further back starts the window, for its own read and for the matching rows. */
export const upTo = (w: SearchWindow, at: SQL): SQL =>
  w.before ? sql`and ${at} <= ${w.before}::timestamptz` : sql``;

/**
 * A time as the windows and the thread's links hand it back: ISO, to the microsecond, so the next window starts
 * exactly where this one ended, and a thread opened up to a message includes it.
 */
export const isoMicros = (at: SQL): SQL =>
  sql`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * A statement over a window: the business's newest rows, bounded by count and by time, read through a btree on
 * (business, time); the words are a filter over that window only (How it works, 2).
 *
 * `times` is the window's own read, `select <time> as at from <table> where <business> <upTo> order by <its index's
 * order>`, which this cuts at one row more than the window holds: if that row is there, the window ends at its time,
 * and rows sharing that time are left whole for the next window (a form response's answers share theirs). `hits`
 * reads the matching rows, with `inWindow(<time>)` keeping them inside it. Each row comes back with
 * `window_complete` and `window_reach` (read by `reachOf`); with no match, one row holds them alone, its other
 * columns null.
 */
export function windowed(
  w: SearchWindow,
  times: SQL,
  hits: (inWindow: (at: SQL) => SQL) => SQL,
): SQL {
  // Under row security a condition bounds an index scan only when every function in it is leakproof, and the
  // planner counts coalesce and greatest as leaky. So the edge is worked out whole in `reach` and reaches the
  // matching rows as an init plan, a bare parameter to the planner: `at > $edge` then bounds their index scan,
  // where any other form of it filters every row of the business.
  const inWindow = (at: SQL) => sql`${at} > (select reach.edge from reach) ${upTo(w, at)}`;
  return sql`with win as materialized (
        select count(*)::int as n, min(t.at) as oldest from (${times} limit ${w.rows + 1}) t
      ), reach as materialized (
        select coalesce(greatest(${w.since}::timestamptz, case when win.n > ${w.rows} then win.oldest end),
            '-infinity'::timestamptz) as edge,
          (win.n <= ${w.rows} and (${w.since}::timestamptz is null or win.oldest is null
            or win.oldest > ${w.since}::timestamptz)) as complete
        from win
      )
      select reach.complete as window_complete,
        case when reach.edge > '-infinity'::timestamptz then ${isoMicros(sql`reach.edge`)} end as window_reach, h.*
      from reach
      left join (${hits(inWindow)}) h on true`;
}

/** What a windowed statement's rows say about its window. */
export interface WindowRow extends Record<string, unknown> {
  window_complete: boolean;
  window_reach: string | null;
}

/** Whether a window looked at everything, and, when it didn't, how far back it went (Look further back's `before`). */
export function reachOf(rows: readonly WindowRow[]): {
  complete: boolean;
  searchedBack: string | null;
} {
  const r = rows[0];
  if (!r || r.window_complete) return { complete: true, searchedBack: null };
  return { complete: false, searchedBack: r.window_reach };
}

/** Several windows of one kind together: complete only if every one is, back only as far as the shallowest. */
export function reachOfAll(
  reaches: readonly { complete: boolean; searchedBack: string | null }[],
): { complete: boolean; searchedBack: string | null } {
  const cut = reaches.filter((r) => !r.complete);
  if (!cut.length) return { complete: true, searchedBack: null };
  // ISO times to the microsecond, all the same length, so the latest sorts last.
  const backs = cut.map((r) => r.searchedBack).filter((b): b is string => !!b);
  return { complete: false, searchedBack: backs.sort().pop() ?? null };
}

/** How much of a long text a found row carries: from a little before its first match, about a snippet and a half. */
export const STRETCH = { before: 100, length: 320 } as const;

/**
 * The stretch of a long text a found row carries, cut in SQL (`substr` around `strpos`), so a row never carries a
 * whole body: `<name>` itself, and `<name>_cut_before` and `<name>_cut_after` for the "…" core puts where it was cut
 * (`stretchSnippet`). `firstWord` is lower-cased as typed, since long text isn't folded (decision 23).
 */
export function stretchOf(column: SQL, firstWord: string | null, name: string): SQL {
  const from = firstWord
    ? sql`greatest(1, strpos(lower(${column}), ${firstWord}) - ${STRETCH.before})`
    : sql`1`;
  return sql`substr(${column}, ${from}, ${STRETCH.length}) as ${sql.raw(name)},
    (${from} > 1) as ${sql.raw(`${name}_cut_before`)},
    (${from} + ${STRETCH.length} <= char_length(${column})) as ${sql.raw(`${name}_cut_after`)}`;
}
