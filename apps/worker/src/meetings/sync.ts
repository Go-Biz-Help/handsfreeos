/**
 * Zoom meetings that follow their appointments. `appointment.meeting_sync` runs per appointment set to "Make a
 * Zoom link": it makes the meeting in the host's Zoom account, moves it when the appointment moves, and deletes it
 * when the appointment is cancelled, a no-show or deleted. The link, Zoom's id for the meeting and the times it was
 * set to live on the appointment's place, so a retry, a late run or a run twice is always safe. When there's no
 * Zoom to make it in, the place says why, in words for the team.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  AppointmentLocation,
  appointmentSetMeetingLink,
  executeCommand,
  meetingConnectionFail,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { appointments, appointmentStaff, meetingConnections, users } from '@hfos/db/schema';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { MeetingAuthError, MeetingError, type MeetingProvider, type TokenSet } from './provider';

type Connection = typeof meetingConnections.$inferSelect;

const REFRESH_AHEAD_MS = 5 * 60_000;
const USABLE = ['active', 'error'] as const;

/**
 * Asks for an appointment's Zoom meeting to be made, moved or deleted. Only queued for appointments set to get a
 * Zoom link, so everyone else never runs the job.
 */
export async function queueMeetingSync(
  tx: Tx,
  scope: TenantScope,
  appointmentId: string,
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        select ${scope.organizationId}, ${scope.workspaceId}, 'appointment.meeting_sync',
          ${`appointment.meeting_sync:${appointmentId}`}, now(), ${JSON.stringify({ appointmentId })}::jsonb
        where exists (select 1 from app.appointments a
                where a.id = ${appointmentId}::uuid and a.location ->> 'video' = 'zoom')
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at)`,
  );
}

/** Someone connected Zoom: their upcoming Zoom appointments still without a link get one now. */
export async function queueMeetingSyncForHost(
  tx: Tx,
  scope: TenantScope,
  userId: string,
): Promise<void> {
  const due = await rows<{ id: string }>(
    tx,
    sql`select a.id from app.appointments a
        join app.appointment_staff s on s.appointment_id = a.id and s.user_id = ${userId}::uuid
        where a.workspace_id = ${scope.workspaceId}::uuid and a.status = 'scheduled'
          and a.ends_at > now() and a.location ->> 'video' = 'zoom'
          and coalesce(a.location ->> 'meetingId', '') = ''
        limit 200`,
  );
  for (const d of due) await queueMeetingSync(tx, scope, d.id);
}

/** Calls Zoom with a working token: renewed ahead of expiry (and sealed again), and once more after a 401. */
export function session(
  s: WorkerServices,
  scope: TenantScope,
  c: Connection,
  provider: MeetingProvider,
) {
  let tokens: TokenSet | null = null;
  const fresh = async (force: boolean): Promise<TokenSet> => {
    if (!c.tokenEnc) throw new MeetingAuthError('The Zoom account has no sign-in.', 'missing');
    const current = tokens ?? (JSON.parse(s.sealer.open(c.tokenEnc)) as TokenSet);
    if (!force && Date.parse(current.expiresAt) - Date.now() > REFRESH_AHEAD_MS)
      return (tokens = current);
    const next = await provider.refresh(current);
    // Zoom hands out a new refresh token every time, so it's kept at once. Only while still connected.
    await asWorker(s.db, scope, (tx) =>
      tx
        .update(meetingConnections)
        .set({
          tokenEnc: s.sealer.seal(JSON.stringify(next)),
          tokenKeyId: s.sealer.keyId,
          tokenExpiresAt: new Date(next.expiresAt),
        })
        .where(
          and(eq(meetingConnections.id, c.id), inArray(meetingConnections.status, [...USABLE])),
        ),
    );
    return (tokens = next);
  };
  return async <T>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
    const t = await fresh(false);
    try {
      return await fn(t.accessToken);
    } catch (e) {
      if (!(e instanceof MeetingError && e.status === 401)) throw e;
      return fn((await fresh(true)).accessToken);
    }
  };
}

async function read(s: WorkerServices, scope: TenantScope, appointmentId: string) {
  return asWorker(s.db, scope, async (tx) => {
    // A booking in the Deleted bin is read too, so its meeting comes out of Zoom.
    await tx.execute(sql`select set_config('app.read_bin', 'on', true)`);
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId));
    if (!a) return null;
    const staff = await tx
      .select({ userId: appointmentStaff.userId, role: appointmentStaff.role })
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, a.id));
    const hostId = (staff.find((r) => r.role === 'host') ?? staff[0])?.userId ?? null;
    const [host] = hostId
      ? await tx
          .select({ fullName: users.fullName, email: users.email })
          .from(users)
          .where(eq(users.id, hostId))
      : [];
    const [conn] = hostId
      ? await tx
          .select()
          .from(meetingConnections)
          .where(
            and(
              eq(meetingConnections.workspaceId, scope.workspaceId),
              eq(meetingConnections.userId, hostId),
              eq(meetingConnections.provider, 'zoom'),
              inArray(meetingConnections.status, ['active', 'reauth_required', 'error']),
            ),
          )
      : [];
    const hostName = host ? (host.fullName || String(host.email)).split(/\s+/)[0]! : null;
    return { a, hostId, hostName, conn: conn ?? null };
  });
}

export const appointmentMeetingSync: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const appointmentId = String(ctx.job.payload['appointmentId'] ?? '');
  const seen = await read(ctx, scope, appointmentId);
  if (!seen) return;
  const { a, hostName, conn } = seen;
  const parsed = AppointmentLocation.safeParse(a.location ?? {});
  if (!parsed.success) return;
  const place = parsed.data;
  // Set to something else since: nothing to keep in step.
  if (place.kind !== 'virtual' || place.video !== 'zoom') return;

  const save = (v: {
    meetingUrl?: string | null;
    meetingId?: string | null;
    meetingFor?: string | null;
    meetingError?: string | null;
  }) =>
    executeCommand(
      ctx.db,
      appointmentSetMeetingLink,
      { workspaceId: scope.workspaceId, appointmentId: a.id, video: 'zoom', ...v },
      systemActor(scope),
      workerMeta(),
    );

  const provider = ctx.calendars.meetings.zoom;
  const usable = !!conn && (conn.status === 'active' || conn.status === 'error') && !!conn.tokenEnc;
  const upcoming = a.status === 'scheduled' && a.binItemId === null;

  try {
    if (!upcoming) {
      // Cancelled, a no-show, completed or deleted: a meeting still ahead comes out of Zoom.
      if (place.meetingId && a.status !== 'completed' && usable) {
        const call = session(ctx, scope, conn!, provider);
        await call((t) => provider.deleteMeeting(t, place.meetingId!));
        await save({ meetingId: null, meetingFor: null });
      }
      return;
    }
    if (!usable) {
      const who = hostName ?? 'The host';
      await save({
        meetingError: !seen.hostId
          ? 'Nobody is assigned to this appointment, so there’s no Zoom account to make its link in. Assign someone who has connected Zoom.'
          : conn?.status === 'reauth_required'
            ? `Zoom needs ${who} to sign in again before this appointment can get its link. They can reconnect in Settings → My calendar.`
            : `${who} hasn’t connected Zoom, so this appointment has no Zoom link yet. They can connect it in Settings → My calendar, then press Make link here.`,
      });
      return;
    }
    // The times and whether it records: a change to either is sent to Zoom.
    const want = `${a.startsAt.toISOString()}|${a.endsAt.toISOString()}${place.record ? '|record' : ''}`;
    if (place.meetingId && place.meetingFor === want && place.meetingUrl) {
      if (place.meetingError) await save({ meetingError: null });
      return;
    }
    const call = session(ctx, scope, conn!, provider);
    const m = {
      appointmentId: a.id,
      topic: a.title,
      start: a.startsAt,
      end: a.endsAt,
      record: place.record,
    };
    if (place.meetingId) {
      // Moved: the same meeting moves. One deleted in Zoom (or in someone else's account) is made again.
      const moved = await call((t) => provider.updateMeeting(t, place.meetingId!, m));
      if (moved) {
        await save({ meetingFor: want, meetingError: null });
        return;
      }
    }
    const made = await call((t) => provider.createMeeting(t, m));
    await save({
      meetingUrl: made.joinUrl,
      meetingId: made.id,
      meetingFor: want,
      meetingError: null,
    });
  } catch (e) {
    if (e instanceof MeetingAuthError && conn) {
      await executeCommand(
        ctx.db,
        meetingConnectionFail,
        {
          workspaceId: scope.workspaceId,
          connectionId: conn.id,
          reason: 'reauth_required',
          message: `Zoom stopped accepting HandsFreeOS’s sign-in for ${conn.accountEmail ?? 'this account'}.`,
        },
        systemActor(scope),
        workerMeta(),
      );
      if (upcoming)
        await save({
          meetingError: `Zoom needs ${hostName ?? 'the host'} to sign in again before this appointment can get its link. They can reconnect in Settings → My calendar.`,
        });
      return;
    }
    const message = errorMessage(e);
    ctx.log.warn({ appointmentId: a.id, err: message }, 'zoom meeting sync failed');
    if (e instanceof MeetingError && e.permanent) {
      if (upcoming)
        await save({
          meetingError:
            'Zoom wouldn’t make this appointment’s meeting. Press Make link to try again.',
        });
      return;
    }
    // Transient: the job runner tries again later.
    throw e;
  }
};
