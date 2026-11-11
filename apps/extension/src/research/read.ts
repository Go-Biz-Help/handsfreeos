/**
 * What every network's reading shares for AI Social Media Content Creator (docs/socialcontent.md, "When a read goes
 * wrong"; ./run.ts): a person's pace, the day's room on each network, the network's warnings, and the AI helper with
 * its problem report when a read doesn't work.
 *
 * - **A person's pace.** A wait between pages and between answers, never the same twice, and at most
 *   `RESEARCH_STEPS_A_DAY` pages and answers on a network a day; past that, reading there waits till tomorrow.
 *   Searches for new creators may use only `RESEARCH_SEARCH_STEPS_A_DAY` of them: the rest is kept for reading the
 *   creators someone ticks or adds, so one ticked late in the day is still read that day.
 * - **Warnings stop the network for the day,** for both social add-ons: they're kept where Social Outreach keeps its
 *   own (src/hfos/warned.ts), since it's the same browser and the same account (decision 1). It never tries to get
 *   around a warning or a check.
 * - **The AI helper** (core's addons/socialcontent/helper.ts): when a read doesn't work, the tab sends a view of the
 *   page with everything a person wrote hidden, the worker's AI sorts what it sees and takes one move at a time to
 *   clear the way (a pop-up's Close, Escape, a scroll, a wait), and the read is tried once more when it cleared
 *   something. A computer's helper looks at most `RESEARCH_LOOKS_A_DAY` times a day for reading.
 * - **The problem report** (core's `problem_report.send`, addon `socialcontent`): what was read, Instagram's answer's
 *   status, the page's outline and what the helper did, for HandsFreeOS's staff to fix the reader. Never a name.
 * - **What it's doing** (`Progress`, `socialcontent.work.progress`): what it's at, the searches done, and how many
 *   accounts, profiles and posts it read, for the Creators page, at once when what it's at changes, else at most
 *   every `PROGRESS_EVERY_MS`.
 */
import {
  HELPER_MOVES_MOST,
  HELPER_VIEW_MOST,
  PROBLEM_OUTLINE_MOST,
  type HelperNotLooked,
  type ProblemHelper,
} from '@hfos/core/problem-report';
import type { ReadKind } from '@hfos/core/addons/socialcontent/helper';
import type { ContentNetwork } from '@hfos/core/addons/socialcontent/networks';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { keepWarning, warnedNow } from '../hfos/warned';
import type { PageRead } from '../networks';
import { reportFound, sectionsIn } from '../jobs/report';
import type { WorkProgressSaid } from '@hfos/core/addons/socialcontent/shapes';
import {
  helperLook,
  reportProblem,
  ResearchRefused,
  workProgress,
  type ResearchWork,
} from './hfos';
import type { ResearchTab } from './tab';

/** Pages opened and answers asked for on one network in a day, at most. */
export const RESEARCH_STEPS_A_DAY = 400;
/**
 * Of those, what searches for new creators may use. The rest is kept for reading the creators someone ticks or adds
 * (a profile, their posts, a video): a day's searches had used it all, so creators ticked that afternoon waited till
 * the next day (9 Nov 2026).
 */
export const RESEARCH_SEARCH_STEPS_A_DAY = 300;
/** The helper's looks a day for reading, every network together. */
export const RESEARCH_LOOKS_A_DAY = 30;
/**
 * A person's pace: between pages it opens (going from one to the next), between answers on one page (scrolling on),
 * and after a helper's move while the page redraws. The tests make it quick.
 */
export const RESEARCH_PACE = {
  openMs: [6_000, 12_000] as readonly [number, number],
  answerMs: [3_000, 7_000] as readonly [number, number],
  settleMs: 1_200,
};

const DAY_KEY = 'hfos-research-day';
const LOOKS_KEY = 'hfos-research-looks';
const today = () => new Date().toLocaleDateString('en-CA');

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
export const paced = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low);

/** How often, at most, it says how a read is going while what it's at stays the same. */
export const PROGRESS_EVERY_MS = 15_000;

/**
 * What a read is doing, said to HandsFreeOS as it goes for the Creators page: at once when what it's at changes (or
 * when told to), else at most every `PROGRESS_EVERY_MS`. Saying it never stops a read.
 */
export class Progress {
  private said: WorkProgressSaid = {};
  private sentAt = 0;
  private sentNow: string | undefined = undefined;

  constructor(private readonly ctx: { businessId: string; work: { id: string } }) {}

  get value(): WorkProgressSaid {
    return this.said;
  }

  async say(patch: WorkProgressSaid, now = false): Promise<void> {
    this.said = { ...this.said, ...patch };
    const moved = this.said.now !== this.sentNow;
    if (!now && !moved && Date.now() - this.sentAt < PROGRESS_EVERY_MS) return;
    this.sentAt = Date.now();
    this.sentNow = this.said.now;
    try {
      await workProgress(this.ctx.businessId, this.ctx.work.id, {
        ...this.said,
        ...(this.said.now ? { now: this.said.now.slice(0, 160) } : {}),
      });
    } catch {
      // Out of reach, or stopped meanwhile: the read goes on, and says how it went when it ends.
    }
  }
}

