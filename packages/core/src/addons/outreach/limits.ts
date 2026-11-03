/**
 * What Social Outreach's saves take (docs/outreach.md): how long, how many, and the shape of a network's ids; and the
 * steps the extension notes, with the daily limits the activity panel counts them against. The commands hold what's
 * sent to these (./saves.ts, ./activity.ts), and the browser extension cuts what it read to fit them before it sends.
 * Plain values with no zod, so the extension takes them without carrying zod along.
 */

/** A chat keeps this many of its most recent messages, and a save sends at most this many. */
export const KEPT_MESSAGES = 100;
/** A person's name, and a sender's on a message. */
export const NAME_MOST = 200;
/** The lines under a profile's name, and how long each. */
export const INTRO_LINES = 30;
export const INTRO_LINE_MOST = 300;
/** One message's words. */
export const MESSAGE_MOST = 2000;
/** A chat brought in from Facebook's download keeps this many of its latest messages, for the AI to read. */
export const RECENT_MESSAGES = 20;
/** When a message was sent, as the network printed it. */
export const WHEN_MOST = 100;
/** What one look-up asks about. */
export const LOOKUP_PROFILES = 200;
export const LOOKUP_THREADS = 50;
export const LOOKUP_NAMES = 10;

/** A profile's number, its username, and a chat's own number, as their links show them. */
export const PROFILE_ID = /^\d{1,30}$/;
export const USERNAME = /^[A-Za-z0-9.]{1,100}$/;
export const THREAD_KEY = /^[A-Za-z0-9._-]{1,64}$/;
/** A group's number, and the name in its link instead (/groups/<this>/), as its links show them. */
export const GROUP_ID = /^\d{1,30}$/;
export const GROUP_SLUG = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The steps the extension notes as the person takes them on a network (./activity.ts), as the panel names them. A
 * recommendation is Alignable's, written by the person themselves (the Instagram and Alignable plan's question 8).
 */
export const TOUCH_KINDS = {
  friend_request: 'Friend request',
  like: 'Like',
  comment: 'Comment',
  message: 'Message',
  recommend: 'Recommendation',
} as const;
export type TouchKind = keyof typeof TOUCH_KINDS;
export const TOUCH_KIND_KEYS = Object.keys(TOUCH_KINDS) as [TouchKind, ...TouchKind[]];

/**
 * A message's place in the outreach, which the daily limits count: the first to them (a chat started), or the first
 * on a later day that isn't answering them (a follow-up). The rest of a day's messages, and answers, are neither.
 */
export const TOUCH_STEPS = ['first_message', 'follow_up'] as const;
export type TouchStep = (typeof TOUCH_STEPS)[number];

/**
 * The starting daily limits per Facebook account (docs/outreach.md): how many of each step a person takes in a day.
 * The activity panel and the extension show the day's against them. Nothing stops at them, since the person takes
 * these steps on Facebook themselves.
 */
export const DAILY_LIMITS = {
  friend_request: 20,
  first_message: 15,
  follow_up: 20,
  comment: 15,
  like: 40,
} as const;
export type DailyStep = keyof typeof DAILY_LIMITS;
export const DAILY_STEPS = Object.keys(DAILY_LIMITS) as DailyStep[];

/** What the day's steps are called: on the activity panel, and in the extension. */
export const DAILY_WORDS: Readonly<
  Record<DailyStep, { readonly label: string; readonly many: string }>
> = {
  friend_request: { label: 'Friend requests', many: 'friend requests' },
  first_message: { label: 'First messages', many: 'first messages' },
  follow_up: { label: 'Follow-ups', many: 'follow-ups' },
  comment: { label: 'Comments', many: 'comments' },
  like: { label: 'Likes', many: 'likes' },
};

/**
 * Tidying the person's own friends (./tidy.ts, decisions 10 and 12): how many sent requests nobody answered the
 * extension cancels in a day, and how many friends it unfriends, each only once the person ticks them. Facebook
 * watches bulk unfriending too.
 */
export const TIDY_LIMITS = { cancel_request: 30, unfriend: 20 } as const;
export type TidyKind = keyof typeof TIDY_LIMITS;
export const TIDY_KIND_KEYS = Object.keys(TIDY_LIMITS) as [TidyKind, ...TidyKind[]];
/**
 * Tidying on its own (decision 98): the most it cancels, withdraws or unfollows in a day with nobody ticking them, and
 * the most friends it unfriends, inside the network's own tidy limits and the day's done by hand.
 */
