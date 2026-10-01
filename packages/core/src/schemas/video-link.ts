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
