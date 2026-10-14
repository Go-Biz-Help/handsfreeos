/**
 * Transcripts of recorded Zoom calls (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §8).
 * `appointment.transcript_fetch` downloads what Zoom's webhook pointed at, with the host's token, and keeps it on the
 * appointment as plain text. `appointment.transcript_watch` runs two hours after a recorded call was due to end: when
 * nothing came, it reads the host's Zoom settings again and emails them once, saying what to fix.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  AppointmentLocation,
  appointmentAttachTranscript,
  executeCommand,
  meetingSettingsWords,
  zoomSettingsProblems,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  appointments,
  appointmentStaff,
  meetingConnections,
  users,
  workspaces,
} from '@hfos/db/schema';
import { missingTranscriptEmail } from '../emails/templates';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { MeetingError } from './provider';
import { session } from './sync';
import { vttToText } from './vtt';

/** How long after a recorded call is due to end before a missing transcript is worth a word. */
export const TRANSCRIPT_GRACE_MS = 2 * 3_600_000;

export async function queueTranscriptFetch(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
  files: readonly { id: string; url: string }[],
): Promise<void> {
  for (const f of files)
    await tx.execute(
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${scope.organizationId}, ${scope.workspaceId}, 'appointment.transcript_fetch',
            ${`appointment.transcript_fetch:${appointmentId}:${f.id}`}, now(),
            ${JSON.stringify({ appointmentId, fileId: f.id, url: f.url })}::jsonb)
          on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing`,
    );
}

/** The check two hours after a recorded call ends; moved along with the call. */
export async function queueTranscriptWatch(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
  endsAt: Date,
): Promise<void> {
  const at = new Date(endsAt.getTime() + TRANSCRIPT_GRACE_MS);
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, 'appointment.transcript_watch',
          ${`appointment.transcript_watch:${appointmentId}`}, ${at.toISOString()}::timestamptz,
          ${JSON.stringify({ appointmentId })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = excluded.run_at`,
  );
}

/** The host and their usable Zoom connection, as the meeting job picks them. */
async function hostOf(s: WorkerServices, scope: TenantScope, appointmentId: string) {
  return asWorker(s.db, scope, async (tx) => {
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
          .from(meetingConnections)
          .where(
            and(
              eq(meetingConnections.workspaceId, scope.workspaceId),
              eq(meetingConnections.userId, hostId),
              eq(meetingConnections.provider, 'zoom'),
              inArray(meetingConnections.status, ['active', 'error']),
            ),
          )
      : [];
    return { a, hostId, conn: conn ?? null };
  });
}

export const appointmentTranscriptFetch: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const fileId = String(ctx.job.payload['fileId'] ?? '');
  const url = String(ctx.job.payload['url'] ?? '');
  const seen = await hostOf(ctx, scope, appointmentId);
  if (!seen?.conn?.tokenEnc || !fileId || !url) return;
  const place = AppointmentLocation.safeParse(seen.a.location ?? {});
  // Only calls the business chose to record (and told the customer about) are kept.
  if (!place.success || !place.data.record) return;
  const provider = ctx.calendars.meetings.zoom;
  try {
    const call = session(ctx, scope, seen.conn, provider);
    const vtt = await call((t) => provider.downloadTranscript(t, url));
    const body = vttToText(vtt).slice(0, 2_000_000);
    if (!body.trim()) return;
    await executeCommand(
      ctx.db,
      appointmentAttachTranscript,
      { workspaceId: scope.workspaceId, appointmentId, provider: 'zoom', externalId: fileId, body },
      systemActor(scope),
      workerMeta(),
    );
  } catch (e) {
    if (e instanceof MeetingError && e.permanent) {
      ctx.log.warn(
        { appointmentId, err: errorMessage(e) },
        'a Zoom transcript could not be fetched',
      );
      return;
    }
    throw e;
  }
};

export const appointmentTranscriptWatch: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const seen = await hostOf(ctx, scope, appointmentId);
  if (!seen?.hostId) return;
  const { a } = seen;
  const place = AppointmentLocation.safeParse(a.location ?? {});
  if (!place.success || place.data.video !== 'zoom' || !place.data.record) return;
  // Cancelled, a no-show, deleted, or moved later (its own watch comes then).
  if (a.status === 'cancelled' || a.status === 'no_show' || a.binItemId !== null) return;
  if (a.endsAt.getTime() + TRANSCRIPT_GRACE_MS > Date.now() + 60_000) return;
  const [had] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from app.appointment_transcripts where appointment_id = ${a.id}::uuid`,
    ),
  );
  if ((had?.n ?? 0) > 0) return;

  // What the host's Zoom settings say now (read fresh: they may have changed since this morning).
  let problems: string[] = [...(seen.conn?.settingsProblems ?? [])];
  if (seen.conn?.tokenEnc) {
    try {
      const provider = ctx.calendars.meetings.zoom;
      const read = await session(ctx, scope, seen.conn, provider)((t) => provider.readSettings(t));
      problems = zoomSettingsProblems(read);
    } catch (e) {
      ctx.log.warn(
        { appointmentId, err: errorMessage(e) },
        'zoom settings read for a missing transcript failed',
      );
    }
  }
  const [who] = await asWorker(ctx.db, scope, (tx) =>
    tx.select({ email: users.email }).from(users).where(eq(users.id, seen.hostId!)),
  );
  const [w] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId)),
  );
  if (!who?.email) return;
  const when = a.startsAt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: w?.timezone ?? 'America/Chicago',
  });
  await ctx.mailer.send({
    to: String(who.email),
    ...missingTranscriptEmail({
      title: a.title,
      when,
      problems: meetingSettingsWords(problems),
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/my-calendar`,
    }),
  });
};