/** What a read is working on. */
export interface ReadCtx {
  readonly businessId: string;
  readonly work: ResearchWork;
  readonly tab: ResearchTab;
}

/**
 * How a read ended: `failure` in words the business's people read (null when it worked), and `halt` when reading on
 * this network should stop for now (signed out, a warning, the day's room used, or its reader can't read the page).
 */
export interface ReadEnd {
  readonly failure: string | null;
  readonly halt?: 'day' | 'while';
}

/**
 * A read's step: what it got, or how it ended. `gone`: the network says it isn't there, and `why`, what it answered
 * (its status, its own short words, the names of its answer's parts), for a report.
 */
export type Got<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly end: ReadEnd;
      readonly gone?: boolean;
      readonly why?: string;
    };

/** A network's name as Social Outreach keeps its warnings (they're the same networks). */
const platformOf = (network: ContentNetwork) => network as Platform;

// ------------------------------------------------------------------------------------------------ the day's room

async function daySteps(): Promise<Partial<Record<ContentNetwork, number>>> {
  try {
    const kept = (await chrome.storage.local.get(DAY_KEY))[DAY_KEY] as
      { day?: string; steps?: Partial<Record<ContentNetwork, number>> } | undefined;
    return kept?.day === today() ? (kept.steps ?? {}) : {};
  } catch {
    return {};
  }
}

/** The day's steps on a network that work of this kind may use: searches leave the rest for ticked creators. */
const stepsFor = (kind: ResearchWork['kind']) =>
  kind === 'find' ? RESEARCH_SEARCH_STEPS_A_DAY : RESEARCH_STEPS_A_DAY;

/** Whether there's room left on a network today, and no warning on it. */
export async function roomOn(network: ContentNetwork): Promise<boolean> {
  if (await warnedNow(platformOf(network))) return false;
  return ((await daySteps())[network] ?? 0) < RESEARCH_STEPS_A_DAY;
}

/** Whether searches for new creators still have room on a network today (the rest is kept for ticked creators). */
export async function searchRoomOn(network: ContentNetwork): Promise<boolean> {
  return ((await daySteps())[network] ?? 0) < RESEARCH_SEARCH_STEPS_A_DAY;
}

/** Takes one of the day's steps on a network for work of this kind: false once its share is used. */
async function takeStep(network: ContentNetwork, kind: ResearchWork['kind']): Promise<boolean> {
  const steps = await daySteps();
  const n = steps[network] ?? 0;
  if (n >= stepsFor(kind)) return false;
  await chrome.storage.local
    .set({ [DAY_KEY]: { day: today(), steps: { ...steps, [network]: n + 1 } } })
    .catch(() => undefined);
  return true;
}

const dayUsed = (network: ContentNetwork, kind: ResearchWork['kind']): ReadEnd =>
  kind === 'find'
    ? {
        failure: `Searching ${networkName(network)} for new creators stopped for today, so the rest of the day’s reading is kept for the creators you tick. It goes on tomorrow.`,
      }
    : {
        failure: `Reading on ${networkName(network)} stopped for today, as it reads only so much a day to stay at a person’s pace. It goes on tomorrow.`,
        halt: 'day',
      };

/** Opens a page at a person's pace, then looks for the network's warnings on it. */
export async function openPage(ctx: ReadCtx, url: string): Promise<Got<null>> {
  if (!(await takeStep(ctx.work.network, ctx.work.kind)))
    return { ok: false, end: dayUsed(ctx.work.network, ctx.work.kind) };
  await pause(paced(RESEARCH_PACE.openMs));
  await ctx.tab.open(url);
  const words = (await ctx.tab.hands('warnings')) ?? [];
  if (words.length) return { ok: false, end: await warned(ctx, words) };
  return { ok: true, value: null };
}

/** Waits a person's pace before the next answer, and takes a step of the day's: false once they're used. */
export async function answerStep(ctx: ReadCtx, first: boolean): Promise<Got<null>> {
  if (!(await takeStep(ctx.work.network, ctx.work.kind)))
    return { ok: false, end: dayUsed(ctx.work.network, ctx.work.kind) };
  if (!first) await pause(paced(RESEARCH_PACE.answerMs));
  return { ok: true, value: null };
}

/**
 * A warning from the network: kept as the day's (Social Outreach stops there too), reported as the network's limit,
 * and the end of reading there today.
 */
export async function warned(ctx: ReadCtx, words: readonly string[]): Promise<ReadEnd> {
  const name = networkName(ctx.work.network);
  await keepWarning(words, platformOf(ctx.work.network)).catch(() => []);
  await report(
    ctx,
    ctx.work.kind,
    `${name} warned the account, so reading there stopped for today.`,
    {
      verdict: 'warning',
      result: 'reported',
      said: `${name} showed a warning: “${words[0]!.slice(0, 120)}”.`,
      moves: [],
      learned: null,
      looks: 0,
      notLooked: null,
    },
  );
  return {
    failure: `${name} said “${words[0]!.slice(0, 120)}”, so reading there stopped for today, for both social add-ons. It goes on tomorrow.`,
    halt: 'day',
  };
}

