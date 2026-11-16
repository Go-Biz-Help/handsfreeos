/**
 * Comment research (../comment-research.ts, docs/outreach.md decision 166), server side: HandsFreeOS's own, so every
 * part a person runs is for HandsFreeOS staff who may change what the AI is told (`platform.ai.manage`), and the
 * database holds the same (the tables' staff policies, and the guide's definers).
 *
 * - **Staff, on Social Outreach → Settings:** each network's newest research and the guide in use there (`get`),
 *   Start (every network at once, decision 171, or one), Stop and sum up, and Use it in every business's comments on
 *   that network or take it out again.
 * - **The browser of whoever started it:** what to read next on a network (`next`: nothing for anyone else, and
 *   nothing once today's share is read), and a search's posts read (`save`: each comment's words sorted and scrubbed
 *   here again, whatever the browser sent).
 * - **The worker:** what it found, once it's read (`sum`).
 *
 * Server-only.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  commentGuide,
  CommentFindings,
  CommentResearchGetInput,
  CommentResearchNextInput,
  CommentResearchNextOutput,
  CommentResearchOutput,
  CommentResearchSaveInput,
  CommentResearchSaveOutput,
  CommentResearchStartInput,
  CommentResearchStopInput,
  CommentResearchSumInput,
  CommentResearchSumOutput,
  CommentResearchUseInput,
  nextTags,
  RESEARCH_DAYS,
  RESEARCH_MIN_TO_SUM,
  RESEARCH_PLATFORMS,
  RESEARCH_POSTS_A_TAG,
  RESEARCH_TARGET,
  researchEnds,
  researchNetworkName,
  researchRoom,
  sortComments,
  topicOfTag,
  type CommentResearch,
  type CommentResearchNetwork,
  type ResearchPlatform,
  type ResearchState,
} from '../comment-research';
import { outreachAddon } from '../manifest';
import { commentResearch } from '../tables';
import { inWorkspace, type Ctx } from './common';

/** The staff permission that runs it: it changes what the AI is told for every business. */
const STAFF = 'platform.ai.manage';
const CHANGED = 'outreach.comment_research.changed';

type Row = typeof commentResearch.$inferSelect;

/** Whether the signed-in person is HandsFreeOS staff who run it. Asked of the database, which is what enforces it. */
async function staffRuns(ctx: Ctx): Promise<boolean> {
  const [row] = await rows<{ ok: boolean }>(ctx.tx, sql`select private.staff_can(${STAFF}) as ok`);
  return row?.ok === true;
}

async function requireStaff(ctx: Ctx): Promise<void> {
  if (!(await staffRuns(ctx)))
    throw HfosError.rule(
      'outreach_research_staff',
      403,
      'Comment research is HandsFreeOS’s own study of how people comment. Only HandsFreeOS staff can run it, and no business needs to.',
    );
}

const shown = (r: Row, me: string | null): CommentResearch => {
  const findings = r.findings ? CommentFindings.safeParse(r.findings) : null;
  return {
    id: r.id,
    platform: r.platform,
    state: r.state,
    mine: r.userId === me,
    startedAt: new Date(r.startedAt).toISOString(),
    endsAt: researchEnds({ days: r.days, startedAt: new Date(r.startedAt) }).toISOString(),
    target: r.target,
    days: r.days,
    kept: r.kept,
    dropped: r.dropped,
    posts: r.posts,
    findings: findings?.success ? findings.data : null,
    guide: r.guide,
  };
};

/** One network's newest research here and the guide in use on it, as the card shows them. */
async function networkCard(
  ctx: Ctx,
  me: string | null,
  platform: ResearchPlatform,
): Promise<CommentResearchNetwork> {
  const [newest] = await ctx.tx
    .select()
    .from(commentResearch)
    .where(
      and(
        eq(commentResearch.workspaceId, ctx.scope.workspaceId!),
        eq(commentResearch.platform, platform),
      ),
    )
    .orderBy(desc(commentResearch.createdAt), desc(commentResearch.id))
    .limit(1);
  const [used] = await rows<{
    guide: string;
    comments: number;
    research_id: string | null;
    used_at: Date | string;
  }>(
    ctx.tx,
    sql`select guide, comments, research_id, used_at from private.comment_guide_in_use(${platform})`,
  );
  return {
    platform,
    research: newest ? shown(newest, me) : null,
    inUse: used
      ? {
          guide: used.guide,
          comments: used.comments,
          usedAt: new Date(used.used_at).toISOString(),
          thisOne: !!newest && used.research_id === newest.id,
        }
      : null,
  };
}

