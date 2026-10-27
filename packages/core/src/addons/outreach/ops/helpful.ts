/**
 * Helpful posts in the groups, and the people who engage (../helpful.ts, docs/outreach.md decision 50): each person's
 * own. The person asks for the day's (or the extension does, once a day); the worker has the AI write it
 * (`outreach.helpful.asked`, then `outreach.helpful.draft`); it goes up as the person chose (copied, after their OK
 * through an ask of their computer, or on its own); and the extension reads who reacted and commented on it, each
 * kept as a profile from the group, nobody in Contacts. Today lists them as warm leads (./today.ts).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import type { GroupCheckState } from '../group-checks';
import {
  ENGAGED_DAYS,
  HELPFUL_GROUP_DAYS,
  HELPFUL_PER_DAY,
  HelpfulAskInput,
  HelpfulAskOutput,
  HelpfulChangeOutput,
  HelpfulDraftInput,
  HelpfulDraftOutput,
  HelpfulEngagedInput,
  HelpfulEngagedOutput,
  NetworkEngagedInput,
  NetworkEngagedOutput,
  HelpfulListInput,
  HelpfulListOutput,
  HelpfulNextInput,
  HelpfulNextOutput,
  HelpfulOkInput,
  HelpfulPostedInput,
  type HelpfulShown,
  HelpfulSkipInput,
  OPEN_HELPFUL_STATES,
  type HelpfulState,
} from '../helpful';
import { outreachAddon } from '../manifest';
import { engagements, helpful } from '../tables';
import { automationOf } from './automation';
import { inWorkspace, keptProfile, once, type Ctx } from './common';
import { playbooksInUse } from './friends';
import { groupFitOf } from './group-checks';
import { NETWORKS, type Platform } from '../networks';
import { readinessFor } from './readiness';
import { startOfToday } from './tidy';

const DAY = 86_400_000;
/** The day's slot is used by one that's being written, waiting, OK'd or up: not one put aside or that couldn't go. */
const COUNTED: readonly HelpfulState[] = ['drafting', 'draft', 'approved', 'posted'];

/** One of the person's own helpful posts, for a change: refused when it isn't theirs or isn't kept. */
async function mine(ctx: Ctx, me: string, helpfulId: string) {
  const [row] = await ctx.tx
    .select()
    .from(helpful)
    .where(
      and(
        eq(helpful.workspaceId, ctx.scope.workspaceId!),
        eq(helpful.id, helpfulId),
        eq(helpful.userId, me),
      ),
    )
    .for('update');
  if (!row) throw HfosError.notFound('That helpful post isn’t kept anymore. Reload the page.');
  return row;
}

/** The person's helpful posts on a network, as the app shows them: today's, then the last fortnight's posted. */
async function shownOf(
  ctx: Ctx,
  me: string,
  todayFrom: Date,
  platform: Platform,
): Promise<HelpfulShown[]> {
  const since = new Date(todayFrom.getTime() - ENGAGED_DAYS * DAY).toISOString();
  const found = await rows<{
    id: string;
    platform: Platform;
    group_id: string | null;
    group_name: string | null;
    group_url: string | null;
    playbook_name: string | null;
    state: HelpfulState;
    how: HelpfulShown['how'];
    topic: string | null;
    body: string | null;
    post_url: string | null;
    why_not: string | null;
    asked_at: Date | string;
    posted_at: Date | string | null;
    comments: number;
    reactions: number;
  }>(
    ctx.tx,
    sql`select h.id, h.platform, h.group_id, g.name as group_name, g.url as group_url, pb.name as playbook_name,
          h.state, h.how, h.topic, h.body, h.post_url, h.why_not, h.asked_at, h.posted_at,
          (select count(*)::int from addon_outreach.engagements e
            where e.helpful_id = h.id and e.kind = 'comment') as comments,
          (select count(*)::int from addon_outreach.engagements e
            where e.helpful_id = h.id and e.kind = 'reaction') as reactions
        from addon_outreach.helpful h
        left join addon_outreach.groups g on g.id = h.group_id
        left join addon_outreach.playbooks pb on pb.id = h.playbook_id
        where h.workspace_id = ${ctx.scope.workspaceId!} and h.user_id = ${me} and h.platform = ${platform}
          and (h.asked_at >= ${todayFrom.toISOString()}::timestamptz
            or (h.state = 'posted' and h.posted_at >= ${since}::timestamptz))
        order by h.asked_at desc limit 30`,
  );
  const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
  return found.map((h) => ({
    helpfulId: h.id,
    platform: h.platform,
    groupId: h.group_id,
    groupName: h.group_name,
    groupUrl: h.group_url,
    playbookName: h.playbook_name,
    state: h.state,
    how: h.how,
    topic: h.topic,
    text: h.body,
    postUrl: h.post_url,
    whyNot: h.why_not,
    askedAt: iso(h.asked_at)!,
    postedAt: iso(h.posted_at),
    comments: h.comments,
    reactions: h.reactions,
  }));
}

