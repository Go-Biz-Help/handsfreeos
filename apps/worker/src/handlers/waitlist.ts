import { and, eq, inArray } from 'drizzle-orm';
import { executeCommand, scheduleJob, waitlistPromote } from '@hfos/core/server';
import { appointments, waitlistEntries } from '@hfos/db/schema';
import { offerFreedTime, WINDOW_END_JOB, windowEndKey } from '../booking/waitlist';
import { systemActor, tenantOf, workerMeta } from '../services';
import type { EventHandler, HandlerContext } from './types';

/**
 * A seat or a 1:1 time opened on a calendar with people waiting. In a session or group time, the oldest
 * waiting customers that fit are booked in and told (their confirmation follows from appointment.booked).
 * A 1:1 time on an hours calendar is offered to the next person whose wanted times cover it.
 */
export const onSeatFreed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const [appt] = await ctx.tx
    .select({ kind: appointments.kind, capacity: appointments.capacity })
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  if (!appt) return;
  const meta = workerMeta(ctx.event.correlationId, ctx.event.id);
  if (appt.kind === 'session' || appt.capacity > 1) {
    await executeCommand(
      ctx.db,
      waitlistPromote,
      { workspaceId: scope.workspaceId, appointmentId },
      systemActor(scope),
      meta,
    );
    return;
  }
  await offerFreedTime(ctx, scope, appointmentId, meta, Date.now());
};

/** Arms the job that ends a wait (booking/waitlist.ts), or moves it sooner when it's already armed for later. */
async function armWaitEnd(ctx: HandlerContext, entryId: string, runAt: Date): Promise<void> {
  const scope = tenantOf(ctx.scope);
  await scheduleJob(
    ctx.tx,
    {
      kind: WINDOW_END_JOB,
      dedupeKey: windowEndKey(entryId),
      runAt,
      payload: { entryId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/**
 * Someone started waiting (staff, the booking page or the AI teammate put them there): a job stops their wait
 * once there is nothing left to wait for, at the end of the window of time they want or when the session they
 * want starts, so the waitlist doesn't fill up with times long gone.
 */
export const onWaitlistAdded: EventHandler = async (ctx) => {
  const entryId = String((ctx.event.payload as { entryId?: unknown } | null)?.entryId ?? '');
  if (!entryId) return;
  const [e] = await ctx.tx
    .select({ wantedTo: waitlistEntries.wantedTo, startsAt: appointments.startsAt })
    .from(waitlistEntries)
    .leftJoin(appointments, eq(appointments.id, waitlistEntries.appointmentId))
    .where(eq(waitlistEntries.id, entryId));
  const endsAt = e?.startsAt ?? e?.wantedTo;
  if (endsAt) await armWaitEnd(ctx, entryId, endsAt);
};

/**
 * A session people wait for was cancelled or moved (one appointment, or a series): their wait ends straight away
 * when it was called off, or at its new start when that's sooner. A session moved later is waited for again when
 * the job runs (waitlist.expire says when it starts now).
 */
export const onWaitedForChanged: EventHandler = async (ctx) => {
  const listed = (ctx.event.payload as { appointmentIds?: unknown } | null)?.appointmentIds;
  const ids = Array.isArray(listed)
    ? listed.filter((id): id is string => typeof id === 'string')
    : ctx.event.entityId
      ? [ctx.event.entityId]
      : [];
  if (!ids.length) return;
  const waiting = await ctx.tx
    .select({
      id: waitlistEntries.id,
      status: appointments.status,
      startsAt: appointments.startsAt,
    })
    .from(waitlistEntries)
    .innerJoin(appointments, eq(appointments.id, waitlistEntries.appointmentId))
    .where(and(inArray(waitlistEntries.appointmentId, ids), eq(waitlistEntries.status, 'waiting')));
  for (const w of waiting)
    await armWaitEnd(ctx, w.id, w.status === 'scheduled' ? w.startsAt : ctx.event.createdAt);
};
