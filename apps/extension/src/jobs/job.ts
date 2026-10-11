/**
 * The jobs the extension does on Facebook for the person, a page at a time: going through their groups for posts
 * worth a comment (./posts.ts), their chats for the AI (./chats.ts), their friend requests, friends and groups'
 * members (./people.ts), their groups (./groups.ts), looking someone up before drafting (./lookup.ts), getting their
 * Facebook file and bringing it in (./file.ts, ./file-in.ts), and cancelling old requests or unfriending the people
 * they ticked (./tidy.ts). The person asks for each from HandsFreeOS (src/asks/run.ts, docs/outreach.md decision
 * 43); the runner that works on its own runs four of them once a day, at the start of their working day
 * (src/auto/daily.ts, decision 32). Each saves to HandsFreeOS, goes at a person's pace, and stops on any Facebook
 * warning. Only the file's steps and tidying press anything on Facebook; the rest open and scroll.
 */
import type { ReadResult } from '../facebook/types';
import type { HfosAnswer, HfosAsk, HfosValues } from '../hfos/messages';
import type {
  Answer,
  Ask,
  BrowseAnswer,
  BrowseAsk,
  FetchAnswer,
  FetchAsk,
  JoinAnswer,
  JoinAsk,
} from '../messages';

/** The Facebook tab a job works in: one of the extension's own (src/tab.ts). */
export interface JobTab {
  /** Opens an address, and waits for Facebook to draw it. */
  open(url: string): Promise<unknown>;
  /** Waits for the tab to finish loading what a press opened. */
  loaded?(id: number): Promise<unknown>;
  /** Brings it to the front, for a step handed to the person. */
  focus?(): Promise<void>;
  ask(message: Ask): Promise<Answer>;
  ask(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
  ask(message: FetchAsk): Promise<FetchAnswer>;
  ask(message: JoinAsk): Promise<JoinAnswer>;
}

/** HandsFreeOS: the background's own line (src/hfos/session.ts). */
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
  /**
   * Hands a step the job can't find to the person, and waits for their answer: Carry on once they've done it, Skip
   * (that person), or Stop. Only what the person asked for has one; the runner's daily jobs never hand over.
   */
  readonly handOver?: (says: string) => Promise<HandOverReply>;
  /** Facebook asks for the person's password or PIN: said while the job waits; null once it's gone on. */
  readonly typing?: (line: string | null) => void;
}

/** The person's answer to a step handed to them. */
export type HandOverReply = 'carry_on' | 'skip' | 'stop';

/**
 * How a job ended: what it did, in words for the person; whether a Facebook warning stopped it; and whether it
 * couldn't do what it was asked (nothing to save, HandsFreeOS refused it), so it doesn't show as done.
 */
export interface JobEnd {
  readonly line: string;
  readonly warned: boolean;
  readonly failed?: boolean;
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
