import { createHash } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { assertInWorkspace } from './file-removed';
import type { HandlerContext } from './types';

interface FilePayload {
  fileId?: string;
}

/**
 * `file.attached` and `file.locked` (Real Estate, step 3): records the stored object's SHA-256 on the file, once, so
 * what a signed document held can always be checked against what is stored. A file deleted meanwhile, or already
 * fingerprinted, is left alone; a missing object throws, and the job tries again.
 */
export async function onFileFingerprint(ctx: HandlerContext): Promise<void> {
  const { fileId } = ctx.event.payload as FilePayload;
  if (!fileId) throw new Error(`${ctx.event.eventType} payload is missing fileId`);
  const [file] = await rows<{ bucket: string; object_path: string }>(
    ctx.tx,
    sql`select bucket, object_path from app.files
        where id = ${fileId}::uuid and workspace_id = ${ctx.event.workspaceId}
          and sha256 is null and deleted_at is null and status = 'ready'`,
  );
  if (!file) return;
  assertInWorkspace(file.object_path, ctx.event.workspaceId);
  const data = await ctx.store.download(file.bucket, file.object_path);
  const sha256 = createHash('sha256').update(data).digest('hex');
  await rows(
    ctx.tx,
    sql`update app.files set sha256 = ${sha256}, hashed_at = now()
        where id = ${fileId}::uuid and sha256 is null`,
  );
}
