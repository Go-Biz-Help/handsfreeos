/**
 * Events near the person (../events-near.ts, docs/outreach.md decisions 112 and 188), server side: whether this week's
 * read is due on each network, which events were read lately, and the read noted with what each event showed. Each
 * person's own.
 *
 * - On Alignable an event's hosts and guests are saved as found by `outreach.finds.save` (./finds.ts).
 * - On Facebook they're kept with the event (`event_people`): those who aren't friends are checked by the AI like
 *   friends (`outreach.checks.next`, ./checks.ts), and Today offers the good fits a friend request (./today.ts).
 * - Today lists the events coming up (`todayEvents`), and Not going puts one aside (`outreach.event.skip`).
 *
 * Server-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  EVENTS_AHEAD_DAYS,
  EVENTS_EVERY_DAYS,
  EVENTS_KEPT_MOST,
  EVENTS_TODAY_MOST,
  EVENTS_UNDATED_DAYS,
  EventSkipInput,
  EventSkipOutput,
  EventsNextInput,
  EventsNextOutput,
  EventsReadInput,
  EventsReadOutput,
  eventSearches,
  type EventPlatform,
  type TodayEvent,
} from '../events-near';
import { outreachAddon } from '../manifest';
import { eventReads } from '../tables';
import { myOwnProfile } from './checks';
import { inWorkspace, keptProfile, once, type Ctx } from './common';
import { ownArea } from './local';
import { tally } from './tallies';
import { startOfToday } from './tidy';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const eventsNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.events.next',
  description:
    'Whether the person’s computer reads the events near them today, on Alignable (their town’s events) or Facebook (its event search for their town): once a week, the first time and then a week after the last read. With the events it read lately, which it never reads again, and on Facebook what to search for.',
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
    const searches = input.platform === 'facebook' ? eventSearches(await ownArea(ctx, me)) : [];
    if (!row) return { due: true, read: [], searches };
    // By the business's days: read on a Monday, due again the next Monday whatever the hour.
    const dueFrom = (await startOfToday(ctx)).getTime() - (EVENTS_EVERY_DAYS - 1) * DAY;
    return { due: new Date(row.readAt).getTime() < dueFrom, read: row.urls, searches };
  },
});

export const eventsRead = defineAddonCommand(outreachAddon, {
  name: 'outreach.events.read',
  description:
    'The person’s computer read the events near them this week, on Alignable or Facebook: up to 5 not read before, each kept for Today’s list of events near them, with who hosts it. On Facebook the hosts and people going who aren’t friends are checked by the AI like friends; on Alignable they went to the AI as found. Nothing on an event was pressed. The next read is a week on.',
  risk: 0,
  input: EventsReadInput,
  output: EventsReadOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const urls = [...new Set([...input.urls, ...input.events.map((e) => e.url)])];
      const fresh = JSON.stringify(urls.slice(0, EVENTS_KEPT_MOST));
      // The newest first, then those read before that aren't again, up to the most kept.
      await ctx.tx.execute(
        sql`insert into addon_outreach.event_reads (workspace_id, user_id, platform, read_at, urls)
            values (${ws}, ${me}, ${input.platform}, ${at.toISOString()}::timestamptz,
              array(select u from jsonb_array_elements_text(${fresh}::jsonb) with ordinality as sent (u, n)
                order by n))
            on conflict (workspace_id, user_id, platform) do update set
              read_at = excluded.read_at,
              urls = (excluded.urls || array(
                select u from unnest(addon_outreach.event_reads.urls) with ordinality as kept (u, n)
                where u <> all (excluded.urls) order by n))[1:${EVENTS_KEPT_MOST}],
              updated_at = excluded.read_at`,
      );
      let added = 0;
      for (const event of input.events) {
        const hosts = [...new Set(event.hosts.map((h) => h.name))];
        const [kept] = await rows<{ id: string }>(
          ctx.tx,
          sql`insert into addon_outreach.events (workspace_id, user_id, platform, url, name, when_text, starts_at,
                place, hosts, seen_at)
              values (${ws}, ${me}, ${input.platform}, ${event.url}, ${event.name}, ${event.when},
                ${event.startsAt}::timestamptz, ${event.place},
                array(select jsonb_array_elements_text(${JSON.stringify(hosts)}::jsonb)),
                ${at.toISOString()}::timestamptz)
              on conflict (workspace_id, user_id, platform, url) do update set
                name = excluded.name, when_text = coalesce(excluded.when_text, addon_outreach.events.when_text),
                starts_at = coalesce(excluded.starts_at, addon_outreach.events.starts_at),
                place = coalesce(excluded.place, addon_outreach.events.place),
                hosts = case when cardinality(excluded.hosts) > 0 then excluded.hosts
                  else addon_outreach.events.hosts end,
                seen_at = excluded.seen_at, updated_at = excluded.seen_at
              returning id`,
        );
        // On Alignable its people went to the AI as found (`outreach.finds.save`); on Facebook they're kept with it.
        if (input.platform === 'facebook' && kept)
          added += await keepEventPeople(ctx, me, kept.id, event, at);
      }
      // Each event the computer read counts (decision 140).
      await tally(ctx, me, input.platform, 'event', urls.length, at);
      return { readAt: at.toISOString(), added };
    });
  },
});

/**
 * Who hosts or is going to an event on Facebook, kept with it: never the person themselves. Returns how many are new at
 * an event near them and not their friends, whom the AI checks like friends.
 */
