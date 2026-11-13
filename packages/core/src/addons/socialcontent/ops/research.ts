/**
 * What a person does on AI Social Media Content Creator's pages (docs/socialcontent.md): the niches searched, the
 * creators studied, their posts and standouts, asking the reading computer to find or read now, and the settings.
 * Everyone with `socialcontent.use` picks niches and creators (one list for the whole business, decision 12); owners
 * and admins (`socialcontent.manage`) pick the networks and whose computer reads.
 */
import { rows, sql } from '@hfos/db/client';
import { and, asc, desc, eq, lt, sql as dsql } from 'drizzle-orm';
import type { z } from 'zod';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { socialcontentAddon } from '../manifest';
import { CONTENT_NETWORK_INFO, creatorFromLink, handleShown, networkName } from '../networks';
import {
  CreatorAddInput,
  CreatorDecideInput,
  CreatorListInput,
  CreatorListOutput,
  Creator as CreatorOut,
  FindNowInput,
  FindNowOutput,
  InWorkspace,
  LIMITS,
  Niche as NicheOutShape,
  NicheAddInput,
  NicheDecideInput,
  NicheListOutput,
  OverviewOutput,
  PostListInput,
  PostListOutput,
  ReadNowInput,
  ReadNowOutput,
  Settings as SettingsOut,
  SettingsSaveInput,
  Work as WorkOutShape,
  WorkStopInput,
} from '../shapes';
import { creators, niches, posts, settings } from '../tables';
import { SOCIALCONTENT_WORDS as W } from '../words';
import {
  creatorOut,
  inWorkspace,
  mayManage,
  nameOf,
  needReady,
  nicheOut,
  postOut,
  queueWork,
  readSince,
  settingsOf,
  timeZoneOf,
  WORK_SELECT,
  workOut,
  type Ctx,
  type WorkRow,
} from './common';
import {
  CALENDAR,
  networkPlanOf,
  POSTING_NETWORKS,
  type NetworkPlan,
  type PostingNetwork,
} from '../calendar';
import { learnedShown } from '../schedule';
import { learnedTimesOf } from './schedule';
import { setupFactsOf } from './setup';
import { parseClock } from '../../../calendar/engine/zoned';

const NO_READER =
  'No computer reads the networks yet. An owner or admin picks one in AI Social Media Content Creator → Settings → Whose computer reads, with the HandsFreeOS Social extension in Chrome.';

async function settingsShown(ctx: Ctx) {
  const s = await settingsOf(ctx);
  return { ...s, readerName: await nameOf(ctx, s.readerUserId) };
}

async function loadNiche(ctx: Ctx, nicheId: string) {
  const [n] = await ctx.tx
    .select()
    .from(niches)
    .where(and(eq(niches.id, nicheId), eq(niches.workspaceId, ctx.scope.workspaceId!)));
  if (!n)
    throw HfosError.notFound(
      'That niche isn’t there anymore. Refresh the page to see the ones there are.',
    );
  return n;
}

async function loadCreator(ctx: Ctx, creatorId: string) {
  const [c] = await ctx.tx
    .select()
    .from(creators)
    .where(and(eq(creators.id, creatorId), eq(creators.workspaceId, ctx.scope.workspaceId!)));
  if (!c)
    throw HfosError.notFound(
      'That creator isn’t there anymore. Refresh the page to see the ones there are.',
    );
  return c;
}

/** One creator as the pages show them. */
async function creatorShown(ctx: Ctx, creatorId: string) {
  const c = await loadCreator(ctx, creatorId);
  const [more] = await rows<{ niche_name: string | null; reading: boolean }>(
    ctx.tx,
    sql`select (select name from addon_socialcontent.niches where id = ${c.nicheId}) as niche_name,
               exists (select 1 from addon_socialcontent.work w where w.creator_id = ${c.id}
                       and w.state in ('waiting', 'taken')) as reading`,
  );
  return creatorOut(c, { nicheName: more?.niche_name ?? null, reading: more?.reading ?? false });
}

