/**
 * What the app says when a computer can't do an ask on a network: Chrome hasn't let the extension on it yet. And
 * **Check LinkedIn** (docs/outreach.md, decision 74): one press that reads the person's main LinkedIn pages and sends
 * HandsFreeOS a problem report of each. The extension's notes of what it saw are core's problem reports
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
  /** Check LinkedIn, on the network's page in Settings. */
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
  checkupAbout: (name: string) =>
    `If something on ${name} isn’t working, press this once. Your computer reads your profile, feed, connections, a search and your messages, then tries each step up to its last press: your headline, a post, a comment, connecting, a message, a like and withdrawing. It never saves, posts, sends, likes or connects anything, and it tells HandsFreeOS what works and what doesn’t, with names and words left out. Its window comes to the front for about three minutes.`,
} as const;

/** The steps Check LinkedIn tries (decision 76), as its line names them. */
export const TRY_STEP_NAMES = {
  headline: 'your headline',
  post: 'posting',
  comment: 'commenting',
  connect: 'connecting',
  message: 'messaging',
  like: 'liking',
  withdraw: 'withdrawing',
  file: 'the data file',
} as const;
export type TryStepName = keyof typeof TRY_STEP_NAMES;
