/**
 * Asking the extension (../asks.ts, docs/outreach.md decision 43): the person asks their working computer, from
 * HandsFreeOS, to do something only a browser on Facebook can; that computer takes it, says how it's going, hands a
 * step to the person when it can't find it, and says how it ended. Each person's asks are their own: owners and
 * admins don't ask someone else's computer. Add to Contacts on the web is here too, since the panel no longer saves.
 */
import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { RequestMeta } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  ASK_LINE_SECONDS,
  ASK_LOOKUPS_MOST,
  ASK_STOPPED_EARLY_LINE,
  ASK_STOPPED_LINE,
  ASKS_SHOWN_MOST,
  AskCancelInput,
  AskChangedOutput,
  askAbout,
  AskEndInput,
  AskEndOutput,
  AskMakeInput,
  AskMakeOutput,
  AskProgressInput,
  AskProgressOutput,
  askRepliesFor,
  AskReplyInput,
  AsksInput,
  AsksOutput,
  AskTakeInput,
  AskTakeOutput,
  askTarget,
  askWarnedLine,
  groupLink,
  OFF_FACEBOOK_KINDS,
  onFacebook,
  OPEN_ASK_STATES,
  ProfileContactInput,
  TIDY_ASK_KINDS,
  type AskAsked,
  type AskGroup,
  type AskTask,
  type AskVia,
} from '../asks';
import { isOffline } from '../live';
import { outreachAddon } from '../manifest';
import { ProfileSaveOutput } from '../saves';
import { asks, computers, profiles } from '../tables';
import { askShown, endStale, groupsForAsk, shownAsks, takeable, type AskRow } from './ask-rows';
import { inWorkspace, once, saveProfile, type Ctx } from './common';
import { businessToday, dayOf } from './day';
import { myComputers, workingOf } from './live';
import { startOfToday, warningOf } from './tidy';

const viaOf = (meta: RequestMeta): AskVia => (meta.channel === 'mobile' ? 'mobile' : 'web');

/** Whether Facebook warned the person today, and its words: nothing more is done on Facebook till tomorrow. */
async function warnedToday(
  ctx: Ctx,
  me: string,
  now: number,
): Promise<{ words: string | null } | null> {
  // One transaction's queries go one after another anyway.
  const warning = await warningOf(ctx, me, await startOfToday(ctx, now), now);
  if (warning?.today) return { words: warning.words };
  const { today } = await businessToday(ctx, now);
  const day = await dayOf(ctx, me, today);
  return day.why === 'warning' ? { words: warning?.words ?? null } : null;
}

/** The ask, with its computer, as the lists show it. */
async function shownOne(ctx: Ctx, row: AskRow, now: number) {
  const [c] = row.computerId
    ? await ctx.tx
        .select({ name: computers.name, seenAt: computers.lastSeenAt })
        .from(computers)
        .where(eq(computers.id, row.computerId))
    : [];
  return askShown(row, { name: c?.name ?? null, seenAt: c?.seenAt ?? null }, now);
}

/** One of the person's own asks, locked for the change. */
async function ownAsk(ctx: Ctx, me: string, askId: string): Promise<AskRow | undefined> {
  const [row] = await ctx.tx
    .select()
    .from(asks)
    .where(
      and(eq(asks.workspaceId, ctx.scope.workspaceId!), eq(asks.userId, me), eq(asks.id, askId)),
    )
    .for('update');
  return row;
}

const isOpen = (row: AskRow) => (OPEN_ASK_STATES as readonly string[]).includes(row.state);

const groupOf = (g: {
  id: string;
  name: string | null;
  url: string;
  people: number;
  admins_read: boolean;
}): AskGroup => ({
  groupId: g.id,
  name: g.name,
  url: g.url,
  people: g.people,
  adminsRead: g.admins_read,
});

