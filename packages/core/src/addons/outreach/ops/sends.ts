/**
 * Messages the extension sends on its own (../sends.ts, docs/outreach.md decisions 26 and 27): each drafted one waits
 * for the person's OK or goes as it is, and the extension says when it went. Each person's are their own.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { FRESH_MINUTES } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import type { DraftOpener } from '../openers';
import {
  changed,
  goesAsItIs,
  handedOver,
  replyNeedsYou,
  SendApproveInput,
  SendApproveOutput,
  SendDoneInput,
  SendDoneOutput,
  SendQueueInput,
  SendQueueOutput,
  SENDS_MOST,
  SendSkipInput,
  SendSkipOutput,
  SendsInput,
  SendsOutput,
  type RecentMessage,
  type Send,
} from '../sends';
import { PARTNER_WORDS } from '../partners';
import { fileChats, openerUses, playbooks, profiles, sends } from '../tables';
import { isPartnerKind } from '../today';
import { automationOf, countWheels } from './automation';
import { noteSent, offerVersionFor } from './conversation';
import { chatKey, contactable, inWorkspace, recentOf, type ChatRef, type Ctx } from './common';
import { openNeed } from './needs';
import { notePartnerSent } from './partners';
import { notePitched } from './stages';

type Row = typeof sends.$inferSelect;

const gone = () =>
  HfosError.notFound(
    'That message isn’t waiting any more: it was sent, skipped, or the person was removed. Refresh your list for today.',
  );

/** The person's sends, with who each is to, the oldest first. */
export async function listed(ctx: Ctx, where: ReturnType<typeof and>): Promise<Send[]> {
  const found = await ctx.tx
    .select({ s: sends, name: profiles.name, url: profiles.url })
    .from(sends)
    .innerJoin(profiles, eq(profiles.id, sends.profileId))
    .where(where)
    .orderBy(sends.createdAt)
    .limit(SENDS_MOST);
  // Each one's chat, where it's going (the person's own: sends are only ever listed for whose they are).
  const recent = new Map<string, RecentMessage[]>();
  for (const userId of new Set(found.map(({ s }) => s.userId)))
    for (const [key, messages] of await recentOf(
      ctx,
      userId,
      found.filter(({ s }) => s.userId === userId).map(({ s }) => refOf(s)),
    ))
      recent.set(`${userId}/${key}`, messages);
  return found.map(({ s, name, url }) => ({
    sendId: s.id,
    kind: s.kind,
    profileId: s.profileId,
    name,
    profileUrl: url,
    chatId: s.chatId,
    threadKey: s.threadKey,
    text: s.text,
    state: s.state,
    why: s.why,
    opener: s.opener,
    handedOver: s.handedOver,
    needsYou: s.needsYou,
    createdAt: s.createdAt.toISOString(),
    recent: recent.get(`${s.userId}/${chatKey(refOf(s))}`) ?? [],
  }));
}

const refOf = (s: { chatId: string | null; profileId: string }): ChatRef => ({
  chatId: s.chatId,
  profileId: s.profileId,
});

export const mine = (ctx: Ctx, me: string) =>
  and(eq(sends.workspaceId, ctx.scope.workspaceId!), eq(sends.userId, me));

