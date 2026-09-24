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
});
export type MediaRefOut = z.infer<typeof MediaRefSchema>;
