/**
 * The day's first messages (docs/outreach.md, decision 126; core's rules in packages/core/src/addons/outreach/goal.ts):
 *
 * - **The first look** (`outreach.goal_check`, one job a person): half an hour into each working day, each network the
 *   person works is worked out as their list is (`outreach.today`, asked on their behalf). One push says how many
 *   messages wait for their OK (answer 8a), and which networks won't reach today's first messages for a reason that
 *   won't fix itself as the day goes, with why (7a). Then the next working day's, while they keep noting steps.
 * - **The midday look** (`outreach.goal_midday`), queued by the first: the same again in the middle of their hours,
 *   with any network short by then that the first look didn't already name.
 *
 * Armed when they start their day or save their settings, and by the morning push for whoever noted a step lately, as
 * the day's report is. Each push goes to the person alone, on their add-ons switch, and opens Today.
 */
import {
  GOAL_KNOWN_EARLY,
  GOAL_LATE_MS,
  goalPushWords,
  goalStartDue,
  goalTimes,
  nextGoalStart,
  type GoalShort,
} from '@hfos/core/addons/outreach/goal';
import { networksShown } from '@hfos/core/addons/outreach/network-words';
import { PLATFORM_KEYS, type Platform } from '@hfos/core/addons/outreach/networks';
import { automationGet } from '@hfos/core/addons/outreach/ops/automation';
import { today } from '@hfos/core/addons/outreach/ops/today';
import { executeQuery } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { businessOf } from './alerts';
import { refusedForGood } from './waiting';

export const GOAL_CHECK_JOB = 'outreach.goal_check';
export const GOAL_MIDDAY_JOB = 'outreach.goal_midday';
const TODAY_HREF = '/a/outreach?view=today';
const DAY = 24 * 3_600_000;
/** Who gets the looks: a step noted in this many days. */
const GOAL_ACTIVE_DAYS = 7;

type Mine = Awaited<ReturnType<typeof settingsOf>>;

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
    ctx.log.warn({ err: e.message, rule: e.rule, userId }, 'no goal look');
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

/** Queues the person's next first look, or moves it sooner. */
export async function armGoalCheck(
  ctx: AddonScopeContext,
  userId: string,
  now = Date.now(),
): Promise<void> {
  const mine = await settingsOf(ctx, userId);
  if (!mine) return;
  const { tz } = await businessOf(ctx);
  await schedule(ctx, GOAL_CHECK_JOB, userId, nextGoalStart(mine.settings.hours, tz, now), {});
}

/** `outreach.day.started`, `outreach.automation.saved`: the person's first look is armed, or moved. */
export async function armGoalCheckFor(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { userId?: string };
  if (p.userId) await armGoalCheck(ctx, p.userId);
}

/** Whoever noted a step this week: their first looks armed, by the morning push. */
export async function armGoalChecks(ctx: AddonJobContext): Promise<void> {
  const since = new Date(ctx.now - GOAL_ACTIVE_DAYS * DAY).toISOString();
  const people = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ user_id: string }>(
      tx,
      sql`select distinct user_id from addon_outreach.touches
          where workspace_id = ${ctx.scope.workspaceId} and at >= ${since}::timestamptz`,
    ),
  );
  for (const p of people) await armGoalCheck(ctx, p.user_id, ctx.now);
}

/**
 * Each network the person works, as Today works it out for them: how many messages wait for their OK, and the networks
 * short, for a reason known now unless it's `midday`, leaving out those named already.
 */
