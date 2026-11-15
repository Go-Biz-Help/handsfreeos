/**
 * The business's own posts and their calendar, in the worker (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md,
 * part 8, decisions 13 to 20; docs/socialcontent.md, "Making posts").
 *
 * - **Write a post** (`socialcontent.content.write`) for a network, from an idea or a few words: the AI writes it
 *   from the Playbook and what HandsFreeOS knows about the business, and it's kept as a Social post waiting for an
 *   OK, on the next open day in the plan for that network unless a day is given. **Write it again**
 *   (`socialcontent.content.rewrite`) writes one over, which takes its OK back.
 * - **Fill the calendar** (`socialcontent.calendar.fill`) queues `socialcontent.calendar`, which writes a post for
 *   each open day in the plan over the next two weeks, a few at a time, from saved ideas first, then new ones, then
 *   the Playbook alone; then it runs again a week later on its own (decision 18).
 * - **Its pictures** (`socialcontent.content.picture`, and on their own after a post is written) are made in
 *   `socialcontent.pictures` (decision 14): a picture with words on it is designed by the AI and drawn here
 *   (./draw.ts); a photo-style one is made by OpenAI's image model (../../pictures.ts) and charged as `ai.image`.
 *   The person's own photos they add themselves, on the web.
 *
 * Nothing here posts anything: posting through the extension comes in parts 9 and 10, and only OK'd posts go.
 */
import { randomUUID } from 'node:crypto';
import {
  CALENDAR,
  firstPlannedNetwork,
  hasPictures,
  isPostingNetwork,
  planOf,
  POSTING_NETWORKS,
  type ContentFormat,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import { movesFor, openSlots as planSlots } from '@hfos/core/addons/socialcontent/schedule';
import {
  contentRetime,
  learnedTimesOf,
  postsOnCalendar,
} from '@hfos/core/addons/socialcontent/ops/schedule';
import {
  calendarFilled,
  contentPictured,
  contentPut,
} from '@hfos/core/addons/socialcontent/ops/worker';
import {
  checkedDesign,
  checkedPost,
  designChoices,
  DESIGN_SCHEMA,
  DESIGN_SYSTEM,
  DesignAnswer,
  designPrompt,
  photoPromptFor,
  POST_LIMITS,
  WRITE_SCHEMA,
  WRITE_SYSTEM,
  WriteAnswer,
  writePrompt,
  type Design,
  type WriteInput,
  type WrittenPost,
} from '@hfos/core/addons/socialcontent/posts-ai';
import type { AiContent } from '@hfos/ai';
import type { ContentPicturedInput } from '@hfos/core/addons/socialcontent/content-shapes';
import {
  CHECKS,
  checkedPictureCheck,
  fitsGraphic,
  fixAsk,
  graphicDue,
  graphicPromptFor,
  PICTURE_CHECK_SCHEMA,
  PICTURE_CHECK_SYSTEM,
  PictureCheckAnswer,
  pageToCheck,
  pictureCheckPrompt,
  withCutWords,
  type PageToCheck,
  type GraphicTry,
  type PictureCheck,
} from '@hfos/core/addons/socialcontent/check-ai';
import {
  examplesFor,
  isAngle,
  nextLook,
  planWrites,
  VARIETY,
  type CreatorPost,
  type IdeaToPlan,
  type PlannedWrite,
  type Topic,
} from '@hfos/core/addons/socialcontent/variety';
import { PlaybookSection } from '@hfos/core/addons/socialcontent/shapes';
import {
  aiImageUsageKey,
  executeCommand,
  fileStore,
  HfosError,
  LOOK_DEFAULT_COLOR,
  lookOf,
  storedFilePath,
  WALLET_REFUSALS,
  walletRoom,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import sharp from 'sharp';
import { z } from 'zod';
import { AiAskError, askStructured } from '../../ai/ask';
import { assertInWorkspace } from '../../handlers/file-removed';
import { chargeUsage } from '../../money/wallet';
import { PictureError } from '../../pictures';
import { scheduleAddonJob } from '../queue';
import { businessText, listsAllFilled, listsHere, offerIsLive, requireLiveOffer } from './business';
import { drawDesign, PICTURE_HEIGHT, PICTURE_WIDTH, type Drawn } from './draw';
import { aiRefusal, suggestIdeas } from './notes';
import { everResearched, queueResearch, researchNow } from './research';
import { aboutOf, creatorPosts, ideasBefore, postsBefore, topicOf, type PostSeen } from './variety';
import type { AddonJobHandler, AddonScopeContext, AddonWorkerAction } from '../types';

export const CALENDAR_JOB = 'socialcontent.calendar';
export const PICTURES_JOB = 'socialcontent.pictures';
export const TIMES_JOB = 'socialcontent.times';
export const WRITE_ACTION = 'socialcontent.content.write';
export const REWRITE_ACTION = 'socialcontent.content.rewrite';
export const FILL_ACTION = 'socialcontent.calendar.fill';
export const PICTURE_ACTION = 'socialcontent.content.picture';

/** Posts one run of the calendar writes before it carries on in the next, a little later. */
const FILL_PER_RUN = 5;
const SOON_MS = 30_000;
const WEEK_MS = CALENDAR.everyDays * 86_400_000;
/** The AI's limit or the balance ran out: it tries again this much later. */
const LATER_MS = 6 * 3_600_000;

// ------------------------------------------------------------------------------------------------ what it knows

interface Here {
  readonly timeZone: string;
  readonly businessName: string;
  readonly color: string;
  readonly plan: ReturnType<typeof planOf>;
  readonly playbook: WriteInput['playbook'];
  /** Whether it fills the calendar on its own (Settings → Posting, and the Calendar's switch). */
  readonly autoFill: boolean;
}

async function hereOf(ctx: AddonScopeContext): Promise<Here> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [w] = await rows<{ timezone: string | null; name: string; settings: unknown }>(
      tx,
      sql`select timezone, name, settings from app.workspaces where id = ${ctx.scope.workspaceId}`,
    );
    const [s] = await rows<{ plan: unknown; auto_fill: boolean }>(
      tx,
      sql`select plan, auto_fill from addon_socialcontent.settings where workspace_id = ${ctx.scope.workspaceId}`,
    );
    const [p] = await rows<{ summary: string | null; sections: unknown }>(
      tx,
      sql`select summary, sections from addon_socialcontent.playbook
          where workspace_id = ${ctx.scope.workspaceId} and written_at is not null`,
    );
    return {
      timeZone: w?.timezone || 'America/Chicago',
      businessName: w?.name ?? 'the business',
      color: lookOf(w?.settings).color?.hex ?? LOOK_DEFAULT_COLOR,
      plan: planOf(s?.plan),
      autoFill: s?.auto_fill ?? true,
      playbook: p
        ? { summary: p.summary, sections: PlaybookSection.array().catch([]).parse(p.sections) }
        : null,
    };
  });
}

