/**
 * The business's own posts and their calendar, for a person (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md,
 * part 8, decisions 13 to 20; docs/socialcontent.md, "Making posts"): the calendar, a post, changing one, OK'ing one
 * or the week, and skipping one. The AI writes posts and makes their pictures in the worker
 * (apps/worker/src/addons/socialcontent/content.ts), through ./worker.ts.
 *
 * Each post is a Social post record (`socialcontent_post`), so its pictures are core files on the record and its
 * timeline, tasks and search work unchanged; this add-on's own row (`content`) keeps the rest. Nothing goes up
 * without an OK (decision 15), and changing an OK'd post takes the OK back.
 */
import { rows, sql } from '@hfos/db/client';
import { and, eq } from 'drizzle-orm';
import { addDays, daysBetween, localDateOf, localInstant } from '../../../calendar/engine/zoned';
import { customRecordArchive, customRecordUpdate } from '../../../commands/custom-record';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CALENDAR,
  chainFor,
  formatFor,
  hasPictures,
  POSTING,
  stillNeeds,
  type ContentState,
} from '../calendar';
import { learnedShown, openSlots } from '../schedule';
import {
  CalendarGetInput,
  CalendarGetOutput,
  Content as ContentShape,
  ContentApproveInput,
  ContentApproveWeekInput,
  ContentApproveWeekOutput,
  ContentGetInput,
  ContentListInput,
  ContentListOutput,
  ContentRemoveInput,
  ContentRemoveOutput,
  ContentSaveInput,
  ContentSkipInput,
  type Content,
  type ContentPicture,
} from '../content-shapes';
import { socialcontentAddon } from '../manifest';
import { tidyHashtags } from '../posts-ai';
import { isAngle } from '../variety';
import { isOfferList } from '../../../main-offer/lists';
import { content } from '../tables';
import { SOCIALCONTENT_WORDS as W } from '../words';
import { inWorkspace, mayManage, offerLiveOf, settingsOf, timeZoneOf, type Ctx } from './common';
import { learnedTimesOf, postsOnCalendar } from './schedule';

const PATH = 'a/socialcontent/calendar';
/** An OK needs its time at least this far ahead: a post OK'd for a minute ago would never go. */
const AHEAD_MS = 60_000;

export const POST_REFUSALS = {
  gone: 'That post isn’t there anymore. Refresh the page to see the ones there are.',
  posted: (network: string) =>
    `That post already went up, so it can’t be changed here. Change it on ${network} itself.`,
  posting: 'That post is going up right now. Try again in a minute.',
  past: 'Its time has passed. Pick a later day under When it goes, then OK it.',
  notOnPost:
    'One of those pictures isn’t on this post anymore. Refresh the page, then add it again with Add your photo.',
  skipped: 'That post is skipped. Bring it back first, then OK it.',
  removeWho:
    'Only an owner or admin removes posts. Press Skip it instead, which opens its day for another post too, or ask one of them.',
  removePosted: (network: string) =>
    `That post already went up, so it stays on the calendar with its numbers. To take it down, delete it on ${network} itself.`,
} as const;

export type ContentRow = typeof content.$inferSelect & { title: string };

/** The post, with its record's name, when it's in this business and not in the Deleted bin. */
export async function loadContent(
  ctx: Ctx,
  postId: string,
  opts: { lock?: boolean } = {},
): Promise<ContentRow> {
  const [r] = await rows<{ title: string }>(
    ctx.tx,
    sql`select r.name as title from app.custom_records r
        join addon_socialcontent.content c on c.record_id = r.id
        where r.id = ${postId}::uuid and r.workspace_id = ${ctx.scope.workspaceId!} and r.archived_at is null`,
  );
  if (!r) throw HfosError.notFound(POST_REFUSALS.gone);
  const [c] = await (opts.lock
    ? ctx.tx
        .select()
        .from(content)
        .where(and(eq(content.recordId, postId), eq(content.workspaceId, ctx.scope.workspaceId!)))
        .for('update')
    : ctx.tx
        .select()
        .from(content)
        .where(and(eq(content.recordId, postId), eq(content.workspaceId, ctx.scope.workspaceId!))));
  if (!c) throw HfosError.notFound(POST_REFUSALS.gone);
  return { ...c, title: r.title };
}

