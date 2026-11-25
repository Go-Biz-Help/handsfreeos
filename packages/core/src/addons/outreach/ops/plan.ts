/**
 * The plan (../plan.ts, docs/outreach.md decision 195): what the person's computer will do today on a network, and
 * about when. The extension says where its day is up to there, as that changes (`outreach.plan.note`), and
 * HandsFreeOS works the rest of the day out from it with the rules the extension itself follows (`outreach.plan`).
 *
 * From 0.156.0 a network's runner asks for its next move and does it (`outreach.plan.next`, ../plan-next.ts): the
 * same rules, on what HandsFreeOS knows and what only the runner's computer does. A network at a time.
 *
 * Step 3: a row of the plan is changed (`outreach.plan.change`, ../plan-changes.ts): put first, skipped for today,
 * moved to a time, or put back. The same rules read the day's changes, for the plan that's shown and for a runner's
 * next move; a step for someone skipped or not yet due is left off the list the extension is given too (./today.ts).
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { localInstant } from '../../../calendar/engine/zoned';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { appVersionAtLeast } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { askNameOn, OPEN_ASK_STATES } from '../asks';
import { businessDay } from '../automation';
import { clockWords } from '../live';
import { outreachAddon } from '../manifest';
import { NETWORKS, type Platform } from '../networks';
import {
  freshPlanDay,
  leftOn,
  nextMove,
  onPlanClock,
  planDayOf,
  PlanInput,
  PlanNoteInput,
  PlanNoteOutput,
  PlanOutput,
  planRow,
  planShown,
  planUntil,
  rowWords,
  type PlanChanged,
  type PlanDay,
  type PlanFacts,
} from '../plan';
import {
  jobOfChangeKey,
  PLAN_CHANGE_TITLE_MOST,
  PLAN_CHANGE_UI,
  PLAN_CHANGES_MOST,
  PlanChangeInput,
  PlanChangeOutput,
  workChangeKey,
  listWithoutOut,
} from '../plan-changes';
import {
  ASKS_SINCE,
  changeSent,
  moveSent,
  NEXT_SINCE,
  NOT_DECIDING,
  PLAN_DECIDES,
  PlanNextInput,
  PlanNextOutput,
} from '../plan-next';
import { RUNNERS, type RunnerJob } from '../runners';
import { asks, planChanges, planDays } from '../tables';
import { shownAsks } from './ask-rows';
import { automationOf } from './automation';
import { inWorkspace, type Ctx } from './common';
import { businessToday, dayOf } from './day';
import { listsOf } from './lists';
import { myComputers, workingOf } from './live';
import { changesOf } from './plan-changes';
import { startOfToday, warningOf } from './tidy';
import { todayFor } from './today';

/**
 * Whether HandsFreeOS decides the order of a network's day for a computer on this build: what the Plan's Do now, and
 * a change to a once-a-day read, go by (step 3, ../plan-changes.ts). A runner that plans for itself wouldn't know of
 * either. The computer's build is the one its heartbeat last said.
 */
const decidesFor = (platform: Platform, version: string | null | undefined): boolean =>
  PLAN_DECIDES.includes(platform) && appVersionAtLeast(version, ASKS_SINCE[platform]);

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
 * saved, today's list, what they changed on today's plan, and their computers.
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
  const [warning, auto, computers, day, lists, open, { list }, changes] = await Promise.all([
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
    changesOf(ctx, me, platform, today),
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
    changes,
  } satisfies PlanFacts;
  return { today, facts, asked, computers, list, changes };
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
    'What the person’s computer will do today on one network (Facebook when left out), and about when: where the day stands in a line, what they asked for that goes first, what’s coming in order with rough times, how many more follow, and the day’s reading and steps done so far. Worked out from where the extension said its day is up to, by the rules it follows. Times are a rough guide. A row that can be changed has its key, and can says how (now, skip, at): pass both to outreach.plan.change. changes is what the person skipped today or moved to a time still ahead, each with its key to put it back.',
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
    const { today, facts, asked, computers, changes } = await knownOf(ctx, me, input, now);
    const reported = await reportedDay(ctx, me, platform, today);
    const working = workingOf(computers);
    const shown = planShown({
      facts,
      reported,
      computer: working
        ? { state: working.state, lastSeenAt: working.lastSeenAt, version: working.version }
        : null,
      decides: decidesFor(platform, working?.version),
    });
    return {
      ...shown,
      asked: asked.map((a) => ({
        askId: a.askId,
        title: askNameOn(a.kind, platform),
        working: a.state !== 'waiting',
      })),
      // What's skipped, or moved to a time still ahead: what's first, or moved and due, shows on its own row.
      changes: changes.flatMap((c): PlanChanged[] =>
        c.change === 'skip'
          ? [{ key: c.key, change: 'skip', at: null, title: c.title }]
          : c.change === 'at' && c.at !== null && c.at > now
            ? [{ key: c.key, change: 'at', at: new Date(c.at).toISOString(), title: c.title }]
            : [],
      ),
    };
  },
});

