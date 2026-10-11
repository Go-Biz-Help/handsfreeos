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
import { defineAddonCommand } from '../../server';
import { outreachAddon } from '../manifest';
import {
  PostCheckInput,
  PostCheckOutput,
  postLook,
  type PostCheck,
  type PostMark,
  PostSkipInput,
  PostSkipOutput,
  PostsSaveInput,
  PostsSaveOutput,
} from '../posts';
import { posts, touches } from '../tables';
import { keepGroup } from './activity';
import { inWorkspace, keptProfile, once } from './common';
import { playbooksInUse } from './friends';

export const postsSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.posts.save',
  description:
    'Keep the posts in a Facebook group’s feed that are worth a comment from the person: those saying a playbook’s signs or asking for help, with who wrote them, for the AI to check. Says how each post the page shows stands, for the extension to mark. Nobody goes in Contacts.',
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
      const groupId = await keepGroup(ctx, input.platform, input.group);
      const playbooks = await playbooksInUse(ctx);
      const urls = [...new Set(input.posts.map((p) => p.url))];
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
        const look = postLook(playbooks, p.text);
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
          payload: { groupId, posts: input.posts.length, checking, found: input.found },
        });
      return { groupId, posts: marks, checking };
    });
  },
});

export const postCheck = defineAddonCommand(outreachAddon, {
  name: 'outreach.post.check',
  description:
    'Worker: what the AI made of a group post kept as worth a look: good for the person to comment on, or not, with why; or that it couldn’t be read.',
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
    if (post.checkState !== 'waiting') return { postId: post.id, check: post.checkState };
    const check: PostCheck = input.check ? (input.check.good ? 'good' : 'not') : 'failed';
    await ctx.tx
      .update(posts)
      .set({ checkState: check, checkWhy: input.check?.why ?? null, checkedAt: at })
      .where(eq(posts.id, post.id));
    await ctx.emit({
      type: 'outreach.post.checked',
      entityType: 'workspace',
      entityId: ws,
      payload: { postId: post.id, check },
    });
    return { postId: post.id, check };
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

export const postCommands = [postsSave, postCheck, postSkip] as const;