const networkWord = (n: string) =>
  n === 'instagram'
    ? 'Instagram'
    : n === 'facebook'
      ? 'Facebook'
      : n === 'linkedin'
        ? 'LinkedIn'
        : n;

/** Refuses a change to a post that went up or is going up now. */
export function needChangeable(c: Pick<ContentRow, 'state' | 'network'>): void {
  if (c.state === 'posted')
    throw HfosError.rule(
      'socialcontent_post_posted',
      409,
      POST_REFUSALS.posted(networkWord(c.network)),
    );
  if (c.state === 'posting')
    throw HfosError.rule('socialcontent_post_posting', 409, POST_REFUSALS.posting);
}

const POST_SELECT = sql`
  select c.*, r.name as title from addon_socialcontent.content c
  join app.custom_records r on r.id = c.record_id and r.archived_at is null`;

type RawRow = Record<string, unknown> & { title: string };
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asDate = (v: unknown): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));

/** A row read with raw SQL, in the Drizzle row's shape. */
function fromRaw(r: RawRow): ContentRow {
  return {
    recordId: String(r['record_id']),
    workspaceId: String(r['workspace_id']),
    ideaId: (r['idea_id'] as string | null) ?? null,
    network: r['network'] as ContentRow['network'],
    format: r['format'] as ContentRow['format'],
    words: String(r['words'] ?? ''),
    hook: (r['hook'] as string | null) ?? null,
    hashtags: (r['hashtags'] as string[] | null) ?? [],
    chain: (r['chain'] as string[] | null) ?? [],
    slides: (r['slides'] as ContentRow['slides']) ?? [],
    script: (r['script'] as ContentRow['script']) ?? null,
    picture: (r['picture'] as string | null) ?? null,
    pictureWay: r['picture_way'] as ContentRow['pictureWay'],
    pictureState: r['picture_state'] as ContentRow['pictureState'],
    pictureFailure: (r['picture_failure'] as string | null) ?? null,
    design: (r['design'] as ContentRow['design']) ?? null,
    fileIds: (r['file_ids'] as string[] | null) ?? [],
    facebookWhere: (r['facebook_where'] as ContentRow['facebookWhere']) ?? [],
    state: r['state'] as ContentState,
    postAt: asDate(r['post_at']),
    approvedBy: (r['approved_by'] as string | null) ?? null,
    approvedAt: asDate(r['approved_at']),
    postedAt: asDate(r['posted_at']),
    postLink: (r['post_link'] as string | null) ?? null,
    failure: (r['failure'] as string | null) ?? null,
    madeBy: r['made_by'] as ContentRow['madeBy'],
    placedBy: r['placed_by'] === 'person' ? 'person' : 'ai',
    angle: isAngle(r['angle']) ? r['angle'] : null,
    topicList: isOfferList(r['topic_list']) ? r['topic_list'] : null,
    topic: (r['topic'] as string | null) ?? null,
    postingAt: asDate(r['posting_at']),
    postedTo: Array.isArray(r['posted_to']) ? (r['posted_to'] as ContentRow['postedTo']) : [],
    numbers: isPlainObject(r['numbers']) ? (r['numbers'] as ContentRow['numbers']) : {},
    checksDueAt: asDate(r['checks_due_at']),
    doneWell: isPlainObject(r['done_well'])
      ? (r['done_well'] as unknown as ContentRow['doneWell'])
      : null,
    createdBy: (r['created_by'] as string | null) ?? null,
    createdAt: asDate(r['created_at'])!,
    updatedAt: asDate(r['updated_at'])!,
    title: r.title,
  };
}