export const sendQueue = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.queue',
  description:
    'The extension drafted a message to someone on the person’s list for today: a first message, a follow-up or a reply. It waits for the person’s OK, or, when they chose for messages to go on their own and their training wheels are off, goes as it is. A message already drafted for them comes back instead.',
  risk: 0,
  input: SendQueueInput,
  output: SendQueueOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.send.queued'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const open = () =>
      listed(
        ctx,
        and(
          mine(ctx, me),
          eq(sends.profileId, input.profileId),
          eq(sends.kind, input.kind),
          inArray(sends.state, ['waiting', 'approved']),
        ),
      );
    const [had] = await open();
    if (had) return had;
    const [profile] = await rows<{ id: string; name: string; platform: Platform; off: boolean }>(
      ctx.tx,
      sql`select p.id, p.name, p.platform, not ${contactable('p')} as off from addon_outreach.profiles p
          where p.workspace_id = ${ws} and p.id = ${input.profileId}`,
    );
    if (!profile)
      throw HfosError.notFound(
        'That person isn’t kept in Social Outreach any more. Refresh your list for today.',
      );
    // Never contact: nothing goes to them, not even a reply.
    if (profile.off)
      throw HfosError.rule(
        'outreach_never_contact',
        422,
        `${profile.name} is on the Never contact list, so no message goes to them. To write to them, take them off it in Social Outreach → People → Friends.`,
      );
    const [chat] = input.chatId
      ? await ctx.tx
          .select({ id: fileChats.id, userId: fileChats.userId, recent: fileChats.recent })
          .from(fileChats)
          .where(and(eq(fileChats.workspaceId, ws), eq(fileChats.id, input.chatId)))
      : [];
    // The person's choices and training wheels on the network the message goes on: each network's are its own.
    const { choices: settings, wheels } = await automationOf(ctx, me, Date.now(), profile.platform);
    const at = changeMoment(ctx.meta);
    // A reply goes on its own only to what HandsFreeOS saw them write, and never to someone who needs the person.
    const theirs =
      chat?.userId === me
        ? ([...chat.recent].reverse().find((m) => !m.fromMe)?.text ?? null)
        : null;
    const partner = isPartnerKind(input.kind);
    // A partner's message waits for an OK of its own, never Approve all (decision 81).
    const needsYou = partner
      ? PARTNER_WORDS.needsYou
      : input.kind !== 'reply'
        ? null
        : theirs === null
          ? 'HandsFreeOS hasn’t seen what they wrote'
          : replyNeedsYou(theirs);
    const goes = goesAsItIs({
      sending: settings.sending,
      replies: settings.replies,
      wheels: wheels.on,
      kind: input.kind,
      simple: input.simple,
      needsYou,
    });
    const handOver = handedOver({
      sending: settings.sending,
      replies: settings.replies,
      wheels: wheels.on,
      kind: input.kind,
      goes,
    });
    // Two drafts for them at once: the second finds the first.
    const [made] = await ctx.tx
      .insert(sends)
      .values({
        workspaceId: ws,
        userId: me,
        profileId: profile.id,
        kind: input.kind,
        chatId: chat?.id ?? null,
        threadKey: input.threadKey,
        text: input.text,
        drafted: input.text,
        opener: input.kind === 'opener' ? input.opener : null,
        state: goes ? 'approved' : 'waiting',
        approvedAt: goes ? at : null,
        // Waits for an OK of its own (Waiting for you): handed over, or to someone who needs the person.
        handedOver: handOver,
        needsYou,
        // The main offer's version it goes with: the one they were first pitched with, or the live one.
        offerVersion:
          input.kind === 'reconnect' || partner ? null : await offerVersionFor(ctx, me, profile.id),
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: sends.id });
    if (made)
      await ctx.emit({
        type: 'outreach.send.queued',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: {
          kind: input.kind,
          waits: !goes,
          // Whose it is: their phone hears it waits as their pushes say (the worker's waiting.ts).
          userId: me,
          // A reply the person counted on going: their phone hears why it came to them at once (the worker's alerts).
          ...(handOver ? { handOver: true, why: needsYou } : {}),
        },
      });
    const [now] = await open();
    if (!now) throw gone();
    return now;
  },
});

