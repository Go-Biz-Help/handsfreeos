/**
 * LinkedIn's copy of the person's data (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part";
 * core's `ASK_KINDS_ON.linkedin`), asked from HandsFreeOS on LinkedIn, as Facebook's file is (../file.ts,
 * ../file-in.ts):
 *
 * - **Ask for the file** (`file_request`): on LinkedIn's Get a copy of your data, in a tab the person can see, it picks
 *   the data files they want, ticks Connections, Invitations and Messages (and Profile, whose name tells their own
 *   messages from the other person's), and presses Request archive. LinkedIn asks for their password, which they type
 *   themselves; it waits, and says so, till LinkedIn says it's preparing the archive.
 * - **Download it** (`file_download`): once LinkedIn says it's ready, Download archive on the same page; then it waits
 *   for Chrome to start the download, and for their password if LinkedIn asks for it.
 * - **Bring it in** (`file_in`): reads the zip from their downloads (core's `readLinkedInExport`, in the offscreen
 *   page), and saves its connections as LinkedIn's friends list (`outreach.friends.save`), the invitations still
 *   waiting as requests and sent ones, each since when the file says, then the one-to-one chats' latest few messages
 *   for the AI (`outreach.download.save`, as LinkedIn's, chats only). It never opens LinkedIn, so a LinkedIn warning
 *   that day doesn't stop it.
 *
 * A step it can't find it hands to the person, and a password box anywhere it waits on them for.
 */
import { fileNameOf, isLinkedInZip } from '../../hfos/files';
import { linkedInListSave } from '../../hfos/saves';
import { LINKEDIN_FILE_PLANS, PASSWORD_CHECK } from '../../networks/linkedin/data';
import { counted } from '../../words';
import { fileKept, getFile, keepFile, Stopped, typingWords, type FileWay } from '../file';
import {
  fileAccess,
  findFiles,
  NO_FILE_ACCESS,
  offscreen,
  openReader,
  startedSince,
} from '../file-in';
import { pause, valueOf, type Job, type JobEnd } from '../job';

/** What's kept between asks: when the file was asked for, and which zips were brought in. */
export const LINKEDIN_FILE_KEY = 'hfos.linkedinFile';

/** How long it watches for Chrome to start the download, and how often it looks. */
const START_MS = 90_000;
const LOOK_MS = 2_000;
/** How long it waits for the person to type their password. */
const TYPING_MS = 15 * 60_000;

export const LINKEDIN_DOWNLOADED =
  'Downloaded, once you typed your password if LinkedIn asked. Then ask for Bring it in.';
export const NO_NEW_LINKEDIN_FILES =
  'No new LinkedIn file in your downloads. Ask for Download my file on LinkedIn first, or download it yourself from Get a copy of your data in LinkedIn’s Settings, then ask again.';
const UNREAD = 'The extension couldn’t read the files. Try again.';

/** "a", "a and b", "a, b and c". */
const andList = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * After Download archive: waits for Chrome to start downloading LinkedIn's zip, and while LinkedIn shows a password
 * box, for the person to type it. When nothing starts, the step goes to them. What to end with.
 */
async function downloadStarted(job: Job, began: number): Promise<string> {
  const words = typingWords(LINKEDIN_FILE);
  job.progress('Waiting for Chrome to start the download…');
  let typing = false;
  let handed = false;
  let until = Date.now() + START_MS;
  try {
    for (;;) {
      if (job.stopped()) throw new Stopped();
      const path = await startedSince(isLinkedInZip, began);
      if (path) return `Downloading ${fileNameOf(path)}. Once Chrome has it, ask for Bring it in.`;
      if (handed) return LINKEDIN_DOWNLOADED;
      const looked = await job.tab.ask({
        type: 'hfos-fetch-step',
        step: PASSWORD_CHECK,
        waitMs: 0,
      });
      const asking = looked.ok && looked.result === 'waiting';
      if (asking !== typing) {
        job.typing?.(asking ? words.waiting : null);
        until = Date.now() + (asking ? TYPING_MS : START_MS);
        typing = asking;
      }
      if (Date.now() > until) {
        if (typing) throw new Error(words.gaveUp);
        const reply = job.handOver
          ? await job.handOver(
              'Chrome hasn’t started downloading your LinkedIn file. Press “Download archive” on the page, then press Carry on.',
            )
          : 'stop';
        if (reply === 'stop' || job.stopped()) throw new Stopped();
        handed = true;
        continue;
      }
      await pause(LOOK_MS);
    }
  } finally {
    if (typing) job.typing?.(null);
  }
}

