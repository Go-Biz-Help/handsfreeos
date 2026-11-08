/**
 * What the worker keeps for AI Social Media Content Creator (docs/socialcontent.md): the niches the AI suggested, the
 * words it wrote to search each network for a niche, and the weekly and monthly reading it queues (decision 11).
 * The system's alone.
 */
import { rows, sql } from '@hfos/db/client';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineAddonCommand } from '../../server';
import { socialcontentAddon } from '../manifest';
import { CONTENT_NETWORK_INFO } from '../networks';
import {
  LIMITS,
  NicheSearchesPutInput,
  NichesPutInput,
  NichesPutOutput,
  WorkQueueInput,
} from '../shapes';
import { creators, niches } from '../tables';
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

export const workerCommands = [nichesPut, nicheSearchesPut, workQueue] as const;
