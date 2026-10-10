/**
 * Live status (docs/outreach.md, decision 41; core's rules in packages/core/src/addons/outreach/live.ts):
 *
 * - **A Facebook warning** (`outreach.warning.seen`) pushes to the person's phone: "Facebook showed a warning. The
 *   extension stopped for today." Once per person a business day, to them alone, on their add-ons switch; it opens
 *   the Live tab.
 * - **The feed is kept a week** (`outreach.live_prune`, one job a business, each day): older lines go. It's armed
 *   when the add-on comes on, and when a computer is new to HandsFreeOS (`outreach.live.changed` with `made`), so
 *   a business that had the add-on before it gets one too.
 */
import { LIVE_KEEP_DAYS, warningPushWords } from '@hfos/core/addons/outreach/live';
import { localDateOf } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { businessOf } from './alerts';

export const LIVE_PRUNE_JOB = 'outreach.live_prune';
const LIVE_HREF = '/a/outreach?view=live';
const DAY = 86_400_000;

/** `outreach.warning.seen`: the person's phone hears that Facebook warned them and the extension stopped. */
export async function warningSeen(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { userId?: unknown };
  const userId =
    typeof p.userId === 'string'
      ? p.userId
      : ctx.event.actorType === 'human' && ctx.event.actorId
        ? ctx.event.actorId
        : null;
  if (!userId) return;
  const { tz } = await businessOf(ctx);
  const day = localDateOf(new Date(ctx.event.occurredAt ?? ctx.event.createdAt).getTime(), tz);
  await asWorker(ctx.db, ctx.scope, (tx) =>
    pushAddonNotice(ctx, tx, {
      // One a business day: a second warning the same day is in the same stop.
      key: `warning:${userId}:${day}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...warningPushWords(),
      href: LIVE_HREF,
      collapseKey: `warning-${userId}`,
    }),
  );
}

/** Queues the feed's pruning for the business, a day from now, unless one waits already. */
export async function armPrune(ctx: AddonScopeContext, now = Date.now()): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: LIVE_PRUNE_JOB,
        dedupeKey: `${LIVE_PRUNE_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(now + DAY),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/**
 * `outreach.live.changed`: a computer new to HandsFreeOS has the feed's pruning armed, for a business that had the
 * add-on before it. Every other change (a step, a new state) leaves it be: the job comes back each day by itself.
 */
export async function liveChanged(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { made?: unknown };
  if (p.made === true) await armPrune(ctx);
}

/** `outreach.live_prune`: lines older than a week go, and it comes back tomorrow. */
export async function livePruneJob(ctx: AddonJobContext): Promise<JobResult> {
  const before = new Date(ctx.now - LIVE_KEEP_DAYS * DAY).toISOString();
  await asWorker(ctx.db, ctx.scope, (tx) =>
    rows(
      tx,
      sql`delete from addon_outreach.live_steps
          where workspace_id = ${ctx.scope.workspaceId} and at < ${before}::timestamptz`,
    ),
  );
  return { rescheduleAt: new Date(ctx.now + DAY) };
}
