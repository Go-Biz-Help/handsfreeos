import { executeCommand, knowledgeDocumentSaveText, scheduleJob } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { files } from '@hfos/db/schema';
import { and, eq } from 'drizzle-orm';
import { documentText, type DocumentText } from '../files/document-text';
import { assertInWorkspace } from '../handlers/file-removed';
import type { HandlerContext } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { MAX_ATTEMPTS } from '../outbox';
import { systemActor, tenantOf, workerMeta } from '../services';

/**
 * Documents in the knowledge base: `knowledge_document.added` queues a `knowledge.document` job, which reads
 * the uploaded file (5 MB at most) and saves its text (100,000 characters at most) as a draft document item
 * through knowledge_document.save_text, for a person to review and publish (../files/document-text.ts reads
 * it). A PDF with no text in it (a scan) gets an empty draft and the note `no_text`.
 */

export const DOCUMENT_LIMITS = { bytes: 5 * 1024 * 1024 } as const;

interface DocumentJob {
  readonly fileId: string;
  readonly title: string | null;
  readonly kind: 'pdf' | 'text';
  readonly requestedBy: string | null;
  readonly correlationId: string;
  readonly causationId: string;
}

/** `knowledge_document.added` (the file is the event's entity): queue reading it. */
export async function onKnowledgeDocumentAdded(ctx: HandlerContext): Promise<void> {
  const p = ctx.event.payload as {
    fileId?: string;
    title?: string;
    kind?: string;
    requestedBy?: string | null;
  };
  if (!p.fileId) throw new Error('knowledge_document.added is missing its file');
  const job: DocumentJob = {
    fileId: p.fileId,
    title: p.title ?? null,
    kind: p.kind === 'pdf' ? 'pdf' : 'text',
    requestedBy: p.requestedBy ?? null,
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  };
  await scheduleJob(ctx.tx, {
    kind: 'knowledge.document',
    dedupeKey: `knowledge.document:${ctx.event.id}`,
    runAt: new Date(),
    payload: { ...job },
    workspaceId: ctx.event.workspaceId,
    organizationId: ctx.event.organizationId,
  });
}

export const knowledgeDocumentJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const job = ctx.job.payload as unknown as DocumentJob;
  const [file] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({
        bucket: files.bucket,
        objectPath: files.objectPath,
        name: files.name,
        sizeBytes: files.sizeBytes,
        deletedAt: files.deletedAt,
      })
      .from(files)
      .where(and(eq(files.id, job.fileId), eq(files.workspaceId, scope.workspaceId))),
  );
  if (!file || file.deletedAt) {
    ctx.log.info({ fileId: job.fileId }, 'document removed before its text was read');
    return;
  }
  let read: DocumentText;
  if (file.sizeBytes !== null && file.sizeBytes > DOCUMENT_LIMITS.bytes)
    read = { text: '', note: 'too_large' };
  else
    try {
      assertInWorkspace(file.objectPath, scope.workspaceId);
      const data = await ctx.store.download(file.bucket, file.objectPath);
      read =
        data.length > DOCUMENT_LIMITS.bytes
          ? { text: '', note: 'too_large' }
          : await documentText(data, job.kind);
    } catch (e) {
      // Storage not answering: try again later; after the last try, the draft says it couldn't be read.
      if (ctx.attempt < MAX_ATTEMPTS) throw e;
      ctx.log.error({ err: e, fileId: job.fileId }, 'document could not be read');
      read = { text: '', note: 'unreadable' };
    }
  const title = job.title?.trim() || file.name.replace(/\.[a-z0-9]{1,8}$/i, '').trim() || file.name;
  await executeCommand(
    ctx.db,
    knowledgeDocumentSaveText,
    {
      workspaceId: scope.workspaceId,
      fileId: job.fileId,
      title: title.slice(0, 200),
      text: read.text,
      note: read.note,
    },
    systemActor(scope, job.requestedBy),
    workerMeta(job.correlationId, job.causationId),
  );
};
