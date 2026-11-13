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
 * work; Instagram and Alignable were looked at first (`stage`), and work now, by hand till their runners; Threads and X
 * work from decision 163, built from their sites' usual buttons and tuned from Check Threads and Check X.
 */
export const PLATFORMS = {
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  alignable: 'Alignable',
  threads: 'Threads',
  x: 'X',
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
   * The most it reads a day while the day's first messages need more good fits (decision 126, answer 4a): ./goal.ts
   * `GOAL_AHEAD_DAYS` of them not ready ahead. Spread through the working hours, a batch at a time.
   */
  readonly checksMost: number;
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
   * Whether its runner looks at hashtags, and the places their posts were tagged at, for posts and who wrote them
   * (Instagram's, its part 15): a few a day, made from the playbooks' area and words (./posts.ts `postLooks`).
   */
  readonly hashtags: boolean;
  /**
   * Whether it's a follow network (Instagram's): a follow is its friend request, and their follow back is its
   * accepting. Nothing is ever written to someone there who doesn't follow the person (decision 159, the owner: "them
   * following us is the trigger to inbox them"), as a message to them lands in their Requests, never their inbox: their
   * follow-back is what starts the first message, as accepting does on every other network.
   */
  readonly follows: boolean;
  /**
   * On a follow network (Instagram's), how many accounts the person followed the extension looks at a day to see who
   * follows them back (the owner, 21 Oct 2026): their own account says so ("Follows you", Follow Back), so the
   * follow-backs never wait on reading the whole list of their followers. Its own count, beside `checksPerDay`: a look
   * reads one account they follow already, sends nothing for the AI and presses nothing. Null where a list of friends
   * or connections says who accepted.
   */
  readonly followBackLooksPerDay: number | null;
  /**
   * How many people found by topic (decision 92, ./finds.ts: a good post's writer, likers and commenters, search
   * results and group members) the person's computer reads a day for the AI's check, before anything is done for them;
   * halved on training wheels and for a week after a warning there. Only a good check puts them on Today. The number
   * here is where a business starts: its own setting, 10 to 100, takes its place (decision 116, `FOUND_CHECKS`,
   * ./ops/common.ts `foundChecksOf`). Null where people found are weighed by the words they show (Facebook's group
   * members, `bestFit`).
   */
  readonly foundChecksPerDay: number | null;
  /**
   * Whether those reads come out of the network's `checksPerDay` (LinkedIn's settled 40 profiles read, found people
   * first) rather than beside it: the network's own limit doesn't grow.
   */
  readonly foundShareReads: boolean;
  /** How many good posts a day have who liked and commented on them read (decision 92); null where none do. */
  readonly postPeoplePerDay: number | null;
  /**
   * How many warm-ups a day view someone's story and like it, where the network has stories (Instagram's, decision
   * 111): each counts as one of the warm-up's likes; null where none do.
   */
  readonly storyLikesPerDay: number | null;
  /**
   * How a comment the AI drafts for a good post goes (decision 92): `hold`, through `sends` like a message, waiting
   * for the person's OK at first (Instagram's, Alignable's, and LinkedIn's from decision 102); `never`, never held as a
   * comment there (Facebook's are the person's).
   */
  readonly commentsWait: 'never' | 'hold';
  /**
   * How many groups the person's computer asks to join a day while people left to reach in them run low (decisions 31
   * and 92), 1 after a warning there; null where it joins none.
   */
  readonly joinsPerDay: number | null;
  /** How many old requests it withdraws, and friends it removes, in a day once the person ticks them. */
  readonly tidyLimits: Readonly<Record<TidyKind, number>>;
  /**
   * Whether anything is ever written to someone in their messages there (decision 163): every network but Threads and
   * X, whose outreach is comments, likes and follows till their messages come in a part of their own. Where it's false
   * there's no first message, follow-up, reply, Reconnect or partner's ask, and no chat is read.
   */
  readonly messages: boolean;
  /**
   * Its post search through the day (decision 163, the owner's "every hour"): in the working hours, every `everyMinutes`,
   * `perLook` of the playbooks' phrases for it in turn, newest first, keeping only posts under `newestHours` old for the
   * AI's check. Null where posts are looked for once a day (`posts` among the once-a-day jobs).
   */
  readonly postSearch: {
    readonly everyMinutes: number;
    readonly perLook: number;
    readonly newestHours: number;
  } | null;
  /**
   * The most characters a comment there takes, where the network counts them (X's 280 for an account that doesn't
   * pay, Threads' 500); null where words are the limit (`COMMENT_WORDS_MOST` in ./today.ts) or none.
   */
  readonly commentCharsMost: number | null;
  /**
   * What the extension's runner does there (the Instagram and Alignable plan's "steps per network"): the kinds on
   * today's list it does on its own, and the switches along the way it reads. Today marks only these as done on their
   * own, and Settings show only these switches. A network still looked at, or before its runner, does none yet.
   */
  readonly runs: { readonly auto: readonly RunnerKind[]; readonly ticks: readonly RunnerTick[] };
  readonly words: NetworkWords;
}

/** The first build of the extension with Threads' and X's kits (decision 163): an older one works neither. */
export const THREADS_X_SINCE = '0.137.0';

/**
 * Threads' and X's kits (decision 163), alike but for their addresses, ids, caps and comments' length: a follow is the
 * request and a follow-back the accepting, as on Instagram; the owner's 3b, 30 comments and 80 likes a day, halved for a
 * new account and for a week after a warning; 20 follows a day; comments wait for an OK at first, as Instagram's and
 * LinkedIn's do; the posts its search finds every hour bring the people checked; and no messages, so no first message
 * or follow-up limit. Its runner looks at their account and likes a post or two, follows, and unfollows once the wait
 * ends without a follow-back (decision 161); comments go through `sends`, and it joins no groups.
 */
function followNetwork(kit: {
  readonly name: string;
  readonly link: RegExp;
  readonly profileId: RegExp;
  readonly username: RegExp;
  readonly threadKey: RegExp;
  readonly friendsCap: number;
  readonly commentCharsMost: number;
  readonly messaging: string;
}): NetworkKit {
  return {
    name: kit.name,
    stage: 'working',
    link: kit.link,
    profileId: kit.profileId,
    username: kit.username,
    threadKey: kit.threadKey,
    friendsCap: kit.friendsCap,
    dailyLimits: { friend_request: 20, first_message: 0, follow_up: 0, comment: 30, like: 80 },
    weeklyRequests: null,
    // Its followers aren't checked yet: its people come from the posts its search finds.
    checksPerDay: 0,
    checksMost: 0,
    forumAnswersPerDay: null,
    recommends: false,
    hashtags: false,
    follows: true,
    // Who follows them back, from the accounts they followed, 30 a day at most, as on Instagram.
    followBackLooksPerDay: 30,
    // Who wrote a good post and who replied to one, 30 a day, from 5 good posts' repliers a day.
    foundChecksPerDay: 30,
    foundShareReads: false,
    postPeoplePerDay: 5,
    storyLikesPerDay: null,
    commentsWait: 'hold',
    joinsPerDay: null,
    // Unfollowing who didn't follow back in the warm-up's wait, 20 a day at most; nobody who follows them is removed.
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    messages: false,
    // Every hour in the working hours (the owner's "every hour"), 2 phrases a look, posts under 2 days old.
    postSearch: { everyMinutes: 60, perLook: 2, newestHours: 48 },
    commentCharsMost: kit.commentCharsMost,
    runs: { auto: ['warm_up', 'friend_request'], ticks: ['warmUp', 'collect'] },
    words: {
      friend: 'follower',
      friends: 'followers',
      friendRequest: 'follow',
      friendRequests: 'follows',
      messaging: kit.messaging,
      messageLike: 'the way people message someone they follow',
    },
  };
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
    checksMost: 150,
    forumAnswersPerDay: null,
    recommends: false,
    hashtags: false,
    follows: false,
    followBackLooksPerDay: null,
    // Its group members are weighed by the words they show (decision 92 leaves Facebook as it was).
    foundChecksPerDay: null,
    foundShareReads: false,
    postPeoplePerDay: null,
    storyLikesPerDay: null,
    commentsWait: 'never',
    joinsPerDay: 3,
    tidyLimits: TIDY_LIMITS,
    messages: true,
    postSearch: null,
    commentCharsMost: null,
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
    checksMost: 150,
    forumAnswersPerDay: null,
    recommends: false,
    hashtags: false,
    follows: false,
    followBackLooksPerDay: null,
    // People found by its post search are checked inside the 40 profiles read, found people first (decision 92), from
    // 5 good posts' reactors and commenters a day. Its comments wait for the person's OK at first, as Instagram's and
    // Alignable's do (decision 102, from 0.99.0: `commentSendsOn`); it joins no groups.
    foundChecksPerDay: 30,
    foundShareReads: true,
    postPeoplePerDay: 5,
    storyLikesPerDay: null,
    commentsWait: 'hold',
    joinsPerDay: null,
    // Old invitations are withdrawn after the business's wait; nobody is removed.
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    messages: true,
    postSearch: null,
    commentCharsMost: null,
    // auto/linkedin.ts: likes and invitations, and from decision 136 accepting the invitations they get, as they
    // picked and the AI says (on Received invitations); comments go through `sends`. Of the switches along the way it
    // reads the warm-up and saving connections: it joins no groups and has no hourly look.
    runs: { auto: ['confirm', 'warm_up', 'friend_request'], ticks: ['warmUp', 'collect'] },
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
  // back, and never before (decision 159). Instagram blocks fast, so its limits start low. Its steps are built from
  // what Check Instagram reads.
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
    // Likes and comments raised from 30 and 10 for the warm-ups while people decide whether to follow back (decision
    // 161, the owner's 2b): still halved for a new account and for a week after a warning.
    dailyLimits: { friend_request: 20, first_message: 10, follow_up: 15, comment: 35, like: 80 },
    weeklyRequests: null,
    checksPerDay: 20,
    checksMost: 60,
    forumAnswersPerDay: null,
    recommends: false,
    hashtags: true,
    // Never a message to someone who doesn't follow them back (decision 159): their follow-back is the trigger.
    follows: true,
    // Who follows them back, from the accounts they followed, 30 a day at most (the owner, 21 Oct 2026).
    followBackLooksPerDay: 30,
    // People found under its hashtags, 30 a day beside the 20 followers checked, from 5 good posts' likers and
    // commenters a day; comments wait for an OK at first (decision 92).
    foundChecksPerDay: 30,
    foundShareReads: false,
    postPeoplePerDay: 5,
    // A look at their story and a like on it, as one of the warm-up's likes, 20 a day at most (decision 111).
    storyLikesPerDay: 20,
    commentsWait: 'hold',
    joinsPerDay: null,
    // Unfollowing those who didn't follow back in the business's wait (3 weeks to start), 20 a day at most; nobody
    // who follows them is removed.
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    messages: true,
    postSearch: null,
    commentCharsMost: null,
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
    checksMost: 60,
    forumAnswersPerDay: 2,
    recommends: true,
    hashtags: false,
    follows: false,
    followBackLooksPerDay: null,
    // Businesses its search and its groups found, 30 a day beside its 30 reads (the build's choice, decision 92), and
    // from 0.108.0 who liked and answered 5 good posts a day (decision 116). Comments wait for an OK at first, and it
    // joins up to 3 good groups a day.
    foundChecksPerDay: 30,
    foundShareReads: false,
    postPeoplePerDay: 5,
    storyLikesPerDay: null,
    commentsWait: 'hold',
    joinsPerDay: 3,
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    messages: true,
    postSearch: null,
    commentCharsMost: null,
    // auto/alignable.ts (part 5): warm-ups (a look at their business page, and a like on a recent post of theirs when
    // it shows one) and connection requests. Comments and forum answers wait for the person's OK, as they're public
    // writing (the plan's question 9, decision 92), and Recommend is only ever theirs. Of the switches along the way it
    // reads the warm-up, the once-a-day jobs and joining groups (decision 92): it has no hourly look. From decision 136
    // it accepts the connection requests they get too, as they picked and the AI says (on My Network's Requests).
    runs: {
      auto: ['confirm', 'warm_up', 'friend_request'],
      ticks: ['warmUp', 'collect', 'joinGroups'],
    },
    words: {
      friend: 'connection',
      friends: 'connections',
      friendRequest: 'connection request',
      friendRequests: 'connection requests',
      messaging: 'Alignable messages',
      messageLike: 'the way local business owners message each other',
    },
  },
  // Follow networks made of posts (decision 163): the work is finding posts on the business's topic every hour and
  // commenting, a like on the good ones, and a follow and decision 161's visits for the good fits found by them, then
  // an unfollow once the wait ends without a follow-back. No messages yet (`messages: false`). Built from the sites'
  // usual buttons and tuned from Check Threads and Check X.
  threads: followNetwork({
    name: PLATFORMS.threads,
    // threads.com since 2025; threads.net still opens it.
    link: /^https:\/\/www\.threads\.(?:com|net)\//,
    profileId: /^[0-9]{1,30}$/,
    // An Instagram username: letters, numbers, dots and underscores, in threads.com/@<this>.
    username: /^[A-Za-z0-9._]{1,30}$/,
    threadKey: /^[0-9]{1,64}$/,
    // Its accounts follow up to Instagram's 7,500.
    friendsCap: 7_500,
    commentCharsMost: 500,
    messaging: 'Threads messages',
  }),
  x: followNetwork({
    name: PLATFORMS.x,
    // x.com, and twitter.com, which sends to it.
    link: /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//,
    profileId: /^[0-9]{1,30}$/,
    // A handle in x.com/<this>: letters, numbers and underscores, 15 at most.
    username: /^[A-Za-z0-9_]{1,15}$/,
    // A conversation's id in /messages/<this>: two account numbers joined by a dash.
    threadKey: /^[0-9-]{1,64}$/,
    // X stops a new account's follows at 5,000 till it has more followers.
    friendsCap: 5_000,
    // What an account that doesn't pay can post in one go (X Premium's longer posts are left alone).
    commentCharsMost: 280,
    messaging: 'X messages',
  }),
};

