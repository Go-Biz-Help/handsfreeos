/**
 * Files in a customer's portal (Real Estate round two, step 4; core). A customer adds one from their portal in three
 * moves: `portal.upload_begin` reserves its place (on them, or on a record they're on), the worker hands their browser
 * a one-time link to put it there, and `portal.upload_confirm` checks what arrived. What isn't a PDF or a photo, or is
 * over 20 MB, is removed there and then; what is goes on the record's timeline and is fingerprinted like any file.
 * The business shares its own files with the customer with `file.share_to_portal`; `portal.files` lists what they see.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { files } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { safeFileName } from '../crm/records';
import { HfosError } from '../errors';
import { requireCustomer } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  FileShareToPortalInput,
  FileShareToPortalOutput,
  PORTAL_UPLOAD_MAX_BYTES,
  PORTAL_UPLOAD_TYPES,
  PORTAL_UPLOADS_PER_DAY,
  PortalFilesInput,
  PortalFilesOutput,
  PortalUploadBeginInput,
  PortalUploadBeginOutput,
  PortalUploadConfirmInput,
  PortalUploadConfirmOutput,
} from '../schemas/portal';

const inWorkspace = (i: { workspaceId: string }) =>
  ({ kind: 'workspace', workspaceId: i.workspaceId }) as const;

const MB = 1024 * 1024;
const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;
const allowedType = (mime: string) =>
  (PORTAL_UPLOAD_TYPES as readonly string[]).includes(mime.toLowerCase());

const wrongType = (name: string) => ({
  rule: 'portal_file_type',
  message: `${name} isn’t a PDF or a photo, so it can’t be added here. Save it as a PDF, or take a photo of it, and add that.`,
});
const tooBig = (name: string, bytes: number) => ({
  rule: 'portal_file_too_big',
  message: `${name} is ${megabytes(bytes)}. Files can be up to ${megabytes(PORTAL_UPLOAD_MAX_BYTES)}. Save a smaller copy (a PDF of fewer pages, or a photo) and add that.`,
});

/** Whether the customer acting is on this record through a portal-visible relationship. */
async function onRecord(ctx: CommandContext, personId: string, recordId: string): Promise<boolean> {
  const [r] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select ${recordId}::uuid in (
          select private.portal_records_for(${ctx.scope.workspaceId}::uuid, ${personId}::uuid)) as ok`,
  );
  return !!r?.ok;
}

export const portalUploadBegin = defineCommand({
  name: 'portal.upload_begin',
  description:
    'A customer starts adding a file from their portal: on themselves, or on a record they’re on. The worker then gives their browser a one-time link to upload it.',
  risk: 1,
  input: PortalUploadBeginInput,
  output: PortalUploadBeginOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const workspaceId = ctx.scope.workspaceId!;
    if (!allowedType(input.mimeType)) {
      const r = wrongType(input.name);
      throw HfosError.rule(r.rule, 422, r.message);
    }
    if (input.sizeBytes > PORTAL_UPLOAD_MAX_BYTES) {
      const r = tooBig(input.name, input.sizeBytes);
      throw HfosError.rule(r.rule, 422, r.message);
    }
    if (input.recordId && !(await onRecord(ctx, me.personId, input.recordId)))
      throw HfosError.notFound(
        'That isn’t in your portal any more. Refresh the page to see what is.',
      );
    const [today] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.files
          where uploaded_by_person_id = ${me.personId} and created_at > now() - interval '1 day'`,
    );
    if ((today?.n ?? 0) >= PORTAL_UPLOADS_PER_DAY)
      throw HfosError.rule(
        'too_many_uploads',
        429,
        `You’ve added ${PORTAL_UPLOADS_PER_DAY} files today, the most a day. Add the rest tomorrow.`,
      );
    const fileId = randomUUID();
    const recordType = input.recordId ? 'custom_record' : 'person';
    const recordId = input.recordId ?? me.personId;
    const objectPath = `${workspaceId}/${recordType}/${recordId}/${fileId}/${safeFileName(input.name)}`;
    await ctx.tx.insert(files).values({
      id: fileId,
      workspaceId,
      recordType,
      recordId,
      bucket: 'attachments',
      objectPath,
      name: input.name,
      mimeType: input.mimeType.toLowerCase(),
      sizeBytes: input.sizeBytes,
      uploadedByPersonId: me.personId,
      portalVisible: true,
    });
    return { fileId, bucket: 'attachments', objectPath };
  },
});