async function readPosts(ctx: Ctx, where: ReturnType<typeof sql>): Promise<ContentRow[]> {
  const found = await rows<RawRow>(
    ctx.tx,
    sql`${POST_SELECT} where c.workspace_id = ${ctx.scope.workspaceId!} and ${where}`,
  );
  return found.map(fromRaw);
}

/** Posts as shown: their pictures (files still on the record, in order), who OK'd them and what each still needs. */
export async function contentOut(ctx: Ctx, list: readonly ContentRow[]): Promise<Content[]> {
  if (!list.length) return [];
  const ids = [...new Set(list.flatMap((c) => c.fileIds))];
  const files = ids.length
    ? await rows<{
        id: string;
        record_id: string;
        bucket: string;
        object_path: string;
        name: string;
        mime_type: string | null;
      }>(
        ctx.tx,
        sql`select id, record_id, bucket, object_path, name, mime_type from app.files
            where workspace_id = ${ctx.scope.workspaceId!} and id = any(${`{${ids.join(',')}}`}::uuid[])
              and status = 'ready' and deleted_at is null`,
      )
    : [];
  const fileById = new Map(files.map((f) => [f.id, f]));
  const approvers = [...new Set(list.map((c) => c.approvedBy).filter((u): u is string => !!u))];
  const names = approvers.length
    ? await rows<{ id: string; name: string }>(
        ctx.tx,
        sql`select id, coalesce(nullif(btrim(full_name), ''), email::text) as name from app.users
            where id = any(${`{${approvers.join(',')}}`}::uuid[])`,
      )
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  const s = await settingsOf(ctx);
  return list.map((c) => {
    const pictures: ContentPicture[] = c.fileIds.flatMap((id) => {
      const f = fileById.get(id);
      return f && f.record_id === c.recordId
        ? [
            {
              fileId: f.id,
              bucket: f.bucket,
              objectPath: f.object_path,
              name: f.name,
              mimeType: f.mime_type,
            },
          ]
        : [];
    });
    return ContentShape.parse({
      id: c.recordId,
      title: c.title,
      network: c.network,
      format: c.format,
      words: c.words,
      hook: c.hook,
      hashtags: c.hashtags,
      chain: c.chain ?? [],
      slides: Array.isArray(c.slides) ? c.slides : [],
      script: c.script && Array.isArray(c.script.lines) ? c.script : null,
      picture: c.picture,
      pictureWay: c.pictureWay,
      pictureState: c.pictureState,
      pictureFailure: c.pictureFailure,
      pictures,
      facebookWhere: c.facebookWhere,
      state: c.state,
      postAt: c.postAt?.toISOString() ?? null,
      approvedBy: c.approvedBy ? (nameById.get(c.approvedBy) ?? null) : null,
      approvedAt: c.approvedAt?.toISOString() ?? null,
      postedAt: c.postedAt?.toISOString() ?? null,
      postLink: c.postLink,
      postedTo: Array.isArray(c.postedTo) ? c.postedTo : [],
      numbers: isPlainObject(c.numbers) ? c.numbers : {},
      doneWell: c.doneWell ?? null,
      failure: c.failure,
      madeBy: c.madeBy,
      placedBy: c.placedBy,
      angle: c.angle,
      topic: c.topicList && c.topic ? { list: c.topicList, line: c.topic } : null,
      ideaId: c.ideaId,
      stillNeeds: stillNeeds({
        network: c.network,
        format: c.format,
        words: c.words,
        hashtags: c.hashtags,
        chain: c.chain ?? [],
        slides: Array.isArray(c.slides) ? c.slides : [],
        fileIds: pictures.map((p) => p.fileId),
        videos: pictures.filter((p) => p.mimeType?.startsWith('video/')).length,
        postAt: c.postAt,
        facebookWhere: c.facebookWhere,
        facebookPage: s.facebookPage,
      }),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    });
  });
}

