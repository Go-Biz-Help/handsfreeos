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

/** Why a file is locked: a signed document, a final version, or something kept as a record. */
/**
 * Worker: a file it fetched or made for a record (a document signed at DocuSign, say), already uploaded to its place
 * (`storedFilePath`). The id is the worker's, so asking again keeps one file.
 */
export const FileStoreInput = z.object({
  workspaceId: uuid,
  id: uuid,
  recordType: attachableRecordType,
  recordId: uuid,
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(ATTACHMENT_TYPES, { error: 'That file type is not supported.' }),
  /** What it came from, for the timeline: `docusign`, say. */
  from: z.string().trim().min(1).max(60).optional(),
});
export const FileStoreOutput = z.object({
  fileId: uuid,
  sizeBytes: z.number().int(),
  /** False when it was kept already: asked again. */
  changed: z.boolean(),
});

export const FILE_LOCK_REASONS = ['signed', 'final', 'record'] as const;
export type FileLockReason = (typeof FILE_LOCK_REASONS)[number];
export const FileLockInput = z.object({
  workspaceId: uuid,
  fileId: uuid,
  reason: z.enum(FILE_LOCK_REASONS).default('signed'),
});
export const FileLockOutput = z.object({
  fileId: uuid,
  lockedAt: isoDateTime,
  /** False when it was already locked: a second press. */
  changed: z.boolean(),
});

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
  /** Locked (a signed document): it can't be deleted or renamed, only replaced by a newer file. */
  locked: z.boolean(),
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
