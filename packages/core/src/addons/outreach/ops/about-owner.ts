/**
 * What a person said of themselves on Settings → Account (About you, docs/outreach.md decision 165), for the worker
 * that writes as them: `<about_owner>` in ../about-owner.ts. The words are theirs alone (app.user_about): the worker
 * reads them only for the people of the business it is scoped to, and only to write as that person.
 */
import { rows, sql, type Tx } from '@hfos/db/client';

/** Their own words, or null with nothing said. */
export async function aboutOwnerFor(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await rows<{ about: string }>(
    tx,
    sql`select about from app.user_about where user_id = ${userId}`,
  );
  return row?.about.trim() || null;
}
