/**
 * Facebook's download file (docs/outreach.md, decisions 2 and 15): what the person's own Facebook says about the
 * people in it, read in their browser, where the file stays. Their friends and since when, the friend requests either
 * way, the friends they removed and the requests they deleted, their followers, and when they last messaged each
 * person. It reads only those parts of the zips Facebook gives (the "Download your information" file, and the chat
 * backup that holds the newer, encrypted chats), a part at a time, so a file of many gigabytes is fine, and it never
 * keeps what a message said. Browser-safe: the web reads the file with it, and the server checks what's sent with its
 * schemas.
 */
import { z } from 'zod';
import {
  DOWNLOAD_CHATS_MOST,
  DOWNLOAD_PART_BYTES,
  DOWNLOAD_PEOPLE_MOST,
  NAME_MOST,
} from './limits';
import { PLATFORM_KEYS } from './playbooks';
import { PersonName } from './saves';

export { DOWNLOAD_CHATS_MOST, DOWNLOAD_PART_BYTES, DOWNLOAD_PEOPLE_MOST } from './limits';

// ---- A zip, a part at a time ----

/** What goes wrong reading the file, for the screen to say (DOWNLOAD_PROBLEMS). */
export type DownloadProblem = 'not_zip' | 'cut_short' | 'locked' | 'packing' | 'html' | 'nothing';

export class DownloadError extends Error {
  constructor(readonly rule: DownloadProblem) {
    super(DOWNLOAD_PROBLEMS[rule]);
    this.name = 'DownloadError';
  }
}

/** What the screen says when the file can't be read: what's wrong, then what to do. */
export const DOWNLOAD_PROBLEMS: Readonly<Record<DownloadProblem, string>> = {
  not_zip:
    'That isn’t one of Facebook’s zip files. Pick the files Facebook gave you, the ones ending in .zip.',
  cut_short:
    'That file stops partway, so it didn’t finish downloading. Download it from Facebook again and pick the new one.',
  locked: 'That zip has a password on it. Pick the file just as Facebook gave it to you.',
  packing:
    'That zip is packed in a way this page can’t open. Pick the file just as Facebook gave it to you.',
  html: 'That file is in HTML, which can’t be read here. Ask Facebook for your information again with Format set to JSON, then pick the new file.',
  nothing:
    'There are no friends, requests or chats in those files. Pick the files from Download your information, and the chat backup if you have it.',
};

/** A file in a zip, as the zip's own list of them says. */
export interface ZipEntry {
  readonly name: string;
  /** How it's packed: 0 as is, 8 deflated. */
  readonly method: number;
  readonly packed: number;
  /** Where its own header starts in the zip. */
  readonly at: number;
  readonly encrypted: boolean;
  /** When it was last changed, as the zip says. */
  readonly changed: Date | null;
}

const END = 0x06054b50;
const BIG_END_AT = 0x07064b50;
const BIG_END = 0x06064b50;
const LISTED = 0x02014b50;
const HEADER = 0x04034b50;
const WHOLE = 0xffffffff;

async function partOf(file: Blob, from: number, to: number): Promise<DataView> {
  return new DataView(await file.slice(from, to).arrayBuffer());
}

/** A zip's date and time, which say no time zone: taken as UTC, near enough for the day. */
function zipTime(date: number, time: number): Date | null {
  const month = (date >> 5) & 15;
  const day = date & 31;
  if (!date || month < 1 || month > 12 || day < 1) return null;
  return new Date(
    Date.UTC(1980 + (date >> 9), month - 1, day, time >> 11, (time >> 5) & 63, (time & 31) * 2),
  );
}