/**
 * Changes a row of today's plan on a network (step 3): Do now, Skip today, Move to a time, or Put back. Pressed on
 * Today's Plan on the web and the phone, and the Assistant's to ask for. The newest change to a row is the one kept.
 */
export const planChange = defineAddonCommand(outreachAddon, {
  name: 'outreach.plan.change',
  description:
    'Change one row of today’s plan on a network (Facebook when left out), by the row’s key from the plan: now puts it first, so it’s the next thing the person’s computer does there; skip leaves it out for today (it’s back tomorrow if it’s still due); at moves it to a time today (time, as 15:30 on the business’s clock): it waits till then; back puts it back as it was. It takes hold the next time their computer looks, usually within minutes. A step for someone on the list can be skipped or moved on any network. Do now, and any change to a once-a-day read, only where the row’s can says so. Every limit and wait stays: a change only picks among what the day would do anyway.',
  risk: 1,
  input: PlanChangeInput,
  output: PlanChangeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_change_plan',
    autonomy: 'confirm',
    keywords: [
      'do it now',
      'skip today',
      'move to a time',
      'put back',
      'change the plan',
      'reschedule',
      'do this first',
    ],
    what: (input) => {
      const { change, time } = input as { change?: string; time?: string };
      return change === 'now'
        ? 'Do it next on today’s plan'
        : change === 'skip'
          ? 'Skip it on today’s plan'
          : change === 'at'
            ? `Move it to ${time ?? 'a time'} on today’s plan`
            : 'Put it back on today’s plan';
    },
    outcome: (output) => ({ words: (output as { words: string }).words }),
  },
  scope: inWorkspace,
  emits: ['outreach.plan.changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { platform, key, change } = input;
    const name = NETWORKS[platform].name;
    const mine = and(
      eq(planChanges.workspaceId, ws),
      eq(planChanges.userId, me),
      eq(planChanges.platform, platform),
    );
    const said = async (rowId: string) =>
      ctx.emit({
        type: 'outreach.plan.changed',
        entityType: 'outreach_plan_change',
        entityId: rowId,
        payload: { userId: me, platform, change },
      });

    if (change === 'back') {
      const [gone] = await ctx.tx
        .delete(planChanges)
        .where(and(mine, eq(planChanges.key, key)))
        .returning({ id: planChanges.id, title: planChanges.title });
      if (gone) await said(gone.id);
      // Put back twice, or from two screens: it's back either way.
      return { key, change, at: null, title: gone?.title ?? '', words: PLAN_CHANGE_UI.done.back };
    }

    const { today, facts, computers, changes } = await knownOf(ctx, me, input, now);
    const reported = (await reportedDay(ctx, me, platform, today)) ?? freshPlanDay(today);
    const kit = RUNNERS[platform];
    // The row, as the plan has it now: a once-a-day read of this network's, or a piece of work left on the list.
    const job = jobOfChangeKey(key);
    const read =
      job !== null && facts.choices.collect && (kit.daily as readonly string[]).includes(job)
        ? (job as RunnerJob)
        : null;
    const work =
      job === null
        ? (leftOn(kit, facts.list, reported).find((w) => workChangeKey(w) === key) ?? null)
        : null;
    if (read === null && work === null)
      throw HfosError.rule(
        'outreach_plan_row_gone',
        409,
        `That isn’t on today’s ${name} plan any more. It may be done already. Open Social Outreach → Today → Plan to see what’s left.`,
      );
    // Do now, and a change to a read, need HandsFreeOS to decide the order there: a runner that plans for itself
    // wouldn't know of either.
    const decides = decidesFor(platform, workingOf(computers)?.version);
    if (!decides && (change === 'now' || read !== null))
      throw HfosError.rule(
        'outreach_plan_order_not_here',
        409,
        `On ${name}, your computer still sets the order of its own day, so ${
          read !== null ? 'its daily reads can’t be changed' : 'a step can’t be put first'
        } from here yet. You can skip a step for someone today, or move it to a time.`,
      );
    const { until, over } = planUntil(facts);
    let at: Date | null = null;
    if (change === 'at') {
      if (!input.time)
        throw HfosError.validation(
          [{ path: 'time', message: 'Say what time today to move it to, like 15:30.' }],
          'Pick a time today to move it to.',
        );
      const moved = localInstant(today, input.time, facts.timeZone);
      if (moved <= now)
        throw HfosError.rule(
          'outreach_plan_time_past',
          409,
          `It’s already past ${clockWords(moved, facts.timeZone)}. Pick a time later today.`,
        );
      if (over)
        throw HfosError.rule(
          'outreach_plan_day_over',
          409,
          `${name}’s working hours are over for today, so nothing new goes on its own. Press Start my day on Social Outreach → Today to carry on now, or skip it and it’s back on tomorrow’s plan.`,
        );
      if (moved >= until)
        throw HfosError.rule(
          'outreach_plan_time_late',
          409,
          `${name} stops for the day at ${clockWords(until, facts.timeZone)}, so it can’t go at ${clockWords(moved, facts.timeZone)}. Pick an earlier time, or press Start my day on Social Outreach → Today to keep going after hours.`,
        );
      at = new Date(moved);
    }
    if (change === 'now' && over)
      throw HfosError.rule(
        'outreach_plan_day_over',
        409,
        `${name}’s working hours are over for today, so nothing new goes on its own. Press Start my day on Social Outreach → Today to carry on now.`,
      );
    if (!changes.some((c) => c.key === key) && changes.length >= PLAN_CHANGES_MOST)
      throw HfosError.rule(
        'outreach_plan_changes_full',
        409,
        `You’ve changed ${PLAN_CHANGES_MOST} things on today’s ${name} plan, which is the most for a day. Put one back first, under Skipped or moved today.`,
      );

    // What the row says, as the plan shows it: kept so what's skipped can be listed and put back.
    const title = (
      read !== null
        ? (kit.names[read] ?? read)
        : rowWords(
            planRow(platform, {
              at: now,
              about: true,
              now: false,
              move: {
                do: 'work',
                work: work!,
                left: 0,
                gap: 0,
                reading: false,
                day: { started: false, until: null },
                answering: false,
              },
            }),
          )
    ).slice(0, PLAN_CHANGE_TITLE_MOST);
    const made = new Date(now);
    // An earlier day's changes count for nothing: they go with the first change of a new day.
    await ctx.tx.delete(planChanges).where(and(mine, lt(planChanges.day, today)));
    const [row] = await ctx.tx
      .insert(planChanges)
      .values({
        workspaceId: ws,
        userId: me,
        platform,
        day: today,
        key,
        change,
        at,
        title,
        madeAt: made,
      })
      .onConflictDoUpdate({
        target: [
          planChanges.workspaceId,
          planChanges.userId,
          planChanges.platform,
          planChanges.key,
        ],
        set: { day: today, change, at, title, madeAt: made, updatedAt: sql`now()` },
      })
      .returning({ id: planChanges.id });
    await said(row!.id);
    return {
      key,
      change,
      at: at ? at.toISOString() : null,
      title,
      words:
        change === 'at'
          ? PLAN_CHANGE_UI.done.at(at!.toISOString(), facts.timeZone)
          : PLAN_CHANGE_UI.done[change],
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
      // The list as the extension is given it (`outreach.today`): without anyone skipped today or moved to later.
      list: move.do === 'work' ? listWithoutOut(list, facts.changes, now) : null,
    };
  },
});

export const planCommands = [planNote, planChange] as const;
export const planQueries = [plan, planNext] as const;
