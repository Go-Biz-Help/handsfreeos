/**
 * Social Outreach's networks on screen (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Networks in the app";
 * docs/outreach.md, "Each network is in the app"): which networks a person works, a network's own words wherever a
 * screen says one ("connection" or "friend", "invitation to connect" or "friend request", "LinkedIn messaging" or
 * "Messenger"), and the words for turning a network on, the business's say, Today's strip, the network on each row,
 * Results by network, the playbook's networks step and the setup's. One copy for the web and the phone.
 *
 * A network is shown by its name, never a logo (Chris). What differs from one network to the next is data here, keyed
 * by network, or the kit's own words (./networks.ts), never an `if`.
 *
 * Plain words, short sentences, curly apostrophes. Browser-safe and pure.
 */
import { TOUCHED_POSTS_WORDS } from './activity';
import { askNameOn, TIDY_ASK_KINDS, TIDY_PACE_WORDS } from './asks';
import {
  SENDING_MODES,
  TIDY_MODE_KEYS,
  tidyModeOn,
  type AutomationSettings,
  type NetworkChoices,
  type SendingMode,
  type TidyMode,
} from './automation';
import { DAILY_WORDS, OWN_TIDY_LIMITS, type DailyStep, type TidyKind } from './limits';
import {
  inNetworkWords,
  isLooking,
  networkOfLink,
  NETWORKS,
  PLATFORM_KEYS,
  PLATFORMS,
  withArticle,
  WORKING_PLATFORMS,
  type Platform,
  type RunnerTick,
} from './networks';
import { COMMENT_HOLD_WORDS } from './sends';
import { TODAY_KINDS, type TodayItem, type TodayKind } from './today';
import { messengerChatUrl } from './waiting-words';
import { OUTREACH_WORDS as W } from './words';

/** The networks a filter offers: every one, then each network that works (one still looked at has nothing to show). */
export const NETWORK_FILTERS = ['all', ...WORKING_PLATFORMS] as const;
export type NetworkFilter = (typeof NETWORK_FILTERS)[number];

/** A network named in an address (`?net=`), or null when it names none. */
export const readNetwork = (value: string | null | undefined): Platform | null =>
  PLATFORM_KEYS.find((p) => p === value) ?? null;

/**
 * The networks a person works now, in the kit's order: those they turned on, and the business allows. Settings read
 * through `withinRules` already have a network the business stopped allowing off.
 */
export function networksOn(
  settings: Pick<AutomationSettings, 'networks'>,
  allowed: readonly Platform[] = PLATFORM_KEYS,
): Platform[] {
  return PLATFORM_KEYS.filter((p) => settings.networks[p].on && allowed.includes(p));
}

/**
 * The networks Today shows: those the person works, or Facebook's alone when they work none (its Start my day then
 * says it's off, and where to turn it on). A network still looked at (decision 78) has no day yet, so isn't among them.
 */
export function networksShown(
  settings: Pick<AutomationSettings, 'networks'>,
  allowed: readonly Platform[] = PLATFORM_KEYS,
): Platform[] {
  const on = networksOn(settings, allowed).filter((p) => !isLooking(p));
  return on.length ? on : [PLATFORM_KEYS[0]];
}

/** The network Today opens on: the one asked for when the person works it, else the first they work. */
export const networkShown = (shown: readonly Platform[], asked: Platform | null): Platform =>
  asked && shown.includes(asked) ? asked : (shown[0] ?? PLATFORM_KEYS[0]);

/**
 * A person's settings with one network turned on or off, or its choices changed. Facebook's choices are the settings'
 * own fields (`choicesFor`); any other network's are in `networks`.
 */
