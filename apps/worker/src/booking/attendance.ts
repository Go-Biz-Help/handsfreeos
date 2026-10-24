/**
 * The end of a session (funnels): everyone still booked who was given a Join link is marked, attended when they
 * opened it and a no-show when they never did, each with attendee.set_attendance, so a workflow on "Somebody missed
 * a session" starts for that one person. One-on-one visits are never marked by themselves: somebody on a video call
 * may well have used the meeting's own address.
 *
 * `attendance.close` runs every ten minutes for the whole server, ten minutes after each session ends (core's
 * `private.attendance_to_close`). A teammate's own tick, before or after, stands: it's a change of its own.
 */
import { attendeeSetAttendance, executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta } from '../services';

export const ATTENDANCE_JOB = 'attendance.close';
export const ATTENDANCE_KEY = 'attendance:close';
const EVERY_MS = 10 * 60_000;
const BATCH = 200;

export const attendanceClose: JobHandler = async (ctx) => {
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ attendee_id: string; workspace_id: string; organization_id: string; joined: boolean }>(
      tx,
      sql`select * from private.attendance_to_close(${BATCH})`,
    ),
  );
  for (const d of due) {
    const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
    try {
      await executeCommand(
        ctx.db,
        attendeeSetAttendance,
        {
          workspaceId: d.workspace_id,
          attendeeId: d.attendee_id,
          attendance: d.joined ? 'attended' : 'no_show',
        },
        systemActor(scope),
        workerMeta(),
      );
    } catch (e) {
      // One booking's trouble never holds up the rest; it's still due at the next run.
      ctx.log.warn(
        { attendeeId: d.attendee_id, err: errorMessage(e) },
        'could not mark attendance',
      );
    }
  }
  return { rescheduleAt: new Date(ctx.now + EVERY_MS) };
};
