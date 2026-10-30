import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { companies, customRecords, files, leads, people } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { safeFileName } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import {
  FileBeginUploadInput,
  FileBeginUploadOutput,
  FileConfirmInput,
  FileConfirmOutput,
  FileDeleteInput,
  FileDeleteOutput,
  FileLockInput,
  FileLockOutput,
  FileStoreInput,
  FileStoreOutput,
} from '../schemas/file';
import { scopeCan } from '../kernel/execute';

const RECORD_WORDS = {
  person: 'customer',
  company: 'company',
  lead: 'lead',
  custom_record: 'record',
} as const;

const fileGone = 'That file isn’t there anymore. It may have been deleted. Refresh and try again.';

async function requireRecord(
  ctx: CommandContext,
  recordType: 'person' | 'company' | 'lead' | 'custom_record',
  recordId: string,
) {
  const table =
    recordType === 'person'
      ? people
      : recordType === 'company'
        ? companies
        : recordType === 'custom_record'
          ? customRecords
          : leads;
  const [row] = await ctx.tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, recordId), eq(table.workspaceId, ctx.scope.workspaceId!)));
  if (!row)
    throw HfosError.notFound(
      `That ${RECORD_WORDS[recordType]} isn’t there anymore. It may have been deleted. Refresh and try again.`,
    );
}

/**
 * Some files belong to the **business** rather than to a customer: a knowledge document
 * (`knowledge_document.begin_upload`), the signed authorisation for moving a number
 * (`number_port.begin_upload`), a document template's PDF and a live poll's slides. Two things follow for
 * each, and nothing else in this file changes: a different permission decides who may touch them, and **no
 * customer timeline hears of them** — there is no customer to hear.
 */
const BUSINESS_OWN = {
  knowledge: {
    permission: 'knowledge.manage',
    refusal:
      'Only owners and admins of this business can change knowledge base files. Ask one of them.',
  },
  port: {
    permission: 'channels.manage',
    refusal:
      'Only owners and admins of this business can change the papers for moving a number. Ask one of them.',
  },
  /** The PDF a document template is made from (20261027015200): its record is the template. */
  document: {
    permission: 'documents.manage',
    refusal:
      'Only people who make document templates can change a template’s PDF. Ask an owner or admin of this business.',
  },
  /** A live poll's slides, a PDF (20261027020000): its record is the poll's form. */
  form: {
    permission: 'forms.manage',
    refusal:
      'Only people who make forms can change a live poll’s slides. Ask an owner or admin of this business.',
  },
} as const;

type BusinessOwnType = keyof typeof BUSINESS_OWN;

const businessOwn = (recordType: string): recordType is BusinessOwnType =>
  recordType in BUSINESS_OWN;