type IdeaRow = {
  id: string;
  title: string;
  hook: string | null;
  format: string | null;
  network: string | null;
  outline: string | null;
  why: string | null;
  state: string;
  angle: string | null;
  topic_list: string | null;
  topic: string | null;
  source_url: string | null;
  source_name: string | null;
};
const IDEA_COLUMNS = sql`id, title, hook, format, network, outline, why, state, angle, topic_list, topic, source_url,
  source_name`;

async function ideaOf(ctx: AddonScopeContext, ideaId: string): Promise<IdeaRow> {
  const [i] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<IdeaRow>(
      tx,
      sql`select ${IDEA_COLUMNS} from addon_socialcontent.ideas
          where id = ${ideaId}::uuid and workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!i)
    throw HfosError.notFound(
      'That idea isn’t there anymore. Refresh the page to see the ones there are.',
    );
  return i;
}

/**
 * The plan's open places ahead, soonest first (decisions 21 and 22): I pick's times, and AI picks' days at the hours
 * it learned (../../../../../packages/core/src/addons/socialcontent/schedule.ts), the same as the Calendar shows.
 */
async function openSlots(ctx: AddonScopeContext, here: Here) {
  const now = Date.now();
  return asWorker(ctx.db, ctx.scope, async (tx) =>
    planSlots({
      plan: here.plan,
      times: await learnedTimesOf(tx, ctx.scope.workspaceId, here.timeZone),
      taken: await postsOnCalendar(tx, ctx.scope.workspaceId, here.timeZone, now),
      timeZone: here.timeZone,
      now,
    }),
  );
}

// ------------------------------------------------------------------------------------------------ writing

/** The AI writes one post; null when what came back held nothing to keep. */
async function writeOne(
  ctx: AddonScopeContext,
  input: Omit<WriteInput, 'business'> & { readonly business?: string },
): Promise<WrittenPost | null> {
  const { value } = await askStructured(ctx, ctx.scope, {
    system: WRITE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: writePrompt({ ...input, business: input.business ?? (await businessText(ctx)) }),
      },
    ],
    schema: WRITE_SCHEMA,
    zod: WriteAnswer,
    maxTokens: 3000,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const post = checkedPost(value, input.network, input.angle ?? null, input.look ?? null);
  if (!post) return null;
  // Without OpenAI's image model here, a photo-style picture is designed instead.
  return post.pictureWay === 'photo' && !ctx.pictures ? { ...post, pictureWay: 'design' } : post;
}

const ideaForAi = (i: IdeaRow | null): WriteInput['idea'] =>
  i
    ? {
        title: i.title,
        hook: i.hook,
        format: i.format,
        outline: i.outline,
        why: i.why,
        source: i.source_url ? (i.source_name ?? i.source_url) : null,
      }
    : null;

/** An idea's kind and topic, when it has them (decisions 34 to 36). */
const kindOf = (i: IdeaRow | null) => ({
  angle: i && isAngle(i.angle) ? i.angle : null,
  topic: i ? topicOf(i.topic_list, i.topic) : null,
});

/** The last posts the AI sees, so it never repeats a hook (pick 1a). */
const recentFor = (seen: readonly PostSeen[]) =>
  seen.slice(0, VARIETY.recentShown).map((p) => ({ title: p.title, hook: p.hook }));

/** Keeps a written post, and queues its pictures when the AI makes them. */
async function keep(
  ctx: AddonScopeContext,
  post: WrittenPost,
  opts: {
    readonly network: PostingNetwork;
    readonly postId?: string;
    readonly ideaId?: string | null;
    readonly postAt?: number | null;
    readonly askedBy?: string | null;
    /** A time the person asked for is theirs: AI picks never moves it (decision 27). */
    readonly placedBy?: 'ai' | 'person';
    /** The line from the lists it was written about (decision 34). */
    readonly topic?: Topic | null;
  },
): Promise<string> {
  const { output } = await executeCommand(
    ctx.db,
    contentPut,
    {
      workspaceId: ctx.scope.workspaceId,
      ...(opts.postId ? { postId: opts.postId } : {}),
      network: opts.network,
      ideaId: opts.ideaId ?? null,
      postAt: opts.postAt ? new Date(opts.postAt).toISOString() : null,
      placedBy: opts.placedBy ?? 'ai',
      post: {
        title: post.title,
        format: post.format,
        hook: post.hook,
        words: post.words,
        hashtags: post.hashtags,
        slides: post.slides,
        chain: post.chain,
        script: post.script,
        picture: post.picture,
        pictureWay: post.pictureWay,
        angle: post.angle,
        topic: opts.topic ?? null,
      },
      askedBy: opts.askedBy ?? null,
    },
    ctx.actor,
    ctx.meta,
  );
  if (hasPictures(post.format) && post.pictureWay !== 'own')
    await queuePictures(ctx, output.postId, {
      way: post.pictureWay,
      prompt: post.photoPrompt,
      ask: null,
    });
  return output.postId;
}

async function queuePictures(
  ctx: AddonScopeContext,
  postId: string,
  p: {
    readonly way: 'design' | 'photo';
    readonly prompt: string | null;
    readonly ask: string | null;
  },
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: PICTURES_JOB,
        dedupeKey: `${PICTURES_JOB}:${postId}`,
        runAt: new Date(),
        payload: { postId, way: p.way, prompt: p.prompt, ask: p.ask },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

const emptyPost = () =>
  HfosError.rule(
    'socialcontent_post_empty',
    502,
    'The AI didn’t write anything usable that time. Try again in a minute.',
  );

const WriteInputShape = z
  .object({
    network: z.enum(POSTING_NETWORKS).optional(),
    /** Several at once (the owner, 14 Nov): a post for each, about the same thing, each written to fit its network. */
    networks: z.array(z.enum(POSTING_NETWORKS)).min(1).max(POSTING_NETWORKS.length).optional(),
    ideaId: z.uuid().optional(),
    ask: z.string().trim().max(POST_LIMITS.ask).optional(),
    postAt: z.iso.datetime().optional(),
  })
  .strict();

export const writePostNow: AddonWorkerAction<z.output<typeof WriteInputShape>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_write_own_post',
    description:
      'Have the AI write one of the business’s own posts for Instagram, Facebook, LinkedIn, Threads or X (network), or one for each of several networks about the same thing (networks), each written to fit its network: from a content idea (ideaId), or from a few words of what it should be about (ask), using the Playbook and what HandsFreeOS knows about the business. With neither, the AI picks what to write about on its own, the way Fill the calendar does. Each goes on the next open day in the plan for its network unless postAt is given, and waits for an OK; its picture is made on its own when the AI makes it. Refused until the business’s main offer is live.',
    autonomy: 'auto',
    keywords: ['write a post', 'social post', 'caption', 'content calendar'],
  },
  input: WriteInputShape,
  async run(ctx, input) {
    await requireLiveOffer(ctx);
    const chosen = input.ideaId ? await ideaOf(ctx, input.ideaId) : null;
    const here = await hereOf(ctx);
    const asked = [
      ...new Set([...(input.network ? [input.network] : []), ...(input.networks ?? [])]),
    ];
    const networks: readonly PostingNetwork[] = asked.length
      ? asked
      : [
          (chosen?.network && isPostingNetwork(chosen.network) ? chosen.network : null) ??
            firstPlannedNetwork(here.plan),
        ];
    const first = networks[0]!;
    const seen = await postsBefore(ctx);
    // No idea and no direction (AI on its own, the owner, 14 Nov): planned the way Fill the calendar plans each post,
    // once, so every network's post is about the same thing.
    const planned = chosen || input.ask ? null : await planOne(ctx, first, seen);
    const idea = chosen ?? planned?.idea ?? null;
    // With no Playbook yet, a line from the lists is enough once they're all filled, as when filling (decision 32).
    const fromLists =
      !idea && !input.ask && !here.playbook && planned?.topic ? await listsAllFilled(ctx) : false;
    if (!idea && !input.ask && !here.playbook && !fromLists)
      throw HfosError.rule(
        'socialcontent_nothing_to_write_from',
        409,
        'Say what the post should be about, or pick an idea under Ideas to write it from.',
      );
    const kind = planned ? { angle: planned.angle, topic: planned.topic } : kindOf(idea);
    const business = await businessText(ctx);
    const examples = examplesFor(
      [aboutOf(kind.topic, idea), input.ask ?? ''].join(' '),
      await creatorPosts(ctx),
    );
    // Each network's post is written for it, all at once: its own length, tags and formats (Instagram never words
    // alone, Threads and X short) come from its rules in the writer's prompt and checkedPost.
    const tries = await Promise.allSettled(
      networks.map((network) =>
        writeOne(ctx, {
          business,
          network,
          playbook: here.playbook,
          idea: ideaForAi(idea),
          ask: input.ask ?? null,
          before: null,
          ...kind,
          recent: recentFor(seen),
          // What the person asked for says how to show it; otherwise it takes the next look (decision 39).
          look: input.ask
            ? null
            : planned && network === first
              ? planned.look
              : nextLook(seen, network, !!ctx.pictures),
          examples,
        }),
      ),
    );
    const done = networks.flatMap((network, i) => {
      const t = tries[i]!;
      if (t.status === 'rejected') {
        ctx.log.warn({ network, err: t.reason }, 'a post for one network wasn’t written');
        return [];
      }
      return t.value ? [{ network, post: t.value }] : [];
    });
    if (!done.length) {
      const failed = tries.find((t) => t.status === 'rejected');
      if (failed)
        throw failed.reason instanceof AiAskError ? aiRefusal(failed.reason) : failed.reason;
      throw emptyPost();
    }
    const slots = await openSlots(ctx, here);
    const kept: { postId: string; postAt: number | null }[] = [];
    for (const { network, post } of done) {
      const open = slots.filter((s) => s.network === network);
      const postAt = input.postAt ? new Date(input.postAt).getTime() : (open[0]?.at ?? null);
      // Written into one of the plan's open places (Write one), it's the AI's time; any other time is the person's.
      const placedBy = postAt === null || open.some((s) => s.at === postAt) ? 'ai' : 'person';
      const postId = await keep(ctx, post, {
        network,
        ideaId: idea?.id ?? null,
        postAt,
        askedBy: ctx.userId,
        placedBy,
        topic: kind.topic,
      });
      kept.push({ postId, postAt });
    }
    const at = kept[0]!.postAt;
    return {
      postId: kept[0]!.postId,
      postAt: at ? new Date(at).toISOString() : null,
      postIds: kept.map((k) => k.postId),
      // The networks whose post the AI didn't write this time.
      missed: networks.filter((n) => !done.some((d) => d.network === n)),
    };
  },
};

/**
 * What AI on its own writes from (the owner, 14 Nov): one post planned the way Fill the calendar plans each, so it
 * takes the kind the weekly mix needs next and a waiting idea of that kind, or the next line from the lists, and the
 * next look (decisions 34 to 39).
 */
async function planOne(
  ctx: AddonScopeContext,
  network: PostingNetwork,
  seen: readonly PostSeen[],
): Promise<(PlannedWrite<{ network: PostingNetwork }> & { idea: IdeaRow | null }) | null> {
  const ideas = await ideasToUse(ctx);
  // Waiting ideas' topics count as taken, so a post written from the lists isn't about one of them.
  const reserved = (await ideasBefore(ctx)).map((i) => ({ angle: null, topic: i.topic }));
  const [p] = planWrites({
    slots: [{ network }],
    before: [...reserved, ...seen],
    ideas: ideas.map(ideaToPlan),
    lists: await listsHere(ctx),
    photos: !!ctx.pictures,
  });
  if (!p) return null;
  return { ...p, idea: p.ideaId ? (ideas.find((i) => i.id === p.ideaId) ?? null) : null };
}

const RewriteInput = z
  .object({ postId: z.uuid(), ask: z.string().trim().max(POST_LIMITS.ask).optional() })
  .strict();

export const rewritePostNow: AddonWorkerAction<z.output<typeof RewriteInput>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_rewrite_own_post',
    description:
      'Have the AI write one of the business’s own posts again, differently, or with what to change (ask: “shorter”, “more about pricing”). It takes the post’s OK back, so it waits for an OK again. A posted post can’t be written again.',
    autonomy: 'auto',
    keywords: ['rewrite post', 'write it again', 'change the caption'],
  },
  input: RewriteInput,
  async run(ctx, input) {
    await requireLiveOffer(ctx);
    const [was] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{
        network: string;
        format: ContentFormat;
        words: string;
        idea_id: string | null;
        state: string;
        angle: string | null;
        topic_list: string | null;
        topic: string | null;
      }>(
        tx,
        sql`select c.network, c.format, c.words, c.idea_id, c.state, c.angle, c.topic_list, c.topic
            from addon_socialcontent.content c
            join app.custom_records r on r.id = c.record_id and r.archived_at is null
            where c.record_id = ${input.postId}::uuid and c.workspace_id = ${ctx.scope.workspaceId}`,
      ),
    );
    if (!was || !isPostingNetwork(was.network))
      throw HfosError.notFound(
        'That post isn’t there anymore. Refresh the page to see the ones there are.',
      );
    if (was.state === 'posted' || was.state === 'posting')
      throw HfosError.rule(
        'socialcontent_post_posted',
        409,
        'That post already went up, so it can’t be written again here.',
      );
    const here = await hereOf(ctx);
    const idea = was.idea_id ? await ideaOf(ctx, was.idea_id).catch(() => null) : null;
    // Written again, it stays the same kind about the same topic (decisions 34 and 36), in new words.
    const topic = topicOf(was.topic_list, was.topic);
    let post: WrittenPost | null;
    try {
      post = await writeOne(ctx, {
        network: was.network,
        playbook: here.playbook,
        idea: ideaForAi(idea),
        ask: input.ask ?? null,
        before: { words: was.words, format: was.format },
        angle: isAngle(was.angle) ? was.angle : null,
        topic,
        recent: recentFor(await postsBefore(ctx)),
        examples: examplesFor(
          [aboutOf(topic, idea), input.ask ?? '', was.words.slice(0, 300)].join(' '),
          await creatorPosts(ctx),
        ),
      });
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e) : e;
    }
    if (!post) throw emptyPost();
    await keep(ctx, post, {
      network: was.network,
      postId: input.postId,
      askedBy: ctx.userId,
      topic,
    });
    return { postId: input.postId };
  },
};

// ------------------------------------------------------------------------------------------------ the calendar

export async function queueFill(
  ctx: AddonScopeContext,
  at: Date,
  pullEarlier: boolean,
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: CALENDAR_JOB,
        dedupeKey: `${CALENDAR_JOB}:${ctx.scope.workspaceId}`,
        runAt: at,
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier },
    ),
  );
}

export const fillCalendarNow: AddonWorkerAction<Record<string, never>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_fill_calendar',
    description:
      'Fill the business’s content calendar: the AI writes a post for each open day in the plan over the next two weeks (saved ideas first, then new ones, then from the Playbook), each waiting for an OK, with their pictures. After that it tops up once a week on its own. Says how many open days there are; the posts show on the calendar as they’re written, over a few minutes. Refused until the business’s main offer is live.',
    autonomy: 'auto',
    keywords: ['fill calendar', 'content calendar', 'plan my posts', 'next two weeks of posts'],
  },
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(ctx) {
    const here = await hereOf(ctx);
    if (!here.autoFill)
      throw HfosError.rule(
        'socialcontent_fill_off',
        409,
        'Filling the calendar is off, so the AI doesn’t write posts on its own. Turn on Fill on its own on the Calendar page or in Settings → Posting, and it fills the open days right away.',
      );
    await requireLiveOffer(ctx);
    const open = await openSlots(ctx, here);
    // With every day taken, it still runs while the AI's drafts from before wait to be written again (decision 37).
    if (!open.length && !(await oldDrafts(ctx, 1)).length) return { open: 0 };
    await queueFill(ctx, new Date(), true);
    return { open: open.length };
  },
};

/** Ideas to write from, best first: saved ones, then new ones, oldest first. */
async function ideasToUse(ctx: AddonScopeContext): Promise<IdeaRow[]> {
  return asWorker(ctx.db, ctx.scope, (tx) =>
    rows<IdeaRow>(
      tx,
      sql`select ${IDEA_COLUMNS} from addon_socialcontent.ideas
          where workspace_id = ${ctx.scope.workspaceId} and state in ('saved', 'new')
          order by (state = 'saved') desc, coalesce(decided_at, created_at)
          limit 60`,
    ),
  );
}

const ideaToPlan = (i: IdeaRow): IdeaToPlan => ({
  id: i.id,
  network: i.network,
  angle: i.angle,
  topic: topicOf(i.topic_list, i.topic),
  saved: i.state === 'saved',
  fact: i.source_url !== null,
});

/**
 * Ideas get more on their own (decision 35): 10 when fewer than 5 wait and there's a Playbook to write them from. The
 * AI's limit or a busy model leaves the ones there are: the calendar writes from the lists meanwhile.
 */
async function topUpIdeas(ctx: AddonScopeContext, here: Here, business: string): Promise<void> {
  if (!here.playbook) return;
  const [w] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from addon_socialcontent.ideas
          where workspace_id = ${ctx.scope.workspaceId} and state in ('saved', 'new')`,
    ),
  );
  if ((w?.n ?? 0) >= VARIETY.ideasBelow) return;
  try {
    await suggestIdeas(ctx, business, VARIETY.ideasAdded);
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    ctx.log.info({ code: e.code }, 'more content ideas wait for the AI');
  }
}

