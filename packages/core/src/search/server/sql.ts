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
