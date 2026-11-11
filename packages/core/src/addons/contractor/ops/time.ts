/**
 * Time on a job (docs/contractor.md, "Time and job costing"; the owner's decision 10): travel and work time from
 * the buttons a crew already taps on a visit, a Break button for one person, and fixes by someone who may. The rules
 * (what starts and stops, how long, what a fix may be) are pure, in ../time.ts.
 *
 * - **The buttons.** The worker hands each of core's `job.status_changed` on a visit to
 *   `contractor.time.follow_status`, with the moment the button was really pressed. What's running on the visit
 *   stops there, and On the way or Started starts a stretch for everyone on the visit (or for whoever pressed it,
 *   when nobody is). Safe to run again, and for news that arrives late: a moment at or before a stretch the
 *   buttons already started on the visit changes nothing.
 * - **Nobody is in two places.** One running stretch per person in a business, held by the table. Starting one
 *   stops whatever else that person had running.
 * - **What an hour cost** is kept apart (`time_costs`), where row security lets only people who may see job costs
 *   read it (the owner's decision 11), and kept as it was when the time was tracked. Only the system writes it
 *   (`contractor.time.stamp_costs`): a person's own cost per hour, else the business's labor cost in Estimating.
 * - **Fixing** takes `contractor.fix_time` and a reason, kept on the stretch and on the job's timeline. It's
 *   allowed on a finished job too: that's when the numbers get checked.
 */
