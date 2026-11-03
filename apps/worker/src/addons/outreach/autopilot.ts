/**
 * Autopilot's day's list (docs/outreach.md, decision 151; core's rules in packages/core/src/addons/outreach/autopilot.ts):
 *
 * - **The list** (`outreach.autopilot_list`, one job a person): an hour before each day's working hours, the day's list
 *   is made (`outreach.autopilot.plan`, on their behalf), and one push says how many people wait for their OK (answer
 *   3a). Then the reminder is queued, and the next day's list.
 * - **The reminder** (`outreach.autopilot_reminder`), queued by the list: in the middle of the hours, while anyone on
 *   today's list still waits, one push says so.
 *
 * Armed when they save their settings with Autopilot on, and by the morning push. Turned on, today's list is made at
 * once (without a push: they're on the screen). Turned off, the next run finds it off and stops. Each push goes to the
 * person alone, on their add-ons switch, and opens Needs you.
 */
import {
  AUTOPILOT_WORDS,
  autopilotDayDue,
  autopilotTimes,
  nextAutopilotList,
} from '@hfos/core/addons/outreach/autopilot';
import { autopilotList, autopilotPlan } from '@hfos/core/addons/outreach/ops/autopilot';
import { automationGet } from '@hfos/core/addons/outreach/ops/automation';
import { executeCommand, executeQuery } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { businessOf } from './alerts';
import { refusedForGood, WAITING_HREF } from './waiting';

export const AUTOPILOT_LIST_JOB = 'outreach.autopilot_list';
export const AUTOPILOT_REMINDER_JOB = 'outreach.autopilot_reminder';

/** The person's settings as the worker reads them, asked on their behalf: null when they can't use it any more. */
async function settingsOf(ctx: AddonScopeContext, userId: string) {
  try {
    return await executeQuery(
      ctx.db,
      automationGet,
      { workspaceId: ctx.scope.workspaceId },
      { ...ctx.actor, onBehalfOf: userId },
      ctx.meta,
    );
  } catch (e) {
    if (!refusedForGood(e)) throw e;
    ctx.log.warn({ err: e.message, rule: e.rule, userId }, 'no autopilot list');
    return null;
  }
}

async function schedule(
  ctx: AddonScopeContext,
  kind: string,
  userId: string,
  at: Date,
  payload: Record<string, unknown>,
) {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind,
        dedupeKey: `${kind}:${userId}`,
        runAt: at,
        payload: { userId, ...payload },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** Today's list made for the person, on their behalf: how many wait for their OK on it. */
async function plan(ctx: AddonScopeContext, userId: string) {
  const made = await executeCommand(
    ctx.db,
    autopilotPlan,
    { workspaceId: ctx.scope.workspaceId },
    { ...ctx.actor, onBehalfOf: userId },
    ctx.meta,
  );
  return made.output;
}

async function push(
  ctx: AddonScopeContext,
  userId: string,
  key: string,
  words: { title: string; body: string },
) {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    pushAddonNotice(ctx, tx, {
      key,
      userIds: [userId],
      permission: 'outreach.use',
      ...words,
      href: WAITING_HREF,
      collapseKey: `autopilot-${userId}`,
    }),
  );
}

/** Queues the person's next list while Autopilot is on for them, or moves it sooner. */
export async function armAutopilot(
  ctx: AddonScopeContext,
  userId: string,
  now = Date.now(),
): Promise<void> {
  const mine = await settingsOf(ctx, userId);
  if (!mine?.settings.autopilot) return;
  const { tz } = await businessOf(ctx);
  await schedule(
    ctx,
    AUTOPILOT_LIST_JOB,
    userId,
    nextAutopilotList(mine.settings.hours, tz, now),
    {},
  );
}

/**
 * `outreach.automation.saved`: with Autopilot on, the next list is armed; turned on just now, today's list is made at
 * once, on a day it works, with its reminder.
 */
export async function autopilotSaved(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as {
    userId?: string;
    autopilot?: boolean;
    autopilotOn?: boolean;
  };
  if (!p.userId || !p.autopilot) return;
  if (p.autopilotOn) {
    const mine = await settingsOf(ctx, p.userId);
    if (!mine?.settings.autopilot) return;
    const { tz } = await businessOf(ctx);
    const day = autopilotDayDue(mine.settings.hours, tz, Date.now());
    if (day) {
      await plan(ctx, p.userId);
      await armReminder(ctx, p.userId, day, mine.settings.hours, tz);
    }
  }
  await armAutopilot(ctx, p.userId);
}

/** Whoever has Autopilot on in the business: their lists armed, by the morning push. */
export async function armAutopilots(ctx: AddonJobContext): Promise<void> {
  const people = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ user_id: string }>(
      tx,
      sql`select user_id from addon_outreach.automation
          where workspace_id = ${ctx.scope.workspaceId} and autopilot`,
    ),
  );
  for (const p of people) await armAutopilot(ctx, p.user_id, ctx.now);
}

async function armReminder(
  ctx: AddonScopeContext,
  userId: string,
  day: string,
  hours: Parameters<typeof autopilotTimes>[1],
  tz: string,
) {
  const { reminder } = autopilotTimes(day, hours, tz);
  if (reminder > Date.now())
    await schedule(ctx, AUTOPILOT_REMINDER_JOB, userId, new Date(reminder), { day });
}

/**
 * `outreach.autopilot_list`: an hour before the person's working day, the day's list made and the push (when anyone
 * waits on it), the reminder queued, then the next day's. Autopilot turned off: it stops.
 */
export async function autopilotListJob(ctx: AddonJobContext): Promise<JobResult> {
  const userId = ctx.job.payload['userId'];
  if (typeof userId !== 'string') return;
  const mine = await settingsOf(ctx, userId);
  if (!mine?.settings.autopilot) return;
  const { tz } = await businessOf(ctx);
  const hours = mine.settings.hours;
  const day = autopilotDayDue(hours, tz, ctx.now);
  if (day) {
    const made = await plan(ctx, userId);
    if (made.made && made.waiting > 0)
      await push(
        ctx,
        userId,
        `autopilot:${ctx.scope.workspaceId}:${userId}:${day}:list`,
        AUTOPILOT_WORDS.push(made.waiting),
      );
    await armReminder(ctx, userId, day, hours, tz);
  }
  return { rescheduleAt: nextAutopilotList(hours, tz, ctx.now + 60_000) };
}

/** `outreach.autopilot_reminder`: the middle of the person's hours, once: anyone on today's list still waiting. */
export async function autopilotReminderJob(ctx: AddonJobContext): Promise<JobResult> {
  const { userId, day } = ctx.job.payload as { userId?: unknown; day?: unknown };
  if (typeof userId !== 'string' || typeof day !== 'string') return;
  const mine = await settingsOf(ctx, userId);
  if (!mine?.settings.autopilot) return;
  // Run past the day's hours (the worker was down): nothing to remind of now.
  const { tz } = await businessOf(ctx);
  if (ctx.now > autopilotTimes(day, mine.settings.hours, tz).end) return;
  const list = await executeQuery(
    ctx.db,
    autopilotList,
    { workspaceId: ctx.scope.workspaceId },
    { ...ctx.actor, onBehalfOf: userId },
    ctx.meta,
  );
  if (list.day !== day || !list.made || list.waiting === 0) return;
  await push(
    ctx,
    userId,
    `autopilot:${ctx.scope.workspaceId}:${userId}:${day}:reminder`,
    AUTOPILOT_WORDS.reminder(list.waiting),
  );
}
