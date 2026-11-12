/**
 * AI Social Media Content Creator's notes (docs/socialcontent.md, parts 3 and 4): what the AI makes of the standouts.
 *
 * - **Posts saved** (`socialcontent.posts.saved`) queue `socialcontent.notes` a minute later, once per business, so a
 *   creator read page by page is noted in one go; a save while it runs has it run once more after.
 * - **The notes job** notes up to 15 standouts that have none (5 to an ask, each beside the posts around it that did
 *   about normal), then writes the Playbook once 3 are noted and again each time 5 more are, then suggests ideas
 *   when the Playbook is new and fewer than 5 new ideas wait. More standouts left: it runs again in two minutes.
 * - **Write it again** (`socialcontent.playbook.write`) and **Get ideas** (`socialcontent.ideas.suggest`), from its
 *   pages and for the Assistant.
 * - **Watching a video** (`socialcontent.post.watch`): the reading computer sends frames from a standout video it was
 *   asked to watch, and its sound; what's said is heard (charged as speech), and the AI looks at the frames and reads
 *   the words, then says what it saw and heard. Only the extension asks, for work its computer took.
 *
 * Every ask is counted under the add-on's AI use and charged to the business. Core holds the prompts and the checks
 * (packages/core/src/addons/socialcontent/notes-ai.ts).
 */
import {
  checkedIdeas,
  checkedNotes,
  checkedPlaybook,
  checkedWatch,
  IDEAS_SCHEMA,
  IDEAS_SYSTEM,
  IdeasAnswer,
  ideasPrompt,
  NOTES_LIMITS,
  NOTES_SCHEMA,
  NOTES_SYSTEM,
  NotesAnswer,
  notesPrompt,
  OWN_FOR_PLAYBOOK,
  PLAYBOOK_SCHEMA,
  PLAYBOOK_SYSTEM,
  PlaybookAnswer,
  playbookDue,
  playbookPrompt,
  WATCH_SCHEMA,
  WATCH_SYSTEM,
  WatchAnswer,
  watchPrompt,
  type NotedForPlaybook,
  type OwnForPlaybook,
  type PostForAi,
  type StandoutForNotes,
} from '@hfos/core/addons/socialcontent/notes-ai';
import {
  CONTENT_NETWORK_INFO,
  isContentNetwork,
  type ContentNetwork,
} from '@hfos/core/addons/socialcontent/networks';
import {
  ideasPut,
  playbookPut,
  postNote,
  postWatched,
} from '@hfos/core/addons/socialcontent/ops/worker';
import {
  LIMITS,
  PlaybookSection,
  PostNotes,
  PostWatched,
  PostWatchInput,
  type PostKind,
} from '@hfos/core/addons/socialcontent/shapes';
import { planIdeas, VARIETY } from '@hfos/core/addons/socialcontent/variety';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { executeCommand, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { AiContent } from '@hfos/ai';
import { z } from 'zod';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
  notAskedWords,
} from '../../ai/ask';
import { noteSpeech, speechMinutes } from '../../money/speech-usage';
import { scheduleAddonJob } from '../queue';
import { businessText, listsHere, offerIsLive, requireLiveOffer } from './business';
import { ideasBefore, postsBefore } from './variety';
import type {
  AddonEventContext,
  AddonJobHandler,
  AddonScopeContext,
  AddonWorkerAction,
} from '../types';

export const NOTES_JOB = 'socialcontent.notes';
export const WATCH_ACTION = 'socialcontent.post.watch';
/** What a watch may send: frames and sound, base64, with room to spare. */
export const WATCH_BODY_BYTES = 8 * 1024 * 1024;
const SOON_MS = 60_000;
const AGAIN_MS = 2 * 60_000;
/** The AI's limit or the balance ran out: the notes wait this long before trying again. */
const LATER_MS = 6 * 3_600_000;
const HEAR_TIMEOUT_MS = 90_000;

