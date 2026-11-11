/**
 * What a person reads and does with AI Social Media Content Creator's notes (docs/socialcontent.md, parts 3 and 4):
 * the Playbook, the content ideas (saved, used or skipped), and trying out watching videos. The AI's notes on each
 * standout come on its posts (`socialcontent.post.list`); the worker writes the notes, the Playbook and the ideas
 * (./worker.ts, apps/worker/src/addons/socialcontent/notes.ts).
 */
import { rows, sql } from '@hfos/db/client';
import { and, desc, eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { socialcontentAddon } from '../manifest';
import {
  Idea as IdeaShape,
  IdeaDecideInput,
  IdeaListInput,
  IdeaListOutput,
  InWorkspace,
  LIMITS,
  PlaybookGetOutput,
  POST_KINDS,
  PlaybookSection,
  WatchTryInput,
  WatchTryOutput,
  type Idea,
  type StandoutRef,
} from '../shapes';
import { ideas, playbook } from '../tables';
import { SOCIALCONTENT_WORDS as W } from '../words';
import { inWorkspace, offerLiveOf, queueWork, settingsOf, type Ctx } from './common';
import { CONTENT_NETWORK_INFO, handleShown, isContentNetwork } from '../networks';

export const ideaOut = (i: typeof ideas.$inferSelect): Idea => ({
  id: i.id,
  title: i.title,
  hook: i.hook,
  format: i.format,
  network: i.network,
  outline: i.outline,
  why: i.why,
  basedOn: i.basedOn,
  state: i.state,
  createdAt: i.createdAt.toISOString(),
});

/** The standouts given, as links to open, in the order given; any no longer there are left out. */
export async function standoutRefs(ctx: Ctx, ids: readonly string[]): Promise<StandoutRef[]> {
  const unique = [...new Set(ids)].slice(0, 300);
  if (!unique.length) return [];
  const found = await rows<{
    id: string;
    link: string;
    network: string;
    kind: string;
    handle: string;
  }>(
    ctx.tx,
    sql`select p.id, p.link, c.network, p.kind, c.handle from addon_socialcontent.posts p
        join addon_socialcontent.creators c on c.id = p.creator_id
        where p.workspace_id = ${ctx.scope.workspaceId!} and p.id = any(${`{${unique.join(',')}}`}::uuid[])`,
  );
  // The business's own posts the Playbook came from too (part 11): by their record, with the link they went up at.
  const own = await rows<{ id: string; link: string | null; network: string; format: string }>(
    ctx.tx,
    sql`select c.record_id as id, c.post_link as link, c.network, c.format
        from addon_socialcontent.content c
        where c.workspace_id = ${ctx.scope.workspaceId!}
          and c.record_id = any(${`{${unique.join(',')}}`}::uuid[]) and c.post_link is not null`,
  );
  const byId = new Map(found.map((f) => [f.id, f]));
  const ownById = new Map(own.map((o) => [o.id, o]));
  return unique.flatMap((id): StandoutRef[] => {
    const f = byId.get(id);
    if (f && isContentNetwork(f.network))
      return [
        {
          id: f.id,
          link: f.link,
          network: f.network,
          kind: f.kind as StandoutRef['kind'],
          creatorShown: handleShown(f.network, f.handle),
        },
      ];
    const o = ownById.get(id);
    if (o?.link && isContentNetwork(o.network))
      return [
        {
          id: o.id,
          link: o.link,
          network: o.network,
          kind: (POST_KINDS as readonly string[]).includes(o.format)
            ? (o.format as StandoutRef['kind'])
            : 'other',
          creatorShown: W.playbook.yourPost,
        },
      ];
    return [];
  });
}

/** How many standouts have the AI's notes. */
export async function notedCount(ctx: Ctx): Promise<number> {
  const [{ n } = { n: 0 }] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_socialcontent.posts
        where workspace_id = ${ctx.scope.workspaceId!} and standout and noted_at is not null`,
  );
  return n;
}

export const playbookGet = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.playbook.get',
  description:
    'The Playbook: what works for the creators studied, written by the AI from its notes on their standout posts, in sections (hooks, formats, topics, captions, timing and the like), each with what to do, why it works and the standouts it came from (examples: each one’s link); when it was last written, and from how many of the noted standouts there are now.',
  input: InWorkspace,
  output: PlaybookGetOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_get_playbook' },
  async handler(ctx) {
    const [p] = await ctx.tx
      .select()
      .from(playbook)
      .where(eq(playbook.workspaceId, ctx.scope.workspaceId!));
    const sections = PlaybookSection.array()
      .catch([])
      .parse(p?.sections ?? []);
    return {
      playbook: {
        summary: p?.summary ?? null,
        sections,
        standouts: p?.standouts ?? 0,
        noted: await notedCount(ctx),
        writtenAt: p?.writtenAt?.toISOString() ?? null,
      },
      examples: await standoutRefs(
        ctx,
        sections.flatMap((s) => s.items.flatMap((i) => i.examples)),
      ),
    };
  },
});

export const ideaList = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.idea.list',
  description:
    'The content ideas the AI suggested for the business’s own posts, from the Playbook and its profile, newest first: each with its title, hook, format, network, an outline, why it should work and the standouts it’s based on (examples: each one’s link), and whether it’s new, saved, used or skipped; and whether the main offer is live (offerLive: until it is, the AI writes no ideas). Pass state to keep to one.',
  input: IdeaListInput,
  output: IdeaListOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_list_ideas' },
  async handler(ctx, input) {
    const found = await ctx.tx
      .select()
      .from(ideas)
      .where(
        and(
          eq(ideas.workspaceId, ctx.scope.workspaceId!),
          input.state ? eq(ideas.state, input.state) : undefined,
        ),
      )
      .orderBy(desc(ideas.createdAt))
      .limit(200);
    return {
      ideas: found.map(ideaOut),
      examples: await standoutRefs(
        ctx,
        found.flatMap((i) => i.basedOn),
      ),
      offerLive: await offerLiveOf(ctx),
    };
  },
});

export const ideaDecide = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.idea.decide',
  description: 'Mark a content idea saved (to make later), used (made it), skipped, or new again.',
  risk: 1,
  input: IdeaDecideInput,
  output: IdeaShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_decide_idea',
    outcome: () => ({ words: W.ideas.decided, path: 'a/socialcontent/ideas' }),
  },
  emits: ['socialcontent.idea.decided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [i] = await ctx.tx
      .update(ideas)
      .set({
        state: input.state,
        decidedBy: input.state === 'new' ? null : me,
        decidedAt: input.state === 'new' ? null : changeMoment(ctx.meta),
        updatedAt: changeMoment(ctx.meta),
      })
      .where(and(eq(ideas.id, input.ideaId), eq(ideas.workspaceId, ctx.scope.workspaceId!)))
      .returning();
    if (!i)
      throw HfosError.notFound(
        'That idea isn’t there anymore. Refresh the page to see the ones there are.',
      );
    await ctx.emit({
      type: 'socialcontent.idea.decided',
      entityType: 'socialcontent_idea',
      entityId: i.id,
      payload: { state: input.state },
    });
    return ideaOut(i);
  },
});

export const watchTry = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.watch.try',
  description:
    'Try watching videos on a few standouts (up to 5, the newest not watched yet), whether watching is on or not: the reading computer plays each, and the AI looks at its frames and listens to it, then says what it saw and heard. It uses more AI than notes from the numbers and caption alone.',
  risk: 2,
  input: WatchTryInput,
  output: WatchTryOutput,
  permission: 'socialcontent.manage',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_try_watching',
    autonomy: 'confirm',
    outcome: (output) => ({
      words: W.watch.asked(Number((output as { asked?: unknown }).asked ?? 0)),
      path: 'a/socialcontent/standouts',
    }),
  },
  emits: ['socialcontent.work.asked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const s = await settingsOf(ctx);
    if (!s.readerUserId)
      throw HfosError.rule(
        'socialcontent_no_reader',
        409,
        'No computer reads the networks yet. An owner or admin picks one in AI Social Media Content Creator → Settings → Whose computer reads, with the HandsFreeOS Social extension in Chrome.',
      );
    const ready = Object.entries(CONTENT_NETWORK_INFO)
      .filter(([, info]) => info.ready && info.watches)
      .map(([n]) => n);
    const videos = await rows<{ id: string; creator_id: string; network: string }>(
      ctx.tx,
      sql`select p.id, p.creator_id, c.network from addon_socialcontent.posts p
          join addon_socialcontent.creators c on c.id = p.creator_id
          where p.workspace_id = ${input.workspaceId} and p.standout and p.kind = 'video' and p.watched_at is null
            and c.network = any(${`{${ready.join(',')}}`}::text[])
            and not exists (select 1 from addon_socialcontent.work w
                            where w.post_id = p.id and w.state in ('waiting', 'taken'))
          order by p.posted_at desc limit ${LIMITS.tryVideos}`,
    );
    if (!videos.length)
      throw HfosError.rule(
        'socialcontent_no_videos',
        409,
        'There’s no Instagram standout video to watch yet (watching works on Instagram for now). Once a studied Instagram creator’s video stands out, it shows under Standouts, and this tries watching it.',
      );
    const asked = await queueWork(
      ctx,
      videos.map((v) => ({
        kind: 'watch' as const,
        network: v.network as 'instagram',
        creatorId: v.creator_id,
        postId: v.id,
      })),
      'trying',
      me,
    );
    return { asked };
  },
});

export const notesCommands = [ideaDecide, watchTry] as const;
export const notesQueries = [playbookGet, ideaList] as const;
