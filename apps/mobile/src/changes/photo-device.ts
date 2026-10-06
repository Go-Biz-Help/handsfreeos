import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { PIECE_BYTES } from '@/sync/kept-files';
import { keptStore } from '@/sync/kept-store';

import type { PhotoTransport, StorageAnswer } from './photos';

/**
 * Photos on the phone itself: taking or picking one (asking for the camera only when it's used; picking needs no
 * permission), shrinking it to a JPEG about 2,048 px on its longest side, keeping it encrypted in the person's kept
 * files until HandsFreeOS confirms it (`sync/kept-files.ts`; round seven, never a plain file), and the requests to
 * Storage.
 */

/** The longest side a photo is shrunk to. */
export const PHOTO_EDGE = 2048;
/** JPEG quality: about 0.5 to 1 MB for a phone photo at 2,048 px. */
export const PHOTO_QUALITY = 0.75;

export type PhotoSource = 'camera' | 'library';

export interface KeptPhoto {
  /** Its name in the person's kept files. */
  readonly localName: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
}

export type TakePhotoResult =
  | { readonly kind: 'kept'; readonly photo: KeptPhoto }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

/** Takes a photo with the camera, or picks one, then shrinks it and keeps it in the person's kept files. */
export async function takePhoto(input: {
  readonly userId: string;
  readonly source: PhotoSource;
  readonly fileId: string;
}): Promise<TakePhotoResult> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  };
  let picked: ImagePicker.ImagePickerResult;
  if (input.source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { kind: 'no-camera-permission' };
    picked = await ImagePicker.launchCameraAsync(options);
  } else {
    picked = await ImagePicker.launchImageLibraryAsync(options);
  }
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return { kind: 'cancelled' };
  return {
    kind: 'kept',
    photo: await keepPhoto({ ...input, uri: asset.uri, width: asset.width, height: asset.height }),
  };
}

/**
 * Shrinks an image to a JPEG no more than 2,048 px on its longest side (an iPhone's HEIC included) and keeps it in the
 * person's kept files, deleting the plain one the manipulator wrote to the cache folder.
 */
export async function keepPhoto(input: {
  readonly userId: string;
  readonly fileId: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}): Promise<KeptPhoto> {
  const longest = Math.max(input.width, input.height);
  const context = ImageManipulator.manipulate(input.uri);
  if (longest > PHOTO_EDGE)
    context.resize(input.width >= input.height ? { width: PHOTO_EDGE } : { height: PHOTO_EDGE });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_QUALITY });
  const localName = `${input.fileId}.jpg`;
  const plain = new File(saved.uri);
  try {
    const bytes = plain.bytesSync();
    keptStore.of(input.userId).put(localName, 'waiting', bytes, { mimeType: 'image/jpeg' });
    return { localName, sizeBytes: bytes.length, width: saved.width, height: saved.height };
  } finally {
    if (plain.exists) plain.delete();
  }
}

/**
 * Test builds: a file over 6 MB for the resumable upload, as a photo's bytes would be. Its bytes are random, so it
 * isn't a picture anyone can open; it only proves an upload in pieces resumes where it stopped.
 */
export function keepLargeTestFile(input: {
  readonly userId: string;
  readonly fileId: string;
  readonly sizeBytes: number;
  readonly randomBytes: (count: number) => Uint8Array;
}): KeptPhoto {
  const kept = keptStore.of(input.userId);
  const localName = `${input.fileId}.jpg`;
  kept.begin(localName, 'waiting', input.sizeBytes, { mimeType: 'image/jpeg' });
  for (let written = 0; written < input.sizeBytes; written += PIECE_BYTES)
    kept.append(
      localName,
      written,
      input.randomBytes(Math.min(PIECE_BYTES, input.sizeBytes - written)),
    );
  return { localName, sizeBytes: input.sizeBytes, width: 0, height: 0 };
}

/** Deletes a photo kept for upload. */
export function removePhoto(userId: string, localName: string): void {
  keptStore.current(userId)?.remove(localName);
}

function answerOf(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): StorageAnswer {
  const header = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const offset = header('upload-offset');
  return {
    reached: true,
    status,
    body,
    offset: offset === null ? null : Number(offset),
    location: header('location'),
  };
}

const unreachable = (error: unknown): StorageAnswer => ({
  reached: false,
  message: error instanceof Error ? error.message : String(error),
});

const headersOf = (response: Response) => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/** Storage and the person's kept files, for one person's photos. */
export function devicePhotoTransport(input: {
  readonly userId: () => string | null;
  readonly fetch: typeof fetch;
  /** Test builds' No signal switch fails uploads too. */
  readonly offline: () => boolean;
}): PhotoTransport {
  const kept = () => {
    const userId = input.userId();
    if (!userId) throw new Error('Nobody is signed in.');
    return keptStore.of(userId);
  };
  return {
    // Read from the kept files and sent from the app (6 MB at most): no plain file for the system to send in the
    // background, so an upload stopped by leaving the app goes again on coming back.
    async uploadWhole(request, onProgress) {
      if (input.offline()) return { reached: false, message: 'No signal.' };
      try {
        const bytes = kept().read(request.localName);
        if (!bytes) return { reached: false, message: 'The photo isn’t on this phone.' };
        const response = await input.fetch(request.url, {
          method: 'POST',
          headers: { 'content-type': request.mimeType, ...request.headers },
          body: bytes,
        });
        const body = await response.text();
        if (response.ok) onProgress(bytes.length);
        return answerOf(response.status, body, headersOf(response));
      } catch (error) {
        return unreachable(error);
      }
    },
    async createResumable(request) {
      if (input.offline()) return { reached: false, message: 'No signal.' };
      try {
        const response = await input.fetch(request.url, {
          method: 'POST',
          headers: request.headers,
        });
        return answerOf(response.status, await response.text(), headersOf(response));
      } catch (error) {
        return unreachable(error);
      }
    },
    async resumableOffset(request) {
      if (input.offline()) return { reached: false, message: 'No signal.' };
      try {
        const response = await input.fetch(request.url, {
          method: 'HEAD',
          headers: request.headers,
        });
        return answerOf(response.status, '', headersOf(response));
      } catch (error) {
        return unreachable(error);
      }
    },
    async sendPiece(request) {
      if (input.offline()) return { reached: false, message: 'No signal.' };
      try {
        const response = await input.fetch(request.url, {
          method: 'PATCH',
          headers: { ...request.headers, 'upload-offset': String(request.offset) },
          body: request.bytes,
        });
        return answerOf(response.status, await response.text(), headersOf(response));
      } catch (error) {
        return unreachable(error);
      }
    },
    readPiece: (localName, offset, length) => kept().readRange(localName, offset, length),
    exists: (localName) => {
      try {
        return kept().has(localName);
      } catch {
        return false;
      }
    },
    remove: (localName) => {
      try {
        kept().remove(localName);
      } catch {
        // Nobody signed in, or their copy isn't open: their kept files go with the copy.
      }
    },
  };
}
