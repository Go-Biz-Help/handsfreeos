'use client';
/** The calls behind Your pictures (core's picture commands and picture.list), from the browser. */
import {
  isAppleHeic,
  PICTURE_PROBLEMS,
  PICTURE_TYPE_BY_ENDING,
  PICTURE_UPLOAD_TYPES,
  type PictureRow,
} from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';

/** The pictures someone can pick, for the file picker. */
export const PICTURE_ACCEPT = Object.keys(PICTURE_UPLOAD_TYPES).join(',');

/** A made picture, at Storage's public address. */
export { pictureSrc } from '@/lib/look';

export function pictureActions(workspaceId: string) {
  // Made when first used: the screens create these while they render, on the server too.
  const api = () => apiBrowser();
  return {
    list: async (): Promise<PictureRow[]> =>
      unwrap(await api().POST('/v1/queries/picture.list', { body: { workspaceId } }))
        .pictures as PictureRow[],
    /**
     * Uploads a picture where `picture.begin_upload` says, then hands it to the worker, which makes the web copy
     * (`picture.upload_ready`). The picture comes back being made.
     */
    upload: async (file: File): Promise<PictureRow> => {
      if (isAppleHeic(file.type, file.name)) throw new Error(PICTURE_PROBLEMS.heic);
      const ending = file.name.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = file.type || PICTURE_TYPE_BY_ENDING[ending] || 'application/octet-stream';
      const begun = unwrap(
        await api().POST('/v1/commands/picture.begin_upload', {
          body: { workspaceId, name: file.name, mimeType, sizeBytes: file.size },
        }),
      );
      const { error } = await supabaseBrowser()
        .storage.from(begun.bucket)
        .upload(begun.objectPath, file, { contentType: mimeType, upsert: false });
      if (error)
        throw new Error(`${file.name} didn’t upload. Check your connection and upload it again.`);
      return unwrap(
        await api().POST('/v1/commands/picture.use_upload', {
          body: { workspaceId, pictureId: begun.pictureId },
        }),
      ).picture as PictureRow;
    },
    update: async (
      pictureId: string,
      patch: { name?: string; words?: string },
    ): Promise<PictureRow> =>
      unwrap(
        await api().POST('/v1/commands/picture.update', {
          body: { workspaceId, pictureId, ...patch },
        }),
      ).picture as PictureRow,
    remove: async (pictureId: string): Promise<void> => {
      unwrap(await api().POST('/v1/commands/picture.remove', { body: { workspaceId, pictureId } }));
    },
  };
}

export type PictureActions = ReturnType<typeof pictureActions>;
