/**
 * What the browser extension saves to Social Outreach (docs/outreach.md): a person's profile and a chat with them,
 * as it read them off the page, and how a chat read again joins what was saved before. Browser-safe: the extension
 * builds these inputs and the server checks them.
 */
import { z } from 'zod';
import {
  FRIEND_STATE_KEYS,
  INTRO_LINE_MOST,
  INTRO_LINES,
  KEPT_MESSAGES,
  LOOKUP_NAMES,
  LOOKUP_PROFILES,
  LOOKUP_THREADS,
  MESSAGE_MOST,
  NAME_MOST,
  PROFILE_ID,
  THREAD_KEY,
  USERNAME,
  WHEN_MOST,
} from './limits';
import { PLATFORM_KEYS, type Platform } from './playbooks';

export type { Platform };
export { KEPT_MESSAGES };

/** Where the two of them stand on Facebook, as the profile showed it to the person saving it. */
export const FRIENDSHIPS = [
  'friends',
  'request_sent',
  'request_received',
  'not_friends',
  'unknown',
] as const;
export type Friendship = (typeof FRIENDSHIPS)[number];

/** A Facebook address, as the extension writes them: on www.facebook.com, over https. */
export const FacebookUrl = z
  .string()
  .trim()
  .max(500)
  .regex(/^https:\/\/www\.facebook\.com\//, 'Send the Facebook address the page links to.');

/** A profile by its number, its username, or both: whichever its links showed. */
export const ProfileRef = z
  .object({
    id: z.string().regex(PROFILE_ID).nullable(),
    username: z.string().regex(USERNAME).nullable(),
    url: FacebookUrl,
  })
  .refine((p) => p.id !== null || p.username !== null, {
    error: 'Send the profile’s number or its username.',
  });
export type ProfileRef = z.output<typeof ProfileRef>;

/** Someone's name, as the page showed it. */
export const PersonName = z
  .string()
  .trim()
  .min(1, 'Send their name as the page shows it.')
  .max(NAME_MOST, `Keep the name under ${NAME_MOST} characters.`);

export const ProfileSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  profile: ProfileRef,
  name: PersonName,
  /** The lines under their name: work, business, town. */
  intro: z.array(z.string().trim().min(1).max(INTRO_LINE_MOST)).max(INTRO_LINES).default([]),
  friendship: z.enum(FRIENDSHIPS).default('unknown'),
  mutualFriends: z.number().int().min(0).max(100_000).nullable().default(null),
  /** A customer already in Contacts the person said this is. Left out: the one the profile is saved to, or a new one. */
  personId: z.uuid().optional(),
});
export type ProfileSaveInput = z.input<typeof ProfileSaveInput>;

export const ProfileSaveOutput = z.object({
  personId: z.uuid(),
  personName: z.string(),
  profileId: z.uuid(),
  /** A new customer was added for them. */
  addedPerson: z.boolean(),
});

/** One message in a chat, as the page showed it. */
export const ChatMessage = z.object({
  from: z.enum(['me', 'them', 'unknown']),
  /** Their name on the message, when the page shows one. */
  sender: z.string().trim().max(NAME_MOST).nullable().default(null),
  text: z.string().trim().min(1).max(MESSAGE_MOST),
  /** When, as Facebook printed it ("Today at 10:12 AM"). */
  when: z.string().trim().max(WHEN_MOST).nullable().default(null),
});
export type ChatMessage = z.output<typeof ChatMessage>;

/** A message as a chat keeps it: also when it was first saved, which says what "Today" meant. */
export interface SavedMessage extends ChatMessage {
  readonly savedAt: string;
}

export const ChatSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  thread: z.object({
    id: z.string().regex(THREAD_KEY, 'Send the chat’s number from its link.'),
    encrypted: z.boolean().default(false),
    url: FacebookUrl,
  }),
  /** The name the chat shows. */
  name: PersonName,
  /** The profile the chat links to: who it's with. */
  profile: ProfileRef.nullable(),
  /** What the page shows, oldest first. Older ones join what was saved before. */
  messages: z
    .array(ChatMessage)
    .min(1, 'There are no messages on the page to save.')
    .max(KEPT_MESSAGES),
  /** A customer already in Contacts the person said this is. */
  personId: z.uuid().optional(),
});
export type ChatSaveInput = z.input<typeof ChatSaveInput>;

export const ChatSaveOutput = z.object({
  personId: z.uuid(),
  personName: z.string(),
  threadId: z.uuid(),
  addedPerson: z.boolean(),
  /** Messages it hadn't saved before. */
  added: z.number().int(),
  /** Messages the chat keeps now. */
  kept: z.number().int(),
});

