import {
  logoUrlFor,
  LookFindOutput,
  LookSetOutput,
  LookUseUploadOutput,
  type BusinessLook,
  type LookUploadType,
} from '@hfos/core';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { api, ApiError, unwrap } from '@/lib/api';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { appFetch } from '@/lib/network';

/**
 * A business's logo and colour from the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8), as
 * the web's lib/look-actions.ts makes the calls: a picture of the logo picked from the phone's photos and uploaded to
 * the place `look.begin_upload` reserved, then handed to the worker (`look.use_upload`); the colour picked; the logo
 * taken off; and "Look on … again". All of them need signal, like the rest of setup.
 */

/** The longest side a logo picked here is sent at: the worker fits it inside 800 × 400 anyway. */
export const LOGO_EDGE = 1600;

export interface PickedLogo {
  readonly name: string;
  readonly mimeType: LookUploadType;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** A logo the worker made, at Storage's public address. */
export const logoSrc = (path: string): string => logoUrlFor(config.supabaseUrl, path);

/**
 * Picks a picture of the logo from the phone's photos (picking needs no permission). A PNG, WebP or GIF comes out as a
 * PNG, its see-through background kept; anything else (an iPhone's HEIC, say) as a JPEG. Null when they cancel.
 */
export async function pickLogo(): Promise<PickedLogo | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  });
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return null;
  const clear =
    /^image\/(?:png|webp|gif)$/.test(asset.mimeType ?? '') ||
    /\.(?:png|webp|gif)$/i.test(asset.fileName ?? '');
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > LOGO_EDGE)
    context.resize(asset.width >= asset.height ? { width: LOGO_EDGE } : { height: LOGO_EDGE });
  const image = await context.renderAsync();
  const saved = await image.saveAsync(
    clear ? { format: SaveFormat.PNG } : { format: SaveFormat.JPEG, compress: 0.92 },
  );
  const file = new File(saved.uri);
  try {
    const base = (asset.fileName ?? 'logo').replace(/\.[^.]+$/, '') || 'logo';
    return {
      name: `${base}.${clear ? 'png' : 'jpg'}`,
      mimeType: clear ? 'image/png' : 'image/jpeg',
      bytes: new Uint8Array(file.bytesSync()),
    };
  } finally {
    if (file.exists) file.delete();
  }
}

export function lookCalls(workspaceId: string) {
  return {
    /** Uploads the picture where `look.begin_upload` says, then hands it to the worker; the look comes back waiting. */
    upload: async (logo: PickedLogo): Promise<BusinessLook> => {
      const begun = unwrap(
        await api.POST('/v1/commands/look.begin_upload', {
          body: {
            workspaceId,
            name: logo.name,
            mimeType: logo.mimeType,
            sizeBytes: logo.bytes.length,
          },
        }),
      );
      const token = await session.accessToken();
      if (!token) throw new ApiError('Sign in to continue.', 401, 'unauthenticated', null);
      let res: Response;
      try {
        res = await appFetch(
          `${config.supabaseUrl}/storage/v1/object/${begun.bucket}/${begun.objectPath}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              apikey: config.supabasePublishableKey,
              'content-type': logo.mimeType,
              'x-upsert': 'false',
            },
            body: logo.bytes,
          },
        );
      } catch {
        // No signal, as errorMessage words it.
        throw new TypeError('Network request failed');
      }
      if (!res.ok)
        throw new Error(`${logo.name} didn’t upload. Check your connection and upload it again.`);
      return LookUseUploadOutput.parse(
        unwrap(
          await api.POST('/v1/commands/look.use_upload', {
            body: { workspaceId, objectPath: begun.objectPath },
          }),
        ),
      ).look;
    },
    /** The colour picked, kept as it is. */
    setColor: async (color: string): Promise<BusinessLook> =>
      LookSetOutput.parse(
        unwrap(await api.POST('/v1/commands/look.set', { body: { workspaceId, color } })),
      ).look,
    /** Takes the logo off: the initials stand in again. */
    removeLogo: async (): Promise<BusinessLook> =>
      LookSetOutput.parse(
        unwrap(
          await api.POST('/v1/commands/look.set', { body: { workspaceId, removeLogo: true } }),
        ),
      ).look,
    /** "Look on lonestarhvac.com again". */
    find: async (): Promise<BusinessLook> =>
      LookFindOutput.parse(
        unwrap(await api.POST('/v1/commands/look.find', { body: { workspaceId } })),
      ).look,
  };
}