export function withNetwork(
  settings: AutomationSettings,
  platform: Platform,
  change: Partial<NetworkChoices>,
): AutomationSettings {
  const { on, young, tidy, ...choices } = change;
  // As `choicesFor` reads them: Facebook's are the settings' own fields, but for its switch, its account's age and its
  // tidying, kept beside them.
  const own = platform === 'facebook';
  const networks = {
    ...settings.networks,
    [platform]: {
      ...settings.networks[platform],
      ...(on === undefined ? {} : { on }),
      ...(young === undefined ? {} : { young }),
      ...(tidy === undefined ? {} : { tidy }),
      ...(own ? {} : choices),
    },
  } as AutomationSettings['networks'];
  return own ? { ...settings, ...choices, networks } : { ...settings, networks };
}

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const an = (s: string) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`;

/** What each network calls what its kit's words don't say, as the screens say it. */
interface MoreWords {
  /** Today's step that says yes to someone's request to connect: "Confirm their request". */
  readonly confirm: string;
  /** Today's step that asks to connect, where "Send a friend request" doesn't fit: "Follow them" on Instagram. */
  readonly request?: string;
  /** The Friends tab's ask to save their list, where "Save my friends list" doesn't fit: "Save my followers". */
  readonly saveList?: string;
  /** Where its one-to-one chats open on the web, from a chat's id. */
  readonly chatUrl: (threadKey: string) => string;
  /** Along the way's switches, in its words: what each does, and a line about it. */
  readonly ticks: Readonly<Record<AlongTick, readonly [string, string]>>;
  /** The playbook's networks step: where it looks for people there. */
  readonly where: string;
  /**
   * Whether Today has its helpful post (decision 50): written for one of the person's groups on Facebook, for the
   * person's own feed on LinkedIn, and once a week for their own account on Instagram and Alignable (decision 109).
   */
  readonly helpful: boolean;
  /** Under the helpful post's choice on the network's page in Settings: what the AI writes there, and where it goes. */
  readonly postingAbout: string;
  /**
   * Tidying up's old requests: what they're called, its button, what's done, why it matters there, and the word for
   * when each was sent ("sent", "followed"); with the line about them when "Sent more than … and not answered" doesn't
   * fit (Instagram's unfollowing).
   */
  readonly oldRequests: {
    readonly title: string;
    readonly button: string;
    readonly done: string;
    readonly why: string;
    readonly since?: string;
    readonly about?: (weeks: string) => string;
    /** Tidying them on its own (decision 98): the choice that does it, and what it does once a day. */
    readonly own: { readonly pick: string; readonly does: string; readonly never?: string };
  };
}

/** The switches along the way, each network's own (`NetworkChoices`). */
export const ALONG_TICKS = [
  'warmUp',
  'confirmRequests',
  'collect',
  'joinGroups',
  'watchPosts',
] as const satisfies readonly (keyof NetworkChoices & RunnerTick)[];
export type AlongTick = (typeof ALONG_TICKS)[number];

const MORE: Readonly<Record<Platform, MoreWords>> = {
  facebook: {
    confirm: TODAY_KINDS.confirm,
    chatUrl: (key) => messengerChatUrl(key)!,
    ticks: {
      warmUp: W.ticks.warmUp,
      confirmRequests: W.ticks.confirmRequests,
      collect: W.ticks.collect,
      joinGroups: W.ticks.joinGroups,
      watchPosts: W.ticks.watchPosts,
    },
    where: 'In the groups they’re in, found with the words below.',
    helpful: true,
    postingAbout: W.abouts.posting,
    oldRequests: {
      title: 'Old friend requests',
      button: 'Cancel the ticked requests',
      done: 'requests cancelled',
      why: 'Facebook pauses your requests when too many wait.',
      own: {
        pick: 'Cancel old friend requests',
        does: 'cancels friend requests nobody answered in your business’s wait',
      },
    },
  },
  linkedin: {
    confirm: 'Accept their invitation',
    chatUrl: (key) => `https://www.linkedin.com/messaging/thread/${encodeURIComponent(key)}/`,
    ticks: {
      warmUp: [
        'Look at their profile and like a post a day before each invitation',
        'Invitations go with no note: the look and the like do the work a note would.',
      ],
      confirmRequests: [
        'Accept invitations from people who fit a playbook',
        'The rest wait for you.',
      ],
      // Since decision 92 it also reads who reacted to and commented on the good posts, and checks them.
      collect: [
        'Once a day, first: check invitations, find posts and read my chats',
        'These fill the list it works from. It searches posts with your playbooks’ words, reads who reacted to and commented on the good ones, and checks those people and your connections for good fits, inside its 40 profile reads a day.',
      ],
      joinGroups: [
        'Join good groups when my groups run low',
        'LinkedIn groups are quiet, so it joins few, and only ones that fit your playbook.',
      ],
      watchPosts: [
        'Look for new posts asking for what I offer, every hour or two',
        'In your working hours, it searches LinkedIn’s newest posts for your playbook’s words. When one asks for what you offer, your phone hears at once and it goes to the top of your list.',
      ],
    },
    where:
      'In posts asking for what you offer, found with LinkedIn’s search, and among your connections.',
    helpful: true,
    postingAbout:
      'Once a day the AI writes a post that helps the people you want to reach, for your own LinkedIn feed: never selling. Who puts it up?',
    oldRequests: {
      title: 'Old invitations',
      button: 'Withdraw the ticked invitations',
      done: 'invitations withdrawn',
      why: 'LinkedIn limits how many invitations can wait, so withdrawing old ones makes room for new ones.',
      own: {
        pick: 'Withdraw old invitations',
        does: 'withdraws invitations nobody answered in your business’s wait',
      },
    },
  },
  // A follow network: a follow goes at once, a follow-back is the accepting, and tidying unfollows (the Instagram and
  // Alignable plan's question 5). Its runner (part 14) reads the warm-up and the once-a-day jobs.
  instagram: {
    confirm: 'Confirm their follow request',
    request: 'Follow them',
    saveList: 'Save my followers',
    chatUrl: (key) => `https://www.instagram.com/direct/t/${encodeURIComponent(key)}/`,
    ticks: {
      warmUp: [
        'Like one or two of their posts a day before following them',
        'A like first makes a follow feel less out of the blue.',
      ],
      confirmRequests: [
        'Confirm follow requests from people who fit a playbook',
        'The rest wait for you.',
      ],
      collect: [
        'Once a day, first: save my newest followers, and read my messages and notifications',
        'These fill the list it works from: whoever followed you, or liked or commented on your posts, is a warm lead. It looks at the accounts you followed to see who followed you back, checks your followers for good fits, looks at your playbooks’ hashtags for posts, reads who liked and commented on the good ones and checks them for good fits, and looks for partners with Instagram’s search, too.',
      ],
      joinGroups: ['Join good groups when my groups run low', 'Instagram has no groups to join.'],
      watchPosts: [
        'Look for new posts asking for what I offer, every hour or two',
        'In your working hours, it looks at your playbook’s hashtags for posts asking for what you offer.',
      ],
    },
    where: 'In hashtags, places, and the followers of accounts like yours.',
    helpful: true,
    postingAbout:
      'Once a week the AI writes a post that helps the people you want to reach, and says what picture to take for it: never selling. You take the picture and post it from Instagram on your phone.',
    // Unfollow, slowly (the plan's question 5): people who didn't follow back in the business's wait, 20 a day at most.
    oldRequests: {
      title: 'Not following you back',
      button: 'Unfollow the ticked',
      done: 'unfollowed',
      why: 'Unfollowing them slowly keeps you well under Instagram’s cap of 7,500 you can follow.',
      since: 'followed',
      about: (weeks) =>
        `Followed more than ${weeks} ago and not following you back. Never anyone who wrote back, a customer, or anyone you followed before HandsFreeOS saw it.`,
      own: {
        pick: 'Unfollow who didn’t follow back',
        does: 'unfollows people who didn’t follow you back in your business’s wait',
        never: 'Never anyone who wrote back, or a customer.',
      },
    },
  },
  alignable: {
    confirm: 'Accept their connection request',
    // A chat is kept by the other business's id, as Alignable's own Message link opens it.
    chatUrl: (key) =>
      `https://www.alignable.com/biz/conversations?with_business_id=${encodeURIComponent(key)}`,
    ticks: {
      warmUp: [
        'Look at their profile and like a post before each connection request',
        'A look and a like first make a request feel less out of the blue.',
      ],
      confirmRequests: [
        'Accept connection requests from people who fit a playbook',
        'The rest wait for you.',
      ],
      // Since decision 92 it also searches for businesses like the person's clients, and reads their groups.
      collect: [
        'Once a day, first: check connection requests, read my messages and my town’s posts, search for businesses like your clients, and read my groups',
        'These fill the list it works from. It checks your connections, and the businesses it finds, for good fits, and looks for partners, too.',
      ],
      // Shown since decision 92: Alignable's groups go through the same pipeline as Facebook's.
      joinGroups: [
        'Join good groups when my groups run low',
        'Your own groups come first. When the people found in them run low, it finds groups for your niche and area, and joins up to 3 good ones a day.',
      ],
      watchPosts: [
        'Look for new questions asking for what I offer, every hour or two',
        'In your working hours, it looks at Alignable’s forum for owners asking for what you offer.',
      ],
    },
    where: 'In your town’s community, and the forum where owners ask for referrals.',
    helpful: true,
    postingAbout:
      'Once a week the AI writes a post that helps the local owners you want to reach, for your own Alignable profile: never selling. Who puts it up?',
    oldRequests: {
      title: 'Old connection requests',
      button: 'Withdraw the ticked requests',
      done: 'requests withdrawn',
      why: 'Old requests that were never answered are best withdrawn.',
      own: {
        pick: 'Withdraw old connection requests',
        does: 'withdraws connection requests nobody answered in your business’s wait',
      },
    },
  },
};

