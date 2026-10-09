/**
 * Facebook's download file (docs/outreach.md, decisions 2 and 15). The reading, in the person's browser, is
 * ./download-read.ts; this adds the schemas the server checks what's sent with.
 */
import { z } from 'zod';
import { DOWNLOAD_CHATS_MOST, DOWNLOAD_LIST_KEYS, DOWNLOAD_PEOPLE_MOST } from './download-read';
import { MESSAGE_MOST, RECENT_MESSAGES } from './limits';
import { PLATFORM_KEYS } from './playbooks';
import { PersonName } from './saves';

export * from './download-read';

// ---- Saving it ----

const When = z.iso.datetime();

export const DownloadPersonInput = z.object({
  list: z.enum(DOWNLOAD_LIST_KEYS),
  name: PersonName,
  at: When.nullable(),
});

/** One of a chat's latest messages: whether the person wrote it, what it said, and when. */
export const DownloadMessageInput = z.object({
  fromMe: z.boolean(),
  text: z.string().trim().min(1).max(MESSAGE_MOST),
  at: When,
});

export const DownloadChatInput = z.object({
  name: PersonName,
  firstAt: When,
  lastAt: When,
  messages: z.number().int().min(1).max(100_000_000),
  lastFromMe: z.boolean(),
  /** Its latest messages, oldest first, for the AI to read. */
  recent: z.array(DownloadMessageInput).max(RECENT_MESSAGES).default([]),
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
