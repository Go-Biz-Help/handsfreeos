/**
 * Notifications under the bell (20261027012600): every push a person's phones were handed is kept for them for 30
 * days, and the bell beside Ask HandsFreeOS lists them, on the phone and on the web. Opening the bell marks what it
 * showed as seen, so its count leaves them out (`notification.seen`); pressing one, in the bell or as the push itself,
 * marks it read (`notification.read`). Both are the person's own and change nothing anyone else sees: no event, and
 * both are safe to send again.
 */
import { rows, sql } from '@hfos/db/client';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  NotificationReadInput,
  NotificationReadOutput,
  NotificationSeenInput,
  NotificationSeenOutput,
} from '../schemas/push';

const account = () => ({ kind: 'account' as const });

const uuids = (ids: readonly string[]) =>
  ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`
    : sql`array[]::uuid[]`;

export const notificationSeen = defineCommand({
  name: 'notification.seen',
  description:
    'Note that you opened your notifications, so the bell stops counting the ones you saw. Ones that came in after stay new.',
  risk: 0,
  input: NotificationSeenInput,
  output: NotificationSeenOutput,
  permission: null,
  scope: account,
  // What somebody has seen is theirs alone, and nothing else changes: no event, and no receipt (a repeat does nothing).
  receipt: false,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    // To the millisecond the bell was given (a list's times are ISO strings, which stop there).
    const upTo = input.upTo
      ? sql`and n.sent_at < ${input.upTo}::timestamptz + interval '1 millisecond'`
      : sql``;
    const seen = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.notifications n set seen_at = now()
          where n.user_id = ${me} and n.seen_at is null ${upTo}
          returning n.id`,
    );
    return { seen: seen.length };
  },
});

export const notificationRead = defineCommand({
  name: 'notification.read',
  description:
    'Mark notifications as opened: the ones you pressed in the bell, or the pushes you pressed on your phone.',
  risk: 0,
  input: NotificationReadInput,
  output: NotificationReadOutput,
  permission: null,
  scope: account,
  receipt: false,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const read = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.notifications n set read_at = now(), seen_at = coalesce(n.seen_at, now())
          where n.user_id = ${me} and n.read_at is null
            and (n.id = any (${uuids(input.ids ?? [])}) or n.push_id = any (${uuids(input.pushIds ?? [])}))
          returning n.id`,
    );
    return { read: read.length };
  },
});

export const notificationCommands = [notificationSeen, notificationRead] as const;