/** The daily steps' names on a network: "Invitations to connect" on LinkedIn, "Friend requests" on Facebook. */
export function dailyWordsOn(
  platform: Platform,
): Readonly<Record<DailyStep, { readonly label: string; readonly many: string }>> {
  const w = NETWORKS[platform].words;
  return {
    ...DAILY_WORDS,
    friend_request: { label: cap(w.friendRequests), many: w.friendRequests },
  };
}

/** Today's kinds on a network: "Send an invitation to connect" and "Accept their invitation" on LinkedIn. */
export function todayKindsOn(platform: Platform): Readonly<Record<TodayKind, string>> {
  return {
    ...TODAY_KINDS,
    friend_request: MORE[platform].request ?? `Send ${an(NETWORKS[platform].words.friendRequest)}`,
    confirm: MORE[platform].confirm,
  };
}

/** The Friends tab's ask to save the person's list on a network: "Save my connections list", "Save my followers". */
export const saveListOn = (platform: Platform): string =>
  MORE[platform].saveList ?? `Save my ${NETWORKS[platform].words.friends} list`;

/**
 * What the extension may do on its own on a network, in its words (Sending, decision 26). Where comments go through
 * `sends` and wait at first (the kit's `commentsWait`, decision 92), Sending says so (`COMMENT_HOLD_WORDS`), and that
 * an answer to a post asking for what the business offers always waits where the network keeps those apart.
 */
