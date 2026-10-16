/**
 * Live status and control (../live.ts, docs/outreach.md decision 41): what each of the person's computers says it's
 * doing, which one works, their day, and the feed of today's steps; Start my day and Stop for today from anywhere;
 * and, for owners and admins, the team's status, counts and how many wait, never their lines or messages. Each
 * person's computers, day and feed are their own.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, RequestMeta } from '../../../kernel/types';
import { onServerClock } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { businessDay, businessLimitsOn, OTHER_PLATFORMS } from '../automation';
import {
  ComputerRenameInput,
  ComputerRenameOutput,
  dayLine,
  DayInput,
  DayOutput,
  isOffline,
  LINE_TELL_SECONDS,
  PRE_DAY_LINE_SECONDS,
  LIVE_STEPS_SHOWN_MOST,
  LiveBeatInput,
  LiveBeatOutput,
  LiveInput,
  LiveOutput,
  LiveTeamInput,
  LiveTeamOutput,
  numberedName,
  sendingOffWords,
  networkOffWords,
  shownState,
  warnedTodayWords,
  type ComputerShown,
  type DayState,
  type DayVia,
  type LiveDay,
} from '../live';
import { dailyLimitsNow, WARNING_SLOWER_DAYS, type DailyStep } from '../limits';
import { outreachAddon } from '../manifest';
import { networkLimitsNow } from '../networks';
import type { Platform } from '../playbooks';
import { notReadyWords } from '../readiness';
import { computers, days, liveSteps } from '../tables';
import { todayLimits } from '../today';
import { automationOf, everyoneAutomation } from './automation';
import { asksWaiting } from './ask-rows';
import { inWorkspace, type Ctx } from './common';
import { listsOf } from './lists';
import { readinessFor } from './readiness';
import { businessToday, dayOf, dayShown, keepDay, writeLine } from './day';
import { dayCounts } from './today';
import { waitingFor } from './waiting';
import { slowsNow, startOfToday, warningOf } from './tidy';

type Computer = typeof computers.$inferSelect;

const DAY = 86_400_000;

/**
 * The computer that works: the most recently used, then the latest seen. One signed out of the extension works only
 * when every one is.
 */
export function workingOf<
  T extends Pick<Computer, 'activeAt' | 'lastSeenAt' | 'state'> & { id: string },
>(all: readonly T[]): T | null {
  const time = (d: Date | null) => (d ? d.getTime() : -Infinity);
  const ranked = [...all].sort(
    (a, b) =>
      Number(a.state === 'signed_out') - Number(b.state === 'signed_out') ||
      time(b.activeAt) - time(a.activeAt) ||
      time(b.lastSeenAt) - time(a.lastSeenAt) ||
      a.id.localeCompare(b.id),
  );
  return ranked[0] ?? null;
}

/** Where a press came from: the phone, the extension, or the web. */
const viaOf = (meta: RequestMeta): DayVia =>
  meta.channel === 'mobile' ? 'mobile' : meta.channel === 'extension' ? 'extension' : 'web';

/** A time the extension read off its own clock, moved onto the server's: one in the future stays ahead. */
function serverTime(iso: string | null, meta: RequestMeta, now: Date, ahead = false): Date | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (!ahead) return onServerClock(at, meta.sentAt ?? null, now);
  const skew = meta.sentAt ? now.getTime() - meta.sentAt.getTime() : 0;
  return new Date(at.getTime() + skew);
}

const sameTime = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : Math.abs(a.getTime() - b.getTime()) < 5_000;

/** The person's computers. */
export async function myComputers(ctx: Ctx, me: string): Promise<Computer[]> {
  return ctx.tx
    .select()
    .from(computers)
    .where(and(eq(computers.workspaceId, ctx.scope.workspaceId!), eq(computers.userId, me)));
}

const shown = (c: Computer, working: Computer | null): ComputerShown => ({
  id: c.id,
  name: c.name,
  lastSeenAt: c.lastSeenAt.toISOString(),
  activeAt: c.activeAt?.toISOString() ?? null,
  working: c.id === working?.id,
  state: c.state,
  version: c.version,
  allowed: c.allowed ?? null,
});

