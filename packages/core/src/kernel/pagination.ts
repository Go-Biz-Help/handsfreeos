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
  throw HfosError.validation([{ path: 'cursor', message: 'Invalid cursor.' }]);
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
