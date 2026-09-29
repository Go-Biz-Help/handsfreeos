/**
 * Jobs (M18): the work a customer is waiting on. Every booked visit starts one (calendar/booking.ts); staff gather
 * more visits into it to make a project, and move it along — on the way, started, waiting on parts, done — from
 * the phone or the web. Each change can text the customer (the worker's `job.status_changed` handler), with the
 * arrival time for On my way.
 *
 * Events are filed under the visit (entityType `appointment`), so every screen that shows a visit refreshes.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { appointmentAttendees, appointments, jobs } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { FRESH_MINUTES } from '../mobile';
import {
  JOB_STATUS_WORDS,
  JobAddVisitInput,
  JobAddVisitOutput,
  JobSetStatusInput,
  JobSetStatusOutput,
  type JobStatus,
} from '../schemas/job';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

async function visitOf(ctx: CommandContext, appointmentId: string) {
  const [appt] = await ctx.tx
    .select()
    .from(appointments)
    .where(
      and(eq(appointments.id, appointmentId), eq(appointments.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!appt)
    throw HfosError.notFound(
      'That visit isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return appt;
}

async function customerOf(ctx: CommandContext, appointmentId: string): Promise<string | null> {
  const [a] = await ctx.tx
    .select({ personId: appointmentAttendees.personId })
    .from(appointmentAttendees)
    .where(eq(appointmentAttendees.appointmentId, appointmentId))
    .orderBy(asc(appointmentAttendees.createdAt), asc(appointmentAttendees.id))
    .limit(1);
  return a?.personId ?? null;
}

/** The visit's job, made now for a visit booked before jobs (or a session's seat). */
async function jobOf(ctx: CommandContext, appt: typeof appointments.$inferSelect) {
  if (appt.jobId) {
    const [job] = await ctx.tx.select().from(jobs).where(eq(jobs.id, appt.jobId)).for('update');
    if (job) return job;
  }
  const [job] = await ctx.tx
    .insert(jobs)
    .values({
      workspaceId: appt.workspaceId,
      personId: await customerOf(ctx, appt.id),
      title: appt.title.slice(0, 200),
      createdBy: userIdOf(ctx.actor),
    })
    .returning();
  await ctx.tx.update(appointments).set({ jobId: job!.id }).where(eq(appointments.id, appt.id));
  return job!;
}

/** About 100 m: close enough for a driving time, not a trail of where a tech was. */
const rough = (n: number) => Math.round(n * 1000) / 1000;

export const jobSetStatus = defineCommand({
  name: 'job.set_status',
  description:
    'Move a job along: on the way (with where you are, for an arrival time), started, waiting on parts, done, or back to scheduled, with an optional note the customer may see. The customer gets a text about it when they can.',
  risk: 1,
  input: JobSetStatusInput,
  output: JobSetStatusOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['job.status_changed'],
  // It reaches the customer, so a change that waited too long on a phone asks before it goes.
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const appt = await visitOf(ctx, input.appointmentId);
    if (appt.status === 'cancelled')
      throw HfosError.rule(
        'visit_cancelled',
        409,
        `“${appt.title}” was cancelled, so its job can’t move along. Book a new visit if the work is still going ahead.`,
      );
    const job = await jobOf(ctx, appt);
    const noteChanged =
      input.customerNote !== undefined && (input.customerNote || null) !== job.customerNote;
    const status = input.status as JobStatus;
    if (status === job.status && !noteChanged)
      return { jobId: job.id, status: job.status as JobStatus, changed: false };
    const now = new Date();
    await ctx.tx
      .update(jobs)
      .set({
        status,
        ...(status !== job.status
          ? { statusChangedAt: now, statusChangedBy: userIdOf(ctx.actor), etaAt: null }
          : {}),
        ...(input.customerNote !== undefined ? { customerNote: input.customerNote || null } : {}),
      })
      .where(eq(jobs.id, job.id));
    await ctx.emit({
      type: 'job.status_changed',
      entityType: 'appointment',
      entityId: appt.id,
      payload: {
        jobId: job.id,
        appointmentId: appt.id,
        calendarId: appt.calendarId,
        from: job.status,
        status,
        statusChanged: status !== job.status,
        noteChanged,
        notify: input.notify,
        ...(status === 'on_the_way' && input.origin
          ? { origin: { lat: rough(input.origin.lat), lng: rough(input.origin.lng) } }
          : {}),
      },
      before: { title: job.title, status: JOB_STATUS_WORDS[job.status as JobStatus] },
      after: {
        title: job.title,
        status: JOB_STATUS_WORDS[status],
        ...(noteChanged ? { note: input.customerNote || null } : {}),
      },
    });
    return { jobId: job.id, status, changed: true };
  },
});

export const jobAddVisit = defineCommand({
  name: 'job.add_visit',
  description:
    'Make a job a project: add another of the same customer’s visits to it. A job the visit leaves with no visits of its own is removed.',
  risk: 1,
  input: JobAddVisitInput,
  output: JobAddVisitOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['job.visit_added'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [job] = await ctx.tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, input.jobId), eq(jobs.workspaceId, ws)))
      .for('update');
    if (!job)
      throw HfosError.notFound(
        'That job isn’t there anymore. It may have been removed with its last visit. Refresh and try again.',
      );
    const appt = await visitOf(ctx, input.appointmentId);
    if (appt.kind !== 'booking')
      throw HfosError.rule(
        'not_a_visit',
        409,
        `“${appt.title}” isn’t a visit for one customer, so it can’t join a job. Pick one of the customer’s booked visits.`,
      );
    if (appt.jobId === job.id) return { jobId: job.id, appointmentId: appt.id };
    const person = await customerOf(ctx, appt.id);
    if (job.personId && person !== job.personId)
      throw HfosError.rule(
        'other_customer',
        409,
        `“${appt.title}” is for a different customer than “${job.title}”. Pick one of the same customer’s visits.`,
      );
    const left = appt.jobId;
    await ctx.tx.update(appointments).set({ jobId: job.id }).where(eq(appointments.id, appt.id));
    if (left) {
      const [still] = await ctx.tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.jobId, left), ne(appointments.id, appt.id)))
        .limit(1);
      if (!still) await ctx.tx.delete(jobs).where(eq(jobs.id, left));
    }
    await ctx.emit({
      type: 'job.visit_added',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { jobId: job.id, appointmentId: appt.id, leftJobId: left },
      after: { job: job.title, visit: appt.title, startsAt: appt.startsAt.toISOString() },
    });
    return { jobId: job.id, appointmentId: appt.id };
  },
});
