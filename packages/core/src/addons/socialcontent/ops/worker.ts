/**
 * What the worker keeps for AI Social Media Content Creator (docs/socialcontent.md): the niches the AI suggested, the
 * words it wrote to search each network for a niche, the weekly and monthly reading it queues (decision 11), and the
 * AI's notes: on each standout, what it saw and heard watching one, the Playbook and the content ideas (part 3).
 * The system's alone.
 */
import { rows, sql } from '@hfos/db/client';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineAddonCommand } from '../../server';
import { socialcontentAddon } from '../manifest';
import { CONTENT_NETWORK_INFO } from '../networks';
import {
  IdeasPutInput,
  IdeasPutOutput,
  LIMITS,
  NicheSearchesPutInput,
  NichesPutInput,
  NichesPutOutput,
  PlaybookPutInput,
  PostNoteInput,
  PostWatchedInput,
  WorkQueueInput,
} from '../shapes';
import { creators, ideas, niches, playbook, posts } from '../tables';
import { inWorkspace, queueWork, readSince, settingsOf } from './common';

export const nichesPut = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.niches.put',
  description:
    'Worker: the niches the AI suggested from the business’s profile. Its own niche is kept, ticked, when there isn’t one yet; each similar one not already there is suggested for someone to tick.',
  risk: 0,
  input: NichesPutInput,
  output: NichesPutOutput,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.niches.suggested'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [{ n } = { n: 0 }] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_socialcontent.niches where workspace_id = ${ws}`,
    );
    let room = LIMITS.niches - n;
    let added = 0;
    const add = async (
      niche: z.output<typeof NichesPutInput>['similar'][number],
      own: boolean,
    ): Promise<void> => {
      if (room <= 0) return;
      const made = await rows<{ id: string }>(
        ctx.tx,
        sql`insert into addon_socialcontent.niches (workspace_id, name, own, state, why, searches)
            values (${ws}, ${niche.name}, ${own}, ${own ? 'picked' : 'suggested'}, ${niche.why},
                    ${JSON.stringify(niche.searches)}::jsonb)
            on conflict do nothing
            returning id`,
      );
      if (made.length) {
        added++;
        room--;
      }
    };
    if (input.own) await add(input.own, true);
    for (const s of input.similar) await add(s, false);
    await ctx.emit({
      type: 'socialcontent.niches.suggested',
      entityType: 'socialcontent_niche',
      payload: { added },
    });
    return { added };
  },
});

export const nicheSearchesPut = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.niche.searches.put',
  description: 'Worker: the words the AI wrote to search each network for a niche.',
  risk: 0,
  input: NicheSearchesPutInput,
  output: z.object({ ok: z.literal(true) }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    await ctx.tx
      .update(niches)
      .set({ searches: input.searches })
      .where(and(eq(niches.id, input.nicheId), eq(niches.workspaceId, ctx.scope.workspaceId!)));
    return { ok: true as const };
  },
});

export const workQueue = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.work.queue',
  description:
    'Worker: the weekly read of every studied creator’s posts (new ones, and the last 60 days’ numbers), or the monthly search of every ticked niche on every network studied. Nothing is queued while no computer reads.',
  risk: 0,
  input: WorkQueueInput,
  output: z.object({ asked: z.number().int() }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.work.asked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const s = await settingsOf(ctx);
    if (!s.readerUserId) return { asked: 0 };
    if (input.kind === 'posts') {
      const now = new Date();
      const studied = await ctx.tx
        .select()
        .from(creators)
        .where(and(eq(creators.workspaceId, ws), eq(creators.state, 'studying')));
      const asked = await queueWork(
        ctx,
        studied
          .filter((c) => CONTENT_NETWORK_INFO[c.network].ready)
          .map((c) => ({
            kind: 'posts' as const,
            network: c.network,
            creatorId: c.id,
            since: readSince(c.postsReadAt, now),
          })),
        input.askedFor,
        null,
      );
      return { asked };
    }
    const picked = await ctx.tx
      .select({ id: niches.id })
      .from(niches)
      .where(and(eq(niches.workspaceId, ws), eq(niches.state, 'picked')));
    const asked = await queueWork(
      ctx,
      picked.flatMap((n) =>
        s.networks.map((network) => ({ kind: 'find' as const, network, nicheId: n.id })),
      ),
      input.askedFor,
      null,
    );
    return { asked };
  },
});

const Ok = z.object({ ok: z.literal(true) });

export const postNote = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.post.note',
  description:
    'Worker: the AI’s notes on a standout: why it worked, its hook, format and topic, the techniques in it, and how the business could use it.',
  risk: 0,
  input: PostNoteInput,
  output: Ok,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.post.noted'],
  async handler(ctx, input) {
    const [p] = await ctx.tx
      .update(posts)
      .set({ notes: input.notes, notedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(posts.id, input.postId), eq(posts.workspaceId, ctx.scope.workspaceId!)))
      .returning({ id: posts.id });
    if (p)
      await ctx.emit({
        type: 'socialcontent.post.noted',
        entityType: 'socialcontent_post',
        entityId: p.id,
        payload: {},
      });
    return { ok: true as const };
  },
});

export const postWatched = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.post.watched',
  description: 'Worker: what the AI saw and heard watching a standout video, and why it worked.',
  risk: 0,
  input: PostWatchedInput,
  output: Ok,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.post.watched'],
  async handler(ctx, input) {
    const [p] = await ctx.tx
      .update(posts)
      .set({ watched: input.watched, watchedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(posts.id, input.postId), eq(posts.workspaceId, ctx.scope.workspaceId!)))
      .returning({ id: posts.id });
    if (p)
      await ctx.emit({
        type: 'socialcontent.post.watched',
        entityType: 'socialcontent_post',
        entityId: p.id,
        payload: {},
      });
    return { ok: true as const };
  },
});

export const playbookPut = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.playbook.put',
  description:
    'Worker: the Playbook the AI wrote from its notes on the standouts, replacing the one before.',
  risk: 0,
  input: PlaybookPutInput,
  output: Ok,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.playbook.written'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const now = new Date();
    await ctx.tx
      .insert(playbook)
      .values({
        workspaceId: ws,
        summary: input.summary,
        sections: input.sections,
        standouts: input.standouts,
        writtenAt: now,
      })
      .onConflictDoUpdate({
        target: playbook.workspaceId,
        set: {
          summary: input.summary,
          sections: input.sections,
          standouts: input.standouts,
          writtenAt: now,
          updatedAt: now,
        },
      });
    await ctx.emit({
      type: 'socialcontent.playbook.written',
      entityType: 'socialcontent_playbook',
      entityId: ws,
      payload: { sections: input.sections.length, standouts: input.standouts },
    });
    return { ok: true as const };
  },
});

export const ideasPut = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.ideas.put',
  description:
    'Worker: content ideas the AI suggested for the business’s own posts, each new until someone decides.',
  risk: 0,
  input: IdeasPutInput,
  output: IdeasPutOutput,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.ideas.added'],
  async handler(ctx, input) {
    if (!input.ideas.length) return { added: 0 };
    const ws = ctx.scope.workspaceId!;
    const made = await ctx.tx
      .insert(ideas)
      .values(input.ideas.map((i) => ({ ...i, workspaceId: ws })))
      .returning({ id: ideas.id });
    await ctx.emit({
      type: 'socialcontent.ideas.added',
      entityType: 'socialcontent_idea',
      payload: { added: made.length },
    });
    return { added: made.length };
  },
});

export const workerCommands = [
  nichesPut,
  nicheSearchesPut,
  workQueue,
  postNote,
  postWatched,
  playbookPut,
  ideasPut,
] as const;