export const sendApprove = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.approve',
  description:
    'The person OKs messages the extension drafted, as they are or changed; with none named, every one waiting (Approve all) except replies handed over to them and messages to someone who needs them, which wait to be OK’d one at a time. The extension sends them. On training wheels, each counts toward coming off them.',
  risk: 1,
  input: SendApproveInput,
  output: SendApproveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // It reaches a prospect: an OK that waited on the phone goes by itself for 30 minutes, and asks "Still send?" after
  // (decision 44). The contract may grow it to `anytime` one day, never back.
  offline: { freshMinutes: FRESH_MINUTES },
  emits: ['outreach.send.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const named = input.sends ? new Map(input.sends.map((s) => [s.sendId, s.text])) : null;
    if (named && !named.size) throw gone();
    // A reply handed over, or a message to someone who needs the person, waits for an OK of its own (`oneByOne`,
    // decisions 27 and 42): only one named alone, without `partial`, is OK'd. Approve all, named (the phone's, any
    // build) or not, passes over them, so no client can OK them in bulk.
    const alone = named?.size === 1 && !input.partial;
    const waiting: Row[] = await ctx.tx
      .select()
      .from(sends)
      .where(
        and(
          mine(ctx, me),
          eq(sends.state, 'waiting'),
          ...(named ? [inArray(sends.id, [...named.keys()])] : []),
          ...(alone ? [] : [eq(sends.handedOver, false), isNull(sends.needsYou)]),
        ),
      )
      .orderBy(sends.createdAt)
      .limit(SENDS_MOST);
    // The phone's Approve all names what it showed: those handled elsewhere since are passed over (`partial`).
    if (named && waiting.length < named.size && !input.partial) {
      const [oneOfTheirOwn] = await ctx.tx
        .select({ id: sends.id })
        .from(sends)
        .where(
          and(
            mine(ctx, me),
            eq(sends.state, 'waiting'),
            inArray(sends.id, [...named.keys()]),
            or(eq(sends.handedOver, true), isNotNull(sends.needsYou)),
          ),
        )
        .limit(1);
      if (oneOfTheirOwn)
        throw HfosError.rule(
          'outreach_send_one_by_one',
          409,
          'A reply handed over to you, or a message to someone who needs you, waits for an OK of its own. OK each one on its own, under Needs you on Today.',
        );
      throw gone();
    }
    const at = changeMoment(ctx.meta);
    const edits: boolean[] = [];
    for (const s of waiting) {
      const text = named?.get(s.id) ?? s.text;
      edits.push(changed(s.drafted, text));
      await ctx.tx
        .update(sends)
        .set({ text, state: 'approved', approvedAt: at, updatedAt: at })
        .where(eq(sends.id, s.id));
      await ctx.emit({
        type: 'outreach.send.approved',
        entityType: 'outreach_profile',
        entityId: s.profileId,
        payload: { kind: s.kind, changed: edits[edits.length - 1] },
      });
    }
    // Each network's training wheels count its own messages OK'd.
    const platforms = waiting.length
      ? await ctx.tx
          .select({ id: profiles.id, platform: profiles.platform })
          .from(profiles)
          .where(inArray(profiles.id, [...new Set(waiting.map((s) => s.profileId))]))
      : [];
    const platformOf = new Map(platforms.map((p) => [p.id, p.platform]));
    const byNetwork = new Map<Platform, boolean[]>();
    waiting.forEach((s, i) => {
      const platform = platformOf.get(s.profileId) ?? 'facebook';
      byNetwork.set(platform, [...(byNetwork.get(platform) ?? []), edits[i]!]);
    });
    let wheels = null;
    for (const [platform, changes] of byNetwork) {
      const state = await countWheels(ctx, me, changes, platform);
      if (!wheels || platform === 'facebook') wheels = state;
    }
    return {
      approved: waiting.map((s) => s.id),
      wheels: wheels ?? (await countWheels(ctx, me, [])),
    };
  },
});

export const sendSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.skip',
  description:
    'The person skips a message the extension drafted: it isn’t sent, and the person is off their list for today.',
  risk: 0,
  input: SendSkipInput,
  output: SendSkipOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // It reaches nobody, so a skip made on the phone with no signal waits as long as it takes (decision 44).
  offline: 'anytime',
  emits: ['outreach.send.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    // The newer press wins: a skip that waited never undoes an OK given after it was pressed.
    const [okd] = await ctx.tx
      .select({ approvedAt: sends.approvedAt })
      .from(sends)
      .where(and(mine(ctx, me), eq(sends.id, input.sendId), eq(sends.state, 'approved')));
    if (okd?.approvedAt && okd.approvedAt > at)
      throw HfosError.rule(
        'outreach_send_okd_since',
        409,
        'You OK’d that message after you skipped it, so the OK stands and the extension sends it. To hold it, press Stop for today on the Live tab: nothing more goes out until tomorrow.',
      );
    const [row] = await ctx.tx
      .update(sends)
      .set({ state: 'skipped', doneAt: at, updatedAt: at })
      .where(
        and(
          mine(ctx, me),
          eq(sends.id, input.sendId),
          inArray(sends.state, ['waiting', 'approved']),
        ),
      )
      .returning();
    if (!row) throw gone();
    await ctx.emit({
      type: 'outreach.send.skipped',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { kind: row.kind },
    });
    return { sendId: row.id };
  },
});

/** The opener a first message went with (decision 23), for the results card. */
async function noteOpener(ctx: Ctx, me: string, row: Row, opener: DraftOpener) {
  const ws = ctx.scope.workspaceId!;
  const [playbook] = await ctx.tx
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(and(eq(playbooks.workspaceId, ws), eq(playbooks.id, opener.playbookId)));
  if (!playbook) return;
  const use = {
    playbookId: playbook.id,
    kind: opener.kind,
    text: opener.text,
    usedAt: row.approvedAt ?? row.createdAt,
  };
  await ctx.tx
    .insert(openerUses)
    .values({ workspaceId: ws, userId: me, profileId: row.profileId, ...use })
    .onConflictDoUpdate({
      target: [openerUses.workspaceId, openerUses.userId, openerUses.profileId],
      set: use,
    });
}