export const portalUploadConfirm = defineCommand({
  name: 'portal.upload_confirm',
  description:
    'A customer finishes adding a file from their portal: it’s checked, then shown to the business on the record’s timeline.',
  risk: 1,
  input: PortalUploadConfirmInput,
  output: PortalUploadConfirmOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['file.attached', 'file.deleted'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [current] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!current || current.deletedAt || current.uploadedByPersonId !== me.personId)
      throw HfosError.notFound('That file isn’t there any more. Add it again.');
    const done = (accepted: boolean, refusal: { rule: string; message: string } | null) => ({
      fileId: current.id,
      accepted,
      refusal,
      name: current.name,
      sizeBytes: Number(current.sizeBytes ?? 0),
      mimeType: current.mimeType ?? 'application/octet-stream',
    });
    if (current.status === 'ready') return done(true, null);
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
    const sizeBytes = Number(info.size_bytes ?? 0);
    const mimeType = (info.mime_type ?? '').toLowerCase();
    // What arrived is what counts: the browser said what it was sending, Storage says what came.
    const refusal = !allowedType(mimeType)
      ? wrongType(current.name)
      : sizeBytes > PORTAL_UPLOAD_MAX_BYTES
        ? tooBig(current.name, sizeBytes)
        : null;
    if (refusal) {
      await ctx.tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, current.id));
      // The worker removes the object (file.deleted), as it does for every file taken off.
      await ctx.emit({
        type: 'file.deleted',
        entityType: current.recordType,
        entityId: current.recordId,
        payload: {
          fileId: current.id,
          name: current.name,
          bucket: current.bucket,
          objectPath: current.objectPath,
          refused: refusal.rule,
        },
        before: { name: current.name },
        after: null,
      });
      return {
        ...done(false, refusal),
        sizeBytes,
        mimeType: mimeType || 'application/octet-stream',
      };
    }
    await ctx.tx
      .update(files)
      .set({ status: 'ready', sizeBytes, mimeType })
      .where(eq(files.id, current.id));
    const eventId = await ctx.emit({
      type: 'file.attached',
      entityType: current.recordType,
      entityId: current.recordId,
      payload: { fileId: current.id, name: current.name, mimeType, sizeBytes, fromPortal: true },
      after: { name: current.name, mimeType, sizeBytes },
    });
    await logSystemActivity(ctx, {
      subtype: 'file_added',
      personId: current.recordType === 'person' ? current.recordId : null,
      customRecordId: current.recordType === 'custom_record' ? current.recordId : null,
      body: current.name,
      meta: { fileId: current.id, mimeType, sizeBytes },
      eventId,
    });
    return { ...done(true, null), sizeBytes, mimeType };
  },
});

export const portalFiles = defineQuery({
  name: 'portal.files',
  description:
    'The files in a customer’s portal: those they added, and those the business shared with them. All of them, or one record’s.',
  input: PortalFilesInput,
  output: PortalFilesOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    // Row security decides which: the portal role reads only what's shown to this customer.
    const list = await rows<{
      id: string;
      name: string;
      mime_type: string | null;
      size_bytes: number | string | null;
      record_type: string;
      record_id: string;
      uploaded_by_person_id: string | null;
      locked_at: Date | string | null;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select id, name, mime_type, size_bytes, record_type::text, record_id, uploaded_by_person_id, locked_at,
            created_at
          from app.files
          where ${input.recordId}::uuid is null or record_id = ${input.recordId}::uuid
          order by created_at desc
          limit 200`,
    );
    return {
      files: list.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes === null ? null : Number(f.size_bytes),
        recordId: f.record_type === 'custom_record' ? f.record_id : null,
        fromYou: f.uploaded_by_person_id === me.personId,
        locked: f.locked_at !== null,
        addedAt: new Date(f.created_at).toISOString(),
      })),
    };
  },
});

export const fileShareToPortal = defineCommand({
  name: 'file.share_to_portal',
  description:
    'Show a file in the portal of the customer it’s on, or of the clients on its record; or stop showing it.',
  risk: 2,
  input: FileShareToPortalInput,
  output: FileShareToPortalOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['file.portal_shared'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!current || current.deletedAt || current.status !== 'ready')
      throw HfosError.notFound(
        'That file isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    if (current.recordType !== 'person' && current.recordType !== 'custom_record')
      throw HfosError.rule(
        'portal_file_not_shareable',
        422,
        `${current.name} isn’t on a customer or one of their records, so it can’t go in a portal.`,
      );
    if (current.uploadedByPersonId && !input.shared)
      throw HfosError.rule(
        'portal_file_theirs',
        409,
        `${current.name} came from the customer, so it stays in their portal.`,
      );
    if (current.portalVisible === input.shared)
      return { fileId: current.id, shared: input.shared, changed: false };
    await ctx.tx.update(files).set({ portalVisible: input.shared }).where(eq(files.id, current.id));
    await ctx.emit({
      type: 'file.portal_shared',
      entityType: current.recordType,
      entityId: current.recordId,
      payload: { fileId: current.id, name: current.name, shared: input.shared },
      before: { portalVisible: current.portalVisible },
      after: { portalVisible: input.shared },
    });
    return { fileId: current.id, shared: input.shared, changed: true };
  },
});

export const portalFileCommands = [
  portalUploadBegin,
  portalUploadConfirm,
  fileShareToPortal,
] as const;
export const portalFileQueries = [portalFiles] as const;
