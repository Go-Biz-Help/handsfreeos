import { HfosError } from '../errors';

// The list input schema (limit + opaque cursor) lives in schemas/crm.ts so browser code can use it.

export interface Cursor {
  /** The sort value of the last row on the page, serialized (ISO timestamp, number, or text). */
  readonly sort: string;
  readonly id: string;
}

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function fromBase64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function encodeCursor(c: Cursor): string {
  return toBase64Url(JSON.stringify([c.sort, c.id]));
}

/** Decodes a client cursor; a malformed one is a validation error, never a silent full scan. */
export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(value));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { sort: parsed[0], id: parsed[1] };
    }
  } catch {
    /* fall through */
  }
  throw listMovedOn();
}

/** A cursor that can't be read: the list starts again from the top. */
export const listMovedOn = (): HfosError =>
  HfosError.validation(
    [{ path: 'cursor', message: 'Start the list again from the top.' }],
    'This list can’t carry on from where it was. Refresh to start it again from the top.',
  );

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2})(?::?(\d{2}))?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A timestamp Postgres will cast: the shape, and every field in range (no 13th month, no 30 February). */
function isTimestamp(sort: string): boolean {
  const m = ISO_TIMESTAMP.exec(sort);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const day = new Date(0);
  day.setUTCFullYear(y, mo - 1, d);
  return (
    y >= 1 &&
    day.getUTCFullYear() === y &&
    day.getUTCMonth() === mo - 1 &&
    day.getUTCDate() === d &&
    h <= 23 &&
    mi <= 59 &&
    s <= 59 &&
    Number(m[9] ?? 0) <= 15 &&
    Number(m[10] ?? 0) <= 59
  );
}

/**
 * A cursor keyed on a timestamp column, for lists that compare `(column, id) < (${sort}::timestamptz, ${id}::uuid)`
 * so the column's index serves every page. The sort must be a real timestamp and the id a uuid: a tampered one is a
 * validation error, not a failed cast.
 */
export function decodeTimeCursor(value: string | undefined): Cursor | null {
  const cursor = decodeCursor(value);
  if (cursor && (!isTimestamp(cursor.sort) || !UUID.test(cursor.id))) throw listMovedOn();
  return cursor;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Fetch `limit + 1` rows, hand them here: returns one page and the cursor for the next when there is more. */
export function page<T>(
  rowsFetched: readonly T[],
  limit: number,
  keyOf: (item: T) => Cursor,
): Page<T> {
  const hasMore = rowsFetched.length > limit;
  const items = hasMore ? rowsFetched.slice(0, limit) : [...rowsFetched];
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null };
}