/** A person's name as the business sees it. */
async function nameOf(ctx: Ctx, userId: string): Promise<string | null> {
  const [u] = await rows<{ name: string | null }>(
    ctx.tx,
    sql`select coalesce(nullif(btrim(full_name), ''), email::text) as name from app.users where id = ${userId}::uuid`,
  );
  return u?.name ?? null;
}

/** The day range a calendar shows, as instants in the business's time zone. */
function rangeOf(from: string, days: number, timeZone: string) {
  const end = addDays(from, days);
  return {
    end,
    start: new Date(localInstant(from, '00:00', timeZone)),
    stop: new Date(localInstant(end, '00:00', timeZone)),
  };
}

// ------------------------------------------------------------------------------------------------ reading

/** How far back the Calendar lists what went up (part 11). */
const RECENT_DAYS = 30;

export const calendarGet = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.calendar.get',
  description:
    'The business’s content calendar: its own posts going in the next two weeks (or the days asked for), soonest first, each with its network, format, words, hashtags, slides or script, pictures, when it goes and whether it’s waiting for an OK, OK’d, posted or skipped (and what it still needs before it can be OK’d); drafts with no day yet; what went up in the 30 days before, each with its numbers 2 and 7 days after it went up and whether it did well against the business’s own other posts; the plan’s open places with no post yet (each AI picks hour, and whether it’s an hour the AI is trying out); the plan itself (for each of Instagram, Facebook and LinkedIn: AI picks, with posts a week, the most a day and the hours it posts between, or I pick, with the times picked on each weekday); what AI picks learned (its best hours so far, from the creators’ posts or the business’s own); when it last filled, whether it fills on its own (autoFill) and when it fills again; whether the main offer is live (offerLive: until it is, the AI writes no posts); and how many ideas are saved to write from.',
  input: CalendarGetInput,
  output: CalendarGetOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_get_calendar' },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const timeZone = await timeZoneOf(ctx);
    const now = Date.now();
    const today = localDateOf(now, timeZone);
    const from = input.from ?? today;
    const { end, start, stop } = rangeOf(from, input.days, timeZone);
    const s = await settingsOf(ctx);
    const inRange = await readPosts(
      ctx,
      sql`c.post_at >= ${start.toISOString()}::timestamptz and c.post_at < ${stop.toISOString()}::timestamptz
          order by c.post_at, c.created_at`,
    );
    const undated = await readPosts(
      ctx,
      sql`c.post_at is null and c.state = 'draft' order by c.created_at desc limit 50`,
    );
    // What went up in the 30 days before these days, with how each did (part 11).
    const recent = await readPosts(
      ctx,
      sql`jsonb_array_length(c.posted_to) > 0
          and (c.post_at is null or c.post_at < ${start.toISOString()}::timestamptz)
          and coalesce(c.posted_at, c.updated_at) > ${new Date(now - RECENT_DAYS * 86_400_000).toISOString()}::timestamptz
          order by coalesce(c.posted_at, c.updated_at) desc limit 20`,
    );
    const ahead = Math.max(0, daysBetween(today, end) - 1);
    const times = await learnedTimesOf(ctx.tx, ws, timeZone);
    const open = openSlots({
      plan: s.plan,
      times,
      taken: await postsOnCalendar(ctx.tx, ws, timeZone, now),
      timeZone,
      now,
      days: ahead,
    }).filter((slot) => slot.date >= from && slot.date < end);
    const [counts] = await rows<{ saved: number; ready: number }>(
      ctx.tx,
      sql`select
            (select count(*)::int from addon_socialcontent.ideas where workspace_id = ${ws} and state = 'saved') as saved,
            (select count(*)::int from addon_socialcontent.content c
               join app.custom_records r on r.id = c.record_id and r.archived_at is null
               where c.workspace_id = ${ws} and c.state = 'ready') as ready`,
    );
    return {
      timeZone,
      today,
      from,
      days: input.days,
      plan: s.plan,
      learned: learnedShown(s.plan, times),
      open: open.map((o) => ({ ...o, at: new Date(o.at).toISOString() })),
      posts: await contentOut(ctx, inRange),
      undated: await contentOut(ctx, undated),
      recent: await contentOut(ctx, recent),
      filledAt: s.filledAt,
      autoFill: s.autoFill,
      offerLive: await offerLiveOf(ctx),
      nextFillAt:
        s.filledAt && s.autoFill
          ? new Date(new Date(s.filledAt).getTime() + CALENDAR.everyDays * 86_400_000).toISOString()
          : null,
      ideasSaved: counts?.saved ?? 0,
      ready: counts?.ready ?? 0,
      poster: s.readerUserId
        ? {
            name: await nameOf(ctx, s.readerUserId),
            mine: userIdOf(ctx.actor) === s.readerUserId,
            seenAt: s.readerSeenAt,
            version: s.readerVersion,
          }
        : null,
      postsOn: [...POSTING.networks],
      facebookPage: s.facebookPage,
      mayManage: mayManage(ctx),
    };
  },
});

