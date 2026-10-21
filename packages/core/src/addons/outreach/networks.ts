/**
 * The social networks Social Outreach knows, and what each is like (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "How it fits: one add-on, a kit per network"): its name, the shape of its links and ids, what it calls a friend and
 * a friend request, how many friends it allows, and its starting daily limits. One kit a network; everything that
 * differs from one network to the next is here, and the rest of the add-on reads it. Plain values with no zod, so the
 * extension takes them as they are.
 */
import {
  DAILY_LIMITS,
  DAILY_STEPS,
  FRIENDS_CAP,
  limitNow,
  PROFILE_ID,
  THREAD_KEY,
  TIDY_LIMITS,
  USERNAME,
  type DailyStep,
  type TidyKind,
} from './limits';

/**
 * The networks it knows, in Chris's order (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md): Facebook and LinkedIn
 * work; Instagram and Alignable were looked at first (`stage`), and work now, by hand till their runners.
 */
export const PLATFORMS = {
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  alignable: 'Alignable',
} as const;
export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_KEYS = Object.keys(PLATFORMS) as [Platform, ...Platform[]];

/** What a network calls its things, in the words the add-on shows and the AI hears. */
export interface NetworkWords {
  /** Someone connected to the person: "friend", "connection". */
  readonly friend: string;
  readonly friends: string;
  /** Asking to connect: "friend request", "invitation to connect". */
  readonly friendRequest: string;
  readonly friendRequests: string;
  /** Where its one-to-one chats are: "Messenger", "LinkedIn messaging". */
  readonly messaging: string;
  /** How a message there reads, for the AI: "the way people message friends". */
  readonly messageLike: string;
}

/** The kinds on today's list a network's runner can do on its own (automation.ts `autoKinds`). */
export type RunnerKind = 'confirm' | 'warm_up' | 'friend_request' | 'comment';
/** The switches along the way a network's runner can read (network-words.ts `ALONG_TICKS`). */
export type RunnerTick = 'warmUp' | 'confirmRequests' | 'collect' | 'joinGroups' | 'watchPosts';

export interface NetworkKit {
  readonly name: string;
  /**
   * Where its build is (the plan's build order, 6: "Each starts with a look at a real account and a kit"): `working`, as
   * Facebook and LinkedIn are; or `looking`, while the extension only reads its pages, for Check <network> (decision
   * 78), and its steps are built from what that reads. A network that's looking has no day, no list for today and no
   * choices to make yet; it can be turned on, allowed in Chrome and checked.
   */
  readonly stage: 'working' | 'looking';
  /** The start of every link to its own pages, over https. */
  readonly link: RegExp;
  /** A profile's id in its links: Facebook's number, LinkedIn's member id. */
  readonly profileId: RegExp;
  /** A profile's name in its address: Facebook's username, LinkedIn's public profile name. */
  readonly username: RegExp;
  /** A chat's own id in its link. */
  readonly threadKey: RegExp;
  /** The most friends or connections it lets a person have. */
  readonly friendsCap: number;
  /** The starting daily limits per account: the most a business may allow (decision 38). */
  readonly dailyLimits: Readonly<Record<DailyStep, number>>;
  /** The most friend requests or invitations in any 7 days, beside the daily limit; null when it has no such cap. */
  readonly weeklyRequests: number | null;
  /** How many profiles the person's computer reads a day to check for good fits (decision 46). */
  readonly checksPerDay: number;
  /**
   * The most answers a day to posts asking for what the business offers, inside the daily comments: Alignable's forum,
   * where owners ask for referrals, watches for the same business answering every question (the plan: 2 a day). Null
   * where comments are the only limit.
   */
  readonly forumAnswersPerDay: number | null;
  /**
   * Whether a person writes recommendations of other businesses there (Alignable's): only by hand, for a business they
   * know (the plan's question 8). Today suggests one a day, a customer or partner of theirs, and the extension notes it
   * once it's sent.
   */
  readonly recommends: boolean;
  /**
   * On a follow network (Instagram's), a message to someone who doesn't follow the person back lands in their Requests,
   * and passes only one text till they accept it (the Instagram and Alignable plan's "The steps"): after how many days
   * without a follow-back that one short message goes (no link, no video), and at most how many of the day's first
   * messages go there. No follow-up goes in a chat they haven't answered or accepted. Null where a first message waits
   * for them to accept.
   */
  readonly requestsMessageAfterDays: number | null;
  readonly requestsMessagesPerDay: number | null;
  /** How many old requests it withdraws, and friends it removes, in a day once the person ticks them. */
  readonly tidyLimits: Readonly<Record<TidyKind, number>>;
  /**
   * What the extension's runner does there (the Instagram and Alignable plan's "steps per network"): the kinds on
   * today's list it does on its own, and the switches along the way it reads. Today marks only these as done on their
   * own, and Settings show only these switches. A network still looked at, or before its runner, does none yet.
   */
  readonly runs: { readonly auto: readonly RunnerKind[]; readonly ticks: readonly RunnerTick[] };
  readonly words: NetworkWords;
}