/** LinkedIn's file: Get a copy of your data. */
export const LINKEDIN_FILE: FileWay = {
  name: 'LinkedIn',
  secret: 'password',
  key: LINKEDIN_FILE_KEY,
  plans: LINKEDIN_FILE_PLANS,
  done: {
    request:
      'LinkedIn is making your copy of your connections, invitations and messages. It emails you when it’s ready, often within minutes and at most a day. Then ask for Download my file.',
    download: LINKEDIN_DOWNLOADED,
  },
  after: (job, which, began) =>
    which === 'download' ? downloadStarted(job, began) : Promise.resolve(null),
};

/** Asks LinkedIn for the file, or downloads it, on Get a copy of your data. */
export const getLinkedInFile = (job: Job, which: 'request' | 'download'): Promise<JobEnd> =>
  getFile(job, which, LINKEDIN_FILE);

/** Reads LinkedIn's zips not brought in yet, and saves what's in them in parts. */
export async function bringInLinkedIn(job: Job): Promise<JobEnd> {
  if (!(await fileAccess())) throw new Error(NO_FILE_ACCESS);
  const kept = await fileKept(LINKEDIN_FILE_KEY);
  const files = (await findFiles(isLinkedInZip)).filter((f) => !kept.broughtIn?.[String(f.id)]);
  if (!files.length) return { line: NO_NEW_LINKEDIN_FILES, warned: false };
  job.progress(`Opening ${counted(files.length, 'file')}…`);
  await openReader('LinkedIn');
  try {
    const read = await offscreen({
      target: 'offscreen',
      type: 'hfos-file-read',
      paths: files.map((f) => f.path),
      platform: 'linkedin',
    });
    if (!('parts' in read)) throw new Error(UNREAD);
    const saved = { friends: 0, requests: 0, sent: 0, added: 0 };
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
      if (!('filePart' in got)) throw new Error(UNREAD);
      const part = got.filePart;
      if ('list' in part) {
        const built = linkedInListSave(part.people, part.list, job.businessId);
        if (!built.ok) continue;
        for (const input of built.input) {
          const done = valueOf(await job.hfos({ type: 'hfos-save-friends', input }));
          saved[part.list] += done.saved;
          saved.added += done.added;
        }
        continue;
      }
      // The chats come last, so the people they're matched to by name are saved first.
      const sent = valueOf(
        await job.hfos({
          type: 'hfos-save-download',
          input: {
            workspaceId: job.businessId,
            platform: 'linkedin',
            madeAt: read.madeAt,
            ...(importId ? { importId } : {}),
            people: [],
            chats: [...part.chats],
            last: i === read.parts - 1,
          },
        }),
      );
      importId = sent.importId;
      if (sent.counts) linked = sent.counts.linked;
    }
    const now = new Date().toISOString();
    await keepFile(
      {
        broughtIn: {
          ...kept.broughtIn,
          ...Object.fromEntries(files.map((f) => [String(f.id), now])),
        },
      },
      LINKEDIN_FILE_KEY,
    );
    const what = andList([
      counted(saved.friends, 'connection'),
      ...(saved.requests ? [`${counted(saved.requests, 'invitation')} you’ve got`] : []),
      ...(saved.sent ? [`${counted(saved.sent, 'invitation')} you’ve sent`] : []),
      ...(read.chats ? [counted(read.chats, 'conversation')] : []),
    ]);
    const fresh = saved.added ? ` (${saved.added.toLocaleString()} new to HandsFreeOS)` : '';
    const matched =
      linked === null
        ? ''
        : ` ${counted(linked, 'conversation')} ${linked === 1 ? 'matches' : 'match'} people saved in HandsFreeOS.`;
    const noLink = read.noLink
      ? ` ${counted(read.noLink, 'person', 'people')} had no profile link in the file, so they weren’t saved.`
      : '';
    return {
      line: `Your LinkedIn file is in: ${what}${fresh}.${matched}${noLink}`,
      warned: false,
    };
  } finally {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}
