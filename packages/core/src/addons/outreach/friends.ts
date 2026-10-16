/**
 * Friends (docs/outreach.md, decisions 10 to 13): where each person's own Facebook stands with the people they reach,
 * the friend requests they get, the friends they keep (never suggested for unfriending), the business's Don't pitch
 * list (never a friend request, like, comment or message), and its Never contact list (nothing at all, not even a reply
 * or confirming their request). Browser-safe: the extension builds the inputs, the
 * web draws the Friends tab, and the server checks them.
 */
import { z } from 'zod';
import { CheckShown, ChecksSummary } from './checks';
import { DownloadCounts } from './download';
import { FIT_LEVEL_KEYS } from './fit';
import {
  FRIEND_ANSWER_KEYS,
  FRIEND_STATE_KEYS,
  FRIENDS_SAVE_MOST,
  INTRO_LINE_MOST,
  INTRO_LINES,
} from './limits';
import { PLATFORM_KEYS } from './playbooks';
import { DontPitch, NeverContact, PersonName, ProfileRef } from './saves';

export { DontPitch, NeverContact } from './saves';
export {
  DONT_PITCH_TAG,
  FRIEND_ANSWER_KEYS,
  FRIEND_ANSWERS,
  FRIEND_STATE_KEYS,
  FRIEND_STATES,
  FRIENDS_CAP,
  FRIENDS_SAVE_MOST,
  type FriendAnswer,
  type FriendState,
} from './limits';

const mutualFriends = z.number().int().min(0).max(100_000).nullable().default(null);

export const FriendNoteInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  answer: z.enum(FRIEND_ANSWER_KEYS),
  /** Who asked to be friends. */
  profile: ProfileRef,
  name: PersonName,
  mutualFriends,
});
export type FriendNoteInput = z.input<typeof FriendNoteInput>;

export const FriendNoteOutput = z.object({
  profileId: z.uuid(),
  /** The customer the profile is saved to, when it is one. */
  personId: z.uuid().nullable(),
  state: z.enum(FRIEND_STATE_KEYS),
});

/**
 * The lists the extension can save as the page shows them: your friends, the friend requests you've got, and the ones
 * you've sent.
 */
export const FRIEND_LISTS = {
  friends: 'Your friends',
  requests: 'Friend requests',
  sent: 'Sent requests',
} as const;
export type FriendList = keyof typeof FRIEND_LISTS;
export const FRIEND_LIST_KEYS = Object.keys(FRIEND_LISTS) as [FriendList, ...FriendList[]];

export const FriendsSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  list: z.enum(FRIEND_LIST_KEYS),
  /** The people the page shows, as far as it has loaded. A longer list goes in parts. */
  people: z
    .array(
      z.object({
        profile: ProfileRef,
        name: PersonName,
        mutualFriends,
        /**
         * When it began, when the list says: LinkedIn's file has since when they're connected and when each
         * invitation went. Where they stand starts then rather than now (so an invitation sent two months ago is
         * old at once), and the same state seen again goes back to it when it's earlier. Never later than now.
         */
        since: z.iso.datetime().nullable().optional(),
      }),
    )
    .min(1, 'There’s nobody on the page to save.')
    .max(FRIENDS_SAVE_MOST, `Save up to ${FRIENDS_SAVE_MOST} at a time.`),
});
export type FriendsSaveInput = z.input<typeof FriendsSaveInput>;

export const FriendsSaveOutput = z.object({
  /** People in the list. */
  saved: z.number().int(),
  /** New to HandsFreeOS. */
  added: z.number().int(),
  /** Known before, and now where the list says they are (friends, or a request either way) where they weren't. */
  changed: z.number().int(),
});

/**
 * Keep, for the person's own friend, and Don't pitch and Never contact, for the business. Someone by the profile kept here, or by their
 * profile on Facebook and their name when the extension sets it from a page.
 */
export const FriendSetInput = z
  .object({
    workspaceId: z.uuid(),
    platform: z.enum(PLATFORM_KEYS).default('facebook'),
    profileId: z.uuid().optional(),
    profile: ProfileRef.optional(),
    name: PersonName.optional(),
    /** Never suggested for unfriending. */
    keep: z.boolean().optional(),
    /** Never a friend request, like, comment or message, from anyone in the business. */
    dontPitch: z.boolean().optional(),
    /** Nothing at all from anyone in the business: no friend request, like, comment or message, not even a reply. */
    neverContact: z.boolean().optional(),
  })
  .refine((i) => i.profileId !== undefined || (i.profile !== undefined && i.name !== undefined), {
    error: 'Say who: the profile kept here, or their profile on Facebook and their name.',
  })
  .refine(
    (i) => i.keep !== undefined || i.dontPitch !== undefined || i.neverContact !== undefined,
    {
      error: 'Say what to change: Keep, Don’t pitch or Never contact.',
    },
  );
