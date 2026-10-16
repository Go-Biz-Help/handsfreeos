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
  checkupAbout: (name: string) =>
    `If something on ${name} isn’t read right, press this once. Your computer opens your profile, your feed, your connections, a search, your messages and one connection’s profile, reads each without pressing anything, and sends HandsFreeOS a note of what it found, with names and words left out. Its window comes to the front for about a minute.`,
} as const;
