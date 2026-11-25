/**
 * Each network's runner (docs/outreach.md, decision 195): the kinds it does on its own, its once-a-day jobs in their
 * order and what each is called, the jobs that find people, and its pace. They were each runner's own in the
 * extension (apps/extension/src/auto/), which now reads them from here, so HandsFreeOS plans the same day the
 * extension works (./plan.ts). The rules they're read by are in ./plan-rules.ts. Browser-safe.
 */
import { NETWORKS, type Platform } from './networks';
import {
  AUTO_KINDS,
  DAILY_JOBS,
  FINDING_JOBS,
  STARTED_GAP_MS,
  type DailyJob,
  type OwnDailyJob,
} from './plan-rules';
import type { TodayKind } from './today';

/** A once-a-day job on any network. */
export type RunnerJob = DailyJob | OwnDailyJob;

// ------------------------------------------------------------------------------------------------- Facebook

/** Facebook's once-a-day jobs by name, for the list of what it did today and the plan. */
export const DAILY_NAMES: Readonly<Record<DailyJob, string>> = {
  requests: 'Friend requests',
  tidy: 'Tidy up',
  occasions: 'Birthdays',
  group_checks: 'Check my groups',
  join: 'Join groups',
  members: 'Group members',
  posts: 'Find posts',
  active: 'Active in your groups',
  chats: 'Read my chats',
  events: 'Events near you',
  followers: 'Your followers',
  checks: 'Check my friends',
  partners: 'Find partners',
  helpful: 'Helpful posts',
  comment_research: 'Comment research',
  profile: 'Read my profile',
};

// ------------------------------------------------------------------------------------------------- LinkedIn

/**
 * The kinds it does on its own on LinkedIn, in order. From 0.99.0 a comment on a good post is drafted and sent through
 * `sends` (decision 102), as Instagram's and Alignable's are, never as a step. From 0.118.0 the invitations they got
 * that HandsFreeOS says to accept, as they pressed or the AI said (decision 136), are accepted from each profile.
 */
export const LINKEDIN_AUTO: readonly TodayKind[] = ['confirm', 'warm_up', 'friend_request'];
/**
 * The once-a-day jobs on LinkedIn, in order. From 0.97.0 it withdraws old invitations on its own after checking the
 * new ones (`tidy`, decision 98), as the person chose; from 0.100.0 it then reads Catch up for birthdays and new jobs
 * (`occasions`, decision 108), for a note on Today that waits for the person's OK. From 0.95.0 (decision 92) who
 * reacted to and commented on the good posts its search found is read after the helpful post (`post_people`), and the
 * people found are checked last (`found_checks`), inside its 40 profiles read, found people first. From 0.109.0 who
 * engaged with their helpful posts is read on its own after the day's post is asked for (`engaged`), as that read
 * needs its window in front, so waits till they're away from their computer (decision 120) while the post goes up as
 * ever. From 0.144.0 HandsFreeOS's own comment research before the profile (`comment_research`, decision 172), only
 * for whoever of its staff started one: from 0.154.0 first whenever its batch is due, outside the working hours too
 * (decision 194, `researchNext`).
 */
export const LINKEDIN_DAILY = [
  'requests',
  'tidy',
  'occasions',
  'checks',
  'chats',
  'posts',
  'partners',
  'helpful',
  'engaged',
  'post_people',
  'found_checks',
  'comment_research',
  'profile',
] as const satisfies readonly RunnerJob[];
export type LinkedInDaily = (typeof LINKEDIN_DAILY)[number];
export const LINKEDIN_DAILY_NAMES: Readonly<Record<LinkedInDaily, string>> = {
  requests: 'Invitations',
  occasions: 'Birthdays and new jobs',
  tidy: 'Tidy up',
  checks: 'Check my connections',
  chats: 'Read my chats',
  posts: 'Find posts',
  partners: 'Find partners',
  helpful: 'Helpful posts',
  engaged: 'Who engaged with your posts',
  post_people: 'Who reacted and commented',
  found_checks: 'Check the people found',
  comment_research: 'Comment research',
  profile: 'Read my profile',
};
/**
 * LinkedIn's jobs that find people, done again in a round while it needs more good fits (decision 126, ./plan-rules.ts
 * `nextRound`): LinkedIn’s post search with the next words, who reacted to and commented on good posts, and their
 * checks.
 */
