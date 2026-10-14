/**
 * Google Meet transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md, step 7). Meet doesn't call us when a
 * transcript is ready, so `appointment.meet_transcript_poll` looks: from 15 minutes after a recorded Meet call is due
 * to end, every 20 minutes, for up to four hours. It reads with the host's Google calendar sign-in, which needs the
 * Meet permission ("Allow Meet transcripts"); without it the two-hour check (transcripts.ts) says what to do.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AppointmentLocation,
  appointmentAttachTranscript,
  executeCommand,
  hasMeetTranscripts,
  meetCodeOf,
} from '@hfos/core/server';
import { asWorker, sql, type Tx } from '@hfos/db/client';
import { appointments, appointmentStaff, calendarConnections } from '@hfos/db/schema';
import { session } from '../calendar/sync';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

const MIN = 60_000;
/** The first look, after the call is due to end. */
const FIRST_LOOK_MS = 15 * MIN;
const EVERY_MS = 20 * MIN;
/** After this long past the end, it stops looking (the two-hour check has already said why). */
const GIVE_UP_MS = 4 * 60 * MIN;

/**
 * Looks for a recorded Meet call's transcript after it ends; moved along with the appointment. Only queued for
 * appointments set to get a Meet link with Record and transcribe on.
 */
export async function queueMeetTranscriptPoll(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}, ${scope.workspaceId}, 'appointment.meet_transcript_poll',
          ${`appointment.meet_transcript_poll:${appointmentId}`}, a.ends_at + interval '15 minutes',
          ${JSON.stringify({ appointmentId })}::jsonb
        from app.appointments a
        where a.id = ${appointmentId}::uuid and a.status = 'scheduled'
          and a.location ->> 'video' = 'google_meet' and (a.location ->> 'record')::boolean is true
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = excluded.run_at`,
  );
}

export const appointmentMeetTranscriptPoll: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const seen = await asWorker(ctx.db, scope, async (tx) => {
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
    if (!a) return null;
    const staff = await tx
      .select({ userId: appointmentStaff.userId, role: appointmentStaff.role })
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, a.id));
    const hostId = (staff.find((r) => r.role === 'host') ?? staff[0])?.userId ?? null;
    const [conn] = hostId
      ? await tx
          .select()
          .from(calendarConnections)
          .where(
            and(
              eq(calendarConnections.workspaceId, scope.workspaceId),
              eq(calendarConnections.userId, hostId),
              eq(calendarConnections.provider, 'google'),
              inArray(calendarConnections.status, ['active', 'error']),
            ),
          )
          .orderBy(desc(calendarConnections.createdAt))
          .limit(1)
      : [];
    return { a, conn: conn ?? null };
  });
  if (!seen) return;
  const { a, conn } = seen;
  const place = AppointmentLocation.safeParse(a.location ?? {});
  if (!place.success || place.data.video !== 'google_meet' || !place.data.record) return;
  // Cancelled, a no-show or deleted: no transcript to look for.
  if (a.status === 'cancelled' || a.status === 'no_show' || a.binItemId !== null) return;
  const code = meetCodeOf(place.data.meetingUrl);
  if (!code) return;
  // Moved later since: its own look comes then.
  if (a.endsAt.getTime() + FIRST_LOOK_MS > Date.now() + MIN) return;
  if (Date.now() > a.endsAt.getTime() + GIVE_UP_MS) return;
  // Not allowed to read Meet transcripts: the two-hour check tells the host how to allow it.
  if (!conn?.tokenEnc || !hasMeetTranscripts(conn.scopes)) return;

  const google = ctx.calendars.providers.google;
  let look;
  try {
    look = await session(
      ctx,
      scope,
      conn,
      google,
    )((t) => ctx.calendars.meet.look(t, code, new Date(a.startsAt.getTime() - 60 * MIN)));
  } catch (e) {
    ctx.log.warn({ appointmentId, err: errorMessage(e) }, 'a Meet transcript look failed');
    return { rescheduleAt: new Date(Date.now() + EVERY_MS) };
  }
  if (look.status === 'not_yet') return { rescheduleAt: new Date(Date.now() + EVERY_MS) };
  if (look.status === 'none') return;
  await executeCommand(
    ctx.db,
    appointmentAttachTranscript,
    {
      workspaceId: scope.workspaceId,
      appointmentId: a.id,
      provider: 'google_meet',
      externalId: look.id,
      body: look.text.slice(0, 2_000_000),
    },
    systemActor(scope),
    workerMeta(),
  );
};
