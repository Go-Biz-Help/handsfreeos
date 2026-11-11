/**
 * Learning from the business's own posts (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, part 11; decision 19;
 * docs/socialcontent.md, "Its own posts' numbers"). Two and seven days after a post went up, the business's reading
 * computer reads its numbers in each place it went up with a link:
 *
 * - `socialcontent.own.next` (the extension, each minute, after posting): the next post whose read is due, on the
 *   networks it reads with no warning today. It's put off half an hour as it's handed out, so a read never answered
 *   is simply asked again later; reading numbers twice changes nothing.
 * - `socialcontent.own.read` (the extension): what each place showed, kept by place and read (`numbers`). Then the
 *   next read's time (`nextCheckAt`). At the 7-day read each place is weighed against the business's own other posts
 *   there (`ownDoneWell`); one that did well is kept (`done_well`) and goes into the Playbook beside the creators'
 *   standouts, which is written again when one does (`socialcontent.content.done_well`, heard by the worker).
 */
import { rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { isPostingNetwork, postText, type PostPlace } from '../calendar';
import {
  Content as ContentShape,
  OwnNextInput,
  OwnNextOutput,
  OwnReadInput,
} from '../content-shapes';
import { socialcontentAddon } from '../manifest';
import {
  checkDue,
  daysUp,
  hasNumbers,
  nextCheckAt,
  OWN,
  ownDoneWell,
  type DoneWell,
  type OwnNumbers,
  type OwnNumbersRead,
  type OwnPostNumbers,
} from '../own';
import { content } from '../tables';
import { inWorkspace } from './common';
import { contentOut, loadContent } from './content';
import { needReader } from './reading';

export const ownNext = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.own.next',
  description:
    'Extension: the next of the business’s own posts whose numbers are due to be read (about 2 and 7 days after it went up), on the networks given: the places to read, each by its link, and its words. It’s put off half an hour as it’s handed out. Null when none is due.',
  risk: 0,
  input: OwnNextInput,
  output: OwnNextOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    await needReader(ctx);
    const ws = ctx.scope.workspaceId!;
    const networks = input.networks.filter(isPostingNetwork);
    if (!networks.length) return { check: null };
    const now = changeMoment(ctx.meta);
    for (;;) {
      const [due] = await rows<{ record_id: string }>(
        ctx.tx,
        sql`select c.record_id from addon_socialcontent.content c
            join app.custom_records r on r.id = c.record_id and r.archived_at is null
            where c.workspace_id = ${ws} and c.checks_due_at <= ${now.toISOString()}::timestamptz
              and c.network = any(${`{${networks.join(',')}}`}::text[])
            order by c.checks_due_at limit 1
            for update of c skip locked`,
      );
      if (!due) return { check: null };
      const c = await loadContent(ctx, due.record_id);
      const network = c.network;
      const check = isPostingNetwork(network) ? checkDue(c.postedTo, c.numbers, now) : null;
      if (!check || !isPostingNetwork(network)) {
        // Nothing to read now (it went up nowhere with a link, or both reads are in): when it's next due, if ever.
        await ctx.tx
          .update(content)
          .set({ checksDueAt: nextCheckAt(c.postedTo, c.numbers) })
          .where(eq(content.recordId, c.recordId));
        continue;
      }
      await ctx.tx
        .update(content)
        .set({ checksDueAt: new Date(now.getTime() + OWN.takenMs) })
        .where(eq(content.recordId, c.recordId));
      return {
        check: {
          id: c.recordId,
          network,
          read: check.read,
          places: check.places,
          text: postText(network, c.words, c.hashtags),
        },
      };
    }
  },
});