export const sendDone = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.done',
  description:
    'The extension sent an OK’d message in Messenger, or couldn’t, and why. The message itself is noted as a step, as any other. One that couldn’t go waits for the person in Waiting for you, with its words, to send themselves.',
  risk: 0,
  input: SendDoneInput,
  output: SendDoneOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.send.done', 'outreach.need.noted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const state = input.sent ? ('sent' as const) : ('failed' as const);
    const [row] = await ctx.tx
      .update(sends)
      .set({ state, why: input.sent ? null : input.why, doneAt: at, updatedAt: at })
      .where(and(mine(ctx, me), eq(sends.id, input.sendId), eq(sends.state, 'approved')))
      .returning();
    if (!row) throw gone();
    if (input.sent && row.kind === 'opener' && row.opener)
      await noteOpener(ctx, me, row, row.opener);
    // A pitch that went moves them on to pitched (decision 47).
    if (input.sent && row.kind === 'pitch') await notePitched(ctx, me, row.profileId, at);
    // Where their conversation is now: a step, a follow-up, a check-in or a reply (decisions 65 to 67); a partner's
    // moves them along the Partners list instead (decision 81).
    if (input.sent && isPartnerKind(row.kind))
      await notePartnerSent(ctx, me, { profileId: row.profileId, kind: row.kind, at });
    else if (input.sent)
      await noteSent(ctx, me, {
        profileId: row.profileId,
        kind: row.kind,
        at,
        offerVersion: row.offerVersion,
      });
    // One that didn't go is the person's to send: it waits in Waiting for you with its words.
    if (!input.sent) {
      const [to] = await ctx.tx
        .select({ name: profiles.name, url: profiles.url })
        .from(profiles)
        .where(eq(profiles.id, row.profileId));
      if (to)
        await openNeed(
          ctx,
          me,
          {
            step: 'message',
            profileId: row.profileId,
            sendId: row.id,
            name: to.name,
            url: row.threadKey
              ? `https://www.facebook.com/messages/t/${encodeURIComponent(row.threadKey)}`
              : to.url,
            why: input.why || 'it didn’t go',
          },
          at,
        );
    }
    await ctx.emit({
      type: 'outreach.send.done',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { kind: row.kind, sent: input.sent },
    });
    return { sendId: row.id, state };
  },
});

export const sendsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.sends',
  description:
    'The person’s messages the extension drafted that wait for their OK, and those OK’d it’s about to send; with their training wheels.',
  input: SendsInput,
  output: SendsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has messages of their own to send.');
    const { wheels } = await automationOf(ctx, me);
    return {
      sends: await listed(ctx, and(mine(ctx, me), inArray(sends.state, ['waiting', 'approved']))),
      wheels,
    };
  },
});

/**
 * Today's sends for the list for today (./today.ts): those open, by profile and kind, and the people skipped or not
 * sent to today, who are off the list until tomorrow.
 */
export async function sendsToday(ctx: Ctx, me: string, todayFrom: string) {
  const found = await rows<{
    id: string;
    profile_id: string;
    kind: string;
    state: Send['state'];
    text: string;
    handed_over: boolean;
    needs_you: string | null;
  }>(
    ctx.tx,
    sql`select id, profile_id, kind, state, text, handed_over, needs_you from addon_outreach.sends
        where workspace_id = ${ctx.scope.workspaceId} and user_id = ${me}
          and (state in ('waiting', 'approved')
            or (state in ('skipped', 'failed') and done_at >= ${todayFrom}::timestamptz))`,
  );
  const key = (profileId: string, kind: string) => `${profileId}:${kind}`;
  const open = new Map<
    string,
    {
      sendId: string;
      state: 'waiting' | 'approved';
      text: string;
      handedOver: boolean;
      needsYou: string | null;
    }
  >();
  const off = new Set<string>();
  for (const s of found)
    if (s.state === 'waiting' || s.state === 'approved')
      open.set(key(s.profile_id, s.kind), {
        sendId: s.id,
        state: s.state,
        text: s.text,
        handedOver: s.handed_over,
        needsYou: s.needs_you,
      });
    else off.add(key(s.profile_id, s.kind));
  return {
    open: (profileId: string | null, kind: string) =>
      profileId ? (open.get(key(profileId, kind)) ?? null) : null,
    off: (profileId: string | null, kind: string) =>
      profileId !== null && off.has(key(profileId, kind)) && !open.has(key(profileId, kind)),
  };
}

export const sendCommands = [sendQueue, sendApprove, sendSkip, sendDone] as const;
export const sendQueries = [sendsList] as const;
