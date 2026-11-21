/**
 * `outreach.comment_replies.save` (docs/outreach.md decision 163, answer 8a; ../comment-replies.ts): replies to the
 * person's comments on Threads and X, as each hourly look read them in their notifications. Each new one is kept as a
 * post of its own (`found: 'reply'`), good to answer with no AI check, so Today drafts an answer as it drafts a comment
 * and the answer waits for an OK on Needs you (`outreach.send.queue`). A reply that says yes to a demo pushes to the
 * person's phone (`outreach.comment.replied`, the worker's `commentReplied`).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import {
  CommentRepliesSaveInput,
  CommentRepliesSaveOutput,
  REPLY_WHY,
  saysYesToDemo,
} from '../comment-replies';
import { outreachAddon } from '../manifest';
import { posts, touches } from '../tables';
import { inWorkspace, keptProfile, once } from './common';

export const commentRepliesSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.comment_replies.save',
  description:
    'Keep the replies to the person’s comments on Threads or X that their computer read in their notifications: each new one from someone they commented to, or shown answering one of their comments, waits on Today for an answer the AI drafts, which waits for their OK. A reply that says yes to a demo pushes to their phone. Nobody goes in Contacts.',
  risk: 1,
  input: CommentRepliesSaveInput,
  output: CommentRepliesSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.comment.replied'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const urls = [...new Set(input.replies.map((r) => r.url))];
      const had = new Set(
        (
          await ctx.tx
            .select({ url: posts.url })
            .from(posts)
            .where(and(eq(posts.workspaceId, ws), eq(posts.userId, me), inArray(posts.url, urls)))
        ).map((r) => r.url),
      );
      let kept = 0;
      for (const reply of input.replies) {
        if (had.has(reply.url)) continue;
        had.add(reply.url);
        const author = await keptProfile(
          ctx,
          { platform: input.platform, profile: reply.author, name: reply.name },
          me,
          at,
        );
        // The person's latest comment to them: what the reply likely answers, and whether it offered a demo.
        const [comment] = await ctx.tx
          .select({ text: touches.commentText })
          .from(touches)
          .where(
            and(
              eq(touches.workspaceId, ws),
              eq(touches.userId, me),
              eq(touches.profileId, author.id),
              eq(touches.kind, 'comment'),
            ),
          )
          .orderBy(desc(touches.at))
          .limit(1);
        // Only a reply to one of their comments: shown so, or from someone they commented to.
        if (!reply.toComment && !comment) continue;
        const [row] = await ctx.tx
          .insert(posts)
          .values({
            workspaceId: ws,
            userId: me,
            groupId: null,
            profileId: author.id,
            url: reply.url,
            posted: reply.when,
            body: reply.text,
            reasons: [REPLY_WHY],
            found: 'reply',
            checkState: 'good',
            checkWhy: REPLY_WHY,
            checkedAt: at,
            seenAt: at,
          })
          .onConflictDoNothing()
          .returning({ id: posts.id });
        if (!row) continue;
        kept++;
        await ctx.emit({
          type: 'outreach.comment.replied',
          entityType: 'outreach_profile',
          entityId: author.id,
          payload: {
            postId: row.id,
            platform: input.platform,
            yes: saysYesToDemo(reply.text, comment?.text ?? null),
          },
        });
      }
      return { kept };
    });
  },
});

export const commentReplyCommands = [commentRepliesSave] as const;
