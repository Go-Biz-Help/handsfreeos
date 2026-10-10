/**
 * The weekly report (docs/outreach.md, decision 34; core's rules in packages/core/src/addons/outreach/results.ts):
 * one job per business (`outreach.weekly`), on Monday at the morning push's hour (8 when that's off), in the
 * business's time zone. Each person who can use Social Outreach and noted a step in the last 7 days gets an email of
 * their week, worked out as the activity panel and the results card work it out (`outreach.activity`,
 * `outreach.openers`, asked on their behalf): friend requests, chats started, replies and demos, their best group and
 * their best opener. An owner or admin also gets the team's when more than one person did outreach. It comes back the
 * next Monday, and it's armed whenever the morning push is.
 *
 * An owner or admin can turn it off (Add-ons → Social Outreach); each person can turn off add-on emails
 * (Settings → Account).
 */
import type { OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { activity } from '@hfos/core/addons/outreach/ops/activity';
import { openers } from '@hfos/core/addons/outreach/ops/openers';
import type { OpenersOutput } from '@hfos/core/addons/outreach/openers';
import {
  bestGroup,
  bestOpener,
  nextWeekly,
  resultWords,
  WEEKLY_HOUR,
} from '@hfos/core/addons/outreach/results';
import { executeQuery } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { outreachWeeklyEmail } from '../../emails/templates';
import type { JobResult } from '../../jobs';
import { scheduleAddonJob } from '../queue';
import type { AddonJobContext, AddonScopeContext } from '../types';
import { businessOf } from './alerts';

export const WEEKLY_JOB = 'outreach.weekly';
const ACTIVITY_HREF = '/a/outreach?view=activity';
const HOUR = 3_600_000;
/** A report that runs this late (the worker was down) still goes; later, it waits for the next Monday. */
const WEEKLY_LATE_MS = 12 * HOUR;
/** Who did outreach in the week: a step noted in this many days. */
const WEEK_DAYS = 7;

const hourOf = (settings: OutreachSettings) => settings.morningPushHour ?? WEEKLY_HOUR;

/** Queues the next weekly report, or moves it sooner; nothing when the business turned it off. */
export async function armWeekly(ctx: AddonScopeContext, now = Date.now()): Promise<void> {
  const { settings, tz } = await businessOf(ctx);
  if (!settings.weeklyReport) return;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: WEEKLY_JOB,
        dedupeKey: `${WEEKLY_JOB}:${ctx.scope.workspaceId}`,
        runAt: nextWeekly(now, tz, hourOf(settings)),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

type Reader = {
  readonly id: string;
  readonly email: string;
  readonly wants_email: boolean;
  readonly manages: boolean;
};

/** Everyone who can use Social Outreach here and noted a step in the week. */
async function weekPeople(ctx: AddonJobContext): Promise<Reader[]> {
  const since = new Date(ctx.now - WEEK_DAYS * 24 * HOUR).toISOString();
  return asWorker(ctx.db, ctx.scope, (tx) =>
    rows<Reader>(
      tx,
      sql`select u.id, u.email::text as email,
            coalesce((u.settings -> 'notifications' ->> 'addonEmail')::boolean, true) as wants_email,
            'outreach.manage' = any (wa.permissions) as manages
          from app.users u
          join app.workspace_access wa on wa.user_id = u.id and wa.workspace_id = ${ctx.scope.workspaceId}
          where u.deleted_at is null and 'outreach.use' = any (wa.permissions)
            and exists (select 1 from addon_outreach.touches t
              where t.workspace_id = wa.workspace_id and t.user_id = u.id and t.at >= ${since}::timestamptz)
          order by u.id`,
    ),
  );
}

/** The person's best opener of the week, with its playbook's name. */
function bestOf(list: OpenersOutput) {
  const best = bestOpener(
    list.playbooks.flatMap((p) => p.openers.map((o) => ({ ...o, playbook: p.name }))),
  );
  return best
    ? {
        text: best.text,
        playbook: best.playbook,
        sent: best.sent,
        replies: best.replies,
        demos: best.demos,
      }
    : null;
}

/** `outreach.weekly`: each person's week, by email, then next Monday's. */
export async function weeklyJob(ctx: AddonJobContext): Promise<JobResult> {
  const { settings, name, tz } = await businessOf(ctx);
  // Turned off: nothing now, and nothing more until it's turned on again.
  if (!settings.weeklyReport) return;
  const hour = hourOf(settings);
  const due = nextWeekly(ctx.now - WEEKLY_LATE_MS, tz, hour).getTime();
  // Moved to a later hour, or the worker was down past the morning: the next one.
  if (due > ctx.now) return { rescheduleAt: nextWeekly(ctx.now, tz, hour) };
  const people = await weekPeople(ctx);
  const ws = ctx.scope.workspaceId;
  for (const person of people.filter((p) => p.wants_email)) {
    try {
      const as = { ...ctx.actor, onBehalfOf: person.id };
      const week = await executeQuery(
        ctx.db,
        activity,
        { workspaceId: ws, period: 'week' },
        as,
        ctx.meta,
      );
      const opened = await executeQuery(
        ctx.db,
        openers,
        { workspaceId: ws, period: 'week' },
        as,
        ctx.meta,
      );
      const team =
        person.manages && people.length > 1
          ? await executeQuery(
              ctx.db,
              activity,
              { workspaceId: ws, period: 'week', everyone: true },
              as,
              ctx.meta,
            )
          : null;
      const group = bestGroup(week.groups);
      const mail = outreachWeeklyEmail({
        business: name,
        numbers: week.numbers,
        bestGroup: group ? { name: group.name ?? 'A group', results: resultWords(group) } : null,
        bestOpener: bestOf(opened),
        team: team
          ? {
              people: people.length,
              friendRequests: team.numbers.friendRequests,
              replies: team.numbers.replies,
              demos: team.numbers.demos,
            }
          : null,
        link: `${ctx.webUrl}/app/w/${ws}${ACTIVITY_HREF}`,
      });
      await ctx.mailer.send({ to: person.email, ...mail });
    } catch (e) {
      ctx.log.warn(
        { err: e instanceof Error ? e.message : String(e), userId: person.id },
        'could not send a weekly outreach report',
      );
    }
  }
  return { rescheduleAt: nextWeekly(ctx.now + 60_000, tz, hour) };
}
