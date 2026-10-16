/**
 * Asking the extension (docs/outreach.md, decision 43): what needs the browser is asked of the person's working
 * computer from HandsFreeOS. The person presses a button on the Friends, Groups, Chats or Today tab; HandsFreeOS keeps
 * an ask addressed to them (`addon_outreach.asks`); the computer that works for them takes it, runs it with the jobs
 * it has, says how it's going, hands a step to the person when it can't find it (**Carry on**, **Skip**), and says how
 * it ended. The web shows each one live, with **Stop**.
 *
 * - **One of a kind at a time, about the same thing:** asking again while one is open answers that one. Looking up a
 *   person and saving a group's members are told apart by who and which groups; at most five look-ups wait at once.
 * - **Only the working computer takes one,** oldest first, one at a time, never beside a step of the runner's.
 * - **A day without a computer on lets an ask go;** Chrome closing mid-ask ends it as lost; a step handed over waits
 *   half an hour, then stops.
 * - **A Facebook warning that day** refuses every ask but bringing in the file from the downloads.
 *
 * Browser-safe: the web, the phone, the extension and the worker read these words and shapes.
 */
import { z } from 'zod';
import { clipLine, isOffline, offlineWords } from './live';
import { JOINS_PER_DAY } from './group-checks';
import { DraftOpener } from './openers';
import { DRAFT_KINDS } from './today';
import { appVersionAtLeast } from '../../mobile';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import { PROFILE_BIO_MOST } from './profile-check';

/** What a person can ask their computer to do, in the order the Live tab's list names them. */
export const ASK_KINDS = {
  file_request: 'Ask Facebook for your file',
  file_download: 'Download your Facebook file',
  file_backup: 'Get your chat backup',
  file_in: 'Bring in your Facebook file from your downloads',
  requests: 'Check your friend requests',
  friends: 'Save your friends list',
  groups: 'Save your groups',
  group_search: 'Find groups',
  members: 'Save group members',
  posts: 'Find posts in your groups',
  chats: 'Read your chats for the AI',
  checks: 'Check your friends for good fits',
  group_checks: 'Check your groups for your people',
  join: 'Ask to join good groups',
  post: 'Put up your helpful post',
  cancel: 'Cancel old friend requests',
  unfriend: 'Unfriend the ones you ticked',
  lookup: 'Look someone up before drafting',
  research: 'Research someone for fit',
  profile_read: 'Read your Facebook profile',
  profile_edit: 'Put your new bio in',
} as const;
export type AskKind = keyof typeof ASK_KINDS;
export const ASK_KIND_KEYS = Object.keys(ASK_KINDS) as [AskKind, ...AskKind[]];
/** The ones that work on Facebook's own download pages, in a tab the person can see: they type their password there. */
export const FILE_KINDS = ['file_request', 'file_download', 'file_backup'] as const;
/** The one that never opens Facebook: a warning that day doesn't stop it. */
export const OFF_FACEBOOK_KINDS = ['file_in'] as const;
/** The ones that press something on Facebook on the person's friends: in a tab they can see, brought to the front. */
export const TIDY_ASK_KINDS = ['cancel', 'unfriend'] as const;

/**
 * The kinds each network's pages can be asked (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by
 * part"): Facebook's every kind; LinkedIn's its invitations and connections, checking connections for fits, reading
 * chats, looking someone up, researching one person, reading the profile and putting the headline in, withdrawing old
 * invitations, searching posts and putting up a post. A kind a network can't be asked is refused
 * (`outreach_ask_not_on_network`).
 */
export const ASK_KINDS_ON: Readonly<Record<Platform, readonly AskKind[]>> = {
  facebook: ASK_KIND_KEYS,
  linkedin: [
    // LinkedIn's own copy of the person's data ("Get a copy of your data"): asked for, downloaded, brought in
    // (./linkedin-export.ts). It has no chat backup.
    'file_request',
    'file_download',
    'file_in',
    'requests',
    'friends',
    'checks',
    'chats',
    'lookup',
    'research',
    'profile_read',
    'profile_edit',
    'cancel',
    'posts',
    'post',
  ],
};
export const askableOn = (platform: Platform, kind: AskKind): boolean =>
  ASK_KINDS_ON[platform].includes(kind);

/**
 * The first build of the extension that works on each network but Facebook: one before it never takes an ask there,
 * which ends saying how to update.
 */
export const ASK_NETWORK_SINCE: Readonly<Partial<Record<Platform, string>>> = {
  linkedin: '0.40.0',
};

/** A target named by its network: as it is on Facebook, and with the network's name before it on any other. */
export const targetOn = (platform: Platform, target: string): string =>
  platform === 'facebook' ? target : `${platform}:${target}`;