// ------------------------------------------------------------------------------------------------ overview

export const overview = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.overview',
  description:
    'How content research stands: the networks studied, whose computer reads them, how many creators are suggested, studied and skipped, how many standout posts there are, what the reading computer was asked to do lately (each with how it went), and how setting up on its own stands.',
  input: InWorkspace,
  output: OverviewOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_overview',
    description:
      'How AI Social Media Content Creator stands here: the networks studied, whose computer reads them (it works in Chrome with the HandsFreeOS Social extension), counts of creators suggested, studied and skipped, the number of standout posts, the reading computer’s recent work (finding creators, reading profiles and posts), each with its state and, when it didn’t work, why, and `setup`: how setting up on its own stands (niches ticked, searches left, creators studied on each network of the 10 it picks, standouts noted, the Playbook, and whether writing waits on the main offer, its lists for content or the Playbook).',
  },
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const s = await settingsShown(ctx);
    const [counts] = await rows<{
      suggested: number;
      studying: number;
      skipped: number;
      standouts: number;
      waiting: number;
    }>(
      ctx.tx,
      sql`select
            (select count(*)::int from addon_socialcontent.creators where workspace_id = ${ws} and state = 'suggested') as suggested,
            (select count(*)::int from addon_socialcontent.creators where workspace_id = ${ws} and state = 'studying') as studying,
            (select count(*)::int from addon_socialcontent.creators where workspace_id = ${ws} and state = 'skipped') as skipped,
            (select count(*)::int from addon_socialcontent.posts where workspace_id = ${ws} and standout) as standouts,
            (select count(*)::int from addon_socialcontent.work where workspace_id = ${ws} and state in ('waiting', 'taken')) as waiting`,
    );
    const recent = await rows<WorkRow>(
      ctx.tx,
      sql`${WORK_SELECT} where w.workspace_id = ${ws} order by w.created_at desc limit 20`,
    );
    return {
      settings: s,
      readerIsMe: s.readerUserId === me,
      mayManage: mayManage(ctx),
      counts: counts ?? { suggested: 0, studying: 0, skipped: 0, standouts: 0, waiting: 0 },
      work: recent.map(workOut),
      learned: learnedShown(s.plan, await learnedTimesOf(ctx.tx, ws, await timeZoneOf(ctx))),
      setup: await setupFactsOf(ctx.tx, ws),
    };
  },
});

/**
 * The plan with a change to some networks (decisions 21, 22 and 24): only the parts given change. Refused, saying
 * what to change, when the hours are under an hour apart or the posts a week don't fit the most a day.
 */
export function planChanged(
  was: Readonly<Record<PostingNetwork, NetworkPlan>>,
  change: Readonly<Partial<Record<PostingNetwork, Partial<NetworkPlan>>>>,
): Record<PostingNetwork, NetworkPlan> {
  const out = { ...was };
  for (const n of POSTING_NETWORKS) {
    const c = change[n];
    if (!c) continue;
    const next = { ...was[n], ...c };
    const name = networkName(n);
    if (parseClock(next.to) - parseClock(next.from) < CALENDAR.windowLeastMinutes)
      throw HfosError.rule(
        'socialcontent_plan_hours',
        400,
        `The hours for ${name} need to be at least an hour apart, with the first before the last. Change From or To under ${name} in Settings → Posting.`,
      );
    const most = 7 * (next.perDay ?? CALENDAR.perDayMost);
    if (next.perWeek > most)
      throw HfosError.rule(
        'socialcontent_plan_per_day',
        400,
        `${next.perWeek} posts a week on ${name} don’t fit in ${next.perDay ?? CALENDAR.perDayMost} a day at most (that’s ${most} a week). Pick fewer a week, or a higher most a day, in Settings → Posting.`,
      );
    out[n] = networkPlanOf(next, was[n]);
  }
  return out;
}