async function keepEventPeople(
  ctx: Parameters<typeof keptProfile>[0],
  me: string,
  eventId: string,
  event: {
    readonly hosts: readonly EventPersonIn[];
    readonly guests: readonly EventPersonIn[];
  },
  at: Date,
): Promise<number> {
  const ws = ctx.scope.workspaceId!;
  const host = new Map<string, boolean>();
  for (const [person, hosting] of [
    ...event.hosts.map((p) => [p, true] as const),
    ...event.guests.map((p) => [p, false] as const),
  ]) {
    const profile = await keptProfile(
      ctx,
      { platform: 'facebook', profile: person.profile, name: person.name },
      me,
      at,
    );
    host.set(profile.id, (host.get(profile.id) ?? false) || hosting);
  }
  if (!host.size) return 0;
  const sent = JSON.stringify([...host].map(([id, h]) => ({ id, host: h })));
  const fresh = await rows<{ id: string }>(
    ctx.tx,
    sql`insert into addon_outreach.event_people (workspace_id, user_id, event_id, profile_id, host, seen_at)
        select ${ws}, ${me}, ${eventId}, p.id, (x->>'host')::boolean, ${at.toISOString()}::timestamptz
        from jsonb_array_elements(${sent}::jsonb) as x
        join addon_outreach.profiles p on p.workspace_id = ${ws} and p.id = (x->>'id')::uuid
        where not (p.friendship = 'self' or ${myOwnProfile(me)})
        on conflict (workspace_id, event_id, profile_id) do update set
          host = addon_outreach.event_people.host or excluded.host,
          seen_at = excluded.seen_at, updated_at = excluded.seen_at
        returning profile_id as id`,
  );
  const ids = fresh.map((f) => f.id);
  if (!ids.length) return 0;
  // New at an event near them, not seen at one before in the last month, and not their friend.
  const [n] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n
        from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as sent (u)
        where not exists (select 1 from addon_outreach.friends f
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.profile_id = sent.u::uuid
              and f.state = 'friends')
          and not exists (select 1 from addon_outreach.event_people ep
            where ep.workspace_id = ${ws} and ep.user_id = ${me} and ep.profile_id = sent.u::uuid
              and ep.event_id <> ${eventId})`,
  );
  return n?.n ?? 0;
}

type EventPersonIn = {
  readonly profile: {
    readonly id: string | null;
    readonly username: string | null;
    readonly url: string;
  };
  readonly name: string;
};

/**
 * The events near the person on Today's card (decision 188): those coming up in the next weeks, the soonest first,
 * then those whose day the page didn't say, read lately. Never one they put aside, or one that's over.
 */
export async function todayEvents(
  ctx: Ctx,
  me: string,
  platform: EventPlatform,
  now: number,
): Promise<TodayEvent[]> {
  const found = await rows<{
    id: string;
    url: string;
    name: string;
    when_text: string | null;
    starts_at: Date | string | null;
    place: string | null;
    hosts: string[];
    people: number;
  }>(
    ctx.tx,
    sql`select e.id, e.url, e.name, e.when_text, e.starts_at, e.place, e.hosts,
          (select count(*)::int from addon_outreach.event_people ep
            left join addon_outreach.checks ch on ch.profile_id = ep.profile_id and ch.user_id = ${me}
            where ep.event_id = e.id and (ch.id is null or ch.verdict in ('waiting', 'good', 'maybe'))) as people
        from addon_outreach.events e
        where e.workspace_id = ${ctx.scope.workspaceId!} and e.user_id = ${me} and e.platform = ${platform}
          and e.skipped_at is null
          and ((e.starts_at is not null
              and e.starts_at >= ${new Date(now - 2 * HOUR).toISOString()}::timestamptz
              and e.starts_at <= ${new Date(now + EVENTS_AHEAD_DAYS * DAY).toISOString()}::timestamptz)
            or (e.starts_at is null
              and e.seen_at >= ${new Date(now - EVENTS_UNDATED_DAYS * DAY).toISOString()}::timestamptz))
        order by e.starts_at asc nulls last, e.seen_at desc, e.id
        limit ${EVENTS_TODAY_MOST}`,
  );
  return found.map((e) => ({
    id: e.id,
    url: e.url,
    name: e.name,
    when: e.when_text,
    startsAt: e.starts_at === null ? null : new Date(e.starts_at).toISOString(),
    place: e.place,
    hosts: e.hosts,
    people: e.people,
  }));
}

export const eventSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.event.skip',
  description:
    'Not going: take an event off the person’s list of events near them on Today (Events near you). Its people are still checked. Nothing changes on the network.',
  risk: 0,
  input: EventSkipInput,
  output: EventSkipOutput,
  permission: 'outreach.use',
  ai: { tool: 'outreach_event_skip', keywords: ['not going', 'skip event', 'hide event'] },
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const done = await rows<{ id: string }>(
      ctx.tx,
      sql`update addon_outreach.events set skipped_at = coalesce(skipped_at, ${at.toISOString()}::timestamptz),
            updated_at = ${at.toISOString()}::timestamptz
          where workspace_id = ${ctx.scope.workspaceId!} and id = ${input.eventId} and user_id = ${me}
          returning id`,
    );
    if (!done.length)
      throw HfosError.notFound(
        'That event isn’t on your list any more. Open Today again to see the events near you.',
      );
    return { skipped: true };
  },
});

export const eventsCommands = [eventsRead, eventSkip] as const;
export const eventsQueries = [eventsNext] as const;