/**
 * What an ask is about, for one like it open to answer it: as `askTarget` says on Facebook, and named by its network
 * on any other, so a LinkedIn ask never answers a Facebook one.
 */
export const askTargetOn = (platform: Platform, ask: AskAsked): string =>
  targetOn(platform, askTarget(ask));

/** Why an ask can't be made on a network: the kind isn't one it's asked there. Null when it can. */
export const notOnNetworkWords = (platform: Platform, kind: AskKind): string | null =>
  askableOn(platform, kind)
    ? null
    : `Your computer can’t do that on ${PLATFORMS[platform]} yet. Ask it on Facebook, or from that network’s own buttons.`;

export const isFileKind = (kind: AskKind): boolean =>
  (FILE_KINDS as readonly string[]).includes(kind);
export const onFacebook = (kind: AskKind): boolean =>
  !(OFF_FACEBOOK_KINDS as readonly string[]).includes(kind);

/** Each tab's asks, which it lists and refreshes on. */
export const ASK_KINDS_FOR = {
  friends: [
    'requests',
    'friends',
    'checks',
    'file_request',
    'file_download',
    'file_backup',
    'file_in',
    'cancel',
    'unfriend',
    'research',
  ],
  pipeline: ['research'],
  groups: ['groups', 'group_search', 'members', 'posts', 'group_checks', 'join'],
  chats: ['chats'],
  today: ['lookup', 'members', 'post', 'profile_read', 'profile_edit'],
} as const satisfies Record<string, readonly AskKind[]>;

export const ASK_STATES = {
  waiting: 'Waiting for your computer',
  working: 'Working on it',
  stuck: 'Needs you',
  typing: 'Needs you',
  done: 'Done',
  failed: 'Didn’t finish',
  cancelled: 'Stopped',
} as const;
export type AskState = keyof typeof ASK_STATES;
export const ASK_STATE_KEYS = Object.keys(ASK_STATES) as [AskState, ...AskState[]];
/** What the lists show: the above, one that waited too long, and one whose computer went away mid-way. */
export const ASK_SHOWN_STATES = {
  ...ASK_STATES,
  expired: 'Let go',
  lost: 'Didn’t finish',
} as const;
export type AskShownState = keyof typeof ASK_SHOWN_STATES;
export const ASK_SHOWN_STATE_KEYS = Object.keys(ASK_SHOWN_STATES) as [
  AskShownState,
  ...AskShownState[],
];
export const OPEN_ASK_STATES = ['waiting', 'working', 'stuck', 'typing'] as const;
/** Taken by a computer and not ended. */
export const TAKEN_ASK_STATES = ['working', 'stuck', 'typing'] as const;
/** Waiting on the person, at their computer. */
export const NEEDS_YOU_STATES = ['stuck', 'typing'] as const;
export const ASK_REPLIES = { carry_on: 'Carry on', skip: 'Skip' } as const;
export type AskReply = keyof typeof ASK_REPLIES;
export const ASK_REPLY_KEYS = Object.keys(ASK_REPLIES) as [AskReply, ...AskReply[]];
export const ASK_VIA = ['web', 'mobile', 'extension'] as const;
export type AskVia = (typeof ASK_VIA)[number];

/** A waiting ask no computer took in a day is let go. */
export const ASK_WAIT_HOURS = 24;
/** A new line alone goes from the extension, and is told to the app, at most this often. */
export const ASK_LINE_SECONDS = 20;
/** A step handed over that nobody carried on with stops after this. */
export const ASK_STUCK_MINUTES = 30;
/** A taken ask whose computer wasn't seen for this long, or that started this long ago, is lost. */
export const ASK_LOST_MINUTES = 10;
export const ASK_LOST_HOURS = 6;
/** Kept this long, pruned with the feed (LIVE_KEEP_DAYS). */
export const ASK_KEEP_DAYS = 7;
export const ASKS_SHOWN_MOST = 50;
/** People ticked in one ask. */
export const ASK_TIDY_MOST = 50;
/** Groups named in one ask: Find posts goes through five (RUN_GROUPS), saving members three (MEMBER_GROUPS). */
export const ASK_GROUPS_MOST = 5;
export const ASK_MEMBER_GROUPS = 3;
/** Words to search for groups with. */
export const ASK_WORDS_MOST = 100;
/** Look-ups waiting at once, for one person. */
export const ASK_LOOKUPS_MOST = 5;
/** A pasted group link, at most. */
export const ASK_LINK_MOST = 500;
/** Read my chats, asked: more than a day's run (the runner's is 60). */
export const ASK_CHATS = 150;
/** How fast the extension goes, in seconds between one and the next: chats read, and people tidied. */
export const CHATS_PACE_SECONDS = [7, 14] as const;
export const TIDY_PACE_SECONDS = [20, 40] as const;
/** Read my chats, under its button and in the Chats tab's empty lists. */
export const READ_CHATS_WORDS = `Your computer opens your chats in Messenger one at a time, every ${CHATS_PACE_SECONDS[0]} to ${CHATS_PACE_SECONDS[1]} seconds, up to ${ASK_CHATS}, and sends each one’s latest messages for the AI to read. Group chats are left out.`;
/** Tidy up, on the Friends tab. */
export const TIDY_PACE_WORDS = `Your computer does it slowly, a person every ${TIDY_PACE_SECONDS[0]} to ${TIDY_PACE_SECONDS[1]} seconds, in a Facebook tab you can see, and stops at today’s limit and on any warning from Facebook.`;