/** What the computer gets, worked out now: the groups' links and counts, who to look up and where. */
async function taskOf(
  ctx: Ctx,
  me: string,
  ask: AskAsked,
): Promise<{ task: AskTask; target: string; about: string | null }> {
  const target = askTarget(ask);
  switch (ask.kind) {
    case 'members':
    case 'posts': {
      if (ask.kind === 'members' && ask.url) {
        const link = groupLink(ask.url);
        if (!link)
          throw HfosError.rule(
            'outreach_ask_not_a_group',
            400,
            'That isn’t a link to a Facebook group. Open the group on Facebook, copy the address from the top of the browser, and paste it here.',
          );
        // A group saved already is that group, whatever link it was pasted with.
        const [saved] = await groupsForAsk(ctx, sql`g.url = ${link}`);
        const group: AskGroup = saved
          ? groupOf(saved)
          : { groupId: null, name: null, url: link, people: 0, adminsRead: false };
        return {
          task: { kind: 'members', groups: [group] },
          target: saved ? `groups:${saved.id}` : target,
          about: askAbout(ask, { groups: [group.name ?? 'the group you pasted'] }),
        };
      }
      if (!ask.groupIds)
        return { task: { kind: ask.kind, groups: null }, target, about: askAbout(ask) };
      const ids = [...new Set(ask.groupIds)];
      const found = await groupsForAsk(ctx, sql`g.id = any (${`{${ids.join(',')}}`}::uuid[])`);
      if (found.length < ids.length)
        throw HfosError.notFound(
          'That group isn’t saved in Social Outreach any more. Refresh the Groups tab.',
        );
      const groups = ids.map((id) => groupOf(found.find((g) => g.id === id)!));
      return {
        task: { kind: ask.kind, groups },
        target,
        about: askAbout(ask, { groups: groups.map((g) => g.name) }),
      };
    }
    case 'lookup': {
      const { draft } = ask;
      const ws = ctx.scope.workspaceId!;
      // Who: the profile, the post's writer, or the one the chat is with.
      // A chat on Today is one of the person's own (`file_chats`), and may have no profile linked: then there's
      // nothing to open, and the drafts come from the chat itself.
      const [who] = await rows<{ url: string | null; name: string }>(
        ctx.tx,
        draft.profileId
          ? sql`select p.url, p.name from addon_outreach.profiles p
                where p.workspace_id = ${ws} and p.id = ${draft.profileId}`
          : draft.postId
            ? sql`select p.url, p.name from addon_outreach.posts po
                  join addon_outreach.profiles p on p.id = po.profile_id
                  where po.workspace_id = ${ws} and po.user_id = ${me} and po.id = ${draft.postId}`
            : sql`select p.url, c.name from addon_outreach.file_chats c
                  left join addon_outreach.profiles p on p.id = c.profile_id
                  where c.workspace_id = ${ws} and c.user_id = ${me} and c.id = ${draft.chatId}`,
      );
      if (!who)
        throw HfosError.notFound(
          'That person isn’t kept in Social Outreach any more. Refresh your list for today.',
        );
      return {
        task: { kind: 'lookup', draft, profileUrl: who.url, name: who.name },
        target,
        about: askAbout(ask, { name: who.name }),
      };
    }
    case 'group_search':
      return { task: { kind: 'group_search', words: ask.words }, target, about: askAbout(ask) };
    case 'cancel':
    case 'unfriend':
      return {
        task: { kind: ask.kind, profileIds: [...new Set(ask.profileIds)] },
        target,
        about: askAbout(ask),
      };
    default:
      return { task: { kind: ask.kind }, target, about: null };
  }
}

