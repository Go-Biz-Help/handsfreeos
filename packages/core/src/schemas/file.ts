import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { attachableRecordType, UserRef } from './crm';

export const ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
] as const;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export const FileBeginUploadInput = z.object({
  workspaceId: uuid,
  /** The file's id, made by the phone so a photo taken offline has one before it uploads (M10). */
  id: uuid.optional(),
  recordType: attachableRecordType,
  recordId: uuid,
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(ATTACHMENT_TYPES, { error: 'That file type is not supported.' }),
  sizeBytes: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES, 'Files can be up to 25 MB.'),
});
export const FileBeginUploadOutput = z.object({
  fileId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});
export const FileConfirmInput = z.object({ workspaceId: uuid, fileId: uuid });
export const FileConfirmOutput = z.object({
  fileId: uuid,
  sizeBytes: z.number().int(),
  mimeType: z.string(),
});
export const FileDeleteInput = z.object({ workspaceId: uuid, fileId: uuid });
export const FileDeleteOutput = z.object({ fileId: uuid });

export const FileOut = z.object({
  id: uuid,
  recordType: attachableRecordType,
  recordId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  isImage: z.boolean(),
  uploadedBy: UserRef,
  createdAt: isoDateTime,
});
export type FileOut = z.infer<typeof FileOut>;
export const FileListInput = z.object({
  workspaceId: uuid,
  recordType: attachableRecordType,
  recordId: uuid,
});
export const FileListOutput = z.object({ files: z.array(FileOut) });
