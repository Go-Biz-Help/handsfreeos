/**
 * Replies the extension saw (../alerts.ts, docs/outreach.md decisions 22 and 150): a chat on one of the person's
 * networks whose last message is theirs, after a step of the person's that starts a conversation (`REPLY_STARTS`: a
 * message, a friend or connection request, a comment). Each is kept once per step of the person's it answers, so seeing
 * the chat again is no news, and the worker pushes the new ones to the person's phone (`outreach.reply.seen`). A newer
 * message of theirs is news too (decision 150): the extension says when a chat's last line changed on the computer,
 * and a chat read says when they wrote; it's kept again, at most once every `NEWER_QUIET_MS`, and a draft for them
 * still waiting for an OK goes, so the next look writes it again from the chat as it is. An old chat, with nothing of
 * the person's noted, is never a reply.
 *
 * Who a chat is with: their profile, or the chat's number as the person's step or a chat read kept it. When neither
 * says (a row of Instagram's or LinkedIn's list, which link to no chat, or a Facebook chat whose number HandsFreeOS
 * never saw), it's theirs only when one person the person reached on that network goes by that name, and it's kept
 * with the chat the person's step went in.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import {
  NEWER_QUIET_MS,
  REPLY_STARTS,
  RepliesNoteInput,
  RepliesNoteOutput,
  type ReplySeen,
} from '../alerts';
import { DRAFTS_THE_CHAT_MOVES } from '../chat-collect';
import { nameKey } from '../download';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import { replies, sends } from '../tables';
import { contactable, inWorkspace, nameKeyOf, profilesFor } from './common';

/** How long after the person's step a chat still showing theirs last isn't counted as an answer. */
const CATCH_UP_MS = 30_000;
/** Some networks show only the minute a message was written: a chat read's times are a minute either way. */
const MINUTE = 60_000;

const starts = sql.join(
  REPLY_STARTS.map((kind) => sql`${kind}`),
  sql`, `,
);

/** Whether the person `me` took a step that starts a conversation with profile `p` (`REPLY_STARTS`). */
const startedWith = (me: string, p: string) => sql`exists (select 1 from addon_outreach.touches t
  where t.profile_id = ${sql.raw(p)}.id and t.user_id = ${me} and t.kind in (${starts}))`;

/**
 * What came of someone writing: kept as a new reply (`kept`, their phone buzzed unless the person was looking), or a
 * newer message inside the quiet time whose waiting draft went (`redraft`, no buzz); null when it's no news.
 */
export type ReplyKept = 'kept' | 'redraft';

/**
 * The drafts for someone written before they wrote (decision 134's `DRAFTS_THE_CHAT_MOVES`): each still waiting for
 * an OK goes, so the next look writes it again from the chat as it is now. Whether any went.
 */
async function dropWaiting(ctx: CommandContext, me: string, profileId: string): Promise<boolean> {
  const gone = await ctx.tx
    .delete(sends)
    .where(
      and(
        eq(sends.workspaceId, ctx.scope.workspaceId!),
        eq(sends.userId, me),
        eq(sends.profileId, profileId),
        eq(sends.state, 'waiting'),
        inArray(sends.kind, [...DRAFTS_THE_CHAT_MOVES]),
      ),
    )
    .returning({ id: sends.id });
  return gone.length > 0;
}

/**
 * Keeps that someone the person reached wrote (decisions 22 and 150): once for each step of the person's it answers,
 * and once more for a newer message of theirs, at most once every `NEWER_QUIET_MS`. `theirsAt` is when a chat read
 * says they wrote; a sighting has none (it's now). Never a chat whose last message of theirs came before the person's
 * step. A draft for them still waiting for an OK goes, written before they wrote.
 */
