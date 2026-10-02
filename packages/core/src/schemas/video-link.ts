import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/** A person asks a customer for a video: a link to text them, made for one conversation. */
export const VideoLinkCreateInput = z.object({
  workspaceId: uuid,
  conversationId: uuid,
});
export const VideoLinkCreateOutput = z.object({
  videoLinkId: uuid,
  /** The key in the link, shown once to send and never kept. */
  token: z.string(),
  /** Where the customer opens it on the app's own address: `/v/<token>`. */
  path: z.string(),
  expiresAt: isoDateTime,
  maxUploads: z.number().int(),
});

/** Worker: the customer's page is about to send a video. */
export const VideoLinkStartUploadInput = z.object({
  workspaceId: uuid,
  videoLinkId: uuid,
  name: z.string().trim().min(1).max(200),
  contentType: z.string().max(120),
  sizeBytes: z.number().int().min(0),
});
export const VideoLinkStartUploadOutput = z.object({
  /** The message the video will arrive as, and the folder it goes up into. */
  uploadId: uuid,
  bucket: z.string(),
  objectPath: z.string(),
});

/** Worker: the video went up, and storage says what arrived. */
export const VideoLinkReceiveUploadInput = z.object({
  workspaceId: uuid,
  videoLinkId: uuid,
  uploadId: uuid,
  objectPath: z.string().min(3).max(500),
  name: z.string().trim().min(1).max(200),
  contentType: z.string().max(120),
  sizeBytes: z.number().int().min(1),
});
export const VideoLinkReceiveUploadOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  duplicate: z.boolean(),
});

// ---------- asking for a file (20261018000400) ----------

/** The AI teammate asks for a file that answers one of its qualifying questions, on the customer's lead. */
export const FileLinkCreateInput = z.object({
  workspaceId: uuid,
  conversationId: uuid,
  leadId: uuid,
  questionId: z.string().trim().min(1).max(40),
});
export const FileLinkCreateOutput = VideoLinkCreateOutput;

/** A photo or PDF the customer texted or emailed, saved as their answer to a file question. */
export const LeadSaveFileAnswerInput = z.object({
  workspaceId: uuid,
  leadId: uuid,
  questionId: z.string().trim().min(1).max(40),
  /** The customer's message it came in. */
  messageId: uuid,
});
export const LeadSaveFileAnswerOutput = z.object({
  leadId: uuid,
  /** The files it put on the lead. */
  files: z.array(z.object({ fileId: uuid, name: z.string() })),
  status: z.enum(['qualified', 'not_a_fit', 'incomplete']),
  missing: z.array(z.string()),
  /** It qualified just now (`lead.qualified` went out). */
  qualified: z.boolean(),
  /** That message was saved for this question already: nothing new. */
  duplicate: z.boolean(),
});

/** Worker: a customer's file is copied from their message onto the record it was filed on. */
export const FileFinishCopyInput = z.object({
  workspaceId: uuid,
  fileId: uuid,
  /** What the worker put in storage. */
  sizeBytes: z.number().int().min(1),
});
export const FileFinishCopyOutput = z.object({ fileId: uuid, ready: z.boolean() });
