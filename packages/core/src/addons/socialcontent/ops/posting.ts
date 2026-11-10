/**
 * Putting the business's own posts up through the extension (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md,
 * parts 9 and 10; docs/socialcontent.md, "Posting"). An OK'd post goes up at its time from the business's reading
 * computer, in Chrome with the HandsFreeOS Social extension: on Facebook (the person's profile, the business's Page,
 * or both, decision 17), LinkedIn and Instagram (their feed).
 *
 * - `socialcontent.post.next` (the extension, each minute): the next OK'd post whose time has come, on the networks
 *   the extension posts on, taken so it's put up once. First it marks as didn't post what was taken and never said how
 *   it went (it may have gone up, so it's never tried again on its own) and what waited more than a day past its time.
 * - `socialcontent.post.went` (the extension): how each place went. Places it went up in are kept, so trying again
 *   never puts it up twice there. Nothing pressed (a warning, signed out) puts it back to waiting.
 * - `socialcontent.content.post_now` (a person, or the Assistant on a Confirm card): puts an OK'd post, or one that
 *   didn't post, up now. It's an OK too: nothing goes up without one (decision 15).
 */
import { rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import {
  hasPictures,
  isPostingNetwork,
  placesFor,
  placesLeft,
  POSTING,
  postText,
  stillNeeds,
  type PostedTo,
  type PostPlace,
} from '../calendar';
import {
  Content as ContentShape,
  ContentPostNowInput,
  PostNextInput,
  PostNextOutput,
  PostWentInput,
} from '../content-shapes';
import { socialcontentAddon } from '../manifest';
import { networkName } from '../networks';
import { content } from '../tables';
import { SOCIALCONTENT_WORDS as W } from '../words';
import { inWorkspace, settingsOf } from './common';
import { contentOut, loadContent, needChangeable, POST_REFUSALS, type ContentRow } from './content';
import { needReader } from './reading';

const PATH = 'a/socialcontent/calendar';

/** Each place's name, for a failure that says where it stopped. */
const PLACE_WORDS: Readonly<Record<PostPlace, (network: string) => string>> = {
  profile: () => W.post.wentUp.profile,
  page: () => W.post.wentUp.page,
  feed: (network) => W.post.wentUp.feed(network),
};

async function failed(
  ctx: CommandContext,
  list: readonly { record_id: string; network: string }[],
): Promise<void> {
  for (const f of list)
    await ctx.emit({
      type: 'socialcontent.content.failed',
      entityType: 'custom_record',
      entityId: f.record_id,
      payload: { postId: f.record_id, network: f.network },
    });
}

/** Marks a post as didn't post, with why. */
async function markFailed(ctx: CommandContext, c: ContentRow, why: string): Promise<void> {
  await ctx.tx
    .update(content)
    .set({ state: 'failed', failure: why.slice(0, 300), postingAt: null, updatedAt: new Date() })
    .where(eq(content.recordId, c.recordId));
  await failed(ctx, [{ record_id: c.recordId, network: c.network }]);
}

export const postNext = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.post.next',
  description:
    'Extension: the next of the business’s own posts to put up now, on the networks the extension posts on: OK’d, its time come, within a day of it, soonest first. It’s taken, so it goes up once. What a computer took and never said how it went is marked as didn’t post (it may have gone up), and what waited more than a day past its time too. Null when nothing is due.',
  risk: 0,
  input: PostNextInput,
  output: PostNextOutput,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.content.posting', 'socialcontent.content.failed'],
  async handler(ctx, input) {
    await needReader(ctx);
    const ws = ctx.scope.workspaceId!;
    await rows(
      ctx.tx,
      sql`update addon_socialcontent.settings
          set reader_seen_at = now(), reader_version = coalesce(${input.version ?? null}, reader_version)
          where workspace_id = ${ws}`,
    );
    // Taken and never said how it went: it may have gone up, so a person looks before it's tried again.
    const stuck = await rows<{ record_id: string; network: string }>(
      ctx.tx,
      sql`update addon_socialcontent.content set state = 'failed', posting_at = null, updated_at = now(),
            failure = case network
              when 'facebook' then ${W.posting.unsure(networkName('facebook'))}
              when 'linkedin' then ${W.posting.unsure(networkName('linkedin'))}
              else ${W.posting.unsure(networkName('instagram'))} end
          where workspace_id = ${ws} and state = 'posting'
            and coalesce(posting_at, updated_at) < now() - make_interval(secs => ${POSTING.postingForMs / 1000})
          returning record_id, network`,
    );
    await failed(ctx, stuck);
    // The computer wasn't on within a day of its time.
    const late = await rows<{ record_id: string; network: string }>(
      ctx.tx,
      sql`update addon_socialcontent.content set state = 'failed', failure = ${W.posting.late}, updated_at = now()
          where workspace_id = ${ws} and state = 'ready'
            and post_at < now() - make_interval(secs => ${POSTING.lateMs / 1000})
          returning record_id, network`,
    );
    await failed(ctx, late);
    const networks = input.networks.filter(isPostingNetwork);
    if (!networks.length) return { post: null };
    for (;;) {
      const [due] = await rows<{ record_id: string }>(
        ctx.tx,
        sql`select c.record_id from addon_socialcontent.content c
            join app.custom_records r on r.id = c.record_id and r.archived_at is null
            where c.workspace_id = ${ws} and c.state = 'ready' and c.post_at <= now()
              and c.network = any(${`{${networks.join(',')}}`}::text[])
            order by c.post_at, c.created_at limit 1
            for update of c skip locked`,
      );
      if (!due) return { post: null };
      const c = await loadContent(ctx, due.record_id);
      const [shown] = await contentOut(ctx, [c]);
      const files = shown!.pictures;
      const network = c.network;
      if (!isPostingNetwork(network)) {
        await markFailed(ctx, c, W.posting.notOn(networkName(network)));
        continue;
      }
      // What went missing since the OK: its video, or its pictures.
      if (c.format === 'video' && !files.some((f) => f.mimeType?.startsWith('video/'))) {
        await markFailed(ctx, c, W.posting.noVideo);
        continue;
      }
      if (hasPictures(c.format) && !files.length) {
        await markFailed(ctx, c, W.posting.noPicture);
        continue;
      }
      const places = placesLeft(network, c.facebookWhere, c.postedTo);
      if (!places.length) {
        // It went up everywhere already: a Try again after the last place had gone.
        await ctx.tx
          .update(content)
          .set({ state: 'posted', postingAt: null, failure: null, updatedAt: new Date() })
          .where(eq(content.recordId, c.recordId));
        continue;
      }
      const at = changeMoment(ctx.meta);
      await ctx.tx
        .update(content)
        .set({ state: 'posting', postingAt: at, updatedAt: at })
        .where(eq(content.recordId, c.recordId));
      await ctx.emit({
        type: 'socialcontent.content.posting',
        entityType: 'custom_record',
        entityId: c.recordId,
        payload: { postId: c.recordId, network, places },
        broadcast: false,
      });
      const s = await settingsOf(ctx);
      return {
        post: {
          id: c.recordId,
          title: c.title,
          network,
          format: c.format,
          text: postText(network, c.words, c.hashtags),
          // A video post sends its video; the rest send their pictures, in order.
          files: (c.format === 'video'
            ? files.filter((f) => f.mimeType?.startsWith('video/')).slice(0, 1)
            : files
          ).map((f) => ({
            bucket: f.bucket,
            objectPath: f.objectPath,
            name: f.name,
            mimeType: f.mimeType,
          })),
          places,
          facebookPage: s.facebookPage,
          postAt: c.postAt?.toISOString() ?? null,
        },
      };
    }
  },
});