/**
 * The first look for news and facts (decision 38), before the first posts with variety are written, so they can use
 * them; then it looks once a week. The AI's limit or a busy model leaves it to the weekly look.
 */
async function firstResearch(ctx: AddonScopeContext, business: string): Promise<void> {
  if (await everResearched(ctx)) return;
  await queueResearch(ctx, new Date(Date.now() + 7 * 86_400_000));
  try {
    const kept = await researchNow(ctx, business);
    ctx.log.info({ kept }, 'the first content research kept news and facts as ideas');
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    ctx.log.info({ code: e.code }, 'the first content research waits for the weekly look');
  }
}

/** Whether it still fills on its own: turned off, a fill under way stops before its next post. */
async function fillsOnItsOwn(ctx: AddonScopeContext): Promise<boolean> {
  const [s] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ auto_fill: boolean }>(
      tx,
      sql`select auto_fill from addon_socialcontent.settings where workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  return s?.auto_fill ?? true;
}

/**
 * The AI's drafts from before the mix (decision 37): no kind, written by the calendar on its own, still drafts nobody
 * changed, ahead or with no day, and with no photo or video of the person's own added. Video drafts from before it
 * stopped writing videos (the owner, 11 Nov) are among them.
 */
async function oldDrafts(
  ctx: AddonScopeContext,
  most: number,
): Promise<{ record_id: string; network: string; post_at: Date | null }[]> {
  return asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ record_id: string; network: string; post_at: Date | null }>(
      tx,
      sql`select c.record_id, c.network, c.post_at from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
          where c.workspace_id = ${ctx.scope.workspaceId} and c.made_by = 'ai' and c.state = 'draft'
            and c.angle is null and c.created_by is null
            and (c.post_at is null or c.post_at > now())
            and (c.picture_way <> 'own' or cardinality(c.file_ids) = 0)
            and not exists (select 1 from app.events e
              where e.workspace_id = c.workspace_id and e.entity_id = c.record_id
                and e.event_type = 'socialcontent.content.saved')
          order by c.post_at nulls last, c.created_at
          limit ${most}`,
    ),
  );
}

/** A place to write a post into: an open day on the calendar, or a draft from before on its day. */
type Slot = {
  readonly network: PostingNetwork;
  readonly at: number | null;
  readonly postId?: string;
};

/** Writes each of a plan's posts: kept on its own day, or over the draft it takes the place of. How many it wrote. */
async function writePlanned(
  ctx: AddonScopeContext,
  here: Here,
  business: string,
  plan: readonly PlannedWrite<Slot>[],
  ideas: readonly IdeaRow[],
  seen: PostSeen[],
  creators: readonly CreatorPost[],
  gate: { readonly fromLists: boolean } | null,
): Promise<number | null> {
  let written = 0;
  for (const p of plan) {
    if (!(await fillsOnItsOwn(ctx))) return null;
    const idea = p.ideaId ? (ideas.find((i) => i.id === p.ideaId) ?? null) : null;
    // With no Playbook or idea yet, it writes from the main offer and its lists only once they're all filled
    // (decision 32: setting up on its own writes 3 days on, Playbook or not).
    if (gate && !idea && !here.playbook && !gate.fromLists) break;
    const post = await writeOne(ctx, {
      business,
      network: p.slot.network,
      playbook: here.playbook,
      idea: ideaForAi(idea),
      ask: null,
      before: null,
      angle: p.angle,
      topic: p.topic,
      recent: recentFor(seen),
      examples: examplesFor(aboutOf(p.topic, idea), creators),
      look: p.look,
    });
    if (!post) continue;
    await keep(ctx, post, {
      network: p.slot.network,
      ...(p.slot.postId ? { postId: p.slot.postId } : { postAt: p.slot.at }),
      ideaId: idea?.id ?? null,
      topic: p.topic,
    });
    seen.unshift({
      title: post.title,
      hook: post.hook,
      angle: post.angle,
      topic: p.topic,
      fact: !!idea?.source_url,
      format: post.format,
      photo: post.pictureWay === 'photo',
      network: p.slot.network,
    });
    written++;
  }
  return written;
}

/**
 * `socialcontent.calendar`: a post for each open day in the plan over the next two weeks, a few at a time, each the
 * kind the weekly mix needs next about the next line from the lists, or a waiting idea of that kind (decisions 34 to
 * 36). First, the AI's drafts from before the mix are written again on their days (decision 37). Once every day has
 * one, it's marked filled and runs again in a week. Turned off (Fill on its own), it stops before its next post and
 * isn't queued again: turning it back on queues it (onSettingsSaved). With no main offer live, it writes nothing and
 * waits: putting the offer live queues it (onOfferPublished, pick 7b).
 */
export const runCalendar: AddonJobHandler = async (ctx) => {
  try {
    const here = await hereOf(ctx);
    if (!here.autoFill) {
      ctx.log.info('the content calendar fills on its own no more: it was turned off');
      return;
    }
    if (!(await offerIsLive(ctx))) {
      ctx.log.info('the content calendar waits for the main offer to go live');
      return;
    }
    const business = await businessText(ctx);
    const lists = await listsHere(ctx);
    await firstResearch(ctx, business);
    await topUpIdeas(ctx, here, business);
    const ideas = await ideasToUse(ctx);
    const seen = await postsBefore(ctx);
    const creators = await creatorPosts(ctx);
    // Waiting ideas' topics count as taken, so a post written from the lists isn't about one of them.
    const reserved = (await ideasBefore(ctx)).map((i) => ({ angle: null, topic: i.topic }));

    const old = await oldDrafts(ctx, VARIETY.rewritePerRun + 1);
    const redo = old
      .slice(0, VARIETY.rewritePerRun)
      .flatMap((d) =>
        isPostingNetwork(d.network)
          ? [{ network: d.network, at: d.post_at?.getTime() ?? null, postId: d.record_id }]
          : [],
      );
    let rewritten = 0;
    if (redo.length) {
      const planned = planWrites({
        slots: redo,
        before: [...reserved, ...seen],
        ideas: ideas.map(ideaToPlan),
        lists,
        photos: !!ctx.pictures,
      });
      const done = await writePlanned(ctx, here, business, planned, ideas, seen, creators, null);
      if (done === null) return;
      rewritten = done;
      ctx.log.info({ rewritten }, 'the AI’s drafts from before were written again with variety');
      if (old.length > VARIETY.rewritePerRun) return { rescheduleAt: new Date(ctx.now + SOON_MS) };
    }

    const open = await openSlots(ctx, here);
    if (!open.length) {
      await executeCommand(
        ctx.db,
        calendarFilled,
        { workspaceId: ctx.scope.workspaceId, written: 0 },
        ctx.actor,
        ctx.meta,
      );
      return { rescheduleAt: new Date(ctx.now + WEEK_MS) };
    }
    const fromLists = !here.playbook && (await listsAllFilled(ctx));
    const room = Math.max(0, FILL_PER_RUN - rewritten);
    // The ideas left: one used just now was marked used.
    const left = await ideasToUse(ctx);
    const planned = planWrites({
      slots: open.slice(0, room).map((o) => ({ network: o.network, at: o.at })),
      before: [...reserved, ...seen],
      ideas: left.map(ideaToPlan),
      lists,
      photos: !!ctx.pictures,
    });
    const written = await writePlanned(ctx, here, business, planned, left, seen, creators, {
      fromLists,
    });
    if (written === null) return;
    if ((written || rewritten) && open.length > room)
      return { rescheduleAt: new Date(ctx.now + SOON_MS) };
    await executeCommand(
      ctx.db,
      calendarFilled,
      { workspaceId: ctx.scope.workspaceId, written },
      ctx.actor,
      ctx.meta,
    );
    return { rescheduleAt: new Date(ctx.now + WEEK_MS) };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.retryable && ctx.attempt < 3) throw e;
    ctx.log.info({ code: e.code }, 'the content calendar waits for the AI');
    return { rescheduleAt: new Date(ctx.now + (e.retryable ? SOON_MS * 10 : LATER_MS)) };
  }
};

// ------------------------------------------------------------------------------------------------ the hours

/**
 * Queues `socialcontent.times` a little later, once for a business however much asks: the creators' posts saved, its
 * own posts' numbers read, or the plan changed (now).
 */
export async function queueTimes(ctx: AddonScopeContext, inMs: number): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: TIMES_JOB,
        dedupeKey: `${TIMES_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(Date.now() + inMs),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/**
 * `socialcontent.times` (decision 27): what AI picks learned about the hours, from the creators' posts and then the
 * business's own, and every post it placed that hasn't gone up, OK'd ones too, moved to the hour it now has for that
 * day. Posts a person set the time of, ones going up within half an hour, and I pick's networks stay as they are.
 */
export const runTimes: AddonJobHandler = async (ctx) => {
  const here = await hereOf(ctx);
  const now = Date.now();
  const moves = await asWorker(ctx.db, ctx.scope, async (tx) =>
    movesFor({
      plan: here.plan,
      times: await learnedTimesOf(tx, ctx.scope.workspaceId, here.timeZone),
      posts: await postsOnCalendar(tx, ctx.scope.workspaceId, here.timeZone, now),
      timeZone: here.timeZone,
      now,
    }),
  );
  if (!moves.length) return;
  const { output } = await executeCommand(
    ctx.db,
    contentRetime,
    {
      workspaceId: ctx.scope.workspaceId,
      moves: moves.slice(0, 500).map((m) => ({
        postId: m.id,
        from: new Date(m.from).toISOString(),
        to: new Date(m.to).toISOString(),
      })),
    },
    ctx.actor,
    ctx.meta,
  );
  ctx.log.info({ moved: output.moved }, 'AI picks moved posts to the hours it learned');
};

// ------------------------------------------------------------------------------------------------ pictures

const PictureInput = z
  .object({
    postId: z.uuid(),
    way: z.enum(['design', 'photo']).optional(),
    ask: z.string().trim().max(POST_LIMITS.ask).optional(),
  })
  .strict();

export const makePictureNow: AddonWorkerAction<z.output<typeof PictureInput>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_make_post_picture',
    description:
      'Make the pictures for one of the business’s own posts again, or another way: "design" for a picture with words on it in the business’s colour (and each slide of a carousel), "photo" for a lifelike photo from OpenAI’s image AI with the words laid over it, under a carousel’s first slide (9¢ each). ask says what to change. They replace the AI’s earlier pictures and take the post’s OK back; they show on the post in a minute.',
    autonomy: 'auto',
    keywords: ['make picture', 'new image', 'design', 'photo for post'],
  },
  input: PictureInput,
  async run(ctx, input) {
    const [was] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ format: ContentFormat; picture_way: string; state: string }>(
        tx,
        sql`select c.format, c.picture_way, c.state from addon_socialcontent.content c
            join app.custom_records r on r.id = c.record_id and r.archived_at is null
            where c.record_id = ${input.postId}::uuid and c.workspace_id = ${ctx.scope.workspaceId}`,
      ),
    );
    if (!was)
      throw HfosError.notFound(
        'That post isn’t there anymore. Refresh the page to see the ones there are.',
      );
    if (!hasPictures(was.format))
      throw HfosError.rule(
        'socialcontent_no_pictures',
        409,
        was.format === 'video'
          ? 'A video post has no pictures to make: record the video from its script.'
          : 'A post with words only has no picture. Change its format to Picture first.',
      );
    const way = input.way ?? (was.picture_way === 'photo' ? 'photo' : 'design');
    if (way === 'photo' && !ctx.pictures)
      throw HfosError.rule(
        'socialcontent_photos_off',
        503,
        'Photo-style pictures aren’t set up on HandsFreeOS yet. Have it designed instead, or add your own photo.',
      );
    await executeCommand(
      ctx.db,
      contentPictured,
      { workspaceId: ctx.scope.workspaceId, postId: input.postId, state: 'waiting', way },
      ctx.actor,
      ctx.meta,
    );
    await queuePictures(ctx, input.postId, { way, prompt: null, ask: input.ask ?? null });
    return { postId: input.postId, way };
  },
};

