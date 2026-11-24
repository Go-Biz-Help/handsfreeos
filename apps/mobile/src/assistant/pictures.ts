import { ASSISTANT_PICTURE_EDGE, ASSISTANT_PICTURE_MAX_BASE64 } from '@hfos/core';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { AskPicture } from './stream';

/**
 * Pictures sent with a question (a paper order form, a screenshot of another form): taken with the camera or chosen,
 * shrunk to a JPEG no longer than ASSISTANT_PICTURE_EDGE on its longest side, as the web's panel does. The AI sees
 * them with that question only; nothing is kept on the phone or on HandsFreeOS.
 */

/** A picture waiting to go with the next question. */
export interface DraftPicture extends AskPicture {
  readonly id: string;
  /** A `data:` address of the same JPEG, for the thumbnail. */
  readonly preview: string;
}

export type TakePictures =
  | { readonly kind: 'taken'; readonly pictures: DraftPicture[]; readonly unreadable: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Takes a photo, or chooses up to `room` pictures, each shrunk to a JPEG. */
export async function takeAssistantPictures(
  source: 'camera' | 'library',
  room: number,
): Promise<TakePictures> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
    ...(source === 'library' && room > 1
      ? { allowsMultipleSelection: true, selectionLimit: room }
      : {}),
  };
  let picked: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { kind: 'no-camera-permission' };
    picked = await ImagePicker.launchCameraAsync(options);
  } else {
    picked = await ImagePicker.launchImageLibraryAsync(options);
  }
  const assets = picked.canceled ? [] : picked.assets.slice(0, Math.max(0, room));
  if (!assets.length) return { kind: 'cancelled' };
  const shrunk = await Promise.all(
    assets.map((a) => shrink(a.uri, a.width, a.height).catch(() => null)),
  );
  const pictures = shrunk.filter((p): p is DraftPicture => !!p);
  return { kind: 'taken', pictures, unreadable: shrunk.length - pictures.length };
}

/** A JPEG no more than ASSISTANT_PICTURE_EDGE on its longest side (an iPhone's HEIC included); no file left behind. */
async function shrink(uri: string, width: number, height: number): Promise<DraftPicture> {
  const context = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > ASSISTANT_PICTURE_EDGE)
    context.resize(
      width >= height ? { width: ASSISTANT_PICTURE_EDGE } : { height: ASSISTANT_PICTURE_EDGE },
    );
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
  try {
    const plain = new File(saved.uri);
    if (plain.exists) plain.delete();
  } catch {
    // The cache folder is emptied by the phone in any case.
  }
  if (!saved.base64 || saved.base64.length > ASSISTANT_PICTURE_MAX_BASE64)
    throw new Error('That picture couldn’t be opened.');
  return {
    id: newId(),
    data: saved.base64,
    mediaType: 'image/jpeg',
    preview: `data:image/jpeg;base64,${saved.base64}`,
  };
}