const MIN = 60_000;
const HOUR = 60 * MIN;

// ------------------------------------------------------------------------------------------------- group links

/** Facebook's own group pages, never a group: copied to the extension's src/facebook/urls.ts from here. */
export const NOT_GROUPS = [
  'categories',
  'create',
  'discover',
  'explore',
  'feed',
  'joins',
  'notifications',
  'search',
  'your_groups',
] as const;
const GROUP_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'web.facebook.com',
  'm.facebook.com',
]);
const GROUP_NAME = /^[\p{L}\p{N}._-]{1,100}$/u;

/**
 * A link to a Facebook group as HandsFreeOS keeps it: `https://www.facebook.com/groups/<name or number>/`, from any
 * page of the group (its members, a post), the phone's site, or with anything after it. Null for anything else.
 */
export function groupLink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim().match(/^https?:\/\//i) ? href.trim() : `https://${href.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!GROUP_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'groups' || !parts[1]) return null;
  let name: string;
  try {
    name = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if ((NOT_GROUPS as readonly string[]).includes(name.toLowerCase()) || !GROUP_NAME.test(name))
    return null;
  return `https://www.facebook.com/groups/${encodeURIComponent(name)}/`;
}

export const isGroupLink = (href: string): boolean => groupLink(href) !== null;

// ------------------------------------------------------------------------------------------------- shapes

const words = z.string().trim().min(2).max(ASK_WORDS_MOST);
const groupIds = z.array(z.uuid()).min(1).max(ASK_GROUPS_MOST);
const profileIds = z.array(z.uuid()).min(1).max(ASK_TIDY_MOST);
/** What a look-up drafts: Today's draft, without the lines (the computer reads those). */
export const AskDraft = z
  .object({
    kind: z.enum(DRAFT_KINDS),
    profileId: z.uuid().nullable().default(null),
    chatId: z.uuid().nullable().default(null),
    postId: z.uuid().nullable().default(null),
  })
  .refine((d) => d.profileId || d.chatId || d.postId, {
    message: 'Say who to look up: their profile, the chat, or the post.',
  });
export type AskDraft = z.output<typeof AskDraft>;

const plain = <K extends AskKind>(kind: K) => z.object({ kind: z.literal(kind) });

/** What's asked, one shape a kind. */
export const AskInput = z.discriminatedUnion('kind', [
  plain('file_request'),
  plain('file_download'),
  plain('file_backup'),
  plain('file_in'),
  plain('requests'),
  plain('friends'),
  plain('groups'),
  plain('chats'),
  plain('checks'),
  plain('group_checks'),
  /** The groups to ask to join; with none, the best not joined yet, found first when there are none. */
  z.object({ kind: z.literal('join'), groupIds: groupIds.max(JOINS_PER_DAY).optional() }),
  /** A helpful post the person OK'd (decision 50), for their computer to put up in its group. */
  z.object({ kind: z.literal('post'), helpfulId: z.uuid() }),
  z.object({ kind: z.literal('group_search'), words }),
  z
    .object({
      kind: z.literal('members'),
      /** The groups to save the members of; with neither these nor a link, the best groups to work. */
      groupIds: groupIds.max(ASK_MEMBER_GROUPS).optional(),
      /** A group's link the person pasted. */
      url: z.string().trim().min(1).max(ASK_LINK_MOST).optional(),
    })
    .refine((m) => !(m.groupIds && m.url), {
      message: 'Ask for the groups you picked, or for a link you pasted, not both.',
    }),
  z.object({ kind: z.literal('posts'), groupIds: groupIds.optional() }),
  z.object({ kind: z.literal('cancel'), profileIds }),
  z.object({ kind: z.literal('unfriend'), profileIds }),
  z.object({ kind: z.literal('lookup'), draft: AskDraft }),
  /** Research one person (decision 46a): checked for fit next, ahead of the daily order, within the day's checks. */
  z.object({ kind: z.literal('research'), profileId: z.uuid() }),
  /** Read the person's own profile for the AI's check (decision 64, ./profile-check.ts). */
  plain('profile_read'),
  /**
   * Put a bio in on their own profile, one the AI wrote and they picked or changed: then read it again. On LinkedIn
   * it's the headline. Each network's own length (`BIO_MOST_ON`) is held when it's asked.
   */
  z.object({
    kind: z.literal('profile_edit'),
    bio: z.string().trim().min(1, 'Pick a bio first.').max(PROFILE_BIO_MOST),
  }),
]);
export type AskInput = z.input<typeof AskInput>;
export type AskAsked = z.output<typeof AskInput>;

/** A group as the computer gets it: from HandsFreeOS's list, or a link pasted (no id until it's saved). */
export const AskGroup = z.object({
  groupId: z.uuid().nullable(),
  name: z.string().nullable(),
  url: z.string(),
  people: z.number().int().min(0),
  adminsRead: z.boolean(),
});
export type AskGroup = z.output<typeof AskGroup>;

/** What the computer gets: the ask, as HandsFreeOS worked it out when asked. */
export const AskTask = z.discriminatedUnion('kind', [
  plain('file_request'),
  plain('file_download'),
  plain('file_backup'),
  plain('file_in'),
  plain('requests'),
  plain('friends'),
  plain('groups'),
  plain('chats'),
  plain('checks'),
  plain('group_checks'),
  z.object({ kind: z.literal('join'), groupIds: z.array(z.uuid()).nullable() }),
  z.object({ kind: z.literal('post'), helpfulId: z.uuid() }),
  z.object({ kind: z.literal('group_search'), words: z.string() }),
  /** Null groups: the computer picks the best ones to work, as the runner does. */
  z.object({ kind: z.literal('members'), groups: z.array(AskGroup).nullable() }),
  /**
   * Off Facebook, `words` are what to search the network's posts with, the playbooks' own (`postSearchWords`): groups
   * there are quiet. Empty on Facebook, and from an API before them.
   */
  z.object({
    kind: z.literal('posts'),
    groups: z.array(AskGroup).nullable(),
    words: z.array(z.string()).default([]),
  }),
  z.object({ kind: z.literal('cancel'), profileIds: z.array(z.uuid()) }),
  z.object({ kind: z.literal('unfriend'), profileIds: z.array(z.uuid()) }),
  z.object({
    kind: z.literal('lookup'),
    draft: z.object({
      kind: z.enum(DRAFT_KINDS),
      profileId: z.uuid().nullable(),
      chatId: z.uuid().nullable(),
      postId: z.uuid().nullable(),
    }),
    profileUrl: z.string().nullable(),
    name: z.string(),
  }),
  z.object({ kind: z.literal('research'), profileId: z.uuid(), name: z.string() }),
  plain('profile_read'),
  z.object({ kind: z.literal('profile_edit'), bio: z.string() }),
]);
export type AskTask = z.output<typeof AskTask>;

/** What came of it beyond the line: a look-up's drafts. */
export const AskResult = z.object({
  drafts: z.array(z.string().max(2_000)).max(5),
  /**
   * What the drafts are for, when it isn't the kind asked: a reply to someone who said yes becomes Send the video or
   * Send the link (`TodayDraftOutput.kind`). Null from extensions before 0.33.0.
   */
  kind: z.enum(DRAFT_KINDS).nullable().default(null),
  opener: DraftOpener.nullable().default(null),
  simple: z.boolean().default(false),
  lookedUp: z.boolean().default(false),
  /** Research with the day's checks used up: the person goes first in tomorrow's checks. */
  queued: z.boolean().default(false),
});
export type AskResult = z.output<typeof AskResult>;

const moment = z.iso.datetime();

/** An ask, as the lists show it. */
export const AskShown = z.object({
  askId: z.uuid(),
  /** The network it's asked on. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  kind: z.enum(ASK_KIND_KEYS),
  /** What it's about, for matching a button to its ask: who, which groups, the words. */
  target: z.string(),
  about: z.string().nullable(),
  via: z.enum(ASK_VIA),
  state: z.enum(ASK_SHOWN_STATE_KEYS),
  line: z.string().nullable(),
  result: AskResult.nullable(),
  reply: z.enum(ASK_REPLY_KEYS).nullable(),
  askedAt: moment,
  startedAt: moment.nullable(),
  endedAt: moment.nullable(),
  computerName: z.string().nullable(),
});
export type AskShown = z.output<typeof AskShown>;

export const AskMakeInput = z.object({
  workspaceId: z.uuid(),
  /** The network it's asked on: Facebook when left out. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  ask: AskInput,
});
export type AskMakeInput = z.input<typeof AskMakeInput>;
export const AskMakeOutput = z.object({
  ask: AskShown,
  /** False: one like it was open already, and that's the one answered. */
  fresh: z.boolean(),
});
export type AskMakeOutput = z.output<typeof AskMakeOutput>;

export const AsksInput = z.object({
  workspaceId: z.uuid(),
  /** Only these kinds: each tab its own. */
  kinds: z.array(z.enum(ASK_KIND_KEYS)).max(ASK_KIND_KEYS.length).optional(),
});
export type AsksInput = z.input<typeof AsksInput>;
export const AsksOutput = z.object({
  now: moment,
  timezone: z.string(),
  /** The computer that works for the person: null with none. */
  computer: z
    .object({
      computerId: z.uuid(),
      name: z.string(),
      online: z.boolean(),
      signedOut: z.boolean(),
      lastSeenAt: moment,
      /** Its build of the extension, as it last said: one too old for a kind of ask can't be asked it. */
      version: z.string().nullable(),
    })
    .nullable(),
  /** Whether Facebook warned them today: nothing but bringing in the file can be asked. */
  warnedToday: z.boolean(),
  /** The open ones and today's, newest first. */
  asks: z.array(AskShown),
});
export type AsksOutput = z.output<typeof AsksOutput>;

export const AskTakeInput = z.object({
  workspaceId: z.uuid(),
  /** The extension's install id. */
  installId: z.uuid(),
  /** The ask it's doing now, if any: other asks it took before are ended as lost (Chrome restarted mid-way). */
  underway: z.uuid().nullable().default(null),
  /**
   * Only asks on this network (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "One runner, one turn"): each
   * network's line takes its own, so one waiting on the person never holds another's, and `underway` is that
   * network's alone. Left out, by a build before networks: the oldest on any network, as before.
   */
  platform: z.enum(PLATFORM_KEYS).optional(),
});
export type AskTakeInput = z.input<typeof AskTakeInput>;
export const AskTakeOutput = z.object({
  ask: z
    .object({
      askId: z.uuid(),
      /** The network to do it on: a build that knows no network but Facebook is never handed another's. */
      platform: z.enum(PLATFORM_KEYS).default('facebook'),
      kind: z.enum(ASK_KIND_KEYS),
      task: AskTask,
      about: z.string().nullable(),
      askedAt: moment,
    })
    .nullable(),
  /** How many more wait. */
  waiting: z.number().int().min(0),
});
export type AskTakeOutput = z.output<typeof AskTakeOutput>;
export type AskTaken = NonNullable<AskTakeOutput['ask']>;

const keptLine = z
  .string()
  .trim()
  .transform((s) => clipLine(s));

export const AskProgressInput = z.object({
  workspaceId: z.uuid(),
  askId: z.uuid(),
  state: z.enum(TAKEN_ASK_STATES),
  line: keptLine,
});
export type AskProgressInput = z.input<typeof AskProgressInput>;
export const AskProgressOutput = z.object({
  /** The person pressed Stop, in the app or elsewhere: stop at the next page. */
  cancelled: z.boolean(),
  /** Their answer to the step handed to them, until a `working` progress takes it. */
  reply: z.enum(ASK_REPLY_KEYS).nullable(),
});
export type AskProgressOutput = z.output<typeof AskProgressOutput>;

export const AskEndInput = z.object({
  workspaceId: z.uuid(),
  askId: z.uuid(),
  state: z.enum(['done', 'failed']),
  line: keptLine,
  result: AskResult.nullable().default(null),
});
export type AskEndInput = z.input<typeof AskEndInput>;
export const AskEndOutput = z.object({ state: z.enum(ASK_STATE_KEYS) });
export type AskEndOutput = z.output<typeof AskEndOutput>;

export const AskReplyInput = z.object({
  workspaceId: z.uuid(),
  askId: z.uuid(),
  reply: z.enum(ASK_REPLY_KEYS),
});
export type AskReplyInput = z.input<typeof AskReplyInput>;
export const AskCancelInput = z.object({ workspaceId: z.uuid(), askId: z.uuid() });
export type AskCancelInput = z.input<typeof AskCancelInput>;
export const AskChangedOutput = z.object({ ask: AskShown });
export type AskChangedOutput = z.output<typeof AskChangedOutput>;

/** Add to Contacts, from the web: a profile kept here becomes a customer, or is tied to one. */
export const ProfileContactInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  /** The customer they are, when the person said "It’s them": else a new one. */
  personId: z.uuid().nullable().default(null),
});
export type ProfileContactInput = z.input<typeof ProfileContactInput>;

