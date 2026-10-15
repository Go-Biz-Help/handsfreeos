/**
 * Getting the person's Facebook file (docs/outreach.md, decisions 16 and 43), asked from the Friends tab in
 * HandsFreeOS: it asks Facebook for the file, downloads it when it's ready, or gets the chat backup, pressing the
 * buttons on Facebook's own pages (src/networks/facebook/fetch.ts) in a tab the person can see. Facebook asks for their
 * password and their PIN, which they type themselves; a step it can't find on the page it hands to them, and carries
 * on once they say so. Bringing the downloaded zips in is ./file-in.ts.
 */
import {
  FETCH_PLANS,
  type FetchJob,
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

export async function fileKept(): Promise<FileKept> {
  try {
    const found: unknown = (await chrome.storage.local.get(FILE_KEY))[FILE_KEY];
    return found && typeof found === 'object' ? (found as FileKept) : {};
  } catch {
    return {};
  }
}

export async function keepFile(change: Partial<FileKept>): Promise<void> {
  const kept = await fileKept();
  await chrome.storage.local.set({ [FILE_KEY]: { ...kept, ...change } }).catch(() => undefined);
}

/** How long a step is looked for before it's handed to the person; a screen that may not come, less. */
const WAIT_MS = 12_000;
const WAIT_OPTIONAL_MS = 4_000;
/** Between steps, while Facebook draws what a press opened. */
const SETTLE_MS = 1_200;
/** How long it waits for the person to type their password or PIN before it stops. */
const TYPING_MS = 15 * 60_000;

const DONE: Record<FetchJob, string> = {
  request:
    'Facebook is making your file. It emails you when it’s ready, often within a few hours. Then ask for Download my file.',
  download:
    'Downloaded, once you typed your password if Facebook asked. If Facebook made more than one part, press Download on each. Then ask for Bring it in.',
  backup: 'Downloaded, once you typed your PIN if Facebook asked. Then ask for Bring it in.',
};

/** Ended because the person said Stop, or the day stopped: the runner of asks says which. */
class Stopped extends Error {}

/** A step it can't find, handed to the person. Stop ends the job; Carry on (or Skip, which here is the same) goes on. */
async function handOver(job: Job, step: FetchStep): Promise<void> {
  const reply = job.handOver
    ? await job.handOver(`Couldn’t find that step on the page. ${step.says} Then press Carry on.`)
    : 'stop';
  if (reply === 'stop' || job.stopped()) throw new Stopped();
}

/** Waits while Facebook asks the person to type, asking again until the step shows. */
async function whileTyping(job: Job, again: () => Promise<FetchAnswer>): Promise<FetchAnswer> {
  job.typing?.('Waiting for you to type your password or PIN in the Facebook tab…');
  const until = Date.now() + TYPING_MS;
  try {
    for (;;) {
      const answer = await again();
      if (job.stopped() || !answer.ok || answer.result !== 'waiting') return answer;
      if (Date.now() > until)
        throw new Error(
          'Nobody typed the password or PIN for 15 minutes, so it stopped. Ask again when you’re at your computer.',
        );
    }
  } finally {
    job.typing?.(null);
  }
}

/** Does steps in order. When the page says there's nothing to do, what to tell the person; else null. */
async function bySteps(job: Job, steps: readonly FetchStep[]): Promise<string | null> {
  let before: StepResult = 'done';
  for (const [i, step] of steps.entries()) {
    if (job.stopped()) throw new Stopped();
    if (step.afterPrevious && before !== 'done' && before !== 'already') {
      before = 'missing';
      continue;
    }
    job.progress(
      step.action === 'stopIf'
        ? 'Checking whether Facebook is making your file already…'
        : `Step ${i + 1} of ${steps.length}: ${step.says}`,
    );
    const once = () =>
      job.tab.ask({
        type: 'hfos-fetch-step',
        step,
        waitMs: step.optional ? WAIT_OPTIONAL_MS : WAIT_MS,
      });
    let answer = await once();
    if (answer.ok && answer.result === 'waiting') answer = await whileTyping(job, once);
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

async function byPath(job: Job, steps: readonly FetchStep[]): Promise<void> {
  let from = 0;
  while (from < steps.length) {
    if (job.stopped()) throw new Stopped();
    job.progress(`Looking for: ${steps[from]!.says}`);
    const once = () => job.tab.ask({ type: 'hfos-fetch-path', steps, from, waitMs: WAIT_MS });
    let answer = await once();
    if (answer.ok && answer.result === 'waiting') answer = await whileTyping(job, once);
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
 * Does one of the file's jobs in the job's tab, handing to the person what it can't find or mustn't type. A stop
 * (theirs, or the day's) ends it quietly: the runner of asks says how it stopped.
 */
export async function getFile(job: Job, which: FetchJob): Promise<JobEnd> {
  const plan = FETCH_PLANS[which];
  job.progress('Opening Facebook…');
  try {
    const id = Number(await job.tab.open(plan.url));
    let nothingToDo: string | null = null;
    if (plan.mode === 'steps') nothingToDo = await bySteps(job, plan.steps);
    else await byPath(job, plan.steps);
    if (plan.then && !nothingToDo) {
      // The path led to a page of its own: let it load, then do its choices in order.
      if (job.tab.loaded && Number.isFinite(id)) await job.tab.loaded(id);
      nothingToDo = await bySteps(job, plan.then);
    }
    if (nothingToDo) return { line: nothingToDo, warned: false };
    if (which === 'request') await keepFile({ requestedAt: new Date().toISOString() });
    return { line: DONE[which], warned: false };
  } catch (error) {
    if (error instanceof Stopped) return { line: 'Stopped.', warned: false };
    throw error;
  }
}
