import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { companies, files, leads, people } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { safeFileName } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import { hasWorkspacePermission } from '../permissions';
import {
  FileBeginUploadInput,
  FileBeginUploadOutput,
  FileConfirmInput,
  FileConfirmOutput,
  FileDeleteInput,
  FileDeleteOutput,
} from '../schemas/file';

async function requireRecord(
  ctx: CommandContext,
  recordType: 'person' | 'company' | 'lead',
  recordId: string,
) {
  const table = recordType === 'person' ? people : recordType === 'company' ? companies : leads;
  const [row] = await ctx.tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, recordId), eq(table.workspaceId, ctx.scope.workspaceId!)));
  if (!row) throw HfosError.notFound('Record not found.');
}

/**
 * Some files belong to the **business** rather than to a customer: a knowledge document
 * (`knowledge_document.begin_upload`) and the signed authorisation for moving a number
 * (`number_port.begin_upload`). Two things follow for both, and nothing else in this file changes:
 * a different permission decides who may touch them, and **no customer timeline hears of them** — there is
 * no customer to hear.
 */
const BUSINESS_OWN = {
  knowledge: {
    permission: 'knowledge.manage',
    refusal: 'Only owners and admins can change knowledge base files.',
  },
  port: {
    permission: 'channels.manage',
    refusal: 'Only owners and admins can change the papers for moving a number.',
  },
} as const;

type BusinessOwnType = keyof typeof BUSINESS_OWN;

const businessOwn = (recordType: string): recordType is BusinessOwnType =>
  recordType in BUSINESS_OWN;

function requireBusinessOwnManager(ctx: CommandContext, recordType: BusinessOwnType): void {
  const rule = BUSINESS_OWN[recordType];
  if (!hasWorkspacePermission(ctx.scope.workspaceRole, rule.permission))
    throw HfosError.forbidden(rule.refusal);
}

export const fileBeginUpload = defineCommand({
  name: 'file.begin_upload',
  description:
    'Reserve a place for a file on a record. Upload to the returned path, then confirm. The phone names the file itself, so asking again for the same one returns the same place.',
  risk: 1,
  input: FileBeginUploadInput,
  output: FileBeginUploadOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const earlier = await madeBefore(ctx.tx, 'files', input.id, workspaceId);
    if (earlier && !earlier.deletedAt && earlier.recordType !== 'knowledge')
      return { fileId: earlier.id, bucket: earlier.bucket, objectPath: earlier.objectPath };
    if (earlier) throw HfosError.notFound('File not found.');
    await requireRecord(ctx, input.recordType, input.recordId);
    const fileId = input.id ?? randomUUID();
    const objectPath = `${workspaceId}/${input.recordType}/${input.recordId}/${fileId}/${safeFileName(input.name)}`;
    const [row] = await insertWithId('files', input.id, () =>
      ctx.tx
        .insert(files)
        .values({
          id: fileId,
          workspaceId,
          recordType: input.recordType,
          recordId: input.recordId,
          bucket: 'attachments',
          objectPath,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          createdBy: requireHuman(ctx).userId,
          // Added when the person picked or took it: on a phone, perhaps well before it had signal.
          createdAt: changeMoment(ctx.meta),
        })
        .returning({ id: files.id }),
    );
    if (!row) throw HfosError.forbidden();
    return { fileId, bucket: 'attachments', objectPath };
  },
});

export const fileConfirm = defineCommand({
  name: 'file.confirm',
  description: 'Mark an uploaded file ready once the object exists in storage.',
  risk: 1,
  input: FileConfirmInput,
  output: FileConfirmOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['file.attached'],
  offline: 'anytime',
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!current || current.deletedAt) throw HfosError.notFound('File not found.');
    const ownFile = businessOwn(current.recordType);
    if (ownFile) requireBusinessOwnManager(ctx, current.recordType as BusinessOwnType);
    if (current.status === 'ready')
      return {
        fileId: current.id,
        sizeBytes: Number(current.sizeBytes ?? 0),
        mimeType: current.mimeType ?? 'application/octet-stream',
      };
    if (current.createdBy !== requireHuman(ctx).userId)
      throw HfosError.forbidden('Only the uploader can confirm a file.');
    const [info] = await rows<{ size_bytes: number | null; mime_type: string | null }>(
      ctx.tx,
      sql`select size_bytes, mime_type from private.storage_object_info(${current.bucket}, ${current.objectPath})`,
    );
    if (!info)
      throw HfosError.rule('file_not_uploaded', 409, 'The file has not finished uploading.');
    const sizeBytes = Number(info.size_bytes ?? current.sizeBytes ?? 0);
    const mimeType = info.mime_type ?? current.mimeType ?? 'application/octet-stream';
    await ctx.tx
      .update(files)
      .set({ status: 'ready', sizeBytes, mimeType })
      .where(eq(files.id, current.id));
    const eventId = await ctx.emit({
      type: 'file.attached',
      entityType: ownFile ? 'file' : current.recordType,
      entityId: ownFile ? current.id : current.recordId,
      payload: { fileId: current.id, name: current.name, mimeType, sizeBytes },
      after: { name: current.name, mimeType, sizeBytes },
    });
    if (ownFile) return { fileId: current.id, sizeBytes, mimeType };
    // On the timeline when the file was added: the confirmation's moment (a phone sends when the photo was taken),
    // never before the file was reserved.
    const madeAt = changeMoment(ctx.meta);
    await logSystemActivity(ctx, {
      subtype: 'file_added',
      personId: current.recordType === 'person' ? current.recordId : null,
      companyId: current.recordType === 'company' ? current.recordId : null,
      leadId: current.recordType === 'lead' ? current.recordId : null,
      body: current.name,
      meta: { fileId: current.id, mimeType, sizeBytes },
      eventId,
      occurredAt: madeAt < current.createdAt ? current.createdAt : madeAt,
    });
    return { fileId: current.id, sizeBytes, mimeType };
  },
});

export const fileDelete = defineCommand({
  name: 'file.delete',
  description: 'Remove a file from a record. The worker deletes the stored object afterwards.',
  risk: 2,
  input: FileDeleteInput,
  output: FileDeleteOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['file.deleted'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!current || current.deletedAt) throw HfosError.notFound('File not found.');
    const ownFile = businessOwn(current.recordType);
    if (ownFile) requireBusinessOwnManager(ctx, current.recordType as BusinessOwnType);
    await ctx.tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, current.id));
    await ctx.emit({
      type: 'file.deleted',
      entityType: ownFile ? 'file' : current.recordType,
      entityId: ownFile ? current.id : current.recordId,
      payload: {
        fileId: current.id,
        name: current.name,
        bucket: current.bucket,
        objectPath: current.objectPath,
      },
      before: { name: current.name },
      after: null,
    });
    return { fileId: current.id };
  },
});
