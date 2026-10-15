/**
 * The social networks Social Outreach knows, and what each is like (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md,
 * "How it fits: one add-on, a kit per network"): its name, the shape of its links and ids, what it calls a friend and
 * a friend request, how many friends it allows, and its starting daily limits. One kit a network; everything that
 * differs from one network to the next is here, and the rest of the add-on reads it. Plain values with no zod, so the
 * extension takes them as they are.
 */
import {
  DAILY_LIMITS,
  FRIENDS_CAP,
  PROFILE_ID,
  THREAD_KEY,
  TIDY_LIMITS,
  USERNAME,
  type DailyStep,
  type TidyKind,
} from './limits';

/** The networks it knows. Facebook works; LinkedIn is being built. */
export const PLATFORMS = { facebook: 'Facebook', linkedin: 'LinkedIn' } as const;
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
}

export interface NetworkKit {
  readonly name: string;
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
  /** How many old requests it withdraws, and friends it removes, in a day once the person ticks them. */
  readonly tidyLimits: Readonly<Record<TidyKind, number>>;
  readonly words: NetworkWords;
}

export const NETWORKS: Readonly<Record<Platform, NetworkKit>> = {
  facebook: {
    name: PLATFORMS.facebook,
    link: /^https:\/\/www\.facebook\.com\//,
    profileId: PROFILE_ID,
    username: USERNAME,
    threadKey: THREAD_KEY,
    friendsCap: FRIENDS_CAP,
    dailyLimits: DAILY_LIMITS,
    weeklyRequests: null,
    checksPerDay: 40,
    tidyLimits: TIDY_LIMITS,
    words: {
      friend: 'friend',
      friends: 'friends',
      friendRequest: 'friend request',
      friendRequests: 'friend requests',
      messaging: 'Messenger',
    },
  },
  linkedin: {
    name: PLATFORMS.linkedin,
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
    // Old invitations are withdrawn after the business's wait; nobody is removed.
    tidyLimits: { cancel_request: 20, unfriend: 0 },
    words: {
      friend: 'connection',
      friends: 'connections',
      friendRequest: 'invitation to connect',
      friendRequests: 'invitations to connect',
      messaging: 'LinkedIn messaging',
    },
  },
};

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
    return `That profile’s address isn’t a ${kit.name} one. Send the ${kit.name} address the page links to.`;
  if (profile.id !== null && !kit.profileId.test(profile.id))
    return `That isn’t a ${kit.name} profile’s id. Send the id its ${kit.name} links show.`;
  if (profile.username !== null && !kit.username.test(profile.username))
    return `That isn’t a ${kit.name} profile’s name. Send the name in its ${kit.name} address.`;
  return null;
}
