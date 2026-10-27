/**
 * Problem reports (supabase/migrations/20261027008100_problem_reports.sql): what one of HandsFreeOS's own tools saw
 * when something didn't go, sent on the person's behalf with `problem_report.send`, and read by staff on the support
 * desk's Problem reports page (`platform.problem_report.list` and `.get`), where each is marked handled
 * (`problem_report.set_handled`). Any add-on's tool may send one: its id is a label, never a key into it.
 *
 * A report never holds what a person wrote: what was found is counts, yes or no and the network's own section names;
 * the outline has tags, roles and the network's own words, with everything a person wrote as "[2 words]".
 *
 * Browser-safe and light (zod alone): the browser extension builds its reports from these.
 */
import { z } from 'zod';

/** The longest outline kept: a LinkedIn feed's is about 130,000 characters. */
export const PROBLEM_OUTLINE_MOST = 200_000;
/** How long a report is kept, handled or not (the worker's `problem_reports.clean_up`). */
export const PROBLEM_KEEP_DAYS = 30;
/** The most one person's tools send in a day; past it, a report isn't kept. */
export const PROBLEM_REPORTS_A_DAY = 500;
/** The most things a report says it found: a tool that saw more keeps what matters most (the extension's report.ts). */
export const PROBLEM_FOUND_MOST = 40;

/** What sent it. */
export const PROBLEM_SOURCES = ['extension', 'web', 'phone'] as const;
export type ProblemSource = (typeof PROBLEM_SOURCES)[number];

/** What a tool found on a page: counts, yes or no, and the network's own section names. Never words. */
const foundValue = z.union([
  z.number().int().min(0).max(100_000),
  z.boolean(),
  z.array(z.string().trim().max(60)).max(40),
]);
export const ProblemFound = z
  .record(z.string().regex(/^[a-z][a-zA-Z]{0,39}$/), foundValue)
  .refine(
    (found) => Object.keys(found).length <= PROBLEM_FOUND_MOST,
    `At most ${PROBLEM_FOUND_MOST} things found.`,
  );
export type ProblemFound = z.output<typeof ProblemFound>;

/** One report, as a tool sends it. */
export const ProblemReport = z.object({
  /** The add-on the tool belongs to ("outreach"); null for core's own. */
  addonId: z
    .string()
    .regex(/^[a-z]{2,16}$/, 'Not an add-on.')
    .nullable()
    .default(null),
  source: z.enum(PROBLEM_SOURCES),
  /** Where: the network ("linkedin") or the part of the app. */
  area: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Not an area.'),
  /** What it was doing: an ask's kind, or a day's step ("like"). */
  job: z.string().trim().min(1).max(40),
  /** The tool's own id for that, when it has one (an ask's). */
  ref: z.string().trim().max(100).nullable().default(null),
  version: z.string().trim().max(20).nullable().default(null),
  /** The page's kind as the tool names it ("own-profile", "feed"…). */
  page: z.string().trim().min(1).max(40),
  /** Its address, people's and groups' parts as {1}, {2}… */
  path: z.string().trim().max(500).default(''),
  /** Whether Chrome showed it; null when the tool couldn't tell. */
  shown: z.boolean().nullable().default(null),
  found: ProblemFound.default({}),
  /** What went wrong, in a line, in the tool's own words. */
  note: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .default(null)
    .transform((n) => n || null),
  outline: z.string().max(PROBLEM_OUTLINE_MOST).nullable().default(null),
});
export type ProblemReport = z.input<typeof ProblemReport>;

export const ProblemReportSendInput = z.object({ workspaceId: z.uuid(), report: ProblemReport });
export type ProblemReportSendInput = z.input<typeof ProblemReportSendInput>;
export const ProblemReportSendOutput = z.object({ reportId: z.uuid() });

// ---------- the desk ----------

export const PROBLEM_STATES = ['open', 'handled', 'all'] as const;
export type ProblemState = (typeof PROBLEM_STATES)[number];

export const ProblemReportListInput = z.object({
  state: z.enum(PROBLEM_STATES).default('open'),
  /** One area, or every one. */
  area: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .nullable()
    .default(null),
  /** The page after the one that ended with this report's time. */
  before: z.iso.datetime().nullable().default(null),
  limit: z.int().min(1).max(50).default(25),
});

const ProblemReportFields = {
  reportId: z.uuid(),
  at: z.iso.datetime(),
  workspaceId: z.uuid(),
  business: z.string(),
  addonId: z.string().nullable(),
  source: z.enum(PROBLEM_SOURCES),
  area: z.string(),
  job: z.string(),
  ref: z.string().nullable(),
  version: z.string().nullable(),
  page: z.string(),
  path: z.string(),
  shown: z.boolean().nullable(),
  note: z.string().nullable(),
  handledAt: z.iso.datetime().nullable(),
};

export const ProblemReportRow = z.object({ ...ProblemReportFields, hasOutline: z.boolean() });
export type ProblemReportRow = z.output<typeof ProblemReportRow>;

export const ProblemReportListOutput = z.object({
  reports: z.array(ProblemReportRow),
  /** Ask for the next page with this as `before`; null when this was the last. */
  nextBefore: z.iso.datetime().nullable(),
  /** Every area with a report, and how many there are open. */
  areas: z.array(z.object({ area: z.string(), open: z.int() })),
});

export const ProblemReportGetInput = z.object({ reportId: z.uuid() });
export const ProblemReportGetOutput = z.object({
  ...ProblemReportFields,
  found: z.record(z.string(), z.unknown()),
  outline: z.string().nullable(),
  /** Who marked it handled, when they have a name. */
  handledBy: z.string().nullable(),
});
export type ProblemReportFull = z.output<typeof ProblemReportGetOutput>;

export const ProblemReportSetHandledInput = z.object({
  reportIds: z.array(z.uuid()).min(1).max(100),
  handled: z.boolean(),
});
export const ProblemReportSetHandledOutput = z.object({
  /** The reports it changed: one already as asked is left alone. */
  changed: z.array(z.uuid()),
});
