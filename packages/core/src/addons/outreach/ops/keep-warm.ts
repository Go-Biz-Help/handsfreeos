/**
 * Warming people up while they decide on the person's request (../keep-warm.ts, decision 161), on the server: who gets
 * a visit on Today, and the post a visit liked kept for its one comment. Whom the tool leaves alone once their warm-up
 * ended with no answer is `warmUpEnded` in ./common.ts, as every pick's `openToMe` reads it.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { VISIT_GAP_DAYS, WARM_POST_GAP_HOURS, warmPostWhy, warmUpEnds } from '../keep-warm';
import type { Platform } from '../playbooks';
import { outreachSettingsOf } from './common';

/** What a like note says, for a post a visit liked (`keepWarmPost`). */
export interface LikedPost {
  readonly platform: Platform;
  readonly postUrl: string | null;
  readonly postText: string | null;
  readonly auto: boolean;
}

/**
 * Instagram's story like is noted as a like with this as its words (the extension's `likeStory`): a story isn't a post
 * to comment under.
 */
const STORY_TEXT = 'Their story';

/**
 * A like the extension made on its own on a post of someone deciding on the person's request, in their warm-up: the
 * first a visit liked is kept for one comment under it (`posts.warm_up`), on Today as any good post is, at most one a
 * visit (none kept for them in the last `WARM_POST_GAP_HOURS`). A story, a like with no post's link or
 * words, or one past their warm-up keeps none.
 */
export async function keepWarmPost(
  ctx: CommandContext,
  me: string,
  profileId: string,
  like: LikedPost,
  at: Date,
): Promise<void> {
  if (!like.auto || !like.postUrl || !like.postText || like.postText === STORY_TEXT) return;
  const weeks = (await outreachSettingsOf(ctx)).cancelRequestsAfterWeeks;
  const ws = ctx.scope.workspaceId!;
  // Visits are a day or more apart, so a post kept in the last few hours was this visit's.
  const since = new Date(at.getTime() - WARM_POST_GAP_HOURS * 3_600_000).toISOString();
  await ctx.tx.execute(sql`
    insert into addon_outreach.posts
      (workspace_id, user_id, profile_id, url, body, found, check_state, check_why, checked_at, warm_up, seen_at)
    select ${ws}, ${me}, ${profileId}, ${like.postUrl}, ${like.postText}, 'account', 'good',
      ${warmPostWhy(like.platform)}, ${at.toISOString()}::timestamptz, true, ${at.toISOString()}::timestamptz
    where exists (select 1 from addon_outreach.friends f
        where f.workspace_id = ${ws} and f.user_id = ${me} and f.profile_id = ${profileId}
          and f.state = 'request_sent'
          and greatest(f.since, f.warm_up_from) + make_interval(weeks => ${weeks})
            > ${at.toISOString()}::timestamptz)
      and not exists (select 1 from addon_outreach.posts po
        where po.workspace_id = ${ws} and po.user_id = ${me} and po.profile_id = ${profileId}
          and po.warm_up and po.seen_at >= ${since}::timestamptz)
    on conflict (workspace_id, user_id, url) do nothing`);
}

/** Back in play (`outreach.stage.mark`, open): someone whose warm-up ended is in play again. */
export async function clearWarmUpEnd(ctx: CommandContext, me: string, profileId: string) {
  await ctx.tx.execute(sql`update addon_outreach.friend_ends set after_warm_up = false
    where workspace_id = ${ctx.scope.workspaceId!} and user_id = ${me} and profile_id = ${profileId}
      and after_warm_up`);
}

/**
 * Whether a request the extension withdrew had its whole warm-up, so it ended with no answer: it went at `since`, and
 * its wait (`weeks`, from `warmFrom` for one already waiting when warm-ups began) was over by `at`. One Cancel all took
 * sooner wasn't.
 */
export function endedWarmUp(
  since: Date | string,
  warmFrom: Date | string | null,
  weeks: number,
  at: Date,
): boolean {
  return warmUpEnds(since, warmFrom, weeks).getTime() <= at.getTime();
}

/** Someone waiting on the person's request, for a visit (`visitsDue`). */
export type VisitDue = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly since: Date | string;
  readonly warm_up_from: Date | string | null;
  readonly playbook_name: string | null;
};

/**
 * Who's due a visit today on a network (decision 161): their request (a follow, on Instagram) the person `me` sent is
 * still waiting, in its warm-up, and it's been a random 1 to 3 business days (`VISIT_GAP_DAYS`) since the last of their
 * request, a fresh start (`warm_up_from`) and their last visit (a like on their page, or a visit with nothing to
 * like). The gap is picked from who they are and the day it counts from, so it's the same all day and differs from
 * one visit to the next. Those whose wait ends soonest first. `allowed` is the
 * picks' filter on `p` (in play, reached, and who the country setting lets).
 */
export async function visitsDue(
  ctx: QueryContext,
  me: string,
  o: {
    readonly platform: Platform;
    readonly weeks: number;
    readonly now: number;
    readonly todayFrom: Date;
    readonly allowed: ReturnType<typeof sql>;
    readonly most: number;
  },
): Promise<VisitDue[]> {
  if (o.most <= 0) return [];
  const ws = ctx.scope.workspaceId!;
  const now = new Date(o.now).toISOString();
  // The last visit was before today, less the random gap's days past its first: a gap of 1 is any day before today.
  const span = VISIT_GAP_DAYS.most - VISIT_GAP_DAYS.least + 1;
  return rows<VisitDue>(
    ctx.tx,
    sql`select p.id, p.name, p.url, f.since, f.warm_up_from, pb.name as playbook_name
        from addon_outreach.friends f
        join addon_outreach.profiles p on p.id = f.profile_id
        left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
        left join addon_outreach.playbooks pb on pb.id = ch.playbook_id
        cross join lateral (select greatest(f.since, f.warm_up_from, p.warm_up_missed_at,
            (select max(t.at) from addon_outreach.touches t
              where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'like')) as visited) lv
        where f.workspace_id = ${ws} and f.user_id = ${me} and p.platform = ${o.platform}
          and f.state = 'request_sent'
          and greatest(f.since, f.warm_up_from) + make_interval(weeks => ${o.weeks})
            > ${now}::timestamptz
          and exists (select 1 from addon_outreach.touches t
            where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'friend_request')
          and lv.visited < ${o.todayFrom.toISOString()}::timestamptz - make_interval(days =>
            ${VISIT_GAP_DAYS.least - 1}::int
              + mod(abs(hashtext(p.id::text || ':' || (lv.visited at time zone 'UTC')::date::text)::bigint),
                ${span}::bigint)::int)
          and ${o.allowed}
        order by greatest(f.since, f.warm_up_from), p.id
        limit ${o.most}`,
  );
}