export const LINKEDIN_FINDING: readonly LinkedInDaily[] = ['posts', 'post_people', 'found_checks'];
/** LinkedIn's pace between steps: slower than Facebook's, a person's. */
export const LINKEDIN_GAP_MS = { least: 2 * 60_000, most: 6 * 60_000 } as const;

// ------------------------------------------------------------------------------------------------- Instagram

/**
 * The kinds it does on its own on Instagram, in order (its kit's `runs.auto`): comments go through `sends`, as
 * messages do, and follow requests from private accounts are theirs to confirm.
 */
export const INSTAGRAM_AUTO: readonly TodayKind[] = ['warm_up', 'friend_request'];
/**
 * The once-a-day jobs on Instagram, in order: the newest followers first (`requests`: on Instagram, who followed back
 * is who accepted), then who followed back seen on their own accounts (`follow_backs`), from 0.97.0 unfollowing who
 * didn't follow back as the person chose (`tidy`, decision 98), the checks, the chats, Find partners, and from part 15
 * the day's hashtags and places (`posts`) and the notifications' warm leads (`helpful`, as Alignable's are). From
 * 0.95.0 (decision 92) who liked and commented on the good posts the hashtags found (`post_people`), and last the
 * people found by topic checked for good fits (`found_checks`). From 0.101.0 the week's helpful post asked for after
 * the warm leads (`weekly_post`, decision 109). From 0.102.0 accounts like the business's after the hashtags
 * (`like_yours`, decision 110): searched for, and one read, its posts and its followers. From 0.140.0 HandsFreeOS's
 * own comment research after the day's finding (`comment_research`, decision 166), in batches through the day: only
 * for whoever of HandsFreeOS's staff started one, and nothing for anyone else; from 0.154.0 first whenever its batch is
 * due, outside the working hours too (decision 194, `researchNext`).
 */
export const INSTAGRAM_DAILY = [
  'requests',
  'follow_backs',
  'tidy',
  'checks',
  'chats',
  'partners',
  'posts',
  'like_yours',
  'helpful',
  'weekly_post',
  'post_people',
  'found_checks',
  'comment_research',
  'profile',
] as const satisfies readonly RunnerJob[];
export type InstagramDaily = (typeof INSTAGRAM_DAILY)[number];
export const INSTAGRAM_DAILY_NAMES: Readonly<Record<InstagramDaily, string>> = {
  requests: 'Your newest followers',
  follow_backs: 'Who followed you back',
  tidy: 'Tidy up',
  checks: 'Check my followers',
  chats: 'Read my chats',
  partners: 'Find partners',
  posts: 'Your hashtags and places',
  like_yours: 'Accounts like yours',
  helpful: 'Who engaged with you',
  weekly_post: 'This week’s helpful post',
  post_people: 'Who liked and commented',
  found_checks: 'Check the people found',
  comment_research: 'Comment research',
  profile: 'Read my profile',
};
/**
 * Instagram's jobs that find people, done again in a round while it needs more good fits (decision 126, ./plan-rules.ts
 * `nextRound`): its hashtags with the next words, an account like yours, who liked and commented on good posts, and
 * their checks.
 */
export const INSTAGRAM_FINDING: readonly InstagramDaily[] = [
  'posts',
  'like_yours',
  'post_people',
  'found_checks',
];
/** Instagram's pace between steps: slower than LinkedIn's, as Instagram blocks fast (the plan's "The risk"). */
export const INSTAGRAM_GAP_MS = { least: 3 * 60_000, most: 8 * 60_000 } as const;

// ------------------------------------------------------------------------------------------------- Alignable

/**
 * The kinds it does on its own on Alignable, in order (its kit's `runs.auto`): comments and forum answers go through
 * `sends`, as messages do. From 0.118.0 the requests they got that HandsFreeOS says to accept, as they pressed or the
 * AI said (decision 136), are accepted on My Network's Requests.
 */
