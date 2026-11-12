/**
 * What the HandsFreeOS Social extension sends in for AI Social Media Content Creator (docs/socialcontent.md): it takes
 * the next thing the business's reading computer is asked to do, sends what it read (the creators a search found, a
 * creator's profile, their posts), and says how it ended. Only the person picked in Settings → Whose computer reads
 * may: one computer reads for the whole business (decision 12), at a person's pace, sharing each network's pace with
 * Social Outreach inside the extension. None of these is the Assistant's (the server module's `notForTheAssistant`).
 *
 * Saving posts weighs all of the creator's posts again (../standouts.ts), since each post's neighbours change.
 */
import { rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { defineAddonCommand } from '../../server';
import { socialcontentAddon } from '../manifest';
import { CONTENT_NETWORK_INFO, creatorOn, type ContentNetwork } from '../networks';
import {
  CreatorReadInput,
  CreatorsFoundInput,
  CreatorsFoundOutput,
  LIMITS,
  PostsSaveInput,
  PostsSaveOutput,
  Searches,
  WorkFinishInput,
  WorkNextInput,
  WorkNextOutput,
  WorkProgressInput,
  type WorkKind,
} from '../shapes';
import { engagementOf, recentKept } from '../picking';
import { DONE_WELL, doneWell, weighPosts } from '../standouts';
import { creators, posts } from '../tables';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '../words';
import { inWorkspace, queueWork, settingsOf, TAKEN_FOR_MS, type Ctx } from './common';
import type { CommandContext } from '../../../kernel/types';

/** Only the reading computer's person sends these in. */
export async function needReader(ctx: CommandContext): Promise<string> {
  const me = requireHuman(ctx).userId;
  const s = await settingsOf(ctx);
  if (s.readerUserId !== me)
    throw HfosError.rule(
      'socialcontent_not_reader',
      409,
      'This computer doesn’t read for AI Social Media Content Creator here. An owner or admin picks whose computer reads in its Settings.',
    );
  return me;
}

type TakenWork = {
  id: string;
  kind: WorkKind;
  network: ContentNetwork;
  niche_id: string | null;
  creator_id: string | null;
  post_id: string | null;
  since: Date | string | null;
};

/** The work this person's computer has under way, of the kind given (and for a creator, theirs). */
async function takenWork(ctx: Ctx, me: string, workId: string): Promise<TakenWork> {
  const [w] = await rows<TakenWork>(
    ctx.tx,
    sql`select id, kind, network, niche_id, creator_id, post_id, since from addon_socialcontent.work
        where id = ${workId} and workspace_id = ${ctx.scope.workspaceId!} and state = 'taken' and taken_by = ${me}`,
  );
  if (!w)
    throw HfosError.rule(
      'socialcontent_work_gone',
      409,
      'That was stopped, or another computer took it. The extension moves on to the next thing.',
    );
  return w;
}

export const workNext = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.work.next',
  description:
    'Extension: the next thing the business’s reading computer is asked to do, on the networks this build reads, taken so no other computer does it: reading a creator someone ticked or added first, then searches for new creators (where the computer still has room for them today), then the weekly and monthly reads, each oldest first. What it already has under way comes back first (Chrome restarted); what a computer took and never finished goes back to waiting after 2 hours. Null when nothing waits.',
  risk: 0,
  input: WorkNextInput,
  output: WorkNextOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.work.taken'],
  async handler(ctx, input) {
    const me = await needReader(ctx);
    const ws = ctx.scope.workspaceId!;
    const s = await settingsOf(ctx);
    // The page says when the reading computer last asked, and its extension's version (docs: "What it's doing").
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.settings
          set reader_seen_at = now(), reader_version = coalesce(${input.version ?? null}, reader_version)
          where workspace_id = ${ws}`,
    );
    const reads = input.reads.filter((n) => CONTENT_NETWORK_INFO[n].ready);
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.work set state = 'waiting', taken_by = null, taken_at = null
          where workspace_id = ${ws} and state = 'taken'
            and (taken_at < now() - make_interval(secs => ${TAKEN_FOR_MS / 1000}) or taken_by is distinct from ${me}::uuid)`,
    );
    if (!reads.length) return { work: null };
    const list = `{${reads.join(',')}}`;
    // Searches only on networks studied, and where the computer kept room for them today.
    const searched = `{${s.networks.filter((n) => (input.searchOn ?? reads).includes(n)).join(',') || 'none'}}`;
    let [w] = await rows<TakenWork>(
      ctx.tx,
      sql`select id, kind, network, niche_id, creator_id, post_id, since from addon_socialcontent.work
          where workspace_id = ${ws} and state = 'taken' and taken_by = ${me} and network = any(${list}::text[])
          order by taken_at limit 1`,
    );
    if (!w) {
      // A creator someone ticked or added is read before the searches for new ones, and the weekly and monthly reads
      // go last: a search takes a good part of the day's room on a network, so a queue of them kept the ticked ones
      // waiting till the next day (9 Nov 2026).
      [w] = await rows<TakenWork>(
        ctx.tx,
        sql`update addon_socialcontent.work set state = 'taken', taken_by = ${me}, taken_at = now()
            where id = (
              select id from addon_socialcontent.work
              where workspace_id = ${ws} and state = 'waiting' and network = any(${list}::text[])
                and (kind <> 'find' or network = any(${searched}::text[]))
              order by case when asked_for in ('weekly', 'monthly') then 2 when kind = 'find' then 1 else 0 end,
                       created_at
              limit 1
              for update skip locked)
            returning id, kind, network, niche_id, creator_id, post_id, since`,
      );
      if (w)
        await ctx.emit({
          type: 'socialcontent.work.taken',
          entityType: 'socialcontent_work',
          entityId: w.id,
          payload: { kind: w.kind, network: w.network },
          broadcast: false,
        });
    }
    if (!w) return { work: null };
    const [niche] = w.niche_id
      ? await rows<{ id: string; name: string; searches: unknown }>(
          ctx.tx,
          sql`select id, name, searches from addon_socialcontent.niches where id = ${w.niche_id}`,
        )
      : [];
    const [creator] = w.creator_id
      ? await ctx.tx
          .select({
            id: creators.id,
            handle: creators.handle,
            link: creators.link,
            name: creators.name,
          })
          .from(creators)
          .where(eq(creators.id, w.creator_id))
      : [];
    // Passed over by a search: everyone known, but those kept as not fitting only because their profile didn't say
    // when they last posted, with followers enough: they're read again, as their grid's links say it now (9 Nov 2026).
    const known =
      w.kind === 'find'
        ? (
            await rows<{ handle: string }>(
              ctx.tx,
              sql`select handle from addon_socialcontent.creators where workspace_id = ${ws} and network = ${w.network}
                    and not (state = 'didnt_fit' and last_post_at is null
                             and coalesce(followers, 0) >= ${DONE_WELL.followersAtLeast})
                  order by created_at desc limit ${LIMITS.knownAtMost}`,
            )
          ).map((r) => r.handle)
        : [];
    const searches = niche ? (Searches.catch({}).parse(niche.searches)[w.network] ?? []) : [];
    const [post] = w.post_id
      ? await ctx.tx
          .select({
            id: posts.id,
            postKey: posts.postKey,
            link: posts.link,
            seconds: posts.seconds,
          })
          .from(posts)
          .where(eq(posts.id, w.post_id))
      : [];
    return {
      work: {
        id: w.id,
        kind: w.kind,
        network: w.network,
        niche: niche
          ? { id: niche.id, name: niche.name, searches: searches.length ? searches : [niche.name] }
          : null,
        creator: creator ?? null,
        since: w.since ? new Date(w.since).toISOString() : null,
        known,
        most: LIMITS.profilesPerFind,
        post: post ?? null,
      },
    };
  },
});

