/**
 * Pushes about what waits for the person (docs/outreach.md, decision 40; core's rules in
 * packages/core/src/addons/outreach/waiting-words.ts), as their `pushes` setting says:
 *
 * - **Bundled** (the default): a message that waits for their OK (`outreach.send.queued` with `waits`) or a step the
 *   extension needs them for (`outreach.need.noted`) arms one job a person (`outreach.waiting_push`). It runs 10
 *   minutes on, to gather the rest, no sooner than 2 hours after their last one, and in their working hours: "5
 *   messages wait for your OK". It pushes only when a message or step began to wait (reached HandsFreeOS) since the
 *   last one, and keeps when it went (`waiting_pushes`), in the same transaction as the push. Replies handed over
 *   aren't in it: each pushed on its own.
 * - **One for each**: each such message or need pushes at once: "Dana Reyes: a message waits for your OK", a comment
 *   on a good post (decision 92): "A comment on Quinn Harper’s post waits for your OK", and a need with its network:
 *   "Dana Reyes: the extension needs you on Alignable". The bundle counts comments with the messages.
 *
 * A reply handed over pushes at once whatever the setting (./alerts.ts), and friend requests they got never push:
 * Facebook tells people of those itself. Someone accepting theirs pushes only when they switched that on (./alerts.ts,
 * decision 101). Every push goes to the person alone, on their add-ons switch, and opens Waiting for
 * you. What they choose and their hours are read as their Waiting for you reads them (`outreach.waiting`, asked on
 * their behalf), so the phone and the extension's pop-ups follow one rule.
 */
import { underAPost } from '@hfos/core/addons/outreach/automation';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { waiting } from '@hfos/core/addons/outreach/ops/waiting';
import type { WaitingOutput } from '@hfos/core/addons/outreach/waiting';
import {
  bundleAt,
  bundleDue,
  bundlePushWords,
  eachPushWords,
  newestNudgeAt,
  nudgeCount,
  type BundleTiming,
} from '@hfos/core/addons/outreach/waiting-words';
import { HfosError } from '@hfos/core';
import { executeQuery } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const WAITING_PUSH_JOB = 'outreach.waiting_push';
export const WAITING_HREF = '/a/outreach?view=waiting';

/** Refused because the person may not use Social Outreach here, or it's turned off (`addon_inactive`, a 403). */
export const refusedForGood = (e: unknown): e is HfosError =>
  e instanceof HfosError && (e.status === 401 || e.status === 403 || e.status === 404);

/** The person's Waiting for you, counted only: their choice of pushes, their hours and the business's time zone too. */
async function waitingOf(ctx: AddonScopeContext, userId: string): Promise<WaitingOutput | null> {
  try {
    return await executeQuery(
      ctx.db,
      waiting,
      { workspaceId: ctx.scope.workspaceId, items: false },
      { ...ctx.actor, onBehalfOf: userId },
      ctx.meta,
    );
  } catch (e) {
    // Anything else (a dropped connection, a timeout) is tried again: the push keys stop a second push.
    if (!refusedForGood(e)) throw e;
    // They can't use Social Outreach here any more, or it was turned off: nothing to tell them.
    ctx.log.warn({ err: e.message, rule: e.rule, userId }, 'no Waiting for you for a push');
    return null;
  }
}

/** When the person last got the bundled push: null when never. */
async function lastPushOf(ctx: AddonScopeContext, userId: string): Promise<number | null> {
  const [kept] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ pushed_at: Date | string }>(
      tx,
      sql`select pushed_at from addon_outreach.waiting_pushes
          where workspace_id = ${ctx.scope.workspaceId} and user_id = ${userId}`,
    ),
  );
  return kept ? new Date(kept.pushed_at).getTime() : null;
}

const timingOf = (list: WaitingOutput, now: number, lastAt: number | null): BundleTiming => ({
  now,
  lastAt,
  hours: list.hours,
  timeZone: list.timezone,
});