export function sendingModesOn(platform: Platform): Readonly<Record<SendingMode, string>> {
  const kit = NETWORKS[platform];
  const requests = cap(kit.words.friendRequests);
  const steps = `${requests}, likes and comments on their own; each message waits for one tap`;
  if (kit.commentsWait === 'never') return { ...SENDING_MODES, steps };
  const waits = [
    COMMENT_HOLD_WORDS,
    ...(kit.forumAnswersPerDay !== null
      ? ['An answer to a post asking for what you offer always waits for your OK.']
      : []),
  ].join(' ');
  return {
    ...SENDING_MODES,
    steps: `${steps}. ${waits}`,
    everything: `Everything on its own, messages too. ${waits}`,
  };
}

/** Under what it does on its own on a network: its limits, its pace, and its warnings. */
export const onItsOwnAbout = (platform: Platform): string =>
  `It keeps your daily limits, goes at a person’s pace, and stops for the day on any warning from ${PLATFORMS[platform]}.`;

/**
 * Today's card for Find posts on a network the extension doesn't work on its own: what it reads, and that the good ones
 * come onto the list. Alignable's runner reads its town's posts once a day itself, so the card doesn't show there.
 */
export const findPostsWordsOn = (
  platform: Platform,
): { readonly title: string; readonly body: string } => ({
  title: askNameOn('posts', platform),
  body: `Your computer reads the posts and forum questions in your town on ${PLATFORMS[platform]}. The AI picks the ones worth an answer, and they come onto this list with a draft, their writers to connect with.`,
});

