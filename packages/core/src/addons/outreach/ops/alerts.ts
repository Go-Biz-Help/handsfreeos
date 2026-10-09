/**
 * Replies the extension saw (../alerts.ts, docs/outreach.md decision 22): a chat on the person's Facebook whose last
 * message is theirs, after a message of the person's it noted. Each is kept once per message of the person's it
 * answers, so seeing the chat again is no news, and the worker pushes the new ones to the person's phone
 * (`outreach.reply.seen`). An old chat, with nothing of the person's noted, is never a reply.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import { RepliesNoteInput, RepliesNoteOutput } from '../alerts';
import { outreachAddon } from '../manifest';
import { replies } from '../tables';
import { inWorkspace, profilesFor } from './common';

/** How long after the person's message a chat still showing theirs last isn't counted as an answer. */
const CATCH_UP_MS = 30_000;

export const repliesNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.replies.note',
  description:
    'The extension saw chats on the person’s Facebook whose last message is theirs: each one after a message of the person’s it noted is kept as a reply, once, and their phone told unless they were looking at it.',
  risk: 0,
  input: RepliesNoteInput,
  output: RepliesNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.reply.seen'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const found: { profileId: string; name: string }[] = [];
    const done = new Set<string>();
    for (const seen of input.seen) {
      const ids = seen.profile
        ? (await profilesFor(ctx, 'facebook', seen.profile)).map((p) => p.id)
        : [];
      if (!ids.length && !seen.threadKey) continue;
      const byProfile = ids.length
        ? sql`t.profile_id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
      const byThread = seen.threadKey ? sql`t.thread_key = ${seen.threadKey}` : sql`false`;
      // The person's last message to them, as the extension noted it: what this reply answers.
      const [last] = await rows<{ profile_id: string; last_at: Date | string; name: string }>(
        ctx.tx,
        sql`select t.profile_id, max(t.at) as last_at, p.name
            from addon_outreach.touches t join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.kind = 'message'
              and (${byProfile} or ${byThread})
            group by t.profile_id, p.name
            order by max(t.at) desc limit 1`,
      );
      if (!last || done.has(last.profile_id)) continue;
      const afterAt = new Date(last.last_at);
      // Seen as the person's message was noted, or before: the chat can't be showing an answer to it yet, and
      // Messenger's list takes a moment to catch up with what was sent.
      if (afterAt.getTime() > at.getTime() - CATCH_UP_MS) continue;
      done.add(last.profile_id);
      const [row] = await ctx.tx
        .insert(replies)
        .values({
          workspaceId: ws,
          userId: me,
          profileId: last.profile_id,
          threadKey: seen.threadKey,
          afterAt,
          seenAt: at,
          pushed: !input.looking,
        })
        .onConflictDoNothing()
        .returning({ id: replies.id });
      if (row) found.push({ profileId: last.profile_id, name: last.name });
    }
    if (found.length)
      await ctx.emit({
        type: 'outreach.reply.seen',
        entityType: 'workspace',
        entityId: ws,
        payload: { userId: me, profileIds: found.map((f) => f.profileId), push: !input.looking },
      });
    return { replies: found };
  },
});

export const alertCommands = [repliesNote] as const;
