/**
 * The offscreen page that reads Facebook's file for the background (src/jobs/file-in.ts, docs/outreach.md decision
 * 43). A service worker can't open the person's files; an extension page can, once they turn on **Allow access to
 * file URLs**. It opens the zips where Chrome saved them, reads them (@hfos/core/addons/outreach/download-read), and
 * keeps what's in them until the background has asked for every part. It answers only the extension's own messages
 * meant for it, and is closed once the file is in.
 */
import {
  DownloadError,
  downloadParts,
  readDownload,
  type DownloadPart,
} from '@hfos/core/addons/outreach/download-read';
import { fileUrlOf } from './hfos/files';
import type { OffscreenAnswer, OffscreenAsk } from './messages';

let parts: DownloadPart[] = [];

/** A downloaded file, opened where Chrome saved it. */
function open(path: string): Promise<Blob> {
  return new Promise((done, failed) => {
    const request = new XMLHttpRequest();
    request.open('GET', fileUrlOf(path));
    request.responseType = 'blob';
    request.onload = () =>
      request.response instanceof Blob && request.response.size > 0
        ? done(request.response)
        : failed(new Error('empty'));
    request.onerror = () => failed(new Error('unreadable'));
    request.send();
  });
}

async function answer(ask: OffscreenAsk): Promise<OffscreenAnswer> {
  if (ask.type === 'hfos-file-part') {
    const part = parts[ask.i];
    return part
      ? { ok: true, part }
      : { ok: false, error: 'The extension lost what it read. Ask again.' };
  }
  try {
    const blobs = await Promise.all(ask.paths.map(open));
    const read = await readDownload(blobs);
    parts = downloadParts(read);
    return {
      ok: true,
      madeAt: read.madeAt,
      parts: parts.length,
      people: read.people.length,
      chats: read.chats.length,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DownloadError
          ? error.message
          : 'Those files couldn’t be opened. Check they’re still in your downloads folder, then ask again.',
    };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  // Only the extension's own background: never a content script in a Facebook tab.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) return false;
  const ask = message as Partial<OffscreenAsk> | null;
  if (ask?.target !== 'offscreen') return false;
  void answer(ask as OffscreenAsk).then(respond);
  return true;
});