type PostForPictures = {
  title: string;
  network: string;
  format: ContentFormat;
  hook: string | null;
  words: string;
  slides: unknown;
  picture: string | null;
  state: string;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'post';

/** Keeps a picture it made as a file on the post. */
async function keepPicture(
  ctx: AddonScopeContext,
  postId: string,
  bytes: Buffer,
  name: string,
  mimeType: 'image/png' | 'image/jpeg',
): Promise<string> {
  const ws = ctx.scope.workspaceId;
  const fileId = randomUUID();
  const path = storedFilePath(ws, 'custom_record', postId, fileId, name);
  assertInWorkspace(path, ws);
  await ctx.store.upload('attachments', path, bytes, mimeType, { upsert: true });
  await executeCommand(
    ctx.db,
    fileStore,
    {
      workspaceId: ws,
      id: fileId,
      recordType: 'custom_record',
      recordId: postId,
      name,
      mimeType,
      from: 'ai',
    },
    ctx.actor,
    ctx.meta,
  );
  return fileId;
}

/** A photo or graphic OpenAI made for a post, cut to the 4:5 portrait every network shows whole. */
interface MadePhoto {
  readonly bytes: Buffer;
  /** What it shows, for the design AI. */
  readonly shows: string;
}

/** The business's last designs, most recent first: the next one starts with a different layout (decision 39). */
async function designsBefore(ctx: AddonScopeContext, postId: string) {
  return asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ style: string | null; font: string | null }>(
      tx,
      sql`select c.design ->> 'style' as style, c.design ->> 'font' as font
          from addon_socialcontent.content c
          where c.workspace_id = ${ctx.scope.workspaceId} and c.design is not null
            and c.record_id <> ${postId}::uuid
          order by c.updated_at desc limit 3`,
    ),
  );
}

