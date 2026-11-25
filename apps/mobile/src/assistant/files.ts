import {
  ASSISTANT_FILE_TYPES,
  ASSISTANT_FILES_MAX_BYTES,
  assistantFileRefusal,
  assistantFileType,
} from '@hfos/core';
import { File } from 'expo-file-system';

import type { AskFile } from './stream';

/**
 * Files sent with a question (a price list, a contract, a spreadsheet), chosen with the phone's own file picker, as
 * the web's panel takes them. The AI reads them with that question only; nothing is kept on the phone or on
 * HandsFreeOS. The picker is expo-file-system's, already in the app, so this needed no new native code.
 */

/** A file waiting to go with the next question. */
export interface DraftFile extends AskFile {
  readonly id: string;
  /** Its size before base64, for the total ASSISTANT_FILES_MAX_BYTES allows. */
  readonly bytes: number;
}

export type PickFiles =
  | {
      readonly kind: 'picked';
      readonly files: DraftFile[];
      /** Why each one left out was left out, in words for the person. */
      readonly refused: string[];
    }
  | { readonly kind: 'cancelled' };

const newId = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Chooses up to `room` files, read to send; `bytesUsed` is what the files already waiting come to. */
export async function pickAssistantFiles(room: number, bytesUsed: number): Promise<PickFiles> {
  const picked =
    room > 1
      ? await File.pickFileAsync({
          multipleFiles: true,
          mimeTypes: [...ASSISTANT_FILE_TYPES, 'text/*'],
        })
      : await File.pickFileAsync({ mimeTypes: [...ASSISTANT_FILE_TYPES, 'text/*'] });
  if (picked.canceled || !picked.result) return { kind: 'cancelled' };
  const chosen = (Array.isArray(picked.result) ? picked.result : [picked.result]).slice(
    0,
    Math.max(0, room),
  );
  const files: DraftFile[] = [];
  const refused: string[] = [];
  let bytes = bytesUsed;
  for (const file of chosen) {
    const name = file.name.trim().slice(0, 200) || 'File';
    const mediaType = assistantFileType(name, file.type ?? '');
    if (!mediaType) {
      refused.push(assistantFileRefusal(name));
      continue;
    }
    const size = file.size ?? 0;
    if (!size || bytes + size > ASSISTANT_FILES_MAX_BYTES) {
      refused.push(
        size
          ? `Files sent with one question can come to ${ASSISTANT_FILES_MAX_BYTES / 1024 / 1024} MB together, so ${name} was left out.`
          : `${name} is empty.`,
      );
      continue;
    }
    try {
      const data = await file.base64();
      if (!data) throw new Error('Empty');
      bytes += size;
      files.push({ id: newId(), name, mediaType, data, bytes: size });
    } catch {
      refused.push(`${name} couldn’t be opened. Try it again, or save it as a PDF.`);
    }
  }
  return { kind: 'picked', files, refused };
}