/** Every file in a zip, from the list at its end, without reading the rest of it. */
export async function zipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailLength = Math.min(file.size, 22 + 0xffff + 20);
  const tail = await partOf(file, file.size - tailLength, file.size);
  let end = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    // A zip that starts as one but has no end stopped downloading partway.
    const start = file.size >= 4 ? await partOf(file, 0, 4) : null;
    throw new DownloadError(start?.getUint32(0, true) === HEADER ? 'cut_short' : 'not_zip');
  }
  let count = tail.getUint16(end + 10, true);
  let listSize = tail.getUint32(end + 12, true);
  let listAt = tail.getUint32(end + 16, true);
  // A zip over 4 GB, or of more than 65,535 files, keeps where its list is in a bigger record before the end.
  if (end >= 20 && tail.getUint32(end - 20, true) === BIG_END_AT) {
    const at = Number(tail.getBigUint64(end - 12, true));
    if (at + 56 > file.size) throw new DownloadError('cut_short');
    const big = await partOf(file, at, at + 56);
    if (big.getUint32(0, true) === BIG_END) {
      count = Number(big.getBigUint64(32, true));
      listSize = Number(big.getBigUint64(40, true));
      listAt = Number(big.getBigUint64(48, true));
    }
  }
  if (listAt + listSize > file.size) throw new DownloadError('cut_short');
  const list = await partOf(file, listAt, listAt + listSize);
  const text = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = 0;
  while (
    entries.length < count &&
    p + 46 <= list.byteLength &&
    list.getUint32(p, true) === LISTED
  ) {
    const flags = list.getUint16(p + 8, true);
    let packed = list.getUint32(p + 20, true);
    const size = list.getUint32(p + 24, true);
    const nameLength = list.getUint16(p + 28, true);
    const extraLength = list.getUint16(p + 30, true);
    const commentLength = list.getUint16(p + 32, true);
    let at = list.getUint32(p + 42, true);
    let changed = zipTime(list.getUint16(p + 14, true), list.getUint16(p + 12, true));
    const name = text.decode(new Uint8Array(list.buffer, list.byteOffset + p + 46, nameLength));
    const extraEnd = p + 46 + nameLength + extraLength;
    for (let e = p + 46 + nameLength; e + 4 <= extraEnd;) {
      const id = list.getUint16(e, true);
      const length = list.getUint16(e + 2, true);
      if (id === 0x0001) {
        // Sizes and places too big for the list's own fields, in this order, each only when its field is full.
        let q = e + 4;
        if (size === WHOLE) q += 8;
        if (packed === WHOLE) {
          packed = Number(list.getBigUint64(q, true));
          q += 8;
        }
        if (at === WHOLE) at = Number(list.getBigUint64(q, true));
      } else if (id === 0x5455 && length >= 5 && list.getUint8(e + 4) & 1) {
        // The time it was changed in seconds, which says UTC.
        changed = new Date(list.getUint32(e + 5, true) * 1000);
      }
      e += 4 + length;
    }
    entries.push({
      name,
      method: list.getUint16(p + 10, true),
      packed,
      at,
      encrypted: (flags & 1) === 1,
      changed,
    });
    p = extraEnd + commentLength;
  }
  return entries;
}

/** One file out of a zip, unpacked. */
export async function zipEntryBytes(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new DownloadError('locked');
  if (entry.at + 30 > file.size) throw new DownloadError('cut_short');
  const header = await partOf(file, entry.at, entry.at + 30);
  if (header.getUint32(0, true) !== HEADER) throw new DownloadError('cut_short');
  const from = entry.at + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (from + entry.packed > file.size) throw new DownloadError('cut_short');
  const packed = file.slice(from, from + entry.packed);
  if (entry.method === 0) return new Uint8Array(await packed.arrayBuffer());
  if (entry.method !== 8) throw new DownloadError('packing');
  const unpacked = packed.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(unpacked).arrayBuffer());
}

// ---- What the download says ----

/** The lists in Facebook's download that HandsFreeOS reads, as the Friends tab names them. */
export const DOWNLOAD_LISTS = {
  friends: 'Friends',
  request_sent: 'Requests you sent',
  request_received: 'Requests you’ve got',
  removed: 'Friends you removed',
  declined: 'Requests you deleted',
  followers: 'Your followers',
  following: 'People you follow',
} as const;
export type DownloadList = keyof typeof DOWNLOAD_LISTS;
export const DOWNLOAD_LIST_KEYS = Object.keys(DOWNLOAD_LISTS) as [DownloadList, ...DownloadList[]];