export const liveBeat = defineAddonCommand(outreachAddon, {
  name: 'outreach.live.beat',
  description:
    'The browser extension says it’s there, on one of the person’s computers: what it’s doing now, its next step and the steps it took since. Answers whether this computer is the one that works, and the person’s day.',
  risk: 0,
  input: LiveBeatInput,
  output: LiveBeatOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Kept whenever it arrives; and a heartbeat leaves no receipt (it's sent every minute, and a repeat does no harm).
  offline: 'anytime',
  receipt: false,
  emits: ['outreach.live.changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const now = new Date();
    const before = await myComputers(ctx, me);
    const workingBefore = workingOf(before);
    let row = before.find((c) => c.installId === input.computer.id);
    const isNew = row === undefined;
    const wasOffline = row ? isOffline(row.lastSeenAt, at.getTime()) : false;
    if (!row) {
      const [made] = await ctx.tx
        .insert(computers)
        .values({
          workspaceId: ws,
          userId: me,
          installId: input.computer.id,
          name: numberedName(
            input.computer.name,
            before.map((c) => c.name),
          ),
          version: input.computer.version,
          allowed: input.computer.allowed,
          lastSeenAt: at,
          // The person's first computer works; a later one once they use it.
          activeAt: input.active || before.length === 0 ? at : null,
          state: input.status.state,
        })
        .onConflictDoNothing()
        .returning();
      row = made ?? (await myComputers(ctx, me)).find((c) => c.installId === input.computer.id)!;
    } else {
      row = {
        ...row,
        lastSeenAt: at > row.lastSeenAt ? at : row.lastSeenAt,
        activeAt: input.active && (row.activeAt === null || at > row.activeAt) ? at : row.activeAt,
        version: input.computer.version ?? row.version,
      };
    }
    const after = before.some((c) => c.id === row.id)
      ? before.map((c) => (c.id === row.id ? row : c))
      : [...before, row];
    const working = workingOf(
      after.map((c) =>
        c.id === row.id && input.status.state !== 'signed_out' && c.state === 'signed_out'
          ? { ...c, state: input.status.state }
          : c,
      ),
    );
    const isWorking = working?.id === row.id;
    const state = isWorking || input.status.state === 'signed_out' ? input.status.state : 'standby';
    const line = input.status.line;
    const nextAt = serverTime(input.status.nextAt, ctx.meta, now, true);
    // A line saved after the last time the app was told is still news, though the last beat already brought it.
    const untoldLine = row.toldAt !== null && row.lineAt !== null && row.lineAt > row.toldAt;
    const lineChanged =
      !isNew && (line !== row.line || !sameTime(nextAt, row.nextAt) || untoldLine);
    const stateChanged = !isNew && state !== row.state;
    // The step before the first day under way: its count is told every few seconds rather than every 45.
    const doing = isWorking ? input.status.doing : null;
    const doingChanged = !isNew && doing !== (row.doing ?? null);

    const sent = input.steps.map((s) => ({
      workspaceId: ws,
      userId: me,
      computerId: row.id,
      clientId: s.id,
      at: serverTime(s.at, ctx.meta, now)!,
      kind: s.kind,
      line: s.line,
    }));
    const inserted = sent.length
      ? await ctx.tx
          .insert(liveSteps)
          .values(sent)
          .onConflictDoNothing()
          .returning({ id: liveSteps.id })
      : [];

    // A heartbeat tells nobody. A new computer, a different one working, a new state or step, one back online, or a
    // new line (at most every so often) tells the app and the person's other computers once.
    const toldLately =
      row.toldAt !== null &&
      now.getTime() - row.toldAt.getTime() <
        (doing ? PRE_DAY_LINE_SECONDS : LINE_TELL_SECONDS) * 1000;
    const tell =
      isNew ||
      workingBefore?.id !== working?.id ||
      inserted.length > 0 ||
      (isWorking && (stateChanged || doingChanged || wasOffline || (lineChanged && !toldLately))) ||
      (!isWorking && stateChanged);
    const [kept] = await ctx.tx
      .update(computers)
      .set({
        lastSeenAt: row.lastSeenAt,
        activeAt: row.activeAt,
        version: row.version,
        allowed: input.computer.allowed,
        state,
        line,
        lineAt: serverTime(input.status.lineAt, ctx.meta, now),
        nextAt,
        doing,
        ...(tell ? { toldAt: now } : {}),
      })
      .where(eq(computers.id, row.id))
      .returning();
    if (tell)
      await ctx.emit({
        type: 'outreach.live.changed',
        entityType: 'outreach_computer',
        entityId: row.id,
        // `made`: a computer new to HandsFreeOS, which has the worker make sure the feed's pruning is armed.
        payload: { userId: me, state, working: isWorking, made: isNew },
      });
    const { today } = await businessToday(ctx, now.getTime());
    return {
      computerId: kept!.id,
      name: kept!.name,
      working: isWorking,
      workingName: isWorking ? null : (working?.name ?? null),
      // Facebook's day, as every build follows it; each other network's beside it, for its own runner.
      day: await dayOf(ctx, me, 'facebook', today),
      days: Object.fromEntries(
        await Promise.all(
          OTHER_PLATFORMS.map(async (p) => [p, await dayOf(ctx, me, p, today)] as const),
        ),
      ),
      stepsKept: input.steps.map((s) => s.id),
      asks: isWorking ? await asksWaiting(ctx, me, now.getTime()) : 0,
    };
  },
});

/**
 * Start my day or Stop for today, for the person's own day on one network, from wherever it was pressed. Each
 * network's day is its own: a stop or a warning on one leaves the others as they are.
 */
async function setDay(
  ctx: CommandContext,
  input: { platform: Platform; installId?: string | undefined },
  state: DayState,
): Promise<LiveDay> {
  const me = requireHuman(ctx).userId;
  const ws = ctx.scope.workspaceId!;
  const { platform } = input;
  const at = changeMoment(ctx.meta);
  const { today, timezone } = await businessToday(ctx);
  const via = viaOf(ctx.meta);
  // A press from another day (one that waited overnight on the phone) changes nothing today, and is passed over
  // quietly: today's warning or Sending off never comes back as a refusal for it.
  if (businessDay(at.getTime(), timezone) !== today) return dayOf(ctx, me, platform, today);
  if (state === 'started') {
    const warning = await warningOf(ctx, me, platform, await startOfToday(ctx));
    const kept = await dayOf(ctx, me, platform, today);
    if (warning?.today || kept.why === 'warning')
      throw HfosError.rule('outreach_warned_today', 409, warnedTodayWords(platform));
    // A network the person doesn't work has no day to start.
    const { choices: settings, rules } = await automationOf(ctx, me, Date.now(), platform);
    if (!settings.on) throw HfosError.rule('outreach_network_off', 409, networkOffWords(platform));
    // Nothing outreach-like until they're ready (decision 63): the first item left says where to finish it.
    const ready = await readinessFor(ctx, me, platform);
    if (!ready.ready) throw HfosError.rule('outreach_not_ready', 409, notReadyWords(ready));
    if (settings.sending === 'off')
      throw HfosError.rule(
        'outreach_sending_off',
        409,
        sendingOffWords(
          rules.sendingAllowed.some((m) => m !== 'off'),
          platform,
        ),
      );
  }
  // Pressed in the extension: that computer is the one the person is using, so it works. When that makes a different
  // computer the one that works, the app and the person's other computers hear it at once, day changed or not.
  const workingBefore = input.installId ? workingOf(await myComputers(ctx, me)) : null;
  if (input.installId)
    await ctx.tx
      .update(computers)
      .set({
        activeAt: sql`greatest(coalesce(${computers.activeAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(computers.workspaceId, ws),
          eq(computers.userId, me),
          eq(computers.installId, input.installId),
        ),
      );
  if (input.installId) {
    const workingNow = workingOf(await myComputers(ctx, me));
    if (workingNow && workingNow.id !== workingBefore?.id)
      await ctx.emit({
        type: 'outreach.live.changed',
        entityType: 'outreach_computer',
        entityId: workingNow.id,
        payload: { userId: me, state: workingNow.state, working: true, made: false },
      });
  }
  if (await keepDay(ctx, me, platform, { today, state, via, at })) {
    await writeLine(ctx, me, at, 'day', dayLine(state, via));
    const [row] = await ctx.tx
      .select({ id: days.id })
      .from(days)
      .where(and(eq(days.workspaceId, ws), eq(days.userId, me), eq(days.platform, platform)));
    await ctx.emit({
      type: state === 'started' ? 'outreach.day.started' : 'outreach.day.stopped',
      entityType: 'outreach_day',
      entityId: row!.id,
      payload: { userId: me, via, platform },
    });
  }
  return dayOf(ctx, me, platform, today);
}

export const dayStart = defineAddonCommand(outreachAddon, {
  name: 'outreach.day.start',
  description:
    'Start my day: the extension on the person’s computer that works starts on their list for today now, at a person’s pace, working hours or not. Pressed on the web, the phone or in the extension.',
  risk: 1,
  input: DayInput,
  output: DayOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Pressed with no signal, it waits and keeps its moment: an older press never undoes a newer one.
  offline: 'anytime',
  emits: ['outreach.day.started', 'outreach.live.changed'],
  handler: (ctx, input) => setDay(ctx, input, 'started'),
});

export const dayStop = defineAddonCommand(outreachAddon, {
  name: 'outreach.day.stop',
  description:
    'Stop for today: the extension on the person’s computers does nothing more on its own until their next working hours. Pressed on the web, the phone or in the extension.',
  risk: 1,
  input: DayInput,
  output: DayOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['outreach.day.stopped', 'outreach.live.changed'],
  handler: (ctx, input) => setDay(ctx, input, 'stopped'),
});

export const computerRename = defineAddonCommand(outreachAddon, {
  name: 'outreach.computer.rename',
  description: 'The person renames one of their own computers the extension runs on.',
  risk: 0,
  input: ComputerRenameInput,
  output: ComputerRenameOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.computer.renamed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .update(computers)
      .set({ name: input.name })
      .where(
        and(
          eq(computers.workspaceId, ctx.scope.workspaceId!),
          eq(computers.userId, me),
          eq(computers.id, input.computerId),
        ),
      )
      .returning({ id: computers.id, name: computers.name });
    if (!row)
      throw HfosError.notFound('That computer isn’t one of yours any more. Refresh the page.');
    await ctx.emit({
      type: 'outreach.computer.renamed',
      entityType: 'outreach_computer',
      entityId: row.id,
      payload: { userId: me },
    });
    return { computerId: row.id, name: row.name };
  },
});

const NONE: Record<DailyStep, number> = {
  friend_request: 0,
  first_message: 0,
  follow_up: 0,
  comment: 0,
  like: 0,
};

export const live = defineAddonQuery(outreachAddon, {
  name: 'outreach.live',
  description:
    'What the extension is doing for the person right now, on the computer that works: its line, next step, how many things wait for them (Waiting for you) and the feed of today’s steps; their computers with when each was last seen; and on one network (Facebook when left out), their day there, today’s counts against its daily limits, any warning it showed and their lists there.',
  input: LiveInput,
  output: LiveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const { platform } = input;
    const { today, timezone } = await businessToday(ctx, now);
    const todayStart = await startOfToday(ctx, now);
    // The network's own day, warning, counts, choices and lists: another network's never show here (Chris: each
    // network on its own). The computers and the feed are the person's, for every network.
    const [warning, auto, all, day, counts, waiting, lists] = await Promise.all([
      warningOf(ctx, me, platform, todayStart, now),
      automationOf(ctx, me, now, platform),
      myComputers(ctx, me),
      dayOf(ctx, me, platform, today),
      dayCounts(ctx, [me], platform, todayStart),
      waitingFor(ctx, [me]),
      listsOf(ctx, me, platform),
    ]);
    const working = workingOf(all);
    const steps = await ctx.tx
      .select({ at: liveSteps.at, kind: liveSteps.kind, line: liveSteps.line })
      .from(liveSteps)
      .where(
        and(
          eq(liveSteps.workspaceId, ctx.scope.workspaceId!),
          eq(liveSteps.userId, me),
          gte(liveSteps.at, todayStart),
        ),
      )
      .orderBy(desc(liveSteps.at), desc(liveSteps.createdAt))
      .limit(LIVE_STEPS_SHOWN_MOST);
    const listed = [...all].sort(
      (a, b) =>
        Number(b.id === working?.id) - Number(a.id === working?.id) ||
        b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    );
    return {
      timezone,
      now: new Date(now).toISOString(),
      sending: auto.choices.sending,
      canSend: auto.rules.sendingAllowed.some((m) => m !== 'off'),
      day,
      computer: working ? shown(working, working) : null,
      computers: listed.map((c) => shown(c, working)),
      status: working
        ? {
            state: working.state,
            line: working.line,
            lineAt: working.lineAt?.toISOString() ?? null,
            nextAt: working.nextAt?.toISOString() ?? null,
            doing: working.doing ?? null,
          }
        : null,
      limits: todayLimits(
        counts.get(me) ?? NONE,
        networkLimitsNow(
          platform,
          slowsNow(warning, now) || auto.wheels.on,
          businessLimitsOn(auto.rules, platform),
        ),
      ),
      waiting: waiting.get(me) ?? 0,
      warning,
      lists,
      steps: steps.map((s) => ({ at: s.at.toISOString(), kind: s.kind, line: s.line })),
    };
  },
});

/**
 * The team's computers, for owners and admins: a computer's line names the people reached, so the database shows them
 * no colleague's row but through this, which gives its state and when it was seen, never its line.
 */
async function teamComputers(ctx: Ctx) {
  const found = await rows<{
    id: string;
    user_id: string;
    name: string;
    state: Computer['state'];
    last_seen_at: Date | string;
    active_at: Date | string | null;
  }>(
    ctx.tx,
    sql`select id, user_id, name, state, last_seen_at, active_at
        from private.outreach_team_computers(${ctx.scope.workspaceId!}::uuid)`,
  );
  return found.map((c) => ({
    id: c.id,
    userId: c.user_id,
    name: c.name,
    state: c.state,
    lastSeenAt: new Date(c.last_seen_at),
    activeAt: c.active_at === null ? null : new Date(c.active_at),
  }));
}

export const liveTeam = defineAddonQuery(outreachAddon, {
  name: 'outreach.live.team',
  description:
    'For owners and admins: each person who uses Social Outreach, with what their extension is doing (working, waiting, stopped for today, offline), today’s counts against their limits and how many things wait for them. Never what it says it’s doing, nor their messages.',
  input: LiveTeamInput,
  output: LiveTeamOutput,
  permission: 'outreach.manage',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { today, timezone } = await businessToday(ctx, now);
    const todayStart = await startOfToday(ctx, now);
    const found = await rows<{ user_id: string; full_name: string | null; email: string }>(
      ctx.tx,
      // Each person's own access row is theirs alone to read: their permissions come from their membership.
      sql`select m.user_id, u.full_name, u.email from app.workspace_memberships m
          join app.users u on u.id = m.user_id
          where m.workspace_id = ${ws}
            and 'outreach.use' = any (private.user_permissions(m.user_id, m.workspace_id))`,
    );
    const ids = found.map((p) => p.user_id);
    // Facebook's days, counts and warnings: the extension works there alone yet.
    const [all, kept, counts, waiting, warned, auto] = await Promise.all([
      teamComputers(ctx),
      ctx.tx
        .select()
        .from(days)
        .where(and(eq(days.workspaceId, ws), eq(days.platform, 'facebook'))),
      dayCounts(ctx, ids, 'facebook', todayStart),
      waitingFor(ctx, ids),
      rows<{ user_id: string; at: Date | string }>(
        ctx.tx,
        sql`select distinct on (user_id) user_id, at from addon_outreach.warnings
            where workspace_id = ${ws} and platform = 'facebook'
              and at >= ${new Date(now - WARNING_SLOWER_DAYS * DAY).toISOString()}::timestamptz
            order by user_id, at desc`,
      ),
      everyoneAutomation(ctx, now),
    ]);
    return {
      timezone,
      now: new Date(now).toISOString(),
      people: found
        .map((p) => {
          const theirs = all.filter((c) => c.userId === p.user_id);
          const working = workingOf(theirs);
          const day = dayShown(
            kept.find((d) => d.userId === p.user_id),
            today,
          );
          const { settings, wheels } = auto.of(p.user_id);
          const warning = warned.find((w) => w.user_id === p.user_id);
          const slower = warning !== undefined || wheels.on;
          return {
            userId: p.user_id,
            name: p.full_name || p.email,
            state: shownState({
              computer: working
                ? { state: working.state, lastSeenAt: working.lastSeenAt.toISOString() }
                : null,
              day,
              sending: settings.sending,
              now,
            }),
            day,
            sending: settings.sending,
            computer: working
              ? {
                  name: working.name,
                  state: working.state,
                  lastSeenAt: working.lastSeenAt.toISOString(),
                }
              : null,
            limits: todayLimits(
              counts.get(p.user_id) ?? NONE,
              dailyLimitsNow(slower, auto.rules.dailyLimits),
            ),
            waiting: waiting.get(p.user_id) ?? 0,
            warned: warning !== undefined && new Date(warning.at) >= todayStart,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

export const liveCommands = [liveBeat, dayStart, dayStop, computerRename] as const;
export const liveQueries = [live, liveTeam] as const;