/** The business's own posts with their 7-day numbers in one place, but this one: what it's weighed against. */
async function othersIn(
  ctx: CommandContext,
  network: string,
  place: PostPlace,
  except: string,
): Promise<OwnPostNumbers[]> {
  const found = await rows<{ record_id: string; numbers: OwnNumbers; posted_to: unknown }>(
    ctx.tx,
    sql`select record_id, numbers, posted_to from addon_socialcontent.content
        where workspace_id = ${ctx.scope.workspaceId!} and network = ${network}
          and record_id <> ${except}::uuid and numbers -> ${place}::text ? 'd7'
        order by posted_at desc nulls last limit 60`,
  );
  return found.flatMap((r) => {
    const read = r.numbers?.[place]?.d7;
    const at = Array.isArray(r.posted_to)
      ? (r.posted_to as { place: string; at: string }[]).find((p) => p.place === place)?.at
      : undefined;
    if (!hasNumbers(read) || !at) return [];
    return [
      {
        id: r.record_id,
        place,
        at,
        views: read.views,
        likes: read.likes,
        comments: read.comments,
      },
    ];
  });
}

export const ownRead = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.own.read',
  description:
    'Extension: what one of the business’s own posts showed in each place it went up, at its read about 2 or 7 days on (views where the network shows them, likes, comments, shares), or why a place couldn’t be read. Kept on the post; at the 7-day read it’s weighed against the business’s own other posts there, and one that did well goes into the Playbook.',
  risk: 0,
  input: OwnReadInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.content.done_well'],
  async handler(ctx, input) {
    await needReader(ctx);
    const c = await loadContent(ctx, input.postId, { lock: true });
    const at = changeMoment(ctx.meta);
    const upAt = new Map(c.postedTo.map((p) => [p.place, p.at]));
    const numbers: Record<string, Record<string, OwnNumbersRead>> = JSON.parse(
      JSON.stringify(c.numbers ?? {}),
    ) as Record<string, Record<string, OwnNumbersRead>>;
    for (const r of input.reads) {
      const up = upAt.get(r.place);
      // Only places it went up in, and each read once.
      if (!up || numbers[r.place]?.[input.read]) continue;
      const days = daysUp(up, at);
      numbers[r.place] = {
        ...(numbers[r.place] ?? {}),
        [input.read]: r.failure
          ? { at: at.toISOString(), days, failure: r.failure.slice(0, 300) }
          : {
              at: at.toISOString(),
              days,
              views: r.views,
              likes: r.likes,
              comments: r.comments,
              shares: r.shares,
            },
      };
    }
    const own = numbers as OwnNumbers;
    // At the 7-day read: how each place did against the business's own other posts there; the best one is kept.
    let doneWell: DoneWell | null = c.doneWell;
    if (input.read === 'd7' && !doneWell) {
      for (const p of c.postedTo) {
        const read = own[p.place]?.d7;
        if (!hasNumbers(read)) continue;
        const well = ownDoneWell(
          {
            id: c.recordId,
            place: p.place,
            at: p.at,
            views: read.views,
            likes: read.likes,
            comments: read.comments,
          },
          await othersIn(ctx, c.network, p.place, c.recordId),
          at,
        );
        if (well && (!doneWell || well.times > doneWell.times)) doneWell = well;
      }
    }
    await ctx.tx
      .update(content)
      .set({
        numbers: own,
        checksDueAt: nextCheckAt(c.postedTo, own),
        doneWell,
        updatedAt: at,
      })
      .where(eq(content.recordId, c.recordId));
    if (doneWell && !c.doneWell)
      await ctx.emit({
        type: 'socialcontent.content.done_well',
        entityType: 'custom_record',
        entityId: c.recordId,
        payload: { postId: c.recordId, network: c.network, times: doneWell.times },
        broadcast: false,
      });
    const [out] = await contentOut(ctx, [await loadContent(ctx, c.recordId)]);
    return out!;
  },
});

export const OWN_EXTENSION =
  'The HandsFreeOS Social extension sends this in from the reading computer, as it reads the business’s own posts’ numbers; a person never does.';

export const ownCommands = [ownNext, ownRead] as const;
