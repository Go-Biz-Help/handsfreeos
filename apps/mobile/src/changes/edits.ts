/**
 * Edits made on the phone send only what the person changed, each with the value they saw (`base`), so a teammate's
 * later change to another detail is never written back over, and the newest change to each detail wins. Tags go on
 * and come off one at a time. The same rules as the web's edit dialogs (`apps/web/src/lib/api/edits.ts`).
 */

/**
 * The details that changed between what the screen opened with and what it saves, with what the person saw of each.
 * Both sides as they'd be saved (trimmed, empty as null). A key with no `base` given sends none.
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
export const orNull = (value: string): string | null => value.trim() || null;

export interface TagRef {
  readonly workspaceId: string;
  readonly recordType: 'person' | 'company' | 'lead';
  readonly recordId: string;
}

/** The tag changes between the tags a screen opened with and the ones chosen: each its own change. */
export function tagChanges(
  ref: TagRef,
  before: readonly string[],
  after: readonly string[],
): {
  readonly name: 'record.add_tag' | 'record.remove_tag';
  readonly input: TagRef & { tagId: string };
}[] {
  const had = new Set(before);
  const has = new Set(after);
  return [
    ...after
      .filter((tagId) => !had.has(tagId))
      .map((tagId) => ({ name: 'record.add_tag' as const, input: { ...ref, tagId } })),
    ...before
      .filter((tagId) => !has.has(tagId))
      .map((tagId) => ({ name: 'record.remove_tag' as const, input: { ...ref, tagId } })),
  ];
}
