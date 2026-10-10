/**
 * The jobs the extension does on Facebook for the person, a page at a time: going through their groups for posts
 * worth a comment (./posts.ts), their chats for the AI (./chats.ts), their friend requests (./requests.ts) and their
 * groups' members (./members.ts). The panel runs the first two when the person presses **Find posts** or **Read my
 * chats** (src/panel/posts.ts, src/panel/chats.ts); the runner that works on its own runs all four once a day, at the
 * start of their working day (src/auto/daily.ts, docs/outreach.md decision 32). Each reads only, saves to HandsFreeOS,
 * goes at a person's pace, and stops on any Facebook warning. None presses anything on Facebook but a chat in the
 * list, to open it, and the page's scroll.
 */
import type { ReadResult } from '../facebook/types';
import type { HfosAnswer, HfosAsk, HfosValues } from '../hfos/messages';
import type { Answer, Ask, BrowseAnswer, BrowseAsk } from '../messages';

/** The Facebook tab a job works in: one of the extension's own (src/tab.ts), or the one beside the panel. */
export interface JobTab {
  /** Opens an address, and waits for Facebook to draw it. */
  open(url: string): Promise<unknown>;
  ask(message: Ask): Promise<Answer>;
  ask(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
}

/** HandsFreeOS: the panel's line to the background, or the background's own. */
export type Hfos = <T extends HfosAsk>(ask: T) => Promise<HfosAnswer<HfosValues[T['type']]>>;

export interface Job {
  readonly tab: JobTab;
  readonly hfos: Hfos;
  readonly businessId: string;
  /** Whether the person pressed Stop, or the day's work stopped. */
  readonly stopped: () => boolean;
  /** Where it's got to, in words for the person. */
  readonly progress: (line: string) => void;
  /** Notes Facebook's warning words in HandsFreeOS (decision 25). */
  readonly warn: (words: readonly string[], url: string) => Promise<void>;
}

/** How a job ended: what it did, in words for the person; and whether a Facebook warning stopped it. */
export interface JobEnd {
  readonly line: string;
  readonly warned: boolean;
}

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A wait between two bounds, never the same twice: a person's pace. */
export const paced = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low);

/** The words a job ends with on a Facebook warning. */
export const warnedLine = (words: readonly string[]) =>
  `Stopped: Facebook says “${words[0]}”. The extension stops for today, and your daily limits are halved for a week.`;

/** Reads the page in the job's tab. */
export async function readIn(tab: JobTab): Promise<ReadResult> {
  const answer = await tab.ask({ type: 'hfos-read' });
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

/** A warning on the page: noted, and the end of the job. Null when there's none. */
export async function warnedOn(job: Job, page: ReadResult): Promise<JobEnd | null> {
  if (!page.warnings.length) return null;
  await job.warn(page.warnings, page.url);
  return { line: warnedLine(page.warnings), warned: true };
}

/** What HandsFreeOS answered, or the problem it said, thrown. */
export function valueOf<T>(answer: HfosAnswer<T>): T {
  if (!answer.ok) throw new Error(answer.problem.message);
  return answer.value;
}
