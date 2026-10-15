/**
 * Tracking: the daily numbers (../tracking.ts, docs/outreach.md decision 70). Results reads the three numbers in a
 * stretch (`outreach.tracking`); the worker reads the person's day for their day's report (`outreach.day_report`) and
 * last week for their review (`outreach.review.week`), and keeps the review (`outreach.review.save`). Every count comes
 * through `private.outreach_numbers`: counts only, never who, and everyone's only for owners and admins, or the
 * worker, since each person's answers and conversations are their own.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { mainOffers } from '@hfos/db/schema';
import { rows } from '@hfos/db/client';
import { addDays, localDateOf, startOfLocalDay } from '../../../calendar/engine/zoned';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { ACTIVITY_PERIODS } from '../activity';
import { DAILY_LIMITS } from '../limits';
import { outreachAddon } from '../manifest';
import { PLATFORM_KEYS, type Platform } from '../networks';
import { playbooks, reviews, setup } from '../tables';
import {
  DayReportInput,
  DayReportOutput,
  fixFirst,
  NO_NUMBERS,
  rateOf,
  ReviewSaveInput,
  ReviewSaveOutput,
  reviewWeek,
  ReviewWeekInput,
  ReviewWeekOutput,
  targetFor,
  TrackingInput,
  TrackingOutput,
  workingDaysIn,
  type TrackingNumbers,
  type WeekReview,
} from '../tracking';
import { automationOf } from './automation';
import { inWorkspace, seesEveryone, type Ctx } from './common';
import { periodStart } from './activity';

const DAY = 24 * 60 * 60 * 1000;
/** A stretch that runs to now. */
const ON = 'infinity';
/** Who did outreach lately: a step noted in this many days. */
const ACTIVE_DAYS = 7;

type Counted = {
  readonly platform: Platform;
  readonly playbook_id: string | null;
  readonly offer_version: number | null;
  readonly messages: number;
  readonly positive: number;
  readonly booked: number;
};

/** The three numbers in [from, to), by network, playbook and version: one person's, or everyone's. */
export async function numbersIn(
  ctx: Ctx,
  who: { readonly me: string; readonly everyone: boolean },
  from: string,
  to: string,
): Promise<Counted[]> {
  return rows<Counted>(
    ctx.tx,
    sql`select platform, playbook_id, offer_version, messages, positive, booked
        from private.outreach_numbers(${ctx.scope.workspaceId!}, ${who.me}, ${who.everyone},
          ${from}::timestamptz, ${to}::timestamptz)`,
  );
}

const add = (a: TrackingNumbers, b: TrackingNumbers): TrackingNumbers => ({
  messages: a.messages + b.messages,
  positive: a.positive + b.positive,
  booked: a.booked + b.booked,
});

/**
 * The counts added up, by playbook (with its name, the most messages first), by version (the newest first) and by
 * network (the most messages first, then in the kit's order).
 */
async function summed(ctx: Ctx, counted: readonly Counted[]) {
  const ws = ctx.scope.workspaceId!;
  const ids = [...new Set(counted.map((c) => c.playbook_id))].filter(
    (id): id is string => id !== null,
  );
  const names = new Map(
    (ids.length
      ? await ctx.tx
          .select({ id: playbooks.id, name: playbooks.name })
          .from(playbooks)
          .where(and(eq(playbooks.workspaceId, ws), inArray(playbooks.id, ids)))
      : []
    ).map((p) => [p.id, p.name]),
  );
  const numbers = counted.reduce<TrackingNumbers>((s, c) => add(s, c), NO_NUMBERS);
  const byPlaybook = new Map<string | null, TrackingNumbers>();
  const byVersion = new Map<number, TrackingNumbers>();
  const byNetwork = new Map<Platform, TrackingNumbers>();
  for (const c of counted) {
    byNetwork.set(c.platform, add(byNetwork.get(c.platform) ?? NO_NUMBERS, c));
    // A playbook let go since keeps its counts, under no playbook.
    const id = c.playbook_id !== null && names.has(c.playbook_id) ? c.playbook_id : null;
    byPlaybook.set(id, add(byPlaybook.get(id) ?? NO_NUMBERS, c));
    if (c.offer_version !== null)
      byVersion.set(c.offer_version, add(byVersion.get(c.offer_version) ?? NO_NUMBERS, c));
  }
  const [offer] = byVersion.size
    ? await ctx.tx
        .select({ live: mainOffers.liveVersion })
        .from(mainOffers)
        .where(eq(mainOffers.workspaceId, ws))
    : [];
  return {
    numbers,
    byPlaybook: [...byPlaybook.entries()]
      .map(([playbookId, n]) => ({
        playbookId,
        name: playbookId ? (names.get(playbookId) ?? null) : null,
        ...n,
      }))
      .sort(
        (a, b) =>
          Number(a.playbookId === null) - Number(b.playbookId === null) ||
          b.messages - a.messages ||
          (a.name ?? '').localeCompare(b.name ?? ''),
      ),
    byVersion: [...byVersion.entries()]
      .sort(([a], [b]) => b - a)
      .map(([version, n]) => ({ version, live: version === (offer?.live ?? null), ...n })),
    byNetwork: PLATFORM_KEYS.filter((p) => byNetwork.has(p))
      .map((platform) => ({ platform, ...byNetwork.get(platform)! }))
      .sort((a, b) => b.messages - a.messages),
  };
}

