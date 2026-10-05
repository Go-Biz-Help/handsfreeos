import { asWorker } from '@hfos/db/client';
import { files } from '@hfos/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { assertInWorkspace } from '../handlers/file-removed';
import type { TenantScope, WorkerServices } from '../services';

/**
 * A stored file's bytes, for worker code that reads what a person uploaded (an add-on reading a contract). The row
 * is read as the worker in the business, so another business's file is never found, and its object path must sit
 * under the business's own folder before anything is downloaded. A file over `maxBytes` isn't downloaded at all.
 */
export type FileBytes =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly name: string;
      readonly mimeType: string | null;
    }
  /** `removed`: deleted, never finished uploading, or not this business's. */
  | { readonly ok: false; readonly why: 'removed' | 'too_large' };

export async function readFileBytes(
  services: Pick<WorkerServices, 'db' | 'store'>,
  scope: TenantScope,
  fileId: string,
  maxBytes: number,
): Promise<FileBytes> {
  const [file] = await asWorker(services.db, scope, (tx) =>
    tx
      .select({
        bucket: files.bucket,
        objectPath: files.objectPath,
        name: files.name,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
      })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.workspaceId, scope.workspaceId),
          eq(files.status, 'ready'),
          isNull(files.deletedAt),
        ),
      ),
  );
  if (!file) return { ok: false, why: 'removed' };
  if (file.sizeBytes !== null && file.sizeBytes > maxBytes) return { ok: false, why: 'too_large' };
  assertInWorkspace(file.objectPath, scope.workspaceId);
  const bytes = await services.store.download(file.bucket, file.objectPath);
  if (bytes.length > maxBytes) return { ok: false, why: 'too_large' };
  return { ok: true, bytes, name: file.name, mimeType: file.mimeType };
}