export const OWN_TIDY_LIMITS: Readonly<Record<TidyKind, number>> = {
  cancel_request: 20,
  unfriend: 10,
};
/**
 * Friend requests the person got that the extension deletes on its own in a day (decision 121), as they chose for the
 * ones they get, halved as the rest are; with any they deleted themselves that day.
 */
export const DECLINES_PER_DAY = 30;

/**
 * After Facebook warns the person (decision 25): every daily limit is halved for a week, and friend requests are left
 * off Today's list for two days. Any warning also stops what the extension does for them for the rest of the day.
 */
export const WARNING_SLOWER_DAYS = 7;
export const WARNING_NO_REQUESTS_DAYS = 2;

/**
 * A network new to the extension (decision 96): every daily limit there is half for the first 2 weeks after the first
 * step it took or noted there for the person, and for 2 more weeks when they said the account is under a year old.
 * Before its first step there, it's new: its first day there starts at half.
 */
export const NEW_NETWORK_DAYS = 14;
export const YOUNG_ACCOUNT_DAYS = 14;

/**
 * No new friend requests (decision 97): while this many of the person's sent requests wait for an answer, on a network
 * where a request waits (not a follow network); or once their friends come within `FRIENDS_CAP_ROOM` of the
 * network's cap, 4,900 on Facebook.
 */
export const REQUESTS_WAITING_MOST = 200;
export const FRIENDS_CAP_ROOM = 100;

/** A limit as it stands: halved, but never below one, while a warning slows things down. */
export const limitNow = (most: number, slower: boolean): number =>
  slower ? Math.max(1, Math.floor(most / 2)) : most;

/**
 * The daily limits as they stand for the person: the business's, halved after a warning, on training wheels or new on
 * the network.
 */
export function dailyLimitsNow(
  slower: boolean,
  /** The business's own, each at most the starting one (decision 38). */
  business: Partial<Readonly<Record<DailyStep, number>>> = {},
): Record<DailyStep, number> {
  return Object.fromEntries(
    DAILY_STEPS.map((step) => [
      step,
      business[step] === 0
        ? 0
        : limitNow(Math.min(DAILY_LIMITS[step], business[step] ?? Infinity), slower),
    ]),
  ) as Record<DailyStep, number>;
}

/** The warning when a day's steps go past the limits: null while they're within them. */
export function pastLimitWords(
  done: Readonly<Record<DailyStep, number>>,
  limits: Readonly<Record<DailyStep, number>> = DAILY_LIMITS,
): string | null {
  const past = DAILY_STEPS.filter((step) => done[step] > limits[step]);
  if (!past.length) return null;
  const steps = past.map((step) => DAILY_WORDS[step].many);
  const listed =
    steps.length > 1 ? `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}` : steps[0];
  return `Past today’s limit for ${listed}. Slow down, so Facebook doesn’t block you.`;
}

/**
 * Where a person's own Facebook stands with someone (./friends.ts), as the Friends tab and the extension name it:
 * friends, a friend request either way, a request they turned down, or not friends.
 */
export const FRIEND_STATES = {
  friends: 'Friends',
  request_sent: 'Request sent',
  request_received: 'Asked to be friends',
  declined: 'Request deleted',
  not_friends: 'Not friends',
} as const;
export type FriendState = keyof typeof FRIEND_STATES;
export const FRIEND_STATE_KEYS = Object.keys(FRIEND_STATES) as [FriendState, ...FriendState[]];

/** The person's answer to a friend request they got, on Facebook, as the extension notes it (./friends.ts). */
export const FRIEND_ANSWERS = {
  confirm: 'Confirmed',
  delete: 'Deleted request',
} as const;
export type FriendAnswer = keyof typeof FRIEND_ANSWERS;
export const FRIEND_ANSWER_KEYS = Object.keys(FRIEND_ANSWERS) as [FriendAnswer, ...FriendAnswer[]];

/** Facebook's cap on friends: the Friends tab counts toward it. */
export const FRIENDS_CAP = 5000;
/** The most people one save of a list sends: the extension sends a longer list in parts. */
export const FRIENDS_SAVE_MOST = 500;
/** Customers with this tag in Contacts are never pitched, like those on the Don't pitch list. */
export const DONT_PITCH_TAG = 'Friend or family';

/**
 * Facebook's download file (./download.ts): the most people, and the most chats, one part of it sends, and how big a
 * part may be as sent, under the API's 256 KB. A bigger file goes in parts.
 */
export const DOWNLOAD_PEOPLE_MOST = 600;
export const DOWNLOAD_CHATS_MOST = 400;
export const DOWNLOAD_PART_BYTES = 200_000;
