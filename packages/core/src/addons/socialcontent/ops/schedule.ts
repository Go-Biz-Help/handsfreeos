/**
 * The schedule's facts, read the same way by the server and the worker (decisions 21 to 27; docs/socialcontent.md,
 * "The schedule"): the posts it learns the hours from (the creators' and the business's own), the posts already on the
 * calendar, and moving the AI's posts that haven't gone up to better hours. The math is ../schedule.ts. Server-only.
 */
import { rows, sql, type Db, type Tx } from '@hfos/db/client';
import { z } from 'zod';
import { defineAddonCommand } from '../../server';
import { isPostingNetwork, type ContentState, type PostedTo } from '../calendar';
import { socialcontentAddon } from '../manifest';
import type { OwnNumbers } from '../own';
import {
  learnTimes,
  mondayOf,
  ownSamples,
  type LearnedTimes,
  type MovablePost,
  type TimeSample,
} from '../schedule';
import { uuid } from '../shapes';
import { addDays, localDateOf, localInstant } from '../../../calendar/engine/zoned';
import { changeMoment } from '../../../kernel/moment';
import { inWorkspace } from './common';

/** How many of the creators' posts, and of its own, it learns the hours from: the latest. */
const CREATOR_POSTS_MOST = 3000;
const OWN_POSTS_MOST = 300;

/**
 * What the business's posts and the creators' say about each hour (decisions 23 and 25): the creators' posts of the
 * last 12 months that were weighed (views against their normal where shown, else likes plus comments), and its own
 * that went up with numbers.
 */
export async function learnedTimesOf(
  tx: Tx | Db,
  workspaceId: string,
  timeZone: string,
): Promise<LearnedTimes> {
  const theirs = await rows<{ network: string; posted_at: Date | string; times: number | string }>(
    tx,
    sql`select c.network, p.posted_at, coalesce(p.views_times, p.engagement_times) as times
        from addon_socialcontent.posts p
        join addon_socialcontent.creators c on c.id = p.creator_id and c.workspace_id = p.workspace_id
        where p.workspace_id = ${workspaceId}::uuid and p.waiting is null
          and coalesce(p.views_times, p.engagement_times) is not null
          and p.posted_at > now() - interval '365 days'
        order by p.posted_at desc
        limit ${CREATOR_POSTS_MOST}`,
  );
  const mine = await rows<{ network: string; posted_to: PostedTo[]; numbers: OwnNumbers }>(
    tx,
    sql`select c.network, c.posted_to, c.numbers from addon_socialcontent.content c
        where c.workspace_id = ${workspaceId}::uuid and jsonb_array_length(c.posted_to) > 0
          and c.numbers <> '{}'::jsonb
        order by coalesce(c.posted_at, c.post_at) desc nulls last
        limit ${OWN_POSTS_MOST}`,
  );
  const samples: TimeSample[] = [
    ...theirs.map((t) => ({
      network: t.network,
      at: new Date(t.posted_at).getTime(),
      times: Number(t.times),
      own: false,
    })),
    ...ownSamples(
      mine.map((m) => ({
        network: m.network,
        postedTo: Array.isArray(m.posted_to) ? m.posted_to : [],
        numbers: m.numbers ?? {},
      })),
    ),
  ];
  return learnTimes(samples, timeZone);
}

/**
 * The posts on the calendar from the Monday of this week on (AI picks counts a week's posts, decision 22), not
 * removed: each one's network, time, state and who set its time.
 */
export async function postsOnCalendar(
  tx: Tx | Db,
  workspaceId: string,
  timeZone: string,
  now: number,
): Promise<MovablePost[]> {
  const since = localInstant(addDays(mondayOf(localDateOf(now, timeZone)), -1), '00:00', timeZone);
  const found = await rows<{
    id: string;
    network: string;
    post_at: Date | string;
    state: ContentState;
    placed_by: 'ai' | 'person';
  }>(
    tx,
    sql`select c.record_id as id, c.network, c.post_at, c.state, c.placed_by
        from addon_socialcontent.content c
        join app.custom_records r on r.id = c.record_id and r.archived_at is null
        where c.workspace_id = ${workspaceId}::uuid and c.post_at >= ${new Date(since).toISOString()}::timestamptz`,
  );
  return found.flatMap((f) =>
    isPostingNetwork(f.network)
      ? [
          {
            id: f.id,
            network: f.network,
            postAt: new Date(f.post_at).getTime(),
            state: f.state,
            placedBy: f.placed_by === 'person' ? ('person' as const) : ('ai' as const),
          },
        ]
      : [],
  );
}

export const ContentRetimeInput = z.object({
  workspaceId: uuid,
  /** Each post moved: from the time it had (so one a person changed meanwhile stays), to the AI's new one. */
  moves: z.array(z.object({ postId: uuid, from: z.iso.datetime(), to: z.iso.datetime() })).max(500),
});

export const contentRetime = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.retime',
  description:
    'Worker: the AI’s posts that haven’t gone up, moved to the hours AI picks now has for their days (decision 27), OK’d ones too, keeping their OK. A post a person set the time of, or changed since, stays where it is.',
  risk: 0,
  input: ContentRetimeInput,
  output: z.object({ moved: z.number().int() }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.content.moved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    let moved = 0;
    for (const m of input.moves) {
      const done = await rows<{ id: string }>(
        ctx.tx,
        sql`update addon_socialcontent.content
            set post_at = ${m.to}::timestamptz, updated_at = ${at.toISOString()}::timestamptz
            where record_id = ${m.postId}::uuid and workspace_id = ${ws}::uuid
              and post_at = ${m.from}::timestamptz and placed_by = 'ai' and state in ('draft', 'ready')
            returning record_id as id`,
      );
      moved += done.length;
    }
    if (moved)
      await ctx.emit({
        type: 'socialcontent.content.moved',
        entityType: 'socialcontent_settings',
        entityId: ws,
        payload: { moved },
      });
    return { moved };
  },
});

export const scheduleCommands = [contentRetime] as const;