export const settingsSave = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.settings.save',
  description:
    'Change content research’s settings: the networks creators are looked for and read on (TikTok and YouTube come in later updates), whose computer does the reading (a person on the team with the HandsFreeOS Social extension in Chrome; null for none), whether new standout videos are watched (frames and sound; it uses a lot more AI, so it starts off), the calendar’s plan for the business’s own posts (for each of Instagram, Facebook, LinkedIn, Threads and X: AI picks, with posts a week, the most a day and the hours it posts between, or I pick, with the times on each weekday), the business’s Facebook Page, where its Facebook posts go (the profile, the Page or both), whether the AI fills the calendar on its own (off stops it, a fill under way too; on fills the open days right away), and whether it picks niches and creators on its own (the business’s own niche and the 2 closest, and the best 10 creators on each network, swapped once a month). What isn’t given stays as it is.',
  risk: 1,
  input: SettingsSaveInput,
  output: SettingsOut,
  permission: 'socialcontent.manage',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_save_settings',
    autonomy: 'confirm',
    what: (input) => {
      const i = input as Partial<z.infer<typeof SettingsSaveInput>>;
      const parts = [
        i.networks ? 'the networks it studies' : null,
        i.readerUserId !== undefined ? 'whose computer reads' : null,
        i.watchVideos === true ? 'turn on watching videos (it uses a lot more AI)' : null,
        i.watchVideos === false ? 'turn off watching videos' : null,
        i.plan ? 'the calendar’s plan' : null,
        i.facebookPage !== undefined ? 'the Facebook Page' : null,
        i.facebookWhere ? 'where Facebook posts go' : null,
        i.autoFill === false ? 'stop filling the calendar on its own' : null,
        i.autoFill === true
          ? 'fill the calendar on its own again (it fills the open days now)'
          : null,
        i.autoPick === false ? 'stop picking niches and creators on its own' : null,
        i.autoPick === true ? 'pick niches and creators on its own' : null,
      ].filter((p): p is string => !!p);
      return parts.length
        ? `Change AI Social Media Content Creator’s settings: ${parts.join(', ')}`
        : 'Change AI Social Media Content Creator’s settings';
    },
    description:
      'Change AI Social Media Content Creator’s settings: `networks`, the networks creators are looked for and read on, `readerUserId`, the team member whose computer reads them in Chrome with the HandsFreeOS Social extension (null for none), `watchVideos`, whether new standout videos are watched (it uses about 10 to 20 times the AI of notes alone for each video, so say so before turning it on), `plan`, the calendar’s plan for each network given, only the parts that change: `mode` "ai" (AI picks the days and hours: `perWeek` 0 to 21, `perDay` the most in one day 1 to 3 or null to spread them out, `from` and `to` the hours it posts between as HH:MM, at least an hour apart) or "mine" (the person picks: `week`, 7 lists of HH:MM times, Sunday first, up to 3 a day); all in the business’s time zone; posts that haven’t gone up move to the AI’s hours when the hours change, `facebookPage`, the business’s Facebook Page link (null for none), `facebookWhere`, where its Facebook posts go (["profile"], ["page"] or both), and `autoFill`, whether the AI fills the calendar on its own (false stops it, a fill under way too, and the posts already written stay; true fills the open days in the next two weeks right away, then tops up once a week), and `autoPick`, whether it picks niches and creators on its own (true: it ticks the business’s own niche and the 2 closest, and studies the best 10 creators on each network, swapping out quiet ones once a month, never ones a person ticked or added; false: a person ticks them). Leave out what doesn’t change.',
    outcome: () => ({ words: W.settings.saved, path: 'a/socialcontent/settings' }),
  },
  emits: ['socialcontent.settings.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    for (const n of input.networks ?? []) needReady(n);
    if (input.readerUserId) {
      const [held] = await rows<{ role: string; permissions: string[] | null }>(
        ctx.tx,
        sql`select role, permissions from private.workspace_member_permissions(${ws}::uuid)
            where user_id = ${input.readerUserId}::uuid`,
      );
      if (
        !held ||
        (held.role !== 'owner' && !(held.permissions ?? []).includes('socialcontent.use'))
      ) {
        const who = (await nameOf(ctx, input.readerUserId)) ?? 'That person';
        throw HfosError.rule(
          'socialcontent_reader_cant_use',
          409,
          held
            ? `${who} can’t use AI Social Media Content Creator, so their computer can’t read for it. Give them Use AI Social Media Content Creator in Settings → Permissions first, or pick someone else.`
            : `${who} isn’t on this business’s team. Pick someone who is.`,
        );
      }
    }
    const was = await settingsOf(ctx);
    const plan = input.plan ? planChanged(was.plan, input.plan) : was.plan;
    const facebookPage = input.facebookPage === undefined ? was.facebookPage : input.facebookPage;
    const facebookWhere = input.facebookWhere
      ? [...new Set(input.facebookWhere)]
      : was.facebookWhere.length
        ? was.facebookWhere
        : ['profile' as const];
    const networks = input.networks ? [...new Set(input.networks)] : was.networks;
    const readerUserId = input.readerUserId === undefined ? was.readerUserId : input.readerUserId;
    const watchVideos = input.watchVideos ?? was.watchVideos;
    const autoFill = input.autoFill ?? was.autoFill;
    const autoPick = input.autoPick ?? was.autoPick;
    // Another computer reads now: when the last one checked in says nothing about it.
    const readerChanged = readerUserId !== was.readerUserId;
    const seen = readerChanged
      ? { readerSeenAt: null, readerVersion: null }
      : { readerSeenAt: was.readerSeenAt, readerVersion: was.readerVersion };
    await ctx.tx
      .insert(settings)
      .values({
        workspaceId: ws,
        networks,
        readerUserId,
        watchVideos,
        plan,
        facebookPage,
        facebookWhere,
        autoFill,
        autoPick,
        updatedBy: me,
      })
      .onConflictDoUpdate({
        target: settings.workspaceId,
        set: {
          networks,
          readerUserId,
          watchVideos,
          plan,
          facebookPage,
          facebookWhere,
          autoFill,
          autoPick,
          ...(readerChanged ? { readerSeenAt: null, readerVersion: null } : {}),
          updatedBy: me,
          updatedAt: changeMoment(ctx.meta),
        },
      });
    await ctx.emit({
      type: 'socialcontent.settings.saved',
      entityType: 'socialcontent_settings',
      payload: {
        networks,
        readerChanged,
        watchVideos,
        planChanged: input.plan !== undefined,
        autoFill,
        // Turned back on: the worker fills the open days right away.
        fillTurnedOn: autoFill && !was.autoFill,
        // A reading computer picked, or picking on its own turned on: setting up goes on (decision 28).
        readerPicked: readerChanged && readerUserId !== null,
        pickTurnedOn: autoPick && !was.autoPick,
      },
    });
    return {
      networks,
      readerUserId,
      watchVideos,
      readerName: await nameOf(ctx, readerUserId),
      ...seen,
      plan,
      facebookPage,
      facebookWhere,
      autoFill,
      autoPick,
    };
  },
});

