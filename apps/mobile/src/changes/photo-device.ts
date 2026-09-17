import { Directory, File, UploadType } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { photosFolderUri } from '@/sync/device-files';

import type { PhotoTransport, StorageAnswer } from './photos';

/**
 * Photos on the phone itself: taking or picking one (asking for the camera only when it's used; picking needs no
 * permission), shrinking it to a JPEG about 2,048 px on its longest side, keeping it in the person's photos folder until
 * HandsFreeOS confirms it (see `photosFolderUri`), and the requests to Storage.
 */

/** The longest side a photo is shrunk to. */
export const PHOTO_EDGE = 2048;
/** JPEG quality: about 0.5 to 1 MB for a phone photo at 2,048 px. */
export const PHOTO_QUALITY = 0.75;

export type PhotoSource = 'camera' | 'library';

export interface KeptPhoto {
  /** The file's name in the person's photos folder. */
  readonly localName: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
}

export type TakePhotoResult =
  | { readonly kind: 'kept'; readonly photo: KeptPhoto }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

const folderUri = photosFolderUri;
const fileUri = (userId: string, name: string) =>
  `${folderUri(userId)}/${encodeURIComponent(name)}`;

/** Takes a photo with the camera, or picks one, then shrinks it and keeps it in the person's photos folder. */
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
 * Shrinks an image to a JPEG no more than 2,048 px on its longest side (an iPhone's HEIC included) and moves it out of
 * the cache folder the manipulator writes to, into the person's photos folder.
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
  const folder = new Directory(folderUri(input.userId));
  folder.create({ intermediates: true, idempotent: true });
  const localName = `${input.fileId}.jpg`;
  const target = new File(fileUri(input.userId, localName));
  if (target.exists) target.delete();
  new File(saved.uri).moveSync(target);
  return { localName, sizeBytes: target.size, width: saved.width, height: saved.height };
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
  const folder = new Directory(folderUri(input.userId));
  folder.create({ intermediates: true, idempotent: true });
  const localName = `${input.fileId}.jpg`;
  const file = new File(fileUri(input.userId, localName));
  if (file.exists) file.delete();
  file.create();
  const handle = file.open();
  try {
    const piece = 1024 * 1024;
    for (let written = 0; written < input.sizeBytes; written += piece)
      handle.writeBytes(input.randomBytes(Math.min(piece, input.sizeBytes - written)));
  } finally {
    handle.close();
  }
  return { localName, sizeBytes: file.size, width: 0, height: 0 };
}

/** Deletes a photo kept for upload. */
export function removePhoto(userId: string, localName: string): void {
  const file = new File(fileUri(userId, localName));
  if (file.exists) file.delete();
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

/** Storage and the photos folder, for one person's photos. */
export function devicePhotoTransport(input: {
  readonly userId: () => string | null;
  readonly fetch: typeof fetch;
  /** Test builds' No signal switch fails uploads too. */
  readonly offline: () => boolean;
}): PhotoTransport {
  const file = (name: string) => {
    const userId = input.userId();
    if (!userId) throw new Error('Nobody is signed in.');
    return new File(fileUri(userId, name));
  };
  return {
    async uploadWhole(request, onProgress) {
      if (input.offline()) return { reached: false, message: 'No signal.' };
      try {
        const result = await file(request.localName).upload(request.url, {
          httpMethod: 'POST',
          uploadType: UploadType.BINARY_CONTENT,
          headers: request.headers,
          mimeType: request.mimeType,
          // An iPhone carries the upload on while the app is in the background; Android ignores it.
          ...(Platform.OS === 'ios' ? { sessionType: 'background' as const } : {}),
          onProgress: ({ bytesSent }) => onProgress(bytesSent),
        });
        return answerOf(result.status, result.body, result.headers);
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
    readPiece(localName, offset, length) {
      const handle = file(localName).open();
      try {
        handle.offset = offset;
        return handle.readBytes(length);
      } finally {
        handle.close();
      }
    },
    exists: (localName) => {
      try {
        return file(localName).exists;
      } catch {
        return false;
      }
    },
    remove: (localName) => {
      try {
        const f = file(localName);
        if (f.exists) f.delete();
      } catch {
        // Nobody signed in: their copy's folder goes with the copy.
      }
    },
  };
}