export const contentGet = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.content.get',
  description:
    'One of the business’s own posts: its network, format, title, words, hook, hashtags, a carousel’s slides or a video’s script, what its picture shows and how it’s made (designed by the AI, a photo-style picture from the AI, or the person’s own), its pictures, where on Facebook it goes, when it goes, whether it’s waiting for an OK, OK’d, posted or skipped, what it still needs before it can be OK’d, and once it went up: where, its links, its numbers about 2 and 7 days after (views, likes, comments, shares) and whether it did well against the business’s own other posts.',
  input: ContentGetInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_get_own_post' },
  async handler(ctx, input) {
    const [out] = await contentOut(ctx, [await loadContent(ctx, input.postId)]);
    return out!;
  },
});

export const contentList = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.content.list',
  description:
    'The business’s own posts, newest first: drafts waiting for an OK, OK’d ones, posted ones or skipped ones (pass state to keep to one, network to keep to one network).',
  input: ContentListInput,
  output: ContentListOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_list_own_posts' },
  async handler(ctx, input) {
    const found = await readPosts(
      ctx,
      sql`true ${input.state ? sql`and c.state = ${input.state}` : sql``}
          ${input.network ? sql`and c.network = ${input.network}` : sql``}
          order by coalesce(c.post_at, c.created_at) desc limit ${input.limit}`,
    );
    return { posts: await contentOut(ctx, found) };
  },
});

// ------------------------------------------------------------------------------------------------ changing

