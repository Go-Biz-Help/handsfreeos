/** A business's logo and colour (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): the commands. */
import { z } from 'zod';
import { isLookColor } from '../look/colour';
import {
  BusinessLookSchema,
  LOOK_LOGO_PATH,
  LOOK_UPLOAD_BUCKET,
  LOOK_UPLOAD_PATH,
} from '../look/look';
import { uuid } from './common';

const hex = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isLookColor, { error: 'Pick a colour like #2d69d8.' });

export const LookBeginUploadInput = z.object({
  workspaceId: uuid,
  /** The picture's own name, as picked. */
  name: z.string().trim().min(1, 'Pick a picture of your logo.').max(200),
  mimeType: z.string().trim().max(100),
  sizeBytes: z.int().min(1),
});
export const LookBeginUploadOutput = z.object({
  bucket: z.literal(LOOK_UPLOAD_BUCKET),
  objectPath: z.string().regex(LOOK_UPLOAD_PATH),
});

export const LookUseUploadInput = z.object({
  workspaceId: uuid,
  objectPath: z.string().regex(LOOK_UPLOAD_PATH, 'Upload the logo again.'),
});
export const LookUseUploadOutput = z.object({ look: BusinessLookSchema });

export const LookSetInput = z
  .object({
    workspaceId: uuid,
    /** The colour picked. */
    color: hex.optional(),
    /** Takes the logo off: the initials stand in again. */
    removeLogo: z.literal(true).optional(),
  })
  .refine((v) => v.color !== undefined || v.removeLogo, { error: 'Nothing to change.' });
export const LookSetOutput = z.object({ look: BusinessLookSchema, changed: z.boolean() });

export const LookFindInput = z.object({ workspaceId: uuid });
export const LookFindOutput = z.object({ look: BusinessLookSchema, url: z.string() });

/** A logo the worker made, as kept. */
const madeLogo = z.object({
  path: z.string().regex(LOOK_LOGO_PATH),
  width: z.int().min(1).max(4000),
  height: z.int().min(1).max(4000),
});

export const LookNoteWebsiteInput = z.object({
  workspaceId: uuid,
  /** The website looked at: nothing is kept when it has changed since. */
  url: z.string().max(500),
  /** The logo found there, made into a PNG; null when there wasn't one. */
  logo: madeLogo.nullable(),
  /** The colour it stands for: the logo's, else the website's own; null when neither has one. */
  color: z.object({ hex, from: z.enum(['logo', 'website']) }).nullable(),
});
export const LookNoteWebsiteOutput = z.object({ kept: z.boolean() });

export const LookNoteUploadInput = z.object({
  workspaceId: uuid,
  /** The upload this is about: nothing changes when it's no longer the one waiting. */
  objectPath: z.string().regex(LOOK_UPLOAD_PATH),
  logo: madeLogo.nullable(),
  color: hex.nullable(),
  /** Why it couldn't be used, in words for the person; null when it could. */
  problem: z.string().max(500).nullable(),
});
export const LookNoteUploadOutput = z.object({ kept: z.boolean() });
