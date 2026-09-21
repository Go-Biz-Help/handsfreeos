/**
 * Records made with the id the phone gave them (M10), so what it adds for a customer created offline a minute
 * earlier can point at that customer. Creates that accept one (person, company, lead, task, activity, file,
 * and from M17 a form's answer sheet) look
 * for it first: already in this business, the create has happened before (a repeat whose receipt is long gone),
 * and the answer is that record, unchanged. An id taken by anything the person can't see is refused the same way
 * whoever holds it, and never says what or where, so no other business's row shows through.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { activities, companies, files, formResponses, leads, people, tasks } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { isUniqueViolation } from '../kernel/pg-errors';

const TABLES = { people, companies, leads, tasks, activities, files, formResponses } as const;
type TableName = keyof typeof TABLES;

/** The record with this id in this business, as the person sees it; null when there's none. */
export async function madeBefore<N extends TableName>(
  tx: Tx,
  table: N,
  id: string | undefined,
  workspaceId: string,
): Promise<(typeof TABLES)[N]['$inferSelect'] | null> {
  if (!id) return null;
  // Every one of these tables has an id and a workspace; one of them stands in for the type of the query.
  const t = TABLES[table] as unknown as typeof people;
  const [row] = await tx
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.workspaceId, workspaceId)));
  return (row as unknown as (typeof TABLES)[N]['$inferSelect'] | undefined) ?? null;
}

/** An id that can't be used: the same refusal whoever holds it. */
export const idUnavailable = (): HfosError =>
  HfosError.validation(
    [{ path: 'id', message: 'That id can’t be used. Make a new one.' }],
    'The app made an id for this that can’t be used.',
  );

/** Runs the insert; an id already taken beyond this person's sight is refused as unusable. */
export async function insertWithId<T>(
  table: TableName,
  id: string | undefined,
  insert: () => Promise<T>,
): Promise<T> {
  try {
    return await insert();
  } catch (e) {
    if (id && isUniqueViolation(e, `${table}_pkey`)) throw idUnavailable();
    throw e;
  }
}