import { and, desc, eq, gt, isNull, lt, lte, ne, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { fmtAt } from '../../../calendar/when';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { contractorAddon } from '../manifest';
import {
  LaborRateListInput,
  LaborRateListOutput,
  LaborRateSetInput,
  LaborRateSetOutput,
  LIMITS,
  TimeAddInput,
  TimeChangeOutput,
  TimeFixInput,
  TimeFollowStatusInput,
  TimeFollowStatusOutput,
  TimeListInput,
  TimeListOutput,
  TimeRemoveInput,
  TimeSetBreakInput,
  TimeSetBreakOutput,
  TimeStampCostsInput,
  TimeStampCostsOutput,
  TimeStopOverrunInput,
  TimeStopOverrunOutput,
} from '../schemas';
import { laborRates, timeEntries } from '../tables';
import {
  clockFor,
  fixProblem,
  limitOf,
  MAX_RUNNING_HOURS,
  secondsOf,
  type TimeKind,
  type TimeSource,
} from '../time';
import {
  CONTRACTOR_WORDS as W,
  FIX_PROBLEM_WORDS,
  namesWords,
  REFUSALS,
  stretchWords,
  timeAmountWords,
} from '../words';
import {
  inWorkspace,
  jobLine,
  loadJob,
  requireCanWork,
  timeZoneOf,
  userName,
  type Ctx,
  type Job,
} from './common';
import { estimatingOf } from './estimates';
import { peopleOf } from './queries';
import { loadVisit, visitNotOnJob } from './visits';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const pathOf = (io: unknown) => {
  const jobId = (io as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === 'string' ? jobPath(jobId) : 'a/contractor';
};
const mayFix = (ctx: Ctx) => scopeCan(ctx.scope, 'contractor.fix_time' as Permission);
const iso = (v: string | Date) => new Date(v).toISOString();

type Entry = typeof timeEntries.$inferSelect;

/** One person at a time: two changes to the same person's clock wait for each other. */
const lockPerson = (ctx: CommandContext, userId: string) =>
  ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`contractor.time:${ctx.scope.workspaceId!}:${userId}`}, 0))`,
  );

// ------------------------------------------------------------------------------------------------ reading

export const timeList = defineAddonQuery(contractorAddon, {
  name: 'contractor.time.list',
  description:
    'The time tracked on a job, or on one of its visits: each stretch of travel, work or break, whose it is and how long, with the totals. Never what it cost.',
  input: TimeListInput,
  output: TimeListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_time',
    description:
      'The time tracked on a job (by job id; appointmentId keeps to one visit): each stretch with its entry id, whose it is, the visit, what it is (travel, work or break), when it started and ended (null while running), how long, whether it was stopped on its own after 12 hours or fixed (by whom and why), and the totals of work, travel and break time. What the time cost is in contractor_get_job_costing, for people who may see job costs.',
    keywords: ['time', 'hours', 'timesheet', 'on the clock', 'break', 'travel time'],
  },
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const visit = input.appointmentId ? sql` and t.appointment_id = ${input.appointmentId}` : sql``;
    const [list, sums] = await Promise.all([
      rows<{
        id: string;
        user_id: string | null;
        name: string | null;
        appointment_id: string | null;
        kind: TimeKind;
        started_at: string;
        ended_at: string | null;
        source: TimeSource;
        auto_stopped: boolean;
        fixed_at: string | null;
        fix_reason: string | null;
        fixed_by: string | null;
      }>(
        ctx.tx,
        sql`select t.id, t.user_id, coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name,
              t.appointment_id, t.kind, t.started_at::text, t.ended_at::text, t.source, t.auto_stopped,
              t.fixed_at::text, t.fix_reason,
              coalesce(nullif(btrim(f.full_name), ''), f.email::text) as fixed_by
            from addon_contractor.time_entries t
            left join app.users u on u.id = t.user_id
            left join app.users f on f.id = t.fixed_by
            where t.record_id = ${job.recordId} and t.workspace_id = ${ws}${visit}
            order by t.started_at desc, t.id
            limit ${LIMITS.timeEntries + 1}`,
      ),
      rows<{ kind: TimeKind; seconds: number; running: number }>(
        ctx.tx,
        sql`select t.kind,
              coalesce(sum(extract(epoch from (coalesce(t.ended_at, now()) - t.started_at))), 0)::float8 as seconds,
              (count(*) filter (where t.ended_at is null))::int as running
            from addon_contractor.time_entries t
            where t.record_id = ${job.recordId} and t.workspace_id = ${ws}${visit}
            group by t.kind`,
      ),
    ]);
    const now = Date.now();
    const of = (kind: TimeKind) =>
      Math.max(0, Math.round(Number(sums.find((s) => s.kind === kind)?.seconds ?? 0)));
    const me = userIdOf(ctx.actor);
    const entries = list.slice(0, LIMITS.timeEntries).map((t) => ({
      id: t.id,
      userId: t.user_id,
      name: t.name ?? W.time.gone,
      appointmentId: t.appointment_id,
      kind: t.kind,
      startedAt: iso(t.started_at),
      endedAt: t.ended_at ? iso(t.ended_at) : null,
      seconds: secondsOf(
        {
          startedAt: new Date(t.started_at).getTime(),
          endedAt: t.ended_at ? new Date(t.ended_at).getTime() : null,
        },
        now,
      ),
      source: t.source,
      autoStopped: t.auto_stopped,
      fixed:
        t.fixed_at && t.fix_reason
          ? { by: t.fixed_by, at: iso(t.fixed_at), reason: t.fix_reason }
          : null,
    }));
    const mine = me ? entries.find((e) => e.userId === me && e.endedAt === null) : undefined;
    return {
      jobId: job.recordId,
      entries,
      totals: {
        workSeconds: of('work'),
        travelSeconds: of('travel'),
        breakSeconds: of('break'),
        paidSeconds: of('work') + of('travel'),
        running: sums.reduce((n, s) => n + s.running, 0),
      },
      mine: mine ? { entryId: mine.id, appointmentId: mine.appointmentId, kind: mine.kind } : null,
      may: { fix: mayFix(ctx) },
      truncated: list.length > LIMITS.timeEntries,
    };
  },
});

// ------------------------------------------------------------------------------------------------ what's shared

/**
 * Stops these stretches at a moment. Never before one started: a break starts at the server's time and a button's
 * moment is the phone's, and the two clocks are never quite the same.
 */
async function stopAt(ctx: CommandContext, list: readonly Entry[], at: Date): Promise<number> {
  for (const e of list)
    await ctx.tx
      .update(timeEntries)
      .set({
        endedAt: new Date(Math.max(at.getTime(), e.startedAt.getTime())),
        updatedAt: new Date(),
      })
      .where(and(eq(timeEntries.id, e.id), isNull(timeEntries.endedAt)));
  return list.length;
}

/**
 * Starts a stretch for one person at a moment, stopping whatever else they had running (nobody is in two places).
 * Says false, and starts nothing, when something of theirs started at or after that moment: the news is stale.
 */
async function startFor(
  ctx: CommandContext,
  job: Job,
  appointmentId: string,
  userId: string,
  kind: TimeKind,
  at: Date,
  source: TimeSource,
): Promise<boolean> {
  await lockPerson(ctx, userId);
  const running = await ctx.tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, ctx.scope.workspaceId!),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.endedAt),
      ),
    );
  if (running.some((e) => e.startedAt.getTime() >= at.getTime())) return false;
  await stopAt(ctx, running, at);
  await ctx.tx.insert(timeEntries).values({
    workspaceId: ctx.scope.workspaceId!,
    recordId: job.recordId,
    appointmentId,
    userId,
    kind,
    startedAt: at,
    source,
    createdBy: userIdOf(ctx.actor),
  });
  return true;
}

/**
 * Time with no cost yet gets what an hour of that person costs now: their own cost per hour, else the business's
 * labor cost in Estimating. Only ever run as the system, which the cost tables' policies don't hold back.
 */
async function stampCosts(
  ctx: CommandContext,
  only: { readonly jobId?: string; readonly userId?: string },
): Promise<number> {
  const ws = ctx.scope.workspaceId!;
  const job = only.jobId ? sql` and t.record_id = ${only.jobId}` : sql``;
  const user = only.userId ? sql` and t.user_id = ${only.userId}` : sql``;
  const made = await rows<{ entry_id: string }>(
    ctx.tx,
    sql`insert into addon_contractor.time_costs (entry_id, workspace_id, record_id, rate_cents)
        select t.id, t.workspace_id, t.record_id, coalesce(r.cost_cents, nullif(e.labor_cost_cents, 0))
        from addon_contractor.time_entries t
        left join addon_contractor.labor_rates r on r.workspace_id = t.workspace_id and r.user_id = t.user_id
        left join addon_contractor.estimating e on e.workspace_id = t.workspace_id
        where t.workspace_id = ${ws} and t.kind <> 'break'${job}${user}
          and coalesce(r.cost_cents, nullif(e.labor_cost_cents, 0)) is not null
          and not exists (select 1 from addon_contractor.time_costs c where c.entry_id = t.id)
        on conflict (entry_id) do nothing
        returning entry_id`,
  );
  return made.length;
}

/** A stretch for a fix, with its job locked: refused when it's gone. */
async function entryForFix(ctx: CommandContext, entryId: string) {
  const [found] = await ctx.tx
    .select({ recordId: timeEntries.recordId })
    .from(timeEntries)
    .where(and(eq(timeEntries.id, entryId), eq(timeEntries.workspaceId, ctx.scope.workspaceId!)));
  if (!found) throw HfosError.notFound(REFUSALS.timeGone);
  const job = await loadJob(ctx, found.recordId, { lock: true });
  if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
  // Read again under the job's lock: someone may have changed or removed it meanwhile.
  const [entry] = await ctx.tx.select().from(timeEntries).where(eq(timeEntries.id, entryId));
  if (!entry) throw HfosError.notFound(REFUSALS.timeGone);
  return { job, entry };
}

const nameOf = async (ctx: Ctx, userId: string | null) =>
  (userId ? await userName(ctx, userId) : null) ?? W.time.gone;

/** Refuses a stretch that can't be: it ends first, runs over a day, or hasn't happened yet. */
function requireSound(start: Date, end: Date): void {
  const problem = fixProblem(start.getTime(), end.getTime(), Date.now());
  if (problem) throw HfosError.rule(`contractor_time_${problem}`, 400, FIX_PROBLEM_WORDS[problem]);
}

/** Refuses time that overlaps another stretch of the same person's, on any job: nobody is in two places. */
async function requireNoOverlap(
  ctx: CommandContext,
  who: { readonly userId: string; readonly name: string },
  start: Date,
  end: Date,
  exceptId: string | null,
): Promise<void> {
  const [other] = await ctx.tx
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, ctx.scope.workspaceId!),
        eq(timeEntries.userId, who.userId),
        lt(timeEntries.startedAt, end),
        dsql`coalesce(${timeEntries.endedAt}, now()) > ${start.toISOString()}::timestamptz`,
        ...(exceptId ? [ne(timeEntries.id, exceptId)] : []),
      ),
    )
    .limit(1);
  if (!other) return;
  const tz = await timeZoneOf(ctx);
  throw HfosError.rule(
    'contractor_time_overlaps',
    409,
    REFUSALS.timeOverlaps(
      who.name,
      stretchWords(
        other.kind,
        fmtAt(other.startedAt.getTime(), tz),
        other.endedAt ? fmtAt(other.endedAt.getTime(), tz) : null,
      ),
    ),
  );
}

// ------------------------------------------------------------------------------------------------ the buttons

/**
 * The worker: a visit's status moved (core's On the way, Started, Waiting on parts, Done, back to Scheduled, or
 * the visit was cancelled), so the clocks of the people on it start or stop at the moment it was pressed.
 */
export const timeFollowStatus = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.follow_status',
  description:
    'Worker: a visit’s status moved, so the time of the people on it starts or stops at the moment it was pressed.',
  risk: 0,
  input: TimeFollowStatusInput,
  output: TimeFollowStatusOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.time.tracked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [v] = await rows<{ job_id: string }>(
      ctx.tx,
      sql`select j.record_id as job_id
          from app.appointments a join addon_contractor.jobs j on j.record_id = a.custom_record_id
          where a.id = ${input.appointmentId} and a.workspace_id = ${ws}`,
    );
    if (!v) return null;
    const job = await loadJob(ctx, v.job_id, { lock: true });
    const at = new Date(input.at);
    const onVisit = and(
      eq(timeEntries.workspaceId, ws),
      eq(timeEntries.appointmentId, input.appointmentId),
    );
    // News that's old, or already taken in: the buttons have started a stretch on the visit at or after this
    // moment. Only the buttons' own stretches count. A break's start is the server's time, not the phone's, and
    // must never make a Done pressed right after it look stale.
    const [later] = await ctx.tx
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(
        and(
          onVisit,
          eq(timeEntries.source, 'status'),
          dsql`${timeEntries.startedAt} >= ${at.toISOString()}::timestamptz`,
        ),
      )
      .limit(1);
    if (later)
      return { jobId: job.recordId, appointmentId: input.appointmentId, started: 0, stopped: 0 };
    const running = await ctx.tx
      .select()
      .from(timeEntries)
      .where(and(onVisit, isNull(timeEntries.endedAt)));
    const stopped = await stopAt(ctx, running, at);
    const kind = clockFor(input.status);
    let started = 0;
    if (kind && !job.archived) {
      const staff = await rows<{ user_id: string }>(
        ctx.tx,
        sql`select s.user_id from app.appointment_staff s
            where s.appointment_id = ${input.appointmentId} and s.workspace_id = ${ws} and s.active
            order by s.user_id`,
      );
      // Nobody on the visit: the time is whoever pressed the button's, when they're on the team.
      const presser =
        !staff.length && input.byUserId && (await userName(ctx, input.byUserId))
          ? [input.byUserId]
          : [];
      for (const userId of staff.length ? staff.map((s) => s.user_id) : presser)
        if (await startFor(ctx, job, input.appointmentId, userId, kind, at, 'status')) started += 1;
    }
    if (!started && !stopped)
      return { jobId: job.recordId, appointmentId: input.appointmentId, started: 0, stopped: 0 };
    await stampCosts(ctx, { jobId: job.recordId });
    await ctx.emit({
      type: 'contractor.time.tracked',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        jobId: job.recordId,
        appointmentId: input.appointmentId,
        status: input.status,
        started,
        stopped,
      },
    });
    return { jobId: job.recordId, appointmentId: input.appointmentId, started, stopped };
  },
});

export const timeSetBreak = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.set_break',
  description:
    'Take a break on a visit, or come back from one: work time pauses for that one person while everyone else’s runs on. Someone else’s break takes “Fix time on jobs”.',
  risk: 1,
  input: TimeSetBreakInput,
  output: TimeSetBreakOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  // Pressed on the job with no signal: it's kept on the phone and sent when there is some, with its own moment.
  offline: 'anytime',
  ai: {
    tool: 'contractor_set_break',
    description:
      'Start a break for the person asking on a visit they’re working (by appointment id; onBreak true), or end it (onBreak false). Their work time pauses for the break and starts again after. Only while the visit is Started and they’re on the clock. userId does it for someone else, for people who may fix time.',
    keywords: ['break', 'lunch', 'pause', 'back to work'],
    outcome: (output) => ({
      words: (output as { onBreak?: boolean } | null)?.onBreak
        ? W.time.breakStarted
        : W.time.breakEnded,
      path: pathOf(output),
    }),
  },
  emits: ['contractor.time.break_set'],
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    const userId = input.userId ?? me;
    if (!userId)
      throw HfosError.rule('contractor_time_someone_else', 403, REFUSALS.timeSomeoneElse);
    const other = userId !== me;
    if (other && !mayFix(ctx))
      throw HfosError.rule('contractor_time_someone_else', 403, REFUSALS.timeSomeoneElse);
    const visit = await loadVisit(ctx, input.appointmentId);
    if (!visit.jobId) throw visitNotOnJob();
    const job = await loadJob(ctx, visit.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const name = await nameOf(ctx, userId);
    await lockPerson(ctx, userId);
    const [running] = await ctx.tx
      .select()
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.workspaceId, ctx.scope.workspaceId!),
          eq(timeEntries.appointmentId, input.appointmentId),
          eq(timeEntries.userId, userId),
          isNull(timeEntries.endedAt),
        ),
      );
    const out = (changed: boolean) => ({
      jobId: job.recordId,
      appointmentId: input.appointmentId,
      userId,
      name,
      onBreak: input.onBreak,
      changed,
    });
    const from: TimeKind = input.onBreak ? 'work' : 'break';
    const to: TimeKind = input.onBreak ? 'break' : 'work';
    // Pressed with no signal, and the visit's clock was stopped before the phone got through: the stretch that was
    // running at that moment is the one the break splits.
    const pressed = ctx.meta.occurredAt ?? null;
    const [held] =
      !running && pressed
        ? await ctx.tx
            .select()
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.workspaceId, ctx.scope.workspaceId!),
                eq(timeEntries.appointmentId, input.appointmentId),
                eq(timeEntries.userId, userId),
                lte(timeEntries.startedAt, pressed),
                gt(timeEntries.endedAt, pressed),
              ),
            )
            .orderBy(desc(timeEntries.startedAt))
            .limit(1)
        : [];
    const current = running ?? held;
    if (current?.kind === to) return out(false);
    if (current?.kind !== from)
      throw input.onBreak
        ? HfosError.rule(
            'contractor_time_not_working',
            409,
            REFUSALS.timeNotWorking(other ? name : null),
          )
        : HfosError.rule(
            'contractor_time_not_on_break',
            409,
            REFUSALS.timeNotOnBreak(other ? name : null),
          );
    // When it was pressed, and never before the stretch it ends, whatever the clocks say.
    const now = new Date(Math.max(changeMoment(ctx.meta).getTime(), current.startedAt.getTime()));
    if (current.endedAt) {
      // The stretch has ended since: it ends at the press instead, and the rest of it is the break (or the work).
      await ctx.tx
        .update(timeEntries)
        .set({ endedAt: now, autoStopped: false, updatedAt: new Date() })
        .where(eq(timeEntries.id, current.id));
    } else await stopAt(ctx, [current], now);
    await ctx.tx.insert(timeEntries).values({
      workspaceId: ctx.scope.workspaceId!,
      recordId: job.recordId,
      appointmentId: input.appointmentId,
      userId,
      kind: to,
      startedAt: now,
      endedAt: current.endedAt,
      autoStopped: current.endedAt ? current.autoStopped : false,
      source: 'break',
      createdBy: me,
    });
    await ctx.emit({
      type: 'contractor.time.break_set',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        jobId: job.recordId,
        appointmentId: input.appointmentId,
        userId,
        onBreak: input.onBreak,
      },
    });
    return out(true);
  },
});

// ------------------------------------------------------------------------------------------------ fixing

export const timeFix = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.fix',
  description:
    'Fix a stretch of time on a job: when it started, when it ended, or whether it was travel, work or a break, with a reason. For owners, admins and anyone given “Fix time on jobs” (the owner’s decision 10).',
  risk: 2,
  input: TimeFixInput,
  output: TimeChangeOutput,
  permission: 'contractor.fix_time',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_fix_time',
    description:
      'Fix one stretch of time on a job (by entry id, from contractor_list_time): startedAt and endedAt as ISO moments, kind (travel, work or break), and a reason, which is kept with it. A stretch that’s still running needs an endedAt. It can’t overlap the same person’s other time. Asks the person first.',
    autonomy: 'confirm',
    what: 'Fix time on a job',
    keywords: ['fix time', 'correct hours', 'timesheet'],
    outcome: (output) => ({ words: W.time.fixed, path: pathOf(output) }),
  },
  emits: ['contractor.time.fixed'],
  async handler(ctx, input) {
    const { job, entry } = await entryForFix(ctx, input.entryId);
    const start = input.startedAt ? new Date(input.startedAt) : entry.startedAt;
    const end = input.endedAt ? new Date(input.endedAt) : entry.endedAt;
    if (!end) throw HfosError.rule('contractor_time_still_running', 409, REFUSALS.timeStillRunning);
    requireSound(start, end);
    const kind = input.kind ?? entry.kind;
    const name = await nameOf(ctx, entry.userId);
    if (entry.userId)
      await requireNoOverlap(ctx, { userId: entry.userId, name }, start, end, entry.id);
    const tz = await timeZoneOf(ctx);
    const said = (k: TimeKind, a: Date, b: Date | null) =>
      stretchWords(k, fmtAt(a.getTime(), tz), b ? fmtAt(b.getTime(), tz) : null);
    await ctx.tx
      .update(timeEntries)
      .set({
        startedAt: start,
        endedAt: end,
        kind,
        autoStopped: false,
        fixedBy: userIdOf(ctx.actor),
        fixedAt: new Date(),
        fixReason: input.reason,
        updatedAt: new Date(),
      })
      .where(eq(timeEntries.id, entry.id));
    const eventId = await ctx.emit({
      type: 'contractor.time.fixed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        entryId: entry.id,
        jobId: job.recordId,
        appointmentId: entry.appointmentId,
        userId: entry.userId,
        wasAutoStopped: entry.autoStopped,
      },
      before: { who: name, time: said(entry.kind, entry.startedAt, entry.endedAt) },
      after: { who: name, time: said(kind, start, end), reason: input.reason },
    });
    await jobLine(ctx, job.recordId, `fixed ${name}’s time: ${said(kind, start, end)}`, {
      body: input.reason,
      eventId,
    });
    return { entryId: entry.id, jobId: job.recordId, name, changed: true };
  },
});

export const timeAdd = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.add',
  description:
    'Add time to a job that wasn’t tracked: whose, travel or work, from when to when, and why. For owners, admins and anyone given “Fix time on jobs”.',
  risk: 2,
  input: TimeAddInput,
  output: TimeChangeOutput,
  permission: 'contractor.fix_time',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_add_time',
    description:
      'Add a stretch of time to a job that the buttons didn’t track (by job id): userId (someone on the team), kind (work to start, or travel or break), startedAt and endedAt as ISO moments, an optional appointmentId (one of the job’s visits) and a reason, which is kept with it. It can’t overlap the same person’s other time. Asks the person first.',
    autonomy: 'confirm',
    what: 'Add time to a job',
    keywords: ['add time', 'add hours', 'missed time'],
    outcome: (output) => ({
      words: W.time.added((output as { name?: string } | null)?.name ?? 'them'),
      path: pathOf(output),
    }),
  },
  emits: ['contractor.time.added'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const name = await requireCanWork(ctx, input.userId);
    if (input.appointmentId) {
      const [a] = await rows<{ id: string }>(
        ctx.tx,
        sql`select id from app.appointments
            where id = ${input.appointmentId} and workspace_id = ${ctx.scope.workspaceId!}
              and custom_record_id = ${job.recordId}`,
      );
      if (!a)
        throw HfosError.rule(
          'contractor_time_visit_elsewhere',
          409,
          REFUSALS.timeVisitElsewhere(job.name),
        );
    }
    const start = new Date(input.startedAt);
    const end = new Date(input.endedAt);
    requireSound(start, end);
    await lockPerson(ctx, input.userId);
    await requireNoOverlap(ctx, { userId: input.userId, name }, start, end, null);
    const me = userIdOf(ctx.actor);
    const [made] = await ctx.tx
      .insert(timeEntries)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        recordId: job.recordId,
        appointmentId: input.appointmentId ?? null,
        userId: input.userId,
        kind: input.kind,
        startedAt: start,
        endedAt: end,
        source: 'added',
        fixedBy: me,
        fixedAt: new Date(),
        fixReason: input.reason,
        createdBy: me,
      })
      .returning({ id: timeEntries.id });
    const seconds = secondsOf({ startedAt: start.getTime(), endedAt: end.getTime() }, Date.now());
    const eventId = await ctx.emit({
      type: 'contractor.time.added',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        entryId: made!.id,
        jobId: job.recordId,
        appointmentId: input.appointmentId ?? null,
        userId: input.userId,
      },
      after: { who: name, time: timeAmountWords(input.kind, seconds), reason: input.reason },
    });
    await jobLine(ctx, job.recordId, `added ${timeAmountWords(input.kind, seconds)} for ${name}`, {
      body: input.reason,
      eventId,
    });
    return { entryId: made!.id, jobId: job.recordId, name, changed: true };
  },
});

export const timeRemove = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.remove',
  description:
    'Remove a stretch of time from a job, with a reason. It comes off the job’s hours and its labor cost. For owners, admins and anyone given “Fix time on jobs”.',
  risk: 2,
  input: TimeRemoveInput,
  output: TimeChangeOutput,
  permission: 'contractor.fix_time',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_remove_time',
    description:
      'Remove one stretch of time from a job (by entry id), with a reason. It comes off the job’s hours and labor cost and can’t be brought back, though the job’s history keeps what it was. Asks the person first.',
    autonomy: 'confirm',
    what: 'Remove time from a job',
    outcome: (output) => ({
      words: W.time.removed((output as { name?: string } | null)?.name ?? 'Their'),
      path: pathOf(output),
    }),
  },
  emits: ['contractor.time.removed'],
  async handler(ctx, input) {
    const { job, entry } = await entryForFix(ctx, input.entryId);
    const name = await nameOf(ctx, entry.userId);
    const seconds = secondsOf(
      { startedAt: entry.startedAt.getTime(), endedAt: entry.endedAt?.getTime() ?? null },
      Date.now(),
    );
    // What it cost goes with it (the table's own cascade).
    await ctx.tx.delete(timeEntries).where(eq(timeEntries.id, entry.id));
    const eventId = await ctx.emit({
      type: 'contractor.time.removed',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        entryId: entry.id,
        jobId: job.recordId,
        appointmentId: entry.appointmentId,
        userId: entry.userId,
        wasAutoStopped: entry.autoStopped,
      },
      before: { who: name, time: timeAmountWords(entry.kind, seconds), reason: input.reason },
    });
    await jobLine(ctx, job.recordId, `removed ${name}’s ${timeAmountWords(entry.kind, seconds)}`, {
      body: input.reason,
      eventId,
    });
    return { entryId: entry.id, jobId: job.recordId, name, changed: true };
  },
});

// ------------------------------------------------------------------------------------------------ the worker's

/**
 * The worker: time with no cost yet gets what an hour of that person costs now. Run after a break, a fix, an
 * added stretch, a person's cost per hour being set, and Estimating's labor cost being set.
 */
export const timeStampCosts = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.stamp_costs',
  description: 'Worker: time with no cost yet gets what an hour of that person costs.',
  risk: 0,
  input: TimeStampCostsInput,
  output: TimeStampCostsOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  // What time cost stays off events (the owner's decision 11).
  emits: [],
  async handler(ctx, input) {
    return { stamped: await stampCosts(ctx, { jobId: input.jobId, userId: input.userId }) };
  },
});

/**
 * The worker: a stretch on a visit left running past the limit is stopped there, so one forgotten Done doesn't
 * swallow a job's profit. It's marked for a look, and the worker tells the people who may fix time.
 */
export const timeStopOverrun = defineAddonCommand(contractorAddon, {
  name: 'contractor.time.stop_overrun',
  description: `Worker: time left running on a visit for ${MAX_RUNNING_HOURS} hours is stopped there and marked for a look.`,
  risk: 0,
  input: TimeStopOverrunInput,
  output: TimeStopOverrunOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.time.auto_stopped'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const none = { jobId: null, job: null, stopped: [], flagged: [], nextAt: null };
    // A visit deleted for good leaves its time on the job with no visit left to stop it: those stop at the limit
    // too, marked the same way, whichever visit's check comes by.
    await ctx.tx.execute(
      sql`update addon_contractor.time_entries
          set ended_at = started_at + make_interval(hours => ${MAX_RUNNING_HOURS}), auto_stopped = true,
            updated_at = now()
          where workspace_id = ${ws} and appointment_id is null and ended_at is null
            and started_at + make_interval(hours => ${MAX_RUNNING_HOURS}) <= now()`,
    );
    const [v] = await rows<{ job_id: string }>(
      ctx.tx,
      sql`select j.record_id as job_id
          from app.appointments a join addon_contractor.jobs j on j.record_id = a.custom_record_id
          where a.id = ${input.appointmentId} and a.workspace_id = ${ws}`,
    );
    if (!v) return none;
    const job = await loadJob(ctx, v.job_id, { lock: true });
    const onVisit = and(
      eq(timeEntries.workspaceId, ws),
      eq(timeEntries.appointmentId, input.appointmentId),
    );
    const running = await ctx.tx
      .select()
      .from(timeEntries)
      .where(and(onVisit, isNull(timeEntries.endedAt)));
    const now = Date.now();
    const over = running.filter((e) => limitOf(e.startedAt.getTime()) <= now);
    for (const e of over)
      await ctx.tx
        .update(timeEntries)
        .set({
          endedAt: new Date(limitOf(e.startedAt.getTime())),
          autoStopped: true,
          updatedAt: new Date(),
        })
        .where(and(eq(timeEntries.id, e.id), isNull(timeEntries.endedAt)));
    const names: string[] = [];
    for (const userId of new Set(over.map((e) => e.userId))) names.push(await nameOf(ctx, userId));
    if (over.length) {
      const eventId = await ctx.emit({
        type: 'contractor.time.auto_stopped',
        entityType: 'custom_record',
        entityId: job.recordId,
        payload: { jobId: job.recordId, appointmentId: input.appointmentId, entries: over.length },
      });
      await jobLine(
        ctx,
        job.recordId,
        `stopped ${namesWords(names)}’s time, which had run ${MAX_RUNNING_HOURS} hours`,
        { eventId },
      );
    }
    const marked = await ctx.tx
      .selectDistinct({ userId: timeEntries.userId })
      .from(timeEntries)
      .where(and(onVisit, eq(timeEntries.autoStopped, true)));
    const flagged: string[] = [];
    for (const m of marked) flagged.push(await nameOf(ctx, m.userId));
    const next = running
      .filter((e) => !over.includes(e))
      .map((e) => limitOf(e.startedAt.getTime()))
      .sort((a, b) => a - b)[0];
    return {
      jobId: job.recordId,
      job: job.name,
      stopped: names,
      flagged: flagged.sort((a, b) => a.localeCompare(b)),
      nextAt: next === undefined ? null : new Date(next).toISOString(),
    };
  },
});

// ------------------------------------------------------------------------------------------------ what an hour costs

export const laborRateList = defineAddonQuery(contractorAddon, {
  name: 'contractor.labor_rate.list',
  description:
    'What an hour of each person on the team costs the business, which turns time on a job into its labor cost. For people who may see job costs.',
  input: LaborRateListInput,
  output: LaborRateListOutput,
  permission: 'contractor.costs',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_labor_costs',
    description:
      'What an hour of each person on the team costs the business (costCents; null when nobody has said), and the labor cost per hour from Estimating that counts for anyone without one (fallbackCents; 0 when that isn’t set either). It turns time tracked on a job into labor cost.',
    keywords: ['cost per hour', 'labor cost', 'hourly cost', 'wages', 'burden rate'],
  },
  async handler(ctx) {
    const [people, costs, estimating] = await Promise.all([
      peopleOf(ctx),
      ctx.tx
        .select({ userId: laborRates.userId, costCents: laborRates.costCents })
        .from(laborRates)
        .where(eq(laborRates.workspaceId, ctx.scope.workspaceId!)),
      estimatingOf(ctx),
    ]);
    const by = new Map(costs.map((c) => [c.userId, Number(c.costCents)]));
    return {
      people: people.map((p) => ({ ...p, costCents: by.get(p.userId) ?? null })),
      fallbackCents: estimating.laborCostCents,
      canChange: scopeCan(ctx.scope, 'contractor.approve' as Permission),
    };
  },
});

export const laborRateSet = defineAddonCommand(contractorAddon, {
  name: 'contractor.labor_rate.set',
  description:
    'Set what an hour of someone on the team costs the business; null takes it off. It counts for time tracked from then on. For owners and admins.',
  risk: 2,
  input: LaborRateSetInput,
  output: LaborRateSetOutput,
  permission: 'contractor.approve',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_set_labor_cost',
    description:
      'Set what an hour of one person on the team costs the business (by user id; costCents, null takes it off): their pay, taxes and whatever else the business counts. It counts for time tracked from then on, and for their time that had no cost yet; time already costed keeps what it cost. Asks the person first.',
    autonomy: 'confirm',
    what: 'Set what an hour of someone costs',
    outcome: (output, input) => {
      const name = (output as { name?: string } | null)?.name ?? 'Their';
      return {
        words:
          (input as { costCents?: number | null } | null)?.costCents === null
            ? W.laborCosts.cleared(name)
            : W.laborCosts.saved(name),
        path: 'a/contractor/settings',
      };
    },
  },
  emits: ['contractor.labor_rate.set'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const name = await requireCanWork(ctx, input.userId);
    const [now] = await ctx.tx
      .select({ costCents: laborRates.costCents })
      .from(laborRates)
      .where(and(eq(laborRates.workspaceId, ws), eq(laborRates.userId, input.userId)));
    const before = now ? Number(now.costCents) : null;
    if (before === input.costCents) return { userId: input.userId, name, changed: false };
    const by = userIdOf(ctx.actor);
    if (input.costCents === null)
      await ctx.tx
        .delete(laborRates)
        .where(and(eq(laborRates.workspaceId, ws), eq(laborRates.userId, input.userId)));
    else
      await ctx.tx
        .insert(laborRates)
        .values({
          workspaceId: ws,
          userId: input.userId,
          costCents: input.costCents,
          updatedBy: by,
        })
        .onConflictDoUpdate({
          target: [laborRates.workspaceId, laborRates.userId],
          set: { costCents: input.costCents, updatedBy: by, updatedAt: dsql`now()` },
        });
    // The amount stays off the event: only people with job-cost access see it.
    await ctx.emit({
      type: 'contractor.labor_rate.set',
      entityType: 'user',
      entityId: input.userId,
      payload: { userId: input.userId, cleared: input.costCents === null },
    });
    return { userId: input.userId, name, changed: true };
  },
});
