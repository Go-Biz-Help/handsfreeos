/**
 * Tracking: the daily numbers (docs/outreach.md, decision 70; core's rules in
 * packages/core/src/addons/outreach/tracking.ts):
 *
 * - **The day's report** (`outreach.day_report`, one job a person): at the end of their working hours on a working
 *   day, their three numbers today against the target: "Today: 14 messages, 2 said yes, 1 booked. 1 more message hits
 *   your target." Only on a day with something to tell, and only while it's on (My settings; on to start). It's
 *   armed when they start their day or save their settings, and by the morning push for whoever noted a step lately,
 *   and comes back the next working day while they keep noting steps.
 * - **The week's review** (`outreach.review`, one job a business): on Monday at the morning push's hour (8 when that's
 *   off), the AI reads each person's numbers for last week and says what to fix first, in the video's order, counted
 *   against the AI limit. With no AI (the day's limit, the wallet, an answer it can't use), the numbers' own words.
 *   Kept for Results (`outreach.review.save`), then pushed. Armed whenever the weekly report is.
 * - **A new main offer** (`main_offer.published`): whoever OK'd how their messages read against an older version
 *   hears it, as Get ready asks them to look again.
 *
 * Each push goes to the person alone, on their add-ons switch.
 */
import {
  anyNumbers,
  checkedReview,
  dayReportDue,
  dayReportWords,
  nextDayEnd,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM,
  ReviewAnswer,
  reviewPrompt,
  reviewPushWords,
  rulesReview,
  type DayReportOutput,
  type ReviewWeekOutput,
  type ReviewWords,
} from '@hfos/core/addons/outreach/tracking';
import { nextWeekly, WEEKLY_HOUR } from '@hfos/core/addons/outreach/results';
import { dayReport, reviewSave, reviewWeekQuery } from '@hfos/core/addons/outreach/ops/tracking';
import { executeCommand, executeQuery } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { businessOf } from './alerts';
import { refusedForGood } from './waiting';

export const DAY_REPORT_JOB = 'outreach.day_report';
export const REVIEW_JOB = 'outreach.review';
const RESULTS_HREF = '/a/outreach?view=results';
const TODAY_HREF = '/a/outreach?view=today';
const HOUR = 3_600_000;
/** A review that runs this late (the worker was down) still goes; later, it waits for the next Monday. */
const REVIEW_LATE_MS = 12 * HOUR;
/** Who gets a review: a step noted in this many days. */
const REVIEW_ACTIVE_DAYS = 14;

/** The person's day's report as the worker reads it, asked on their behalf: null when they can't use it any more. */
async function dayOf(
  ctx: AddonScopeContext,
  userId: string,
  day?: string,
): Promise<DayReportOutput | null> {
  try {
    return await executeQuery(
      ctx.db,
      dayReport,
      { workspaceId: ctx.scope.workspaceId, ...(day ? { day } : {}) },
      { ...ctx.actor, onBehalfOf: userId },
      ctx.meta,
    );
  } catch (e) {
    if (!refusedForGood(e)) throw e;
    ctx.log.warn({ err: e.message, rule: e.rule, userId }, 'no day’s report');
    return null;
  }
}

async function scheduleDayReport(ctx: AddonScopeContext, userId: string, at: Date) {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: DAY_REPORT_JOB,
        dedupeKey: `${DAY_REPORT_JOB}:${userId}`,
        runAt: at,
        payload: { userId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** Queues the person's next day's report, or moves it sooner; nothing while it's off. */
export async function armDayReport(
  ctx: AddonScopeContext,
  userId: string,
  now = Date.now(),
): Promise<void> {
  const day = await dayOf(ctx, userId);
  if (!day?.on) return;
  await scheduleDayReport(ctx, userId, nextDayEnd(day.hours, day.timezone, now));
}

/** `outreach.day.started`, `outreach.automation.saved`: the person's day's report is armed, or moved. */
export async function armDayReportFor(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { userId?: string };
  if (p.userId) await armDayReport(ctx, p.userId);
}

/** Whoever noted a step this week: their day's reports armed, by the morning push. */
export async function armDayReports(ctx: AddonJobContext): Promise<void> {
  const since = new Date(ctx.now - 7 * 24 * HOUR).toISOString();
  const people = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ user_id: string }>(
      tx,
      sql`select distinct user_id from addon_outreach.touches
          where workspace_id = ${ctx.scope.workspaceId} and at >= ${since}::timestamptz`,
    ),
  );
  for (const p of people) await armDayReport(ctx, p.user_id, ctx.now);
}

