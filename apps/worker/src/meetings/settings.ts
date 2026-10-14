/**
 * Reading a connected Zoom account's settings for transcripts (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md §7).
 * `meeting_connection.settings_check` runs per connection: right after it connects, when its person presses Check
 * again, and once a day after that. It stores what the settings mean (core's codes) through a command, which only
 * says something when they change.
 */
import { and, eq } from 'drizzle-orm';
import {
  executeCommand,
  meetingConnectionFail,
  meetingConnectionRecordSettings,
  zoomSettingsProblems,
} from '@hfos/core/server';
import { asWorker, sql, type Tx } from '@hfos/db/client';
import { meetingConnections } from '@hfos/db/schema';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { MeetingAuthError } from './provider';
import { session } from './sync';

const DAY = 86_400_000;

/** Reads the connection's settings now (or brings a later read forward). */
export async function queueSettingsCheck(
  tx: Tx,
  scope: TenantScope,
  connectionId: string,
  at = new Date(),
): Promise<void> {
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, 'meeting_connection.settings_check',
          ${`meeting_connection.settings_check:${connectionId}`}, ${at.toISOString()}::timestamptz,
          ${JSON.stringify({ connectionId })}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at)`,
  );
}

export const meetingSettingsCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const connectionId = String(ctx.job.payload['connectionId'] ?? '');
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select()
      .from(meetingConnections)
      .where(and(eq(meetingConnections.id, connectionId))),
  );
  // Disconnected or waiting on a reconnect: nothing to read until that changes (connecting again queues a read).
  if (!c || (c.status !== 'active' && c.status !== 'error') || !c.tokenEnc) return;
  const provider = ctx.calendars.meetings[c.provider];
  try {
    const call = session(ctx, scope, c, provider);
    const read = await call((t) => provider.readSettings(t));
    await executeCommand(
      ctx.db,
      meetingConnectionRecordSettings,
      { workspaceId: scope.workspaceId, connectionId: c.id, problems: zoomSettingsProblems(read) },
      systemActor(scope),
      workerMeta(),
    );
  } catch (e) {
    if (e instanceof MeetingAuthError) {
      await executeCommand(
        ctx.db,
        meetingConnectionFail,
        {
          workspaceId: scope.workspaceId,
          connectionId: c.id,
          reason: 'reauth_required',
          message: `Zoom stopped accepting HandsFreeOS’s sign-in for ${c.accountEmail ?? 'this account'}.`,
        },
        systemActor(scope),
        workerMeta(),
      );
      return;
    }
    // Zoom didn't answer: what was stored stays, and the daily read tries again.
    ctx.log.warn({ connectionId: c.id, err: errorMessage(e) }, 'zoom settings check failed');
  }
  return { rescheduleAt: new Date(Date.now() + DAY) };
};
