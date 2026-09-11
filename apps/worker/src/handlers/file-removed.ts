import { rows, sql } from '@hfos/db/client';
import { recordSystemEvent } from '../system-event';
import type { HandlerContext } from './types';

interface FileDeletedPayload {
  fileId?: string;
  name?: string;
  bucket?: string;
  objectPath?: string;
}

const PENDING_TTL = '1 hour';

/** Refuses any path outside the job's workspace: the worker's key must never act on another tenant's objects. */
export function assertInWorkspace(objectPath: string, workspaceId: string | null): void {
  if (!workspaceId || !objectPath.startsWith(`${workspaceId}/`) || objectPath.includes('..'))
    throw new Error(`object path ${objectPath} is outside workspace ${workspaceId ?? 'null'}`);
}

/**
 * `file.deleted`: the row was marked deleted by a person with `files.delete`; the worker removes the
 * stored object with its own key and records `file.removed`. Missing objects are fine (retries).
 * The same pass sweeps this workspace's pending rows older than an hour (uploads that never confirmed).
 */
export async function onFileDeleted(ctx: HandlerContext): Promise<void> {
  const payload = ctx.event.payload as FileDeletedPayload;
  const { fileId, bucket, objectPath } = payload;
  if (!fileId || !bucket || !objectPath)
    throw new Error('file.deleted payload is missing fileId, bucket or objectPath');
  assertInWorkspace(objectPath, ctx.event.workspaceId);
  await ctx.store.remove(bucket, objectPath);
  await recordSystemEvent(ctx.tx, {
    type: 'file.removed',
    action: 'file.remove',
    organizationId: ctx.event.organizationId,
    workspaceId: ctx.event.workspaceId,
    entityType: 'file',
    entityId: fileId,
    payload: { fileId, bucket, objectPath },
    after: { name: payload.name ?? objectPath.split('/').pop(), bucket, objectPath },
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
  await sweepPending(ctx);
}

/** Deletes pending rows older than an hour and any object that was uploaded but never confirmed. */
export async function sweepPending(ctx: HandlerContext): Promise<number> {
  const stale = await rows<{ id: string; bucket: string; object_path: string }>(
    ctx.tx,
    sql`delete from app.files
        where workspace_id = ${ctx.event.workspaceId} and status = 'pending' and deleted_at is null
          and created_at < now() - ${PENDING_TTL}::interval
        returning id, bucket, object_path`,
  );
  for (const row of stale) {
    assertInWorkspace(row.object_path, ctx.event.workspaceId);
    await ctx.store.remove(row.bucket, row.object_path);
  }
  if (stale.length)
    ctx.log.info({ swept: stale.length }, 'removed pending uploads older than an hour');
  return stale.length;
}