/**
 * `outreach.day_report`: the person's day, at the end of their working hours, when it's on and the day had a first
 * message, a yes or a call; then the next working day's while they keep noting steps. Their hours moved later: it
 * comes back then.
 */
export async function dayReportJob(ctx: AddonJobContext): Promise<JobResult> {
  const userId = ctx.job.payload['userId'];
  if (typeof userId !== 'string') return;
  const now = await dayOf(ctx, userId);
  if (!now?.on) return;
  const due = dayReportDue(now.hours, now.timezone, ctx.now);
  if (due) {
    const day = await dayOf(ctx, userId, due);
    if (day && anyNumbers(day.numbers))
      await asWorker(ctx.db, ctx.scope, (tx) =>
        pushAddonNotice(ctx, tx, {
          // One a person a day: run again, it's the same push.
          key: `day-report:${ctx.scope.workspaceId}:${userId}:${due}`,
          userIds: [userId],
          permission: 'outreach.use',
          ...dayReportWords(day.numbers, day.target),
          href: `${RESULTS_HREF}&period=today`,
          collapseKey: `day-report-${userId}`,
        }),
      );
  }
  // The next working day's while they keep noting steps, or the end of today's when it ran early (their hours moved
  // later since it was armed). Quiet for a week: it waits for them to start a day or save their settings.
  if (now.active || !due) return { rescheduleAt: nextDayEnd(now.hours, now.timezone, ctx.now) };
}

// ---- The week's review ----

const hourOf = (settings: { morningPushHour: number | null }) =>
  settings.morningPushHour ?? WEEKLY_HOUR;

/** Queues the next week's review, or moves it sooner. */
export async function armReview(ctx: AddonScopeContext, now = Date.now()): Promise<void> {
  const { settings, tz } = await businessOf(ctx);
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: REVIEW_JOB,
        dedupeKey: `${REVIEW_JOB}:${ctx.scope.workspaceId}`,
        runAt: nextWeekly(now, tz, hourOf(settings)),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** Everyone who can use Social Outreach here and noted a step lately. */
async function reviewPeople(ctx: AddonJobContext): Promise<string[]> {
  const since = new Date(ctx.now - REVIEW_ACTIVE_DAYS * 24 * HOUR).toISOString();
  return asWorker(ctx.db, ctx.scope, async (tx) =>
    (
      await rows<{ user_id: string }>(
        tx,
        sql`select distinct t.user_id from addon_outreach.touches t
            join app.workspace_access wa on wa.user_id = t.user_id and wa.workspace_id = t.workspace_id
            where t.workspace_id = ${ctx.scope.workspaceId} and t.at >= ${since}::timestamptz
              and 'outreach.use' = any (wa.permissions)
            order by t.user_id`,
      )
    ).map((r) => r.user_id),
  );
}

/** What the AI says to fix first, from the week's numbers; null when it can't say it now (`retry`) or at all. */
async function aiReview(
  ctx: AddonJobContext,
  week: ReviewWeekOutput,
  business: string,
): Promise<ReviewWords | 'retry' | null> {
  try {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: reviewPrompt(week, business) }],
      schema: REVIEW_SCHEMA,
      zod: ReviewAnswer,
      maxTokens: 800,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    return checkedReview(value);
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A dropped connection or a busy model is tried again; the day's limit, the wallet or a refusal isn't.
    if (e.retryable && ctx.attempt < 3) return 'retry';
    ctx.log.warn({ code: e.code }, 'the AI couldn’t write a week’s review: the numbers’ own words');
    return null;
  }
}