export const postWent = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.post.went',
  description:
    'Extension: how putting one of the business’s own posts up went, place by place (Facebook profile, Page, a feed): each place it went up is kept with its link, so trying again never puts it up twice there. Up everywhere is posted; any place that didn’t take it is didn’t post, with why. Nothing pressed (again) puts it back to waiting.',
  risk: 0,
  input: PostWentInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  emits: ['socialcontent.content.posted', 'socialcontent.content.failed'],
  async handler(ctx, input) {
    await needReader(ctx);
    const c = await loadContent(ctx, input.postId, { lock: true });
    // A late answer still counts: after a while unanswered it's marked as didn't post, and may have gone up.
    if (c.state !== 'posting' && c.state !== 'failed')
      throw HfosError.rule('socialcontent_post_gone', 409, W.posting.gone);
    const network = networkName(c.network);
    const at = changeMoment(ctx.meta);
    const kept = new Set(c.postedTo.map((p) => p.place));
    const postedTo: PostedTo[] = [
      ...c.postedTo,
      ...input.went
        .filter((w) => w.posted && !kept.has(w.place))
        .map((w) => ({ place: w.place, link: w.link, at: at.toISOString() })),
    ];
    const left = placesLeft(c.network, c.facebookWhere, postedTo);
    const stops = input.went
      .filter((w) => !w.posted)
      .map((w) => ({ place: w.place, why: w.failure ?? input.failure ?? '' }));
    const several = placesFor(c.network, c.facebookWhere).length > 1;
    let state: ContentRow['state'];
    let failure: string | null = null;
    if (!left.length) state = 'posted';
    else if (input.again && postedTo.length === c.postedTo.length && !stops.length) {
      // Nothing was pressed: it waits for a later turn while its time is still recent.
      state = c.postAt && c.postAt.getTime() < Date.now() - POSTING.lateMs ? 'failed' : 'ready';
      failure = state === 'failed' ? W.posting.late : null;
    } else {
      state = 'failed';
      const why = stops.length
        ? stops
            .map((s) =>
              several
                ? W.posting.stoppedAt(PLACE_WORDS[s.place](network), s.why || W.post.didntPost)
                : s.why || W.post.didntPost,
            )
            .join(' ')
        : input.failure || W.post.didntPost;
      failure = why.slice(0, 300);
    }
    // The first link it got stands for the post (its profile's before its Page's).
    const link = postedTo.find((p) => p.link)?.link ?? c.postLink;
    await ctx.tx
      .update(content)
      .set({
        state,
        postedTo,
        postLink: link,
        failure,
        postingAt: null,
        ...(state === 'posted' ? { postedAt: at } : {}),
        updatedAt: at,
      })
      .where(eq(content.recordId, c.recordId));
    if (state === 'posted' || state === 'failed')
      await ctx.emit({
        type: state === 'posted' ? 'socialcontent.content.posted' : 'socialcontent.content.failed',
        entityType: 'custom_record',
        entityId: c.recordId,
        payload: {
          postId: c.recordId,
          network: c.network,
          places: postedTo.map((p) => p.place),
        },
      });
    const [out] = await contentOut(ctx, [await loadContent(ctx, c.recordId)]);
    return out!;
  },
});