export const workFinish = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.work.finish',
  description:
    'Extension: how something the reading computer took ended: done, or failed with why in words the person can read. A creator’s posts read through mark them read now.',
  risk: 0,
  input: WorkFinishInput,
  output: z.object({ ok: z.literal(true) }),
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.work.finished'],
  async handler(ctx, input) {
    const me = await needReader(ctx);
    const w = await takenWork(ctx, me, input.workId);
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.work
          set state = ${input.failure ? 'failed' : 'done'}, failure = ${input.failure}, finished_at = now()
          where id = ${w.id}`,
    );
    if (!input.failure && w.kind === 'posts' && w.creator_id)
      await ctx.tx
        .update(creators)
        .set({ postsReadAt: new Date() })
        .where(eq(creators.id, w.creator_id));
    await ctx.emit({
      type: 'socialcontent.work.finished',
      entityType: 'socialcontent_work',
      entityId: w.id,
      payload: { kind: w.kind, network: w.network, failed: Boolean(input.failure) },
    });
    return { ok: true as const };
  },
});

export const workProgress = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.work.progress',
  description:
    'Extension: how something the reading computer took is going, as it goes: what it’s at now, the searches done, and how many accounts it looked at, profiles and posts it read. Shown on the Creators page.',
  risk: 0,
  input: WorkProgressInput,
  output: z.object({ ok: z.literal(true) }),
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.work.progressed'],
  async handler(ctx, input) {
    const me = await needReader(ctx);
    const w = await takenWork(ctx, me, input.workId);
    // What it says replaces what it said before; HandsFreeOS's own counts stay.
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.work
          set progress = coalesce(progress, '{}'::jsonb) || ${JSON.stringify(input.progress)}::jsonb
          where id = ${w.id}`,
    );
    await ctx.emit({
      type: 'socialcontent.work.progressed',
      entityType: 'socialcontent_work',
      entityId: w.id,
      payload: { kind: w.kind, network: w.network },
    });
    return { ok: true as const };
  },
});