// ------------------------------------------------------------------------------------------------- rules

export const askOpen = (state: AskShownState): boolean =>
  (OPEN_ASK_STATES as readonly string[]).includes(state);
export const askNeedsYou = (state: AskShownState): boolean =>
  (NEEDS_YOU_STATES as readonly string[]).includes(state);

/** What a person may answer a step handed to them: the file's steps go on, a person ticked can be skipped. */
export function askRepliesFor(kind: AskKind): AskReply[] {
  // Putting the bio in by hand, where the computer couldn't find Edit bio: they say when it's in.
  if (isFileKind(kind) || kind === 'profile_edit') return ['carry_on'];
  if ((TIDY_ASK_KINDS as readonly string[]).includes(kind)) return ['carry_on', 'skip'];
  return [];
}

/**
 * What the lists show: `expired` for a waiting one no computer took in a day, `lost` for one taken whose computer
 * went away (not seen for ten minutes, or started six hours ago), else the state.
 */
export function askShownState(
  ask: {
    readonly state: AskState;
    readonly askedAt: string | Date;
    readonly startedAt: string | Date | null;
    /** When its computer was last seen: null with none. */
    readonly seenAt: string | Date | null;
  },
  now: number,
): AskShownState {
  const time = (at: string | Date) => new Date(at).getTime();
  if (ask.state === 'waiting')
    return now - time(ask.askedAt) > ASK_WAIT_HOURS * HOUR ? 'expired' : 'waiting';
  if ((TAKEN_ASK_STATES as readonly string[]).includes(ask.state)) {
    if (ask.seenAt === null || now - time(ask.seenAt) > ASK_LOST_MINUTES * MIN) return 'lost';
    if (ask.startedAt !== null && now - time(ask.startedAt) > ASK_LOST_HOURS * HOUR) return 'lost';
  }
  return ask.state;
}