export const contentPostNow = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.content.post_now',
  description:
    'Put one of the business’s own posts up now, from the computer that posts (in Chrome with the HandsFreeOS Social extension), instead of at its time: an OK’d one, or one that didn’t post. It counts as the OK (decision 15), so it needs everything a post needs. Places it already went up in are left out. It goes up in a minute or two while that computer has Chrome open.',
  risk: 2,
  input: ContentPostNowInput,
  output: ContentShape,
  permission: 'socialcontent.use',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_post_own_post_now',
    autonomy: 'confirm',
    what: () => 'Put this post up now',
    outcome: (output) => ({
      words: W.post.postNowAsked,
      path: `${PATH}?post=${String((output as { id?: unknown }).id ?? '')}`,
    }),
  },
  emits: ['socialcontent.content.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const c = await loadContent(ctx, input.postId, { lock: true });
    needChangeable(c);
    if (c.state === 'skipped')
      throw HfosError.rule('socialcontent_post_not_ready', 409, POST_REFUSALS.skipped);
    if (!isPostingNetwork(c.network) || !POSTING.networks.includes(c.network))
      throw HfosError.rule(
        'socialcontent_post_not_posted_here',
        409,
        W.posting.notOn(networkName(c.network)),
      );
    const s = await settingsOf(ctx);
    const [shown] = await contentOut(ctx, [c]);
    const at = changeMoment(ctx.meta);
    const needs = stillNeeds({
      network: c.network,
      format: c.format,
      words: c.words,
      slides: Array.isArray(c.slides) ? c.slides : [],
      fileIds: shown!.pictures.map((p) => p.fileId),
      videos: shown!.pictures.filter((p) => p.mimeType?.startsWith('video/')).length,
      postAt: at,
      facebookWhere: c.facebookWhere,
      facebookPage: s.facebookPage,
    });
    if (needs) throw HfosError.rule('socialcontent_post_not_ready', 409, needs);
    await ctx.tx
      .update(content)
      .set({
        state: 'ready',
        postAt: at,
        approvedBy: me,
        approvedAt: at,
        failure: null,
        postingAt: null,
        updatedAt: at,
      })
      .where(eq(content.recordId, c.recordId));
    await ctx.emit({
      type: 'socialcontent.content.approved',
      entityType: 'custom_record',
      entityId: c.recordId,
      payload: { postId: c.recordId, network: c.network, postAt: at.toISOString(), now: true },
    });
    const [out] = await contentOut(ctx, [await loadContent(ctx, c.recordId)]);
    return out!;
  },
});

export const POSTING_EXTENSION =
  'The HandsFreeOS Social extension sends this in from the computer that posts, as it puts the business’s OK’d posts up; a person never does.';

export const postingCommands = [postNext, postWent, contentPostNow] as const;
