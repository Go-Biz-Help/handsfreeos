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

// ---------- the AI helper ----------

/**
 * How the AI helper sorted a step that didn't go (docs/outreach.md, decision 142): something was in the way (a pop-up,
 * a window over the button, a page still loading); the step's button was there in a new place or under new words (a
 * layout difference); the network refused it (or a limit); a warning; or it couldn't tell.
 */
export const HELPER_VERDICTS = ['in_the_way', 'moved', 'refused', 'warning', 'unclear'] as const;
export type HelperVerdict = (typeof HELPER_VERDICTS)[number];

/** How it ended: cleared and the step went on the tool's own try; the helper pressed the step's button; or reported. */
export const HELPER_RESULTS = ['fixed_itself', 'done_by_helper', 'reported'] as const;
export type HelperResult = (typeof HELPER_RESULTS)[number];

/** What the helper may do on the page, a move at a time. `press` is the step's own button, found in a new place. */
export const HELPER_MOVES = ['click', 'scroll', 'escape', 'wait', 'press'] as const;
export type HelperMove = (typeof HELPER_MOVES)[number];

/**
 * Why it didn't look at all (decision 144): this computer's looks for the day were used, the page couldn't be read for
 * it, the AI wasn't asked (its limit, the business's balance, busy: `said` has HandsFreeOS's words), or HandsFreeOS
 * didn't answer (`said` has what went wrong).
 */
export const HELPER_NOT_LOOKED = ['looks_used', 'no_view', 'not_asked', 'no_answer'] as const;
export type HelperNotLooked = (typeof HELPER_NOT_LOOKED)[number];

/** The most moves it takes on one step, and the most looks a report keeps. */
export const HELPER_MOVES_MOST = 8;

/** What the AI helper did on a step that didn't go, kept with its report. Never a name or anything a person wrote. */
export const ProblemHelper = z.object({
  verdict: z.enum(HELPER_VERDICTS),
  result: z.enum(HELPER_RESULTS),
  /** What was in the way, or what changed and where, in the helper's words: the network's, never a person's. */
  said: z.string().trim().max(400),
  /** Its moves in order: what it did, to what (the element's line from the page's view), and whether it went. */
  moves: z
    .array(
      z.object({
        do: z.enum(HELPER_MOVES),
        on: z.string().trim().max(200).nullable(),
        went: z.boolean(),
      }),
    )
    .max(HELPER_MOVES_MOST + 4),
  /** A way it learned before was tried first: whether it worked. Null when there was none. */
  learned: z.enum(['worked', 'failed']).nullable().default(null),
  /** How many times it looked at the page. */
  looks: z.int().min(0).max(20),
  /** Why it didn't look, when it didn't (`looks` 0). Null when it looked, and on a report from before it. */
  notLooked: z.enum(HELPER_NOT_LOOKED).nullable().default(null),
});
export type ProblemHelper = z.output<typeof ProblemHelper>;

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
  /** What the AI helper did, when it looked (decision 142). */
  helper: ProblemHelper.nullable().default(null),
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

export const ProblemReportRow = z.object({
  ...ProblemReportFields,
  hasOutline: z.boolean(),
  /** How the AI helper sorted it and how it ended, when it looked. */
  helper: z.object({ verdict: z.enum(HELPER_VERDICTS), result: z.enum(HELPER_RESULTS) }).nullable(),
});
export type ProblemReportRow = z.output<typeof ProblemReportRow>;

/** How many days the desk's count of reports by step goes back. */
export const PROBLEM_STEP_DAYS = 7;

/** The reports of the last week on one area and job: how many, how many open, and how the helper sorted them. */
export const ProblemStep = z.object({
  area: z.string(),
  job: z.string(),
  reports: z.int(),
  open: z.int(),
  inTheWay: z.int(),
  moved: z.int(),
  refused: z.int(),
  fixed: z.int(),
  doneByHelper: z.int(),
});
export type ProblemStep = z.output<typeof ProblemStep>;

export const ProblemReportListOutput = z.object({
  reports: z.array(ProblemReportRow),
  /** Ask for the next page with this as `before`; null when this was the last. */
  nextBefore: z.iso.datetime().nullable(),
  /** Every area with a report, and how many there are open. */
  areas: z.array(z.object({ area: z.string(), open: z.int() })),
  /** The last week's reports by step, the most first (`PROBLEM_STEP_DAYS`). */
  steps: z.array(ProblemStep),
});

export const ProblemReportGetInput = z.object({ reportId: z.uuid() });
export const ProblemReportGetOutput = z.object({
  ...ProblemReportFields,
  found: z.record(z.string(), z.unknown()),
  outline: z.string().nullable(),
  /** Who marked it handled, when they have a name. */
  handledBy: z.string().nullable(),
  /** What the AI helper did, when it looked; null for a report from before it, or one it didn't look at. */
  helper: ProblemHelper.nullable(),
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

// ---------- learned ways ----------

/**
 * How the AI helper found a step's button in a new place (decision 142), so the next computer finds it there without
 * the AI: the element's tag and role, the network's own words on it and in its label (a person's as "[…]", and the
 * person the step is for as "(their name)"), the part of the page it sits in, and the menu it's under when it had to
 * be opened first. Never anything a person wrote.
 */
export const LearnedWayShape = z.object({
  tag: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  role: z.string().trim().max(40).nullable(),
  label: z.string().trim().max(120).nullable(),
  words: z.string().trim().max(120).nullable(),
  inside: z.string().trim().max(40).nullable(),
  menu: z
    .object({
      tag: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
      role: z.string().trim().max(40).nullable(),
      label: z.string().trim().max(120).nullable(),
      words: z.string().trim().max(120).nullable(),
    })
    .nullable(),
});
export type LearnedWayShape = z.output<typeof LearnedWayShape>;

/** One way, as the support desk lists it. */
export const LearnedWayRow = z.object({
  wayId: z.uuid(),
  addonId: z.string().nullable(),
  area: z.string(),
  button: z.string(),
  way: LearnedWayShape,
  worked: z.int(),
  failed: z.int(),
  /** How many businesses it worked for. */
  businesses: z.int(),
  trustedAt: z.iso.datetime().nullable(),
  removedAt: z.iso.datetime().nullable(),
  firstAt: z.iso.datetime(),
  lastWorkedAt: z.iso.datetime().nullable(),
  lastFailedAt: z.iso.datetime().nullable(),
});
export type LearnedWayRow = z.output<typeof LearnedWayRow>;

export const LearnedWayListInput = z.object({
  area: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .nullable()
    .default(null),
});
export const LearnedWayListOutput = z.object({ ways: z.array(LearnedWayRow) });

export const LearnedWaySetRemovedInput = z.object({
  wayIds: z.array(z.uuid()).min(1).max(100),
  removed: z.boolean(),
});
export const LearnedWaySetRemovedOutput = z.object({
  /** The ways it changed: one already as asked is left alone. */
  changed: z.array(z.uuid()),
});
