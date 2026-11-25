/**
 * The plan (../plan.ts, docs/outreach.md decision 195): what the person's computer will do today on a network, and
 * about when. The extension says where its day is up to there, as that changes (`outreach.plan.note`), and
 * HandsFreeOS works the rest of the day out from it with the rules the extension itself follows (`outreach.plan`).
 * Nothing here tells the extension what to do: that's the next step of the same decision.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { askNameOn, OPEN_ASK_STATES } from '../asks';
import { businessDay } from '../automation';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import {
  onPlanClock,
  planDayOf,
  PlanInput,
  PlanNoteInput,
  PlanNoteOutput,
  PlanOutput,
  planShown,
  type PlanDay,
} from '../plan';
import { asks, planDays } from '../tables';
import { shownAsks } from './ask-rows';
import { automationOf } from './automation';
import { inWorkspace, type Ctx } from './common';
import { businessToday, dayOf } from './day';
import { listsOf } from './lists';
import { myComputers, workingOf } from './live';
import { startOfToday, warningOf } from './tidy';
import { todayFor } from './today';

/** What the person's working computer last said of today on a network: null when it hasn't, or said it of another day. */
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
  return row && row.day === today ? planDayOf(row.state) : null;
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
    const { today, timezone } = await businessToday(ctx, now);
    const todayStart = await startOfToday(ctx, now);
    const [warning, auto, all, day, lists, reported, open, { list }] = await Promise.all([
      warningOf(ctx, me, platform, todayStart, now),
      automationOf(ctx, me, now, platform),
      myComputers(ctx, me),
      dayOf(ctx, me, platform, today),
      listsOf(ctx, me, platform),
      reportedDay(ctx, me, platform, today),
      shownAsks(
        ctx,
        me,
        and(eq(asks.platform, platform), inArray(asks.state, [...OPEN_ASK_STATES])),
        now,
      ),
      todayFor(ctx, { workspaceId: input.workspaceId, platform }),
    ]);
    const working = workingOf(all);
    // Open still, as the lists show them: one whose computer went away, or that waited a day, goes before nothing.
    const asked = open
      .filter((a) => (OPEN_ASK_STATES as readonly string[]).includes(a.state))
      .reverse();
    const shown = planShown({
      facts: {
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
      },
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

export const planCommands = [planNote] as const;
export const planQueries = [plan] as const;
