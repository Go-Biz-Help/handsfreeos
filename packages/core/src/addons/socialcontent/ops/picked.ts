/**
 * Picking many of the business's own posts on the Calendar, and what a post that didn't post can do (the owner, 15 Nov
 * 2026; the design they OK'd; docs/socialcontent.md, "Picking many posts"):
 *
 * - `socialcontent.content.approve_many`: OK the picked posts waiting for an OK.
 * - `socialcontent.content.hide`: take them off the Calendar, kept under its Hidden filter; one not up yet is skipped
 *   too, so it never goes up while hidden. `hide: false` shows them again.
 * - `socialcontent.content.remove_many`: delete them from the Calendar (owners and admins, as removing one is). One
 *   that went up stays on the network: HandsFreeOS can't take posts down.
 * - `socialcontent.content.mark_posted`: posts that didn't post marked as posted by hand, when the person sees them on
 *   the network; one may carry its link, so its numbers are read.
 * - `socialcontent.content.look` (Check if it posted): the reading computer looks on the network for them by their
 *   first words, through `socialcontent.post.look_next` and `socialcontent.post.looked`. It also looks once on its
 *   own, 10 minutes after one that may have gone up is marked as didn't post (./posting.ts).
 * - `socialcontent.content.pick`: the Pick menu's "all" picks across any date.
 *
 * Redo is `socialcontent.content.redo` (./posting.ts), with no 30 cap now. Each picking command takes up to 500 posts at
 * a time and says which it left alone and why; the screens send more in turns.
 */
import { rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  canLook,
  isPostingNetwork,
  LOOK,
  PICKING,
  placesLeft,
  postText,
  type PostedTo,
} from '../calendar';
import {
  Content as ContentShape,
  ContentApproveManyInput,
  ContentApproveManyOutput,
  ContentHideInput,
  ContentHideOutput,
  ContentLookInput,
  ContentLookOutput,
  ContentMarkPostedInput,
  ContentMarkPostedOutput,
  ContentPickInput,
  ContentPickOutput,
  ContentRemoveManyInput,
  ContentRemoveManyOutput,
  PostLookedInput,
  PostLookNextInput,
  PostLookNextOutput,
} from '../content-shapes';
import { socialcontentAddon } from '../manifest';
import { networkName } from '../networks';
import { nextCheckAt } from '../own';
import { content } from '../tables';
import { SOCIALCONTENT_WORDS as W } from '../words';
import { inWorkspace, settingsOf, timeZoneOf } from './common';
import {
  contentOut,
  loadContent,
  okOne,
  POST_REFUSALS,
  rangeOf,
  removeOne,
  type ContentRow,
} from './content';
import { needReader } from './reading';

const PATH = 'a/socialcontent/calendar';

export const PICK_REFUSALS = {
  notWaiting: 'It isn’t waiting for an OK, so there’s nothing to OK.',
  notFailed:
    'Only a post that didn’t post can be marked as posted or looked for. This one isn’t marked as didn’t post.',
  linkOne:
    'A link goes with one post. Mark them one at a time to add each one’s link, or leave the link empty.',
  linkElsewhere: (network: string) =>
    `That link isn’t a ${network} link. Copy the post’s link from ${network}, or leave it empty.`,
  noReader:
    'No computer puts posts up yet, so nothing can look for them. An owner or admin picks one in Settings → Whose computer reads.',
  removeWho: 'Only an owner or admin can delete posts. Hide them instead, or ask one of them.',
} as const;