/** Every network's newest research here and the guide in use on it, as the card shows them. */
async function card(ctx: Ctx, me: string | null): Promise<CommentResearchOutput> {
  const networks: CommentResearchNetwork[] = [];
  for (const platform of RESEARCH_PLATFORMS) networks.push(await networkCard(ctx, me, platform));
  return { networks };
}

async function changed(ctx: CommandContext, id: string, state: ResearchState): Promise<void> {
  await ctx.emit({
    type: CHANGED,
    entityType: 'workspace',
    entityId: ctx.scope.workspaceId!,
    payload: { id, state },
  });
}

async function researchOr404(ctx: Ctx, id: string): Promise<Row> {
  const [row] = await ctx.tx
    .select()
    .from(commentResearch)
    .where(and(eq(commentResearch.workspaceId, ctx.scope.workspaceId!), eq(commentResearch.id, id)))
    .limit(1);
  if (!row)
    throw HfosError.notFound(
      'That comment research isn’t there anymore. Open Social Outreach → Settings again to see the newest one.',
    );
  return row;
}

export const commentResearchGet = defineAddonQuery(outreachAddon, {
  name: 'outreach.comment_research.get',
  description:
    'HandsFreeOS staff only: on each network (Instagram, Facebook, LinkedIn, Alignable, Threads and X), the newest comment research run from this business (where it stands, how many real comments it kept and left out, and what it found), and the comment guide every business’s comments there are written with now, if one is in use.',
  input: CommentResearchGetInput,
  output: CommentResearchOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    await requireStaff(ctx);
    return card(ctx, requireHuman(ctx).userId);
  },
});

export const commentResearchStart = defineAddonCommand(outreachAddon, {
  name: 'outreach.comment_research.start',
  description:
    'HandsFreeOS staff only: start a comment research, on every network with none running (or on the one named). Over 3 days the browser of the person who starts it reads about 2,000 real comments a network under posts of many kinds, a little at a time, keeping each comment’s words only (never who wrote it or the post) and leaving out ones that read like a bot’s. One at a time a network.',
  risk: 1,
  input: CommentResearchStartInput,
  output: CommentResearchOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [CHANGED],
  async handler(ctx, input) {
    await requireStaff(ctx);
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const open = new Set(
      (
        await rows<{ platform: ResearchPlatform }>(
          ctx.tx,
          sql`select platform from addon_outreach.comment_research
              where workspace_id = ${ws} and state in ('reading', 'summing')`,
        )
      ).map((r) => r.platform),
    );
    const asked = input.platform ? [input.platform] : RESEARCH_PLATFORMS;
    const starting = asked.filter((platform) => !open.has(platform));
    if (!starting.length)
      throw HfosError.rule(
        'outreach_research_running',
        409,
        input.platform
          ? `A comment research is already running on ${researchNetworkName(input.platform)}. Press Stop and sum up what it has, or wait for it to finish, then start another.`
          : 'A comment research is already running on every network. Press Stop and sum up what it has on one, or wait for them to finish, then start again.',
      );
    const started = await ctx.tx
      .insert(commentResearch)
      .values(
        starting.map((platform) => ({
          workspaceId: ws,
          userId: me,
          platform,
          state: 'reading' as const,
          target: RESEARCH_TARGET,
          days: RESEARCH_DAYS,
          startedAt: at,
          createdAt: at,
          updatedAt: at,
        })),
      )
      .returning({ id: commentResearch.id });
    for (const row of started) await changed(ctx, row.id, 'reading');
    return card(ctx, me);
  },
});

