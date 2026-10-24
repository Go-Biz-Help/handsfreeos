/**
 * Follow-ups (plan M7, "Other work"; Automations' "Follow-ups after silence"), `ai_teammate.follow_up`: the
 * customer went quiet after the teammate asked them something (nudges.ts armed it on the business's ladder).
 * Before each one it checks that it still should:
 * - the teammate still has the conversation (no hand-off, no take-over) and still follows up;
 * - they haven't written since, nothing got booked, and no draft waits for a person;
 * - their lead isn't won, lost or ruled out as not a fit, and they haven't texted STOP;
 * - the ladder isn't used up, and no funnel has them (the funnel follows up instead).
 * Then it waits for the teammate's working hours (and, for a text, the end of quiet hours, unless it's one of the
 * quick ones: nudges.ts goesInQuietHours), going at a random time early on (spreadAfter), and runs the follow-up
 * (run.ts runNudge), which in training becomes a draft. When the message they didn't answer offered times, it
 * first checks which are still open, so the follow-up offers those and never one that's gone.
 */
import { eq } from 'drizzle-orm';
import {
  calendarAvailability,
  executeQuery,
  followUpScheduleMinutes,
  loadTeammate,
  openHoursOf,
  workspaceMessaging,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { quietEndAt } from '../booking/deliver';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { answersChannel, runtimeConfigOf } from './config';
import { inFunnel } from './funnel-context';
import { TEAMMATE_JOBS } from './constants';
import { nextWorkingAt } from './hours';
import {
  followsUp,
  goesInQuietHours,
  nextFollowUpAt,
  offeredOf,
  spreadAfter,
  unansweredOf,
  type OfferedSlot,
} from './nudges';
import { runNudge, type NudgeSpec } from './run';

type Due =
  | { readonly wait: Date }
  | {
      readonly n: number;
      readonly lastAt: number;
      readonly total: number;
      readonly monthly: boolean;
      readonly neverWrote: boolean;
      readonly offered: readonly OfferedSlot[];
    };

/** Which of the offered times are still open (and still ahead), by the calendar's own availability. */
async function stillOpen(
  db: Db,
  scope: TenantScope,
  offered: readonly OfferedSlot[],
  jobId: string,
): Promise<{ label: string; startsAt: string; open: boolean }[]> {
  const now = Date.now();
  const out: { label: string; startsAt: string; open: boolean }[] = [];
  const byCalendar = new Map<string, OfferedSlot[]>();
  for (const o of offered)
    byCalendar.set(o.calendarId, [...(byCalendar.get(o.calendarId) ?? []), o]);
  for (const [calendarId, slots] of byCalendar) {
    const ahead = slots.filter((s) => Date.parse(s.startsAt) > now);
    for (const s of slots)
      if (Date.parse(s.startsAt) <= now)
        out.push({ label: s.label, startsAt: s.startsAt, open: false });
    if (!ahead.length) continue;
    const from = Math.min(...ahead.map((s) => Date.parse(s.startsAt)));
    const to = Math.max(...ahead.map((s) => Date.parse(s.startsAt))) + 60_000;
    let open = new Set<number>();
    try {
      const got = await executeQuery(
        db,
        calendarAvailability,
        {
          workspaceId: scope.workspaceId,
          calendarId,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          serviceId: ahead[0]!.serviceId,
          ...(ahead[0]!.durationMinutes ? { durationMinutes: ahead[0]!.durationMinutes } : {}),
        },
        systemActor(scope),
        workerMeta(null, jobId),
      );
      open = new Set(got.slots.map((x) => Date.parse(x.startsAt)));
    } catch {
      // The calendar changed under it (archived, a length it no longer offers): none of them can be promised.
    }
    for (const s of ahead)
      out.push({ label: s.label, startsAt: s.startsAt, open: open.has(Date.parse(s.startsAt)) });
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export const followUpJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId =
    typeof ctx.job.payload['conversationId'] === 'string'
      ? ctx.job.payload['conversationId']
      : null;
  if (!conversationId) return;
  const carried = offeredOf(ctx.job.payload['offered']);
  const due = await asWorker(ctx.db, scope, async (tx): Promise<Due | null> => {
    const teammate = await loadTeammate(tx, scope.workspaceId);
    if (!teammate || teammate.status === 'off') return null;
    const config = runtimeConfigOf(teammate.config);
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (
      !conv ||
      conv.handledBy !== 'ai' ||
      conv.aiTeammateId !== teammate.id ||
      !answersChannel(config, conv.channel)
    )
      return null;
    const u = await unansweredOf(tx, conv.id);
    if (!u || !followsUp(config, u)) return null;
    // Inside a funnel, the funnel follows up.
    if (await inFunnel(tx, conv.personId)) return null;
    const since = new Date(u.anchorAt).toISOString();
    const [stop] = await rows<{
      booked: boolean;
      waiting: boolean;
      closed: boolean;
      opted_out: boolean;
    }>(
      tx,
      sql`select
            exists (select 1 from app.appointment_attendees t where t.workspace_id = ${scope.workspaceId}
              and t.person_id = ${conv.personId} and t.status = 'booked'
              and t.created_at > ${since}::timestamptz) as booked,
            exists (select 1 from app.ai_teammate_drafts d where d.conversation_id = ${conv.id}
              and d.status = 'pending') as waiting,
            -- Their lead was won, lost or ruled out since, and they have no other open one.
            (exists (select 1 from app.leads l where l.workspace_id = ${scope.workspaceId}
                and l.person_id = ${conv.personId}
                and (l.status <> 'open' or l.qualification ->> 'status' = 'not_a_fit')
                and l.updated_at > ${since}::timestamptz)
              and not exists (select 1 from app.leads l where l.workspace_id = ${scope.workspaceId}
                and l.person_id = ${conv.personId} and l.status = 'open' and l.archived_at is null
                and coalesce(l.qualification ->> 'status', '') <> 'not_a_fit')) as closed,
            (${conv.channel} = 'sms' and exists (select 1 from app.opt_outs o
              where o.workspace_id = ${scope.workspaceId} and o.counterpart_e164 = ${conv.counterpart}
                and o.opted_out)) as opted_out`,
    );
    if (stop?.booked || stop?.waiting || stop?.closed || stop?.opted_out) return null;
    // The ladder is used up (or the business shortened it since this was armed).
    if (nextFollowUpAt(config, u, carried, u.anchorAt) === null) return null;
    const now = Date.now();
    const m = await workspaceMessaging(tx, scope.workspaceId);
    const tz = m.timezone || 'UTC';
    const working = nextWorkingAt(config, openHoursOf(m.rawSettings), tz, now);
    if (working > now) return { wait: new Date(spreadAfter(working)) };
    if (conv.channel === 'sms' && !goesInQuietHours(config, u, now)) {
      const end = quietEndAt(m.settings.quietHours, tz, now);
      if (end !== null) return { wait: new Date(spreadAfter(end)) };
    }
    return {
      n: u.sent + 1,
      lastAt: u.anchorAt,
      total: followUpScheduleMinutes(config.followUp).length,
      monthly: u.sent + 1 > config.followUp.ladder.length,
      neverWrote: u.neverWrote,
      offered: u.sent === 0 && config.followUp.chaseTimes ? carried : [],
    };
  });
  if (!due) return;
  if ('wait' in due) return { rescheduleAt: due.wait };
  const spec: NudgeSpec = {
    n: due.n,
    lastAt: due.lastAt,
    total: due.total,
    monthly: due.monthly,
    neverWrote: due.neverWrote,
    offered: due.offered.length ? await stillOpen(ctx.db, scope, due.offered, ctx.job.id) : [],
  };
  return runNudge(ctx, scope, conversationId, spec, TEAMMATE_JOBS.followUp);
};