/** The sites each network's posts live on, for a link someone pastes. */
const NETWORK_HOSTS: Readonly<Record<string, readonly string[]>> = {
  facebook: ['facebook.com', 'fb.com', 'fb.watch'],
  instagram: ['instagram.com'],
  linkedin: ['linkedin.com', 'lnkd.in'],
  threads: ['threads.net', 'threads.com'],
  x: ['x.com', 'twitter.com'],
};
const onNetwork = (link: string, network: string): boolean => {
  const hosts = NETWORK_HOSTS[network];
  if (!hosts) return true;
  try {
    const host = new URL(link).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

type LeftOut = { postId: string; title: string; why: string };

/** Each picked post, locked, in the order given; one removed meanwhile is left out, saying so. */
async function eachPicked(
  ctx: CommandContext,
  postIds: readonly string[],
  left: LeftOut[],
): Promise<ContentRow[]> {
  const out: ContentRow[] = [];
  for (const postId of [...new Set(postIds)]) {
    const c = await loadContent(ctx, postId, { lock: true }).catch((e: unknown) => {
      if (e instanceof HfosError && e.code === 'not_found') return null;
      throw e;
    });
    if (c) out.push(c);
    else left.push({ postId, title: '', why: POST_REFUSALS.gone });
  }
  return out;
}

const count = (o: unknown, key: string) =>
  ((o as Record<string, unknown>)[key] as number | undefined) ?? 0;
const leftOf = (o: unknown, key: string) =>
  ((o as Record<string, unknown>)[key] as unknown[] | undefined)?.length ?? 0;
const picked = (input: unknown) => (input as { postIds?: unknown[] }).postIds?.length ?? 0;
const these = (n: number, one: string, many: string) =>
  n === 1 ? one : many.replace('#', String(n));

export const contentApproveMany = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.approve_many',
  description:
    'OK several of the business’s own posts at once (the owner, 15 Nov: picked on the Calendar, by post, day, week, month or all), so each goes up at its time (decision 15). Only posts waiting for an OK, each with everything it needs and its time ahead. Says how many it OK’d, and which it couldn’t and why. Up to 500 at a time.',
  risk: 2,
  input: ContentApproveManyInput,
  output: ContentApproveManyOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_approve_own_posts',
    autonomy: 'confirm',
    what: (input) =>
      these(
        picked(input),
        'OK this post to go up at its time',
        'OK these # posts to go up at their times',
      ),
    outcome: (output) => ({
      words: W.picking.approved(count(output, 'approved'), leftOf(output, 'notApproved')),
      path: PATH,
    }),
  },
  emits: ['socialcontent.content.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const facebookPage = (await settingsOf(ctx)).facebookPage;
    const notApproved: LeftOut[] = [];
    let approved = 0;
    for (const c of await eachPicked(ctx, input.postIds, notApproved)) {
      if (c.state !== 'draft') {
        notApproved.push({ postId: c.recordId, title: c.title, why: PICK_REFUSALS.notWaiting });
        continue;
      }
      const needs = await okOne(ctx, c, me, facebookPage);
      if (needs) notApproved.push({ postId: c.recordId, title: c.title, why: needs });
      else approved++;
    }
    return { approved, notApproved };
  },
});

export const contentHide = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.hide',
  description:
    'Hide several of the business’s own posts from the Calendar (the owner, 15 Nov): they’re kept under its Hidden filter, and one that hasn’t gone up is skipped too, so it never goes up while hidden (an OK’d one loses its OK) and its day opens for another. hide: false shows them again, bringing a skipped one back as waiting for an OK. Not one going up right now. Up to 500 at a time.',
  risk: 1,
  input: ContentHideInput,
  output: ContentHideOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_hide_own_posts',
    outcome: (output, input) => ({
      words:
        (input as { hide?: boolean }).hide === false
          ? W.picking.shown(count(output, 'changed'))
          : W.picking.hidden(count(output, 'changed')),
      path: PATH,
    }),
  },
  emits: ['socialcontent.content.hidden'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const at = changeMoment(ctx.meta);
    const notChanged: LeftOut[] = [];
    let changed = 0;
    for (const c of await eachPicked(ctx, input.postIds, notChanged)) {
      if (input.hide) {
        if (c.hiddenAt) continue;
        if (c.state === 'posting') {
          notChanged.push({ postId: c.recordId, title: c.title, why: POST_REFUSALS.posting });
          continue;
        }
        // A hidden post never goes up: one not up yet is skipped, as Skip does, and its day opens.
        const skips = c.state === 'draft' || c.state === 'ready';
        await ctx.tx
          .update(content)
          .set({
            hiddenAt: at,
            ...(skips ? { state: 'skipped' as const, approvedBy: null, approvedAt: null } : {}),
            updatedAt: at,
          })
          .where(eq(content.recordId, c.recordId));
        await ctx.emit({
          type: 'socialcontent.content.hidden',
          entityType: 'custom_record',
          entityId: c.recordId,
          payload: { postId: c.recordId, network: c.network, hidden: true, skipped: skips },
        });
      } else {
        if (!c.hiddenAt) continue;
        await ctx.tx
          .update(content)
          .set({
            hiddenAt: null,
            ...(c.state === 'skipped' ? { state: 'draft' as const } : {}),
            updatedAt: at,
          })
          .where(eq(content.recordId, c.recordId));
        await ctx.emit({
          type: 'socialcontent.content.hidden',
          entityType: 'custom_record',
          entityId: c.recordId,
          payload: { postId: c.recordId, network: c.network, hidden: false },
        });
      }
      changed++;
    }
    return { changed, notChanged };
  },
});

