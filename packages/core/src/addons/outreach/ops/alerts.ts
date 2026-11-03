/**
 * Replies the extension saw (../alerts.ts, docs/outreach.md decision 22): a chat on the person's Facebook whose last
 * message is theirs, after a message of the person's it noted. Each is kept once per message of the person's it
 * answers, so seeing the chat again is no news, and the worker pushes the new ones to the person's phone
 * (`outreach.reply.seen`). An old chat, with nothing of the person's noted, is never a reply. A chat seen by its name
 * alone (a row of Instagram's or LinkedIn's list, which link to no chat) is theirs only when one person the person
 * messaged on that network goes by that name, and it's kept with the chat the person's message went in.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import { RepliesNoteInput, RepliesNoteOutput } from '../alerts';
import { nameKey } from '../download';
import { outreachAddon } from '../manifest';
import { replies } from '../tables';
import { contactable, inWorkspace, nameKeyOf, profilesFor } from './common';

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
        ? (await profilesFor(ctx, input.platform, seen.profile)).map((p) => p.id)
        : [];
      if (!ids.length && !seen.threadKey && seen.profile) continue;
      const byProfile = ids.length
        ? sql`t.profile_id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
      const byThread = seen.threadKey ? sql`t.thread_key = ${seen.threadKey}` : sql`false`;
      // Seen by its name alone: their name, their username, or the name their chat goes by here.
      const nameOnly = !seen.threadKey && !seen.profile;
      const key = nameKey(seen.name);
      const byName = nameOnly
        ? sql`(${nameKeyOf('p')} = ${key} or lower(p.username) = ${key}
            or exists (select 1 from addon_outreach.file_chats c
              where c.workspace_id = ${ws} and c.user_id = ${me} and c.platform = ${input.platform}
                and c.profile_id = p.id and c.name_key = ${key}))`
        : sql`false`;
      // The person's last message to them, as the extension noted it: what this reply answers, and the chat it went in.
      const matches = await rows<{
        profile_id: string;
        last_at: Date | string;
        name: string;
        thread_key: string | null;
      }>(
        ctx.tx,
        sql`select t.profile_id, max(t.at) as last_at, p.name,
              (array_agg(t.thread_key order by t.at desc) filter (where t.thread_key is not null))[1] as thread_key
            from addon_outreach.touches t join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.kind = 'message'
              and p.platform = ${input.platform} and (${byProfile} or ${byThread} or ${byName})
              and ${contactable('p')}
            group by t.profile_id, p.name
            order by max(t.at) desc limit 2`,
      );
      // Two people the person messaged by the one name: neither is known to be the one who wrote.
      if (nameOnly && matches.length > 1) continue;
      const [last] = matches;
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
          threadKey: seen.threadKey ?? last.thread_key,
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
