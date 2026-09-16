/**
 * Reading a stored settings document forgivingly. Settings written by an older version of the app, half-saved,
 * or hand-edited must never stop a page from rendering: every field that doesn't pass falls back to its default
 * and the rest is kept. Never throws, as long as the schema has a default for every field.
 *
 * Used by the Action Center's settings and the money settings; the save path still validates strictly, so a
 * person is told what's wrong when they're the one changing it.
 */
import type { ZodType } from 'zod';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Removes the value at a path (or, when that isn't there, its nearest parent that is). */
function dropNearest(doc: Record<string, unknown>, path: readonly PropertyKey[]): boolean {
  for (let len = path.length; len > 0; len--) {
    let at: unknown = doc;
    for (const key of path.slice(0, len - 1)) {
      at = isPlainObject(at) ? at[key as string] : undefined;
    }
    const last = path[len - 1] as string;
    if (isPlainObject(at) && last in at) {
      delete at[last];
      return true;
    }
  }
  return false;
}

/** How many bad fields it will drop before giving up and returning the defaults. */
const ROUNDS = 25;

/** A stored document read field by field: what passes is kept, what doesn't falls back to its default. */
export function readForgiving<T>(schema: ZodType<T>, raw: unknown): T {
  const doc: Record<string, unknown> = isPlainObject(raw) ? JSON.parse(JSON.stringify(raw)) : {};
  for (let round = 0; round < ROUNDS; round++) {
    const result = schema.safeParse(doc);
    if (result.success) return result.data;
    let dropped = false;
    for (const issue of result.error.issues) dropped = dropNearest(doc, issue.path) || dropped;
    if (!dropped) break;
  }
  return schema.parse({});
}
