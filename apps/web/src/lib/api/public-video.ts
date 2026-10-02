/**
 * A video link's page (`/v/<token>`) talking to the worker's `/public/video` routes (20261018000300). No session:
 * the token is the whole of the permission. Opening the page changes nothing (link previews open it); a video
 * goes up only when the customer picks one.
 *
 * The video itself goes straight to Storage, on a link the worker signs for its one path, with the browser's own
 * upload so the page can show how far it has got.
 */
import { VIDEO_LINK_WORDS } from '@hfos/core';
import { publicEnv } from '../env';
import { ApiError } from './errors';

export interface VideoLinkView {
  readonly business: string;
  /**
   * 20261018000400: a link that asks for a file (a photo or PDF that answers a qualifying question) rather than a
   * video, with the question's words as asked. A worker from before then sends neither: it's a video link.
   */
  readonly asksFor?: 'video' | 'file';
  readonly ask?: string | null;
  readonly expiresAt: string;
  readonly maxUploads: number;
  readonly received: number;
  /** Why it takes nothing more right now, in the customer's words; null when it takes a video. */
  readonly problem: { readonly rule: string; readonly message: string } | null;
}

export interface VideoUploadStart {
  readonly uploadId: string;
  readonly objectPath: string;
  readonly uploadUrl: string;
}

async function call<T>(token: string, suffix: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}/public/video/${encodeURIComponent(token)}${suffix}`, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...init,
    });
  } catch {
    throw new ApiError(0, 'internal', VIDEO_LINK_WORDS.stopped);
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; rule?: string } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.rule,
    );
  }
  return json as T;
}

const post = <T>(token: string, suffix: string, body: unknown) =>
  call<T>(token, suffix, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const getVideoLink = (token: string) => call<VideoLinkView>(token, '', { method: 'GET' });

/** A file's name to send: its own, else what it is (a phone's camera may hand over one with none). */
const nameOf = (file: File) =>
  file.name.slice(0, 200) || (file.type.startsWith('video/') ? 'video' : 'file');

export const startVideoUpload = (token: string, file: File) =>
  post<VideoUploadStart>(token, '/start', {
    name: nameOf(file),
    contentType: file.type,
    sizeBytes: file.size,
  });

export const finishVideoUpload = (token: string, start: VideoUploadStart, file: File) =>
  post<{ sent: true; duplicate: boolean }>(token, '/done', {
    uploadId: start.uploadId,
    objectPath: start.objectPath,
    name: nameOf(file),
  });

/**
 * The file to Storage on the signed link, telling `onProgress` how far it has got (0 to 100). Rejects with the
 * page's own words when the signal drops or Storage turns it away.
 */
export function putVideo(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): { done: Promise<void>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.floor((e.loaded / e.total) * 100)));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, 'internal', VIDEO_LINK_WORDS.stopped));
    xhr.onerror = () => reject(new ApiError(0, 'internal', VIDEO_LINK_WORDS.stopped));
    xhr.onabort = () => reject(new ApiError(0, 'internal', VIDEO_LINK_WORDS.stopped));
    xhr.send(file);
  });
  return { done, cancel: () => xhr.abort() };
}