/** The files given are ready files on this post's record. */
async function checkFiles(
  ctx: CommandContext,
  postId: string,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const found = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.files where workspace_id = ${ctx.scope.workspaceId!}
          and id = any(${`{${ids.join(',')}}`}::uuid[]) and record_type = 'custom_record'
          and record_id = ${postId}::uuid and status = 'ready' and deleted_at is null`,
  );
  if (found.length !== new Set(ids).size)
    throw HfosError.rule('socialcontent_picture_not_on_post', 409, POST_REFUSALS.notOnPost);
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  JSON.stringify(a) === JSON.stringify(b);

export const contentSave = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.save',
  description:
    'Change one of the business’s own posts: its title, network, format, words, hook, hashtags, slides, script, what its picture shows and how it’s made, its pictures (files on the post, in order), where on Facebook it goes, or when it goes (null for no day yet). What isn’t given stays as it is. Changing an OK’d post takes the OK back, so it waits for an OK again. A posted post can’t be changed.',
  risk: 1,
  input: ContentSaveInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_save_own_post',
    outcome: (output) => ({
      words: W.post.saved,
      path: `${PATH}?post=${String((output as { id?: unknown }).id ?? '')}`,
    }),
  },
  emits: ['socialcontent.content.saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const was = await loadContent(ctx, input.postId, { lock: true });
    needChangeable(was);
    const network = input.network ?? was.network;
    const format = formatFor(network, input.format ?? was.format);
    const fileIds = input.fileIds ? [...new Set(input.fileIds)] : was.fileIds;
    if (input.fileIds) await checkFiles(ctx, was.recordId, fileIds);
    const facebookWhere =
      network === 'facebook'
        ? [
            ...new Set(
              input.facebookWhere ??
                (was.facebookWhere.length ? was.facebookWhere : ['profile' as const]),
            ),
          ]
        : [];
    const next = {
      network,
      format,
      words: input.words === undefined ? was.words : input.words.trim(),
      hook: input.hook === undefined ? was.hook : input.hook || null,
      hashtags: input.hashtags === undefined ? was.hashtags : tidyHashtags(input.hashtags, 30),
      // Threads and X keep their chain (decision 41); any other network has none.
      chain: chainFor(network, input.chain ?? was.chain ?? []),
      slides:
        input.slides === undefined ? was.slides : input.slides.filter((s) => s.heading || s.body),
      script: input.script === undefined ? was.script : input.script,
      picture: input.picture === undefined ? was.picture : input.picture || null,
      pictureWay: input.pictureWay ?? was.pictureWay,
      fileIds,
      facebookWhere,
      postAt:
        input.postAt === undefined
          ? was.postAt
          : input.postAt === null
            ? null
            : new Date(input.postAt),
    };
    const title = input.title ?? was.title;
    const changed =
      title !== was.title ||
      next.network !== was.network ||
      next.format !== was.format ||
      next.words !== was.words ||
      next.hook !== was.hook ||
      !sameList(next.hashtags, was.hashtags) ||
      !sameList(next.chain, was.chain ?? []) ||
      !sameList(next.slides, was.slides) ||
      JSON.stringify(next.script) !== JSON.stringify(was.script) ||
      next.picture !== was.picture ||
      next.pictureWay !== was.pictureWay ||
      !sameList(next.fileIds, was.fileIds) ||
      !sameList(next.facebookWhere, was.facebookWhere) ||
      (next.postAt?.getTime() ?? null) !== (was.postAt?.getTime() ?? null);
    // Changing an OK'd post (or one that didn't post) takes the OK back: it waits for an OK again.
    const unOk = changed && (was.state === 'ready' || was.state === 'failed');
    if (title !== was.title)
      await executeCommandWithin(ctx, customRecordUpdate, {
        workspaceId: ctx.scope.workspaceId!,
        customRecordId: was.recordId,
        name: title,
      });
    if (changed)
      await ctx.tx
        .update(content)
        .set({
          ...next,
          // A picture made for a post with no pictures now stays as it was; one whose pictures were taken off is none.
          pictureState: hasPictures(format) ? was.pictureState : 'none',
          ...(unOk
            ? { state: 'draft' as const, approvedBy: null, approvedAt: null, failure: null }
            : {}),
          // A time a person set is theirs: AI picks never moves it to a better hour (decision 27).
          ...((next.postAt?.getTime() ?? null) !== (was.postAt?.getTime() ?? null)
            ? { placedBy: 'person' as const }
            : {}),
          updatedAt: changeMoment(ctx.meta),
        })
        .where(eq(content.recordId, was.recordId));
    if (changed)
      await ctx.emit({
        type: 'socialcontent.content.saved',
        entityType: 'custom_record',
        entityId: was.recordId,
        payload: { postId: was.recordId, network, unOkd: unOk },
      });
    const [out] = await contentOut(ctx, [await loadContent(ctx, was.recordId)]);
    return out!;
  },
});

/** OKs a post that's ready to: nothing missing, and its time ahead. Null when it's OK'd; else what it needs. */
async function okOne(
  ctx: CommandContext,
  c: ContentRow,
  me: string,
  facebookPage: string | null,
): Promise<string | null> {
  if (c.state === 'ready') return null;
  if (c.state === 'skipped') return POST_REFUSALS.skipped;
  const pictures = await rows<{ id: string; mime_type: string | null }>(
    ctx.tx,
    c.fileIds.length
      ? sql`select id, mime_type from app.files where workspace_id = ${ctx.scope.workspaceId!}
              and id = any(${`{${c.fileIds.join(',')}}`}::uuid[]) and record_id = ${c.recordId}::uuid
              and status = 'ready' and deleted_at is null`
      : sql`select null::uuid as id, null::text as mime_type where false`,
  );
  const needs = stillNeeds({
    network: c.network,
    format: c.format,
    words: c.words,
    hashtags: c.hashtags,
    chain: c.chain ?? [],
    slides: Array.isArray(c.slides) ? c.slides : [],
    fileIds: pictures.map((p) => p.id),
    videos: pictures.filter((p) => p.mime_type?.startsWith('video/')).length,
    postAt: c.postAt,
    facebookWhere: c.facebookWhere,
    facebookPage,
  });
  if (needs) return needs;
  if (c.postAt && c.postAt.getTime() < Date.now() + AHEAD_MS) return POST_REFUSALS.past;
  const at = changeMoment(ctx.meta);
  await ctx.tx
    .update(content)
    .set({ state: 'ready', approvedBy: me, approvedAt: at, failure: null, updatedAt: at })
    .where(eq(content.recordId, c.recordId));
  await ctx.emit({
    type: 'socialcontent.content.approved',
    entityType: 'custom_record',
    entityId: c.recordId,
    payload: { postId: c.recordId, network: c.network, postAt: c.postAt?.toISOString() ?? null },
  });
  return null;
}

export const contentApprove = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.approve',
  description:
    'OK one of the business’s own posts so it goes up at its time (decision 15: nothing goes up without an OK), or take the OK back (ok: false). It needs everything a post needs first: words, its pictures or slides, a day ahead, and for Facebook where it goes.',
  risk: 2,
  input: ContentApproveInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_approve_own_post',
    autonomy: 'confirm',
    what: (input) =>
      (input as { ok?: boolean }).ok === false
        ? 'Take back the OK on this post'
        : 'OK this post to go up at its time',
    outcome: (output) => ({
      words: (output as { state?: unknown }).state === 'ready' ? W.post.approved : W.post.takenBack,
      path: `${PATH}?post=${String((output as { id?: unknown }).id ?? '')}`,
    }),
  },
  emits: ['socialcontent.content.approved', 'socialcontent.content.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const c = await loadContent(ctx, input.postId, { lock: true });
    needChangeable(c);
    if (input.ok) {
      const needs = await okOne(ctx, c, me, (await settingsOf(ctx)).facebookPage);
      if (needs) throw HfosError.rule('socialcontent_post_not_ready', 409, needs);
    } else if (c.state === 'ready' || c.state === 'failed') {
      await ctx.tx
        .update(content)
        .set({
          state: 'draft',
          approvedBy: null,
          approvedAt: null,
          updatedAt: changeMoment(ctx.meta),
        })
        .where(eq(content.recordId, c.recordId));
      await ctx.emit({
        type: 'socialcontent.content.saved',
        entityType: 'custom_record',
        entityId: c.recordId,
        payload: { postId: c.recordId, network: c.network, unOkd: true },
      });
    }
    const [out] = await contentOut(ctx, [await loadContent(ctx, c.recordId)]);
    return out!;
  },
});

export const contentApproveWeek = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.approve_week',
  description:
    'OK the week in one go (decision 15): every draft of the business’s own posts going in the next 7 days that has everything it needs. Says how many it OK’d, and which still need something, and what.',
  risk: 2,
  input: ContentApproveWeekInput,
  output: ContentApproveWeekOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_approve_week',
    autonomy: 'confirm',
    what: () => 'OK every post ready to go in the next 7 days',
    outcome: (output) => {
      const o = output as { approved?: number; notReady?: unknown[] };
      return {
        words: W.calendar.approvedWeek(o.approved ?? 0, o.notReady?.length ?? 0),
        path: PATH,
      };
    },
  },
  emits: ['socialcontent.content.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const timeZone = await timeZoneOf(ctx);
    const from = input.from ?? localDateOf(Date.now(), timeZone);
    const { start, stop } = rangeOf(from, 7, timeZone);
    const facebookPage = (await settingsOf(ctx)).facebookPage;
    const drafts = await readPosts(
      ctx,
      sql`c.state = 'draft' and c.post_at >= ${new Date(Math.max(start.getTime(), Date.now())).toISOString()}::timestamptz
          and c.post_at < ${stop.toISOString()}::timestamptz order by c.post_at for update of c`,
    );
    let approved = 0;
    const notReady: { postId: string; title: string; needs: string }[] = [];
    for (const c of drafts) {
      const needs = await okOne(ctx, c, me, facebookPage);
      if (needs) notReady.push({ postId: c.recordId, title: c.title, needs });
      else approved++;
    }
    return { approved, notReady };
  },
});

export const contentSkip = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.skip',
  description:
    'Skip one of the business’s own posts, so it doesn’t go up and its day is open again for another (an OK’d one loses its OK), or bring a skipped one back as a draft waiting for an OK (skip: false).',
  risk: 1,
  input: ContentSkipInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_skip_own_post',
    outcome: (output) => ({
      words: (output as { state?: unknown }).state === 'skipped' ? W.post.skipped : W.post.restored,
      path: PATH,
    }),
  },
  emits: ['socialcontent.content.skipped'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const c = await loadContent(ctx, input.postId, { lock: true });
    needChangeable(c);
    const to: ContentState | null = input.skip
      ? c.state === 'skipped'
        ? null
        : 'skipped'
      : c.state === 'skipped'
        ? 'draft'
        : null;
    if (to) {
      await ctx.tx
        .update(content)
        .set({ state: to, approvedBy: null, approvedAt: null, updatedAt: changeMoment(ctx.meta) })
        .where(eq(content.recordId, c.recordId));
      await ctx.emit({
        type: 'socialcontent.content.skipped',
        entityType: 'custom_record',
        entityId: c.recordId,
        payload: { postId: c.recordId, network: c.network, skipped: to === 'skipped' },
      });
    }
    const [out] = await contentOut(ctx, [await loadContent(ctx, c.recordId)]);
    return out!;
  },
});

export const contentRemove = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.remove',
  description:
    'Remove one of the business’s own posts from the calendar for good, so it never goes up and its day is open for another (Fill the calendar or Write one then writes a new one there). Its record is archived, as an add-on’s records are never deleted. Not a post that went up or is going up. Owners and admins.',
  risk: 2,
  input: ContentRemoveInput,
  output: ContentRemoveOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_remove_own_post',
    autonomy: 'confirm',
    outcome: (output) => ({
      words: W.post.removed((output as { openDay?: unknown }).openDay != null),
      path: PATH,
    }),
  },
  // Its record's archiving is core's command, with that command's own event.
  emits: [],
  async handler(ctx, input) {
    requireHuman(ctx);
    // Archiving a record is records.archive's, and the database holds that too.
    if (!scopeCan(ctx.scope, 'records.archive'))
      throw HfosError.rule('socialcontent_remove_forbidden', 403, POST_REFUSALS.removeWho);
    const c = await loadContent(ctx, input.postId, { lock: true });
    if (c.state === 'posted')
      throw HfosError.rule(
        'socialcontent_post_posted',
        409,
        POST_REFUSALS.removePosted(networkWord(c.network)),
      );
    if (c.state === 'posting')
      throw HfosError.rule('socialcontent_post_posting', 409, POST_REFUSALS.posting);
    await executeCommandWithin(ctx, customRecordArchive, {
      workspaceId: ctx.scope.workspaceId!,
      customRecordId: c.recordId,
    });
    const openDay = c.postAt ? localDateOf(c.postAt.getTime(), await timeZoneOf(ctx)) : null;
    return { postId: c.recordId, openDay };
  },
});

export const contentCommands = [
  contentSave,
  contentApprove,
  contentApproveWeek,
  contentSkip,
  contentRemove,
] as const;
export const contentQueries = [calendarGet, contentGet, contentList] as const;