/** Each list by the name the download gives it inside its file (`friends_v2`)… */
const LIST_KEYS = new Map<string, DownloadList>([
  ['friends_v2', 'friends'],
  ['friends', 'friends'],
  ['sent_requests_v2', 'request_sent'],
  ['sent_requests', 'request_sent'],
  ['received_requests_v2', 'request_received'],
  ['received_requests', 'request_received'],
  ['deleted_friends_v2', 'removed'],
  ['deleted_friends', 'removed'],
  ['removed_friends_v2', 'removed'],
  ['removed_friends', 'removed'],
  ['rejected_requests_v2', 'declined'],
  ['rejected_requests', 'declined'],
  ['followers_v3', 'followers'],
  ['followers_v2', 'followers'],
  ['followers', 'followers'],
  ['following_v3', 'following'],
  ['following_v2', 'following'],
  ['following', 'following'],
]);

/** …or by the file's own name, when the list is all the file holds. */
const LIST_FILES = new Map<string, DownloadList>([
  ['your_friends.json', 'friends'],
  ['friends.json', 'friends'],
  ['sent_friend_requests.json', 'request_sent'],
  ['received_friend_requests.json', 'request_received'],
  ['friend_requests_received.json', 'request_received'],
  ['removed_friends.json', 'removed'],
  ['rejected_friend_requests.json', 'declined'],
  ['people_who_followed_you.json', 'followers'],
  ['followers.json', 'followers'],
  ["who_you've_followed.json", 'following'],
  ['who_you_follow.json', 'following'],
  ['following.json', 'following'],
]);

/** The download's folders that hold those lists. */
const LIST_FOLDERS = /(^|\/)(connections|friends|followers|following|friends_and_followers)\//;

const strictText = new TextDecoder('utf-8', { fatal: true });

/**
 * Facebook's download writes each byte of a letter outside plain English as a character of its own ("JosÃ©" for
 * "José"). This puts them back together; text not written that way comes back as it was.
 */
export function facebookText(text: string): string {
  let high = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) return text;
    if (c > 0x7f) high = true;
  }
  if (!high) return text;
  try {
    return strictText.decode(Uint8Array.from(text, (c) => c.charCodeAt(0)));
  } catch {
    return text;
  }
}

/** How names are matched: in lower case, accents kept, spaces closed up. */
export function nameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Facebook's own start: nothing in a download is older. */
const FIRST_DAY = Date.UTC(2004, 0, 1);

/** A moment in the download, in seconds or milliseconds, as milliseconds; null when it isn't one. */
function msOf(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{9,13}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return ms >= FIRST_DAY && ms < Date.now() + 86_400_000 ? Math.round(ms) : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The name Facebook shows for an account that's gone: nobody to find. */
const GONE = /^(facebook|instagram|messenger) user$/i;

const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const name = facebookText(raw).trim().replace(/\s+/g, ' ');
  return name && name.length <= NAME_MOST && !GONE.test(name) ? name : null;
};

/** Someone in one of the download's lists. */
export interface DownloadPerson {
  readonly list: DownloadList;
  readonly name: string;
  /** When, as the list says: since when friends, when a request was sent or deleted. */
  readonly at: string | null;
}

/** The name and moment in one entry of a list, in the older shape (`name`, `timestamp`) or the newer (`label_values`). */
function entryOf(item: unknown): { name: string; at: string | null } | null {
  if (!isRecord(item)) return null;
  let name = cleanName(item.name) ?? cleanName(item.title);
  let ms = msOf(item.timestamp ?? item.creation_timestamp);
  if (Array.isArray(item.label_values)) {
    for (const field of item.label_values) {
      if (!isRecord(field)) continue;
      const label = typeof field.label === 'string' ? field.label.toLowerCase() : '';
      if (!name && label.includes('name')) name = cleanName(field.value);
      ms ??= msOf(field.timestamp_value);
    }
  }
  if (!name && Array.isArray(item.string_list_data) && isRecord(item.string_list_data[0])) {
    name = cleanName(item.string_list_data[0].value);
    ms ??= msOf(item.string_list_data[0].timestamp);
  }
  return name ? { name, at: ms === null ? null : new Date(ms).toISOString() } : null;
}