/** The person's goal (Get ready's Your numbers), their working days a week, and what they can send safely a day. */
export async function goalOf(
  ctx: Ctx,
  me: string,
): Promise<{ goal: number; daysAWeek: number; canSend: number } | null> {
  const [kept] = await ctx.tx
    .select({ goal: setup.callsGoal })
    .from(setup)
    .where(and(eq(setup.workspaceId, ctx.scope.workspaceId!), eq(setup.userId, me)));
  if (!kept?.goal) return null;
  const auto = await automationOf(ctx, me);
  return {
    goal: kept.goal,
    daysAWeek: auto.settings.hours.days.length,
    canSend: Math.min(
      DAILY_LIMITS.first_message,
      auto.rules.dailyLimits.first_message ?? DAILY_LIMITS.first_message,
    ),
  };
}

const reviewOf = (r: typeof reviews.$inferSelect): WeekReview => ({
  week: r.week,
  fix: r.fix,
  numbers: r.numbers,
  target: r.target,
  headline: r.headline,
  why: r.why,
  steps: r.steps,
  by: r.by,
  at: r.updatedAt.toISOString(),
});

/** The person's latest week's review. */
async function latestReview(ctx: Ctx, me: string): Promise<WeekReview | null> {
  const [r] = await ctx.tx
    .select()
    .from(reviews)
    .where(and(eq(reviews.workspaceId, ctx.scope.workspaceId!), eq(reviews.userId, me)))
    .orderBy(desc(reviews.week))
    .limit(1);
  return r ? reviewOf(r) : null;
}

function meOf(ctx: Ctx): string {
  const me = userIdOf(ctx.actor);
  if (!me) throw HfosError.forbidden('Only a person has numbers of their own.');
  return me;
}

export const tracking = defineAddonQuery(outreachAddon, {
  name: 'outreach.tracking',
  description:
    'The three numbers to watch every day, in a stretch of days: first messages sent, positive replies and calls booked, the two rates between them against the usual ones and the person’s targets from their goal, by playbook, by the main offer’s version and by network, and their latest week’s review. Owners and admins can see everyone’s counts.',
  input: TrackingInput,
  output: TrackingOutput,
  permission: 'outreach.use',
  // The worker asks on a person's behalf too.
  actors: ['human', 'system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = meOf(ctx);
    if (input.everyone && !(await seesEveryone(ctx, me)))
      throw HfosError.forbidden(
        'Only owners and admins (Run Social Outreach) see the whole team’s numbers. Yours are under You.',
        'outreach_activity_everyone',
      );
    const timezone = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    const from = await periodStart(ctx, ACTIVITY_PERIODS[input.period].days, timezone);
    const s = await summed(ctx, await numbersIn(ctx, { me, everyone: input.everyone }, from, ON));
    const goal = input.everyone ? null : await goalOf(ctx, me);
    return {
      from,
      timezone,
      period: input.period,
      everyone: input.everyone,
      numbers: s.numbers,
      rates: {
        yes: rateOf(s.numbers.positive, s.numbers.messages),
        books: rateOf(s.numbers.booked, s.numbers.positive),
      },
      target: goal
        ? targetFor({ ...goal, days: workingDaysIn(input.period, goal.daysAWeek) })
        : null,
      byPlaybook: s.byPlaybook,
      byVersion: s.byVersion,
      byNetwork: s.byNetwork,
      review: input.everyone ? null : await latestReview(ctx, me),
    };
  },
});

