/**
 * Find people (docs/outreach.md, decision 128): a card for each way Social Outreach finds new people, with what it
 * found for the person in the last week and how many the AI's check called a good fit (`outreach.finds.week`). The web
 * page and the phone's screen read the same cards, in the same order, from here. What's changed about a way stays where
 * it's kept: the groups on their own list, the words searched in the playbook, the accounts like yours on this page.
 *
 * Browser-safe and pure.
 */
import type { FindHow, FindsWeekOutput } from './finds';
import type { Platform } from './networks';

export const FIND_WAY_KEYS = [
  'groups',
  'posts',
  'searches',
  'like_yours',
  'events',
  'followers',
  'partners',
] as const;
export type FindWay = (typeof FIND_WAY_KEYS)[number];

/** Each way: its name, what it is, and the networks it's on. */
export const FIND_WAYS: Readonly<
  Record<
    FindWay,
    { readonly title: string; readonly about: string; readonly on: readonly Platform[] }
  >
> = {
  groups: {
    title: 'Groups',
    about: 'People in the groups you work, once each group’s admins are saved.',
    on: ['facebook', 'linkedin', 'alignable'],
  },
  posts: {
    title: 'Good posts',
    about: 'People who wrote, commented on or liked a post the AI called good.',
    on: ['instagram', 'linkedin', 'alignable'],
  },
  searches: {
    title: 'Searches',
    about:
      'Hashtags on Instagram, words on LinkedIn and kinds of business on Alignable, from your playbooks.',
    on: ['instagram', 'linkedin', 'alignable'],
  },
  like_yours: {
    title: 'Accounts like yours',
    about: 'People who follow accounts like yours on Instagram, checked each week.',
    on: ['instagram'],
  },
  events: {
    title: 'Events near you',
    about: 'People hosting or going to events near you on Alignable.',
    on: ['alignable'],
  },
  followers: {
    title: 'Your followers',
    about: 'People who follow you on Facebook but aren’t your friends yet.',
    on: ['facebook'],
  },
  partners: {
    title: 'Partners',
    about: 'People with a big audience that fits, found to partner with.',
    on: ['facebook', 'linkedin', 'instagram', 'alignable'],
  },
};

/** The ways people found by topic count toward: the rest are counted on their own. */
const HOWS: Partial<Record<FindWay, readonly FindHow[]>> = {
  groups: ['member'],
  posts: ['posted', 'commented', 'liked'],
  searches: ['searched'],
  like_yours: ['follows'],
  events: ['event'],
};

export interface FindWayCount {
  readonly found: number;
  readonly good: number;
  readonly maybe: number;
}

/** What each way found in the week: a group's members checked count with those found in groups. */
export function findWayCounts(week: FindsWeekOutput): Record<FindWay, FindWayCount> {
  const sum = (hows: readonly FindHow[], plus: FindWayCount = { found: 0, good: 0, maybe: 0 }) =>
    week.ways
      .filter((w) => hows.includes(w.how))
      .reduce(
        (a, w) => ({ found: a.found + w.found, good: a.good + w.good, maybe: a.maybe + w.maybe }),
        plus,
      );
  return {
    groups: sum(HOWS.groups!, week.members),
    posts: sum(HOWS.posts!),
    searches: sum(HOWS.searches!),
    like_yours: sum(HOWS.like_yours!),
    events: sum(HOWS.events!),
    followers: week.followers,
    partners: { found: week.partners, good: 0, maybe: 0 },
  };
}

const n = (count: number) => count.toLocaleString('en-US');

/** A card's line: "118 found this week · 31 good fits", or that nothing came this week. */
export function findWayLine(way: FindWay, count: FindWayCount): string {
  if (way === 'partners')
    return count.found ? `${n(count.found)} found this week` : 'None found this week';
  if (!count.found) return 'Nothing found this week';
  const fits = count.good === 1 ? '1 good fit' : `${n(count.good)} good fits`;
  return `${n(count.found)} found this week · ${fits}`;
}

/** The words on the page, beside the cards. */
export const FIND_PAGE_WORDS = {
  week: 'This week',
  weekAbout:
    'What each way found for you in the last 7 days, and how many the AI called a good fit.',
  openGroups: 'Open groups',
  editWords: 'Change them in the playbook',
  wordsTitle: 'What it searches for',
  wordsNone: 'No words to search for yet. Add some in a playbook’s Where do you find them.',
  seePartners: 'See partners',
  fileTitle: 'Old friends and chats',
  fileAbout:
    'Facebook’s download of your account brings in since when you’ve been friends, and your latest message with each.',
  postsTitle: 'Posts asking for what you offer',
  admins: (count: number) =>
    count === 1
      ? '1 group needs its admins saved before anyone there is suggested.'
      : `${n(count)} groups need their admins saved before anyone there is suggested.`,
  saveAdmins: 'Save them',
} as const;
