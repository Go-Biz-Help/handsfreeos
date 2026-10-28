/**
 * Staying active in the person's Facebook groups (../active.ts, docs/outreach.md decision 114), server side: what the
 * person's computer does there today (how many recent posts to like, in which of their groups, and whether a question
 * is still to keep for the day's reply), and the question it keeps. Today lists the kept question, the AI writes the
 * reply, and it goes through `sends` (`group_reply`, ./sends.ts). Each person's own. Server-only.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  ACTIVE_GROUPS,
  ActiveNextInput,
  ActiveNextOutput,
  ActiveReplyInput,
  ActiveReplyOutput,
  GROUP_REPLY_WORDS,
  groupRepliesOn,
  likesToday,
  type ActiveNextOutput as Next,
} from '../active';
import { outreachAddon } from '../manifest';
import type { GroupCheckState } from '../group-checks';
import { postLook } from '../posts';
import { posts } from '../tables';
import { keepGroup } from './activity';
import { automationOf, limitsFor } from './automation';
import { myOwnProfile } from './checks';
import { inWorkspace, keptProfile, notOthers, once } from './common';
import { playbooksInUse } from './friends';
import { groupFitOf } from './group-checks';
import { workingBuild } from './live';
import { someoneElses } from './owners';
import { readinessFor } from './readiness';
import { slowsNow, startOfToday, warningOf } from './tidy';
import { dayCounts } from './today';

const NONE: Next = { likes: 0, reply: false, groups: [], own: null };

export const activeNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.active.next',
  description:
    'What the person’s computer does today to stay active in their Facebook groups: how many recent posts to like there (3 to 5, within the day’s likes), in which of their groups (up to 3 that fit and that no teammate works, a different few each day), and whether a question there is still to keep for the day’s reply. Nothing before the person is ready, nor with Sending off.',
  input: ActiveNextInput,
  output: ActiveNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const todayStart = await startOfToday(ctx, now);
    const todayFrom = todayStart.toISOString();
    // Nothing before they're ready (decision 63), nor while they do everything themselves.
    const [readiness, { choices }] = await Promise.all([
      readinessFor(ctx, me, input.platform),
      automationOf(ctx, me, now, input.platform),
    ]);
    if (!readiness.ready || choices.sending === 'off') return NONE;
    const warning = await warningOf(ctx, me, input.platform, todayStart, now);
    const [done, limits] = await Promise.all([
      dayCounts(ctx, [me], input.platform, todayStart).then((d) => d.get(me)!),
      limitsFor(ctx, me, slowsNow(warning, now), now, input.platform),
    ]);
    const [today] = await rows<{ liked: number; kept: boolean }>(
      ctx.tx,
      sql`select (select count(*)::int from addon_outreach.touches t
              join addon_outreach.profiles p on p.id = t.profile_id
              where t.workspace_id = ${ws} and t.user_id = ${me} and t.kind = 'like' and p.platform = ${input.platform}
                and t.at >= ${todayFrom}::timestamptz and t.post_url like '%/groups/%') as liked,
            exists (select 1 from addon_outreach.posts po
              where po.workspace_id = ${ws} and po.user_id = ${me} and po.reply_at >= ${todayFrom}::timestamptz) as kept`,
    );
    // Today's few, less any liked in a group already today, within what the day's likes leave.
    const likes = Math.max(
      0,
      Math.min(likesToday(now) - (today?.liked ?? 0), limits.like - done.like),
    );
    const reply =
      !today?.kept &&
      limits.comment - done.comment > 0 &&
      groupRepliesOn(await workingBuild(ctx, me));
    if (!likes && !reply) return NONE;
    const candidates = await rows<{
      id: string;
      name: string | null;
      url: string;
      detail: string | null;
      members: number | null;
      privacy: 'public' | 'private' | null;
      check_state: GroupCheckState | null;
      check_why: string[] | null;
      check_playbook_id: string | null;
    }>(
      ctx.tx,
      sql`select g.id, g.name, g.url, g.detail, g.members, g.privacy, g.check_state, g.check_why, g.check_playbook_id
          from addon_outreach.groups g
          join addon_outreach.my_groups m on m.group_id = g.id and m.user_id = ${me} and m.joined
          where g.workspace_id = ${ws} and g.platform = ${input.platform} and ${notOthers(me, 'g')}
          order by md5(g.id::text || ${todayFrom})`,
    );
    const playbooks = await playbooksInUse(ctx, input.platform);
    // Work these first, then Maybe; a different few each day, in the day's turn.
    const fitting = candidates
      .map((g) => ({ g, fit: groupFitOf(playbooks, { ...g, joined: true, check_playbook: null }) }))
      .filter(({ fit }) => fit.verdict !== 'skip')
      .sort((a, b) => Number(b.fit.verdict === 'work') - Number(a.fit.verdict === 'work'))
      .slice(0, ACTIVE_GROUPS);
    if (!fitting.length) return NONE;
    const seen = readiness.profileCheck?.seen ?? null;
    return {
      likes,
      reply,
      groups: fitting.map(({ g }) => ({ groupId: g.id, name: g.name, url: g.url })),
      own: seen ? { url: seen.url, username: seen.username } : null,
    };
  },
});

export const activeReply = defineAddonCommand(outreachAddon, {
  name: 'outreach.active.reply',
  description:
    'Keep one recent post that asks something, in one of the person’s Facebook groups, for the day’s reply: the first of those sent that isn’t theirs, answered or put aside already, another teammate’s person’s, or one the AI checks for a comment instead. Today lists it, and the AI writes the reply, which waits for the person’s OK at first. One a day. Nobody goes in Contacts.',
  risk: 1,
  input: ActiveReplyInput,
  output: ActiveReplyOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const todayFrom = (await startOfToday(ctx, at.getTime())).toISOString();
    return once(async () => {
      const [kept] = await rows<{ id: string }>(
        ctx.tx,
        sql`select id from addon_outreach.posts
            where workspace_id = ${ws} and user_id = ${me} and reply_at >= ${todayFrom}::timestamptz limit 1`,
      );
      if (kept) return { postId: null, url: null, why: GROUP_REPLY_WORDS.keptToday };
      const playbooks = await playbooksInUse(ctx, input.platform);
      for (const p of input.posts) {
        const groupId = await keepGroup(ctx, input.platform, p.group);
        const author = await keptProfile(
          ctx,
          { platform: input.platform, profile: p.author, name: p.name },
          me,
          at,
          { groupId },
          (h) => (h.groupId ? {} : { groupId }),
        );
        const [mine] = await rows<{ own: boolean; done: boolean }>(
          ctx.tx,
          sql`select p.friendship = 'self' or ${myOwnProfile(me)} as own,
                exists (select 1 from addon_outreach.touches t
                  where t.user_id = ${me} and t.kind = 'comment' and t.post_url = ${p.url}) as done
              from addon_outreach.profiles p where p.id = ${author.id}`,
        );
        if (mine?.own || mine?.done || (await someoneElses(ctx, me, author.id))) continue;
        const [had] = await rows<{
          id: string;
          check_state: string;
          skipped: boolean;
          reply_at: Date | string | null;
        }>(
          ctx.tx,
          sql`select id, check_state, skipped_at is not null as skipped, reply_at from addon_outreach.posts
              where workspace_id = ${ws} and user_id = ${me} and url = ${p.url}`,
        );
        let postId: string;
        if (had) {
          // One kept for the AI's check is a comment's to be (decision 20); one answered or set aside is done with.
          if (!['not', 'failed'].includes(had.check_state) || had.skipped || had.reply_at) continue;
          postId = had.id;
        } else {
          // Worth the AI's check: Find posts and the look at the newest keep it for a comment.
          if (postLook(playbooks, p.text, { platform: input.platform, words: null }).worth)
            continue;
          const [row] = await ctx.tx
            .insert(posts)
            .values({
              workspaceId: ws,
              userId: me,
              groupId,
              profileId: author.id,
              url: p.url,
              posted: p.when,
              body: p.text,
              comments: p.comments,
              reactions: p.reactions,
              reasons: ['Asks something'],
              found: 'active',
              checkState: 'not',
              seenAt: at,
            })
            .returning({ id: posts.id });
          postId = row!.id;
        }
        await ctx.tx.execute(
          sql`update addon_outreach.posts set reply_at = ${at.toISOString()}::timestamptz, seen_at = ${at.toISOString()}::timestamptz
              where id = ${postId}`,
        );
        return { postId, url: p.url, why: null };
      }
      return { postId: null, url: null, why: GROUP_REPLY_WORDS.noneKept };
    });
  },
});

export const activeCommands = [activeReply] as const;
export const activeQueries = [activeNext] as const;