export const reviewWeekQuery = defineAddonQuery(outreachAddon, {
  name: 'outreach.review.week',
  description:
    'Worker: a person’s numbers for last week, Monday to Sunday, with their week’s target, by playbook and version, what to fix first, and whether that week’s review is kept already.',
  input: ReviewWeekInput,
  output: ReviewWeekOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  async handler(ctx) {
    const me = meOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const timezone = await workspaceTimezone(ctx.tx, ws);
    const { week, end } = reviewWeek(Date.now(), timezone);
    const from = new Date(startOfLocalDay(week, timezone)).toISOString();
    const to = new Date(startOfLocalDay(end, timezone)).toISOString();
    const s = await summed(ctx, await numbersIn(ctx, { me, everyone: false }, from, to));
    const goal = await goalOf(ctx, me);
    const target = goal ? targetFor({ ...goal, days: goal.daysAWeek }) : null;
    const [kept] = await ctx.tx
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.workspaceId, ws), eq(reviews.userId, me), eq(reviews.week, week)));
    return {
      week,
      from,
      to,
      numbers: s.numbers,
      target,
      byPlaybook: s.byPlaybook,
      byVersion: s.byVersion,
      fix: fixFirst(s.numbers, target?.messages ?? null),
      kept: !!kept,
    };
  },
});

export const reviewSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.review.save',
  description:
    'Worker: keeps a person’s week’s review: what to fix first, the week’s numbers, and the words the AI wrote from them, or the numbers’ own when it couldn’t.',
  risk: 0,
  input: ReviewSaveInput,
  output: ReviewSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const at = changeMoment(ctx.meta);
    const values = {
      fix: input.fix,
      numbers: input.numbers,
      target: input.target,
      headline: input.headline,
      why: input.why,
      steps: input.steps,
      by: input.by,
      updatedAt: at,
    };
    const [row] = await ctx.tx
      .insert(reviews)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: input.userId,
        week: input.week,
        ...values,
      })
      .onConflictDoUpdate({
        target: [reviews.workspaceId, reviews.userId, reviews.week],
        set: values,
      })
      .returning({ id: reviews.id });
    return { reviewId: row!.id, saved: true };
  },
});

export const dayReport = defineAddonQuery(outreachAddon, {
  name: 'outreach.day_report',
  description:
    'Worker: whether a person’s day’s report is on, their working hours, their three numbers today against a working day’s target, and whether they noted a step lately.',
  input: DayReportInput,
  output: DayReportOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = meOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const timezone = await workspaceTimezone(ctx.tx, ws);
    const now = Date.now();
    const day = input.day ?? localDateOf(now, timezone);
    const from = new Date(startOfLocalDay(day, timezone)).toISOString();
    const to = new Date(startOfLocalDay(addDays(day, 1), timezone)).toISOString();
    const [auto, counted, goal, lately] = await Promise.all([
      automationOf(ctx, me, now),
      numbersIn(ctx, { me, everyone: false }, from, to),
      goalOf(ctx, me),
      rows<{ ok: boolean }>(
        ctx.tx,
        sql`select true as ok from addon_outreach.touches
            where workspace_id = ${ws} and user_id = ${me}
              and at >= ${new Date(now - ACTIVE_DAYS * DAY).toISOString()}::timestamptz
            limit 1`,
      ),
    ]);
    return {
      on: auto.settings.dayReport,
      hours: auto.settings.hours,
      timezone,
      numbers: counted.reduce<TrackingNumbers>((s, c) => add(s, c), NO_NUMBERS),
      target: goal ? targetFor({ ...goal, days: 1 }).messages : null,
      active: lately.length > 0,
    };
  },
});

export const trackingCommands = [reviewSave] as const;
export const trackingQueries = [tracking, reviewWeekQuery, dayReport] as const;
