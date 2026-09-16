/**
 * Texts that wait for quiet hours to end (M10): a person's "Send at 8:00 AM". message.send keeps the text in its
 * conversation as scheduled, and `message.scheduled` queues `message.send_scheduled` for the moment quiet hours end.
 * The job asks message.release_scheduled, which reads the text again under its lock and runs every check a text
 * passes as of then — the way the Action Center's held texts go out — before handing it to the sender
 * (`message.queued`), or records why it didn't go. Quiet hours that came round again make it wait again. Cancelling
 * brings the job forward, so a cancelled text ends at once rather than in the morning.
 */
import { executeCommand, messageReleaseScheduled, scheduleJob } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { messages } from '@hfos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta } from '../services';

export const SCHEDULED_TEXT_JOBS = {
  /** One per text waiting for quiet hours to end: it goes then. */
  send: 'message.send_scheduled',
} as const;
export const scheduledTextJobKey = (messageId: string): string => `scheduled-text:${messageId}`;

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** A person chose "Send at 8:00 AM": the job waits for that moment. */
export const onTextScheduled: EventHandler = async (ctx) => {
  const messageId = ctx.event.entityId;
  const sendAt = Date.parse(String((ctx.event.payload as Record<string, unknown>)['sendAt'] ?? ''));
  if (!isUuid(messageId) || !Number.isFinite(sendAt)) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(
    ctx.tx,
    {
      kind: SCHEDULED_TEXT_JOBS.send,
      dedupeKey: scheduledTextJobKey(messageId),
      runAt: new Date(sendAt),
      payload: { messageId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
};

/** Someone cancelled it: the job runs now, and the text ends there. */
export const onScheduleCancelled: EventHandler = async (ctx) => {
  const messageId = ctx.event.entityId;
  if (!isUuid(messageId)) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(
    ctx.tx,
    {
      kind: SCHEDULED_TEXT_JOBS.send,
      dedupeKey: scheduledTextJobKey(messageId),
      runAt: new Date(),
      payload: { messageId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
};

/** `message.send_scheduled`: the text goes (or ends, or says why), or waits for its time. */
export const sendScheduledTextJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const messageId = ctx.job.payload['messageId'];
  if (!isUuid(messageId)) return;
  const [m] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ sentBy: messages.sentBy })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.workspaceId, scope.workspaceId))),
  );
  if (!m) return;
  // HandsFreeOS sends it for the person who wrote it: the timeline credits them.
  const { output } = await executeCommand(
    ctx.db,
    messageReleaseScheduled,
    { workspaceId: scope.workspaceId, messageId },
    systemActor(scope, m.sentBy),
    workerMeta(null, ctx.job.id),
  );
  if (output.outcome === 'waiting' && output.retryAt)
    return { rescheduleAt: new Date(output.retryAt) };
};

export const scheduledTextJobs = {
  [SCHEDULED_TEXT_JOBS.send]: sendScheduledTextJob,
};
