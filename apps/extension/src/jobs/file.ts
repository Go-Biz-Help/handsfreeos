/**
 * Getting the person's Facebook file (docs/outreach.md, decisions 16 and 43), asked from the Friends tab in
 * HandsFreeOS: it asks Facebook for the file, downloads it when it's ready, or gets the chat backup, pressing the
 * buttons on Facebook's own pages (src/networks/facebook/fetch.ts) in a tab the person can see. Facebook asks for their
 * password and their PIN, which they type themselves; a step it can't find on the page it hands to them, and carries
 * on once they say so. Bringing the downloaded zips in is ./file-in.ts. LinkedIn's data file goes the same way, on its
 * own page and with its own steps (./linkedin/file.ts).
 */
import {
  FETCH_PLANS,
  type FetchJob,
  type FetchPlan,
  type FetchStep,
  type StepResult,
} from '../networks/facebook/fetch';
import type { FetchAnswer } from '../messages';
import { pause, type Job, type JobEnd } from './job';

/** What's kept between asks: when the file was asked for, and which zips were brought in (./file-in.ts). */
export const FILE_KEY = 'hfos.facebookFile';
export interface FileKept {
  readonly requestedAt?: string;
  readonly broughtIn?: Readonly<Record<string, string>>;
}

/** What's kept of a network's file: Facebook's unless said. */
export async function fileKept(key: string = FILE_KEY): Promise<FileKept> {
  try {
    const found: unknown = (await chrome.storage.local.get(key))[key];
    return found && typeof found === 'object' ? (found as FileKept) : {};
  } catch {
    return {};
  }
}

export async function keepFile(change: Partial<FileKept>, key: string = FILE_KEY): Promise<void> {
  const kept = await fileKept(key);
  await chrome.storage.local.set({ [key]: { ...kept, ...change } }).catch(() => undefined);
}

/** How a network's file is got: its steps, its words, and where what's kept between asks is kept. */
export interface FileWay {
  /** The network's name: "Opening Facebook…". */
  readonly name: string;
  /** What the person types there themselves. */
  readonly secret: string;
  readonly key: string;
  readonly plans: Readonly<Partial<Record<FetchJob, FetchPlan>>>;
  /** What's said when each job's done. */
  readonly done: Readonly<Partial<Record<FetchJob, string>>>;
  /**
   * After the steps, what's left to see to (LinkedIn's: waiting for the download to start), given when the steps
   * began: the words to end with, or null for `done`'s.
   */
  readonly after?: (job: Job, which: FetchJob, began: number) => Promise<string | null>;
}

/** How long a step is looked for before it's handed to the person; a screen that may not come, less. */
const WAIT_MS = 12_000;
const WAIT_OPTIONAL_MS = 4_000;
/** Between steps, while Facebook draws what a press opened. */
const SETTLE_MS = 1_200;
/** How long it waits for the person to type their password or PIN before it stops. */
const TYPING_MS = 15 * 60_000;

/** Facebook's file: Accounts Center's download, and the chat backup. */
export const FACEBOOK_FILE: FileWay = {
  name: 'Facebook',
  secret: 'password or PIN',
  key: FILE_KEY,
  plans: FETCH_PLANS,
  done: {
    request:
      'Facebook is making your file. It emails you when it’s ready, often within a few hours. Then ask for Download my file.',
    download:
      'Downloaded, once you typed your password if Facebook asked. If Facebook made more than one part, press Download on each. Then ask for Bring it in.',
    backup: 'Downloaded, once you typed your PIN if Facebook asked. Then ask for Bring it in.',
  },
};

/** Ended because the person said Stop, or the day stopped: the runner of asks says which. */
export class Stopped extends Error {}

/**
 * A step it can't find, handed to the person: `says` what to do. Stop ends the job; Carry on (or Skip, which here is
 * the same) goes on.
 */
export async function handOverStep(job: Job, says: string): Promise<void> {
  const reply = job.handOver
    ? await job.handOver(`Couldn’t find that step on the page. ${says} Then press Carry on.`)
    : 'stop';
  if (reply === 'stop' || job.stopped()) throw new Stopped();
}

const handOver = (job: Job, step: FetchStep) => handOverStep(job, step.says);

/** What's said while the person types, and when nobody did for `TYPING_MS`. */
export const typingWords = (way: Pick<FileWay, 'name' | 'secret'>) => ({
  waiting: `Waiting for you to type your ${way.secret} in the ${way.name} tab…`,
  gaveUp: `Nobody typed the ${way.secret} for ${TYPING_MS / 60_000} minutes, so it stopped. Ask again when you’re at your computer.`,
});