/**
 * `outreach.review`: each person's week's review, kept and pushed, then next Monday's. Someone whose review is kept
 * already is skipped, so a run tried again for one the AI couldn't write yet does only that one.
 */
export async function reviewJob(ctx: AddonJobContext): Promise<JobResult> {
  const { settings, name, tz } = await businessOf(ctx);
  const hour = hourOf(settings);
  const due = nextWeekly(ctx.now - REVIEW_LATE_MS, tz, hour).getTime();
  // Moved to a later hour, or the worker was down past the morning: the next one.
  if (due > ctx.now) return { rescheduleAt: nextWeekly(ctx.now, tz, hour) };
  let again = false;
  for (const userId of await reviewPeople(ctx)) {
    const as = { ...ctx.actor, onBehalfOf: userId };
    let week: ReviewWeekOutput;
    try {
      week = await executeQuery(
        ctx.db,
        reviewWeekQuery,
        { workspaceId: ctx.scope.workspaceId },
        as,
        ctx.meta,
      );
    } catch (e) {
      if (!refusedForGood(e)) throw e;
      continue;
    }
    if (week.kept) continue;
    const ai = await aiReview(ctx, week, name);
    if (ai === 'retry') {
      again = true;
      continue;
    }
    const words = ai ?? rulesReview(week.fix, week.numbers, week.target?.messages ?? null);
    await executeCommand(
      ctx.db,
      reviewSave,
      {
        workspaceId: ctx.scope.workspaceId,
        userId,
        week: week.week,
        fix: week.fix,
        numbers: week.numbers,
        target: week.target?.messages ?? null,
        ...words,
        by: ai ? 'ai' : 'rules',
      },
      ctx.actor,
      ctx.meta,
    );
    await asWorker(ctx.db, ctx.scope, (tx) =>
      pushAddonNotice(ctx, tx, {
        key: `review:${ctx.scope.workspaceId}:${userId}:${week.week}`,
        userIds: [userId],
        permission: 'outreach.use',
        ...reviewPushWords({ headline: words.headline, numbers: week.numbers }),
        href: RESULTS_HREF,
        collapseKey: `review-${userId}`,
      }),
    );
  }
  // Someone's waits on the AI: the job's tried again, and those kept already are skipped.
  if (again) throw new Error('the AI was busy for a week’s review: trying again');
  return { rescheduleAt: nextWeekly(ctx.now + 60_000, tz, hour) };
}

// ---- A new main offer ----

/**
 * `main_offer.published`: everyone who OK'd how their messages read against an older version hears that it changed,
 * as Get ready's Your messages asks them to look again.
 */
export async function offerPublished(ctx: AddonEventContext): Promise<void> {
  const version = Number((ctx.event.payload as { version?: unknown } | null)?.version);
  if (!Number.isInteger(version) || version < 2) return;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const older = await rows<{ user_id: string }>(
      tx,
      sql`select s.user_id from addon_outreach.setup s
          where s.workspace_id = ${ctx.scope.workspaceId} and s.messages_at is not null
            and coalesce(s.messages_version, 0) < ${version}`,
    );
    if (!older.length) return;
    await pushAddonNotice(ctx, tx, {
      key: `offer:${ctx.scope.workspaceId}:${version}`,
      userIds: older.map((o) => o.user_id),
      permission: 'outreach.use',
      title: 'Your main offer changed',
      body: `Look over your messages again under Get ready: they now use version ${version}.`,
      href: TODAY_HREF,
      collapseKey: 'main-offer',
    });
  });
}