export const askMake = defineAddonCommand(outreachAddon, {
  name: 'outreach.ask.make',
  description:
    'The person asks their computer, from HandsFreeOS, to do something on Facebook only the browser extension can: get their Facebook file, check their friend requests, save their friends, groups or a group’s members, find posts, read their chats, cancel or unfriend the people they ticked, or look someone up before drafting. The computer that works for them takes it. Asking again while one like it is open answers that one.',
  risk: 1,
  input: AskMakeInput,
  output: AskMakeOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.ask.made'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const now = at.getTime();
    const ask = input.ask as AskAsked;
    if (!(await myComputers(ctx, me)).length)
      throw HfosError.rule(
        'outreach_no_computer',
        409,
        'No computer has the extension signed in yet, so there’s nothing to do this. Install HandsFreeOS Social in Chrome on your computer and sign in, then ask again.',
      );
    if (onFacebook(ask.kind) && (await warnedToday(ctx, me, now)))
      throw HfosError.rule(
        'outreach_warned_today',
        409,
        'Facebook showed you a warning today, so the extension does nothing more on Facebook until tomorrow. Your daily limits are halved for a week.',
      );
    // Two presses at once (a double-click, or the web and the phone together) make one ask: the second waits for
    // the first and finds it open.
    await ctx.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`outreach.asks:${ws}:${me}`}, 0))`,
    );
    await endStale(ctx, me, at);
    const { task, target, about } = await taskOf(ctx, me, ask);

    // One like it open: that's the one. Cancelling and unfriending are one at a time whoever was ticked.
    const anyTarget = (TIDY_ASK_KINDS as readonly string[]).includes(ask.kind);
    const [open] = await shownAsks(
      ctx,
      me,
      and(
        eq(asks.kind, ask.kind),
        inArray(asks.state, [...OPEN_ASK_STATES]),
        anyTarget ? undefined : eq(asks.target, target),
      ),
      now,
      1,
    );
    if (open) return { ask: open, fresh: false };
    if (ask.kind === 'lookup') {
      const [row] = await ctx.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(asks)
        .where(
          and(
            eq(asks.workspaceId, ws),
            eq(asks.userId, me),
            eq(asks.kind, 'lookup'),
            inArray(asks.state, [...OPEN_ASK_STATES]),
          ),
        );
      if ((row?.n ?? 0) >= ASK_LOOKUPS_MOST)
        throw HfosError.rule(
          'outreach_ask_lookups_full',
          409,
          `Your computer has ${ASK_LOOKUPS_MOST} people to look up already. Wait for those drafts, or press Draft from what HandsFreeOS knows.`,
        );
    }

    const [row] = await ctx.tx
      .insert(asks)
      .values({
        workspaceId: ws,
        userId: me,
        kind: ask.kind,
        target,
        task,
        about,
        via: viaOf(ctx.meta),
        askedAt: at,
      })
      .returning();
    await ctx.emit({
      type: 'outreach.ask.made',
      entityType: 'outreach_ask',
      entityId: row!.id,
      payload: { userId: me, kind: ask.kind },
    });
    return { ask: await shownOne(ctx, row!, now), fresh: true };
  },
});

export const askTake = defineAddonCommand(outreachAddon, {
  name: 'outreach.ask.take',
  description:
    'The browser extension on the person’s computer that works takes the oldest thing they asked of it from HandsFreeOS. A computer standing by takes nothing. On a day Facebook warned them, asks that would open Facebook end instead.',
  risk: 0,
  input: AskTakeInput,
  output: AskTakeOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.ask.started', 'outreach.ask.ended'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const now = at.getTime();
    const all = await myComputers(ctx, me);
    const here = all.find((c) => c.installId === input.installId);
    const mine = and(eq(asks.workspaceId, ws), eq(asks.userId, me));
    const count = async () => {
      const [row] = await ctx.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(asks)
        .where(and(mine, takeable(now)));
      return row?.n ?? 0;
    };
    if (!here || workingOf(all)?.id !== here.id) return { ask: null, waiting: await count() };
    await endStale(ctx, me, at, { computerId: here.id, underway: input.underway });

    // A warning today: what would open Facebook ends now, as the day did.
    const warned = await warnedToday(ctx, me, now);
    if (warned) {
      const ended = await ctx.tx
        .update(asks)
        .set({
          state: 'failed',
          line: askWarnedLine(warned.words),
          endedAt: at,
          updatedAt: new Date(),
        })
        .where(
          and(
            mine,
            takeable(now),
            sql`${asks.kind} not in (${sql.join(
              OFF_FACEBOOK_KINDS.map((k) => sql`${k}`),
              sql`, `,
            )})`,
          ),
        )
        .returning({ id: asks.id, kind: asks.kind });
      for (const e of ended)
        await ctx.emit({
          type: 'outreach.ask.ended',
          entityType: 'outreach_ask',
          entityId: e.id,
          payload: { userId: me, kind: e.kind, state: 'failed' },
        });
    }

    const [next] = await ctx.tx
      .select({ id: asks.id })
      .from(asks)
      .where(and(mine, takeable(now)))
      .orderBy(asc(asks.askedAt), asc(asks.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!next) return { ask: null, waiting: 0 };
    const [row] = await ctx.tx
      .update(asks)
      .set({
        state: 'working',
        computerId: here.id,
        startedAt: at,
        line: null,
        reply: null,
        toldAt: null,
        updatedAt: new Date(),
      })
      .where(eq(asks.id, next.id))
      .returning();
    await ctx.emit({
      type: 'outreach.ask.started',
      entityType: 'outreach_ask',
      entityId: row!.id,
      payload: { userId: me, kind: row!.kind },
    });
    return {
      ask: {
        askId: row!.id,
        kind: row!.kind,
        task: row!.task,
        about: row!.about,
        askedAt: row!.askedAt.toISOString(),
      },
      waiting: await count(),
    };
  },
});

const notAsked = () =>
  HfosError.notFound('That isn’t asked of your computer any more. Refresh the page.');

export const askProgress = defineAddonCommand(outreachAddon, {
  name: 'outreach.ask.progress',
  description:
    'The browser extension says how an ask is going: its line, and whether it needs the person (a step it can’t find, or their password). Answers whether the person stopped it, and their answer to a step handed to them.',
  risk: 0,
  input: AskProgressInput,
  output: AskProgressOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Sent every few seconds while it works, and a repeat does no harm: like the beat, it leaves no receipt.
  receipt: false,
  emits: ['outreach.ask.progressed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await ownAsk(ctx, me, input.askId);
    if (!row) throw notAsked();
    if (!isOpen(row)) return { cancelled: row.state === 'cancelled', reply: null };
    // Only a computer that took it says how it's going.
    if (row.state === 'waiting')
      throw HfosError.rule(
        'outreach_ask_not_taken',
        409,
        'Your computer hasn’t taken that yet, so there’s nothing to say about it. It starts it in a moment.',
      );
    const now = new Date();
    const changed = input.state !== row.state;
    const lineNew = input.line !== (row.line ?? '');
    if (!changed && !lineNew) return { cancelled: false, reply: row.reply };
    const due =
      changed ||
      row.toldAt === null ||
      now.getTime() - row.toldAt.getTime() >= ASK_LINE_SECONDS * 1000;
    // Back to work: the person's answer is taken.
    const reply = input.state === 'working' && changed ? null : row.reply;
    await ctx.tx
      .update(asks)
      .set({
        state: input.state,
        line: input.line || null,
        reply,
        ...(due ? { toldAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(asks.id, row.id));
    if (due)
      await ctx.emit({
        type: 'outreach.ask.progressed',
        entityType: 'outreach_ask',
        entityId: row.id,
        payload: { userId: me, kind: row.kind, state: input.state, changed },
      });
    return { cancelled: false, reply };
  },
});

export const askEnd = defineAddonCommand(outreachAddon, {
  name: 'outreach.ask.end',
  description:
    'The browser extension says how an ask ended: done, or why it didn’t finish, with a look-up’s drafts. One the person stopped stays stopped.',
  risk: 0,
  input: AskEndInput,
  output: AskEndOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Kept whenever it arrives, at the moment it ended: a retried end gets the first answer.
  offline: 'anytime',
  emits: ['outreach.ask.ended'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await ownAsk(ctx, me, input.askId);
    if (!row) throw notAsked();
    if (row.state === 'cancelled') {
      // Stopped: the extension's words say how far it got ("Stopped after 3 people.").
      if (input.line)
        await ctx.tx
          .update(asks)
          .set({ line: input.line, updatedAt: new Date() })
          .where(eq(asks.id, row.id));
      return { state: row.state };
    }
    if (!isOpen(row)) return { state: row.state };
    await ctx.tx
      .update(asks)
      .set({
        state: input.state,
        line: input.line || null,
        result: row.kind === 'lookup' ? input.result : null,
        endedAt: at,
        startedAt: row.startedAt ?? at,
        reply: null,
        updatedAt: new Date(),
      })
      .where(eq(asks.id, row.id));
    await ctx.emit({
      type: 'outreach.ask.ended',
      entityType: 'outreach_ask',
      entityId: row.id,
      payload: { userId: me, kind: row.kind, state: input.state },
    });
    return { state: input.state };
  },
});

export const askReply = defineAddonCommand(outreachAddon, {
  name: 'outreach.ask.reply',
  description:
    'The person answers a step their computer handed to them: Carry on (they did it, or it should look again), or Skip (that person).',
  risk: 0,
  input: AskReplyInput,
  output: AskChangedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.ask.replied'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const row = await ownAsk(ctx, me, input.askId);
    if (!row || row.state !== 'stuck' || !askRepliesFor(row.kind).includes(input.reply))
      throw HfosError.notFound('Your computer isn’t waiting on that any more. Refresh the page.');
    const [kept] = await ctx.tx
      .update(asks)
      .set({ reply: input.reply, updatedAt: new Date() })
      .where(eq(asks.id, row.id))
      .returning();
    await ctx.emit({
      type: 'outreach.ask.replied',
      entityType: 'outreach_ask',
      entityId: row.id,
      payload: { userId: me, kind: row.kind, reply: input.reply },
    });
    return { ask: await shownOne(ctx, kept!, Date.now()) };
  },
});

export const askCancel = defineAddonCommand(outreachAddon, {
  name: 'outreach.ask.cancel',
  description:
    'The person stops something they asked of their computer: one waiting never starts, and one under way stops at its next page.',
  risk: 0,
  input: AskCancelInput,
  output: AskChangedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.ask.cancelled'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await ownAsk(ctx, me, input.askId);
    if (!row) throw notAsked();
    if (!isOpen(row)) throw HfosError.notFound('That’s finished already. Refresh the page.');
    const [kept] = await ctx.tx
      .update(asks)
      .set({
        state: 'cancelled',
        line: row.state === 'waiting' ? ASK_STOPPED_EARLY_LINE : ASK_STOPPED_LINE,
        endedAt: at,
        reply: null,
        updatedAt: new Date(),
      })
      .where(eq(asks.id, row.id))
      .returning();
    await ctx.emit({
      type: 'outreach.ask.cancelled',
      entityType: 'outreach_ask',
      entityId: row.id,
      payload: { userId: me, kind: row.kind },
    });
    return { ask: await shownOne(ctx, kept!, at.getTime()) };
  },
});

export const asksList = defineAddonQuery(outreachAddon, {
  name: 'outreach.asks',
  description:
    'What the person asked their computer to do from HandsFreeOS: the ones still open and today’s, newest first, each with how it’s going or how it ended; and the computer that works for them, whether it’s on.',
  input: AsksInput,
  output: AsksOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const [todayStart, timezone, all, warned] = await Promise.all([
      startOfToday(ctx, now),
      workspaceTimezone(ctx.tx, ctx.scope.workspaceId!),
      myComputers(ctx, me),
      warnedToday(ctx, me, now),
    ]);
    const working = workingOf(all);
    const listed = await shownAsks(
      ctx,
      me,
      and(
        or(inArray(asks.state, [...OPEN_ASK_STATES]), gte(asks.askedAt, todayStart)),
        input.kinds?.length ? inArray(asks.kind, input.kinds) : undefined,
      ),
      now,
      ASKS_SHOWN_MOST,
    );
    return {
      now: new Date(now).toISOString(),
      timezone,
      computer: working
        ? {
            computerId: working.id,
            name: working.name,
            online: !isOffline(working.lastSeenAt, now),
            signedOut: working.state === 'signed_out',
            lastSeenAt: working.lastSeenAt.toISOString(),
          }
        : null,
      warnedToday: warned !== null,
      asks: listed,
    };
  },
});

export const profileContact = defineAddonCommand(outreachAddon, {
  name: 'outreach.profile.contact',
  description:
    'Add to Contacts: someone the person reached, kept as a profile, becomes a customer in Contacts with Facebook as their source, or is tied to the customer the person says they are.',
  risk: 1,
  input: ProfileContactInput,
  output: ProfileSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.profile.saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const [profile] = await ctx.tx
      .select()
      .from(profiles)
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      );
    if (!profile)
      throw HfosError.notFound(
        'That person isn’t kept in Social Outreach any more. Refresh the page.',
      );
    const saved = await once(() =>
      saveProfile(ctx, {
        platform: profile.platform,
        profile: { id: profile.platformId, username: profile.username, url: profile.url },
        name: profile.name,
        facts: null,
        ...(input.personId ? { personId: input.personId } : {}),
      }),
    );
    await ctx.emit({
      type: 'outreach.profile.saved',
      entityType: 'person',
      entityId: saved.personId,
      payload: {
        platform: profile.platform,
        profileId: saved.profileId,
        addedPerson: saved.addedPerson,
      },
    });
    return saved;
  },
});

export const askCommands = [
  askMake,
  askTake,
  askProgress,
  askEnd,
  askReply,
  askCancel,
  profileContact,
] as const;
export const askQueries = [asksList] as const;