type PostRow = {
  id: string;
  creator_id: string;
  network: string;
  kind: PostKind;
  posted_at: Date | string;
  caption: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  seconds: number | null;
  views_times: string | number | null;
  engagement_times: string | number | null;
};
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const networkOf = (n: string): ContentNetwork => (isContentNetwork(n) ? n : 'instagram');
const postForAi = (r: PostRow): PostForAi => ({
  id: r.id,
  network: networkOf(r.network),
  kind: r.kind,
  postedAt: new Date(r.posted_at).toISOString(),
  caption: r.caption,
  views: r.views,
  likes: r.likes,
  comments: r.comments,
  shares: r.shares,
  seconds: r.seconds,
  viewsTimes: num(r.views_times),
  engagementTimes: num(r.engagement_times),
});
const POST_COLUMNS = sql.raw(
  `p.id, p.creator_id, c.network, p.kind, p.posted_at, p.caption, p.views, p.likes, p.comments, p.shares,
   p.seconds, p.views_times, p.engagement_times`,
);

/** The AI's own trouble in words a person can read, for the actions a person presses. */
export function aiRefusal(e: AiAskError): HfosError {
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    default:
      return e.retryable
        ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE)
        : HfosError.rule(
            'ai_failed',
            502,
            'The AI couldn’t write that just now. Try again in a minute.',
          );
  }
}

// ------------------------------------------------------------------------------------------------ notes

/** Standouts without notes, newest first, each with its creator's followers and the posts around it. */
async function unnoted(ctx: AddonScopeContext, most: number): Promise<StandoutForNotes[]> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const found = await rows<PostRow & { followers: number | null }>(
      tx,
      sql`select ${POST_COLUMNS}, c.followers from addon_socialcontent.posts p
          join addon_socialcontent.creators c on c.id = p.creator_id
          where p.workspace_id = ${ctx.scope.workspaceId} and p.standout and p.noted_at is null
          order by p.posted_at desc limit ${most}`,
    );
    const out: StandoutForNotes[] = [];
    for (const s of found) {
      const around = await rows<PostRow>(
        tx,
        sql`(select ${POST_COLUMNS} from addon_socialcontent.posts p
             join addon_socialcontent.creators c on c.id = p.creator_id
             where p.creator_id = ${s.creator_id} and not p.standout and not p.pinned and p.posted_at < ${new Date(s.posted_at).toISOString()}::timestamptz
             order by p.posted_at desc limit ${NOTES_LIMITS.around / 2})
            union all
            (select ${POST_COLUMNS} from addon_socialcontent.posts p
             join addon_socialcontent.creators c on c.id = p.creator_id
             where p.creator_id = ${s.creator_id} and not p.standout and not p.pinned and p.posted_at > ${new Date(s.posted_at).toISOString()}::timestamptz
             order by p.posted_at asc limit ${NOTES_LIMITS.around / 2})`,
      );
      out.push({ ...postForAi(s), followers: s.followers, around: around.map(postForAi) });
    }
    return out;
  });
}

