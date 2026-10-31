/**
 * Openers on group posts (../posts.ts, docs/outreach.md decisions 18 to 20): the posts in a group's feed that the
 * extension read, kept when they're worth a look and checked by the AI, each person's own. Nobody goes in Contacts:
 * who wrote one is kept as a profile with no customer, as when a step is noted. Today lists the good ones
 * (./today.ts) until the person comments, which the extension notes as before, or puts the post aside.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import { NETWORKS } from '../networks';
import {
  dayNumber,
  PostCheckInput,
  PostCheckOutput,
  accountPostLook,
  postLook,
  postLooks,
  type PostCheck,
  type PostMark,
  PostSkipInput,
  PostSkipOutput,
  PostsSaveInput,
  PostsSaveOutput,
  postSearchWords,
  PostWordsInput,
  PostWordsOutput,
} from '../posts';
import { posts, touches } from '../tables';
import { keepGroup } from './activity';
import { inWorkspace, keptProfile, once } from './common';
import { tally } from './tallies';
import { findWriter } from './finds';
import { playbooksInUse } from './friends';

export const postsSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.posts.save',
  description:
    'Keep the posts in a Facebook group’s feed, or found by a network’s own search (LinkedIn’s post search, Instagram’s hashtags and places, Alignable’s town), that are worth a comment from the person: those saying a playbook’s signs or asking for help, or found under a playbook’s own hashtag or phrase, with who wrote them and the hashtag or phrase that found them, for the AI to check. Says how each post the page shows stands, for the extension to mark. Nobody goes in Contacts.',
  risk: 1,
  input: PostsSaveInput,
  output: PostsSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.posts.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const groupId = input.group ? await keepGroup(ctx, input.platform, input.group) : null;
      const playbooks = await playbooksInUse(ctx, input.platform);
      const urls = [...new Set(input.posts.map((p) => p.url))];
      // Each post the computer read counts (decision 140).
      await tally(ctx, me, input.platform, 'post', urls.length, at);
      const kept = await ctx.tx
        .select()
        .from(posts)
        .where(and(eq(posts.workspaceId, ws), eq(posts.userId, me), inArray(posts.url, urls)));
      const commented = new Set(
        (
          await ctx.tx
            .selectDistinct({ postUrl: touches.postUrl })
            .from(touches)
            .where(
              and(
                eq(touches.workspaceId, ws),
                eq(touches.userId, me),
                eq(touches.kind, 'comment'),
                inArray(touches.postUrl, urls),
              ),
            )
        ).map((r) => r.postUrl),
      );
      const byUrl = new Map(kept.map((p) => [p.url, p]));
      const marks: PostMark[] = [];
      let checking = 0;
      for (const p of input.posts) {
        const had = byUrl.get(p.url);
        if (had) {
          await ctx.tx
            .update(posts)
            .set({
              body: p.text,
              ...(p.when ? { posted: p.when } : {}),
              ...(p.comments !== null ? { comments: p.comments } : {}),
              ...(p.reactions !== null ? { reactions: p.reactions } : {}),
              groupId: had.groupId ?? groupId,
              // The first hashtag or phrase that found it stays (decision 92).
              ...(had.words === null && input.words ? { words: input.words } : {}),
              seenAt: at,
            })
            .where(eq(posts.id, had.id));
          marks.push({
            url: p.url,
            check: had.checkState,
            why: had.checkWhy ? [had.checkWhy] : had.reasons,
            done: commented.has(p.url) || had.skippedAt !== null,
          });
          continue;
        }
        // An account like the business's (decision 110): each of its posts is kept, for its people.
        const look =
          input.found === 'account'
            ? accountPostLook(playbooks, input.words, p.text)
            : postLook(playbooks, p.text, { platform: input.platform, words: input.words });
        if (!look.worth) {
          marks.push({ url: p.url, check: null, why: look.reasons as string[], done: false });
          continue;
        }
        const author = await keptProfile(
          ctx,
          { platform: input.platform, profile: p.author, name: p.name },
          me,
          at,
          { groupId },
          (h) => (h.groupId ? {} : { groupId }),
        );
        const [row] = await ctx.tx
          .insert(posts)
          .values({
            workspaceId: ws,
            userId: me,
            groupId,
            profileId: author.id,
            url: p.url,
            posted: p.when,
            body: p.text,
            comments: p.comments,
            reactions: p.reactions,
            reasons: [...look.reasons],
            playbookId: look.playbookId,
            found: input.found,
            words: input.words,
            seenAt: at,
          })
          .onConflictDoNothing()
          .returning({ id: posts.id });
        if (row) checking++;
        marks.push({
          url: p.url,
          check: 'waiting',
          why: [...look.reasons],
          done: commented.has(p.url),
        });
      }
      if (checking)
        await ctx.emit({
          type: 'outreach.posts.saved',
          entityType: 'workspace',
          entityId: ws,
          payload: {
            groupId,
            posts: input.posts.length,
            checking,
            found: input.found,
            ...(input.words ? { words: input.words } : {}),
          },
        });
      return { groupId, posts: marks, checking };
    });
  },
});

export const postCheck = defineAddonCommand(outreachAddon, {
  name: 'outreach.post.check',
  description:
    'Worker: what the AI made of a group post kept as worth a look: good for the person to comment on, or not, with why, whether its writer is asking now for what the business offers, and whether its writer is someone the business is for; or that it couldn’t be read. On Instagram, LinkedIn or Alignable a good post’s writer is found, and so is one who fits though their post isn’t good, for the AI’s check of them.',
  risk: 0,
  input: PostCheckInput,
  output: PostCheckOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.post.checked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [post] = await ctx.tx
      .select()
      .from(posts)
      .where(and(eq(posts.workspaceId, ws), eq(posts.id, input.postId)))
      .for('update');
    if (!post) throw HfosError.notFound('That post isn’t kept anymore.');
    // Checked already: a second answer changes nothing.
    if (post.checkState !== 'waiting')
      return { postId: post.id, check: post.checkState, strong: post.strong };
    const check: PostCheck = input.check ? (input.check.good ? 'good' : 'not') : 'failed';
    // Strong only ever for a good post (decision 49).
    const strong = check === 'good' && input.check?.strong === true;
    await ctx.tx
      .update(posts)
      .set({ checkState: check, checkWhy: input.check?.why ?? null, strong, checkedAt: at })
      .where(eq(posts.id, post.id));
    // A good post's writer, on a network that checks people found (decision 92), is found: the AI checks them from
    // their own page before anything is done for them. So is a writer the business is for whose post isn't one to
    // comment on, as most a search finds are their own ads (decision 123), found by the search.
    if (check === 'good') await findWriter(ctx, post, at);
    else if (check === 'not' && input.check?.fits) await findWriter(ctx, post, at, 'searched');
    await ctx.emit({
      type: 'outreach.post.checked',
      entityType: 'workspace',
      entityId: ws,
      // The worker pushes a strong one to the person who found it, when it's fresh.
      payload: { postId: post.id, check, strong, userId: post.userId },
    });
    return { postId: post.id, check, strong };
  },
});

export const postSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.post.skip',
  description:
    'Put a group post aside: it comes off the person’s list for today and isn’t suggested again.',
  risk: 0,
  input: PostSkipInput,
  output: PostSkipOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_skip_post',
    keywords: ['put a post aside', 'skip post'],
  },
  scope: inWorkspace,
  // It reaches nobody, so Not for me pressed on the phone with no signal waits as long as it takes (decision 44).
  offline: 'anytime',
  emits: ['outreach.post.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [post] = await ctx.tx
      .update(posts)
      .set({ skippedAt: at })
      .where(and(eq(posts.workspaceId, ws), eq(posts.id, input.postId), eq(posts.userId, me)))
      .returning({ id: posts.id });
    if (!post) throw HfosError.notFound('That post isn’t on your list anymore. Reload Today.');
    await ctx.emit({
      type: 'outreach.post.skipped',
      entityType: 'workspace',
      entityId: ws,
      payload: { postId: post.id },
    });
    return { postId: post.id };
  },
});

/**
 * The words to search a network's posts with (LinkedIn's post search, latest first): the playbooks' own, as an ask for
 * Find posts takes them (`postSearchWords`), the day's in turn. For the extension's runner, which finds posts once a
 * day on its own; on Instagram, with the day's hashtags and the area's places (`postLooks`).
 */
export const postWords = defineAddonQuery(outreachAddon, {
  name: 'outreach.posts.words',
  description:
    'The words the person’s computer searches a network’s posts with today, from the playbooks in use: their own phrases for the network’s post search first, a few a day in turn, else the quoted words in their signs, then their words for groups. With them, the hashtags a day’s look on Instagram opens (the playbooks’ own first, else ones made from their area and words), and the playbooks’ places, to tell a post tagged in the area.',
  input: PostWordsInput,
  output: PostWordsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_post_search_words',
    keywords: ['words posts are searched with'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const playbooks = await playbooksInUse(ctx, input.platform);
    // Each day the next in turn, by the day's number; a search again later in the day the next after (decision 126).
    const day = dayNumber() + input.round;
    return {
      words: postSearchWords(playbooks, input.platform, day),
      // Where its runner looks at hashtags (Instagram's).
      ...(NETWORKS[input.platform].hashtags
        ? postLooks(playbooks, input.platform, day)
        : { tags: [], places: [] }),
    };
  },
});

export const postCommands = [postsSave, postCheck, postSkip] as const;
export const postQueries = [postWords] as const;
