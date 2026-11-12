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
import { content, creators, ideas, niches, playbook, posts, settings } from '../tables';
import { inWorkspace, queueWork, readSince, settingsOf, type Ctx } from './common';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { customRecordCreate, customRecordUpdate } from '../../../commands/custom-record';
import { formatFor, hasPictures } from '../calendar';
import {
  CalendarFilledInput,
  ContentPicturedInput,
  ContentPutInput,
  ContentPutOutput,
} from '../content-shapes';
import { loadContent, needChangeable } from './content';

export const nichesPut = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.niches.put',
  description:
    'Worker: the niches the AI suggested from the business’s profile. Its own niche is kept, ticked, when there isn’t one yet or the one there was skipped (that one stays, skipped, as a niche like it); when it’s one already kept, that one becomes the own one. Each similar one not already there is suggested for someone to tick; setting up on its own ticks the closest few too (decision 29), never one about its customers’ world.',
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
    ): Promise<string | null> => {
      if (room <= 0) return null;
      const made = await rows<{ id: string }>(
        ctx.tx,
        sql`insert into addon_socialcontent.niches (workspace_id, name, own, state, why, searches)
            values (${ws}, ${niche.name}, ${own}, ${own ? 'picked' : 'suggested'}, ${niche.why},
                    ${JSON.stringify(niche.searches)}::jsonb)
            on conflict do nothing
            returning id`,
      );
      if (!made.length) return null;
      added++;
      room--;
      return made[0]!.id;
    };
    // Its own niche, skipped: the new one takes its place as the business's own (the owner, 9 Nov 2026: "I really
    // need to grow as my niche"), and the old one stays, skipped, among the ones like it.
    if (input.own)
      await rows(
        ctx.tx,
        sql`update addon_socialcontent.niches set own = false
            where workspace_id = ${ws} and own and state = 'skipped'
              and lower(btrim(name)) <> lower(btrim(${input.own.name}))`,
      );
    if (input.own) await add(input.own, true);
    // Its own niche is one already kept, as a niche like it: that one is the business's own now, ticked when it was
    // only suggested. One someone skipped stays as it is.
    if (input.own)
      await rows(
        ctx.tx,
        sql`update addon_socialcontent.niches
            set own = true, state = case when state = 'suggested' then 'picked' else state end
            where workspace_id = ${ws} and lower(btrim(name)) = lower(btrim(${input.own.name}))
              and not own and state <> 'skipped'
              and not exists (select 1 from addon_socialcontent.niches o where o.workspace_id = ${ws} and o.own)`,
      );
    // Setting up on its own (decision 29): the closest new ones are ticked too, never one about its customers' world.
    let toPick = input.pickClosest;
    for (const s of input.similar) {
      const id = await add(s, false);
      if (!id || toPick <= 0 || /^your customers/i.test(s.why ?? '')) continue;
      await rows(
        ctx.tx,
        sql`update addon_socialcontent.niches set state = 'picked' where id = ${id} and state = 'suggested'`,
      );
      toPick--;
    }
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
    'Worker: the weekly read of every studied creator’s posts (new ones, and the last 60 days’ numbers), or the monthly search of every ticked niche on every network studied, or that search for setting up on its own. Nothing is queued while no computer reads.',
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
      .values(
        input.ideas.map(({ topic, source, ...i }) => ({
          ...i,
          topicList: topic?.list ?? null,
          topic: topic?.line ?? null,
          sourceUrl: source?.url ?? null,
          sourceName: source?.name ?? null,
          workspaceId: ws,
        })),
      )
      .returning({ id: ideas.id });
    await ctx.emit({
      type: 'socialcontent.ideas.added',
      entityType: 'socialcontent_idea',
      payload: { added: made.length },
    });
    return { added: made.length };
  },
});