export const NETWORKS: Readonly<Record<Platform, NetworkKit>> = {
  facebook: {
    name: PLATFORMS.facebook,
    stage: 'working',
    link: /^https:\/\/www\.facebook\.com\//,
    profileId: PROFILE_ID,
    username: USERNAME,
    threadKey: THREAD_KEY,
    friendsCap: FRIENDS_CAP,
    dailyLimits: DAILY_LIMITS,
    weeklyRequests: null,
    checksPerDay: 40,
    forumAnswersPerDay: null,
    recommends: false,
    requestsMessageAfterDays: null,
    requestsMessagesPerDay: null,
    tidyLimits: TIDY_LIMITS,
    // auto/run.ts: requests to confirm, likes, friend requests and comments; every switch along the way.
    runs: {
      auto: ['confirm', 'warm_up', 'friend_request', 'comment'],
      ticks: ['warmUp', 'confirmRequests', 'collect', 'joinGroups', 'watchPosts'],
    },
    words: {
      friend: 'friend',
      friends: 'friends',
      friendRequest: 'friend request',
      friendRequests: 'friend requests',
      messaging: 'Messenger',
      messageLike: 'the way people message friends',
    },
  },
  linkedin: {
    name: PLATFORMS.linkedin,
    stage: 'working',
    link: /^https:\/\/www\.linkedin\.com\//,
    // A member's id as LinkedIn's links carry it (ACoAA…), and the name in /in/<this>/.
    profileId: /^[A-Za-z0-9_-]{1,64}$/,
    username: /^[A-Za-z0-9%_-]{1,100}$/,
    // A conversation's id in /messaging/thread/<this>/.
    threadKey: /^[A-Za-z0-9._=+-]{1,128}$/,
    friendsCap: 30_000,
    // The plan's starting limits (Chris, 2026-10-15): LinkedIn watches invitations closely, and a look at a profile is
    // seen by its owner.
    dailyLimits: { friend_request: 15, first_message: 15, follow_up: 20, comment: 10, like: 30 },
    weeklyRequests: 80,
    checksPerDay: 40,
    forumAnswersPerDay: null,
    recommends: false,
    requestsMessageAfterDays: null,
    requestsMessagesPerDay: null,
    // Old invitations are withdrawn after the business's wait; nobody is removed.
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    // auto/linkedin.ts: likes, invitations and comments; invitations sent to them are theirs to accept. Of the switches
    // along the way it reads the warm-up and saving connections: it joins no groups and has no hourly look.
    runs: { auto: ['warm_up', 'friend_request', 'comment'], ticks: ['warmUp', 'collect'] },
    words: {
      friend: 'connection',
      friends: 'connections',
      friendRequest: 'invitation to connect',
      friendRequests: 'invitations to connect',
      messaging: 'LinkedIn messaging',
      messageLike: 'the way people message someone they know from work',
    },
  },
  // A follow network (the plan's "The networks after LinkedIn"): follow, like, comment, then a message once they follow
  // back; else one short message after 3 days, which waits in their Requests. Instagram blocks fast, so its limits
  // start low. Its steps are built from what Check Instagram reads.
  instagram: {
    name: PLATFORMS.instagram,
    // Working from its part 12 (the app), as Alignable did before its runner, and on its own from part 14 (its runner).
    stage: 'working',
    link: /^https:\/\/www\.instagram\.com\//,
    // An account's number, and its name in instagram.com/<this>/: letters, numbers, dots and underscores.
    profileId: /^[0-9]{1,30}$/,
    username: /^[A-Za-z0-9._]{1,30}$/,
    // A conversation's id in /direct/t/<this>/.
    threadKey: /^[0-9]{1,64}$/,
    // How many accounts it lets someone follow.
    friendsCap: 7_500,
    dailyLimits: { friend_request: 20, first_message: 10, follow_up: 15, comment: 10, like: 30 },
    weeklyRequests: null,
    checksPerDay: 20,
    forumAnswersPerDay: null,
    recommends: false,
    // No follow-back in 3 days: one short message to their Requests, at most 5 of the day's 10 first messages.
    requestsMessageAfterDays: 3,
    requestsMessagesPerDay: 5,
    // Unfollowing those who didn't follow back in the business's wait (3 weeks to start), 20 a day at most; nobody
    // who follows them is removed.
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    // auto/instagram.ts (part 14): warm-ups (a look at their account and a like on one or two of their recent posts)
    // and follows. Comments wait for the person's OK each time, as they're public writing (the plan's "Anything public
    // … waits for an OK", and Alignable's answers), so `comment` isn't here, and unfollowing stays the person's ticks.
    // Of the switches along the way it reads the warm-up and the once-a-day jobs: no groups, no hourly look, and no
    // follow requests to confirm.
    runs: { auto: ['warm_up', 'friend_request'], ticks: ['warmUp', 'collect'] },
    words: {
      friend: 'follower',
      friends: 'followers',
      friendRequest: 'follow',
      friendRequests: 'follows',
      messaging: 'Instagram messages',
      messageLike: 'the way people message someone they follow',
    },
  },
  // Made for small businesses, by town (the plan): connect, message, recommend, and a forum where owners ask for
  // referrals. Close to LinkedIn in shape; little is published, so its steps are built from what Check Alignable reads.
  alignable: {
    name: PLATFORMS.alignable,
    // Working from part 3 (the app), as LinkedIn was, and on its own from part 5 (its runner).
    stage: 'working',
    link: /^https:\/\/www\.alignable\.com\//,
    profileId: /^[A-Za-z0-9_-]{1,64}$/,
    username: /^[A-Za-z0-9%_-]{1,100}$/,
    threadKey: /^[A-Za-z0-9._=+-]{1,128}$/,
    friendsCap: 10_000,
    dailyLimits: { friend_request: 15, first_message: 15, follow_up: 20, comment: 10, like: 30 },
    weeklyRequests: null,
    checksPerDay: 30,
    forumAnswersPerDay: 2,
    recommends: true,
    requestsMessageAfterDays: null,
    requestsMessagesPerDay: null,
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    // auto/alignable.ts (part 5): warm-ups (a look at their business page, and a like on a recent post of theirs when
    // it shows one) and connection requests. Comments and forum answers wait for the person's OK each time, as they're
    // public writing (the plan's question 9), and Recommend is only ever theirs. Of the switches along the way it reads
    // the warm-up and the once-a-day jobs: it joins no groups and has no hourly look.
    runs: { auto: ['warm_up', 'friend_request'], ticks: ['warmUp', 'collect'] },
    words: {
      friend: 'connection',
      friends: 'connections',
      friendRequest: 'connection request',
      friendRequests: 'connection requests',
      messaging: 'Alignable messages',
      messageLike: 'the way local business owners message each other',
    },
  },
};