/** Notes a few standouts. How many were noted. */
async function noteSome(
  ctx: AddonScopeContext,
  standouts: readonly StandoutForNotes[],
  business: string,
): Promise<number> {
  const { prompt, refs } = notesPrompt({ business, standouts });
  const { value } = await askStructured(ctx, ctx.scope, {
    system: NOTES_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    schema: NOTES_SCHEMA,
    zod: NotesAnswer,
    maxTokens: 600 * standouts.length,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const notes = checkedNotes(value, refs);
  for (const n of notes)
    await executeCommand(
      ctx.db,
      postNote,
      { workspaceId: ctx.scope.workspaceId, postId: n.postId, notes: n.notes },
      ctx.actor,
      ctx.meta,
    );
  return notes.length;
}

// ------------------------------------------------------------------------------------------------ the Playbook

async function playbookState(ctx: AddonScopeContext): Promise<{
  noted: number;
  writtenFrom: number | null;
  newIdeas: number;
  ownNew: number;
}> {
  const [r] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ noted: number; written_from: number | null; new_ideas: number; own_new: number }>(
      tx,
      sql`select
            (select count(*)::int from addon_socialcontent.posts
             where workspace_id = ${ctx.scope.workspaceId} and standout and noted_at is not null) as noted,
            (select standouts from addon_socialcontent.playbook
             where workspace_id = ${ctx.scope.workspaceId} and written_at is not null) as written_from,
            (select count(*)::int from addon_socialcontent.ideas
             where workspace_id = ${ctx.scope.workspaceId} and state = 'new') as new_ideas,
            (select count(*)::int from addon_socialcontent.content c
             where c.workspace_id = ${ctx.scope.workspaceId} and c.done_well is not null
               and (c.done_well ->> 'at')::timestamptz > coalesce(
                 (select written_at from addon_socialcontent.playbook
                  where workspace_id = ${ctx.scope.workspaceId}), '-infinity'::timestamptz)) as own_new`,
    ),
  );
  return {
    noted: r?.noted ?? 0,
    writtenFrom: r?.written_from ?? null,
    newIdeas: r?.new_ideas ?? 0,
    ownNew: r?.own_new ?? 0,
  };
}

/** The business's own posts that did best against its own others (part 11), the best first. */
async function ownForPlaybook(ctx: AddonScopeContext): Promise<OwnForPlaybook[]> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ record_id: string; network: string; format: string; words: string; done_well: unknown }>(
      tx,
      sql`select c.record_id, c.network, c.format, c.words, c.done_well
          from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
          where c.workspace_id = ${ctx.scope.workspaceId} and c.done_well is not null
          order by (c.done_well ->> 'times')::numeric desc nulls last
          limit ${OWN_FOR_PLAYBOOK}`,
    ),
  );
  return found.flatMap((r) => {
    const well = r.done_well as { times?: unknown; on?: unknown } | null;
    const on = well?.on;
    if (
      !isContentNetwork(r.network) ||
      typeof well?.times !== 'number' ||
      (on !== 'views' && on !== 'engagement' && on !== 'both')
    )
      return [];
    return [
      {
        id: r.record_id,
        network: r.network,
        format: r.format,
        words: r.words,
        times: well.times,
        on,
      },
    ];
  });
}

