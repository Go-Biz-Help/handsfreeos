import { z } from 'zod';
import { uuid } from './common';

/** A stored photo, recording or attachment (telephony bucket) or a customer file sent as an attachment. */
export const MediaRefSchema = z.object({
  bucket: z.string().min(1).max(63),
  objectPath: z.string().min(3).max(500),
  contentType: z.string().max(120),
  sizeBytes: z.number().int().min(0),
  name: z.string().max(200),
  fileId: uuid.optional(),
  /**
   * How it came, when it wasn't by text: a video the customer sent through a link we texted them, or a photo or PDF
   * through a link that asked for a file.
   */
  via: z.enum(['video_link', 'file_link']).optional(),
});
export type MediaRefOut = z.infer<typeof MediaRefSchema>;
