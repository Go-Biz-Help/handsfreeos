/**
 * What the browser extension notes as the person works on Facebook, and what the activity panel shows
 * (docs/outreach.md, decisions 7 and 8): the friend requests, likes, comments and messages they send there
 * themselves, each with who it was to and the group they found them in; and how many of each in a day, a week or a
 * month. Browser-safe: the extension builds the notes, and the web and the extension draw the panel from these.
 */
import { z } from 'zod';
import { GROUP_ID, GROUP_SLUG, NAME_MOST, THREAD_KEY } from './limits';
import { PLATFORM_KEYS } from './playbooks';
import { FacebookUrl, PersonName, ProfileRef } from './saves';

/** The steps the extension notes, as the panel names them. */
export const TOUCH_KINDS = {
  friend_request: 'Friend request',
  like: 'Like',
  comment: 'Comment',
  message: 'Message',
} as const;
export type TouchKind = keyof typeof TOUCH_KINDS;
export const TOUCH_KIND_KEYS = Object.keys(TOUCH_KINDS) as [TouchKind, ...TouchKind[]];

/**
 * A message's place in the outreach, which the daily limits count: the first to them (a chat started), or the first
 * on a later day that isn't answering them (a follow-up). The rest of a day's messages, and answers, are neither.
 */
export const TOUCH_STEPS = ['first_message', 'follow_up'] as const;
export type TouchStep = (typeof TOUCH_STEPS)[number];

/** A group by its number, the name in its link, or both: whichever its links showed. */
export const GroupRef = z
  .object({
    id: z.string().regex(GROUP_ID).nullable(),
    slug: z.string().regex(GROUP_SLUG).nullable(),
    url: FacebookUrl,
    /** Its name as the page showed it, when it did. */
    name: z.string().trim().min(1).max(NAME_MOST).nullable().default(null),
  })
  .refine((g) => g.id !== null || g.slug !== null, {
    error: 'Send the group’s number or the name in its link.',
  });
export type GroupRef = z.output<typeof GroupRef>;

export const TouchSaveInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  kind: z.enum(TOUCH_KIND_KEYS),
  /** Who it was to: the person asked to be friends, whose post or comment it was, who the message went to. */
  profile: ProfileRef,
  name: PersonName,
  /** The group they were found in, when the page said. */
  group: GroupRef.nullable().default(null),
  /** The post liked or commented on. */
  postUrl: FacebookUrl.nullable().default(null),
  /** The chat a message went in: the number in its link. */
  threadKey: z.string().regex(THREAD_KEY).nullable().default(null),
  /** A message answering theirs: the chat's last message before it was from them, as the page showed it. */
  replying: z.boolean().nullable().default(null),
});
export type TouchSaveInput = z.input<typeof TouchSaveInput>;

export const TouchSaveOutput = z.object({
  touchId: z.uuid(),
  profileId: z.uuid(),
  /** The customer the profile is saved to, when it is one. */
  personId: z.uuid().nullable(),
  /** A message's place: a chat started, a follow-up, or neither. */
  step: z.enum(TOUCH_STEPS).nullable(),
  /** Noted already: the same post liked again, or a second friend request within a day. */
  repeated: z.boolean(),
});

/** The stretches of time the panel shows, each ending today, in the business's time zone. */
export const ACTIVITY_PERIODS = {
  today: { label: 'Today', days: 1 },
  week: { label: 'Last 7 days', days: 7 },
  month: { label: 'Last 30 days', days: 30 },
} as const;
export type ActivityPeriod = keyof typeof ACTIVITY_PERIODS;
export const ACTIVITY_PERIOD_KEYS = Object.keys(ACTIVITY_PERIODS) as [
  ActivityPeriod,
  ...ActivityPeriod[],
];

export const ActivityInput = z.object({
  workspaceId: z.uuid(),
  period: z.enum(ACTIVITY_PERIOD_KEYS).default('today'),
  /** Everyone's steps, for owners and admins (`outreach.manage`). Left out: the person's own. */
  everyone: z.boolean().default(false),
});
export type ActivityInput = z.input<typeof ActivityInput>;

/** The most people the panel lists; `morePeople` says how many it left out. */
export const ACTIVITY_PEOPLE = 100;
/** The most groups it lists. */
export const ACTIVITY_GROUPS = 50;

const count = z.number().int().min(0);
const moment = z.iso.datetime();

export const ActivityOutput = z.object({
  /** Where the stretch starts: midnight in the business's time zone. */
  from: moment,
  timezone: z.string(),
  everyone: z.boolean(),
  /** How many of each in the stretch. */
  numbers: z.object({
    /** People reached any way. */
    people: count,
    /** Friend requests sent. */
    friendRequests: count,
    /** Posts liked. */
    likes: count,
    comments: count,
    /** First messages: chats started. */
    chatsStarted: count,
    followUps: count,
    /** People who wrote back, as a chat saved to HandsFreeOS shows: a message from them after one from us. */
    replies: count,
  }),
  /** The person's own day so far, step by step, against the daily limits (DAILY_LIMITS). */
  today: z.object({
    friend_request: count,
    first_message: count,
    follow_up: count,
    comment: count,
    like: count,
  }),
  /**
   * The people below by the group they were found in, the most first: how many, and how many of them were sent a
   * friend request, liked or commented on, sent a first message, and wrote back in the stretch.
   */
  groups: z.array(
    z.object({
      groupId: z.uuid(),
      name: z.string().nullable(),
      url: z.string(),
      people: count,
      friendRequests: count,
      /** Liked or commented on. */
      warmedUp: count,
      chatsStarted: count,
      replies: count,
    }),
  ),
  /**
   * The people reached or who wrote back in the stretch, the latest first, with the last time of each step (in any
   * stretch): how far each has come.
   */
  people: z.array(
    z.object({
      profileId: z.uuid(),
      personId: z.uuid().nullable(),
      name: z.string(),
      url: z.string(),
      group: z.object({ name: z.string().nullable(), url: z.string() }).nullable(),
      requestedAt: moment.nullable(),
      likedAt: moment.nullable(),
      commentedAt: moment.nullable(),
      messagedAt: moment.nullable(),
      repliedAt: moment.nullable(),
      lastAt: moment,
    }),
  ),
  morePeople: count,
});
export type ActivityOutput = z.output<typeof ActivityOutput>;
