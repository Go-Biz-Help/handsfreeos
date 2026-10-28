/**
 * Events near the person on Alignable (../events-near.ts, docs/outreach.md decision 112), server side: whether this
 * week's read is due and which events were read lately, and the read noted. Each person's own. The hosts and guests an
 * event shows are saved as found by `outreach.finds.save` (./finds.ts). Server-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  EVENTS_EVERY_DAYS,
  EVENTS_KEPT_MOST,
  EventsNextInput,
  EventsNextOutput,
  EventsReadInput,
  EventsReadOutput,
} from '../events-near';
import { outreachAddon } from '../manifest';
import { eventReads } from '../tables';
import { inWorkspace } from './common';
import { startOfToday } from './tidy';

const DAY = 86_400_000;

export const eventsNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.events.next',
  description:
    'Whether the person’s computer reads the events in their town on Alignable today: once a week, the first time and then a week after the last read. With the events it read lately, which it never reads again.',
  input: EventsNextInput,
  output: EventsNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .select()
      .from(eventReads)
      .where(
        and(
          eq(eventReads.workspaceId, ctx.scope.workspaceId!),
          eq(eventReads.userId, me),
          eq(eventReads.platform, input.platform),
        ),
      );
    if (!row) return { due: true, read: [] };
    // By the business's days: read on a Monday, due again the next Monday whatever the hour.
    const dueFrom = (await startOfToday(ctx)).getTime() - (EVENTS_EVERY_DAYS - 1) * DAY;
    return { due: new Date(row.readAt).getTime() < dueFrom, read: row.urls };
  },
});

export const eventsRead = defineAddonCommand(outreachAddon, {
  name: 'outreach.events.read',
  description:
    'The person’s computer read the events in their town on Alignable this week: up to 5 not read before, whose hosts and guests went to the AI to check. Nothing on an event was pressed. The next read is a week on.',
  risk: 0,
  input: EventsReadInput,
  output: EventsReadOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const fresh = JSON.stringify([...new Set(input.urls)].slice(0, EVENTS_KEPT_MOST));
    // The newest first, then those read before that aren't again, up to the most kept.
    await ctx.tx.execute(
      sql`insert into addon_outreach.event_reads (workspace_id, user_id, platform, read_at, urls)
          values (${ctx.scope.workspaceId!}, ${me}, ${input.platform}, ${at.toISOString()}::timestamptz,
            array(select u from jsonb_array_elements_text(${fresh}::jsonb) with ordinality as sent (u, n)
              order by n))
          on conflict (workspace_id, user_id, platform) do update set
            read_at = excluded.read_at,
            urls = (excluded.urls || array(
              select u from unnest(addon_outreach.event_reads.urls) with ordinality as kept (u, n)
              where u <> all (excluded.urls) order by n))[1:${EVENTS_KEPT_MOST}],
            updated_at = excluded.read_at`,
    );
    return { readAt: at.toISOString() };
  },
});

export const eventsCommands = [eventsRead] as const;
export const eventsQueries = [eventsNext] as const;
