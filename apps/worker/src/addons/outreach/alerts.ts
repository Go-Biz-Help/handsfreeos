/**
 * Phone alerts (docs/outreach.md, decision 22; core's rules in packages/core/src/addons/outreach/alerts.ts):
 *
 * - **A reply** the extension saw (`outreach.reply.seen`) is pushed to the person at once, unless they were looking
 *   at it: "Dana Reyes wrote back".
 * - **A reply handed over** (`outreach.send.queued`, decision 27): with Replies (b) or (c), a reply that waits for the
 *   person after all, because it isn't simple or they need the person, is pushed at once, whatever their pushes
 *   setting says (./waiting.ts), and opens Waiting for you: "Dana Reyes needs you".
 * - **Someone accepted** the person's friend request, invitation or follow (`outreach.friend.accepted`, decision
 *   101): pushed at once when they switched it on, one push for everyone a list showed: "Dana Reyes accepted your
 *   friend request". Off to start.
 * - **The morning push** (`outreach.morning`, one job per business): at the business's hour, each person who noted a
 *   step lately and has something on their list for today hears how much, worked out as their list is
 *   (`outreach.today`, asked on their behalf). It comes back the next morning. A change to the hour moves it; it's
 *   armed when the add-on comes on, and whenever the extension sends something, so a business that had the add-on
 *   on before the push existed gets it too.
 *
 * Each goes to the person alone, on their add-ons switch, and opens Today, or Waiting for you for a reply handed over
 * (`pushAddonNotice`).
 */
import {
  acceptedPushWords,
  MORNING_ACTIVE_DAYS,
  morningPushWords,
  nextMorning,
  replyPushWords,
} from '@hfos/core/addons/outreach/alerts';
import { outreachSettings, type OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { handOverPushWords } from '@hfos/core/addons/outreach/sends';
import { automationGet } from '@hfos/core/addons/outreach/ops/automation';
import { today } from '@hfos/core/addons/outreach/ops/today';
import { networksShown } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { doneOnItsOwn, type TodayOutput } from '@hfos/core/addons/outreach/today';
import { executeQuery, localDateOf, workspaceMessaging } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { WAITING_HREF } from './waiting';

export const MORNING_JOB = 'outreach.morning';
const TODAY_HREF = '/a/outreach?view=today';
const HOUR = 3_600_000;
/** A morning push that runs this late (the worker was down) waits for the next morning. */
const MORNING_LATE_MS = 3 * HOUR;

/** Social Outreach's settings for the business, and its name and time zone. */
export async function businessOf(
  ctx: AddonScopeContext,
): Promise<{ settings: OutreachSettings; name: string; tz: string }> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [installed] = await rows<{ settings: unknown }>(
      tx,
      sql`select settings from app.addon_installations
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}`,
    );
    const m = await workspaceMessaging(tx, ctx.scope.workspaceId);
    return {
      settings: outreachSettings(installed?.settings),
      name: m.name,
      tz: m.timezone || 'UTC',
    };
  });
}

/** The business's hour for the morning push, and its time zone. */
async function morningOf(ctx: AddonScopeContext): Promise<{ hour: number | null; tz: string }> {
  const { settings, tz } = await businessOf(ctx);
  return { hour: settings.morningPushHour, tz };
}