/** The team's part of the live view on a network: "Your team", and on another network "Your team on LinkedIn". */
export const teamWordsOn = (
  platform: Platform,
): { readonly title: string; readonly noneTitle: string; readonly none: string } =>
  platform === 'facebook'
    ? { title: W.team, noneTitle: W.teamNoneTitle, none: W.teamNone }
    : {
        title: `${W.team} on ${PLATFORMS[platform]}`,
        noneTitle: `Nobody here has ${PLATFORMS[platform]} on yet`,
        none: `Nobody here has ${PLATFORMS[platform]} on yet.`,
      };

/** Under On its own on a network the extension doesn't work yet: what it does there instead. */
export const noRunnerWords = (platform: Platform): string =>
  `Your computer doesn’t work on ${PLATFORMS[platform]} on its own yet. You take each step and send each message yourself, and it notes what you do.`;

/** Whether Today has its helpful post on a network. */
export const helpfulOn = (platform: Platform): boolean => MORE[platform].helpful;

/** Under the helpful post's choice on a network's page in Settings. */
export const postingAboutOn = (platform: Platform): string => MORE[platform].postingAbout;

/** Each tidying ask's daily limit on the Friends tab: cancelling old requests, and unfriending. */
const TIDY_STEP = { cancel: 'cancel_request', unfriend: 'unfriend' } as const satisfies Record<
  (typeof TIDY_ASK_KINDS)[number],
  TidyKind
>;

/**
 * Tidying up on a network, in its words (the Friends tab): the asks it has, those with a daily limit there (LinkedIn
 * withdraws old invitations, and never removes a connection), and what each is called. Facebook's are as they were.
 */
export function tidyWordsOn(platform: Platform) {
  const kit = NETWORKS[platform];
  const old = MORE[platform].oldRequests;
  const w = kit.words;
  const weeks = (n: number) => (n === 1 ? 'a week' : `${n} weeks`);
  return {
    title: 'Tidy up',
    // "In an Instagram tab", never "a Instagram".
    about: `Tick the ones to go. ${inNetworkWords(TIDY_PACE_WORDS, platform).replace(`a ${kit.name} tab`, `${withArticle(kit.name)} tab`)}`,
    kinds: TIDY_ASK_KINDS.filter((k) => kit.tidyLimits[TIDY_STEP[k]] > 0),
    step: TIDY_STEP,
    cancel: {
      title: old.title,
      button: old.button,
      done: old.done,
      /** Beside each: "sent Oct 3", "followed Oct 3". */
      since: old.since ?? 'sent',
      about: (after: number) =>
        `${old.about ? old.about(weeks(after)) : `Sent more than ${weeks(after)} ago and not answered.`} ${old.why}`,
    },
    unfriend: {
      title: `${cap(w.friends)} to unfriend`,
      button: 'Unfriend the ticked',
      done: 'unfriended',
      about: (friends: number, most: number) =>
        `No contact either way in six months, ${w.friends} for longer, and not in Contacts, a prospect, kept or on Don’t pitch. You have ${friends.toLocaleString('en-US')} of ${most.toLocaleString('en-US')} ${w.friends}.`,
      needsFile: `Bring in your ${kit.name} file first (Let the extension get your file, beside this): it says when you last talked to each ${w.friend}.`,
    },
  };
}

/**
 * Why no new friend requests are on Today's list (decision 97), and what lets them start again, in a network's words:
 * on the web and the phone.
 */
export function requestsHeldWords(
  held: { readonly why: 'waiting' | 'cap'; readonly count: number; readonly most: number },
  platform: Platform,
): string {
  const kit = NETWORKS[platform];
  const { friendRequests, friends } = kit.words;
  const count = held.count.toLocaleString('en-US');
  if (held.why === 'cap')
    return `No new ${friendRequests} for now: you have ${count} ${friends} on ${kit.name}, close to its cap of ${kit.friendsCap.toLocaleString('en-US')}. ${
      kit.tidyLimits.unfriend > 0
        ? `To make room, unfriend some under Tidy up on the Friends tab.`
        : `To make room, remove some ${friends} on ${kit.name}.`
    }`;
  return `No new ${friendRequests} for now: ${count} of yours are still waiting for an answer, and ${kit.name} watches accounts with many. They start again under ${held.most.toLocaleString('en-US')}. Tick some under ${MORE[platform].oldRequests.title} in Tidy up on the Friends tab.`;
}