export const ALIGNABLE_AUTO: readonly TodayKind[] = ['confirm', 'warm_up', 'friend_request'];
/**
 * The once-a-day jobs on Alignable, in order, as Instagram's: the requests, the connections checked, their chats
 * (0.84.0), Find partners, their town's posts, and who engaged with them, from their notifications (`helpful`: who
 * engaged, here with no helpful post of their own). From 0.95.0 (decision 92) the person's own groups go first
 * (`my_groups`), before any search or join; after the town's posts, the search for businesses like their clients
 * (`search`), the groups found and checked, joined, their members read and their posts (`group_checks`, `join`,
 * `members`, `group_posts`); and the businesses found by topic are checked last (`found_checks`). From 0.97.0 old
 * connection requests are withdrawn after the new ones are checked, as the person chose (`tidy`, decision 98). From
 * 0.101.0 the week's helpful post is asked for after who engaged (`weekly_post`, decision 109), and from 0.104.0 the
 * events near them are read once a week before the businesses found are checked (`events`, decision 112). From
 * 0.108.0 who liked and answered the good posts found is read after the groups' posts (`post_people`, decision 116).
 * From 0.144.0 HandsFreeOS's own comment research before the profile (`comment_research`, decision 172), only for
 * whoever of its staff started one: from 0.154.0 first whenever its batch is due, outside the working hours too
 * (decision 194, `researchNext`).
 */
export const ALIGNABLE_DAILY = [
  'my_groups',
  'requests',
  'tidy',
  'checks',
  'chats',
  'partners',
  'posts',
  'search',
  'group_checks',
  'join',
  'members',
  'group_posts',
  'post_people',
  'helpful',
  'weekly_post',
  'events',
  'found_checks',
  'comment_research',
  'profile',
] as const satisfies readonly RunnerJob[];
export type AlignableDaily = (typeof ALIGNABLE_DAILY)[number];
export const ALIGNABLE_DAILY_NAMES: Readonly<Record<AlignableDaily, string>> = {
  my_groups: 'Your groups',
  requests: 'Connection requests',
  tidy: 'Tidy up',
  checks: 'Check my connections',
  chats: 'Read my chats',
  partners: 'Find partners',
  posts: 'Find posts in your town',
  search: 'Search for businesses',
  group_checks: 'Check groups',
  join: 'Join groups',
  members: 'Group members',
  group_posts: 'Posts in your groups',
  post_people: 'Who liked and answered',
  helpful: 'Who engaged with you',
  weekly_post: 'This week’s helpful post',
  events: 'Events near you',
  found_checks: 'Check the businesses found',
  comment_research: 'Comment research',
  profile: 'Read my profile',
};
/**
 * Alignable's jobs that find people, done again in a round while it needs more good fits (decision 126, ./plan-rules.ts
 * `nextRound`): its search with the next kinds of business, groups and their members, who commented on good posts, and
 * their checks.
 */
export const ALIGNABLE_FINDING: readonly AlignableDaily[] = [
  'search',
  'group_checks',
  'join',
  'members',
  'post_people',
  'found_checks',
];
/** Alignable's pace between steps: LinkedIn's, a person's (the plan's "The risk, said plainly"). */
export const ALIGNABLE_GAP_MS = { least: 2 * 60_000, most: 6 * 60_000 } as const;

// ------------------------------------------------------------------------------------------------- Threads and X

/** The networks one runner works the same way (decision 163). */
export type FollowPlatform = 'threads' | 'x';

/**
 * The kinds it does on its own there, in order (its kit's `runs.auto`): comments, and answers to replies, go through
 * `sends`, and so do Threads' messages (decision 167).
 */
export const FOLLOW_AUTO: readonly TodayKind[] = ['warm_up', 'friend_request'];
/**
 * The once-a-day jobs there, in order: the newest followers (`requests`: who followed back is who accepted), who
 * followed back seen on their own profiles, unfollowing who didn't as the person chose (`tidy`), the person's chats
 * read for the AI where it writes in them (Threads', decision 167), who replied to good posts, the people found
 * checked for good fits, from 0.144.0 HandsFreeOS's own comment research for whoever of its staff started one
 * (`comment_research`, decision 172; from 0.154.0 first whenever its batch is due, outside the working hours too,
 * decision 194), and their own profile on the 1st of the month. Its search isn't one: it goes every hour.
 */