/** How the business's last photo posts' pictures went, most recent first: whether OpenAI's graphic was tried and passed. */
async function graphicsBefore(
  ctx: AddonScopeContext,
  postId: string,
): Promise<(GraphicTry | null)[]> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ graphic: { tried?: unknown; passed?: unknown } | null }>(
      tx,
      sql`select c.design -> 'graphic' as graphic from addon_socialcontent.content c
          where c.workspace_id = ${ctx.scope.workspaceId} and c.picture_way = 'photo'
            and c.picture_state = 'made' and c.record_id <> ${postId}::uuid
          order by c.updated_at desc limit 10`,
    ),
  );
  return found.map((r) =>
    r.graphic ? { tried: r.graphic.tried === true, passed: r.graphic.passed === true } : null,
  );
}

const slidesOf = (p: PostForPictures) =>
  Array.isArray(p.slides)
    ? (p.slides as { heading?: unknown; body?: unknown }[]).map((s) => ({
        heading: String(s.heading ?? ''),
        body: String(s.body ?? ''),
      }))
    : [];

/** The design AI lays out a post's pages; `photo` is what the photo under the first page shows, when it has one. */
async function askDesign(
  ctx: AddonScopeContext,
  here: Here,
  business: string,
  postId: string,
  p: PostForPictures,
  ask: string | null,
  photo: string | null,
): Promise<Design> {
  const slides = slidesOf(p);
  const pagesWanted = p.format === 'carousel' && slides.length ? slides.length : 1;
  const choices = designChoices(await designsBefore(ctx, postId), !!photo);
  const { value } = await askStructured(ctx, ctx.scope, {
    system: DESIGN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: designPrompt({
          business,
          businessName: here.businessName,
          color: here.color,
          post: {
            network: isPostingNetwork(p.network) ? p.network : 'instagram',
            format: p.format,
            hook: p.hook,
            words: p.words,
            slides,
            picture: p.picture,
          },
          ask,
          photo,
          choices,
        }),
      },
    ],
    schema: DESIGN_SCHEMA,
    zod: DesignAnswer,
    maxTokens: 3000,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const design = checkedDesign(value, here.color, pagesWanted, {
    photo: !!photo,
    avoid: choices.avoid,
  });
  if (!design) throw new PictureError('The AI’s design had no words to put on the picture.', true);
  return design;
}

