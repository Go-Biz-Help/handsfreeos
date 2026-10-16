/**
 * What the extension saw (docs/outreach.md, decision 74): a note from the person's computer of each page a job read,
 * so a reader that misses something on a network's real pages is found from what the computer sent, not from the
 * person describing it. Each note has the page's kind and its address with people's and groups' parts as {1}, {2}…,
 * whether its window was in front (Chrome draws nothing in a window hidden behind another), what the readers found
 * there (counts and the network's own section names, never words), a line on what it couldn't find, and, when
 * something was missing or the person asked for **Check LinkedIn**, the page's outline: tags, roles and the network's
 * own words, with everything a person wrote as "[2 words]" (the extension's src/networks/outline.ts). Each person's
 * own; it goes with its ask, and a day's step's after a week (`outreach.live_prune`).
 *
 * And what the app says when a computer can't do an ask on a network: Chrome hasn't let the extension on it yet.
 * Browser-safe: the extension, the web, the phone and the server read these.
 */
import { z } from 'zod';
import { NETWORKS, PLATFORM_KEYS, type Platform } from './networks';

/** The longest outline kept: a LinkedIn feed's is about 130,000 characters. */
export const REPORT_OUTLINE_MOST = 200_000;

/** What the readers found on a page: counts, yes or no, and the network's own section names. Never words. */
const foundValue = z.union([
  z.number().int().min(0).max(100_000),
  z.boolean(),
  z.array(z.string().trim().max(60)).max(40),
]);
export const ReportFound = z
  .record(z.string().regex(/^[a-z][a-zA-Z]{0,39}$/), foundValue)
  .refine((found) => Object.keys(found).length <= 40, 'At most 40 things found.');
export type ReportFound = z.output<typeof ReportFound>;

/** One page as the computer saw it. */
export const PageReport = z.object({
  platform: z.enum(PLATFORM_KEYS),
  /** The ask it was for; null for a step of the person's day. */
  askId: z.uuid().nullable().default(null),
  /** The ask's kind, or the day's step. */
  job: z.string().trim().min(1).max(40),
  version: z.string().trim().max(20).nullable().default(null),
  /** The page's kind as the readers name it ("own-profile", "feed"…). */
  page: z.string().trim().min(1).max(40),
  /** Its address, people's and groups' parts as {1}, {2}… */
  path: z.string().trim().max(500),
  /** Whether Chrome showed it; null when the build couldn't tell. */
  shown: z.boolean().nullable().default(null),
  found: ReportFound.default({}),
  /** What it couldn't find, in a line. */
  note: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .default(null)
    .transform((n) => n || null),
  outline: z.string().max(REPORT_OUTLINE_MOST).nullable().default(null),
});
export type PageReport = z.input<typeof PageReport>;

export const ReportSaveInput = z.object({ workspaceId: z.uuid(), report: PageReport });
export type ReportSaveInput = z.input<typeof ReportSaveInput>;
export const ReportSaveOutput = z.object({ reportId: z.uuid() });
export type ReportSaveOutput = z.output<typeof ReportSaveOutput>;

/** How long a day's step's notes are kept; an ask's go with it, after the same week. */
export const REPORT_KEEP_DAYS = 7;

/**
 * Whether a computer may work a network as it last said: Chrome lets the extension on it (Facebook always: its sites
 * are the extension's own). A build that doesn't say (`allowed` null) may.
 */
export const allowedOn = (allowed: readonly Platform[] | null | undefined, platform: Platform) =>
  allowed == null || allowed.includes(platform);

export const REPORT_WORDS = {
  /** Under an ask its computer can't do yet, and on the computer's card. */
  notAllowed: (computer: string, platform: Platform) => {
    const name = NETWORKS[platform].name;
    return `${computer} isn’t allowed on ${name} yet. Open the extension’s panel on a ${name} page and press Allow on ${name}, then Allow in Chrome’s box.`;
  },
  /** Check LinkedIn, on the network's page in Settings. */
  checkupTitle: (name: string) => `Check ${name}`,
  checkupAbout: (name: string) =>
    `If something on ${name} isn’t read right, press this once. Your computer opens your profile, your feed, your connections, a search, your messages and one connection’s profile, reads each without pressing anything, and sends HandsFreeOS a note of what it found, with names and words left out. Its window comes to the front for about a minute.`,
} as const;
