/**
 * Notifications under the bell (20261027012600): what HandsFreeOS sent to a person's phones in the last 30 days,
 * newest first, from every business they're in, with how many are new. The web's bell reads it; the phone keeps its
 * own copy (me_v1).
 */
import { rows, sql } from '@hfos/db/client';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { decodeTimeCursor, encodeCursor } from '../kernel/pagination';
import { NotificationListInput, NotificationListOutput } from '../schemas/push';

type Row = {
  id: string;
  workspace_id: string | null;
  category: string;
  title: string;
  subtitle: string | null;
  body: string;
  path: string;
  alert_id: string | null;
  sent_at: string;
  seen_at: Date | string | null;
  read_at: Date | string | null;
};

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

export const notificationList = defineQuery({
  name: 'notification.list',
  description:
    'Your notifications: what HandsFreeOS sent to your phone in the last 30 days, newest first, from every business you’re in, and how many are new.',
  input: NotificationListInput,
  output: NotificationListOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const cursor = decodeTimeCursor(input.cursor);
    // Keyed on (sent_at, id) at full precision: two pushes can go in the same moment.
    const after = cursor
      ? sql`and (n.sent_at, n.id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const list = await rows<Row>(
      ctx.tx,
      sql`select n.id, n.workspace_id, n.category, n.title, n.subtitle, n.body, n.path,
            case when n.refs ->> 'alertId' ~ ${UUID} then n.refs ->> 'alertId' end as alert_id,
            to_char(n.sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sent_at, n.seen_at, n.read_at
          from app.notifications n
          where n.user_id = ${me} ${after}
          order by n.sent_at desc, n.id desc
          limit ${input.limit + 1}`,
    );
    const [count] = await rows<{ unseen: number }>(
      ctx.tx,
      sql`select count(*)::int as unseen from app.notifications n where n.user_id = ${me} and n.seen_at is null`,
    );
    const page = list.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      notifications: page.map((n) => ({
        id: n.id,
        workspaceId: n.workspace_id,
        category: n.category,
        title: n.title,
        subtitle: n.subtitle,
        body: n.body,
        path: n.path,
        alertId: n.alert_id,
        sentAt: new Date(n.sent_at).toISOString(),
        seenAt: iso(n.seen_at),
        readAt: iso(n.read_at),
      })),
      unseen: count?.unseen ?? 0,
      nextCursor:
        list.length > input.limit && last
          ? encodeCursor({ sort: last.sent_at, id: last.id })
          : null,
    };
  },
});

export const notificationQueries = [notificationList] as const;
