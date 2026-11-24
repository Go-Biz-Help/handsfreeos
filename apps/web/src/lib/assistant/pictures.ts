'use client';
import { ASSISTANT_PICTURE_EDGE, ASSISTANT_PICTURE_MAX_BASE64 } from '@hfos/core';
import type { AskPicture } from './stream';

/** A picture waiting to go with the next question: what's sent, and a small copy to show in the box. */
export interface DraftPicture extends AskPicture {
  readonly id: string;
  /** A `data:` address of the same JPEG, for the thumbnail. */
  readonly preview: string;
}

/**
 * A picture the person chose, pasted or dropped, shrunk to a JPEG no longer than ASSISTANT_PICTURE_EDGE on its
 * longest side: about what the AI reads at, so a phone's 12-megapixel photo costs no more than a screenshot. Throws
 * when the browser can't open it (an iPhone's HEIC in a browser that doesn't read them).
 */
export async function shrinkPicture(file: Blob): Promise<DraftPicture> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, ASSISTANT_PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    // A screenshot with see-through parts gets white behind it, as on a page, rather than JPEG's black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const preview = canvas.toDataURL('image/jpeg', 0.85);
    const data = preview.slice(preview.indexOf(',') + 1);
    if (!data || data.length > ASSISTANT_PICTURE_MAX_BASE64) throw new Error('Too big');
    return { id: crypto.randomUUID(), data, mediaType: 'image/jpeg', preview };
  } finally {
    bitmap.close();
  }
}

/** The pictures among files pasted or dropped. */
export const picturesAmong = (files: Iterable<File>): File[] =>
  [...files].filter((f) => f.type.startsWith('image/'));