export const contentRemoveMany = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.remove_many',
  description:
    'Delete several of the business’s own posts from the Calendar for good (the owner, 15 Nov): their records are archived, as an add-on’s records are never deleted. One not up yet never goes up, and its day opens for another; one that went up stays on the network, since HandsFreeOS can’t take posts down. Not one going up right now. Owners and admins. Up to 500 at a time.',
  risk: 2,
  input: ContentRemoveManyInput,
  output: ContentRemoveManyOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_remove_own_posts',
    autonomy: 'confirm',
    what: (input) =>
      these(
        picked(input),
        'Delete this post from the Calendar',
        'Delete these # posts from the Calendar',
      ),
    outcome: (output) => ({
      words: W.picking.removed(count(output, 'removed'), leftOf(output, 'notRemoved')),
      path: PATH,
    }),
  },
  // Each record's archiving is core's command, with that command's own event.
  emits: [],
  async handler(ctx, input) {
    requireHuman(ctx);
    // Archiving a record is records.archive's, and the database holds that too.
    if (!scopeCan(ctx.scope, 'records.archive'))
      throw HfosError.rule('socialcontent_remove_forbidden', 403, PICK_REFUSALS.removeWho);
    const notRemoved: LeftOut[] = [];
    let removed = 0;
    for (const c of await eachPicked(ctx, input.postIds, notRemoved)) {
      if (c.state === 'posting') {
        notRemoved.push({ postId: c.recordId, title: c.title, why: POST_REFUSALS.posting });
        continue;
      }
      await removeOne(ctx, c);
      removed++;
    }
    return { removed, notRemoved };
  },
});

export const contentMarkPosted = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.mark_posted',
  description:
    'Mark posts that didn’t post as posted (the owner, 15 Nov): for when the person can see them on the network, since one can go up even though the extension didn’t see it go up. Each moves to posted everywhere it hadn’t gone up and won’t go up again. With one post, its link may be given (from that network), so its numbers are read 2 and 7 days on. Up to 500 at a time.',
  risk: 2,
  input: ContentMarkPostedInput,
  output: ContentMarkPostedOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_mark_own_posts_posted',
    autonomy: 'confirm',
    what: (input) =>
      these(picked(input), 'Mark this post as posted', 'Mark these # posts as posted'),
    outcome: (output) => ({
      words: W.picking.marked(count(output, 'marked'), leftOf(output, 'notMarked')),
      path: PATH,
    }),
  },
  emits: ['socialcontent.content.posted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    if (input.link && new Set(input.postIds).size > 1)
      throw HfosError.rule('socialcontent_link_one', 400, PICK_REFUSALS.linkOne);
    const at = changeMoment(ctx.meta);
    const notMarked: LeftOut[] = [];
    let marked = 0;
    for (const c of await eachPicked(ctx, input.postIds, notMarked)) {
      if (!canLook(c)) {
        notMarked.push({ postId: c.recordId, title: c.title, why: PICK_REFUSALS.notFailed });
        continue;
      }
      if (input.link && !onNetwork(input.link, c.network))
        throw HfosError.rule(
          'socialcontent_link_elsewhere',
          400,
          PICK_REFUSALS.linkElsewhere(networkName(c.network)),
        );
      // It went up about its time, as far as anyone knows: its numbers are read from then.
      const when = new Date(Math.min(c.postAt?.getTime() ?? at.getTime(), at.getTime()));
      const left = placesLeft(c.network, c.facebookWhere, c.postedTo);
      const postedTo: PostedTo[] = [
        ...c.postedTo,
        ...left.map((place, i) => ({
          place,
          link: i === 0 ? input.link : null,
          at: when.toISOString(),
        })),
      ];
      await ctx.tx
        .update(content)
        .set({
          state: 'posted',
          // A post that went up was OK'd; one marked as didn't post before it was OK'd counts as OK'd now.
          ...(c.approvedAt ? {} : { approvedAt: at, approvedBy: me }),
          postedTo,
          postLink: c.postLink ?? input.link,
          postedAt: when,
          failure: null,
          postingAt: null,
          lookDueAt: null,
          lookedAt: null,
          lookFailure: null,
          lookAsked: false,
          checksDueAt: c.checksDueAt ?? nextCheckAt(postedTo, c.numbers),
          updatedAt: at,
        })
        .where(eq(content.recordId, c.recordId));
      await ctx.emit({
        type: 'socialcontent.content.posted',
        entityType: 'custom_record',
        entityId: c.recordId,
        payload: {
          postId: c.recordId,
          network: c.network,
          places: postedTo.map((p) => p.place),
          marked: true,
        },
      });
      marked++;
    }
    return { marked, notMarked };
  },
});

