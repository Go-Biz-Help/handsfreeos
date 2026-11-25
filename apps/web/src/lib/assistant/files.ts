'use client';
import { assistantFileType, ASSISTANT_FILES_MAX_BYTES } from '@hfos/core';
import type { AskFile } from './stream';

/** A file waiting to go with the next question. */
export interface DraftFile extends AskFile {
  readonly id: string;
  /** Its size before base64, for the total ASSISTANT_FILES_MAX_BYTES allows. */
  readonly bytes: number;
}

/** The file's bytes as base64, with no `data:` prefix. */
async function base64Of(file: Blob): Promise<string> {
  const url = await new Promise<string>((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.onerror = () => fail(reader.error ?? new Error('Unreadable'));
    reader.readAsDataURL(file);
  });
  return url.slice(url.indexOf(',') + 1);
}

/**
 * A file the person chose, pasted or dropped, read to send: null when it isn't a kind the Assistant reads (the caller
 * says why), and throws when it can't be read or is over ASSISTANT_FILES_MAX_BYTES by itself.
 */
export async function readDraftFile(file: File): Promise<DraftFile | null> {
  const mediaType = assistantFileType(file.name, file.type);
  if (!mediaType) return null;
  if (!file.size || file.size > ASSISTANT_FILES_MAX_BYTES) throw new Error('Too big');
  const data = await base64Of(file);
  if (!data) throw new Error('Empty');
  return {
    id: crypto.randomUUID(),
    name: file.name.trim().slice(0, 200) || 'File',
    mediaType,
    data,
    bytes: file.size,
  };
}