export const FOLLOW_DAILY = [
  'requests',
  'follow_backs',
  'tidy',
  'chats',
  'post_people',
  'found_checks',
  'comment_research',
  'profile',
] as const satisfies readonly RunnerJob[];
export type FollowDaily = (typeof FOLLOW_DAILY)[number];
export const FOLLOW_DAILY_NAMES: Readonly<Record<FollowDaily, string>> = {
  requests: 'Your newest followers',
  follow_backs: 'Who followed you back',
  tidy: 'Tidy up',
  chats: 'Read my chats',
  post_people: 'Who replied to good posts',
  found_checks: 'Check the people found',
  comment_research: 'Comment research',
  profile: 'Read my profile',
};
/** Its once-a-day jobs on a network: its chats only where it writes in them (Threads', decision 167). */
export const followDailyOn = (platform: FollowPlatform): readonly FollowDaily[] =>
  FOLLOW_DAILY.filter((job) => job !== 'chats' || NETWORKS[platform].messages);
/** Its jobs that find people, done again in a round while it needs more good fits (decision 126). */
export const FOLLOW_FINDING: readonly FollowDaily[] = ['post_people', 'found_checks'];
/** Its pace between steps: as Instagram's, as both networks limit accounts that go fast. */
export const FOLLOW_GAP_MS = { least: 3 * 60_000, most: 8 * 60_000 } as const;

// ------------------------------------------------------------------------------------------------- every network

/** A network's runner, as the plan reads it. */
export interface RunnerKit {
  /** The kinds of step it does on its own there: the list's `auto` is narrowed to these. */
  readonly auto: readonly TodayKind[];
  /** Its once-a-day jobs, in order. */
  readonly daily: readonly RunnerJob[];
  /** What each is called. */
  readonly names: Readonly<Partial<Record<RunnerJob, string>>>;
  /** Its jobs that find people, done again in a round while it needs more good fits (decision 126). */
  readonly finding: readonly RunnerJob[];
  /** Its pace between two parts of the day's reading, and the least between two steps on the list. */
  readonly pace: { readonly least: number; readonly most: number };
  /** A step on the list never follows another sooner than its pace: every network but Facebook. */
  readonly paced: boolean;
  /** It writes in people's messages there: on X only its steps and comments go. */
  readonly messages: boolean;
  /** In the hours, every hour or two, it looks at the newest posts in the person's groups (decision 49): Facebook. */
  readonly watches: boolean;
  /** It searches for posts every hour (decision 163): Threads and X. */
  readonly searches: boolean;
  /** It puts the helpful post up on its own where the person lets it (decision 50): Facebook and LinkedIn. */
  readonly posts: boolean;
}

const follow = (platform: FollowPlatform): RunnerKit => ({
  auto: FOLLOW_AUTO,
  daily: followDailyOn(platform),
  names: FOLLOW_DAILY_NAMES,
  finding: FOLLOW_FINDING,
  pace: FOLLOW_GAP_MS,
  paced: true,
  messages: NETWORKS[platform].messages,
  watches: false,
  searches: true,
  posts: false,
});

export const RUNNERS: Readonly<Record<Platform, RunnerKit>> = {
  facebook: {
    auto: AUTO_KINDS,
    daily: DAILY_JOBS,
    names: DAILY_NAMES,
    finding: FINDING_JOBS,
    pace: STARTED_GAP_MS,
    paced: false,
    messages: true,
    watches: true,
    searches: false,
    posts: true,
  },
  linkedin: {
    auto: LINKEDIN_AUTO,
    daily: LINKEDIN_DAILY,
    names: LINKEDIN_DAILY_NAMES,
    finding: LINKEDIN_FINDING,
    pace: LINKEDIN_GAP_MS,
    paced: true,
    messages: true,
    watches: false,
    searches: false,
    posts: true,
  },
  instagram: {
    auto: INSTAGRAM_AUTO,
    daily: INSTAGRAM_DAILY,
    names: INSTAGRAM_DAILY_NAMES,
    finding: INSTAGRAM_FINDING,
    pace: INSTAGRAM_GAP_MS,
    paced: true,
    messages: true,
    watches: false,
    searches: false,
    posts: false,
  },
  alignable: {
    auto: ALIGNABLE_AUTO,
    daily: ALIGNABLE_DAILY,
    names: ALIGNABLE_DAILY_NAMES,
    finding: ALIGNABLE_FINDING,
    pace: ALIGNABLE_GAP_MS,
    paced: true,
    messages: true,
    watches: false,
    searches: false,
    posts: false,
  },
  threads: follow('threads'),
  x: follow('x'),
};
