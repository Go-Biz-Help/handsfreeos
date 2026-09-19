/**
 * The way back in (M13).
 *
 * Support access lives in a table, and a table can be emptied by a bad afternoon. So the people who run
 * HandsFreeOS are named in the worker's settings as well, and every start makes sure they are support
 * admins. It adds and it promotes; it never takes anything away.
 *
 * The work itself is a database function (0071). The worker holds no business in scope while it starts, and
 * "every user on the platform" is not a question a tenant-scoped reader may ask — so it is asked by
 * something that says plainly that it may ask it, rather than by a query that would quietly find nobody.
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
    const [row] = await asWorker(db, {}, (tx) =>
      rows<{ made: number }>(
        tx,
        sql`select private.confirm_platform_owners(array[${sql.join(
          emails.map((e) => sql`${e}`),
          sql`, `,
        )}]::text[]) as made`,
      ),
    );
    const made = Number(row?.made ?? 0);
    if (made > 0) log.info({ made, owners: emails }, 'support admins confirmed from settings');
    // Naming somebody who has not signed up yet is allowed — Chris may be here before his account is. It
    // says so out loud, because the silent version of this is an afternoon spent wondering.
    else
      log.warn(
        { owners: emails },
        'no HandsFreeOS account matches PLATFORM_OWNER_EMAILS yet, so nobody was made a support admin',
      );
  } catch (e) {
    // Never a reason not to start: the desk still works for whoever is already staff.
    log.warn({ err: e }, 'could not confirm the support admins named in the settings');
  }
}