/** Writes the Playbook from the noted standouts, the biggest first. How many sections it has. */
export async function writePlaybook(ctx: AddonScopeContext, business?: string): Promise<number> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      id: string;
      network: string;
      kind: PostKind;
      views_times: string | null;
      engagement_times: string | null;
      notes: unknown;
      watched: unknown;
    }>(
      tx,
      sql`select p.id, c.network, p.kind, p.views_times, p.engagement_times, p.notes, p.watched
          from addon_socialcontent.posts p join addon_socialcontent.creators c on c.id = p.creator_id
          where p.workspace_id = ${ctx.scope.workspaceId} and p.standout and p.noted_at is not null
          order by greatest(coalesce(p.views_times, 0), coalesce(p.engagement_times, 0)) desc
          limit ${NOTES_LIMITS.playbookFrom}`,
    ),
  );
  const noted: NotedForPlaybook[] = found.flatMap((r) => {
    const notes = PostNotes.safeParse(r.notes);
    if (!notes.success) return [];
    const watched = PostWatched.safeParse(r.watched);
    return [
      {
        id: r.id,
        network: networkOf(r.network),
        kind: r.kind,
        viewsTimes: num(r.views_times),
        engagementTimes: num(r.engagement_times),
        notes: notes.data,
        watched: watched.success ? watched.data : null,
      },
    ];
  });
  const own = await ownForPlaybook(ctx);
  if (!noted.length && !own.length) return 0;
  const { prompt, refs } = playbookPrompt({
    business: business ?? (await businessText(ctx)),
    noted,
    own,
  });
  const { value } = await askStructured(ctx, ctx.scope, {
    system: PLAYBOOK_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    schema: PLAYBOOK_SCHEMA,
    zod: PlaybookAnswer,
    maxTokens: 4000,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const checked = checkedPlaybook(value, refs);
  if (!checked.sections.length) return 0;
  const [{ n } = { n: noted.length }] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from addon_socialcontent.posts
          where workspace_id = ${ctx.scope.workspaceId} and standout and noted_at is not null`,
    ),
  );
  await executeCommand(
    ctx.db,
    playbookPut,
    {
      workspaceId: ctx.scope.workspaceId,
      summary: checked.summary,
      sections: checked.sections,
      standouts: n,
    },
    ctx.actor,
    ctx.meta,
  );
  return checked.sections.length;
}

// ------------------------------------------------------------------------------------------------ ideas

/**
 * Has the AI suggest ideas from the Playbook, each planned first as a kind in the weekly mix and a line from the lists
 * (decisions 34 to 36). How many were added; null when there's no Playbook yet.
 */
export async function suggestIdeas(
  ctx: AddonScopeContext,
  business?: string,
  wanted: number = NOTES_LIMITS.ideasAsked,
): Promise<number | null> {
  const here = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [p] = await rows<{ summary: string | null; sections: unknown }>(
      tx,
      sql`select summary, sections from addon_socialcontent.playbook
          where workspace_id = ${ctx.scope.workspaceId} and written_at is not null`,
    );
    const [s] = await rows<{ networks: string[] | null }>(
      tx,
      sql`select networks from addon_socialcontent.settings where workspace_id = ${ctx.scope.workspaceId}`,
    );
    const already = await rows<{ title: string }>(
      tx,
      sql`select title from addon_socialcontent.ideas where workspace_id = ${ctx.scope.workspaceId}
          order by created_at desc limit 100`,
    );
    return { p, networks: s?.networks ?? ['instagram'], already: already.map((a) => a.title) };
  });
  if (!here.p) return null;
  const sections = PlaybookSection.array().catch([]).parse(here.p.sections);
  const exampleIds = [
    ...new Set(sections.flatMap((s) => s.items.flatMap((i) => i.examples))),
  ].slice(0, 30);
  const standouts = exampleIds.length
    ? await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ id: string; network: string; notes: unknown }>(
          tx,
          sql`select p.id, c.network, p.notes from addon_socialcontent.posts p
              join addon_socialcontent.creators c on c.id = p.creator_id
              where p.workspace_id = ${ctx.scope.workspaceId} and p.id = any(${`{${exampleIds.join(',')}}`}::uuid[])`,
        ),
      )
    : [];
  const networks = here.networks
    .filter(isContentNetwork)
    .filter((n) => CONTENT_NETWORK_INFO[n].ready);
  const recent = await postsBefore(ctx);
  // The ideas waiting come before the new ones in the mix, and their topics aren't taken again.
  const slots = planIdeas(
    Math.min(wanted, LIMITS.ideasAtOnce),
    [...(await ideasBefore(ctx)), ...recent],
    await listsHere(ctx),
  );
  const { prompt, refs } = ideasPrompt({
    business: business ?? (await businessText(ctx)),
    summary: here.p.summary,
    sections,
    standouts: standouts.flatMap((s) => {
      const notes = PostNotes.safeParse(s.notes);
      return notes.success
        ? [{ id: s.id, network: networkOf(s.network), why: notes.data.why }]
        : [];
    }),
    networks: networks.length ? networks : ['instagram'],
    already: here.already,
    slots,
    recent: recent.slice(0, VARIETY.recentShown),
  });
  const { value } = await askStructured(ctx, ctx.scope, {
    system: IDEAS_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    schema: IDEAS_SCHEMA,
    zod: IdeasAnswer,
    maxTokens: 1000 + 500 * slots.length,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const ideas = checkedIdeas(
    value,
    refs,
    here.already,
    networks.length ? networks : ['instagram'],
    slots,
  );
  if (!ideas.length) return 0;
  const { output } = await executeCommand(
    ctx.db,
    ideasPut,
    { workspaceId: ctx.scope.workspaceId, ideas },
    ctx.actor,
    ctx.meta,
  );
  return output.added;
}

// ------------------------------------------------------------------------------------------------ the job

/**
 * Posts saved: the notes job, a minute from now, once per business. With new standouts, and also without, so a
 * standout an earlier run left without notes is noted on the next save (the job asks the AI only about unnoted ones).
 */
export const onPostsSaved = async (ctx: AddonEventContext): Promise<void> => {
  await queueNotes(ctx, new Date(Date.now() + SOON_MS));
};

/** One of the business's own posts did well (part 11): the notes job, which writes the Playbook again with it. */
export const onOwnDoneWell = async (ctx: AddonEventContext): Promise<void> => {
  await queueNotes(ctx, new Date(Date.now() + SOON_MS));
};

/**
 * Queues the notes job. When it's already running, it runs once more after (`pullEarlier`): on 10 Nov 2026 a
 * creator's posts were saved while the run for another's was writing the Playbook, and that run had already picked
 * its standouts, so two were never noted.
 */
export async function queueNotes(ctx: AddonScopeContext, runAt: Date): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: NOTES_JOB,
        dedupeKey: `${NOTES_JOB}:${ctx.scope.workspaceId}`,
        runAt,
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** Notes up to 15 standouts, then the Playbook and ideas when they're due. */
export const runNotes: AddonJobHandler = async (ctx) => {
  try {
    const standouts = await unnoted(ctx, NOTES_LIMITS.perRun + 1);
    const now = standouts.slice(0, NOTES_LIMITS.perRun);
    let business: string | undefined;
    if (now.length) {
      business = await businessText(ctx);
      for (let i = 0; i < now.length; i += NOTES_LIMITS.perAsk)
        await noteSome(ctx, now.slice(i, i + NOTES_LIMITS.perAsk), business);
    }
    const state = await playbookState(ctx);
    // Due by the creators' noted standouts, or written again when one of the business's own posts did well (part 11).
    if (
      playbookDue(state.noted, state.writtenFrom) ||
      (state.writtenFrom !== null && state.ownNew > 0)
    ) {
      business ??= await businessText(ctx);
      const sections = await writePlaybook(ctx, business);
      // No ideas until the main offer is live (pick 7b): the Playbook is research, and goes on.
      if (sections && state.newIdeas < VARIETY.ideasBelow && (await offerIsLive(ctx)))
        await suggestIdeas(ctx, business, VARIETY.ideasAdded);
    }
    if (standouts.length > NOTES_LIMITS.perRun)
      return { rescheduleAt: new Date(ctx.now + AGAIN_MS) };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try soon; the AI's limit or the balance, later.
    if (e.retryable && ctx.attempt < 3) throw e;
    ctx.log.info({ code: e.code }, 'content notes wait for the AI');
    return { rescheduleAt: new Date(ctx.now + (e.retryable ? AGAIN_MS * 5 : LATER_MS)) };
  }
};

// ------------------------------------------------------------------------------------------------ actions

/** Write it again, from the Playbook page. */
export const writePlaybookNow: AddonWorkerAction<Record<string, never>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_write_playbook',
    description:
      'Have the AI write AI Social Media Content Creator’s Playbook again now, from its notes on every noted standout post: what works for the creators studied, in sections, each with what to do, why and the standouts it came from. It replaces the one before.',
    autonomy: 'auto',
    keywords: ['playbook', 'what works', 'rewrite playbook'],
  },
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(ctx) {
    let sections: number;
    try {
      sections = await writePlaybook(ctx);
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e) : e;
    }
    if (!sections)
      throw HfosError.rule('socialcontent_nothing_noted', 409, W.playbook.nothingToWrite);
    return { sections };
  },
};

/** Get ideas, from the Ideas page. */
export const suggestIdeasNow: AddonWorkerAction<Record<string, never>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_suggest_ideas',
    description:
      'Have the AI suggest up to 5 new content ideas for the business’s own posts, from AI Social Media Content Creator’s Playbook and the business’s profile, each with a hook, format, network, outline, why it should work and the standouts it’s based on. Each is the next kind in the weekly mix (a tip, a customer’s problem, a story, or the offer) about the next line from the main offer’s lists for content. They wait under Ideas as new; 10 more come on their own whenever fewer than 5 wait. Refused until the business’s main offer is live.',
    autonomy: 'auto',
    keywords: ['content ideas', 'post ideas', 'what to post'],
  },
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(ctx) {
    await requireLiveOffer(ctx);
    let added: number | null;
    try {
      added = await suggestIdeas(ctx);
    } catch (e) {
      throw e instanceof AiAskError ? aiRefusal(e) : e;
    }
    if (added === null)
      throw HfosError.rule('socialcontent_no_playbook', 409, W.ideas.needsPlaybook);
    return { added };
  },
};

/** The reading computer watched a standout video: what it saw and heard, as the AI's notes. */
export const watchPost: AddonWorkerAction<z.output<typeof PostWatchInput>> = {
  permission: 'socialcontent.use',
  bodyBytes: WATCH_BODY_BYTES,
  input: PostWatchInput,
  async run(ctx, input): Promise<{ watched: boolean; failure: string | null }> {
    const [found] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<PostRow & { notes: unknown }>(
        tx,
        sql`select ${POST_COLUMNS}, p.notes from addon_socialcontent.work w
            join addon_socialcontent.posts p on p.id = w.post_id
            join addon_socialcontent.creators c on c.id = p.creator_id
            where w.id = ${input.workId} and w.workspace_id = ${ctx.scope.workspaceId} and w.kind = 'watch'
              and w.state = 'taken' and w.taken_by = ${ctx.userId}::uuid and w.post_id = ${input.postId}`,
      ),
    );
    if (!found)
      throw HfosError.rule(
        'socialcontent_work_gone',
        409,
        'That was stopped, or another computer took it. The extension moves on to the next thing.',
      );
    let heard: string | null = null;
    if (input.sound && ctx.speech) {
      try {
        const clip = await ctx.speech.transcribe(Buffer.from(input.sound, 'base64'), {
          contentType: 'audio/wav',
          signal: AbortSignal.timeout(HEAR_TIMEOUT_MS),
        });
        heard = clip.text.trim() || null;
        await noteSpeech(ctx, ctx.scope, [
          {
            key: 'speech.recording.minute',
            quantity: speechMinutes(clip.seconds),
            source: 'transcript',
            ref: found.id,
          },
        ]);
      } catch (e) {
        ctx.log.warn({ err: e }, 'couldn’t hear a standout video; it’s watched without its words');
      }
    }
    const notes = PostNotes.safeParse(found.notes);
    const frames = [...input.frames].sort((a, b) => a.at - b.at);
    const content: AiContent[] = [
      ...frames.map((f) => ({
        type: 'image' as const,
        mediaType: 'image/jpeg' as const,
        data: f.jpeg,
      })),
      {
        type: 'text',
        text: watchPrompt({
          post: postForAi(found),
          notes: notes.success ? notes.data : null,
          frames: frames.map((f) => f.at),
          heard,
        }),
      },
    ];
    let watched;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: WATCH_SYSTEM,
        messages: [{ role: 'user', content }],
        schema: WATCH_SCHEMA,
        zod: WatchAnswer,
        maxTokens: 1200,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      watched = checkedWatch(value);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      return { watched: false, failure: notAskedWords(e).slice(0, 300) };
    }
    if (!watched) return { watched: false, failure: 'The AI couldn’t say what was in this video.' };
    await executeCommand(
      ctx.db,
      postWatched,
      { workspaceId: ctx.scope.workspaceId, postId: found.id, watched },
      ctx.actor,
      ctx.meta,
    );
    return { watched: true, failure: null };
  },
};