async function lookAt(
  ctx: AddonJobContext,
  userId: string,
  mine: NonNullable<Mine>,
  midday: boolean,
  told: readonly Platform[],
): Promise<{ waitingOk: number; shorts: GoalShort[] }> {
  const actor = { ...ctx.actor, onBehalfOf: userId };
  const workspaceId = ctx.scope.workspaceId;
  let waitingOk = 0;
  const shorts: GoalShort[] = [];
  for (const platform of networksShown(mine.settings, mine.rules.networksAllowed)) {
    const list = await executeQuery(ctx.db, today, { workspaceId, platform }, actor, ctx.meta);
    waitingOk += [...list.items, ...list.partners].filter(
      (i) => i.send?.state === 'waiting',
    ).length;
    const g = list.goal;
    if (
      g?.why &&
      g.short > 0 &&
      !told.includes(platform) &&
      (midday || GOAL_KNOWN_EARLY.includes(g.why))
    )
      shorts.push({ platform, short: g.short, most: g.most, why: g.why, facts: g.facts });
  }
  return { waitingOk, shorts };
}

async function push(
  ctx: AddonJobContext,
  userId: string,
  key: string,
  looked: { waitingOk: number; shorts: readonly GoalShort[] },
) {
  const words = goalPushWords(looked.waitingOk, looked.shorts);
  if (!words) return;
  const net = looked.shorts[0]?.platform;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    pushAddonNotice(ctx, tx, {
      key,
      userIds: [userId],
      permission: 'outreach.use',
      ...words,
      href: net ? `${TODAY_HREF}&net=${net}` : TODAY_HREF,
      collapseKey: `goal-${userId}`,
    }),
  );
}

/** Whether the person noted a step lately: the looks keep coming back only while they work. */
async function active(ctx: AddonJobContext, userId: string): Promise<boolean> {
  const since = new Date(ctx.now - GOAL_ACTIVE_DAYS * DAY).toISOString();
  const [row] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ ok: boolean }>(
      tx,
      sql`select true as ok from addon_outreach.touches
          where workspace_id = ${ctx.scope.workspaceId} and user_id = ${userId}
            and at >= ${since}::timestamptz limit 1`,
    ),
  );
  return row !== undefined;
}

/**
 * `outreach.goal_check`: half an hour into the person's working day, the push (when there's something to say), the
 * midday look queued, then the next working day's while they keep noting steps. Their hours moved: it comes back then.
 */
export async function goalCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const userId = ctx.job.payload['userId'];
  if (typeof userId !== 'string') return;
  const mine = await settingsOf(ctx, userId);
  if (!mine) return;
  const { tz } = await businessOf(ctx);
  const hours = mine.settings.hours;
  const day = goalStartDue(hours, tz, ctx.now);
  if (day) {
    const looked = await lookAt(ctx, userId, mine, false, []);
    await push(ctx, userId, `goal:${ctx.scope.workspaceId}:${userId}:${day}:start`, looked);
    const { midday } = goalTimes(day, hours, tz);
    if (midday > ctx.now)
      await schedule(ctx, GOAL_MIDDAY_JOB, userId, new Date(midday), {
        day,
        told: looked.shorts.map((s) => s.platform),
      });
  }
  if (!day || (await active(ctx, userId)))
    return { rescheduleAt: nextGoalStart(hours, tz, ctx.now + 60_000) };
}

/** `outreach.goal_midday`: the middle of the person's working day, once: what's waiting for their OK, and who's short. */
export async function goalMiddayJob(ctx: AddonJobContext): Promise<JobResult> {
  const { userId, day, told } = ctx.job.payload as {
    userId?: unknown;
    day?: unknown;
    told?: unknown;
  };
  if (typeof userId !== 'string' || typeof day !== 'string') return;
  const mine = await settingsOf(ctx, userId);
  if (!mine) return;
  // Run past the afternoon (the worker was down): it waits for tomorrow's.
  const { tz } = await businessOf(ctx);
  if (ctx.now > goalTimes(day, mine.settings.hours, tz).midday + GOAL_LATE_MS) return;
  const named = Array.isArray(told)
    ? PLATFORM_KEYS.filter((p) => (told as unknown[]).includes(p))
    : [];
  const looked = await lookAt(ctx, userId, mine, true, named);
  await push(ctx, userId, `goal:${ctx.scope.workspaceId}:${userId}:${day}:midday`, looked);
}