/**
 * Claude looks at the pictures beside the words they should say (decision 40). Null when it couldn't be asked: the
 * check never stops a drawn picture, but an OpenAI graphic is kept only when it passed.
 */
async function checkPictures(
  ctx: AddonScopeContext,
  pictures: readonly Buffer[],
  pages: readonly PageToCheck[],
): Promise<PictureCheck | null> {
  try {
    const images: AiContent[] = [];
    for (const bytes of pictures)
      images.push({
        type: 'image',
        mediaType: 'image/jpeg',
        data: (
          await sharp(bytes)
            .resize(CHECKS.width, CHECKS.height, { fit: 'cover' })
            .jpeg({ quality: 82 })
            .toBuffer()
        ).toString('base64'),
      });
    const { value } = await askStructured(ctx, ctx.scope, {
      system: PICTURE_CHECK_SYSTEM,
      messages: [
        { role: 'user', content: [...images, { type: 'text', text: pictureCheckPrompt(pages) }] },
      ],
      schema: PICTURE_CHECK_SCHEMA,
      zod: PictureCheckAnswer,
      maxTokens: 1500,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    return checkedPictureCheck(value, pictures.length);
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    ctx.log.warn({ code: e.code }, 'the pictures couldn’t be checked');
    return null;
  }
}

/**
 * Draws a design and has it checked (decision 40); one that fails is designed once more with its problems to fix,
 * and the one with fewer problems is kept.
 */
async function drawChecked(
  ctx: AddonScopeContext,
  here: Here,
  business: string,
  postId: string,
  p: PostForPictures,
  ask: string | null,
  first: Design,
  photo: MadePhoto | null,
): Promise<{ design: Design; pictures: Drawn[]; check: PictureCheck | null }> {
  const drawn = async (d: Design) => {
    const pictures = await drawDesign(d, photo?.bytes ?? null);
    const check = withCutWords(
      await checkPictures(
        ctx,
        pictures.map((x) => x.bytes),
        d.pages.map(pageToCheck),
      ),
      pictures.map((x) => !!x.cut),
    );
    return { design: d, pictures, check };
  };
  const one = await drawn(first);
  if (!one.check || one.check.passes) return one;
  ctx.log.info(
    { postId, problems: one.check.problems },
    'a design failed its check; designing it again',
  );
  try {
    const two = await drawn(
      await askDesign(ctx, here, business, postId, p, fixAsk(one.check, ask), photo?.shows ?? null),
    );
    return !two.check || two.check.problems.length <= one.check.problems.length ? two : one;
  } catch (e) {
    if (!(e instanceof AiAskError) && !(e instanceof PictureError)) throw e;
    return one;
  }
}

async function keepPictures(
  ctx: AddonScopeContext,
  postId: string,
  p: PostForPictures,
  pictures: readonly Drawn[],
): Promise<string[]> {
  const fileIds: string[] = [];
  for (const [i, pic] of pictures.entries())
    fileIds.push(
      await keepPicture(
        ctx,
        postId,
        pic.bytes,
        `${slug(p.title)}${pictures.length > 1 ? `-${i + 1}` : ''}.${pic.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
        pic.mimeType,
      ),
    );
  return fileIds;
}

/**
 * OpenAI makes one picture for a post (decisions 14, 39 and 40): a photo with no words, or a whole graphic with the
 * words in it. Each is charged its 9¢ as soon as it's made, kept or not, since OpenAI charges for it.
 */
async function openAiPicture(
  ctx: AddonScopeContext,
  postId: string,
  title: string,
  prompt: string,
  what: string,
): Promise<Buffer> {
  const maker = ctx.pictures;
  if (!maker)
    throw new PictureError(
      'Photo-style pictures aren’t set up on HandsFreeOS yet. Have it designed instead, or add your own photo.',
      false,
    );
  const room = await asWorker(ctx.db, ctx.scope, (tx) =>
    walletRoom(tx, ctx.scope.workspaceId, 'ai', (m, e) => ctx.log.error({ err: e }, m)),
  );
  if (!room.allowed) throw new PictureError(WALLET_REFUSALS.ai, false);
  const made = await maker.make(prompt);
  if (made.model !== maker.model)
    ctx.log.warn(
      { postId, model: maker.model, backup: made.model },
      'the image model was busy; the backup made the picture',
    );
  await chargeUsage(ctx.wallet, ctx.scope, {
    parts: [{ key: 'ai.image', quantity: 1 }],
    idempotencyKey: aiImageUsageKey(randomUUID()),
    subject: `${what} for “${title.slice(0, 80)}”`,
    // What OpenAI really counted, kept beside the 9¢ so the price can be checked against it (owner's pick, 11 Nov).
    meta: { postId, model: made.model, ...(made.usage ? { openAi: made.usage } : {}) },
  });
  return sharp(made.bytes)
    .resize(PICTURE_WIDTH, PICTURE_HEIGHT, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** What the photo shows: the AI's description from when it wrote the post, else the post itself. */
const photoShows = (p: PostForPictures, prompt: string | null) =>
  prompt ?? p.picture ?? p.hook ?? p.words.slice(0, 400);

/**
 * OpenAI's whole graphic, words and all (decision 40), kept only when the check passed it; null otherwise, with how
 * the try went.
 */
async function tryGraphic(
  ctx: AddonScopeContext,
  postId: string,
  p: PostForPictures,
  design: Design,
  prompt: string | null,
  ask: string | null,
): Promise<{
  readonly picture: Drawn | null;
  readonly graphic: GraphicTry & { problems?: string[] };
}> {
  const page = design.pages[0]!;
  let bytes: Buffer;
  try {
    bytes = await openAiPicture(
      ctx,
      postId,
      p.title,
      graphicPromptFor({ shows: photoShows(p, prompt), page, colors: design, ask }),
      'OpenAI graphic',
    );
  } catch (e) {
    if (e instanceof PictureError && !e.retryable && !e.refused) throw e;
    if (!(e instanceof PictureError)) throw e;
    ctx.log.warn(
      { err: e, postId },
      'OpenAI’s graphic couldn’t be made; the words are drawn over a photo',
    );
    return { picture: null, graphic: { tried: true, passed: false } };
  }
  const check = await checkPictures(
    ctx,
    [bytes],
    [{ words: [page.kicker, page.heading].filter((w): w is string => !!w) }],
  );
  if (check?.passes)
    return { picture: { bytes, mimeType: 'image/jpeg' }, graphic: { tried: true, passed: true } };
  ctx.log.info(
    { postId, problems: check?.problems },
    'OpenAI’s graphic failed its check; the words are drawn over a photo',
  );
  return {
    picture: null,
    graphic: { tried: true, passed: false, ...(check ? { problems: check.problems } : {}) },
  };
}

/** Why a picture didn't work, in words a person can read. */
function pictureFailure(e: unknown): string {
  if (e instanceof PictureError) return e.message.slice(0, 300);
  if (e instanceof AiAskError) return aiRefusal(e).message.slice(0, 300);
  return 'Something went wrong making the picture. Press Make it again to try once more.';
}

/**
 * `socialcontent.pictures`: one post's AI-made pictures. The design comes first (its words); a photo post's single
 * picture is then OpenAI's whole graphic when one is due and passes the check (decision 40), else a photo OpenAI
 * makes with the words drawn over it (decision 39); a designed one is drawn. Every drawn picture is checked, and
 * designed once more when it fails.
 */
export const runPictures: AddonJobHandler = async (ctx) => {
  const postId = String(ctx.job.payload['postId'] ?? '');
  const payloadWay = ctx.job.payload['way'];
  const prompt = typeof ctx.job.payload['prompt'] === 'string' ? ctx.job.payload['prompt'] : null;
  const ask = typeof ctx.job.payload['ask'] === 'string' ? ctx.job.payload['ask'] : null;
  const [p] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<PostForPictures & { picture_way: string }>(
      tx,
      sql`select r.name as title, c.network, c.format, c.hook, c.words, c.slides, c.picture, c.state, c.picture_way
          from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
          where c.record_id = ${postId}::uuid and c.workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!p || p.state === 'posted' || p.state === 'posting' || !hasPictures(p.format)) return;
  const asked = payloadWay === 'photo' || payloadWay === 'design' ? payloadWay : p.picture_way;
  if (asked !== 'photo' && asked !== 'design') return;
  // Without OpenAI's image model here, a photo-style picture is designed instead.
  let way: 'design' | 'photo' = asked === 'photo' && !ctx.pictures ? 'design' : asked;
  const pictured = (input: Omit<z.input<typeof ContentPicturedInput>, 'workspaceId' | 'postId'>) =>
    executeCommand(
      ctx.db,
      contentPictured,
      { workspaceId: ctx.scope.workspaceId, postId, ...input },
      ctx.actor,
      ctx.meta,
    );
  await pictured({ state: 'making', way });
  try {
    const here = await hereOf(ctx);
    const business = await businessText(ctx);
    const shows = way === 'photo' ? (p.picture ?? photoShows(p, prompt)) : null;
    let design = await askDesign(ctx, here, business, postId, p, ask, shows);
    let graphic: (GraphicTry & { problems?: string[] }) | null = null;
    if (way === 'photo' && p.format !== 'carousel' && fitsGraphic(design.pages[0]!)) {
      if (graphicDue(await graphicsBefore(ctx, postId))) {
        const tried = await tryGraphic(ctx, postId, p, design, prompt, ask);
        graphic = tried.graphic;
        if (tried.picture) {
          const fileIds = await keepPictures(ctx, postId, p, [tried.picture]);
          await pictured({
            state: 'made',
            way,
            fileIds,
            design: { ...design, graphic } as unknown as Record<string, unknown>,
          });
          return;
        }
      } else graphic = { tried: false, passed: false };
    }
    // A photo OpenAI makes goes under the words, like a picture made in Canva (decision 39). When it can't be made
    // on the last try, the picture is designed without it rather than left without one.
    let photo: MadePhoto | null = null;
    if (way === 'photo')
      try {
        photo = {
          bytes: await openAiPicture(
            ctx,
            postId,
            p.title,
            photoPromptFor(photoShows(p, prompt), ask),
            'Photo-style picture',
          ),
          shows: shows ?? '',
        };
      } catch (e) {
        const again =
          (e instanceof PictureError && e.retryable) || (e instanceof AiAskError && e.retryable);
        if (again && ctx.attempt < 3) throw e;
        if (e instanceof PictureError && !e.retryable && !e.refused) throw e;
        ctx.log.warn(
          { err: e, postId },
          'the photo couldn’t be made; the picture is designed instead',
        );
        way = 'design';
        design = await askDesign(ctx, here, business, postId, p, ask, null);
      }
    const done = await drawChecked(ctx, here, business, postId, p, ask, design, photo);
    const fileIds = await keepPictures(ctx, postId, p, done.pictures);
    await pictured({
      state: 'made',
      way,
      fileIds,
      design: {
        ...done.design,
        ...(done.check ? { check: done.check } : {}),
        ...(graphic ? { graphic } : {}),
      } as unknown as Record<string, unknown>,
    });
  } catch (e) {
    const retryable =
      (e instanceof PictureError && e.retryable) || (e instanceof AiAskError && e.retryable);
    if (retryable && ctx.attempt < 3) throw e;
    if (!(e instanceof PictureError) && !(e instanceof AiAskError))
      ctx.log.error({ err: e, postId }, 'a post’s picture couldn’t be made');
    await pictured({ state: 'failed', way, failure: pictureFailure(e) });
  }
};