export const contentLook = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.look',
  description:
    'Check if posts that didn’t post went up after all (the owner, 15 Nov): the computer that posts looks on the network for each, by its first words, in Chrome with the HandsFreeOS Social extension, usually within a minute while Chrome is open there. Each one found is marked as posted with its link; one not found says so. Up to 500 at a time.',
  risk: 1,
  input: ContentLookInput,
  output: ContentLookOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_check_own_posts',
    outcome: (output) => ({
      words: W.picking.lookAsked(count(output, 'asked'), leftOf(output, 'notAsked')),
      path: PATH,
    }),
  },
  emits: [],
  async handler(ctx, input) {
    requireHuman(ctx);
    if (!(await settingsOf(ctx)).readerUserId)
      throw HfosError.rule('socialcontent_no_reader', 409, PICK_REFUSALS.noReader);
    const at = changeMoment(ctx.meta);
    const notAsked: LeftOut[] = [];
    let asked = 0;
    for (const c of await eachPicked(ctx, input.postIds, notAsked)) {
      if (!canLook(c)) {
        notAsked.push({ postId: c.recordId, title: c.title, why: PICK_REFUSALS.notFailed });
        continue;
      }
      await ctx.tx
        .update(content)
        // Asked for by a person: its window comes in front for the look right away, as a Check's does.
        .set({ lookDueAt: at, lookFailure: null, lookAsked: true })
        .where(eq(content.recordId, c.recordId));
      asked++;
    }
    return { asked, notAsked };
  },
});

export const contentPick = defineAddonQuery(socialcontentAddon, {
  name: 'socialcontent.content.pick',
  description:
    'The business’s own posts the Calendar’s Pick menu picks across any date, or the days given (the owner, 15 Nov): everything (all), waiting for an OK (waiting), OK’d (okd), past ones that went up or didn’t (past), ones that didn’t post (failed), or hidden ones (hidden). Only everything and hidden take in hidden posts. Each with its title, network, state and time; up to 2,000, soonest first.',
  input: ContentPickInput,
  output: ContentPickOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: { tool: 'socialcontent_pick_own_posts' },
  async handler(ctx, input) {
    const which =
      input.which === 'all'
        ? sql`true`
        : input.which === 'hidden'
          ? sql`c.hidden_at is not null`
          : input.which === 'waiting'
            ? sql`c.hidden_at is null and c.state = 'draft'`
            : input.which === 'okd'
              ? sql`c.hidden_at is null and c.state = 'ready'`
              : input.which === 'failed'
                ? sql`c.hidden_at is null and c.state = 'failed'`
                : sql`c.hidden_at is null and c.state in ('posted', 'failed')`;
    let when = sql`true`;
    if (input.from) {
      const { start, stop } = rangeOf(input.from, input.days ?? 1, await timeZoneOf(ctx));
      when = sql`c.post_at >= ${start.toISOString()}::timestamptz and c.post_at < ${stop.toISOString()}::timestamptz`;
    }
    const found = await rows<{
      id: string;
      title: string;
      network: string;
      state: string;
      post_at: string | Date | null;
      hidden: boolean;
    }>(
      ctx.tx,
      sql`select c.record_id as id, r.name as title, c.network, c.state, c.post_at,
                 c.hidden_at is not null as hidden
          from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
          where c.workspace_id = ${ctx.scope.workspaceId!} and ${which} and ${when}
          order by c.post_at nulls last, c.created_at
          limit ${PICKING.listMost + 1}`,
    );
    return ContentPickOutput.parse({
      posts: found.slice(0, PICKING.listMost).map((r) => ({
        id: r.id,
        title: r.title,
        network: r.network,
        state: r.state,
        postAt: r.post_at ? new Date(r.post_at).toISOString() : null,
        hidden: r.hidden,
      })),
      more: found.length > PICKING.listMost,
    });
  },
});

// ------------------------------------------------------------------------------------------------ the extension

