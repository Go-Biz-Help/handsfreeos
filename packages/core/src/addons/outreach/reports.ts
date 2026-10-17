/**
 * What the app says when a computer can't do an ask on a network: Chrome hasn't let the extension on it yet. And
 * **Check LinkedIn** and **Check Facebook** (docs/outreach.md, decisions 74, 76 and 77): one press that reads the
 * person's main pages on the network, tries each step up to its last press, and sends HandsFreeOS a problem report of
 * each. The extension's notes of what it saw are core's problem reports
 * (schemas/problem-report.ts, sent with `problem_report.send`, read on the support desk); this add-on keeps none.
 * Browser-safe: the extension, the web, the phone and the server read these.
 */
import { NETWORKS, type Platform } from './networks';

/**
 * Whether a computer may work a network as it last said: Chrome lets the extension on it (Facebook always: its sites
 * are the extension's own). A build that doesn't say (`allowed` null) may.
 */
export const allowedOn = (allowed: readonly Platform[] | null | undefined, platform: Platform) =>
  allowed == null || allowed.includes(platform);

const listed = (items: readonly string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
    : (items[0] ?? '');

export const REPORT_WORDS = {
  /** Under an ask its computer can't do yet, and on the computer's card. */
  notAllowed: (computer: string, platform: Platform) => {
    const name = NETWORKS[platform].name;
    return `${computer} isn’t allowed on ${name} yet. Open the extension’s panel on a ${name} page and press Allow on ${name}, then Allow in Chrome’s box.`;
  },
  /** Check LinkedIn or Check Facebook, on the network's page in Settings. */
  checkupTitle: (name: string) => `Check ${name}`,
  /** How Check LinkedIn ended: the pages it noted, and those it read nothing on. */
  checkupDone: (name: string, pages: number, nothingOn: readonly string[]) =>
    `Checked ${pages} ${name} pages and sent HandsFreeOS a note of each.${
      nothingOn.length ? ` Nothing was read on ${listed(nothingOn)}.` : ''
    }`,
  /**
   * How Check LinkedIn ended, now that it tries each step too (decision 76): the pages it read, the steps that don't
   * work and those it found nothing to try on, by name. What each found is in its own note; the line fits an ask's 300.
   */
  checkupTried: (
    name: string,
    pages: number,
    broken: readonly TryStepName[],
    untried: readonly TryStepName[],
    tried: number,
  ) => {
    const named = (steps: readonly TryStepName[]) => listed(steps.map((s) => TRY_STEP_NAMES[s]));
    const parts = [`Read ${pages} ${name} pages and tried ${tried} steps up to their last press.`];
    if (!broken.length) parts.push(untried.length ? 'Each one tried works.' : 'Everything works.');
    else parts.push(`Not working: ${named(broken)}.`);
    if (untried.length) parts.push(`Nothing to try on: ${named(untried)}.`);
    return parts.join(' ').slice(0, 300);
  },
  /** What the button does on a network, under its title: what it reads, what it tries, and what it never does. */
  checkupAbout: (platform: Platform) => CHECKUP_ABOUT[platform],
} as const;

const CHECKUP_ABOUT: Readonly<Record<Platform, string>> = {
  facebook:
    'If something on Facebook isn’t working, press this once. Your computer reads your profile, feed, friends, friend requests, groups, searches and chats, then tries each step up to its last press: your bio, a post in a group, a comment, a friend request, a message, a like, confirming and cancelling requests, unfriending, joining a group and your Facebook file. It never saves, posts, sends, likes, adds, joins or removes anything, and it tells HandsFreeOS what works and what doesn’t, with names and words left out. Its window comes to the front for about four minutes.',
  linkedin:
    'If something on LinkedIn isn’t working, press this once. Your computer reads your profile, feed, connections, a search and your messages, then tries each step up to its last press: your headline, a post, a comment, connecting, a message, a like and withdrawing. It never saves, posts, sends, likes or connects anything, and it tells HandsFreeOS what works and what doesn’t, with names and words left out. Its window comes to the front for about three minutes.',
};

/** The steps Check LinkedIn (decision 76) and Check Facebook (decision 77) try, as their lines name them. */
export const TRY_STEP_NAMES = {
  headline: 'your headline',
  bio: 'your bio',
  post: 'posting',
  comment: 'commenting',
  connect: 'connecting',
  request: 'friend requests',
  message: 'messaging',
  like: 'liking',
  confirm: 'confirming requests',
  withdraw: 'withdrawing',
  cancel: 'cancelling requests',
  unfriend: 'unfriending',
  join: 'joining groups',
  file: 'the data file',
} as const;
export type TryStepName = keyof typeof TRY_STEP_NAMES;