/** The networks past their look: all four now. */
export const WORKING_PLATFORMS: readonly Platform[] = PLATFORM_KEYS.filter(
  (p) => NETWORKS[p].stage === 'working',
);

/** Whether a network is still being looked at: Check <network> reads it, and nothing else runs there yet. */
export const isLooking = (platform: Platform): boolean => NETWORKS[platform].stage === 'looking';

/**
 * Whether the extension works a network on its own: its runner takes steps there and sends what's OK'd. Until it does
 * (each network before its runner, as Instagram was till its part 14), every step and message there is the person's
 * own, which the extension notes.
 */
export const runsOnItsOwn = (platform: Platform): boolean =>
  NETWORKS[platform].runs.auto.length > 0;

/**
 * A network's daily limits as they stand for the person: the business's own on that network, each at most the
 * network's starting one, halved (never below one) after a warning there or on training wheels there.
 */
export function networkLimitsNow(
  platform: Platform,
  slower: boolean,
  business: Partial<Readonly<Record<DailyStep, number>>> = {},
): Record<DailyStep, number> {
  const starting = NETWORKS[platform].dailyLimits;
  return Object.fromEntries(
    DAILY_STEPS.map((step) => [
      step,
      business[step] === 0
        ? 0
        : limitNow(Math.min(starting[step], business[step] ?? Infinity), slower),
    ]),
  ) as Record<DailyStep, number>;
}