/** The kind of record a Social post is, in this business. */
export async function postKindId(ctx: Ctx): Promise<string> {
  const [k] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from app.custom_record_types
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = 'socialcontent' and key = 'socialcontent_post'
          and archived_at is null`,
  );
  if (!k)
    throw HfosError.rule(
      'socialcontent_no_post_kind',
      409,
      'Social posts aren’t set up in this business yet. An owner turns AI Social Media Content Creator off and on again in Settings → Add-ons, and they are.',
    );
  return k.id;
}

export const contentPut = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.put',
  description:
    'Worker: a post the AI wrote for the business, kept as a Social post record waiting for an OK, for a day in the calendar or none, with its kind in the weekly mix and the line from the lists it’s about; or a post written again, which takes its OK back. The idea it came from is marked used.',
  risk: 0,
  input: ContentPutInput,
  output: ContentPutOutput,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.content.written', 'socialcontent.idea.decided'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const p = input.post;
    const format = formatFor(input.network, p.format);
    // An AI-made picture is made after it's kept; the person's own waits for them.
    const pictureState =
      hasPictures(format) && p.pictureWay !== 'own' ? ('waiting' as const) : ('none' as const);
    const fields = {
      network: input.network,
      format,
      words: p.words,
      hook: p.hook,
      hashtags: p.hashtags,
      slides: format === 'carousel' ? p.slides : [],
      script: format === 'video' ? p.script : null,
      picture: p.picture,
      pictureWay: p.pictureWay,
      pictureFailure: null,
      angle: p.angle,
      topicList: p.topic?.list ?? null,
      topic: p.topic?.line ?? null,
      updatedAt: changeMoment(ctx.meta),
    };
    let postId = input.postId ?? null;
    let created = false;
    if (postId) {
      const was = await loadContent(ctx, postId, { lock: true });
      needChangeable(was);
      if (p.title !== was.title)
        await executeCommandWithin(ctx, customRecordUpdate, {
          workspaceId: ws,
          customRecordId: postId,
          name: p.title,
        });
      await ctx.tx
        .update(content)
        .set({
          ...fields,
          // A draft from before written again from an idea (decision 37) now comes from that idea.
          ...(input.ideaId ? { ideaId: input.ideaId } : {}),
          // Its pictures stay until new ones are made (or, for its own, until the person changes them).
          pictureState:
            pictureState === 'waiting' ? 'waiting' : was.fileIds.length ? 'made' : 'none',
          design: null,
          state: was.state === 'skipped' ? 'skipped' : 'draft',
          approvedBy: null,
          approvedAt: null,
          failure: null,
        })
        .where(eq(content.recordId, postId));
    } else {
      const made = await executeCommandWithin(ctx, customRecordCreate, {
        workspaceId: ws,
        typeId: await postKindId(ctx),
        name: p.title,
      });
      postId = made.output.customRecordId;
      created = true;
      const s = await settingsOf(ctx);
      await ctx.tx.insert(content).values({
        ...fields,
        recordId: postId,
        workspaceId: ws,
        ideaId: input.ideaId,
        pictureState,
        facebookWhere: input.network === 'facebook' ? s.facebookWhere : [],
        postAt: input.postAt ? new Date(input.postAt) : null,
        placedBy: input.placedBy,
        madeBy: 'ai',
        createdBy: input.askedBy,
      });
    }
    if (input.ideaId) {
      const used = await ctx.tx
        .update(ideas)
        .set({
          state: 'used',
          decidedAt: changeMoment(ctx.meta),
          updatedAt: changeMoment(ctx.meta),
        })
        .where(and(eq(ideas.id, input.ideaId), eq(ideas.workspaceId, ws)))
        .returning({ id: ideas.id });
      if (used.length)
        await ctx.emit({
          type: 'socialcontent.idea.decided',
          entityType: 'socialcontent_idea',
          entityId: input.ideaId,
          payload: { state: 'used' },
        });
    }
    await ctx.emit({
      type: 'socialcontent.content.written',
      entityType: 'custom_record',
      entityId: postId,
      payload: {
        postId,
        network: input.network,
        format,
        again: !created,
        postAt: input.postAt,
        ideaId: input.ideaId,
      },
    });
    return { postId, created };
  },
});

export const contentPictured = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.pictured',
  description:
    'Worker: where a post’s AI-made pictures are (waiting, being made, made, or failed with why), and the pictures it made, which take the place of the earlier ones on the post (those stay among its files). New pictures take a post’s OK back.',
  risk: 0,
  input: ContentPicturedInput,
  output: z.object({ ok: z.literal(true) }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.content.pictured'],
  async handler(ctx, input) {
    const was = await loadContent(ctx, input.postId, { lock: true });
    needChangeable(was);
    const made = input.state === 'made' && input.fileIds;
    const newPictures = made && JSON.stringify(input.fileIds) !== JSON.stringify(was.fileIds);
    const unOk = newPictures && (was.state === 'ready' || was.state === 'failed');
    await ctx.tx
      .update(content)
      .set({
        pictureState: input.state,
        pictureFailure: input.state === 'failed' ? (input.failure ?? null) : null,
        ...(input.way ? { pictureWay: input.way } : {}),
        ...(made ? { fileIds: input.fileIds } : {}),
        ...(input.design !== undefined ? { design: input.design } : {}),
        ...(unOk
          ? { state: 'draft' as const, approvedBy: null, approvedAt: null, failure: null }
          : {}),
        updatedAt: changeMoment(ctx.meta),
      })
      .where(eq(content.recordId, was.recordId));
    if (input.state === 'made' || input.state === 'failed')
      await ctx.emit({
        type: 'socialcontent.content.pictured',
        entityType: 'custom_record',
        entityId: was.recordId,
        payload: { postId: was.recordId, state: input.state, pictures: input.fileIds?.length ?? 0 },
      });
    // The AI's earlier pictures stay among the post's files, for the person to use or remove.
    return { ok: true as const };
  },
});

export const calendarFilled = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.calendar.filled',
  description: 'Worker: the calendar was filled, with how many posts it wrote.',
  risk: 0,
  input: CalendarFilledInput,
  output: z.object({ ok: z.literal(true) }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.calendar.filled'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .insert(settings)
      .values({ workspaceId: ws, filledAt: at })
      .onConflictDoUpdate({ target: settings.workspaceId, set: { filledAt: at } });
    await ctx.emit({
      type: 'socialcontent.calendar.filled',
      entityType: 'socialcontent_settings',
      entityId: ws,
      payload: { written: input.written },
    });
    return { ok: true as const };
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
  contentPut,
  contentPictured,
  calendarFilled,
] as const;
