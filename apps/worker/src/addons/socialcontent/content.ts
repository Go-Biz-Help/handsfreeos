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
  emptySlots,
  hasPictures,
  isPostingNetwork,
  planOf,
  POSTING_NETWORKS,
  slotsAhead,
  type ContentFormat,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import {
  calendarFilled,
  contentPictured,
  contentPut,
} from '@hfos/core/addons/socialcontent/ops/worker';
import {
  checkedDesign,
  checkedPost,
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
import type { ContentPicturedInput } from '@hfos/core/addons/socialcontent/content-shapes';
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
import { businessText } from './business';
import { drawDesign, PICTURE_HEIGHT, PICTURE_WIDTH } from './draw';
import { aiRefusal } from './notes';
import type { AddonJobHandler, AddonScopeContext, AddonWorkerAction } from '../types';

export const CALENDAR_JOB = 'socialcontent.calendar';
export const PICTURES_JOB = 'socialcontent.pictures';
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
}

async function hereOf(ctx: AddonScopeContext): Promise<Here> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [w] = await rows<{ timezone: string | null; name: string; settings: unknown }>(
      tx,
      sql`select timezone, name, settings from app.workspaces where id = ${ctx.scope.workspaceId}`,
    );
    const [s] = await rows<{ plan: unknown }>(
      tx,
      sql`select plan from addon_socialcontent.settings where workspace_id = ${ctx.scope.workspaceId}`,
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
};

async function ideaOf(ctx: AddonScopeContext, ideaId: string): Promise<IdeaRow> {
  const [i] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<IdeaRow>(
      tx,
      sql`select id, title, hook, format, network, outline, why from addon_socialcontent.ideas
          where id = ${ideaId}::uuid and workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!i)
    throw HfosError.notFound(
      'That idea isn’t there anymore. Refresh the page to see the ones there are.',
    );
  return i;
}

/** The posts in the calendar now: what's taken on each network each day. */
async function takenDays(ctx: AddonScopeContext) {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ network: string; post_at: Date | string; state: string }>(
      tx,
      sql`select c.network, c.post_at, c.state from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
          where c.workspace_id = ${ctx.scope.workspaceId} and c.post_at > now() - interval '1 day'`,
    ),
  );
  return found.flatMap((t) =>
    isPostingNetwork(t.network)
      ? [
          {
            network: t.network,
            postAt: new Date(t.post_at).getTime(),
            state: t.state as 'draft',
          },
        ]
      : [],
  );
}

/** The plan's open days ahead, soonest first. */
async function openSlots(ctx: AddonScopeContext, here: Here) {
  return emptySlots(
    slotsAhead(here.plan, here.timeZone, Date.now()),
    await takenDays(ctx),
    here.timeZone,
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
  const post = checkedPost(value, input.network);
  if (!post) return null;
  // Without OpenAI's image model here, a photo-style picture is designed instead.
  return post.pictureWay === 'photo' && !ctx.pictures ? { ...post, pictureWay: 'design' } : post;
}

const ideaForAi = (i: IdeaRow | null): WriteInput['idea'] =>
  i ? { title: i.title, hook: i.hook, format: i.format, outline: i.outline, why: i.why } : null;

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
      post: {
        title: post.title,
        format: post.format,
        hook: post.hook,
        words: post.words,
        hashtags: post.hashtags,
        slides: post.slides,
        script: post.script,
        picture: post.picture,
        pictureWay: post.pictureWay,
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
      'Have the AI write one of the business’s own posts for Instagram, Facebook or LinkedIn, from a content idea (ideaId), or from a few words of what it should be about (ask), using the Playbook and what HandsFreeOS knows about the business. It goes on the next open day in the plan for that network unless postAt is given, and waits for an OK; its picture is made on its own when the AI makes it.',
    autonomy: 'auto',
    keywords: ['write a post', 'social post', 'caption', 'content calendar'],
  },
  input: WriteInputShape,
  async run(ctx, input) {
    const idea = input.ideaId ? await ideaOf(ctx, input.ideaId) : null;
    const here = await hereOf(ctx);
    const network: PostingNetwork =
      input.network ??
      (idea?.network && isPostingNetwork(idea.network) ? idea.network : null) ??
      POSTING_NETWORKS.find((n) => here.plan[n].perWeek > 0) ??
      'instagram';
    if (!idea && !input.ask && !here.playbook)
      throw HfosError.rule(
        'socialcontent_nothing_to_write_from',
        409,
        'Say what the post should be about, or pick an idea under Ideas to write it from.',
      );
    let post: WrittenPost | null;
    try {
      post = await writeOne(ctx, {
        network,
        playbook: here.playbook,
        idea: ideaForAi(idea),
        ask: input.ask ?? null,
        before: null,
      });
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e) : e;
    }
    if (!post) throw emptyPost();
    const postAt = input.postAt
      ? new Date(input.postAt).getTime()
      : ((await openSlots(ctx, here)).find((s) => s.network === network)?.at ?? null);
    const postId = await keep(ctx, post, {
      network,
      ideaId: idea?.id ?? null,
      postAt,
      askedBy: ctx.userId,
    });
    return { postId, postAt: postAt ? new Date(postAt).toISOString() : null };
  },
};

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
    const [was] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{
        network: string;
        format: ContentFormat;
        words: string;
        idea_id: string | null;
        state: string;
      }>(
        tx,
        sql`select c.network, c.format, c.words, c.idea_id, c.state from addon_socialcontent.content c
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
    let post: WrittenPost | null;
    try {
      post = await writeOne(ctx, {
        network: was.network,
        playbook: here.playbook,
        idea: ideaForAi(idea),
        ask: input.ask ?? null,
        before: { words: was.words, format: was.format },
      });
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e) : e;
    }
    if (!post) throw emptyPost();
    await keep(ctx, post, { network: was.network, postId: input.postId, askedBy: ctx.userId });
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
      'Fill the business’s content calendar: the AI writes a post for each open day in the plan over the next two weeks (saved ideas first, then new ones, then from the Playbook), each waiting for an OK, with their pictures. After that it tops up once a week on its own. Says how many open days there are; the posts show on the calendar as they’re written, over a few minutes.',
    autonomy: 'confirm',
    keywords: ['fill calendar', 'content calendar', 'plan my posts', 'next two weeks of posts'],
  },
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(ctx) {
    const here = await hereOf(ctx);
    const open = await openSlots(ctx, here);
    if (!open.length) return { open: 0 };
    await queueFill(ctx, new Date(), true);
    return { open: open.length };
  },
};

