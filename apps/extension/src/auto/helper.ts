/**
 * The AI helper, from the runners (docs/outreach.md, decision 142; core's addons/outreach/helper.ts). When one of a
 * day's steps doesn't go on any network, the runner asks it before handing the step to the person:
 *
 * - **A learned way first.** For a step it may press (a like, a friend or connection request, a follow, a confirm),
 *   the ways the helper found before and every computer trusts (they worked twice), tried in the tab: one is pressed
 *   only when exactly one thing on the page fits it. No AI asked.
 * - **Then it looks**, a move at a time, up to its last (`HELPER_MOVES_MOST`): the tab sends a view of the page with
 *   everything a person wrote hidden (src/networks/helper-view.ts), the worker's AI says what it sees and its one next
 *   move, and the tab takes it. A click only clears the way; a press is the step's own button, found in a new place.
 * - **What it did** goes on the step's problem report (`ProblemHelper`): what it sorted it as, what it said, its
 *   moves, and how it ended, which the runner sets once the step's own check has said whether the step went.
 *
 * A computer's helper looks at most `HELPER_LOOKS_A_DAY` times a day, every network together; past that, and without
 * the AI (its limit, the business's balance, busy), the step is reported as before.
 */
import {
  HELPER_LOOKS_A_DAY,
  type HelperButton,
  type HelperLookOutput,
  type WayShape,
} from '@hfos/core/addons/outreach/helper';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  HELPER_MOVES_MOST,
  type HelperNotLooked,
  type HelperResult,
  type ProblemHelper,
} from '@hfos/core/problem-report';
import type { HelperAnswer, HelperAsk } from '../messages';
import type { Hfos, JobTab } from '../jobs/job';
import { reporter } from '../jobs/report';
import { Refused } from '../hfos/session';
import { reportWhy } from './plan';

/** The tab the helper works in: any network's. */
export interface HelperTab {
  ask(message: HelperAsk): Promise<HelperAnswer>;
}

/** What the helper did on one step. */
export interface HelperRun {
  /** For the report: its `result` says `reported` until the runner knows better (`ended`). */
  readonly helper: ProblemHelper;
  /** It took a move that cleared something in the way: the step is worth trying once more. */
  readonly cleared: boolean;
  /** It pressed the step's own button, or a learned way did: the step's own check says whether it went. */
  readonly pressed: boolean;
  /** How the button was found, when it pressed it: noted once the step's own check says how it went. */
  readonly way: WayShape | null;
}