/** The follow networks (Instagram's): a follow is the request, and their follow-back the accepting (decision 159). */
export const FOLLOW_PLATFORMS: readonly Platform[] = PLATFORM_KEYS.filter(
  (p) => NETWORKS[p].follows,
);

/** The networks past their look: all six now. */
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
 * Whether the extension answers the requests the person gets there on its own (decisions 30, 121 and 136): the runners
 * on Facebook, LinkedIn and Alignable confirm them, and delete them as the person picks; Instagram's are the person's.
 */
export const answersRequests = (platform: Platform): boolean =>
  NETWORKS[platform].runs.auto.includes('confirm');

/**
 * Whether groups are the person's to work on a network (decision 48 on Facebook, decision 92 on Alignable): its runner
 * reads them and can ask to join them, so the person picks between joining more and only their own (decision 148).
 * Instagram has no groups, and LinkedIn's are too quiet to work.
 */
export const joinsGroups = (platform: Platform): boolean =>
  NETWORKS[platform].runs.ticks.includes('joinGroups');

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
      business[step] === 0 || starting[step] === 0
        ? 0
        : limitNow(Math.min(starting[step], business[step] ?? Infinity), slower),
    ]),
  ) as Record<DailyStep, number>;
}

/** A network's name after "a" or "an", as it's said: "a LinkedIn page", "an Instagram page", "an X page". */
export const withArticle = (name: string): string =>
  `${/^(?:[aeiou]|x$)/i.test(name) ? 'an' : 'a'} ${name}`;

/** Whether anything is ever written to someone in their messages on a network (decision 163): not on Threads or X. */
export const messagesOn = (platform: Platform): boolean => NETWORKS[platform].messages;

/** The networks where people are messaged: every one but Threads and X (decision 163). */
export const MESSAGE_PLATFORMS: readonly Platform[] = PLATFORM_KEYS.filter(
  (p) => NETWORKS[p].messages,
);

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