/**
 * What an ask is about, so the same thing asked twice is the same ask: who's looked up, which groups, the words. Empty
 * for the kinds that are one at a time whatever they're about.
 */
export function askTarget(ask: AskAsked): string {
  switch (ask.kind) {
    case 'group_search':
      return ask.words.toLowerCase().replace(/\s+/g, ' ');
    case 'join':
      return ask.groupIds ? `groups:${[...new Set(ask.groupIds)].sort().join(',')}` : 'best';
    case 'post':
      return `helpful:${ask.helpfulId}`;
    case 'members':
    case 'posts': {
      if (ask.groupIds) return `groups:${[...new Set(ask.groupIds)].sort().join(',')}`;
      if (ask.kind === 'members' && ask.url) return `link:${groupLink(ask.url) ?? ask.url}`;
      return 'best';
    }
    case 'lookup': {
      const { draft } = ask;
      const who = draft.postId
        ? `post:${draft.postId}`
        : draft.chatId
          ? `chat:${draft.chatId}`
          : `profile:${draft.profileId}`;
      return `${draft.kind}:${who}`;
    }
    case 'research':
      return researchTarget(ask.profileId);
    default:
      return '';
  }
}

const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What it's about, for the lists: "Austin Small Business Owners" (one group), "3 groups", "your best groups",
 * "3 people", "Dana Reyes", "“dog groomers austin”"; null for the rest.
 */
