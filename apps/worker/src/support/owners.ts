/**
 * The way back in (M13).
 *
 * Support access lives in a table, and a table can be emptied by a bad afternoon. So the people who run
 * HandsFreeOS are named in the worker's settings as well, and every start makes sure they are support
 * admins. It adds and it promotes; it never takes anything away, and it says nothing when the address
 * belongs to nobody yet — Chris may be named here before he has ever signed in.
 */
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';

export async function ensurePlatformOwners(
  db: Db,
  emails: readonly string[],
  log: Logger,
): Promise<void> {
  if (emails.length === 0) return;
  try {
    const made = await asWorker(db, {}, (tx) =>
      rows<{ email: string }>(
        tx,
        sql`with named as (
              select u.id, u.email::text as email from app.users u
              where lower(u.email::text) = any (${emails}::text[]))
            insert into platform.staff (user_id, role, status, display_name)
            select n.id, 'admin', 'active', '' from named n
            on conflict (user_id) do update set role = 'admin', status = 'active', updated_at = now()
            returning (select email from named where named.id = platform.staff.user_id) as email`,
      ),
    );
    if (made.length > 0)
      log.info({ owners: made.map((m) => m.email) }, 'support admins confirmed from settings');
  } catch (e) {
    // Never a reason not to start: the desk still works for whoever is already staff.
    log.warn({ err: e }, 'could not confirm the support admins named in the settings');
  }
}