export const commentResearchStop = defineAddonCommand(outreachAddon, {
  name: 'outreach.comment_research.stop',
  description:
    'HandsFreeOS staff only: stop a comment research that is still reading. With 100 comments or more kept, the AI sums up what it has; with fewer, it is only stopped.',
  risk: 1,
  input: CommentResearchStopInput,
  output: CommentResearchOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [CHANGED],
  async handler(ctx, input) {
    await requireStaff(ctx);
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await researchOr404(ctx, input.id);
    if (row.state !== 'reading') return card(ctx, me);
    const state: ResearchState = row.kept >= RESEARCH_MIN_TO_SUM ? 'summing' : 'stopped';
    await ctx.tx
      .update(commentResearch)
      .set({ state, endedAt: at, updatedAt: at })
      .where(and(eq(commentResearch.id, row.id), eq(commentResearch.state, 'reading')));
    await changed(ctx, row.id, state);
    return card(ctx, me);
  },
});

export const commentResearchUse = defineAddonCommand(outreachAddon, {
  name: 'outreach.comment_research.use',
  description:
    'HandsFreeOS staff only: put a finished comment research’s guide in every business’s comments on its network (how real comments sound there: their length, words and punctuation), in place of the guide in use on that network; or take the guide in use there out again.',
  risk: 2,
  input: CommentResearchUseInput,
  output: CommentResearchOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [CHANGED],
  async handler(ctx, input) {
    await requireStaff(ctx);
    const me = requireHuman(ctx).userId;
    const row = await researchOr404(ctx, input.id);
    if (!input.use) {
      await ctx.tx.execute(sql`select private.stop_comment_guide(${row.platform})`);
    } else {
      const findings = row.findings ? CommentFindings.safeParse(row.findings) : null;
      if (row.state !== 'done' || !row.guide || !findings?.success)
        throw HfosError.rule(
          'outreach_research_not_done',
          409,
          'This research has no guide yet. Wait for it to finish reading and for the AI to sum it up, then press Use in everyone’s comments.',
        );
      await ctx.tx.execute(
        sql`select private.use_comment_guide(${row.platform}, ${row.guide}, ${findings.data.comments}::int, ${row.id}::uuid)`,
      );
    }
    await changed(ctx, row.id, row.state);
    return card(ctx, me);
  },
});

export const commentResearchNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.comment_research.next',
  description:
    'What the person’s computer reads next on a network for the comment research they started there, if they started one: the next hashtags or search words (none once today’s share of the comments is read, so it spreads over its days). Nothing for anyone who didn’t start one.',
  input: CommentResearchNextInput,
  output: CommentResearchNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    // Row security shows a research to HandsFreeOS staff only, so anyone else has none.
    const [run] = await ctx.tx
      .select()
      .from(commentResearch)
      .where(
        and(
          eq(commentResearch.workspaceId, ctx.scope.workspaceId!),
          eq(commentResearch.platform, input.platform),
          eq(commentResearch.userId, me),
          eq(commentResearch.state, 'reading'),
        ),
      )
      .limit(1);
    if (!run) return { research: null };
    const now = new Date();
    const startedAt = new Date(run.startedAt);
    // Past its days it waits for the worker to sum it up.
    if (now >= researchEnds({ days: run.days, startedAt })) return { research: null };
    const room = researchRoom(
      { target: run.target, days: run.days, kept: run.kept, startedAt },
      now,
    );
    return {
      research: {
        id: run.id,
        tags: room > 0 ? nextTags(run.platform, run.tags) : [],
        postsEach: RESEARCH_POSTS_A_TAG,
        kept: run.kept,
        target: run.target,
      },
    };
  },
});