export async function keepReply(
  ctx: CommandContext,
  o: {
    readonly me: string;
    readonly profileId: string;
    readonly threadKey: string | null;
    readonly theirsAt: Date | null;
    readonly newer: boolean;
    readonly looking: boolean;
  },
): Promise<ReplyKept | null> {
  const ws = ctx.scope.workspaceId!;
  const at = changeMoment(ctx.meta);
  // The person's last step that starts a conversation: what this answers, and the chat it went in.
  const [last] = await rows<{
    at: Date | string;
    kind: string;
    thread_key: string | null;
  }>(
    ctx.tx,
    sql`select t.at, t.kind,
          (select k.thread_key from addon_outreach.touches k
            where k.profile_id = t.profile_id and k.user_id = t.user_id and k.thread_key is not null
            order by k.at desc limit 1) as thread_key
        from addon_outreach.touches t
        where t.workspace_id = ${ws} and t.user_id = ${o.me} and t.profile_id = ${o.profileId}
          and t.kind in (${starts})
        order by t.at desc limit 1`,
  );
  if (!last) return null;
  const ours = new Date(last.at);
  // Seen as the person's step was noted, or before: the chat can't be showing an answer to it yet, and Messenger's
  // list takes a moment to catch up with what was sent.
  if (ours.getTime() > at.getTime() - CATCH_UP_MS) return null;
  // A chat read says when they wrote: before the person's step, it answers nothing of it.
  if (o.theirsAt && o.theirsAt.getTime() <= ours.getTime() - MINUTE) return null;
  // After a request or a comment, the chat may hold an older message of theirs, last: read before, it says so.
  if (!o.theirsAt && !o.newer && last.kind !== 'message') {
    const [chat] = await rows<{ last_from_me: boolean; last_at: Date | string }>(
      ctx.tx,
      sql`select last_from_me, last_at from addon_outreach.file_chats
          where workspace_id = ${ws} and user_id = ${o.me} and profile_id = ${o.profileId}
          order by last_at desc limit 1`,
    );
    if (chat && !chat.last_from_me && new Date(chat.last_at).getTime() <= ours.getTime() - MINUTE)
      return null;
  }
  const [latest] = await rows<{ after_at: Date | string; seen_at: Date | string }>(
    ctx.tx,
    sql`select after_at, seen_at from addon_outreach.replies
        where workspace_id = ${ws} and user_id = ${o.me} and profile_id = ${o.profileId}
        order by seen_at desc limit 1`,
  );
  let afterAt = ours;
  if (latest && new Date(latest.after_at).getTime() >= ours.getTime()) {
    // They wrote back to this step already: only a newer message of theirs is news.
    const seenAt = new Date(latest.seen_at);
    const newer = o.newer || (o.theirsAt !== null && o.theirsAt.getTime() > seenAt.getTime());
    if (!newer) return null;
    // Inside the quiet time: no buzz, but a draft written before it goes, to be written again.
    if (at.getTime() - seenAt.getTime() < NEWER_QUIET_MS)
      return (await dropWaiting(ctx, o.me, o.profileId)) ? 'redraft' : null;
    afterAt = seenAt;
  }
  const [row] = await ctx.tx
    .insert(replies)
    .values({
      workspaceId: ws,
      userId: o.me,
      profileId: o.profileId,
      threadKey: o.threadKey ?? last.thread_key,
      afterAt,
      seenAt: at,
      pushed: !o.looking,
    })
    .onConflictDoNothing()
    .returning({ id: replies.id });
  if (!row) return null;
  await dropWaiting(ctx, o.me, o.profileId);
  return 'kept';
}

/** Tells the person's phone who wrote back (`outreach.reply.seen`): those kept as new, unless they were looking. */
export async function tellReplies(
  ctx: CommandContext,
  me: string,
  profileIds: readonly string[],
  push: boolean,
): Promise<void> {
  if (!profileIds.length) return;
  await ctx.emit({
    type: 'outreach.reply.seen',
    entityType: 'workspace',
    entityId: ctx.scope.workspaceId!,
    payload: { userId: me, profileIds: [...profileIds], push },
  });
}

