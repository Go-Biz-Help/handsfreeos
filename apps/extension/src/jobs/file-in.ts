/**
 * Bringing the person's Facebook file in (docs/outreach.md, decisions 16 and 43), asked from the Friends tab in
 * HandsFreeOS: it finds Facebook's zips among Chrome's downloads (whether the extension pressed Download or the person
 * did), reads the new ones where Chrome saved them, and sends what's in them in parts, the way the Friends tab's card
 * does: names and moments, and each chat's latest few messages for the AI to read (src/hfos/files.ts). The zips stay
 * on the computer.
 *
 * A service worker can't open the person's files, so the reading happens in an offscreen page of the extension's own
 * (src/offscreen.ts), made for this and closed after; Chrome lets it open them once the person turns on **Allow
 * access to file URLs** for the extension. It never opens Facebook, so a warning that day doesn't stop it. LinkedIn's
 * file comes in the same way, with its own finder and parts (./linkedin/file.ts).
 */
import { isFacebookZip, type DownloadSeen } from '../hfos/files';
import type { OffscreenAnswer, OffscreenAsk } from '../messages';
import { counted } from '../words';
import { fileKept, keepFile } from './file';
import { valueOf, type Job, type JobEnd } from './job';

/** The newest Facebook zips looked at. */
const FILES_MOST = 8;

export const NO_FILE_ACCESS =
  'Chrome needs your OK once to let the extension open your downloads: on your computer, open chrome://extensions, press Details on HandsFreeOS Social, and turn on Allow access to file URLs. Then ask again.';
export const NO_NEW_FILES =
  'No new Facebook files in your downloads. Ask for Download your Facebook file first, or download it yourself, then ask again.';

export interface FoundFile {
  readonly id: number;
  readonly path: string;
}

/** What the finders need to know of one of Chrome's downloads. */
const seen = (item: chrome.downloads.DownloadItem): DownloadSeen => ({
  url: item.url,
  finalUrl: item.finalUrl,
  referrer: item.referrer,
  filename: item.filename,
  mime: item.mime,
});

/** A network's zips among Chrome's downloads, the newest first: Facebook's unless said. */
export async function findFiles(
  isZip: (item: DownloadSeen) => boolean = isFacebookZip,
): Promise<FoundFile[]> {
  try {
    const items = await chrome.downloads.search({
      state: 'complete',
      exists: true,
      orderBy: ['-startTime'],
      limit: 200,
    });
    return items
      .filter((item) => isZip(seen(item)))
      .slice(0, FILES_MOST)
      .map((item) => ({ id: item.id, path: item.filename }));
  } catch {
    return [];
  }
}

/** A network's zip Chrome started downloading since a moment, done or not: its path, or null. */
export async function startedSince(
  isZip: (item: DownloadSeen) => boolean,
  since: number,
): Promise<string | null> {
  try {
    const items = await chrome.downloads.search({
      startedAfter: new Date(since).toISOString(),
      orderBy: ['-startTime'],
      limit: 20,
    });
    const found = items.find((item) => item.state !== 'interrupted' && isZip(seen(item)));
    return found ? found.filename : null;
  } catch {
    return null;
  }
}

/** Whether the person let the extension open their files. */
export const fileAccess = (): Promise<boolean> =>
  chrome.extension.isAllowedFileSchemeAccess().catch(() => false);

export async function offscreen(ask: OffscreenAsk): Promise<OffscreenAnswer> {
  const answer = (await chrome.runtime
    .sendMessage(ask)
    .catch(() => null)) as OffscreenAnswer | null;
  if (!answer) throw new Error('The extension couldn’t read the files. Try again.');
  if (!answer.ok) throw new Error(answer.error);
  return answer;
}

/** Opens the offscreen page that reads a network's zips (Facebook's unless said). */
export async function openReader(network = 'Facebook'): Promise<void> {
  await chrome.offscreen.closeDocument().catch(() => undefined);
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: `Reads the ${network} zips the person downloaded, where Chrome saved them.`,
  });
}

/** Reads the zips not brought in yet, and sends them in parts. */
export async function bringIn(job: Job): Promise<JobEnd> {
  if (!(await fileAccess())) throw new Error(NO_FILE_ACCESS);
  const kept = await fileKept();
  const files = (await findFiles()).filter((f) => !kept.broughtIn?.[String(f.id)]);
  if (!files.length) return { line: NO_NEW_FILES, warned: false };
  job.progress(`Opening ${counted(files.length, 'file')}…`);
  await openReader();
  try {
    const read = await offscreen({
      target: 'offscreen',
      type: 'hfos-file-read',
      paths: files.map((f) => f.path),
    });
    if (!('parts' in read)) throw new Error('The extension couldn’t read the files. Try again.');
    let importId: string | undefined;
    let linked: number | null = null;
    for (let i = 0; i < read.parts; i++) {
      if (job.stopped()) return { line: 'Stopped.', warned: false };
      job.progress(
        read.parts > 1
          ? `Bringing it in: part ${(i + 1).toLocaleString()} of ${read.parts.toLocaleString()}`
          : 'Bringing it in…',
      );
      const got = await offscreen({ target: 'offscreen', type: 'hfos-file-part', i });
      if (!('part' in got)) throw new Error('The extension couldn’t read the files. Try again.');
      const sent = valueOf(
        await job.hfos({
          type: 'hfos-save-download',
          input: {
            workspaceId: job.businessId,
            madeAt: read.madeAt,
            ...(importId ? { importId } : {}),
            people: got.part.people,
            chats: got.part.chats,
            last: i === read.parts - 1,
          },
        }),
      );
      importId = sent.importId;
      if (sent.counts) linked = sent.counts.linked;
    }
    const now = new Date().toISOString();
    await keepFile({
      broughtIn: {
        ...kept.broughtIn,
        ...Object.fromEntries(files.map((f) => [String(f.id), now])),
      },
    });
    return {
      line:
        linked === null
          ? 'Your Facebook file is in.'
          : `Your Facebook file is in. ${linked.toLocaleString()} ${linked === 1 ? 'name matches' : 'names match'} people saved in HandsFreeOS.`,
      warned: false,
    };
  } finally {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}