export const commentResearchSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.comment_research.save',
  description:
    'A search’s posts (a hashtag, search words or an Alignable place) the person’s computer read for the comment research they started, each with the comments it showed. Only a comment’s words are kept, with the kind of post: nobody’s name, no link, and nothing that reads like a bot’s or an advert’s. Once enough are kept, the AI sums up how they’re written.',
  risk: 0,
  input: CommentResearchSaveInput,
  output: CommentResearchSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [CHANGED],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [run] = await rows<{
      id: string;
      platform: ResearchPlatform;
      state: ResearchState;
      kept: number;
      target: number;
    }>(
      ctx.tx,
      sql`select id, platform, state, kept, target from addon_outreach.comment_research
          where workspace_id = ${ws} and id = ${input.id} and user_id = ${me}
          for update`,
    );
    if (!run || run.state !== 'reading')
      return { kept: 0, dropped: 0, total: run?.kept ?? 0, reading: false };
    const topic = topicOfTag(run.platform, input.tag);
    if (!topic)
      throw HfosError.rule(
        'outreach_research_tag',
        422,
        `“${input.tag}” isn’t one of the comment research’s searches on ${researchNetworkName(run.platform)}, so nothing from it was kept. Update the extension and it reads the right ones.`,
      );
    // Each post's comments once, sorted here whatever the browser sent; the same words under several posts count up.
    const counts = new Map<string, { w: string; n: number }>();
    let dropped = 0;
    for (const post of input.posts) {
      const sorted = sortComments(post.comments);
      dropped += sorted.dropped + post.dropped;
      for (const words of sorted.kept) {
        const key = words.toLowerCase();
        const had = counts.get(key);
        if (had) had.n++;
        else counts.set(key, { w: words, n: 1 });
      }
    }
    // Never past what it set out to keep.
    const room = Math.max(0, run.target - run.kept);
    const list: { w: string; n: number }[] = [];
    let kept = 0;
    for (const c of counts.values()) {
      if (kept >= room) break;
      const n = Math.min(c.n, room - kept);
      list.push({ w: c.w, n });
      kept += n;
    }
    if (list.length)
      await ctx.tx.execute(
        sql`insert into addon_outreach.comment_samples as s
              (workspace_id, research_id, topic, words, words_key, seen, created_at)
            select ${ws}::uuid, ${run.id}::uuid, ${topic}, min(x.w), md5(lower(x.w)), sum(x.n)::int,
              ${at.toISOString()}::timestamptz
            from jsonb_to_recordset(${JSON.stringify(list)}::jsonb) as x(w text, n integer)
            group by md5(lower(x.w))
            on conflict (research_id, words_key) do update set seen = s.seen + excluded.seen`,
      );
    const total = run.kept + kept;
    const full = total >= run.target;
    await ctx.tx.execute(
      sql`update addon_outreach.comment_research
          set kept = ${total}, dropped = dropped + ${dropped}, posts = posts + ${input.posts.length},
            tags = case when ${input.tag} = any (tags) or cardinality(tags) >= 400 then tags
                        else array_append(tags, ${input.tag}) end,
            state = ${full ? 'summing' : 'reading'},
            ended_at = ${full ? sql`${at.toISOString()}::timestamptz` : sql`null`},
            updated_at = ${at.toISOString()}::timestamptz
          where workspace_id = ${ws} and id = ${run.id}`,
    );
    if (full) await changed(ctx, run.id, 'summing');
    return { kept, dropped, total, reading: !full };
  },
});

export const commentResearchSum = defineAddonCommand(outreachAddon, {
  name: 'outreach.comment_research.sum',
  description:
    'Worker: what a comment research found once its reading ended (how real comments are written, counted, with the AI’s patterns and real examples by kind of post), kept with the guide made from it; or, with too few comments to learn from, the research stopped.',
  risk: 0,
  input: CommentResearchSumInput,
  output: CommentResearchSumOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [CHANGED],
  async handler(ctx, input) {
    const at = changeMoment(ctx.meta);
    const row = await researchOr404(ctx, input.id);
    if (row.state !== 'reading' && row.state !== 'summing') return { id: row.id, state: row.state };
    const state: ResearchState = input.findings ? 'done' : 'stopped';
    await ctx.tx
      .update(commentResearch)
      .set({
        state,
        findings: input.findings,
        guide: input.findings ? commentGuide(input.findings, row.platform) : null,
        endedAt: row.endedAt ?? at,
        updatedAt: at,
      })
      .where(eq(commentResearch.id, row.id));
    await changed(ctx, row.id, state);
    return { id: row.id, state };
  },
});

export const commentResearchCommands = [
  commentResearchStart,
  commentResearchStop,
  commentResearchUse,
  commentResearchSave,
  commentResearchSum,
] as const;
export const commentResearchQueries = [commentResearchGet, commentResearchNext] as const;