export function askAbout(
  ask: AskAsked,
  named: { readonly groups?: readonly (string | null)[]; readonly name?: string | null } = {},
): string | null {
  const clip = (s: string) => clipLine(s, 200);
  switch (ask.kind) {
    case 'group_search':
      return clip(`“${ask.words}”`);
    case 'members':
    case 'posts': {
      const groups = named.groups ?? [];
      if (groups.length === 1) return clip(groups[0] ?? 'the group you pasted');
      if (groups.length > 1) return counted(groups.length, 'group', 'groups');
      return ask.kind === 'members' && ask.url ? 'the group you pasted' : 'your best groups';
    }
    case 'cancel':
    case 'unfriend':
      return counted(ask.profileIds.length, 'person', 'people');
    case 'join': {
      const groups = named.groups ?? [];
      if (groups.length === 1) return clip(groups[0] ?? 'a group');
      if (groups.length > 1) return counted(groups.length, 'group', 'groups');
      return 'good groups';
    }
    case 'lookup':
    case 'post':
    case 'research':
      return named.name ? clip(named.name) : null;
    default:
      return null;
  }
}

/** Under an ask the computer hasn't taken: when it will. */
export function askWaitingWords(
  computer: {
    readonly name: string;
    readonly online: boolean;
    readonly signedOut: boolean;
    readonly lastSeenAt: string;
  } | null,
  timeZone: string,
  now: number,
): string {
  if (!computer)
    return 'Install HandsFreeOS Social in Chrome on your computer and sign in, and it does this.';
  if (computer.signedOut)
    return `${computer.name} is signed out of the extension. Sign in there, and it does this.`;
  if (!computer.online || isOffline(computer.lastSeenAt, now))
    return `${offlineWords(computer.lastSeenAt, timeZone, now)} It does this then.`;
  return `${computer.name} starts on it in a moment.`;
}

