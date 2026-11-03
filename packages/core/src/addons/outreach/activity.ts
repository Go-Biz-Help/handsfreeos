/**
 * What the browser extension notes as the person works on Facebook, and what the activity panel shows
 * (docs/outreach.md, decisions 7 and 8): the friend requests, likes, comments and messages they send there
 * themselves, each with who it was to and the group they found them in; and how many of each in a day, a week or a
 * month. Browser-safe: the extension builds the notes, and the web and the extension draw the panel from these.
 */
import { z } from 'zod';
import { relativeTimeAgo } from '../../workflows/approval-words';
import { GROUP_ID, GROUP_SLUG, NAME_MOST, TOUCH_KIND_KEYS, TOUCH_STEPS } from './limits';
import { NETWORKS } from './networks';
import { PLATFORM_KEYS } from './playbooks';
import { NetworkUrl, PersonName, ProfileRef, ThreadKey } from './saves';
import { WarningState } from './tidy';

export {
  TOUCH_KIND_KEYS,
  TOUCH_KINDS,
  TOUCH_STEPS,
  type TouchKind,
  type TouchStep,
} from './limits';

/** What a step keeps of the post, the comment and why, at most. */
export const TOUCH_POST_TEXT_MOST = 300;
export const TOUCH_COMMENT_MOST = 2_000;
export const TOUCH_WHY_MOST = 160;