/** The people in one of the download's lists, or null when the file isn't one of them. */
export function listIn(path: string, data: unknown): DownloadPerson[] | null {
  const file = (path.split('/').pop() ?? '').toLowerCase();
  const byFile = LIST_FILES.get(file);
  if (!LIST_FOLDERS.test(path) && !byFile) return null;
  let found: { list: DownloadList; items: unknown[] } | null = null;
  if (Array.isArray(data)) found = byFile ? { list: byFile, items: data } : null;
  else if (isRecord(data)) {
    for (const [key, value] of Object.entries(data)) {
      const list = LIST_KEYS.get(key);
      if (list && Array.isArray(value)) {
        found = { list, items: value };
        break;
      }
    }
    const lists = Object.values(data).filter(Array.isArray);
    if (!found && byFile && lists.length === 1) found = { list: byFile, items: lists[0]! };
  }
  if (!found) return null;
  const { list, items } = found;
  return items.flatMap((item) => {
    const entry = entryOf(item);
    return entry ? [{ list, ...entry }] : [];
  });
}

/** A chat in the download: who's in it, and who wrote each message when. Null when the file isn't one. */
export function chatIn(
  data: unknown,
): { people: string[]; messages: { from: string | null; at: number }[] } | null {
  if (!isRecord(data) || !Array.isArray(data.participants) || !Array.isArray(data.messages))
    return null;
  const people = data.participants.flatMap((p) => {
    const name = cleanName(isRecord(p) ? p.name : p);
    return name ? [name] : [];
  });
  const messages = data.messages.flatMap((m) => {
    if (!isRecord(m)) return [];
    const at = msOf(m.timestamp_ms ?? m.timestampMs ?? m.timestamp);
    if (at === null) return [];
    const sender = m.sender_name ?? m.senderName ?? m.sender;
    return [{ from: cleanName(isRecord(sender) ? sender.name : sender), at }];
  });
  return { people, messages };
}

/** When the person last messaged someone, as their chats in the download say: one-to-one chats only. */
export interface DownloadChat {
  /** Who it was with. */
  readonly name: string;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly messages: number;
  /** Whether the latest message was the person's own. */
  readonly lastFromMe: boolean;
}

/** The person's own name, from their profile in the download. */
function ownerIn(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const profile = isRecord(data.profile_v2)
    ? data.profile_v2
    : isRecord(data.profile)
      ? data.profile
      : null;
  const name = profile && isRecord(profile.name) ? profile.name.full_name : profile?.name;
  return cleanName(name);
}

/**
 * Each person the download's chats were with, one-to-one: the first and the latest message, how many, and whether the
 * latest was the person's own. The person is the one named on their profile, or else the one in nearly every chat.
 */
export function chatsByPerson(
  chats: readonly { people: string[]; messages: { from: string | null; at: number }[] }[],
  owner: string | null,
): DownloadChat[] {
  const pairs = chats.filter((c) => c.people.length === 2 && c.messages.length);
  let me = owner ? nameKey(owner) : null;
  if (!me || !pairs.some((c) => c.people.some((p) => nameKey(p) === me))) {
    const seen = new Map<string, number>();
    for (const c of pairs)
      for (const key of new Set(c.people.map(nameKey))) seen.set(key, (seen.get(key) ?? 0) + 1);
    const [top, second] = [...seen].sort((a, b) => b[1] - a[1]);
    // With one chat, or two names as common, there's no telling which is the person's own.
    me = top && top[1] > 1 && (!second || top[1] > second[1]) ? top[0] : null;
  }
  if (!me) return [];
  const byPerson = new Map<
    string,
    { name: string; first: number; last: number; messages: number; lastFromMe: boolean }
  >();
  for (const c of pairs) {
    const other = c.people.find((p) => nameKey(p) !== me);
    if (!other || !c.people.some((p) => nameKey(p) === me)) continue;
    const key = nameKey(other);
    const had = byPerson.get(key) ?? {
      name: other,
      first: Infinity,
      last: -Infinity,
      messages: 0,
      lastFromMe: false,
    };
    for (const m of c.messages) {
      had.first = Math.min(had.first, m.at);
      if (m.at >= had.last) {
        had.last = m.at;
        had.lastFromMe = m.from !== null && nameKey(m.from) === me;
      }
      had.messages++;
    }
    byPerson.set(key, had);
  }
  return [...byPerson.values()].map((c) => ({
    name: c.name,
    firstAt: new Date(c.first).toISOString(),
    lastAt: new Date(c.last).toISOString(),
    messages: c.messages,
    lastFromMe: c.lastFromMe,
  }));
}

