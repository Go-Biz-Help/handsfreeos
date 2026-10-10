/**
 * Live status (docs/outreach.md, decision 41; core's rules in packages/core/src/addons/outreach/live.ts):
 *
 * - **A Facebook warning** (`outreach.warning.seen`) pushes to the person's phone: "Facebook showed a warning. The
 *   extension stopped for today." Once per person a business day, to them alone, on their add-ons switch; it opens
 *   the Live tab.
 * - **The feed is kept a week** (`outreach.live_prune`, one job a business, each day): older lines go, asks of
 *   the extension asked a week ago (decision 43), needs done, let go or no longer shown a while since, and computers
 *   not seen for a month but each person's working one. It's armed when the add-on comes on, and when a computer is
 *   new to HandsFreeOS (`outreach.live.changed` with `made`), so a business that had the add-on before it gets one
 *   too.
 */
import { ASK_KEEP_DAYS } from '@hfos/core/addons/outreach/asks';
import {
  COMPUTER_KEEP_DAYS,
  LIVE_KEEP_DAYS,
  warningPushWords,
} from '@hfos/core/addons/outreach/live';
import {
  NEED_GONE_DAYS,
  NEED_QUIET_DAYS,
  NEED_SHOWN_DAYS,
} from '@hfos/core/addons/outreach/waiting-words';
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

/**
 * `outreach.live_prune`: lines older than a week go, and so do asks of the extension asked a week ago (decision 43);
 * needs done or let go more than `NEED_QUIET_DAYS` ago (Let it go keeps a step quiet that long, no more), and open ones
 * not seen for `NEED_SHOWN_DAYS` and `NEED_GONE_DAYS` more (off the list a while; noted again, one is new anyway);
 * and computers not seen for `COMPUTER_KEEP_DAYS`, but the one that works for each person (ranked as core's
 * `workingOf`): their lines went with the week already, and an ask one took keeps no computer. Seen again, a computer
 * comes back as new. It comes back tomorrow.
 */
export async function livePruneJob(ctx: AddonJobContext): Promise<JobResult> {
  const before = new Date(ctx.now - LIVE_KEEP_DAYS * DAY).toISOString();
  const asked = new Date(ctx.now - ASK_KEEP_DAYS * DAY).toISOString();
  const unseen = new Date(ctx.now - COMPUTER_KEEP_DAYS * DAY).toISOString();
  const cleared = new Date(ctx.now - NEED_QUIET_DAYS * DAY).toISOString();
  const offList = new Date(ctx.now - (NEED_SHOWN_DAYS + NEED_GONE_DAYS) * DAY).toISOString();
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    await rows(
      tx,
      sql`delete from addon_outreach.live_steps
          where workspace_id = ${ctx.scope.workspaceId} and at < ${before}::timestamptz`,
    );
    await rows(
      tx,
      sql`delete from addon_outreach.asks
          where workspace_id = ${ctx.scope.workspaceId} and asked_at < ${asked}::timestamptz`,
    );
    await rows(
      tx,
      sql`delete from addon_outreach.needs
          where workspace_id = ${ctx.scope.workspaceId}
            and ((state <> 'open' and cleared_at < ${cleared}::timestamptz)
              or (state = 'open' and seen_at < ${offList}::timestamptz))`,
    );
    await rows(
      tx,
      sql`delete from addon_outreach.computers c
          where c.workspace_id = ${ctx.scope.workspaceId} and c.last_seen_at < ${unseen}::timestamptz
            and c.id <> (select w.id from addon_outreach.computers w
              where w.workspace_id = c.workspace_id and w.user_id = c.user_id
              order by w.state = 'signed_out', w.active_at desc nulls last, w.last_seen_at desc, w.id
              limit 1)`,
    );
  });
  return { rescheduleAt: new Date(ctx.now + DAY) };
}