export const OutreachLookupInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  /** Profiles on the page: which are saved, and to whom. */
  profiles: z
    .array(
      z.object({
        id: z.string().regex(PROFILE_ID).nullable(),
        username: z.string().regex(USERNAME).nullable(),
      }),
    )
    .max(LOOKUP_PROFILES)
    .default([]),
  /** Chats on the page: which of the person's own are saved, and how much of each. */
  threads: z.array(z.string().regex(THREAD_KEY)).max(LOOKUP_THREADS).default([]),
  /** Names to look for in Contacts: who someone not saved yet may already be. */
  names: z.array(PersonName).max(LOOKUP_NAMES).default([]),
});

const Person = z.object({ personId: z.uuid(), name: z.string() });

/**
 * Why someone's never pitched (docs/outreach.md, decision 11): put on the business's Don't pitch list, by whom and
 * when, or a customer tagged Friend or family in Contacts.
 */
export const DontPitch = z.object({
  /** Who put them on the list: null once they've left the business, and for a tag alone. */
  by: z.string().nullable(),
  at: z.iso.datetime().nullable(),
  /** A customer tagged Friend or family (DONT_PITCH_TAG). */
  tagged: z.boolean(),
});
export type DontPitch = z.output<typeof DontPitch>;

export const OutreachLookupOutput = z.object({
  profiles: z.array(
    Person.extend({
      profileId: z.uuid(),
      id: z.string().nullable(),
      username: z.string().nullable(),
    }),
  ),
  /**
   * Every profile on the page kept here, with a customer or not: where the person's own Facebook stands with them,
   * whether they keep them, whether they're never pitched, and what's known for fit (./fit.ts).
   */
  marks: z.array(
    z.object({
      profileId: z.uuid(),
      id: z.string().nullable(),
      username: z.string().nullable(),
      state: z.enum(FRIEND_STATE_KEYS).nullable(),
      keep: z.boolean(),
      dontPitch: DontPitch.nullable(),
      /** A demo they booked after the person reached them: through the demo link, or marked (./demos.ts `DEMO_HOWS`). */
      demo: z.enum(['link', 'marked']).nullable(),
      intro: z.array(z.string()),
      mutualFriends: z.number().int().nullable(),
      groupName: z.string().nullable(),
    }),
  ),
  threads: z.array(
    Person.extend({
      threadId: z.uuid(),
      key: z.string(),
      kept: z.number().int(),
      lastSavedAt: z.iso.datetime(),
    }),
  ),
  /** Customers with each name, up to three each, and what tells them apart. */
  sameName: z.array(
    z.object({
      name: z.string(),
      people: z.array(
        Person.extend({
          email: z.string().nullable(),
          phone: z.string().nullable(),
          source: z.string().nullable(),
          createdAt: z.iso.datetime(),
          /** Already saved with a profile on this network. */
          hasProfile: z.boolean(),
        }),
      ),
    }),
  ),
});

/** The same message read twice: the same words from the same side. A side the page didn't say matches either. */
function same(a: ChatMessage, b: ChatMessage): boolean {
  return a.text === b.text && (a.from === b.from || a.from === 'unknown' || b.from === 'unknown');
}

/**
 * A chat read again, joined to what was saved before. The page shows a stretch of the chat (the newest as it opens,
 * older ones as you scroll up), so the stretch read is placed where it overlaps the saved one the most, the latest
 * such place when two overlap as much; with no overlap it's taken as newer. Messages in both keep their first
 * saving, and learn who sent them when only the new read says. Only the most recent `keep` are kept.
 */
export function joinMessages(
  saved: readonly SavedMessage[],
  read: readonly ChatMessage[],
  savedAt: string,
  keep: number = KEPT_MESSAGES,
): { readonly messages: SavedMessage[]; readonly added: number } {
  // `at` is where read[0] falls in saved: negative when the read starts before what's saved.
  let at = saved.length;
  let best = 0;
  for (let start = saved.length - 1; start > -read.length; start--) {
    const from = Math.max(0, -start);
    const to = Math.min(read.length, saved.length - start);
    let matches = true;
    for (let i = from; i < to && matches; i++) matches = same(saved[start + i]!, read[i]!);
    if (matches && to - from > best) {
      best = to - from;
      at = start;
    }
  }
  const joined: (SavedMessage & { readonly isNew?: true })[] = [];
  for (let p = Math.min(0, at); p < Math.max(saved.length, at + read.length); p++) {
    const old = saved[p];
    const now = read[p - at];
    if (old && now)
      joined.push(
        old.from === 'unknown' && now.from !== 'unknown'
          ? { ...old, from: now.from, sender: old.sender ?? now.sender }
          : old,
      );
    else if (old) joined.push(old);
    else if (now) joined.push({ ...now, savedAt, isNew: true });
  }
  const kept = joined.slice(-keep);
  return {
    messages: kept.map(({ isNew: _, ...m }) => m),
    added: kept.filter((m) => m.isNew).length,
  };
}