// ------------------------------------------------------------------------------------------------ the AI helper

async function takeLook(): Promise<boolean> {
  try {
    const kept = (await chrome.storage.local.get(LOOKS_KEY))[LOOKS_KEY] as
      { day?: string; n?: number } | undefined;
    const n = kept?.day === today() ? (kept.n ?? 0) : 0;
    if (n >= RESEARCH_LOOKS_A_DAY) return false;
    await chrome.storage.local.set({ [LOOKS_KEY]: { day: today(), n: n + 1 } });
    return true;
  } catch {
    return true;
  }
}

const notLooked = (why: HelperNotLooked | null, said = ''): ProblemHelper => ({
  verdict: 'unclear',
  result: 'reported',
  said: said.replace(/\s+/g, ' ').trim().slice(0, 400),
  moves: [],
  learned: null,
  looks: 0,
  notLooked: why,
});

/** What the helper did, and whether it cleared something in the way, so the read is worth trying once more. */
export interface HelperRun {
  readonly helper: ProblemHelper;
  readonly cleared: boolean;
}

/** The helper's looks and moves on the page, up to its last, for a read that didn't work. Never throws. */
export async function helpWith(ctx: ReadCtx, read: ReadKind, why: string): Promise<HelperRun> {
  const moves: ProblemHelper['moves'][number][] = [];
  let looks = 0;
  let verdict: ProblemHelper['verdict'] = 'unclear';
  let said = '';
  let cleared = false;
  let stopped: { why: HelperNotLooked; said: string } | null = null;
  try {
    for (let i = 0; i <= HELPER_MOVES_MOST; i++) {
      if (!(await takeLook())) {
        stopped ??= { why: 'looks_used', said: '' };
        break;
      }
      const view = await ctx.tab.hands('view', i === 0);
      if (typeof view !== 'string') {
        stopped ??= { why: 'no_view', said: '' };
        break;
      }
      let answer;
      try {
        answer = await helperLook(ctx.businessId, {
          network: ctx.work.network,
          read,
          why: why.slice(0, 300),
          view: view.slice(0, HELPER_VIEW_MOST),
          moves,
        });
      } catch (error) {
        stopped ??= {
          why: 'no_answer',
          said: error instanceof ResearchRefused ? error.message : '',
        };
        break;
      }
      if (!answer.asked) {
        stopped ??= { why: 'not_asked', said: answer.said };
        break;
      }
      looks++;
      verdict = answer.verdict;
      if (answer.said) said = answer.said;
      const move = answer.move;
      if (move.do === 'none' || move.do === 'press') break;
      const done = await ctx.tab.hands('move', { do: move.do, ref: move.ref, dir: move.dir });
      moves.push({ do: move.do, on: done?.on ?? null, went: done?.went ?? false });
      if (done?.went && verdict === 'in_the_way' && move.do !== 'wait') cleared = true;
      await pause(RESEARCH_PACE.settleMs);
    }
  } catch (error) {
    console.warn('HandsFreeOS Social’s AI helper couldn’t look', error);
  }
  if (!looks)
    return { helper: notLooked(stopped?.why ?? null, stopped?.said ?? ''), cleared: false };
  return {
    helper: { verdict, result: 'reported', said, moves, learned: null, looks, notLooked: null },
    cleared: cleared || (verdict === 'in_the_way' && moves.some((m) => m.went)),
  };
}

// ------------------------------------------------------------------------------------------------ the report

/** The address line of an outline: "Page: profile /{1}/". */
const PAGE_LINE = /^Page: \S+ (.+)$/m;

/**
 * Sends a read's problem report: never a name, only what was read, the network's answer, the page's outline and what
 * the helper did. A report that can't be made or sent is let go.
 */
export async function report(
  ctx: ReadCtx,
  read: ReadKind,
  note: string,
  helper: ProblemHelper | null,
  found: Record<string, number | boolean | string[]> = {},
): Promise<void> {
  try {
    const page = await ctx.tab.hands('outline');
    const outline = page?.outline ?? '';
    await reportProblem(ctx.businessId, {
      addonId: 'socialcontent',
      source: 'extension',
      area: ctx.work.network,
      job: `read.${read}`,
      ref: ctx.work.id,
      version: chrome.runtime.getManifest().version.slice(0, 20),
      page: page ? String(page.result.kind).slice(0, 40) : 'unknown',
      path: (PAGE_LINE.exec(outline)?.[1] ?? '').slice(0, 500),
      shown: page?.shown ?? null,
      found: page
        ? reportFound(page.result as unknown as PageRead, sectionsIn(outline), found)
        : { ...found },
      note: note.slice(0, 300),
      outline: outline ? outline.slice(0, PROBLEM_OUTLINE_MOST) : null,
      helper,
    });
  } catch (error) {
    console.warn('HandsFreeOS Social couldn’t send its report on a read', error);
  }
}
