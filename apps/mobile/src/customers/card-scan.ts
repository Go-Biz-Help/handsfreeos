import { CARD_SEND_EDGE, type CardCorners, type CardSide, type ReadCardOut } from '@hfos/core';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { keptStore } from '@/sync/kept-store';
import { workerPost } from '@/lib/worker';

/**
 * Scanning a business card (Contacts → + → Scan a business card; core's `crm/business-card.ts`): a picture of one side
 * is taken or chosen, shrunk to a JPEG, and sent to the worker, which reads it and straightens the card. The picture
 * the person took stays on the phone only while the screen is open, so the edges can be fixed by hand; the
 * straightened card is kept in the person's kept files (encrypted, never a plain file) once the contact is added, and
 * uploads to their Files on the photo track.
 */

/** A picture of one side, as the phone sends it. */
export interface CardPhoto {
  /** JPEG, base64. */
  readonly base64: string;
  readonly width: number;
  readonly height: number;
}

export type TakeCardPhoto =
  | { readonly kind: 'taken'; readonly photo: CardPhoto }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

/** Takes a picture of a side with the camera, or chooses one, shrunk to a JPEG about 2,048 px on its longest side. */
export async function takeCardPhoto(source: 'camera' | 'library'): Promise<TakeCardPhoto> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  };
  let picked: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { kind: 'no-camera-permission' };
    picked = await ImagePicker.launchCameraAsync(options);
  } else {
    picked = await ImagePicker.launchImageLibraryAsync(options);
  }
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return { kind: 'cancelled' };
  return { kind: 'taken', photo: await shrink(asset.uri, asset.width, asset.height) };
}

/** A JPEG no more than 2,048 px on its longest side (an iPhone's HEIC included), as base64; no file left behind. */
async function shrink(uri: string, width: number, height: number): Promise<CardPhoto> {
  const context = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > CARD_SEND_EDGE)
    context.resize(width >= height ? { width: CARD_SEND_EDGE } : { height: CARD_SEND_EDGE });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
  try {
    const plain = new File(saved.uri);
    if (plain.exists) plain.delete();
  } catch {
    // The cache folder is emptied by the phone in any case.
  }
  if (!saved.base64) throw new Error('That picture couldn’t be opened. Take it again.');
  return { base64: saved.base64, width: saved.width, height: saved.height };
}

/**
 * A side read and straightened by the worker. With `corners` (placed by hand), only straightened again: nothing is
 * read and no AI is used. Needs signal.
 */
export function readCardSide(
  workspaceId: string,
  side: CardSide,
  photo: CardPhoto,
  corners?: CardCorners,
): Promise<ReadCardOut> {
  return workerPost<ReadCardOut>('/v1/contacts/read-card', {
    workspaceId,
    side,
    image: photo.base64,
    ...(corners ? { corners } : {}),
  });
}

/** Base64 to bytes. */
export function bytesOf(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** The straightened card kept in the person's kept files for upload, under the file id its upload will use. */
export function keepCardPicture(
  userId: string,
  fileId: string,
  base64: string,
): { readonly localName: string; readonly sizeBytes: number } {
  const bytes = bytesOf(base64);
  const localName = `${fileId}.jpg`;
  keptStore.of(userId).put(localName, 'waiting', bytes, { mimeType: 'image/jpeg' });
  return { localName, sizeBytes: bytes.length };
}