// ------------------------------------------------------------------------------------------------ niches

export const nicheList = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.niche.list',
  description:
    'The niches content research looks in: the business’s own, then the similar ones, each searched, skipped or only suggested so far, with why the AI thinks it’s like the business’s and the words searched on each network.',
  input: InWorkspace,
  output: NicheListOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_list_niches' },
  async handler(ctx) {
    const all = await ctx.tx
      .select()
      .from(niches)
      .where(eq(niches.workspaceId, ctx.scope.workspaceId!))
      .orderBy(desc(niches.own), asc(niches.createdAt));
    return { niches: all.map(nicheOut) };
  },
});

export const nicheAdd = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.niche.add',
  description:
    'Add a niche for content research to look in for creators, ticked to be searched. The AI writes the words to search each network for it.',
  risk: 1,
  input: NicheAddInput,
  output: NicheOutShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_add_niche',
    outcome: (output) => ({
      words: W.niches.added(String((output as { name?: unknown }).name ?? '')),
      path: 'a/socialcontent/creators',
    }),
  },
  emits: ['socialcontent.niche.added'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [{ n } = { n: 0 }] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_socialcontent.niches where workspace_id = ${ws}`,
    );
    if (n >= LIMITS.niches)
      throw HfosError.rule(
        'socialcontent_too_many_niches',
        409,
        `There are already ${LIMITS.niches} niches. Skip the ones you don’t need under Creators → Niches before adding more.`,
      );
    let made: typeof niches.$inferSelect;
    try {
      [made] = (await ctx.tx
        .insert(niches)
        .values({ workspaceId: ws, name: input.name, state: 'picked', addedBy: me, decidedBy: me })
        .returning()) as [typeof niches.$inferSelect];
    } catch (e) {
      if (isUniqueViolation(e, 'niches_name_idx'))
        throw HfosError.rule(
          'socialcontent_niche_taken',
          409,
          `${W.niches.nameTaken(input.name)} Tick it under Creators → Niches.`,
        );
      throw e;
    }
    await ctx.emit({
      type: 'socialcontent.niche.added',
      entityType: 'socialcontent_niche',
      entityId: made.id,
      payload: { name: made.name },
    });
    return nicheOut(made);
  },
});

export const nicheDecide = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.niche.decide',
  description:
    'Tick a niche to be searched for creators (picked), or skip it (skipped). Only ticked niches are searched.',
  risk: 1,
  input: NicheDecideInput,
  output: NicheOutShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_decide_niche' },
  emits: ['socialcontent.niche.decided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const was = await loadNiche(ctx, input.nicheId);
    if (was.state === input.state) return nicheOut(was);
    const [now] = await ctx.tx
      .update(niches)
      .set({ state: input.state, decidedBy: me })
      .where(eq(niches.id, was.id))
      .returning();
    if (input.state === 'skipped')
      await rows(
        ctx.tx,
        sql`update addon_socialcontent.work set state = 'stopped', finished_at = now()
            where niche_id = ${was.id} and state = 'waiting'`,
      );
    await ctx.emit({
      type: 'socialcontent.niche.decided',
      entityType: 'socialcontent_niche',
      entityId: was.id,
      payload: { name: was.name, state: input.state },
    });
    return nicheOut(now!);
  },
});

// ------------------------------------------------------------------------------------------------ creators

export const creatorList = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.creator.list',
  description:
    'The creators content research knows: suggested by a search (for someone to tick), studied (their posts read and weighed), skipped, or found but not fitting (fewer than 5,000 followers or no post in the last 30 days). Each with their network, followers, last post, niche, why they were suggested, how many posts were read and how many stand out. Filter by state or network.',
  input: CreatorListInput,
  output: CreatorListOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_list_creators' },
  async handler(ctx, input) {
    const found = await ctx.tx
      .select({
        c: creators,
        nicheName: niches.name,
        reading: dsql<boolean>`exists (select 1 from addon_socialcontent.work w where w.creator_id = ${creators.id} and w.state in ('waiting', 'taken'))`,
      })
      .from(creators)
      .leftJoin(niches, eq(niches.id, creators.nicheId))
      .where(
        and(
          eq(creators.workspaceId, ctx.scope.workspaceId!),
          input.state ? eq(creators.state, input.state) : undefined,
          input.network ? eq(creators.network, input.network) : undefined,
        ),
      )
      .orderBy(
        desc(creators.standoutsCount),
        dsql`${creators.followers} desc nulls last`,
        desc(creators.createdAt),
      )
      .limit(500);
    return {
      creators: found.map((r) =>
        creatorOut(r.c, { nicheName: r.nicheName, reading: Boolean(r.reading) }),
      ),
    };
  },
});

export const creatorAdd = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.creator.add',
  description:
    'Study a creator from a link to their page (instagram.com/name, a Facebook profile or page, or a LinkedIn member’s or company’s page; TikTok and YouTube come later), or a bare @name with its network. They’re studied straight away, whatever their size: their profile and their posts back 12 months are read next.',
  risk: 1,
  input: CreatorAddInput,
  output: CreatorOut,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_add_creator',
    outcome: (output) => ({
      words: W.creators.added(String((output as { shown?: unknown }).shown ?? 'them')),
      path: 'a/socialcontent/creators',
    }),
  },
  emits: ['socialcontent.creator.added', 'socialcontent.work.asked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const page = creatorFromLink(input.link, input.network);
    if (!page)
      throw HfosError.rule(
        'socialcontent_link_unreadable',
        400,
        input.link.trim().startsWith('@') && !input.network
          ? `Pick the network ${input.link.trim()} is on, or paste the link to their page instead.`
          : 'That link isn’t a page of a person or a business on Instagram, Facebook, LinkedIn, TikTok or YouTube. Copy the link from their profile, like instagram.com/theirname.',
      );
    needReady(page.network);
    const [made] = await rows<{ id: string; created: boolean }>(
      ctx.tx,
      sql`insert into addon_socialcontent.creators
            (workspace_id, network, handle, link, state, found_by, added_by, decided_by, picked_by)
          values (${ws}, ${page.network}, ${page.handle}, ${page.link}, 'studying', 'person', ${me}, ${me}, 'person')
          on conflict (workspace_id, network, handle)
            do update set state = 'studying', decided_by = excluded.decided_by, picked_by = 'person'
          returning id, (xmax = 0) as created`,
    );
    const c = await loadCreator(ctx, made!.id);
    await queueWork(
      ctx,
      [
        ...(c.profileReadAt
          ? []
          : [{ kind: 'profile' as const, network: c.network, creatorId: c.id }]),
        {
          kind: 'posts',
          network: c.network,
          creatorId: c.id,
          since: readSince(c.postsReadAt, new Date()),
        },
      ],
      'added',
      me,
    );
    await ctx.emit({
      type: 'socialcontent.creator.added',
      entityType: 'socialcontent_creator',
      entityId: c.id,
      payload: { network: c.network, handle: c.handle, created: made!.created },
    });
    return creatorShown(ctx, c.id);
  },
});

export const creatorDecide = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.creator.decide',
  description:
    'Study a creator (study: true: their posts back 12 months are read and weighed, then again every week), or skip them (study: false: nothing more is read, and a search never suggests them again). Works on suggested, studied and skipped creators alike.',
  risk: 1,
  input: CreatorDecideInput,
  output: CreatorOut,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_decide_creator' },
  emits: ['socialcontent.creator.decided', 'socialcontent.work.asked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const was = await loadCreator(ctx, input.creatorId);
    const state = input.study ? 'studying' : 'skipped';
    // Ticked again by a person, one the AI picked is theirs now: the monthly swap leaves it (decision 31).
    if (was.state === state && was.pickedBy === 'ai')
      await ctx.tx
        .update(creators)
        .set({ pickedBy: 'person', decidedBy: me })
        .where(eq(creators.id, was.id));
    if (was.state !== state) {
      if (input.study) needReady(was.network);
      await ctx.tx
        .update(creators)
        .set({ state, decidedBy: me, pickedBy: 'person' })
        .where(eq(creators.id, was.id));
      if (input.study)
        await queueWork(
          ctx,
          [
            ...(was.profileReadAt
              ? []
              : [{ kind: 'profile' as const, network: was.network, creatorId: was.id }]),
            {
              kind: 'posts',
              network: was.network,
              creatorId: was.id,
              since: readSince(was.postsReadAt, new Date()),
            },
          ],
          'studying',
          me,
        );
      else
        await rows(
          ctx.tx,
          sql`update addon_socialcontent.work set state = 'stopped', finished_at = now()
              where creator_id = ${was.id} and state = 'waiting'`,
        );
      await ctx.emit({
        type: 'socialcontent.creator.decided',
        entityType: 'socialcontent_creator',
        entityId: was.id,
        payload: { network: was.network, handle: was.handle, state },
      });
    }
    return creatorShown(ctx, was.id);
  },
});

// ------------------------------------------------------------------------------------------------ posts

export const postList = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.post.list',
  description:
    'Studied creators’ posts, newest first: each with its numbers (views, likes, comments, shares) and how many times the median of the 10 posts on each side of it it did, on views and on likes plus comments. A standout did at least 2 times on either, and has the AI’s notes on why it worked (its hook, format, topic and techniques, and how the business could use it), and for a video it watched, what it saw and heard. Pass standoutsOnly for the Standouts page, creatorId for one creator’s posts, network to keep to one network, and before (a post’s postedAt) for the next page.',
  input: PostListInput,
  output: PostListOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_list_posts' },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const found = await ctx.tx
      .select({
        post: posts,
        creator: { name: creators.name, network: creators.network, handle: creators.handle },
      })
      .from(posts)
      .innerJoin(creators, eq(creators.id, posts.creatorId))
      .where(
        and(
          eq(posts.workspaceId, ws),
          input.creatorId ? eq(posts.creatorId, input.creatorId) : undefined,
          input.standoutsOnly ? eq(posts.standout, true) : undefined,
          input.network ? eq(creators.network, input.network) : undefined,
          input.before ? lt(posts.postedAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(posts.postedAt), asc(posts.id))
      .limit(input.limit + 1);
    const shown = found.slice(0, input.limit);
    const ids = shown.filter((r) => r.post.kind === 'video').map((r) => r.post.id);
    const watching = new Set(
      ids.length
        ? (
            await rows<{ post_id: string }>(
              ctx.tx,
              sql`select post_id from addon_socialcontent.work
                  where workspace_id = ${ws} and kind = 'watch' and state in ('waiting', 'taken')
                    and post_id = any(${`{${ids.join(',')}}`}::uuid[])`,
            )
          ).map((r) => r.post_id)
        : [],
    );
    return {
      posts: shown.map((r) => postOut(r.post, r.creator, watching.has(r.post.id))),
      more: found.length > input.limit,
    };
  },
});

// ------------------------------------------------------------------------------------------------ asking now

export const findNow = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.find.now',
  description:
    'Look for creators now, rather than at the monthly look: the reading computer searches each ticked niche on each network studied (or the one given) for creators with 5,000+ followers who posted in the last 30 days, and suggests them to tick.',
  risk: 1,
  input: FindNowInput,
  output: FindNowOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_find_creators',
    outcome: (output) => {
      const o = output as { networks?: string[]; niches?: number };
      return {
        words: W.creators.finding(
          (o.networks ?? [])
            .map((n) => CONTENT_NETWORK_INFO[n as 'instagram']?.name ?? n)
            .join(', '),
          o.niches ?? 0,
        ),
        path: 'a/socialcontent/creators',
      };
    },
  },
  emits: ['socialcontent.work.asked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const s = await settingsOf(ctx);
    if (!s.readerUserId) throw HfosError.rule('socialcontent_no_reader', 409, NO_READER);
    if (input.network) needReady(input.network);
    const networks = input.network ? [input.network] : s.networks;
    if (!networks.length)
      throw HfosError.rule(
        'socialcontent_no_networks',
        409,
        'No network is picked to study. An owner or admin picks one in AI Social Media Content Creator → Settings → Networks.',
      );
    const picked = await ctx.tx
      .select({ id: niches.id })
      .from(niches)
      .where(and(eq(niches.workspaceId, ctx.scope.workspaceId!), eq(niches.state, 'picked')));
    if (!picked.length)
      throw HfosError.rule(
        'socialcontent_no_niches',
        409,
        'Tick at least one niche to look in first, under Creators → Niches. Suggest niches has the AI find yours and ones like it.',
      );
    const asked = await queueWork(
      ctx,
      picked.flatMap((n) =>
        networks.map((network) => ({ kind: 'find' as const, network, nicheId: n.id })),
      ),
      'person',
      me,
    );
    return { asked, networks, niches: picked.length };
  },
});

export const readNow = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.read.now',
  description:
    'Read a studied creator’s posts again now (creatorId), or every studied creator’s, rather than at the weekly read: new posts, and the numbers of the last 60 days’ posts, which still grow. Their standouts are worked out again after.',
  risk: 1,
  input: ReadNowInput,
  output: ReadNowOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_read_creators',
    outcome: (output) => ({
      words: `Asked the reading computer to read ${W.count(Number((output as { asked?: unknown }).asked ?? 0), 'creator')} again.`,
      path: 'a/socialcontent/creators',
    }),
  },
  emits: ['socialcontent.work.asked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const s = await settingsOf(ctx);
    if (!s.readerUserId) throw HfosError.rule('socialcontent_no_reader', 409, NO_READER);
    const which = input.creatorId
      ? [await loadCreator(ctx, input.creatorId)]
      : await ctx.tx
          .select()
          .from(creators)
          .where(
            and(eq(creators.workspaceId, ctx.scope.workspaceId!), eq(creators.state, 'studying')),
          );
    if (input.creatorId && which[0]!.state !== 'studying')
      throw HfosError.rule(
        'socialcontent_not_studied',
        409,
        `${handleShown(which[0]!.network, which[0]!.handle)} isn’t studied. Press Study on them first, under Creators.`,
      );
    const now = new Date();
    const asked = await queueWork(
      ctx,
      which
        .filter((c) => CONTENT_NETWORK_INFO[c.network].ready)
        .map((c) => ({
          kind: 'posts' as const,
          network: c.network,
          creatorId: c.id,
          since: readSince(c.postsReadAt, now),
        })),
      'person',
      me,
    );
    return { asked };
  },
});

export const workStop = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.work.stop',
  description:
    'Stop something the reading computer was asked to do that’s still waiting or under way (finding creators for a niche, reading a creator’s profile or posts).',
  risk: 1,
  input: WorkStopInput,
  output: WorkOutShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_stop_work' },
  emits: ['socialcontent.work.stopped'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const changed = await rows<{ id: string }>(
      ctx.tx,
      sql`update addon_socialcontent.work set state = 'stopped', finished_at = now()
          where id = ${input.workId} and workspace_id = ${ws} and state in ('waiting', 'taken')
          returning id`,
    );
    const [w] = await rows<WorkRow>(
      ctx.tx,
      sql`${WORK_SELECT} where w.id = ${input.workId} and w.workspace_id = ${ws}`,
    );
    if (!w) throw HfosError.notFound('That isn’t there anymore. Refresh the page.');
    if (changed.length)
      await ctx.emit({
        type: 'socialcontent.work.stopped',
        entityType: 'socialcontent_work',
        entityId: w.id,
        payload: { kind: w.kind, network: w.network },
      });
    return workOut(w);
  },
});

export const researchCommands = [
  settingsSave,
  nicheAdd,
  nicheDecide,
  creatorAdd,
  creatorDecide,
  findNow,
  readNow,
  workStop,
] as const;
export const researchQueries = [overview, nicheList, creatorList, postList] as const;