/** What the download says, ready to save. */
export interface DownloadRead {
  /** When Facebook made the file, as near as it says. */
  readonly madeAt: string;
  readonly people: readonly DownloadPerson[];
  readonly chats: readonly DownloadChat[];
  /** The JSON files read, and the ones that couldn't be. */
  readonly read: number;
  readonly unread: number;
}

/** The files a chat could be in: the download's message folders, and every file in the chat backup. */
const CHAT_PLACES =
  /(^|\/)(messages?|inbox|e2ee[a-z_]*|archived_threads|filtered_threads|message_requests)\//;
/** The download's own folders, which the chat backup doesn't have. */
const DOWNLOAD_FOLDERS =
  /^(connections|your_facebook_activity|personal_information|logged_information)\//;
const PROFILE_FILE = /(^|\/)profile_information\.json$/;
/** More than this in one JSON file isn't a list or a chat. */
const BIGGEST_JSON = 200_000_000;

/**
 * Reads the friends, requests, followers and chats out of Facebook's zips: the download (one or more parts) and the
 * chat backup. `progress` hears how many of the files to read are done.
 */
export async function readDownload(
  files: readonly Blob[],
  progress?: (done: number, all: number) => unknown,
): Promise<DownloadRead> {
  const zips = await Promise.all(
    files.map(async (file) => ({ file, entries: await zipEntries(file) })),
  );
  const toRead: { file: Blob; entry: ZipEntry; kind: 'list' | 'chat' | 'profile' }[] = [];
  let html = 0;
  let locked = 0;
  let latest = 0;
  for (const { file, entries } of zips) {
    // The chat backup has none of the download's folders: any of its JSON files may be a chat.
    const backup = !entries.some((e) => DOWNLOAD_FOLDERS.test(e.name));
    for (const entry of entries) {
      if (entry.changed) latest = Math.max(latest, entry.changed.getTime());
      const path = entry.name;
      if (/\.html?$/i.test(path)) html++;
      if (!/\.json$/i.test(path)) continue;
      if (entry.encrypted) {
        locked++;
        continue;
      }
      const name = (path.split('/').pop() ?? '').toLowerCase();
      if (PROFILE_FILE.test(path)) toRead.push({ file, entry, kind: 'profile' });
      else if (LIST_FOLDERS.test(path) || LIST_FILES.has(name))
        toRead.push({ file, entry, kind: 'list' });
      else if (backup || CHAT_PLACES.test(path)) toRead.push({ file, entry, kind: 'chat' });
    }
  }
  if (!toRead.length) throw new DownloadError(locked ? 'locked' : html ? 'html' : 'nothing');

  const text = new TextDecoder('utf-8');
  const people = new Map<string, DownloadPerson>();
  const chats: { people: string[]; messages: { from: string | null; at: number }[] }[] = [];
  let owner: string | null = null;
  let read = 0;
  let unread = 0;
  for (const [i, { file, entry, kind }] of toRead.entries()) {
    await progress?.(i, toRead.length);
    let data: unknown;
    try {
      if (entry.packed > BIGGEST_JSON) throw new Error('too big');
      data = JSON.parse(text.decode(await zipEntryBytes(file, entry)));
      read++;
    } catch (e) {
      if (e instanceof DownloadError && e.rule === 'cut_short') throw e;
      unread++;
      continue;
    }
    if (kind === 'profile') owner ??= ownerIn(data);
    else if (kind === 'list') {
      for (const p of listIn(entry.name, data) ?? [])
        people.set(`${p.list}\n${nameKey(p.name)}\n${p.at ?? ''}`, p);
    } else {
      const chat = chatIn(data);
      if (chat) chats.push(chat);
    }
  }
  await progress?.(toRead.length, toRead.length);

  const byPerson = chatsByPerson(chats, owner);
  if (!people.size && !byPerson.length) throw new DownloadError(html ? 'html' : 'nothing');
  // When the zip says its files were written, and never before the latest moment in them.
  for (const p of people.values()) if (p.at) latest = Math.max(latest, Date.parse(p.at));
  for (const c of byPerson) latest = Math.max(latest, Date.parse(c.lastAt));
  return {
    madeAt: new Date(Math.min(latest || Date.now(), Date.now())).toISOString(),
    people: [...people.values()],
    chats: byPerson,
    read,
    unread,
  };
}