/** A network's name after "a" or "an", as it's said: "a LinkedIn page", "an Instagram page". */
export const withArticle = (name: string): string =>
  `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;

/** The network a link is on, or null when it's on none the add-on knows. */
export function networkOfLink(url: string): Platform | null {
  return PLATFORM_KEYS.find((p) => NETWORKS[p].link.test(url)) ?? null;
}

/** Whether a value fits some network's shape for it: what a save takes before it knows which network is meant. */
export const fitsAnyNetwork = (
  shape: 'profileId' | 'username' | 'threadKey',
  value: string,
): boolean => PLATFORM_KEYS.some((p) => NETWORKS[p][shape].test(value));

/**
 * Why a profile as a page showed it isn't one on the network it was sent for, or null when it is: its link on
 * another network's pages, or an id or name another network's shape. Saves refuse it rather than keep a profile on
 * the wrong network.
 */
export function profileMisfit(
  platform: Platform,
  profile: { readonly id: string | null; readonly username: string | null; readonly url: string },
): string | null {
  const kit = NETWORKS[platform];
  if (!kit.link.test(profile.url))
    return `That profile’s address isn’t ${withArticle(kit.name)} one. Send the ${kit.name} address the page links to.`;
  if (profile.id !== null && !kit.profileId.test(profile.id))
    return `That isn’t ${withArticle(kit.name)} profile’s id. Send the id its ${kit.name} links show.`;
  if (profile.username !== null && !kit.username.test(profile.username))
    return `That isn’t ${withArticle(kit.name)} profile’s name. Send the name in its ${kit.name} address.`;
  return null;
}

/**
 * A prompt's or a line's Facebook words in a network's own: its name, its messaging, what it calls a friend and a
 * friend request. Facebook's come back as written. Only for the add-on's own words, never for what a person wrote: a
 * name or a message passes through untouched only because it isn't given to this.
 */
export function inNetworkWords(text: string, platform: Platform): string {
  if (platform === 'facebook') return text;
  const kit = NETWORKS[platform];
  const w = kit.words;
  return text
    .replace(
      /\b(a|A) friend request\b/g,
      (_, a: string) => `${an(a, w.friendRequest)} ${w.friendRequest}`,
    )
    .replace(/Facebook Messenger|Messenger/g, w.messaging)
    .replace(/Facebook/g, kit.name)
    .replace(/\bfriend requests\b/g, w.friendRequests)
    .replace(/\bfriend request\b/g, w.friendRequest)
    .replace(/\bFriend requests\b/g, cap(w.friendRequests))
    .replace(/\bFriend request\b/g, cap(w.friendRequest))
    .replace(/\bfriends\b/g, w.friends)
    .replace(/\bfriend\b/g, w.friend)
    .replace(/\bFriends\b/g, cap(w.friends))
    .replace(/\bFriend\b/g, cap(w.friend));
}

const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "a" or "an" before a word, keeping the capital of the one it replaces. */
const an = (was: string, word: string) => {
  const article = /^[aeiou]/i.test(word) ? 'an' : 'a';
  return was === 'A' ? cap(article) : article;
};
