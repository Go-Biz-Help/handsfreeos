/**
 * The plan (../plan.ts, docs/outreach.md decision 195): what the person's computer will do today on a network, and
 * about when. The extension says where its day is up to there, as that changes (`outreach.plan.note`), and
 * HandsFreeOS works the rest of the day out from it with the rules the extension itself follows (`outreach.plan`).
 *
 * From 0.156.0 a network's runner asks for its next move and does it (`outreach.plan.next`, ../plan-next.ts): the
 * same rules, on what HandsFreeOS knows and what only the runner's computer does. A network at a time.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { appVersionAtLeast } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { askNameOn, OPEN_ASK_STATES } from '../asks';
import { businessDay } from '../automation';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import {
  freshPlanDay,
  nextMove,
  onPlanClock,
  planDayOf,
  PlanInput,
  PlanNoteInput,
  PlanNoteOutput,
  PlanOutput,
  planShown,
  type PlanDay,
  type PlanFacts,
} from '../plan';
import {
  changeSent,
  moveSent,
  NEXT_SINCE,
  NOT_DECIDING,
  PLAN_DECIDES,
  PlanNextInput,
  PlanNextOutput,
} from '../plan-next';
import { asks, planDays } from '../tables';
import { shownAsks } from './ask-rows';
import { automationOf } from './automation';
import { inWorkspace, type Ctx } from './common';
import { businessToday, dayOf } from './day';
import { listsOf } from './lists';
import { myComputers, workingOf } from './live';
import { startOfToday, warningOf } from './tidy';
import { todayFor } from './today';

/**
 * Where the person's day is up to on a network, as their working computer last said: null when it never has. What it
 * said of an earlier day is a day not begun, as its runner makes of it the next time it goes.
 */
export async function reportedDay(
  ctx: Ctx,
  me: string,
  platform: Platform,
  today: string,
): Promise<PlanDay | null> {
  const [row] = await ctx.tx
    .select({ day: planDays.day, state: planDays.state })
    .from(planDays)
    .where(
      and(
        eq(planDays.workspaceId, ctx.scope.workspaceId!),
        eq(planDays.userId, me),
        eq(planDays.platform, platform),
      ),
    );
  if (!row) return null;
  return row.day >= today ? planDayOf(row.state) : freshPlanDay(today);
}

/**
 * What HandsFreeOS knows of the person's day on a network, for the rules: their choices and hours, their day as
 * pressed, a warning today, what they asked of the extension that's still open (oldest first), their lists as last
 * saved, today's list, and their computers.
 */
async function knownOf(
  ctx: Ctx,
  me: string,
  input: { workspaceId: string; platform: Platform },
  now: number,
) {
  const { platform } = input;
  const { today, timezone } = await businessToday(ctx, now);
  const todayStart = await startOfToday(ctx, now);
  const [warning, auto, computers, day, lists, open, { list }] = await Promise.all([
    warningOf(ctx, me, platform, todayStart, now),
    automationOf(ctx, me, now, platform),
    myComputers(ctx, me),
    dayOf(ctx, me, platform, today),
    listsOf(ctx, me, platform),
    shownAsks(
      ctx,
      me,
      and(eq(asks.platform, platform), inArray(asks.state, [...OPEN_ASK_STATES])),
      now,
    ),
    todayFor(ctx, { workspaceId: input.workspaceId, platform }),
  ]);
  // Open still, as the lists show them: one whose computer went away, or that waited a day, goes before nothing.
  const asked = open
    .filter((a) => (OPEN_ASK_STATES as readonly string[]).includes(a.state))
    .reverse();
  const facts = {
    platform,
    now,
    timeZone: timezone,
    hours: auto.settings.hours,
    choices: auto.choices,
    noting: auto.settings.noting,
    day,
    warned: warning?.today ?? false,
    asks: asked.length,
    lists,
    list,
  } satisfies PlanFacts;
  return { today, facts, asked, computers, list };
}