/**
 * Who a chat seen is with, among those the person reached on the network: by their profile, or the chat's number as
 * the person's step or a chat read kept it; else by its name, when exactly one of them goes by it. A profile or a
 * number that's someone else's here is never anyone by name.
 */
async function whoWrote(
  ctx: CommandContext,
  me: string,
  platform: Platform,
  seen: ReplySeen,
): Promise<{ id: string; name: string } | null> {
  const ws = ctx.scope.workspaceId!;
  const threadKey = seen.threadKey ?? null;
  const ids = seen.profile ? (await profilesFor(ctx, platform, seen.profile)).map((p) => p.id) : [];
  const pick = (by: SQL) =>
    rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select p.id, p.name from addon_outreach.profiles p
          where p.workspace_id = ${ws} and p.platform = ${platform} and ${by}
            and ${contactable('p')} and ${startedWith(me, 'p')}
          order by (select max(t.at) from addon_outreach.touches t
            where t.profile_id = p.id and t.user_id = ${me} and t.kind in (${starts})) desc, p.id
          limit 2`,
    );
  const exact: SQL[] = [
    ...(ids.length
      ? [
          sql`p.id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ]
      : []),
    ...(threadKey
      ? [
          sql`(exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.thread_key = ${threadKey})
              or exists (select 1 from addon_outreach.file_chats c
                where c.workspace_id = ${ws} and c.user_id = ${me} and c.platform = ${platform}
                  and c.profile_id = p.id and c.thread_key = ${threadKey}))`,
        ]
      : []),
  ];
  if (exact.length) {
    const [hit] = await pick(sql`(${sql.join(exact, sql` or `)})`);
    if (hit) return hit;
  }
  // Their profile is kept here as someone the person didn't reach: not anyone else by name.
  if (ids.length) return null;
  if (threadKey) {
    const [elses] = await rows<{ one: number }>(
      ctx.tx,
      sql`select 1 as one from addon_outreach.file_chats c
          where c.workspace_id = ${ws} and c.user_id = ${me} and c.platform = ${platform}
            and c.thread_key = ${threadKey} and c.profile_id is not null
          limit 1`,
    );
    if (elses) return null;
  }
  // By its name alone: their name, their username, or the name their chat goes by here.
  const key = nameKey(seen.name);
  const named = await pick(
    sql`(${nameKeyOf('p')} = ${key} or lower(p.username) = ${key}
      or exists (select 1 from addon_outreach.file_chats c
        where c.workspace_id = ${ws} and c.user_id = ${me} and c.platform = ${platform}
          and c.profile_id = p.id and c.name_key = ${key}))`,
  );
  // Two people the person reached by the one name: neither is known to be the one who wrote.
  return named.length === 1 ? named[0]! : null;
}

export const repliesNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.replies.note',
  description:
    'The extension saw chats on one of the person’s networks whose last message is theirs: each one after a message, request or comment of the person’s it noted is kept as a reply, once, and once more for a newer message of theirs, and their phone told unless they were looking at it.',
  risk: 0,
  input: RepliesNoteInput,
  output: RepliesNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.reply.seen'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const found: { profileId: string; name: string }[] = [];
    const told: string[] = [];
    const done = new Set<string>();
    for (const seen of input.seen) {
      const who = await whoWrote(ctx, me, input.platform, seen);
      if (!who || done.has(who.id)) continue;
      done.add(who.id);
      const kept = await keepReply(ctx, {
        me,
        profileId: who.id,
        threadKey: seen.threadKey ?? null,
        theirsAt: null,
        newer: seen.newer ?? false,
        looking: input.looking,
      });
      if (!kept) continue;
      found.push({ profileId: who.id, name: who.name });
      if (kept === 'kept') told.push(who.id);
    }
    await tellReplies(ctx, me, told, !input.looking);
    return { replies: found };
  },
});

export const alertCommands = [repliesNote] as const;