/** A group by its number, the name in its link, or both: whichever its links showed. */
export const GroupRef = z
  .object({
    id: z.string().regex(GROUP_ID).nullable(),
    slug: z.string().regex(GROUP_SLUG).nullable(),
    url: NetworkUrl,
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
  postUrl: NetworkUrl.nullable().default(null),
  /** The chat a message went in: the number in its link. */
  threadKey: ThreadKey.nullable().default(null),
  /** A message answering theirs: the chat's last message before it was from them, as the page showed it. */
  replying: z.boolean().nullable().default(null),
  /** Taken by the extension on its own (decision 26), not pressed by the person. */
  auto: z.boolean().default(false),
  /**
   * For a like or comment the extension made on its own, for the Results tab: what the post said, the AI's comment,
   * and why it picked that post to like. Never what the person wrote themselves.
   */
  postText: z.string().trim().min(1).max(TOUCH_POST_TEXT_MOST).nullable().default(null),
  commentText: z.string().trim().min(1).max(TOUCH_COMMENT_MOST).nullable().default(null),
  why: z.string().trim().min(1).max(TOUCH_WHY_MOST).nullable().default(null),
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
    /**
     * People who wrote back: a message from them after one from us, in a chat saved to HandsFreeOS or one the
     * extension saw (decision 22).
     */
    replies: count,
    /** People reached who booked a demo, through the demo link or marked (decision 24). */
    demos: count,
  }),
  /** The person's own day so far, step by step, against the daily limits (`limits`). */
  today: z.object({
    friend_request: count,
    first_message: count,
    follow_up: count,
    comment: count,
    like: count,
  }),
  /** The person's daily limits as they stand: DAILY_LIMITS, halved for a week after a warning. */
  limits: z.object({
    friend_request: count,
    first_message: count,
    follow_up: count,
    comment: count,
    like: count,
  }),
  /** A warning Facebook showed the person lately. */
  warning: WarningState.nullable(),
  /**
   * The person's own Partners list in the stretch (./partners.ts, decision 81): how many were asked to partner, said
   * they're interested, booked a call and were made partners. Each person's list is their own, so it's left out of
   * the team's results, and for someone with nobody on theirs.
   */
  partners: z.object({ asked: count, interested: count, calls: count, partners: count }).nullable(),
  /**
   * The people below by the group they were found in, the ones that brought demos and replies first (./results.ts):
   * how many, and how many of them were sent a friend request, liked or commented on, sent a first message, wrote
   * back and booked a demo in the stretch.
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
      demos: count,
    }),
  ),
  /**
   * The people below by the hashtag, phrase or kind of business they were found with on Instagram, LinkedIn or
   * Alignable (decision 116), the ones that brought demos and replies first: which words bring replies. The same
   * counts as the groups'.
   */
  topics: z.array(
    z.object({
      platform: z.enum(PLATFORM_KEYS),
      words: z.string(),
      people: count,
      friendRequests: count,
      warmedUp: count,
      chatsStarted: count,
      replies: count,
      demos: count,
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
      /** The network their profile is on: each row shows it by name. */
      platform: z.enum(PLATFORM_KEYS).default('facebook'),
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

/** A step someone took or was taken toward, as Results' People list shows it. */
export const ACTIVITY_STEP_KEYS = [
  'requestedAt',
  'likedAt',
  'commentedAt',
  'messagedAt',
  'repliedAt',
] as const;
export type ActivityStepKey = (typeof ACTIVITY_STEP_KEYS)[number];

export interface ActivityStep {
  readonly key: ActivityStepKey;
  readonly label: string;
  readonly at: string;
}

const STEP_LABELS: Record<Exclude<ActivityStepKey, 'requestedAt'>, string> = {
  likedAt: 'Liked',
  commentedAt: 'Commented',
  messagedAt: 'Messaged',
  repliedAt: 'Wrote back',
};

/**
 * How far someone has come, a step at a time, for the web's People list and the phone's: each step taken, in order,
 * the request to connect in their network's words ("Friend request", "Invitation to connect").
 */
export function activityStepsOf(p: ActivityOutput['people'][number]): ActivityStep[] {
  return ACTIVITY_STEP_KEYS.flatMap((key): ActivityStep[] => {
    const at = p[key];
    if (!at) return [];
    if (key !== 'requestedAt') return [{ key, label: STEP_LABELS[key], at }];
    const word = NETWORKS[p.platform].words.friendRequest;
    return [{ key, label: `${word.charAt(0).toUpperCase()}${word.slice(1)}`, at }];
  });
}

/** The words around Results' People list. */
export const ACTIVITY_PEOPLE_WORDS = {
  title: 'People',
  latestFirst: 'The latest first',
  fromGroup: (name: string | null) => `From ${name ?? 'a group'}`,
  more: (count: number) => `And ${count.toLocaleString('en-US')} more, not shown.`,
} as const;
export type ActivityTopic = ActivityOutput['topics'][number];

/** What a row of Activity's words says: "“sourdough” on Instagram". */
export const topicName = (t: Pick<ActivityTopic, 'platform' | 'words'>): string =>
  `“${t.words}” on ${NETWORKS[t.platform].name}`;

/** Which steps the list of posts shows: likes and comments, or one of them. */
export const TOUCHED_POST_KINDS = ['all', 'like', 'comment'] as const;
/** How many posts the list shows at a time; `before` asks for the ones after. */
export const TOUCHED_POSTS_PAGE = 50;

export const TouchedPostsInput = z.object({
  workspaceId: z.uuid(),
  period: z.enum(ACTIVITY_PERIOD_KEYS).default('week'),
  /** Everyone's, for owners and admins (`outreach.manage`). Left out: the person's own. */
  everyone: z.boolean().default(false),
  kind: z.enum(TOUCHED_POST_KINDS).default('all'),
  /** The next page: the ones before the last one shown. */
  before: moment.nullable().default(null),
});
export type TouchedPostsInput = z.input<typeof TouchedPostsInput>;

export const TouchedPostsOutput = z.object({
  from: moment,
  everyone: z.boolean(),
  /** The posts liked and commented on in the stretch, the latest first. */
  posts: z.array(
    z.object({
      touchId: z.uuid(),
      kind: z.enum(['like', 'comment']),
      at: moment,
      /** Whose post it was. */
      profileId: z.uuid(),
      personId: z.uuid().nullable(),
      name: z.string(),
      profileUrl: z.string(),
      postUrl: z.string().nullable(),
      /** What the post said, when it was kept: for the extension's own likes and comments, and posts found. */
      postText: z.string().nullable(),
      /** The comment the extension posted on its own. The person's own are never kept. */
      commentText: z.string().nullable(),
      /** Why the AI picked that post to like. */
      why: z.string().nullable(),
      /** Done by the extension on its own, not pressed by the person. */
      auto: z.boolean(),
      group: z.object({ name: z.string().nullable(), url: z.string() }).nullable(),
      /** Who on the team, when the list is everyone's. */
      by: z.string().nullable(),
    }),
  ),
  /** The time to ask `before` for the next page; null when there are no more. */
  next: moment.nullable(),
});
export type TouchedPostsOutput = z.output<typeof TouchedPostsOutput>;

type TouchedPost = TouchedPostsOutput['posts'][number];
type TouchedKind = (typeof TOUCHED_POST_KINDS)[number];

/** The words of the Results tab's posts liked and commented on, on the web and the phone. */
export const TOUCHED_POSTS_WORDS = {
  title: 'Posts liked and commented on',
  kinds: { all: 'All', like: 'Likes', comment: 'Comments' } satisfies Record<TouchedKind, string>,
  latestFirst: (period: ActivityPeriod) => `${ACTIVITY_PERIODS[period].label}, the latest first`,
  none: (kind: TouchedKind, period: ActivityPeriod) =>
    `No ${kind === 'all' ? 'likes or comments' : TOUCHED_POSTS_WORDS.kinds[kind].toLowerCase()} noted ${
      period === 'today' ? 'today' : `in the ${ACTIVITY_PERIODS[period].label.toLowerCase()}`
    }.`,
  failed: 'The posts didn’t load. Try again in a minute.',
  more: 'Show more',
  openPost: 'Open the post',
  openProfile: 'Facebook',
  commentHeading: 'The comment',
  ownComment: 'Your own comment: its words aren’t kept.',
  why: (why: string) => `Why this post: ${why}`,
  /** "12 min ago", "3 d ago", then the day. */
  when: (at: string, now = Date.now()) => relativeTimeAgo(at, now),
  /** "Liked", "Commented". */
  kind: (post: Pick<TouchedPost, 'kind'>) => (post.kind === 'comment' ? 'Commented' : 'Liked'),
  /** "By the extension · Sam · in Austin Owners". */
  byLine: (post: Pick<TouchedPost, 'auto' | 'by' | 'group'>) =>
    [
      post.auto ? 'By the extension' : 'By hand',
      post.by,
      post.group ? `in ${post.group.name ?? 'a group'}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
} as const;