/** Adds to HandsFreeOS's own counts on a piece of work's progress. */
async function countOn(
  ctx: Parameters<typeof rows>[0],
  workId: string,
  counts: { suggested: number; didntFit: number },
): Promise<void> {
  if (!counts.suggested && !counts.didntFit) return;
  await rows(
    ctx,
    sql`update addon_socialcontent.work
        set progress = coalesce(progress, '{}'::jsonb) || jsonb_build_object(
          'suggested', coalesce((progress->>'suggested')::int, 0) + ${counts.suggested}::int,
          'didntFit', coalesce((progress->>'didntFit')::int, 0) + ${counts.didntFit}::int)
        where id = ${workId}`,
  );
}

/** "12,400 followers, posted 3 days ago": what a search saw of a creator. */
function sawWords(followers: number | null, lastPostAt: string | null, now: Date): string {
  const parts = [
    followers === null ? null : W.creators.followers(followers),
    lastPostAt ? W.creators.posted(daysAgo(lastPostAt, now) ?? '') : null,
  ].filter(Boolean);
  return parts.join(', ');
}

export const creatorsFound = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.creators.found',
  description:
    'Extension: the creators a search for a niche found on a network, with what each one’s profile showed. Those with 5,000+ followers who posted in the last 30 days are suggested to tick; the rest are kept as not fitting, so they aren’t read again (but for those whose profile didn’t say when they last posted). Anyone already known is left as they are, but for their numbers, and one who didn’t fit and does now is suggested.',
  risk: 0,
  input: CreatorsFoundInput,
  output: CreatorsFoundOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.creators.found'],
  async handler(ctx, input) {
    const me = await needReader(ctx);
    const ws = ctx.scope.workspaceId!;
    const w = await takenWork(ctx, me, input.workId);
    if (w.kind !== 'find')
      throw HfosError.rule('socialcontent_work_kind', 409, 'That isn’t a search for creators.');
    const now = new Date();
    let suggested = 0;
    let didntFit = 0;
    for (const f of input.found) {
      const page = creatorOn(w.network, f.handle.replace(/^@/, '').toLowerCase());
      const good = doneWell(f, now);
      const why = sawWords(f.followers, f.lastPostAt, now) || null;
      // Their latest posts, from extension 0.136.0: kept for the AI to read, and how they do for their followers.
      const recent = f.recent === null ? null : JSON.stringify(recentKept(f.recent));
      const engagement = engagementOf(f.recent, f.followers);
      // Kept as not fitting before, when its profile was read again: suggested now counts as a new suggestion.
      const [before] = await rows<{ state: string }>(
        ctx.tx,
        sql`select state from addon_socialcontent.creators
            where workspace_id = ${ws} and network = ${w.network} and handle = ${page.handle}`,
      );
      const [r] = await rows<{ state: string; created: boolean }>(
        ctx.tx,
        sql`insert into addon_socialcontent.creators
              (workspace_id, network, handle, name, link, bio, followers, last_post_at, niche_id, state, found_by, why,
               profile_read_at, recent, engagement)
            values (${ws}, ${w.network}, ${page.handle}, ${f.name}, ${page.link}, ${f.bio}, ${f.followers},
                    ${f.lastPostAt}::timestamptz, ${w.niche_id}, ${good ? 'suggested' : 'didnt_fit'}, 'search', ${why}, now(),
                    ${recent}::jsonb, ${engagement})
            on conflict (workspace_id, network, handle) do update set
              name = coalesce(excluded.name, addon_socialcontent.creators.name),
              bio = coalesce(excluded.bio, addon_socialcontent.creators.bio),
              followers = coalesce(excluded.followers, addon_socialcontent.creators.followers),
              last_post_at = greatest(excluded.last_post_at, addon_socialcontent.creators.last_post_at),
              profile_read_at = now(),
              recent = coalesce(excluded.recent, addon_socialcontent.creators.recent),
              engagement = case when excluded.recent is not null then excluded.engagement
                                else addon_socialcontent.creators.engagement end,
              -- Someone who didn't fit last time and does now is suggested; nobody else's state changes.
              state = case when addon_socialcontent.creators.state = 'didnt_fit' and excluded.state = 'suggested'
                           then 'suggested' else addon_socialcontent.creators.state end,
              why = case when addon_socialcontent.creators.state in ('didnt_fit', 'suggested')
                         then excluded.why else addon_socialcontent.creators.why end,
              niche_id = coalesce(addon_socialcontent.creators.niche_id, excluded.niche_id)
            returning state, (xmax = 0) as created`,
      );
      if (r?.created) {
        if (r.state === 'suggested') suggested++;
        else didntFit++;
      } else if (before?.state === 'didnt_fit' && r?.state === 'suggested') suggested++;
    }
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.work set done_count = coalesce(done_count, 0) + ${suggested} where id = ${w.id}`,
    );
    await countOn(ctx.tx, w.id, { suggested, didntFit });
    await ctx.emit({
      type: 'socialcontent.creators.found',
      entityType: 'socialcontent_work',
      entityId: w.id,
      payload: { network: w.network, nicheId: w.niche_id, suggested, didntFit },
    });
    return { suggested, didntFit };
  },
});

export const creatorRead = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.creator.read',
  description:
    'Extension: what a creator’s profile shows now: their name, bio, followers and when they last posted.',
  risk: 0,
  input: CreatorReadInput,
  output: z.object({ ok: z.literal(true) }),
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.creator.read'],
  async handler(ctx, input) {
    await needReader(ctx);
    const [c] = await ctx.tx
      .update(creators)
      .set({
        ...(input.name !== null ? { name: input.name } : {}),
        ...(input.bio !== null ? { bio: input.bio } : {}),
        ...(input.followers !== null ? { followers: input.followers } : {}),
        ...(input.lastPostAt !== null
          ? { lastPostAt: dsql`greatest(${creators.lastPostAt}, ${input.lastPostAt}::timestamptz)` }
          : {}),
        // Their latest posts, from extension 0.136.0: how they do for their followers, now.
        ...(input.recent !== null
          ? {
              recent: recentKept(input.recent),
              engagement: engagementOf(input.recent, input.followers),
            }
          : {}),
        profileReadAt: new Date(),
      })
      .where(
        and(eq(creators.id, input.creatorId), eq(creators.workspaceId, ctx.scope.workspaceId!)),
      )
      .returning({ id: creators.id, network: creators.network });
    if (!c) throw HfosError.notFound('That creator isn’t there anymore.');
    await ctx.emit({
      type: 'socialcontent.creator.read',
      entityType: 'socialcontent_creator',
      entityId: c.id,
      payload: { network: c.network },
      broadcast: false,
    });
    return { ok: true as const };
  },
});

export const postsSave = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.posts.save',
  description:
    'Extension: a studied creator’s posts as their page shows them now, up to 100 at a time: each one’s link, when it was posted, its kind, caption and numbers. New posts are kept and known ones get their numbers now; then all of the creator’s posts are weighed again against the 10 posts on each side of each, and the standouts kept.',
  risk: 0,
  input: PostsSaveInput,
  output: PostsSaveOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.posts.saved', 'socialcontent.work.asked'],
  async handler(ctx, input) {
    await needReader(ctx);
    const ws = ctx.scope.workspaceId!;
    const [creator] = await ctx.tx
      .select()
      .from(creators)
      .where(and(eq(creators.id, input.creatorId), eq(creators.workspaceId, ws)));
    if (!creator) throw HfosError.notFound('That creator isn’t there anymore.');
    const unique = [...new Map(input.posts.map((p) => [p.postKey, p])).values()];
    if (unique.length)
      await ctx.tx
        .insert(posts)
        .values(
          unique.map((p) => ({
            workspaceId: ws,
            creatorId: creator.id,
            postKey: p.postKey,
            link: p.link,
            postedAt: new Date(p.postedAt),
            kind: p.kind,
            caption: p.caption,
            views: p.views,
            likes: p.likes,
            comments: p.comments,
            shares: p.shares,
            seconds: p.seconds,
            pinned: p.pinned,
          })),
        )
        .onConflictDoUpdate({
          target: [posts.workspaceId, posts.creatorId, posts.postKey],
          set: {
            link: dsql`excluded.link`,
            kind: dsql`excluded.kind`,
            caption: dsql`coalesce(excluded.caption, ${posts.caption})`,
            views: dsql`coalesce(excluded.views, ${posts.views})`,
            likes: dsql`coalesce(excluded.likes, ${posts.likes})`,
            comments: dsql`coalesce(excluded.comments, ${posts.comments})`,
            shares: dsql`coalesce(excluded.shares, ${posts.shares})`,
            seconds: dsql`coalesce(excluded.seconds, ${posts.seconds})`,
            pinned: dsql`excluded.pinned`,
            readAt: dsql`now()`,
          },
        });
    const all = await ctx.tx
      .select({
        id: posts.id,
        postedAt: posts.postedAt,
        views: posts.views,
        likes: posts.likes,
        comments: posts.comments,
        viewsTimes: posts.viewsTimes,
        engagementTimes: posts.engagementTimes,
        standout: posts.standout,
        standoutOn: posts.standoutOn,
        waiting: posts.waiting,
      })
      .from(posts)
      .where(and(eq(posts.workspaceId, ws), eq(posts.creatorId, creator.id)));
    const weighed = weighPosts(all, new Date());
    const before = new Map(all.map((p) => [p.id, p]));
    const newStandouts: string[] = [];
    for (const w of weighed) {
      const was = before.get(w.id)!;
      if (w.standout && !was.standout) newStandouts.push(w.id);
      const same =
        Number(was.viewsTimes ?? -1) === (w.viewsTimes ?? -1) &&
        Number(was.engagementTimes ?? -1) === (w.engagementTimes ?? -1) &&
        was.standout === w.standout &&
        was.standoutOn === w.on &&
        was.waiting === w.waiting;
      if (same) continue;
      await ctx.tx
        .update(posts)
        .set({
          viewsTimes: w.viewsTimes,
          engagementTimes: w.engagementTimes,
          standout: w.standout,
          standoutOn: w.on,
          waiting: w.waiting,
        })
        .where(eq(posts.id, w.id));
    }
    const standouts = weighed.filter((w) => w.standout).length;
    const latest = all.reduce<Date | null>(
      (m, p) => (m === null || p.postedAt > m ? p.postedAt : m),
      null,
    );
    await ctx.tx
      .update(creators)
      .set({
        postsCount: all.length,
        standoutsCount: standouts,
        ...(latest
          ? {
              lastPostAt: dsql`greatest(${creators.lastPostAt}, ${latest.toISOString()}::timestamptz)`,
            }
          : {}),
      })
      .where(eq(creators.id, creator.id));
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.work set done_count = coalesce(done_count, 0) + ${unique.length}
          where workspace_id = ${ws} and creator_id = ${creator.id} and kind = 'posts' and state = 'taken'`,
    );
    // Watching is on: each new standout video is watched too (decision 9, off until an owner turns it on).
    const s = await settingsOf(ctx);
    if (
      s.watchVideos &&
      newStandouts.length &&
      CONTENT_NETWORK_INFO[creator.network as ContentNetwork]?.watches
    ) {
      const videos = await ctx.tx
        .select({ id: posts.id })
        .from(posts)
        .where(
          and(
            eq(posts.workspaceId, ws),
            eq(posts.creatorId, creator.id),
            eq(posts.kind, 'video'),
            dsql`${posts.id} = any(${`{${newStandouts.join(',')}}`}::uuid[])`,
            dsql`${posts.watchedAt} is null`,
          ),
        );
      if (videos.length)
        await queueWork(
          ctx,
          videos.map((v) => ({
            kind: 'watch' as const,
            network: creator.network as ContentNetwork,
            creatorId: creator.id,
            postId: v.id,
          })),
          'standout',
          null,
        );
    }
    await ctx.emit({
      type: 'socialcontent.posts.saved',
      entityType: 'socialcontent_creator',
      entityId: creator.id,
      payload: {
        network: creator.network,
        saved: unique.length,
        standouts,
        newStandouts,
      },
      broadcast: newStandouts.length > 0,
    });
    return { saved: unique.length, standouts, newStandouts };
  },
});

export const readingCommands = [
  workNext,
  workFinish,
  workProgress,
  creatorsFound,
  creatorRead,
  postsSave,
] as const;

/** Why none of these is the Assistant's. */
export const EXTENSION =
  'The HandsFreeOS Social extension sends this in from the reading computer, as it reads the networks; a person never does.';