export type FriendSetInput = z.input<typeof FriendSetInput>;

export const FriendSetOutput = z.object({
  profileId: z.uuid(),
  keep: z.boolean(),
  dontPitch: DontPitch.nullable(),
  neverContact: NeverContact.nullable(),
});

/** What the Friends tab shows: the good fits among friends and chats are decision 46's (./checks.ts). */
export const FRIEND_VIEWS = {
  friends: 'Friends',
  fits: 'Good fits',
  requests: 'Requests',
  sent: 'Sent',
  keep: 'Keep',
  dont_pitch: 'Don’t pitch',
  never_contact: 'Never contact',
} as const;
export type FriendView = keyof typeof FRIEND_VIEWS;
export const FRIEND_VIEW_KEYS = Object.keys(FRIEND_VIEWS) as [FriendView, ...FriendView[]];

/** How many people a page of the Friends tab lists. */
export const FRIENDS_PAGE = 100;

export const FriendsInput = z.object({
  workspaceId: z.uuid(),
  view: z.enum(FRIEND_VIEW_KEYS).default('friends'),
  /** Part of a name. */
  search: z.string().trim().max(100).optional(),
  /** Which page, from 1. One past the end shows the last. */
  page: z.number().int().min(1).max(100_000).default(1),
});
export type FriendsInput = z.input<typeof FriendsInput>;

const count = z.number().int().min(0);

export const FriendsOutput = z.object({
  counts: z.object({
    friends: count,
    /** Friends and people chatted with whom the AI found a good fit, or might fit. */
    fits: count,
    /** Friend requests you've got and not answered. */
    requests: count,
    /** Friend requests you sent that haven't been answered. */
    sent: count,
    keep: count,
    /** The business's. */
    dontPitch: count,
    /** The business's too. */
    neverContact: count,
  }),
  /** Facebook's cap on friends. */
  cap: count,
  /** The person's latest Facebook download file brought in: when Facebook made it, when it came, and what it held. */
  download: z
    .object({ madeAt: z.iso.datetime(), at: z.iso.datetime(), counts: DownloadCounts })
    .nullable(),
  people: z.array(
    z.object({
      profileId: z.uuid(),
      personId: z.uuid().nullable(),
      name: z.string(),
      url: z.string(),
      /** Where the person's own Facebook stands with them, when known, and since when. */
      state: z.enum(FRIEND_STATE_KEYS).nullable(),
      since: z.iso.datetime().nullable(),
      keep: z.boolean(),
      dontPitch: DontPitch.nullable(),
      neverContact: NeverContact.nullable(),
      mutualFriends: z.number().int().nullable(),
      /** The first lines of their intro, as last saved. */
      intro: z.array(z.string().max(INTRO_LINE_MOST)).max(INTRO_LINES),
      group: z.object({ name: z.string().nullable(), url: z.string() }).nullable(),
      /** When they became friends, as the person's Facebook download file says. */
      friendsSince: z.iso.datetime().nullable(),
      /** The latest message between them, from the download file or noted since, and whether it was the person's. */
      lastMessage: z.object({ at: z.iso.datetime(), fromMe: z.boolean() }).nullable(),
      /** How they fit the playbooks in use, for the requests. */
      fit: z
        .object({
          level: z.enum(FIT_LEVEL_KEYS),
          score: z.number().int(),
          playbookName: z.string().nullable(),
          reasons: z.array(z.string()),
        })
        .nullable(),
      /** What the AI made of them, once the extension has checked them (decision 46). */
      check: CheckShown.nullable(),
    }),
  ),
  /** How far checking friends and chats for good fits has come. */
  checks: ChecksSummary,
  /** The page these are, from 1, out of `pages`; there's always one, if empty. */
  page: count.min(1),
  pages: count.min(1),
  /** Everyone in this view who has the name searched for, on every page. */
  total: count,
  /** How many come after this page. */
  more: count,
});
export type FriendsOutput = z.output<typeof FriendsOutput>;
