/**
 * LinkedIn's copy of the person's data ("Get a copy of your data", in its Settings under Data privacy), read in their
 * browser (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "What maps to what": Facebook's download file becomes
 * LinkedIn's Connections, Invitations and messages). It reads only these files of the zip LinkedIn gives:
 *
 * - **Connections.csv**: everyone they're connected to, with their profile's address and since when.
 * - **Invitations.csv**: invitations either way, with the other person's profile and when.
 * - **messages.csv**: their conversations, one-to-one only, and of each only the latest few messages
 *   (`RECENT_MESSAGES`), which the AI reads for a summary, as Facebook's chats.
 * - **Profile.csv**: their own name, to tell their messages from the other person's.
 *
 * Every column is found by its name in the file's header row, past the notes LinkedIn writes above it, so a column
 * moved or added changes nothing. No zod, so the extension takes it as it is (as ./download-read.ts).
 */
import {
  DownloadError,
  nameKey,
  zipEntries,
  zipEntryBytes,
  type DownloadChat,
  type DownloadMessage,
} from './download-read';
import { MESSAGE_MOST, NAME_MOST, RECENT_MESSAGES } from './limits';

/** Someone in the person's connections, as the file has them. */
export interface LinkedInPerson {
  readonly name: string;
  /** Their profile's address, as https://www.linkedin.com/in/<name>/: null when the file has none. */
  readonly url: string | null;
  /** Since when they're connected, or when the invitation went. */
  readonly at: string | null;
}

/** An invitation to connect, either way. */
export interface LinkedInInvitation extends LinkedInPerson {
  readonly direction: 'sent' | 'received';
}

/** A one-to-one conversation, as Facebook's chats are kept, with the other person's profile. */
export interface LinkedInChat extends DownloadChat {
  readonly url: string | null;
}

/** What the file says, ready to save. */
export interface LinkedInExport {
  /** When LinkedIn made the file, as near as it says. */
  readonly madeAt: string;
  readonly connections: readonly LinkedInPerson[];
  readonly invitations: readonly LinkedInInvitation[];
  readonly chats: readonly LinkedInChat[];
  /** The files read, and the ones that couldn't be. */
  readonly read: number;
  readonly unread: number;
}

/** The rows of a CSV file: quoted fields with commas, quotes and line breaks in them, and a byte-order mark. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The rows under the header row that names every column in `needed` (any case), each read by column name. LinkedIn
 * writes notes above the header of some files; those are passed over. Null when no row names them all.
 */
function table(text: string, needed: readonly string[]): Map<string, string>[] | null {
  const rows = csvRows(text);
  const at = rows.findIndex((r) => {
    const names = new Set(r.map((c) => c.trim().toLowerCase()));
    return needed.every((n) => names.has(n));
  });
  if (at < 0) return null;
  const header = rows[at]!.map((c) => c.trim().toLowerCase());
  return rows
    .slice(at + 1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => new Map(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** LinkedIn's start: nothing in its file is older. */
const FIRST_DAY = Date.UTC(2003, 4, 1);

/**
 * A moment as LinkedIn writes it, as an ISO time, or null: "15 Oct 2026" (Connected On), "10/15/26, 3:04 PM" (an
 * invitation's Sent At) or "2026-10-15 14:03:22 UTC" (a message's Date). Times without a zone are read as UTC.
 */
export function linkedInTime(raw: string): string | null {
  const text = raw.trim();
  let ms: number | null = null;
  const dayMonth = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(text);
  const us =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AaPp][Mm])?$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?: ?(?:UTC|Z))?$/.exec(
    text,
  );
  if (dayMonth) {
    const month = MONTHS.indexOf(dayMonth[2]!.toLowerCase());
    if (month >= 0) ms = Date.UTC(Number(dayMonth[3]), month, Number(dayMonth[1]));
  } else if (us) {
    const year = Number(us[3]) < 100 ? 2000 + Number(us[3]) : Number(us[3]);
    let hour = Number(us[4]) % 12;
    if (us[7]?.toLowerCase() === 'pm') hour += 12;
    if (!us[7]) hour = Number(us[4]);
    ms = Date.UTC(year, Number(us[1]) - 1, Number(us[2]), hour, Number(us[5]), Number(us[6] ?? 0));
  } else if (iso) {
    ms = Date.UTC(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      Number(iso[6] ?? 0),
    );
  }
  return ms !== null && Number.isFinite(ms) && ms >= FIRST_DAY && ms <= Date.now() + 86_400_000
    ? new Date(ms).toISOString()
    : null;
}

