'use client';
import { apiBrowser, unwrap } from './client';

/**
 * What an edit dialog sends (M10): only the details the person changed, each with the value the dialog opened
 * with (`base`). A dialog left open while someone else (or a phone that was offline) changed other details never
 * writes its old values back, and the server keeps the newest change to each detail.
 *
 * Both sides are given as the dialog would save them (trimmed, empty as null). A key whose `base` isn't given
 * sends none.
 */
export function editedOnly<T extends Record<string, unknown>>(
  opened: T,
  now: T,
  base: Partial<T> = opened,
): { readonly changes: Partial<T>; readonly base: Partial<T>; readonly any: boolean } {
  const changes: Partial<T> = {};
  const seen: Partial<T> = {};
  for (const key of Object.keys(now) as (keyof T)[]) {
    if (JSON.stringify(now[key] ?? null) === JSON.stringify(opened[key] ?? null)) continue;
    changes[key] = now[key];
    if (key in base) seen[key] = base[key];
  }
  return { changes, base: seen, any: Object.keys(changes).length > 0 };
}

/** A text field as it's saved: trimmed, and empty as nothing. */
export const orNull = (v: string): string | null => v.trim() || null;

/**
 * Tags are put on and taken off one at a time (record.add_tag, record.remove_tag), so two people tagging the same
 * customer both land. Changes only what differs between the tags the dialog opened with and the ones chosen.
 */
export async function saveTagChanges(
  workspaceId: string,
  recordType: 'person' | 'company' | 'lead',
  recordId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<boolean> {
  const had = new Set(before);
  const has = new Set(after);
  const ref = { workspaceId, recordType, recordId };
  let changed = false;
  for (const tagId of after.filter((id) => !had.has(id))) {
    unwrap(await apiBrowser().POST('/v1/commands/record.add_tag', { body: { ...ref, tagId } }));
    changed = true;
  }
  for (const tagId of before.filter((id) => !has.has(id))) {
    unwrap(await apiBrowser().POST('/v1/commands/record.remove_tag', { body: { ...ref, tagId } }));
    changed = true;
  }
  return changed;
}