export const helpfulAsk = defineAddonCommand(outreachAddon, {
  name: 'outreach.helpful.ask',
  description:
    'Ask the AI for today’s helpful post: one that helps the people in one of the person’s groups that fits (theirs to name, else the best not posted in this week), from the playbook and what people there ask, after reading its rules. One a day; asking again answers today’s.',
  risk: 1,
  input: HelpfulAskInput,
  output: HelpfulAskOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_write_helpful_post',
    keywords: ['write helpful post', 'draft group post'],
  },
  scope: inWorkspace,
  emits: ['outreach.helpful.asked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const now = at.getTime();
    return once(async () => {
      // Two presses at once make one: the second finds the first. Each network's day is its own.
      await ctx.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`outreach.helpful:${ws}:${me}:${input.platform}`}, 0))`,
      );
      const todayFrom = await startOfToday(ctx, now);
      const today = await rows<{ id: string; state: HelpfulState; group_name: string | null }>(
        ctx.tx,
        sql`select h.id, h.state, g.name as group_name from addon_outreach.helpful h
            left join addon_outreach.groups g on g.id = h.group_id
            where h.workspace_id = ${ws} and h.user_id = ${me} and h.platform = ${input.platform}
              and h.asked_at >= ${todayFrom.toISOString()}::timestamptz
            order by h.asked_at desc`,
      );
      const open = today.find((h) => (OPEN_HELPFUL_STATES as readonly string[]).includes(h.state));
      if (open) return { helpfulId: open.id, groupName: open.group_name, fresh: false };
      if (today.filter((h) => COUNTED.includes(h.state)).length >= HELPFUL_PER_DAY)
        throw HfosError.rule(
          'outreach_helpful_today',
          409,
          input.platform === 'facebook'
            ? 'Today’s helpful post is up. The next one comes tomorrow: one a day keeps Facebook and the groups happy.'
            : `Today’s helpful post on ${NETWORKS[input.platform].name} is up. The next one comes tomorrow: one a day keeps your feed welcome.`,
        );
      // Off Facebook it goes on the person's own feed: no group to pick, the playbook in use first.
      if (input.platform !== 'facebook') {
        const playbooks = await playbooksInUse(ctx, input.platform);
        const { choices } = await automationOf(ctx, me, now, input.platform);
        const [row] = await ctx.tx
          .insert(helpful)
          .values({
            workspaceId: ws,
            userId: me,
            platform: input.platform,
            groupId: null,
            playbookId: playbooks[0]?.id ?? null,
            state: 'drafting',
            how: choices.posting,
            askedAt: at,
            updatedAt: at,
          })
          .returning({ id: helpful.id });
        await ctx.emit({
          type: 'outreach.helpful.asked',
          entityType: 'workspace',
          entityId: ws,
          payload: { helpfulId: row!.id, groupId: null, userId: me, platform: input.platform },
        });
        return { helpfulId: row!.id, groupName: null, fresh: true };
      }

      const weekAgo = new Date(now - HELPFUL_GROUP_DAYS * DAY).toISOString();
      // Facebook's groups only: one joined on Alignable (decision 92) is never Facebook's to post in.
      const candidates = await rows<{
        id: string;
        name: string | null;
        detail: string | null;
        members: number | null;
        privacy: 'public' | 'private' | null;
        check_state: GroupCheckState | null;
        check_why: string[];
        check_playbook_id: string | null;
        posted_lately: boolean;
        asked: number;
      }>(
        ctx.tx,
        sql`select g.id, g.name, g.detail, g.members, g.privacy, g.check_state, g.check_why, g.check_playbook_id,
              exists (select 1 from addon_outreach.helpful h
                where h.group_id = g.id and h.user_id = ${me} and h.platform = 'facebook'
                  and h.state in ('drafting', 'draft', 'approved', 'posted')
                  and h.asked_at >= ${weekAgo}::timestamptz) as posted_lately,
              (select count(*)::int from addon_outreach.posts po
                where po.group_id = g.id and po.user_id = ${me}) as asked
            from addon_outreach.groups g
            join addon_outreach.my_groups m on m.group_id = g.id and m.user_id = ${me} and m.joined
            where g.workspace_id = ${ws} and g.platform = 'facebook'
              ${input.groupId ? sql`and g.id = ${input.groupId}` : sql``}`,
      );
      if (input.groupId && !candidates.length)
        throw HfosError.rule(
          'outreach_helpful_not_in_group',
          409,
          'You’re not in that group, so a post can’t go there. Join it on Facebook, then press Save my groups on the Groups tab.',
        );
      const named = input.groupId ? candidates[0] : undefined;
      if (named?.posted_lately)
        throw HfosError.rule(
          'outreach_helpful_group_this_week',
          409,
          `You posted in ${named.name ?? 'that group'} in the last week. Pick another group: one post a week in each keeps its people glad to see you.`,
        );
      const playbooks = await playbooksInUse(ctx, 'facebook');
      const ranked = candidates
        .filter((g) => !g.posted_lately)
        .map((g) => ({
          g,
          fit: groupFitOf(playbooks, { ...g, joined: true, check_playbook: null }),
        }))
        .filter(({ fit }) => input.groupId || fit.verdict !== 'skip')
        .sort(
          (a, b) =>
            Number(b.g.check_state === 'good') - Number(a.g.check_state === 'good') ||
            b.fit.score - a.fit.score ||
            Number(b.g.asked > 0) - Number(a.g.asked > 0) ||
            (b.g.members ?? 0) - (a.g.members ?? 0),
        );
      const best = ranked[0];
      if (!best)
        throw HfosError.rule(
          'outreach_helpful_no_group',
          409,
          candidates.length
            ? 'You posted in each of your groups that fit this week. The next helpful post comes when a week has passed in one of them.'
            : 'You’re not in a group that fits yet. Press Check my groups on the Groups tab, or join one that fits.',
        );
      const { settings } = await automationOf(ctx, me, now);
      const [row] = await ctx.tx
        .insert(helpful)
        .values({
          workspaceId: ws,
          userId: me,
          groupId: best.g.id,
          playbookId: best.g.check_playbook_id ?? best.fit.playbookId ?? playbooks[0]?.id ?? null,
          state: 'drafting',
          how: settings.posting,
          askedAt: at,
          updatedAt: at,
        })
        .returning({ id: helpful.id });
      await ctx.emit({
        type: 'outreach.helpful.asked',
        entityType: 'workspace',
        entityId: ws,
        payload: { helpfulId: row!.id, groupId: best.g.id, userId: me },
      });
      return { helpfulId: row!.id, groupName: best.g.name, fresh: true };
    });
  },
});

export const helpfulDraft = defineAddonCommand(outreachAddon, {
  name: 'outreach.helpful.draft',
  description:
    'Worker: what the AI wrote for a helpful post, or why one doesn’t belong in that group (its rules don’t allow it), or that it couldn’t be written.',
  risk: 0,
  input: HelpfulDraftInput,
  output: HelpfulDraftOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.helpful.drafted'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .select()
      .from(helpful)
      .where(and(eq(helpful.workspaceId, ws), eq(helpful.id, input.helpfulId)))
      .for('update');
    if (!row) throw HfosError.notFound('That helpful post isn’t kept anymore.');
    // Written already, or put aside meanwhile: a second answer changes nothing.
    if (row.state !== 'drafting') return { helpfulId: row.id, state: row.state };
    const d = input.draft;
    const change =
      d === null
        ? {
            state: 'failed' as const,
            whyNot: 'The AI couldn’t write it just now. Press Write a helpful post to try again.',
            endedAt: at,
          }
        : !d.allowed || !d.text
          ? {
              state: 'skipped' as const,
              topic: d.topic || null,
              whyNot: d.why || 'The group’s rules don’t allow a post like it.',
              endedAt: at,
            }
          : {
              state: 'draft' as const,
              topic: d.topic || null,
              body: d.text,
              draftedAt: at,
            };
    await ctx.tx
      .update(helpful)
      .set({ ...change, updatedAt: at })
      .where(eq(helpful.id, row.id));
    await ctx.emit({
      type: 'outreach.helpful.drafted',
      entityType: 'workspace',
      entityId: ws,
      payload: { helpfulId: row.id, state: change.state, userId: row.userId, how: row.how },
    });
    return { helpfulId: row.id, state: change.state };
  },
});

export const helpfulOk = defineAddonCommand(outreachAddon, {
  name: 'outreach.helpful.ok',
  description:
    'OK a helpful post for the person’s computer to put up in its group, as written or as they changed it. Their computer posts it when asked (an ask of kind post).',
  risk: 1,
  input: HelpfulOkInput,
  output: HelpfulChangeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_ok_helpful_post',
    autonomy: 'confirm',
    keywords: ['ok helpful post', 'approve group post'],
  },
  scope: inWorkspace,
  emits: ['outreach.helpful.oked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.helpfulId);
    if (row.state === 'approved' && !input.text) return { helpfulId: row.id, state: row.state };
    if (row.state !== 'draft' && row.state !== 'approved')
      throw HfosError.rule(
        'outreach_helpful_not_waiting',
        409,
        row.state === 'drafting'
          ? 'The AI is still writing it. It’s here in a minute.'
          : `It’s ${row.state === 'posted' ? 'up already' : 'put aside'}, so there’s nothing to OK. Reload the page.`,
      );
    await ctx.tx
      .update(helpful)
      .set({
        state: 'approved',
        ...(input.text ? { body: input.text } : {}),
        approvedAt: at,
        updatedAt: at,
      })
      .where(eq(helpful.id, row.id));
    await ctx.emit({
      type: 'outreach.helpful.oked',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { helpfulId: row.id, changed: input.text !== undefined },
    });
    return { helpfulId: row.id, state: 'approved' as const };
  },
});

export const helpfulSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.helpful.skip',
  description: 'Put a helpful post aside: it isn’t posted. The day’s slot is free for another.',
  risk: 0,
  input: HelpfulSkipInput,
  output: HelpfulChangeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_skip_helpful_post',
    keywords: ['skip helpful post'],
  },
  scope: inWorkspace,
  emits: ['outreach.helpful.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.helpfulId);
    if (!(OPEN_HELPFUL_STATES as readonly string[]).includes(row.state))
      return { helpfulId: row.id, state: row.state };
    await ctx.tx
      .update(helpful)
      .set({ state: 'skipped', endedAt: at, updatedAt: at })
      .where(eq(helpful.id, row.id));
    await ctx.emit({
      type: 'outreach.helpful.skipped',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { helpfulId: row.id },
    });
    return { helpfulId: row.id, state: 'skipped' as const };
  },
});

export const helpfulPosted = defineAddonCommand(outreachAddon, {
  name: 'outreach.helpful.posted',
  description:
    'A helpful post went up in its group (the extension posted it, or the person says they did), with its link once known; or the extension couldn’t post it, with why.',
  risk: 1,
  input: HelpfulPostedInput,
  output: HelpfulChangeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_helpful_posted',
    keywords: ['I posted it', 'post is up', 'post link'],
  },
  scope: inWorkspace,
  emits: ['outreach.helpful.posted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.helpfulId);
    if (row.state === 'posted') {
      // Up already: a link found later is kept.
      if (input.posted && input.url && !row.postUrl)
        await ctx.tx
          .update(helpful)
          .set({ postUrl: input.url, updatedAt: at })
          .where(eq(helpful.id, row.id));
      return { helpfulId: row.id, state: row.state };
    }
    if (row.state !== 'draft' && row.state !== 'approved')
      throw HfosError.rule(
        'outreach_helpful_not_waiting',
        409,
        row.state === 'drafting'
          ? 'The AI is still writing it. It’s here in a minute.'
          : 'It was put aside, so it isn’t noted as posted. Write a new one tomorrow.',
      );
    const change = input.posted
      ? { state: 'posted' as const, postUrl: input.url, postedAt: at, whyNot: null }
      : { state: 'failed' as const, whyNot: input.why, endedAt: at };
    await ctx.tx
      .update(helpful)
      .set({ ...change, updatedAt: at })
      .where(eq(helpful.id, row.id));
    await ctx.emit({
      type: 'outreach.helpful.posted',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { helpfulId: row.id, posted: input.posted },
    });
    return { helpfulId: row.id, state: change.state };
  },
});

export const helpfulEngaged = defineAddonCommand(outreachAddon, {
  name: 'outreach.helpful.engaged',
  description:
    'Who reacted to or commented on one of the person’s helpful posts, as the extension read it: each kept as a profile from the group, a warm lead for Today. Nobody goes in Contacts.',
  risk: 1,
  input: HelpfulEngagedInput,
  output: HelpfulEngagedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.helpful.engaged'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const row = await mine(ctx, me, input.helpfulId);
      if (row.state !== 'posted')
        throw HfosError.rule(
          'outreach_helpful_not_posted',
          409,
          'That helpful post isn’t up yet, so nobody could engage with it.',
        );
      if (input.url && !row.postUrl)
        await ctx.tx
          .update(helpful)
          .set({ postUrl: input.url, updatedAt: at })
          .where(eq(helpful.id, row.id));
      let added = 0;
      const seen = [
        ...input.comments.map((e) => ({ e, kind: 'comment' as const })),
        ...input.reactions.map((e) => ({ e, kind: 'reaction' as const })),
      ];
      for (const { e, kind } of seen) {
        const profile = await keptProfile(
          ctx,
          { platform: row.platform, profile: e.profile, name: e.name },
          me,
          at,
          { groupId: row.groupId },
          (h) => (h.groupId ? {} : { groupId: row.groupId }),
        );
        // The person themselves, answering under their own post, isn't a lead.
        if ((profile.friendship as string) === 'self') continue;
        const [made] = await ctx.tx
          .insert(engagements)
          .values({
            workspaceId: ws,
            userId: me,
            helpfulId: row.id,
            profileId: profile.id,
            kind,
            comment: kind === 'comment' ? e.comment : null,
            seenAt: at,
          })
          .onConflictDoNothing()
          .returning({ id: engagements.id });
        if (made) added++;
      }
      if (added)
        await ctx.emit({
          type: 'outreach.helpful.engaged',
          entityType: 'workspace',
          entityId: ws,
          payload: { helpfulId: row.id, added },
        });
      return { helpfulId: row.id, added };
    });
  },
});

export const helpfulList = defineAddonQuery(outreachAddon, {
  name: 'outreach.helpful',
  description:
    'The person’s helpful posts: today’s (being written, waiting, OK’d, up, put aside or couldn’t go), then the last fortnight’s posted, with who engaged; and their posting choice.',
  input: HelpfulListInput,
  output: HelpfulListOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_helpful_posts',
    keywords: ['helpful post', 'group post', 'who engaged'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const todayFrom = await startOfToday(ctx, now);
    const posts = await shownOf(ctx, me, todayFrom, input.platform);
    const { choices: settings } = await automationOf(ctx, me, now, input.platform);
    return {
      posts,
      today: posts.filter(
        (p) => COUNTED.includes(p.state) && Date.parse(p.askedAt) >= todayFrom.getTime(),
      ).length,
      perDay: HELPFUL_PER_DAY,
      posting: settings.posting,
    };
  },
});

export const helpfulNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.helpful.next',
  description:
    'For the person’s computer: the helpful post to put up (the one OK’d that an ask names, else a draft it posts on its own), and the posts up in the last fortnight to read for who engaged.',
  input: HelpfulNextInput,
  output: HelpfulNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const since = new Date(Date.now() - ENGAGED_DAYS * DAY).toISOString();
    // On its own, it posts nothing until the person is ready (decision 63; their profile never holds it, decision 90);
    // one they OK'd and asked for still goes.
    const holds = !input.helpfulId && !(await readinessFor(ctx, me, input.platform)).ready;
    const [post] = await rows<{
      id: string;
      group_name: string | null;
      group_url: string | null;
      body: string;
    }>(
      ctx.tx,
      sql`select h.id, g.name as group_name, g.url as group_url, h.body from addon_outreach.helpful h
          left join addon_outreach.groups g on g.id = h.group_id
          where h.workspace_id = ${ws} and h.user_id = ${me} and h.body is not null
            and h.platform = ${input.platform}
            and ${
              input.helpfulId
                ? sql`h.id = ${input.helpfulId} and h.state = 'approved'`
                : sql`h.how = 'own' and h.state = 'draft'`
            }
          order by h.asked_at desc limit 1`,
    );
    const read = await rows<{
      id: string;
      group_name: string | null;
      group_url: string | null;
      post_url: string | null;
      body: string;
    }>(
      ctx.tx,
      sql`select h.id, g.name as group_name, g.url as group_url, h.post_url, h.body
          from addon_outreach.helpful h
          left join addon_outreach.groups g on g.id = h.group_id
          where h.workspace_id = ${ws} and h.user_id = ${me} and h.state = 'posted'
            and h.platform = ${input.platform}
            and h.posted_at >= ${since}::timestamptz
          order by h.posted_at desc limit 14`,
    );
    return {
      post:
        post && !holds
          ? {
              helpfulId: post.id,
              groupName: post.group_name,
              groupUrl: post.group_url,
              text: post.body,
            }
          : null,
      read: read.map((h) => ({
        helpfulId: h.id,
        groupName: h.group_name,
        groupUrl: h.group_url,
        postUrl: h.post_url,
        text: h.body.slice(0, 200),
      })),
    };
  },
});

/** Whether the person has a helpful post OK'd for their computer to put up: an ask of kind post names it. */
export async function approvedHelpful(ctx: Ctx, me: string, helpfulId: string) {
  const [row] = await ctx.tx
    .select({ id: helpful.id, state: helpful.state, groupId: helpful.groupId })
    .from(helpful)
    .where(
      and(
        eq(helpful.workspaceId, ctx.scope.workspaceId!),
        eq(helpful.userId, me),
        eq(helpful.id, helpfulId),
        inArray(helpful.state, ['approved']),
      ),
    );
  return row ?? null;
}

export const networkEngaged = defineAddonCommand(outreachAddon, {
  name: 'outreach.engaged.save',
  description:
    'Who liked or commented on the person’s posts and answers, recommended them or started following them, on a network itself, as the extension read its notifications (Alignable’s and Instagram’s): each kept as a profile there, a warm lead for Today. Nobody goes in Contacts.',
  risk: 1,
  input: NetworkEngagedInput,
  output: NetworkEngagedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.engaged.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      let added = 0;
      for (const e of input.engaged) {
        const profile = await keptProfile(
          ctx,
          { platform: input.platform, profile: e.profile, name: e.name },
          me,
          at,
        );
        if ((profile.friendship as string) === 'self') continue;
        // One a person and kind off any helpful post, kept to the latest seen.
        const [kept] = await rows<{ added: boolean }>(
          ctx.tx,
          sql`insert into addon_outreach.engagements
                (workspace_id, user_id, helpful_id, profile_id, kind, comment, seen_at)
              values (${ws}, ${me}, null, ${profile.id}, ${e.kind},
                ${e.kind === 'comment' ? e.comment : null}, ${at.toISOString()}::timestamptz)
              on conflict (workspace_id, user_id, profile_id, kind) where helpful_id is null
                do update set seen_at = greatest(engagements.seen_at, excluded.seen_at),
                  comment = coalesce(excluded.comment, engagements.comment)
              returning (xmax = 0) as added`,
        );
        if (kept?.added) added++;
      }
      if (added)
        await ctx.emit({
          type: 'outreach.engaged.saved',
          entityType: 'workspace',
          entityId: ws,
          payload: { platform: input.platform, added },
        });
      return { added };
    });
  },
});

export const helpfulCommands = [
  helpfulAsk,
  helpfulDraft,
  helpfulOk,
  helpfulSkip,
  helpfulPosted,
  helpfulEngaged,
  networkEngaged,
] as const;
export const helpfulQueries = [helpfulList, helpfulNext] as const;