// ---- Saving it ----

const When = z.iso.datetime();

export const DownloadPersonInput = z.object({
  list: z.enum(DOWNLOAD_LIST_KEYS),
  name: PersonName,
  at: When.nullable(),
});

export const DownloadChatInput = z.object({
  name: PersonName,
  firstAt: When,
  lastAt: When,
  messages: z.number().int().min(1).max(100_000_000),
  lastFromMe: z.boolean(),
});

export const DownloadSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  /** The bringing-in these are part of; left out on the first part, which starts one. */
  importId: z.uuid().optional(),
  /** When Facebook made the file, as near as it says. */
  madeAt: When,
  people: z
    .array(DownloadPersonInput)
    .max(DOWNLOAD_PEOPLE_MOST, `Send up to ${DOWNLOAD_PEOPLE_MOST} people at a time.`)
    .default([]),
  chats: z
    .array(DownloadChatInput)
    .max(DOWNLOAD_CHATS_MOST, `Send up to ${DOWNLOAD_CHATS_MOST} chats at a time.`)
    .default([]),
  /** The last part: what the file says is put in place on the people saved here. */
  last: z.boolean().default(false),
});
export type DownloadSaveInput = z.input<typeof DownloadSaveInput>;

const count = z.number().int().min(0);

/** What a download held, by list, and how many of its people are linked to a profile saved here. */
export const DownloadCounts = z.object({
  friends: count,
  request_sent: count,
  request_received: count,
  removed: count,
  declined: count,
  followers: count,
  following: count,
  chats: count,
  /** People and chats matched by name to one profile saved here. */
  linked: count,
  /** The rest: nobody saved here by that name yet, or more than one. */
  notLinked: count,
});
export type DownloadCounts = z.output<typeof DownloadCounts>;

export const DownloadSaveOutput = z.object({
  importId: z.uuid(),
  /** On the last part: what the whole file held. */
  counts: DownloadCounts.nullable(),
  /** On the last part: the people saved here whose friendship the file told something new about. */
  changed: count,
});
export type DownloadSaveOutput = z.output<typeof DownloadSaveOutput>;

/** One part of a download as sent: some of its people, some of its chats, or both. */
export interface DownloadPart {
  readonly people: DownloadPerson[];
  readonly chats: DownloadChat[];
}

/** What's read, cut into parts that each fit one save: a part's people and chats, and its size as sent. */
export function downloadParts(read: Pick<DownloadRead, 'people' | 'chats'>): DownloadPart[] {
  const parts: DownloadPart[] = [];
  const size = new TextEncoder();
  let part: DownloadPart = { people: [], chats: [] };
  let bytes = 0;
  const add = <K extends keyof DownloadPart>(
    kind: K,
    item: DownloadPart[K][number],
    most: number,
  ) => {
    const length = size.encode(JSON.stringify(item)).length + 1;
    if (part[kind].length >= most || bytes + length > DOWNLOAD_PART_BYTES) {
      parts.push(part);
      part = { people: [], chats: [] };
      bytes = 0;
    }
    (part[kind] as DownloadPart[K][number][]).push(item);
    bytes += length;
  };
  for (const p of read.people) add('people', p, DOWNLOAD_PEOPLE_MOST);
  for (const c of read.chats) add('chats', c, DOWNLOAD_CHATS_MOST);
  if (part.people.length || part.chats.length || !parts.length) parts.push(part);
  return parts;
}
