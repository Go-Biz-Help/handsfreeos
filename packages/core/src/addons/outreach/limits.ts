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

/** The steps the extension notes as the person takes them on Facebook (./activity.ts), as the panel names them. */
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

/** The warning when a day's steps go past the limits: null while they're within them. */
export function pastLimitWords(done: Readonly<Record<DailyStep, number>>): string | null {
  const past = DAILY_STEPS.filter((step) => done[step] > DAILY_LIMITS[step]);
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

/** Facebook's cap on friends: the Friends tab counts toward it. */
export const FRIENDS_CAP = 5000;
/** The most people one save of a list sends: the extension sends a longer list in parts. */
export const FRIENDS_SAVE_MOST = 500;
/** Customers with this tag in Contacts are never pitched, like those on the Don't pitch list. */
export const DONT_PITCH_TAG = 'Friend or family';