/** Who the step is for and what it was. */
export interface HelperFor {
  readonly businessId: string;
  readonly platform: Platform;
  /** Today's kind ("friend_request"), or a send's. */
  readonly step: string;
  /** What the runner said went wrong, without the person's name. */
  readonly why: string;
  /** Who it's for, shown in the tab's view as "(their name)" and never sent. */
  readonly theirName: string | null;
  /** The step's own button when the helper may press it; null to only clear the way and say. */
  readonly button: HelperButton | null;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** After a move, while the page redraws. */
const SETTLE_MS = 1_200;
/** How long the learned ways for a network are kept before they're asked for again. */
const WAYS_FOR_MS = 60 * 60_000;
/** Where a computer counts its helper's looks for the day. */
export const HELPER_LOOKS_KEY = 'hfos-helper-looks';

const today = () => new Date().toISOString().slice(0, 10);

/** Takes one of the day's looks: false once they're all used. */
async function takeLook(): Promise<boolean> {
  try {
    const kept = (await chrome.storage.local.get(HELPER_LOOKS_KEY))[HELPER_LOOKS_KEY] as
      { day?: string; n?: number } | undefined;
    const n = kept?.day === today() ? (kept.n ?? 0) : 0;
    if (n >= HELPER_LOOKS_A_DAY) return false;
    await chrome.storage.local.set({ [HELPER_LOOKS_KEY]: { day: today(), n: n + 1 } });
    return true;
  } catch {
    return true;
  }
}

const waysKept = new Map<
  Platform,
  { at: number; ways: readonly { button: HelperButton; way: WayShape }[] }
>();

/** The learned ways every computer tries on a network, asked for at most once an hour. */
async function waysFor(
  hfos: Hfos,
  businessId: string,
  platform: Platform,
): Promise<readonly { button: HelperButton; way: WayShape }[]> {
  const kept = waysKept.get(platform);
  if (kept && Date.now() - kept.at < WAYS_FOR_MS) return kept.ways;
  const asked = await hfos({
    type: 'hfos-helper-ways',
    workspaceId: businessId,
    input: { platform },
  });
  // An answer without its list (an older worker's) is none, kept as none for the hour.
  const ways = asked.ok && Array.isArray(asked.value?.ways) ? asked.value.ways : [];
  waysKept.set(platform, { at: Date.now(), ways });
  return ways;
}

/**
 * A report's helper part that looked nowhere, and why when it didn't (decision 143): the day's looks used, the page
 * unread, the AI not asked or HandsFreeOS not answering, with HandsFreeOS's words for the last two (`said`).
 */
const notLooked = (
  moves: ProblemHelper['moves'] = [],
  why: HelperNotLooked | null = null,
  said = '',
): ProblemHelper => ({
  verdict: 'unclear',
  result: 'reported',
  said: said.replace(/\s+/g, ' ').trim().slice(0, 400),
  moves,
  learned: null,
  looks: 0,
  notLooked: why,
});

/**
 * Tries the learned ways for the step's button, then looks. Null when there was nothing to do: no way fit and the
 * tab couldn't be asked at all.
 */
export async function helpWith(
  tab: HelperTab,
  hfos: Hfos,
  at: HelperFor,
): Promise<HelperRun | null> {
  try {
    if (at.button) {
      const ways = (await waysFor(hfos, at.businessId, at.platform)).filter(
        (w) => w.button === at.button,
      );
      for (const { way } of ways) {
        const tried = await tab.ask({
          type: 'hfos-helper-way',
          way,
          button: at.button,
          theirName: at.theirName,
        });
        if (tried.ok && tried.pressed)
          return {
            helper: {
              ...notLooked([{ do: 'press', on: 'a way it learned before', went: true }]),
              verdict: 'moved',
              learned: 'worked',
            },
            cleared: false,
            pressed: true,
            way,
          };
      }
    }
    return await look(tab, hfos, at);
  } catch (error) {
    console.warn('HandsFreeOS Social’s AI helper couldn’t look', error);
    return null;
  }
}

/** The looks and moves, up to the last. */
async function look(tab: HelperTab, hfos: Hfos, at: HelperFor): Promise<HelperRun | null> {
  const moves: ProblemHelper['moves'][number][] = [];
  let looks = 0;
  let verdict: ProblemHelper['verdict'] = 'unclear';
  let said = '';
  let cleared = false;
  // Why the first look didn't happen, for the report: what stopped it, and HandsFreeOS's words when it said.
  let stopped: { why: HelperNotLooked; said: string } | null = null;
  for (let i = 0; i <= HELPER_MOVES_MOST; i++) {
    if (!(await takeLook())) {
      stopped ??= { why: 'looks_used', said: '' };
      break;
    }
    const seen = await tab.ask({
      type: 'hfos-helper-view',
      theirName: at.theirName,
      fresh: i === 0,
    });
    if (!seen.ok || seen.view === undefined) {
      stopped ??= { why: 'no_view', said: seen.ok ? '' : seen.error };
      break;
    }
    const asked = await hfos({
      type: 'hfos-helper-look',
      workspaceId: at.businessId,
      input: {
        platform: at.platform,
        step: at.step.slice(0, 40),
        button: at.button,
        why: at.why.slice(0, 300),
        view: seen.view,
        moves,
      },
    });
    const answer: HelperLookOutput | null = asked.ok ? asked.value : null;
    if (!answer?.asked) {
      stopped ??= asked.ok
        ? { why: 'not_asked', said: asked.value.said }
        : { why: 'no_answer', said: asked.problem.message };
      break;
    }
    looks++;
    verdict = answer.verdict;
    if (answer.said) said = answer.said;
    const move = answer.move;
    if (move.do === 'none') break;
    const went = await tab.ask({
      type: 'hfos-helper-move',
      move: { do: move.do, ref: move.ref, dir: move.dir },
      button: at.button,
    });
    const done = went.ok ? went.done : undefined;
    moves.push({ do: move.do, on: done?.on ?? null, went: done?.went ?? false });
    if (move.do === 'press' && done?.went)
      return {
        helper: { verdict, result: 'reported', said, moves, learned: null, looks, notLooked: null },
        cleared,
        pressed: true,
        way: done.way ?? null,
      };
    if (done?.went && verdict === 'in_the_way' && move.do !== 'wait') cleared = true;
    await pause(SETTLE_MS);
  }
  if (!looks)
    return {
      helper: notLooked(moves, stopped?.why ?? null, stopped?.said ?? ''),
      cleared: false,
      pressed: false,
      way: null,
    };
  return {
    helper: { verdict, result: 'reported', said, moves, learned: null, looks, notLooked: null },
    // A wait that let the page finish loading counts too, when the helper said something was in the way.
    cleared: cleared || (verdict === 'in_the_way' && moves.some((m) => m.went)),
    pressed: false,
    way: null,
  };
}

/** The helper's part of the report, as the step ended. */
export const ended = (run: HelperRun, result: HelperResult, worked?: boolean): ProblemHelper => ({
  ...run.helper,
  result,
  // A learned way that pressed but didn't make the step go is said to have failed.
  learned: run.helper.learned === 'worked' && worked === false ? 'failed' : run.helper.learned,
});

/**
 * Notes how a press went, once the step's own check has said: a way the AI found and the step went is learned; a
 * learned way counts up, or down when the step didn't go. Never stops the runner.
 */
export async function noteWay(
  hfos: Hfos,
  businessId: string,
  platform: Platform,
  button: HelperButton | null,
  run: HelperRun | null,
  worked: boolean,
): Promise<void> {
  if (!run?.pressed || !run.way || !button) return;
  // A way the AI found that didn't make the step go is nothing to learn.
  if (!worked && run.helper.learned !== 'worked') return;
  try {
    await hfos({
      type: 'hfos-helper-way',
      workspaceId: businessId,
      input: { platform, button, way: run.way, worked },
    });
    if (!worked) waysKept.delete(platform);
  } catch {
    // Learned another time.
  }
}

// ---------- after a step, on any network ----------

/** How a runner's step went, as every network's runner says it (each has its own `Outcome`, shaped like this). */
type Went = {
  readonly done: boolean;
  readonly line: string;
  /** One the person can do themselves: handed to them (decision 42). */
  readonly need?: true;
  /** Worth the helper's look though it isn't handed over (a like it couldn't press). */
  readonly look?: true;
  /** Found done already (connected, asked): nothing's left to do, so no failure to report (decision 143). */
  readonly skip?: true;
  readonly helper?: ProblemHelper;
};

/** What the runner was doing: a step on Today's list, a draft or a send, for someone. */
export interface HelperWork {
  readonly do: string;
  readonly item: { readonly kind: string; readonly name: string };
}

const went = (outcome: object): outcome is Went => 'done' in outcome && 'line' in outcome;

/**
 * What every runner does once a piece of work has gone, before it notes how: a step that didn't go and hasn't had the
 * helper yet gets it (only to clear the way and say what it sees: a press is the step's own, inside it); once it
 * cleared something, a step handed over is tried once more. Then the problem report: for anything that didn't go, or
 * that went with the helper's help, with why (never a name), the page's outline and what the helper did. The report's
 * id goes back for the step's Needs you.
 */
export async function helpAfter<O extends object>(at: {
  readonly tab: JobTab & HelperTab;
  readonly hfos: Hfos;
  readonly businessId: string;
  readonly platform: Platform;
  readonly work: HelperWork;
  /** What the report says it was doing: Today's kind, or the work's. */
  readonly job: string;
  readonly outcome: O;
  /** The same work once more: null where trying again could do it twice (a message). */
  readonly again: (() => Promise<O>) | null;
  /** Says on the panel what's happening. */
  readonly say?: (line: string) => Promise<unknown>;
}): Promise<{ readonly outcome: O; readonly reportId: string | null }> {
  let outcome: object = at.outcome;
  const { item } = at.work;
  if (went(outcome) && !outcome.done && (outcome.need || outcome.look) && !outcome.helper) {
    await at.say?.(`Looking at what stopped it: ${outcome.line}`).catch(() => undefined);
    const run = await helpWith(at.tab, at.hfos, {
      businessId: at.businessId,
      platform: at.platform,
      step: item.kind,
      why: reportWhy(item, outcome.line),
      theirName: item.name,
      button: null,
    });
    if (run) {
      const first: Went = outcome;
      outcome = { ...first, helper: run.helper };
      if (run.cleared && first.need && at.again) {
        let again: object;
        try {
          again = await at.again();
        } catch (error) {
          if (error instanceof Refused) throw error;
          again = {
            done: false,
            line: `${item.name}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (!went(again)) outcome = again;
        else if (again.done) outcome = { ...again, helper: ended(run, 'fixed_itself') };
      }
    }
  }
  let reportId: string | null = null;
  // Every step that didn't go is reported, but one found done already (decision 143), and every one the helper was in.
  if (went(outcome) && ((!outcome.done && !outcome.skip) || outcome.helper))
    reportId = await reporter(at.tab, at.hfos, {
      businessId: at.businessId,
      platform: at.platform,
      askId: null,
      job: at.job,
    })({
      note: reportWhy(item, outcome.line).slice(0, 300),
      outline: true,
      helper: outcome.helper ?? null,
    });
  return { outcome: outcome as O, reportId };
}

/**
 * Inside a step, when the runner couldn't find its own button on a page it checked is theirs: a learned way, else the
 * AI finds and presses it. When the helper only cleared the way, the runner's own press goes again (`again`). Whether
 * the button was pressed, and what the helper did, for the step's own check to finish.
 */
export async function pressFor(
  tab: HelperTab,
  hfos: Hfos,
  at: HelperFor & { readonly button: HelperButton },
  again: () => Promise<boolean>,
): Promise<{ readonly pressed: boolean; readonly run: HelperRun | null }> {
  const run = await helpWith(tab, hfos, at);
  if (run?.pressed) return { pressed: true, run };
  if (run?.cleared) return { pressed: await again().catch(() => false), run };
  return { pressed: false, run };
}

/**
 * The helper's part of a step that used it inside, once the step's own check has said: done by it (it pressed), fixed
 * itself (it cleared the way and the runner's own press went), or reported; and the way it pressed, noted.
 */
export async function pressEnded(
  hfos: Hfos,
  at: { readonly businessId: string; readonly platform: Platform; readonly button: HelperButton },
  run: HelperRun | null,
  worked: boolean,
): Promise<ProblemHelper | undefined> {
  if (!run) return undefined;
  // It changed nothing (no press, nothing cleared) and the step went on its own: it wasn't needed, so it's no report.
  if (worked && !run.pressed && !run.cleared) return undefined;
  await noteWay(hfos, at.businessId, at.platform, at.button, run, worked);
  return ended(
    run,
    worked ? (run.pressed ? 'done_by_helper' : 'fixed_itself') : 'reported',
    worked,
  );
}

/**
 * A step's own help, for a runner: `press` once its own press didn't find the button on a page it checked is theirs,
 * with why in the runner's words (whether the button was pressed, by the helper or by the runner's `again` once the
 * helper cleared the way; once a step: a second asks nothing); `end` once the step's own check has said whether it
 * went, for its outcome's `helper` (undefined when the helper wasn't needed).
 */
export function stepHelp(
  tab: HelperTab,
  hfos: Hfos,
  at: Omit<HelperFor, 'why'> & { readonly button: HelperButton },
): {
  readonly press: (why: string, again: () => Promise<boolean>) => Promise<boolean>;
  readonly end: (worked: boolean) => Promise<ProblemHelper | undefined>;
} {
  let run: HelperRun | null = null;
  let asked = false;
  return {
    async press(why, again) {
      if (asked) return false;
      asked = true;
      const got = await pressFor(tab, hfos, { ...at, why }, again);
      run = got.run;
      return got.pressed;
    },
    end: (worked) => pressEnded(hfos, at, run, worked),
  };
}