export const planNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.plan.note',
  description:
    'The browser extension says where its day is up to on one network: what it has done, what it tried, what waits to be looked at again and when it works next. HandsFreeOS works the plan out from it. Only the person’s working computer is kept.',
  risk: 0,
  input: PlanNoteInput,
  output: PlanNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Kept whenever it arrives, and it leaves no receipt: it's sent with every step, and the newest one is all that counts.
  offline: 'anytime',
  receipt: false,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = new Date();
    // A computer on standby has its own state, a day it isn't working: kept, it would take the working one's place.
    const all = await myComputers(ctx, me);
    const working = workingOf(all);
    if (!working || working.installId !== input.computer) return { kept: false };
    const at = changeMoment(ctx.meta);
    // Its times are on its own clock: moved onto HandsFreeOS's by how far apart the two are.
    const skew = ctx.meta.sentAt ? now.getTime() - ctx.meta.sentAt.getTime() : 0;
    const state = onPlanClock(input.state, skew);
    const { timezone } = await businessToday(ctx, now.getTime());
    // Before its first go of a day it has no day of its own: it's about today.
    const day = state.day ?? businessDay(now.getTime(), timezone);
    await ctx.tx
      .insert(planDays)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: me,
        platform: input.platform,
        day,
        state,
        notedAt: at,
      })
      .onConflictDoUpdate({
        target: [planDays.workspaceId, planDays.userId, planDays.platform],
        set: { day, state, notedAt: at, updatedAt: now },
      });
    return { kept: true };
  },
});

export const plan = defineAddonQuery(outreachAddon, {
  name: 'outreach.plan',
  description:
    'What the person’s computer will do today on one network (Facebook when left out), and about when: where the day stands in a line, what they asked for that goes first, what’s coming in order with rough times, how many more follow, and the day’s reading and steps done so far. Worked out from where the extension said its day is up to, by the rules it follows. Times are a rough guide.',
  input: PlanInput,
  output: PlanOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_plan',
    keywords: [
      'plan for today',
      'schedule',
      'what will the extension do',
      'what is it doing next',
      'when will it send',
      'coming up',
    ],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const { platform } = input;
    const { today, facts, asked, computers } = await knownOf(ctx, me, input, now);
    const reported = await reportedDay(ctx, me, platform, today);
    const working = workingOf(computers);
    const shown = planShown({
      facts,
      reported,
      computer: working
        ? { state: working.state, lastSeenAt: working.lastSeenAt, version: working.version }
        : null,
    });
    return {
      ...shown,
      asked: asked.map((a) => ({
        askId: a.askId,
        title: askNameOn(a.kind, platform),
        working: a.state !== 'waiting',
      })),
    };
  },
});

export const planNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.plan.next',
  description:
    'The browser extension asks what a network’s runner does next: it says where its day is up to and what only its computer knows (whether the person is away, the reads put off till they are), and HandsFreeOS answers with the move by the day’s rules, from its own settings, list, asks, warnings and day. Only for the networks HandsFreeOS decides, and only the person’s working computer: any other is told to plan for itself.',
  input: PlanNextInput,
  output: PlanNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const { platform } = input;
    if (!PLAN_DECIDES.includes(platform)) return NOT_DECIDING;
    // Only a build that does what it's sent is told what to do: any other plans for itself.
    if (!appVersionAtLeast(ctx.meta.appVersion, NEXT_SINCE)) return NOT_DECIDING;
    const now = Date.now();
    const { facts, computers, list } = await knownOf(ctx, me, input, now);
    // A computer on standby works nothing: its runner stands down by itself.
    const working = workingOf(computers);
    if (!working || working.installId !== input.computer) return NOT_DECIDING;
    // Its times are on its own clock: moved onto HandsFreeOS's to work the move out, and back for the answer.
    const skew = now - input.now;
    const kept = planDayOf(onPlanClock(input.state, skew));
    const { move, state } = nextMove(facts, kept, input.random, input.here);
    return {
      decides: true,
      move: moveSent(move, skew),
      change: changeSent(kept, state, skew),
      list: move.do === 'work' ? list : null,
    };
  },
});

export const planCommands = [planNote] as const;
export const planQueries = [plan, planNext] as const;