/** Queues the next morning push, or moves it sooner; nothing when the business turned it off. */
export async function armMorning(ctx: AddonScopeContext, now = Date.now()): Promise<void> {
  const { hour, tz } = await morningOf(ctx);
  if (hour === null) return;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: MORNING_JOB,
        dedupeKey: `${MORNING_JOB}:${ctx.scope.workspaceId}`,
        runAt: nextMorning(now, tz, hour),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `addon.settings_saved`: Social Outreach's own settings may have moved the morning push. */
export async function settingsSaved(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (p['addonId'] !== undefined && p['addonId'] !== ctx.manifest.id) return;
  await armMorning(ctx);
}

/** `outreach.reply.seen`: the person's phone hears who wrote back, unless they were looking. */
export async function replySeen(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as {
    userId?: string;
    profileIds?: string[];
    push?: boolean;
  };
  if (p.push && p.userId && p.profileIds?.length) {
    const userId = p.userId;
    await asWorker(ctx.db, ctx.scope, async (tx) => {
      const found = await rows<{ id: string; name: string; person_id: string | null }>(
        tx,
        sql`select id, name, person_id from addon_outreach.profiles
            where workspace_id = ${ctx.scope.workspaceId}
              and id = any (${`{${p.profileIds!.join(',')}}`}::uuid[])`,
      );
      for (const profile of found)
        await pushAddonNotice(ctx, tx, {
          key: `reply:${ctx.event.id}:${profile.id}`,
          userIds: [userId],
          permission: 'outreach.use',
          ...replyPushWords(profile.name),
          href: TODAY_HREF,
          collapseKey: `reply-${profile.id}`,
          personId: profile.person_id,
        });
    });
  }
  await armMorning(ctx);
}

/** `outreach.friend.accepted`: on their switch, the person's phone hears who accepted, in one push. */
export async function requestAccepted(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as {
    userId?: string;
    platform?: Platform;
    profileIds?: string[];
    push?: boolean;
  };
  if (!p.push || !p.userId || !p.platform || !p.profileIds?.length) return;
  const { userId, platform } = p;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const found = await rows<{ id: string; name: string; person_id: string | null }>(
      tx,
      sql`select id, name, person_id from addon_outreach.profiles
          where workspace_id = ${ctx.scope.workspaceId}
            and id = any (${`{${p.profileIds!.join(',')}}`}::uuid[])
          order by name, id`,
    );
    if (!found.length) return;
    const one = found.length === 1 ? found[0]! : null;
    await pushAddonNotice(ctx, tx, {
      key: `accepted:${ctx.event.id}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...acceptedPushWords(
        found.map((f) => f.name),
        platform,
      ),
      href: TODAY_HREF,
      collapseKey: one ? `accepted-${one.id}` : null,
      personId: one?.person_id ?? null,
    });
  });
}

/** `outreach.send.queued`: a reply handed over to the person (decision 27) is pushed to them, with why. */
export async function handOver(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as {
    handOver?: boolean;
    userId?: string;
    why?: string | null;
  };
  if (!p.handOver || !p.userId || !ctx.event.entityId) return;
  const userId = p.userId;
  const profileId = ctx.event.entityId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [profile] = await rows<{ name: string; person_id: string | null }>(
      tx,
      sql`select name, person_id from addon_outreach.profiles
          where workspace_id = ${ctx.scope.workspaceId} and id = ${profileId}`,
    );
    if (!profile) return;
    await pushAddonNotice(ctx, tx, {
      key: `hand-over:${ctx.event.id}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...handOverPushWords(profile.name, p.why ?? null),
      href: WAITING_HREF,
      // The same chat's "wrote back" gives way to it.
      collapseKey: `reply-${profileId}`,
      personId: profile.person_id,
    });
  });
}

/** The people to hear in the morning: those who can use Social Outreach here and noted a step lately. */
async function morningPeople(ctx: AddonJobContext): Promise<string[]> {
  const since = new Date(ctx.now - MORNING_ACTIVE_DAYS * 24 * HOUR).toISOString();
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

/** `outreach.morning`: each person's list for today, in a push, then the next morning's. */
export async function morningJob(ctx: AddonJobContext): Promise<JobResult> {
  const { hour, tz } = await morningOf(ctx);
  // Turned off: nothing now, and nothing more until it's turned on again.
  if (hour === null) return;
  const due = nextMorning(ctx.now - MORNING_LATE_MS, tz, hour).getTime();
  // Moved to a later hour, or the worker was down past the morning: the next one.
  if (due > ctx.now) return { rescheduleAt: nextMorning(ctx.now, tz, hour) };
  const day = localDateOf(ctx.now, tz);
  for (const userId of await morningPeople(ctx)) {
    const actor = { ...ctx.actor, onBehalfOf: userId };
    const workspaceId = ctx.scope.workspaceId;
    let theirs: { platform: Platform; items: TodayOutput['items'] }[];
    try {
      // Each network they work, as Today's strip shows them: Facebook's alone when they work none.
      const mine = await executeQuery(ctx.db, automationGet, { workspaceId }, actor, ctx.meta);
      theirs = [];
      for (const platform of networksShown(mine.settings, mine.rules.networksAllowed)) {
        const list = await executeQuery(ctx.db, today, { workspaceId, platform }, actor, ctx.meta);
        // What the extension does on its own isn't theirs to do. A partner's steps are on the list too (decision 81).
        const items = [...list.items, ...list.partners].filter(
          (item) => !doneOnItsOwn(item.kind, list.auto),
        );
        if (items.length) theirs.push({ platform, items });
      }
    } catch (e) {
      ctx.log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'no list for a morning push',
      );
      continue;
    }
    const words = morningPushWords(
      theirs.flatMap((t) => t.items),
      theirs.map((t) => t.platform),
    );
    if (!words) continue;
    await asWorker(ctx.db, ctx.scope, (tx) =>
      pushAddonNotice(ctx, tx, {
        key: `morning:${userId}:${day}`,
        userIds: [userId],
        permission: 'outreach.use',
        ...words,
        href: TODAY_HREF,
        collapseKey: `morning-${userId}`,
      }),
    );
  }
  return { rescheduleAt: nextMorning(ctx.now + 60_000, tz, hour) };
}