/** Queues the person's bundled push, or moves it sooner. */
async function armBundle(
  ctx: AddonEventContext,
  userId: string,
  list: WaitingOutput,
  now = Date.now(),
): Promise<void> {
  const runAt = bundleAt(timingOf(list, now, await lastPushOf(ctx, userId)));
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: WAITING_PUSH_JOB,
        dedupeKey: `${WAITING_PUSH_JOB}:${userId}`,
        runAt: new Date(runAt),
        payload: { userId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** What began to wait, for a push of its own. */
interface Nudge {
  readonly kind: 'message' | 'comment' | 'need';
  readonly profileId: string;
  readonly name: string;
  readonly personId: string | null;
  readonly why: string | null;
  /** A need's network, which its push names. */
  readonly platform?: Platform;
}

/** Something began to wait for the person: a push now, or the bundled one armed, as they chose. */
async function nudge(ctx: AddonEventContext, userId: string, what: Nudge): Promise<void> {
  const list = await waitingOf(ctx, userId);
  if (!list) return;
  if (list.pushes === 'bundled') return armBundle(ctx, userId, list);
  await asWorker(ctx.db, ctx.scope, (tx) =>
    pushAddonNotice(ctx, tx, {
      key: `waiting:${ctx.event.id}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...eachPushWords(what.kind, what.name, what.why, what.platform ?? null),
      href: WAITING_HREF,
      // The same person's newer one replaces it on the phone.
      collapseKey: `waiting-${what.profileId}`,
      personId: what.personId,
    }),
  );
}

/**
 * `outreach.send.queued`: a message, or a comment (decision 92), that waits for the person's OK. A reply handed over
 * isn't one: it pushes at once by itself (./alerts.ts).
 */
export async function sendWaits(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as {
    waits?: boolean;
    handOver?: boolean;
    userId?: string;
    kind?: string;
  };
  if (!p.waits || p.handOver || !p.userId || !ctx.event.entityId) return;
  const userId = p.userId;
  const profileId = ctx.event.entityId;
  // A reply in a group goes under its post as a comment does (decision 114).
  const comment = p.kind !== undefined && underAPost(p.kind);
  const [still] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ name: string; person_id: string | null }>(
      tx,
      sql`select p.name, p.person_id from addon_outreach.sends s
          join addon_outreach.profiles p on p.workspace_id = s.workspace_id and p.id = s.profile_id
          where s.workspace_id = ${ctx.scope.workspaceId} and s.user_id = ${userId}
            and s.profile_id = ${profileId} and s.state = 'waiting'
            and ${comment ? sql`s.kind in ('comment', 'group_reply')` : sql`s.kind not in ('comment', 'group_reply')`}
          limit 1`,
    ),
  );
  // OK'd or skipped already: nothing waits.
  if (!still) return;
  await nudge(ctx, userId, {
    kind: comment ? 'comment' : 'message',
    profileId,
    name: still.name,
    personId: still.person_id,
    why: null,
  });
}

/** `outreach.need.noted`: a step the extension couldn't do, handed to the person. */
export async function needNoted(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { userId?: string };
  if (!p.userId || !ctx.event.entityId) return;
  const userId = p.userId;
  const [need] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      profile_id: string;
      name: string;
      why: string;
      person_id: string | null;
      platform: Platform;
    }>(
      tx,
      sql`select n.profile_id, n.name, n.why, p.person_id, p.platform from addon_outreach.needs n
          join addon_outreach.profiles p on p.workspace_id = n.workspace_id and p.id = n.profile_id
          where n.workspace_id = ${ctx.scope.workspaceId} and n.id = ${ctx.event.entityId}
            and n.user_id = ${userId} and n.state = 'open'`,
    ),
  );
  // Done or let go already.
  if (!need) return;
  await nudge(ctx, userId, {
    kind: 'need',
    profileId: need.profile_id,
    name: need.name,
    personId: need.person_id,
    why: need.why,
    platform: need.platform,
  });
}

/**
 * `outreach.waiting_push`: the person's bundled push, when it's due and something began to wait since the last one.
 * Not due yet (their hours, or the last one under 2 hours ago): it comes back when it is. Switched to one for each, or
 * nothing new: nothing, until the next new one arms it again.
 */
export async function waitingPushJob(ctx: AddonJobContext): Promise<JobResult> {
  const userId = ctx.job.payload['userId'];
  if (typeof userId !== 'string') return;
  const list = await waitingOf(ctx, userId);
  if (!list || list.pushes !== 'bundled') return;
  const lastAt = await lastPushOf(ctx, userId);
  const timing = timingOf(list, ctx.now, lastAt);
  if (!bundleDue(timing)) return { rescheduleAt: new Date(bundleAt(timing)) };
  const newest = newestNudgeAt(list.kinds);
  if (!nudgeCount(list.kinds) || newest === null || (lastAt !== null && newest <= lastAt)) return;
  const words = bundlePushWords(list.kinds);
  if (!words) return;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    await pushAddonNotice(ctx, tx, {
      // One for each time it went: run again, it's the same push.
      key: `waiting:${ctx.scope.workspaceId}:${userId}:${lastAt ?? 'first'}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...words,
      href: WAITING_HREF,
      // A newer one replaces the older on the phone.
      collapseKey: `waiting-${userId}`,
    });
    await rows(
      tx,
      sql`insert into addon_outreach.waiting_pushes (workspace_id, user_id, pushed_at)
          values (${ctx.scope.workspaceId}, ${userId}, ${new Date(ctx.now).toISOString()}::timestamptz)
          on conflict (workspace_id, user_id) do update set pushed_at = excluded.pushed_at`,
    );
  });
}