/** Asked again while one like it is open. */
export function askAgainWords(kind: AskKind): string {
  if ((TIDY_ASK_KINDS as readonly string[]).includes(kind))
    return 'Your computer is still on the last ones you ticked. Stop it there to tick others.';
  return 'Your computer is on it already.';
}

export const ASK_EXPIRED_LINE =
  'Your computer wasn’t on for a day, so this was let go. Ask again when it’s on.';
export const ASK_LOST_LINE = 'Chrome closed before it finished. Ask again in HandsFreeOS.';
export const ASK_STUCK_LINE =
  'Nobody carried on for half an hour, so it stopped. Ask again when you’re at your computer.';
export const ASK_STOPPED_LINE = 'Stopped.';
export const ASK_STOPPED_EARLY_LINE = 'Stopped before it started.';
/**
 * Ended because the extension's sign-in changed under it, at a sign-in, a sign-out or a business picked: signed out,
 * someone else signed in, or another business picked.
 */
export function askSignInLine(
  now: { readonly userId: string; readonly businessId: string } | null,
  was: { readonly userId: string; readonly businessId: string },
): string {
  if (!now) return 'Stopped: you signed out of the extension here. Sign in again, then ask again.';
  if (now.userId !== was.userId)
    return 'Stopped: you signed in as someone else here. Sign in as yourself, then ask again.';
  return 'Stopped: you picked another business in the extension. Pick this one again, then ask again.';
}
/** Ended on the day's warning on its network (Facebook's unless said), before it began or as it went. */
export const askWarnedLine = (words: string | null, platform: Platform = 'facebook'): string =>
  `${PLATFORMS[platform]} warned you today${words ? ` (“${words}”)` : ''}, so the extension does nothing more on ${PLATFORMS[platform]} until tomorrow.`;
/** Under a step handed to the person, while they type their password. */
export const ASK_TYPING_WORDS =
  'Facebook is asking for your password or PIN. Type it on your computer, in the Facebook tab it opened.';

/** The push, and the extension's pop-up, when an ask first needs the person. */
export function askStuckPushWords(
  state: 'stuck' | 'typing',
  line: string | null,
): { title: string; body: string } {
  return {
    title: 'Your computer needs you',
    body:
      state === 'typing' ? ASK_TYPING_WORDS : line || 'It handed you a step. Open the Live tab.',
  };
}

/** The runner's line while an ask goes first. */
export const ASK_FIRST_WORDS = 'Doing what you asked from HandsFreeOS first. It carries on after.';

// ------------------------------------------------------------------------------------------------- the buttons' words

/** Each state's badge colour, the same on the web and the phone. */
export const ASK_TONES: Record<AskShownState, 'accent' | 'ok' | 'pending' | 'danger' | 'gray'> = {
  waiting: 'accent',
  working: 'ok',
  stuck: 'pending',
  typing: 'pending',
  done: 'ok',
  failed: 'danger',
  lost: 'danger',
  cancelled: 'gray',
  expired: 'gray',
};

/** The buttons and the lines under them, the same on the web and the phone. */
export const ASK_WORDS = {
  fromFacebook: 'From Facebook',
  fromFacebookNote:
    'Your computer opens Facebook in a window of its own and saves what it reads here.',
  saveGroups: 'Save my groups',
  findGroups: 'Find groups',
  searchFor: 'Words to search for',
  saveMembers: 'Save members of my best groups',
  findPosts: 'Find posts',
  saveItsMembers: 'Save its members',
  readChats: 'Read my chats',
  askedTitle: 'Asked of your computer',
  askedNone:
    'Nothing asked today. Buttons like Save my groups and Read my chats ask your computer to do things on Facebook for you.',
  onIt: 'Your computer is on it. Stop it below to ask again.',
  stop: 'Stop',
  stopped: ASK_STOPPED_LINE,
  youSaid: (reply: AskReply) => `You said ${ASK_REPLIES[reply]}.`,
} as const;

export const NO_COMPUTER_ASK_WORDS =
  'Install HandsFreeOS Social in Chrome on your computer and sign in, and these buttons work.';
