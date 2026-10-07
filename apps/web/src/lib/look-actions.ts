'use client';
/** The calls that change a business's logo and colour (core's look commands), from the browser. */
import { LOOK_UPLOAD_TYPES, type BusinessLook, type LookUploadType } from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';

/** The pictures a logo can be, for the file picker. */
export const LOOK_ACCEPT = Object.keys(LOOK_UPLOAD_TYPES).join(',');

/** Some systems hand over a picture without its type: worked out from its ending. */
const BY_ENDING: Record<string, LookUploadType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

export function lookActions(workspaceId: string) {
  // Made when first used: the screens create these while they render, on the server too.
  const api = () => apiBrowser();
  return {
    /**
     * Uploads a picture of the logo where `look.begin_upload` says, then hands it to the worker, which makes it
     * ready (`look.upload_ready`). The look comes back waiting for it.
     */
    upload: async (file: File): Promise<BusinessLook> => {
      const ending = file.name.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = file.type || BY_ENDING[ending] || 'application/octet-stream';
      const begun = unwrap(
        await api().POST('/v1/commands/look.begin_upload', {
          body: { workspaceId, name: file.name, mimeType, sizeBytes: file.size },
        }),
      );
      const { error } = await supabaseBrowser()
        .storage.from(begun.bucket)
        .upload(begun.objectPath, file, { contentType: mimeType, upsert: false });
      if (error)
        throw new Error(`${file.name} didn’t upload. Check your connection and upload it again.`);
      return unwrap(
        await api().POST('/v1/commands/look.use_upload', {
          body: { workspaceId, objectPath: begun.objectPath },
        }),
      ).look as BusinessLook;
    },
    /** The colour picked, kept as it is. */
    setColor: async (color: string): Promise<BusinessLook> =>
      unwrap(await api().POST('/v1/commands/look.set', { body: { workspaceId, color } }))
        .look as BusinessLook,
    /** Takes the logo off: the initials stand in again. */
    removeLogo: async (): Promise<BusinessLook> =>
      unwrap(await api().POST('/v1/commands/look.set', { body: { workspaceId, removeLogo: true } }))
        .look as BusinessLook,
    /** "Look on lonestarhvac.com again". */
    find: async (): Promise<BusinessLook> =>
      unwrap(await api().POST('/v1/commands/look.find', { body: { workspaceId } }))
        .look as BusinessLook,
  };
}

export type LookActions = ReturnType<typeof lookActions>;