function requireBusinessOwnManager(ctx: CommandContext, recordType: BusinessOwnType): void {
  const rule = BUSINESS_OWN[recordType];
  if (!scopeCan(ctx.scope, rule.permission)) throw HfosError.forbidden(rule.refusal);
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
    if (earlier)
      throw HfosError.notFound(
        'That file isn’t there anymore. It may have been removed. Pick the file again to add it.',
      );
    await requireRecord(ctx, input.recordType, input.recordId);
    const fileId = input.id ?? randomUUID();
    const objectPath = storedFilePath(
      workspaceId,
      input.recordType,
      input.recordId,
      fileId,
      input.name,
    );
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

/** Where a file on a record is kept in storage: what `file.begin_upload` reserves, and where the worker stores one. */
export const storedFilePath = (
  workspaceId: string,
  recordType: string,
  recordId: string,
  fileId: string,
  name: string,
) => `${workspaceId}/${recordType}/${recordId}/${fileId}/${safeFileName(name)}`;

export const fileStore = defineCommand({
  name: 'file.store',
  description:
    'Worker: a file it fetched or made for a record (a document signed at DocuSign, say), already uploaded to its place in storage. Kept ready, as storage measured it, and put on the timeline.',
  risk: 1,
  input: FileStoreInput,
  output: FileStoreOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['file.attached'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [earlier] = await ctx.tx
      .select({ id: files.id, sizeBytes: files.sizeBytes, recordId: files.recordId })
      .from(files)
      .where(eq(files.id, input.id));
    if (earlier) {
      if (earlier.recordId !== input.recordId) throw HfosError.forbidden();
      return { fileId: earlier.id, sizeBytes: Number(earlier.sizeBytes ?? 0), changed: false };
    }
    await requireRecord(ctx, input.recordType, input.recordId);
    const objectPath = storedFilePath(
      workspaceId,
      input.recordType,
      input.recordId,
      input.id,
      input.name,
    );
    const [info] = await rows<{ size_bytes: number | null; mime_type: string | null }>(
      ctx.tx,
      sql`select size_bytes, mime_type from private.storage_object_info('attachments', ${objectPath})`,
    );
    if (!info)
      throw HfosError.rule(
        'file_not_uploaded',
        409,
        `${input.name} isn’t in storage yet, so it can’t be kept. It’s tried again on its own.`,
      );
    const sizeBytes = Math.max(1, Number(info.size_bytes ?? 0));
    await ctx.tx.insert(files).values({
      id: input.id,
      workspaceId,
      recordType: input.recordType,
      recordId: input.recordId,
      bucket: 'attachments',
      objectPath,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes,
      status: 'ready',
      createdBy: null,
    });
    const eventId = await ctx.emit({
      type: 'file.attached',
      entityType: input.recordType,
      entityId: input.recordId,
      payload: { fileId: input.id, name: input.name, mimeType: input.mimeType, sizeBytes },
      after: { name: input.name, mimeType: input.mimeType, sizeBytes },
    });
    await logSystemActivity(ctx, {
      subtype: 'file_added',
      personId: input.recordType === 'person' ? input.recordId : null,
      companyId: input.recordType === 'company' ? input.recordId : null,
      leadId: input.recordType === 'lead' ? input.recordId : null,
      customRecordId: input.recordType === 'custom_record' ? input.recordId : null,
      body: input.name,
      meta: {
        fileId: input.id,
        mimeType: input.mimeType,
        sizeBytes,
        ...(input.from ? { from: input.from } : {}),
      },
      eventId,
    });
    return { fileId: input.id, sizeBytes, changed: true };
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
    if (!current || current.deletedAt) throw HfosError.notFound(fileGone);
    const ownFile = businessOwn(current.recordType);
    if (ownFile) requireBusinessOwnManager(ctx, current.recordType as BusinessOwnType);
    if (current.status === 'ready')
      return {
        fileId: current.id,
        sizeBytes: Number(current.sizeBytes ?? 0),
        mimeType: current.mimeType ?? 'application/octet-stream',
      };
    if (current.createdBy !== requireHuman(ctx).userId)
      throw HfosError.forbidden(
        'Only the person who uploaded this file can finish adding it. Add the file again yourself if you need it here.',
      );
    const [info] = await rows<{ size_bytes: number | null; mime_type: string | null }>(
      ctx.tx,
      sql`select size_bytes, mime_type from private.storage_object_info(${current.bucket}, ${current.objectPath})`,
    );
    if (!info)
      throw HfosError.rule(
        'file_not_uploaded',
        409,
        `${current.name} didn’t finish uploading. Check your connection and add it again.`,
      );
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
      customRecordId: current.recordType === 'custom_record' ? current.recordId : null,
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
    if (!current || current.deletedAt) throw HfosError.notFound(fileGone);
    const ownFile = businessOwn(current.recordType);
    if (ownFile) requireBusinessOwnManager(ctx, current.recordType as BusinessOwnType);
    // The database refuses it too (private.guard_document_file): documents sent from it still read it.
    if (current.recordType === 'document')
      throw HfosError.rule(
        'document_file_kept',
        409,
        `${current.name} is a template’s PDF, kept for the documents sent from it. Add another PDF on the template to replace it.`,
      );
    // Published versions of the poll, and calls that showed them, still point at them.
    if (current.recordType === 'form')
      throw HfosError.rule(
        'slides_file_kept',
        409,
        `${current.name} is a live poll’s slides, kept for the versions of the poll that show them. Add other slides on the poll to replace them.`,
      );
    // The database refuses it too (private.guard_locked_file); this says so with the file's name.
    if (current.lockedAt)
      throw HfosError.rule(
        'file_locked',
        409,
        `${current.name} is signed and kept, so it can’t be deleted. Add the newer version as another file instead.`,
      );
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

/**
 * Lock a file for good: a signed contract, a disclosure, a final version (Real Estate, step 3). From then on nobody
 * deletes, renames or unlocks it; the database holds it to that (`private.guard_locked_file`), and deleting the whole
 * business is the only way it goes. An add-on that locks one is named on it, and the lock outlasts the add-on.
 */
export const fileLock = defineCommand({
  name: 'file.lock',
  description:
    'Lock a file on a record for good, like a signed contract: nobody can delete or rename it afterwards. Add a newer file to replace it.',
  risk: 2,
  input: FileLockInput,
  output: FileLockOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['file.locked'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!current || current.deletedAt) throw HfosError.notFound(fileGone);
    if (businessOwn(current.recordType))
      throw HfosError.rule(
        'file_not_lockable',
        409,
        `${current.name} belongs to the business, not a customer’s record, so it isn’t locked. Only files on a customer or a record are.`,
      );
    if (current.lockedAt)
      return { fileId: current.id, lockedAt: current.lockedAt.toISOString(), changed: false };
    if (current.status !== 'ready')
      throw HfosError.rule(
        'file_not_ready',
        409,
        `${current.name} hasn’t finished uploading, so it can’t be locked yet. Try again in a minute.`,
      );
    const lockedAt = new Date();
    const lockedBy = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    await ctx.tx
      .update(files)
      .set({
        lockedAt,
        lockedBy,
        lockedReason: input.reason,
        lockedByAddon: ctx.addon?.id ?? null,
      })
      .where(eq(files.id, current.id));
    const eventId = await ctx.emit({
      type: 'file.locked',
      entityType: current.recordType,
      entityId: current.recordId,
      payload: { fileId: current.id, name: current.name, reason: input.reason },
      before: { locked: false },
      after: { name: current.name, locked: true, reason: input.reason },
    });
    await logSystemActivity(ctx, {
      subtype: 'file_locked',
      personId: current.recordType === 'person' ? current.recordId : null,
      companyId: current.recordType === 'company' ? current.recordId : null,
      leadId: current.recordType === 'lead' ? current.recordId : null,
      customRecordId: current.recordType === 'custom_record' ? current.recordId : null,
      body: current.name,
      meta: { fileId: current.id, reason: input.reason },
      eventId,
    });
    return { fileId: current.id, lockedAt: lockedAt.toISOString(), changed: true };
  },
});