export const WARNED_ASK_WORDS =
  'Facebook warned you today, so your computer does nothing more on Facebook until tomorrow.';

/**
 * The first build of the extension that does each kind of ask (the rest every build here does): one before it can't,
 * so it isn't asked to. An older build left such an ask hanging at "Starting…".
 */
export const ASK_KIND_SINCE: Readonly<Partial<Record<AskKind, string>>> = {
  checks: '0.21.0',
  group_checks: '0.22.0',
  join: '0.22.0',
  post: '0.24.0',
  research: '0.27.0',
  profile_read: '0.32.0',
  profile_edit: '0.32.0',
};

/**
 * Whether a build of the extension is too old for a kind of ask, on a network (Facebook when left out). One that
 * didn't say its version is.
 */
export const tooOldFor = (
  version: string | null,
  kind: AskKind,
  platform: Platform = 'facebook',
): boolean => {
  const since = ASK_KIND_SINCE[kind];
  const network = ASK_NETWORK_SINCE[platform];
  return (
    (since !== undefined && !appVersionAtLeast(version, since)) ||
    (network !== undefined && !appVersionAtLeast(version, network))
  );
};

/** What a computer whose extension is too old for an ask says: how to update it. */
export const tooOldWords = (computer: { readonly name: string; readonly version: string | null }) =>
  `HandsFreeOS Social on ${computer.name} is an older build${computer.version ? ` (${computer.version})` : ''} that can’t do this yet. Download the newest one (the link is in Social Outreach’s setup, under Install the extension), unzip it over the old folder, and press Reload on Chrome’s Extensions page. Then ask again.`;

/** Why a button can't ask now, in words: null when it can. */
export function cantAskWhy(
  asks: Pick<AsksOutput, 'computer' | 'warnedToday'>,
  kind: AskKind,
): string | null {
  if (!asks.computer) return NO_COMPUTER_ASK_WORDS;
  if (tooOldFor(asks.computer.version, kind)) return tooOldWords(asks.computer);
  if (asks.warnedToday && onFacebook(kind)) return WARNED_ASK_WORDS;
  return null;
}

/** Why the buttons wait, once for a tab: no computer, it's signed out or offline, or Facebook warned them today. */
export function computerNoteWords(
  asks: Pick<AsksOutput, 'computer' | 'warnedToday' | 'timezone' | 'now'>,
): string | null {
  const c = asks.computer;
  if (!c) return NO_COMPUTER_ASK_WORDS;
  if (asks.warnedToday) return `${WARNED_ASK_WORDS} Bringing in your file still works.`;
  if (c.signedOut || !c.online) return askWaitingWords(c, asks.timezone, Date.parse(asks.now));
  return null;
}

/** What a press says once HandsFreeOS has it: asked, and when the computer does it; or that one like it is open. */
export function askedWords(
  made: {
    readonly fresh: boolean;
    readonly ask: {
      readonly kind: AskKind;
      readonly state?: string;
      readonly line?: string | null;
    };
  },
  asks: Pick<AsksOutput, 'computer' | 'timezone'>,
  now: number,
): string {
  // Ended as it was asked (Research with the day's checks used up): its line says what comes of it.
  if (made.ask.state === 'done' && made.ask.line) return made.ask.line;
  return made.fresh
    ? `Asked. ${askWaitingWords(asks.computer, asks.timezone, now)}`
    : askAgainWords(made.ask.kind);
}

/** What a Research ask is about: the person. `outreach.checks.next` finds the asks by it. */
export const researchTarget = (profileId: string): string => `profile:${profileId}`;

/** What the latest Research ask about someone came to, for the row (`researchShown` in ./checks.ts). */
export function researchAskState(
  ask: Pick<AskShown, 'state' | 'result'> | null,
): 'open' | 'tomorrow' | 'failed' | null {
  if (!ask) return null;
  if (askOpen(ask.state)) return 'open';
  if (ask.state === 'done') return ask.result?.queued ? 'tomorrow' : null;
  return ask.state === 'cancelled' ? null : 'failed';
}

/** What a button's ask is about, worked out as `outreach.ask.make` does, so it finds its own ask: '' when it can't be. */
export function targetOf(ask: AskInput): string {
  const parsed = AskInput.safeParse(ask);
  return parsed.success ? askTarget(parsed.data) : '';
}

/** The newest ask of a kind (and about the same thing, when given): `outreach.asks` lists them newest first. */
export function latestAsk<A extends { readonly kind: AskKind; readonly target: string }>(
  asks: { readonly asks: readonly A[] } | null,
  kind: AskKind,
  target?: string,
): A | null {
  return (
    asks?.asks.find((a) => a.kind === kind && (target === undefined || a.target === target)) ?? null
  );
}