export const postLookNext = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.post.look_next',
  description:
    'Extension: the next of the business’s own posts that didn’t post to look for on the network (Check if it posted, or on its own 10 minutes after one that may have gone up), on the networks given: its words as they went up, and the places it hadn’t gone up. It’s put off half an hour as it’s handed out. Null when none is due.',
  risk: 0,
  input: PostLookNextInput,
  output: PostLookNextOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  // Asked every minute. A look handed out and never answered is asked again later, so a repeat does no harm, and it
  // leaves no receipt: each one went to every phone of the person's.
  receipt: false,
  emits: [],
  async handler(ctx, input) {
    await needReader(ctx);
    const ws = ctx.scope.workspaceId!;
    const networks = input.networks.filter(isPostingNetwork);
    if (!networks.length) return { post: null };
    const now = changeMoment(ctx.meta);
    for (;;) {
      const [due] = await rows<{ record_id: string }>(
        ctx.tx,
        sql`select c.record_id from addon_socialcontent.content c
            join app.custom_records r on r.id = c.record_id and r.archived_at is null
            where c.workspace_id = ${ws} and c.look_due_at <= ${now.toISOString()}::timestamptz
              and c.network = any(${`{${networks.join(',')}}`}::text[])
            order by c.look_due_at limit 1
            for update of c skip locked`,
      );
      if (!due) return { post: null };
      const c = await loadContent(ctx, due.record_id);
      const network = c.network;
      const places = placesLeft(network, c.facebookWhere, c.postedTo);
      // Redone, posted or skipped since it was asked for: nothing to look for.
      if (!canLook(c) || !isPostingNetwork(network) || !places.length) {
        await ctx.tx
          .update(content)
          .set({ lookDueAt: null, lookAsked: false })
          .where(eq(content.recordId, c.recordId));
        continue;
      }
      await ctx.tx
        .update(content)
        .set({ lookDueAt: new Date(now.getTime() + LOOK.takenMs) })
        .where(eq(content.recordId, c.recordId));
      return {
        post: {
          id: c.recordId,
          network,
          text: postText(network, c.words, c.hashtags),
          places,
          facebookPage: (await settingsOf(ctx)).facebookPage,
          postAt: c.postAt?.toISOString() ?? null,
          asked: c.lookAsked,
        },
      };
    }
  },
});

export const postLooked = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.post.looked',
  description:
    'Extension: what looking on the network for a post that didn’t post found, place by place. Found everywhere it hadn’t gone up, it’s posted, with its links; otherwise it stays as didn’t post, saying when it looked. Why it couldn’t look at all (signed out, a warning) is kept to show.',
  risk: 0,
  input: PostLookedInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.content.posted'],
  async handler(ctx, input) {
    await needReader(ctx);
    const c = await loadContent(ctx, input.postId, { lock: true });
    const at = changeMoment(ctx.meta);
    if (!canLook(c)) {
      // Redone or marked meanwhile: what it found no longer matters.
      await ctx.tx
        .update(content)
        .set({ lookDueAt: null, lookAsked: false })
        .where(eq(content.recordId, c.recordId));
    } else if (input.failure && !input.found.length) {
      await ctx.tx
        .update(content)
        .set({ lookDueAt: null, lookAsked: false, lookFailure: input.failure, updatedAt: at })
        .where(eq(content.recordId, c.recordId));
    } else {
      const kept = new Set(c.postedTo.map((p) => p.place));
      const postedTo: PostedTo[] = [
        ...c.postedTo,
        ...input.found
          .filter((f) => !kept.has(f.place))
          .map((f) => ({ place: f.place, link: f.link, at: at.toISOString() })),
      ];
      const done = !placesLeft(c.network, c.facebookWhere, postedTo).length;
      await ctx.tx
        .update(content)
        .set({
          postedTo,
          postLink: postedTo.find((p) => p.link)?.link ?? c.postLink,
          lookDueAt: null,
          lookAsked: false,
          lookFailure: null,
          lookedAt: done ? null : at,
          ...(done
            ? {
                state: 'posted' as const,
                ...(c.approvedAt ? {} : { approvedAt: at }),
                failure: null,
                postedAt: at,
                checksDueAt: c.checksDueAt ?? nextCheckAt(postedTo, c.numbers),
              }
            : {}),
          updatedAt: at,
        })
        .where(eq(content.recordId, c.recordId));
      if (done)
        await ctx.emit({
          type: 'socialcontent.content.posted',
          entityType: 'custom_record',
          entityId: c.recordId,
          payload: {
            postId: c.recordId,
            network: c.network,
            places: postedTo.map((p) => p.place),
            looked: true,
          },
        });
    }
    const [out] = await contentOut(ctx, [await loadContent(ctx, c.recordId)]);
    return out!;
  },
});

export const LOOK_EXTENSION =
  'The HandsFreeOS Social extension sends this in from the computer that posts, as it looks on the network for a post that didn’t post; a person asks with Check if it posted (socialcontent_check_own_posts).';

export const pickedCommands = [
  contentApproveMany,
  contentHide,
  contentRemoveMany,
  contentMarkPosted,
  contentLook,
  postLookNext,
  postLooked,
] as const;
export const pickedQueries = [contentPick] as const;