/** Ideas to write from, best first: saved ones, then new ones, oldest first. */
async function ideasToUse(ctx: AddonScopeContext): Promise<IdeaRow[]> {
  return asWorker(ctx.db, ctx.scope, (tx) =>
    rows<IdeaRow>(
      tx,
      sql`select id, title, hook, format, network, outline, why from addon_socialcontent.ideas
          where workspace_id = ${ctx.scope.workspaceId} and state in ('saved', 'new')
          order by (state = 'saved') desc, coalesce(decided_at, created_at)
          limit 60`,
    ),
  );
}

/**
 * `socialcontent.calendar`: a post for each open day in the plan over the next two weeks, a few at a time. Once
 * every day has one, it's marked filled and runs again in a week.
 */
export const runCalendar: AddonJobHandler = async (ctx) => {
  try {
    const here = await hereOf(ctx);
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
    const ideas = await ideasToUse(ctx);
    const business = await businessText(ctx);
    let written = 0;
    for (const slot of open.slice(0, FILL_PER_RUN)) {
      const at = ideas.findIndex((i) => i.network === slot.network || i.network === null);
      const idea = at >= 0 ? ideas.splice(at, 1)[0]! : (ideas.shift() ?? null);
      if (!idea && !here.playbook) break;
      const post = await writeOne(ctx, {
        business,
        network: slot.network,
        playbook: here.playbook,
        idea: ideaForAi(idea),
        ask: null,
        before: null,
      });
      if (!post) continue;
      await keep(ctx, post, { network: slot.network, ideaId: idea?.id ?? null, postAt: slot.at });
      written++;
    }
    if (written && open.length > FILL_PER_RUN) return { rescheduleAt: new Date(ctx.now + SOON_MS) };
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
      'Make the pictures for one of the business’s own posts again, or another way: "design" for a picture with words on it in the business’s colour (and each slide of a carousel), "photo" for a lifelike picture with no words from OpenAI’s image AI (9¢ each). ask says what to change. They replace the AI’s earlier pictures and take the post’s OK back; they show on the post in a minute.',
    autonomy: 'confirm',
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
    const asked = input.way ?? (was.picture_way === 'photo' ? 'photo' : 'design');
    const way = was.format === 'carousel' ? 'design' : asked;
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

async function designPictures(
  ctx: AddonScopeContext,
  postId: string,
  p: PostForPictures,
  ask: string | null,
): Promise<{ fileIds: string[]; design: Design }> {
  const here = await hereOf(ctx);
  const slides = Array.isArray(p.slides)
    ? (p.slides as { heading?: unknown; body?: unknown }[]).map((s) => ({
        heading: String(s.heading ?? ''),
        body: String(s.body ?? ''),
      }))
    : [];
  const pagesWanted = p.format === 'carousel' && slides.length ? slides.length : 1;
  const { value } = await askStructured(ctx, ctx.scope, {
    system: DESIGN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: designPrompt({
          business: await businessText(ctx),
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
        }),
      },
    ],
    schema: DESIGN_SCHEMA,
    zod: DesignAnswer,
    maxTokens: 2500,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const design = checkedDesign(value, here.color, pagesWanted);
  if (!design) throw new PictureError('The AI’s design had no words to put on the picture.', true);
  const pngs = await drawDesign(design);
  const fileIds: string[] = [];
  for (const [i, png] of pngs.entries())
    fileIds.push(
      await keepPicture(
        ctx,
        postId,
        png,
        `${slug(p.title)}${pngs.length > 1 ? `-${i + 1}` : ''}.png`,
        'image/png',
      ),
    );
  return { fileIds, design };
}

async function photoPicture(
  ctx: AddonScopeContext,
  postId: string,
  p: PostForPictures,
  prompt: string | null,
  ask: string | null,
): Promise<string> {
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
  const described = prompt ?? p.picture ?? p.hook ?? p.words.slice(0, 400);
  const made = await maker.make(photoPromptFor(described, ask));
  // The 4:5 portrait every network shows whole, cut from the middle.
  const jpeg = await sharp(made)
    .resize(PICTURE_WIDTH, PICTURE_HEIGHT, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 88 })
    .toBuffer();
  const fileId = await keepPicture(ctx, postId, jpeg, `${slug(p.title)}.jpg`, 'image/jpeg');
  await chargeUsage(ctx.wallet, ctx.scope, {
    parts: [{ key: 'ai.image', quantity: 1 }],
    idempotencyKey: aiImageUsageKey(fileId),
    subject: `Photo-style picture for “${p.title.slice(0, 80)}”`,
    meta: { postId, fileId, model: maker.model },
  });
  return fileId;
}

/** Why a picture didn't work, in words a person can read. */
function pictureFailure(e: unknown): string {
  if (e instanceof PictureError) return e.message.slice(0, 300);
  if (e instanceof AiAskError) return aiRefusal(e).message.slice(0, 300);
  return 'Something went wrong making the picture. Press Make it again to try once more.';
}

/** `socialcontent.pictures`: one post's AI-made pictures, designed or photo-style. */
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
  // A carousel's slides are designed; without OpenAI's image model here, a photo is designed too.
  const way = p.format === 'carousel' || (asked === 'photo' && !ctx.pictures) ? 'design' : asked;
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
    if (way === 'design') {
      const { fileIds, design } = await designPictures(ctx, postId, p, ask);
      await pictured({
        state: 'made',
        way,
        fileIds,
        design: design as unknown as Record<string, unknown>,
      });
    } else {
      const fileId = await photoPicture(ctx, postId, p, prompt, ask);
      await pictured({ state: 'made', way, fileIds: [fileId], design: null });
    }
  } catch (e) {
    const retryable =
      (e instanceof PictureError && e.retryable) || (e instanceof AiAskError && e.retryable);
    if (retryable && ctx.attempt < 3) throw e;
    if (!(e instanceof PictureError) && !(e instanceof AiAskError))
      ctx.log.error({ err: e, postId }, 'a post’s picture couldn’t be made');
    await pictured({ state: 'failed', way, failure: pictureFailure(e) });
  }
};