/** Waits while the network asks the person to type, asking again until the step shows. */
async function whileTyping(
  job: Job,
  way: FileWay,
  again: () => Promise<FetchAnswer>,
): Promise<FetchAnswer> {
  const words = typingWords(way);
  job.typing?.(words.waiting);
  const until = Date.now() + TYPING_MS;
  try {
    for (;;) {
      const answer = await again();
      if (job.stopped() || !answer.ok || answer.result !== 'waiting') return answer;
      if (Date.now() > until) throw new Error(words.gaveUp);
    }
  } finally {
    job.typing?.(null);
  }
}

/** Does steps in order. When the page says there's nothing to do, what to tell the person; else null. */
async function bySteps(
  job: Job,
  way: FileWay,
  steps: readonly FetchStep[],
): Promise<string | null> {
  let before: StepResult = 'done';
  for (const [i, step] of steps.entries()) {
    if (job.stopped()) throw new Stopped();
    if (step.afterPrevious && before !== 'done' && before !== 'already') {
      before = 'missing';
      continue;
    }
    job.progress(
      step.action === 'stopIf'
        ? `Checking whether ${way.name} is making your file already…`
        : `Step ${i + 1} of ${steps.length}: ${step.says}`,
    );
    const once = () =>
      job.tab.ask({
        type: 'hfos-fetch-step',
        step,
        waitMs: step.optional ? WAIT_OPTIONAL_MS : WAIT_MS,
      });
    let answer = await once();
    if (answer.ok && answer.result === 'waiting') answer = await whileTyping(job, way, once);
    if (job.stopped()) throw new Stopped();
    if (!answer.ok) throw new Error(answer.error);
    if (answer.result === 'stop') return step.says;
    before = answer.result;
    if (answer.result === 'missing' || answer.result === 'waiting') {
      if (step.optional) continue;
      await handOver(job, step);
      before = 'done';
      continue;
    }
    await pause(SETTLE_MS);
  }
  return null;
}

async function byPath(job: Job, way: FileWay, steps: readonly FetchStep[]): Promise<void> {
  let from = 0;
  while (from < steps.length) {
    if (job.stopped()) throw new Stopped();
    job.progress(`Looking for: ${steps[from]!.says}`);
    const once = () => job.tab.ask({ type: 'hfos-fetch-path', steps, from, waitMs: WAIT_MS });
    let answer = await once();
    if (answer.ok && answer.result === 'waiting') answer = await whileTyping(job, way, once);
    if (job.stopped()) throw new Stopped();
    if (!answer.ok) throw new Error(answer.error);
    if (answer.at !== undefined) {
      from = answer.at + 1;
      await pause(SETTLE_MS);
      continue;
    }
    // The person presses it, or a step past it; the path carries on from wherever the page is then.
    await handOver(job, steps[from]!);
  }
}

/**
 * Does one of the file's jobs in the job's tab, handing to the person what it can't find or mustn't type: Facebook's
 * unless said. A stop (theirs, or the day's) ends it quietly: the runner of asks says how it stopped.
 */
export async function getFile(
  job: Job,
  which: FetchJob,
  way: FileWay = FACEBOOK_FILE,
): Promise<JobEnd> {
  const plan = way.plans[which];
  if (!plan)
    return {
      line: `${way.name} has no ${which === 'backup' ? 'chat backup' : 'file'} for your computer to get.`,
      warned: false,
      failed: true,
    };
  job.progress(`Opening ${way.name}…`);
  const began = Date.now();
  try {
    const id = Number(await job.tab.open(plan.url));
    let nothingToDo: string | null = null;
    if (plan.mode === 'steps') nothingToDo = await bySteps(job, way, plan.steps);
    else await byPath(job, way, plan.steps);
    if (plan.then && !nothingToDo) {
      // The path led to a page of its own: let it load, then do its choices in order.
      if (job.tab.loaded && Number.isFinite(id)) await job.tab.loaded(id);
      nothingToDo = await bySteps(job, way, plan.then);
    }
    if (nothingToDo) return { line: nothingToDo, warned: false };
    const said = way.after ? await way.after(job, which, began) : null;
    if (which === 'request') await keepFile({ requestedAt: new Date().toISOString() }, way.key);
    return { line: said ?? way.done[which] ?? 'Done.', warned: false };
  } catch (error) {
    if (error instanceof Stopped) return { line: 'Stopped.', warned: false };
    throw error;
  }
}
