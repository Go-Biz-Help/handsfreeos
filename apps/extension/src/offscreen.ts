/**
 * The offscreen page that reads a network's file for the background (src/jobs/file-in.ts, docs/outreach.md decision
 * 43; LinkedIn's, src/jobs/linkedin/file.ts). A service worker can't open the person's files; an extension page can,
 * once they turn on **Allow access to file URLs**. It opens the zips where Chrome saved them, reads them
 * (@hfos/core/addons/outreach/download-read, and linkedin-export for LinkedIn's), and keeps what's in them until the
 * background has asked for every part. It answers only the extension's own messages meant for it, and is closed once
 * the file is in.
 */
import {
  DOWNLOAD_PROBLEMS,
  DownloadError,
  downloadParts,
  readDownload,
  type DownloadPart,
} from '@hfos/core/addons/outreach/download-read';
import {
  LINKEDIN_FILE_PROBLEMS,
  readLinkedInExport,
} from '@hfos/core/addons/outreach/linkedin-export';
import { fileUrlOf, linkedInFileParts, type LinkedInFilePart } from './hfos/files';
import type { OffscreenAnswer, OffscreenAsk } from './messages';

/** What was read, kept till the background has every part: Facebook's, or LinkedIn's. */
let kept:
  | { readonly platform: 'facebook'; readonly parts: readonly DownloadPart[] }
  | { readonly platform: 'linkedin'; readonly parts: readonly LinkedInFilePart[] } = {
  platform: 'facebook',
  parts: [],
};

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

/** LinkedIn's zips, read and cut into the parts it saves (src/hfos/files.ts). */
async function readLinkedIn(blobs: Blob[]): Promise<OffscreenAnswer> {
  const read = await readLinkedInExport(blobs);
  const got = linkedInFileParts(read);
  kept = { platform: 'linkedin', parts: got.parts };
  return {
    ok: true,
    madeAt: read.madeAt,
    parts: got.parts.length,
    people: got.connections + got.invitations,
    chats: got.chats,
    connections: got.connections,
    invitations: got.invitations,
    noLink: got.noLink,
  };
}

async function answer(ask: OffscreenAsk): Promise<OffscreenAnswer> {
  if (ask.type === 'hfos-file-part') {
    const lost = { ok: false, error: 'The extension lost what it read. Ask again.' } as const;
    if (kept.platform === 'linkedin') {
      const part = kept.parts[ask.i];
      return part ? { ok: true, linkedin: part } : lost;
    }
    const part = kept.parts[ask.i];
    return part ? { ok: true, part } : lost;
  }
  const linkedIn = ask.platform === 'linkedin';
  try {
    const blobs = await Promise.all(ask.paths.map(open));
    if (linkedIn) return await readLinkedIn(blobs);
    const read = await readDownload(blobs);
    kept = { platform: 'facebook', parts: downloadParts(read) };
    return {
      ok: true,
      madeAt: read.madeAt,
      parts: kept.parts.length,
      people: read.people.length,
      chats: read.chats.length,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DownloadError
          ? (linkedIn ? LINKEDIN_FILE_PROBLEMS : DOWNLOAD_PROBLEMS)[error.rule]
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