/** A profile's address as the add-on keeps LinkedIn's: https://www.linkedin.com/in/<name>/, or null. */
export function linkedInProfileUrl(raw: string): string | null {
  const m =
    /^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([A-Za-z0-9%_-]{1,100})\/?(?:[?#].*)?$/i.exec(
      raw.trim(),
    );
  return m ? `https://www.linkedin.com/in/${m[1]}/` : null;
}

const cleanName = (raw: string | undefined): string | null => {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  return name && name.length <= NAME_MOST ? name : null;
};

/** Everyone in Connections.csv. */
export function connectionsIn(text: string): LinkedInPerson[] | null {
  const rows = table(text, ['first name', 'last name', 'url']);
  if (!rows) return null;
  return rows.flatMap((r) => {
    const name = cleanName(`${r.get('first name') ?? ''} ${r.get('last name') ?? ''}`);
    return name
      ? [
          {
            name,
            url: linkedInProfileUrl(r.get('url') ?? ''),
            at: linkedInTime(r.get('connected on') ?? ''),
          },
        ]
      : [];
  });
}

/** Every invitation in Invitations.csv, each with the other person: who it went to, or who sent it. */
export function invitationsIn(text: string): LinkedInInvitation[] | null {
  const rows = table(text, ['from', 'to', 'direction']);
  if (!rows) return null;
  return rows.flatMap((r) => {
    const way = (r.get('direction') ?? '').toLowerCase();
    const direction = way.startsWith('out') ? 'sent' : way.startsWith('in') ? 'received' : null;
    if (!direction) return [];
    const name = cleanName(direction === 'sent' ? r.get('to') : r.get('from'));
    const url = linkedInProfileUrl(
      (direction === 'sent' ? r.get('inviteeprofileurl') : r.get('inviterprofileurl')) ?? '',
    );
    return name
      ? [{ name, url, at: linkedInTime(r.get('sent at') ?? ''), direction } as const]
      : [];
  });
}

/** The person's own name, from Profile.csv. */
export function ownerOf(text: string): string | null {
  const [row] = table(text, ['first name', 'last name']) ?? [];
  return row ? cleanName(`${row.get('first name') ?? ''} ${row.get('last name') ?? ''}`) : null;
}

/** A message's words as kept: no markup, one space between words, cut to fit. */
const words = (raw: string): string =>
  raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '’')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MOST);

/**
 * Each one-to-one conversation in messages.csv: who with and their profile, the first and latest message, how many,
 * whether the latest was the person's own, and its latest few with words. The person is `owner` (Profile.csv's
 * name), or else the one in nearly every conversation. Group conversations and spam are left out.
 */