/**
 * Tidying up on its own (decisions 29 and 98) on a network's page in Settings, in its words: the choice, what it does
 * once a day, and its picks. Unfriending is offered only where the network has it (Facebook's).
 */
export function tidyChoiceOn(platform: Platform) {
  const kit = NETWORKS[platform];
  const own = MORE[platform].oldRequests.own;
  const unfriends = tidyModeOn(platform, 'unfriend') === 'unfriend';
  const picks: Readonly<Record<TidyMode, string>> = {
    off: 'Off: only the ones I tick',
    cancel: own.pick,
    unfriend: `${own.pick}, and unfriend`,
  };
  return {
    label: 'Tidy up on its own',
    about: [
      `Once a day it ${own.does} (3 weeks to start, set on General), up to ${OWN_TIDY_LIMITS.cancel_request} a day.`,
      own.never ?? null,
      unfriends
        ? `Unfriending takes only ${kit.words.friends} the AI found aren’t a fit and you’ve never chatted with, up to ${OWN_TIDY_LIMITS.unfriend} a day.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    options: TIDY_MODE_KEYS.filter((k) => unfriends || k !== 'unfriend').map((key) => ({
      key,
      label: picks[key],
    })),
  };
}

/**
 * The network something on a list is on, from its link: a message's, a step's or a request's profile. Facebook's when
 * the link is on none the add-on knows.
 */
export const networkOfUrl = (url: string | null | undefined): Platform =>
  (url ? networkOfLink(url) : null) ?? PLATFORM_KEYS[0];

/** Along the way's switches on a network, in its words. */
export const ticksOn = (
  platform: Platform,
): Readonly<Record<AlongTick, readonly [string, string]>> => MORE[platform].ticks;

/** The switches along the way Settings show on a network: only those its runner reads (its kit's `runs`). */
export const ticksShownOn = (platform: Platform): readonly AlongTick[] =>
  ALONG_TICKS.filter((tick) => NETWORKS[platform].runs.ticks.includes(tick));

/** A chat's page on its network, from its id: Messenger's on Facebook, LinkedIn messaging's on LinkedIn. */
export const chatUrlOn = (platform: Platform, threadKey: string | null): string | null =>
  threadKey ? MORE[platform].chatUrl(threadKey) : null;

/** "Open in Messenger", "Open in LinkedIn messaging". */
export const openChatWords = (platform: Platform): string =>
  `Open in ${NETWORKS[platform].words.messaging}`;

/** "Open on Facebook", "Open on LinkedIn". */
export const openPageWords = (platform: Platform): string => `Open on ${PLATFORMS[platform]}`;

/**
 * Where Open goes for someone on Today's list, and its words, on the web and the phone: the post it's about (a comment,
 * a warm lead, or the post a found person's like goes on), else their chat on the network's messaging, else their
 * page. Null with none of them.
 */
export function todayOpenOf(
  item: Pick<TodayItem, 'postUrl' | 'threadKey' | 'profileUrl'>,
  platform: Platform,
): { readonly url: string; readonly words: string } | null {
  if (item.postUrl) return { url: item.postUrl, words: TOUCHED_POSTS_WORDS.openPost };
  const chat = chatUrlOn(platform, item.threadKey);
  if (chat) return { url: chat, words: openChatWords(platform) };
  return item.profileUrl ? { url: item.profileUrl, words: openPageWords(platform) } : null;
}

/** "40% of first messages": a network's share of them, beside Results by network. */
export function shareWords(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}% of first messages` : '';
}

/** Social Outreach's words about networks, on the web and the phone. */
export const NETWORK_WORDS = {
  /** The setup's networks step, and the Settings menu's heading over each network's page. */
  title: 'Networks',
  about:
    'Where you reach people. Each network has its own day, limits and choices, and a warning on one never stops another.',
  /** Under Facebook, whose choices are the settings' own: below Networks, and the setup's next step. */
  facebookChoices: 'What it does on Facebook is set in your main settings.',
  /** A network that's off for the person. */
  off: (name: string) => `${name} is off for you: nothing runs, reads or shows there.`,
  /**
   * A network still looked at (decision 78), on its page in Settings: what the extension does there for now, and what
   * the person can do to move it on.
   */
  looking: (name: string) =>
    `${name} is new to HandsFreeOS. For now the extension only reads it, and does nothing on its own there. Allow it on ${name} in Chrome, then press Check ${name} below once: its steps are built from what it reads on your own account.`,
  /**
   * Beside a network's On for you switch once its save is done (Chris, 2026-10-16): at the top of its page in
   * Settings, where every change saves as it's made.
   */
  switched: (name: string, on: boolean) =>
    on ? `${name} is on. The extension picks it up in a few seconds.` : `${name} is off.`,
  /**
   * A network the business doesn't use: why, and who can change it. Owners and admins turn on Your team may use it,
   * under For your team on the network's own page in Settings.
   */
  notAllowed: (name: string, manages: boolean) =>
    `Your business doesn’t use ${name} for outreach. ${
      manages
        ? `Turn on “Your team may use ${name}” below to allow it.`
        : `Ask an owner or admin of this business to allow it under Social Outreach → Settings → ${name}.`
    }`,
  /** The heading over a network's own choices. */
  choicesOn: (name: string) => `What it does on ${name}`,
  /** Under it: its choices are its own. */
  choicesAbout: (name: string) =>
    `${name}’s choices are its own, and start off. It keeps ${name}’s daily limits, goes at a person’s pace, and stops on ${name} for the day on any warning there.`,
  /** The business's say (decision 38). */
  allowedTitle: 'Networks your team may use',
  allowedAbout:
    'Facebook is always allowed. Someone who works a network you stop allowing has it turned off for them.',
  alwaysAllowed: 'Always allowed',
  limitsOn: (name: string) => `Daily limits on ${name}`,
  limitsAbout: (name: string) =>
    `Up to ${name}’s starting limits, which keep an account there safe. Halved for your first 2 weeks there, for a week after a warning there, and on training wheels there.`,
  /** The switch for a young account (decision 96), on the network's page under its limits. */
  young: (name: string) => `My ${name} account is under a year old`,
  youngAbout: (name: string) =>
    `A newer account gets 2 more weeks at half limits, as ${name} watches new accounts most. The extension can’t see how old yours is.`,
  /** Today's strip. */
  stripTitle: 'Your networks',
  listOn: (name: string) => `Your list for today on ${name}`,
  showList: (name: string) => `Show ${name}’s list`,
  notStarted: 'Not started today',
  startAll: 'Start all',
  stopAll: 'Stop all',
  stoppedOn: (name: string) => `Stopped on ${name} for today. Your other networks go on.`,
  /** Lists by network. */
  filter: 'Network',
  all: 'All networks',
  /** The playbook's networks step. */
  playbookTitle: 'Networks',
  playbookAbout:
    'Where this playbook looks for people. The niche, the offer, the conversation and the voice are the same on each.',
  playbookAtLeastOne: 'Pick at least one network.',
  where: (platform: Platform) => MORE[platform].where,
} as const;

/** Something waiting for the person (./waiting.ts), as much of it as says its network. */
type Waited =
  | { readonly kind: 'ask'; readonly ask: { readonly platform?: Platform } }
  | { readonly kind: 'reply' | 'message'; readonly send: { readonly profileUrl: string | null } }
  | {
      readonly kind: 'need';
      readonly need: { readonly platform?: Platform; readonly url: string | null };
    }
  | { readonly kind: 'request'; readonly request: { readonly url: string } };

/** The network something waiting for the person is on: Needs you marks each with its own (Chris). */
export function networkOfWaiting(item: Waited): Platform {
  switch (item.kind) {
    case 'ask':
      return item.ask.platform ?? PLATFORM_KEYS[0];
    // Its profile's network, which HandsFreeOS sends with it; by its link only from a server before it did.
    case 'need':
      return item.need.platform ?? networkOfUrl(item.need.url);
    case 'request':
      return networkOfUrl(item.request.url);
    default:
      return networkOfUrl(item.send.profileUrl);
  }
}
