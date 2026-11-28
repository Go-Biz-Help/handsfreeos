/** Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1): the commands and the list. */
import { z } from 'zod';
import {
  PICTURE_PATH,
  PICTURE_STATUSES,
  PICTURE_UPLOAD_BUCKET,
  PICTURE_UPLOAD_PATH,
} from '../look/pictures';
import { isoDateTime, uuid } from './common';

/** One picture in the library, as the screens and the Assistant read it. */
export const PictureRow = z.object({
  id: uuid,
  name: z.string(),
  /** What it shows, for screen readers and when it doesn't load. */
  words: z.string(),
  status: z.enum(PICTURE_STATUSES),
  /** The copy everyone sees, in the public `pictures` bucket, once it's ready. */
  path: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Why it couldn't be used, when it couldn't. */
  problem: z.string().nullable(),
  createdAt: isoDateTime,
});
export type PictureRow = z.infer<typeof PictureRow>;

export const PictureListInput = z.object({ workspaceId: uuid });
export const PictureListOutput = z.object({ pictures: z.array(PictureRow) });

export const PictureBeginUploadInput = z.object({
  workspaceId: uuid,
  /** The picture's own name, as picked. */
  name: z.string().trim().min(1, 'Pick a picture.').max(200),
  mimeType: z.string().trim().max(100),
  sizeBytes: z.int().min(1),
});
export const PictureBeginUploadOutput = z.object({
  pictureId: uuid,
  bucket: z.literal(PICTURE_UPLOAD_BUCKET),
  objectPath: z.string().regex(PICTURE_UPLOAD_PATH),
});

export const PictureUseUploadInput = z.object({ workspaceId: uuid, pictureId: uuid });
export const PictureUseUploadOutput = z.object({ picture: PictureRow });

export const PictureUpdateInput = z
  .object({
    workspaceId: uuid,
    pictureId: uuid,
    name: z.string().trim().min(1, 'Name the picture.').max(200).optional(),
    words: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.name !== undefined || v.words !== undefined, { error: 'Nothing to change.' });
export const PictureUpdateOutput = z.object({ picture: PictureRow });

export const PictureRemoveInput = z.object({ workspaceId: uuid, pictureId: uuid });
export const PictureRemoveOutput = z.object({ removed: z.boolean() });

export const PictureNoteMadeInput = z.object({
  workspaceId: uuid,
  pictureId: uuid,
  /** The copy the worker made; null when it couldn't. */
  made: z
    .object({
      path: z.string().regex(PICTURE_PATH),
      width: z.int().min(1).max(10_000),
      height: z.int().min(1).max(10_000),
      bytes: z.int().min(0),
    })
    .nullable(),
  /** Why it couldn't be used, in words for the person; null when it could. */
  problem: z.string().max(500).nullable(),
});
export const PictureNoteMadeOutput = z.object({ kept: z.boolean() });