export function linkedInChatsIn(text: string, owner: string | null): LinkedInChat[] | null {
  const rows = table(text, ['conversation id', 'from', 'to', 'date']);
  if (!rows) return null;
  type Line = {
    from: string;
    to: string[];
    fromUrl: string;
    toUrl: string;
    at: string;
    text: string;
  };
  const byConversation = new Map<string, Line[]>();
  for (const r of rows) {
    if ((r.get('folder') ?? '').toLowerCase().includes('spam')) continue;
    const at = linkedInTime(r.get('date') ?? '');
    const from = cleanName(r.get('from'));
    if (!at || !from) continue;
    const to = (r.get('to') ?? '')
      .split(',')
      .map((n) => cleanName(n))
      .filter((n): n is string => n !== null);
    const id = r.get('conversation id') ?? '';
    const lines = byConversation.get(id) ?? [];
    lines.push({
      from,
      to,
      fromUrl: r.get('sender profile url') ?? '',
      toUrl: r.get('recipient profile urls') ?? '',
      at,
      text: words(r.get('content') ?? ''),
    });
    byConversation.set(id, lines);
  }
  // One-to-one: two people in it, all told.
  const pairs = [...byConversation.values()].filter(
    (lines) => new Set(lines.flatMap((l) => [l.from, ...l.to]).map(nameKey)).size === 2,
  );
  let me = owner ? nameKey(owner) : null;
  if (!me || !pairs.some((lines) => lines.some((l) => nameKey(l.from) === me))) {
    const seen = new Map<string, number>();
    for (const lines of pairs)
      for (const key of new Set(lines.flatMap((l) => [l.from, ...l.to]).map(nameKey)))
        seen.set(key, (seen.get(key) ?? 0) + 1);
    const [top, second] = [...seen].sort((a, b) => b[1] - a[1]);
    me = top && top[1] > 1 && (!second || top[1] > second[1]) ? top[0] : null;
  }
  if (!me) return [];
  const chats: LinkedInChat[] = [];
  for (const lines of pairs) {
    const sorted = [...lines].sort((a, b) => a.at.localeCompare(b.at));
    const theirs = sorted.find((l) => nameKey(l.from) !== me);
    const mine = sorted.find((l) => nameKey(l.from) === me);
    const other = theirs?.from ?? mine?.to.find((n) => nameKey(n) !== me);
    if (!other) continue;
    const url =
      linkedInProfileUrl(theirs?.fromUrl ?? '') ??
      (mine ? linkedInProfileUrl(mine.toUrl.split(',')[0] ?? '') : null);
    const recent: DownloadMessage[] = sorted
      .filter((l) => l.text)
      .slice(-RECENT_MESSAGES)
      .map((l) => ({ fromMe: nameKey(l.from) === me, text: l.text, at: l.at }));
    const last = sorted.at(-1)!;
    chats.push({
      name: other,
      url,
      firstAt: sorted[0]!.at,
      lastAt: last.at,
      messages: sorted.length,
      lastFromMe: nameKey(last.from) === me,
      recent,
    });
  }
  return chats;
}

const FILES = {
  connections: /(^|\/)connections\.csv$/i,
  invitations: /(^|\/)invitations\.csv$/i,
  messages: /(^|\/)messages\.csv$/i,
  profile: /(^|\/)profile\.csv$/i,
} as const;
type FileKind = keyof typeof FILES;

/**
 * Reads the connections, invitations and conversations out of LinkedIn's zip (one or more). `progress` hears how many
 * of the files to read are done.
 */
export async function readLinkedInExport(
  files: readonly Blob[],
  progress?: (done: number, all: number) => unknown,
): Promise<LinkedInExport> {
  const toRead: {
    file: Blob;
    entry: Awaited<ReturnType<typeof zipEntries>>[number];
    kind: FileKind;
  }[] = [];
  let latest = 0;
  let locked = 0;
  for (const file of files)
    for (const entry of await zipEntries(file)) {
      if (entry.changed) latest = Math.max(latest, entry.changed.getTime());
      const kind = (Object.keys(FILES) as FileKind[]).find((k) => FILES[k].test(entry.name));
      if (!kind) continue;
      if (entry.encrypted) locked++;
      else toRead.push({ file, entry, kind });
    }
  if (!toRead.length) throw new DownloadError(locked ? 'locked' : 'nothing');

  const text = new TextDecoder('utf-8');
  const found: Partial<Record<FileKind, string[]>> = {};
  let read = 0;
  let unread = 0;
  for (const [i, { file, entry, kind }] of toRead.entries()) {
    await progress?.(i, toRead.length);
    try {
      (found[kind] ??= []).push(text.decode(await zipEntryBytes(file, entry)));
      read++;
    } catch (e) {
      if (e instanceof DownloadError && e.rule === 'cut_short') throw e;
      unread++;
    }
  }
  await progress?.(toRead.length, toRead.length);

  const owner = (found.profile ?? []).map(ownerOf).find((n) => n !== null) ?? null;
  const connections = (found.connections ?? []).flatMap((t) => connectionsIn(t) ?? []);
  const invitations = (found.invitations ?? []).flatMap((t) => invitationsIn(t) ?? []);
  const chats = (found.messages ?? []).flatMap((t) => linkedInChatsIn(t, owner) ?? []);
  if (!connections.length && !invitations.length && !chats.length)
    throw new DownloadError('nothing');
  for (const p of [...connections, ...invitations])
    if (p.at) latest = Math.max(latest, Date.parse(p.at));
  for (const c of chats) latest = Math.max(latest, Date.parse(c.lastAt));
  return {
    madeAt: new Date(Math.min(latest || Date.now(), Date.now())).toISOString(),
    connections,
    invitations,
    chats,
    read,
    unread,
  };
}
