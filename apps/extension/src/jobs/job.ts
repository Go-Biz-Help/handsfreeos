/**
 * The jobs the extension does on Facebook for the person, a page at a time: going through their groups for posts
 * worth a comment (./posts.ts), their chats for the AI (./chats.ts), their friend requests, friends and groups'
 * members (./people.ts), their groups (./groups.ts), looking someone up before drafting (./lookup.ts), getting their
 * Facebook file and bringing it in (./file.ts, ./file-in.ts), and cancelling old requests or unfriending the people
 * they ticked (./tidy.ts). The person asks for each from HandsFreeOS (src/asks/run.ts, docs/outreach.md decision
 * 43); the runner that works on its own runs four of them once a day, at the start of their working day
 * (src/auto/daily.ts, decision 32). Each saves to HandsFreeOS, goes at a person's pace, and stops on any Facebook
 * warning. Only the file's steps and tidying press anything on Facebook; the rest open and scroll. LinkedIn's are in
 * ./linkedin/, with the same `Job`, and Read my chats (./chats.ts) works on both.
 */
import type { Reporter, ReportNote } from './report';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { platformOf, type PageRead } from '../networks/kit';
import type { ReadResult } from '../networks/facebook/types';
import type { HfosAnswer, HfosAsk, HfosValues } from '../hfos/messages';
import type {
  Answer,
  Ask,
  BrowseAnswer,
  BrowseAsk,
  FetchAnswer,
  FetchAsk,
  FeedPostAnswer,
  FeedPostAsk,
  PostPeopleAnswer,
  PostPeopleAsk,
  GroupPostAnswer,
  GroupPostAsk,
  JoinAnswer,
  JoinAsk,
  CodeAnswer,
  CodeAsk,
  OwnProfileAnswer,
  OwnProfileAsk,
  PageThereAnswer,
  PageThereAsk,
  ProfileEditAnswers,
  ProfileEditAsk,
  TryAnswer,
  TryAsk,
  UnfollowAnswer,
  UnfollowAsk,
  WithdrawAnswer,
  WithdrawAsk,
  WriteNameAsk,
} from '../messages';

/** The tab a job works in, on its network's pages: one of the extension's own (src/tab.ts). */
export interface JobTab {
  /** Opens an address, and waits for Facebook to draw it. */
  open(url: string): Promise<unknown>;
  /** Waits for the tab to finish loading what a press opened. */
  loaded?(id: number): Promise<unknown>;
  /** Brings it to the front, for a step handed to the person. */
  focus?(): Promise<void>;
  /**
   * Brings it to the front while `work` runs, then the person's own window back: for a page that draws only what's on
   * screen.
   */
  inFront?<T>(work: () => Promise<T>): Promise<T>;
  /** While `inFront` runs, brings it back in front when the person put another window over it. */
  keepInFront?(): Promise<void>;
  /** Closes it, and its window when it has one of its own: done with the network's pages before the job ends. */
  close?(): Promise<void>;
  ask(message: Ask): Promise<Answer>;
  ask(message: BrowseAsk): Promise<BrowseAnswer | Answer>;
  ask(message: FetchAsk): Promise<FetchAnswer>;
  ask(message: JoinAsk): Promise<JoinAnswer>;
  ask(message: GroupPostAsk): Promise<GroupPostAnswer>;
  ask(message: FeedPostAsk): Promise<FeedPostAnswer>;
  ask(message: PostPeopleAsk): Promise<PostPeopleAnswer>;
  ask(message: OwnProfileAsk): Promise<OwnProfileAnswer>;
  ask(message: PageThereAsk): Promise<PageThereAnswer>;
  ask(message: WriteNameAsk): Promise<OwnProfileAnswer>;
  ask<A extends ProfileEditAsk>(message: A): Promise<ProfileEditAnswers[A['type']]>;
  ask(message: CodeAsk): Promise<CodeAnswer>;
  ask(message: TryAsk): Promise<TryAnswer>;
  ask(message: WithdrawAsk): Promise<WithdrawAnswer>;
  ask(message: UnfollowAsk): Promise<UnfollowAnswer>;
}

/** HandsFreeOS: the background's own line (src/hfos/session.ts). */
export type { Reporter };
export type Hfos = <T extends HfosAsk>(ask: T) => Promise<HfosAnswer<HfosValues[T['type']]>>;

export interface Job {
  readonly tab: JobTab;
  readonly hfos: Hfos;
  readonly businessId: string;
  /** Whether the person pressed Stop, or the day's work stopped. */
  readonly stopped: () => boolean;
  /** Where it's got to, in words for the person. */
  readonly progress: (line: string) => void;
  /** Notes its network's warning words in HandsFreeOS, as that network's (decision 25). */
  readonly warn: (words: readonly string[], url: string) => Promise<void>;
  /**
   * Hands a step the job can't find to the person, and waits for their answer: Carry on once they've done it, Skip
   * (that person), or Stop. Only what the person asked for has one; the runner's daily jobs never hand over.
   */
  /** `note`: what wasn't found, step by step, for the note of the page that goes with it (decision 74). */
  readonly handOver?: (says: string, note?: ReportNote) => Promise<HandOverReply>;
  /** The network asks for the person's password (or Facebook's PIN): said while the job waits; null once it's gone on. */
  readonly typing?: (line: string | null) => void;
  /**
   * The network emailed the person a code and asks for it: HandsFreeOS asks them (`line` says what to look for), their
   * phone tells them, and they type it there. The code, once they have (it's handed over once, never kept here); null
   * when none came in `ASK_CODE_MINUTES`, or the ask stopped. Only what the person asked for has one.
   */
  readonly code?: (line: string) => Promise<string | null>;
  /** Notes the page its tab shows in HandsFreeOS (decision 74, ./report.ts): what it found, and what it didn't. */
  readonly report?: Reporter;
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
  /** A list read to its very end and saved whole (./people.ts): the friends list, or friend requests either way. */
  readonly whole?: boolean;
}

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A wait between two bounds, never the same twice: a person's pace. */
export const paced = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low);

/** The words a job ends with on a network's warning (Facebook's unless said): that network alone stops. */
export const warnedLine = (words: readonly string[], name: string = NETWORKS.facebook.name) =>
  `Stopped: ${name} says “${words[0]}”. The extension stops on ${name} for today, and your ${name} limits are halved for a week.`;

/** Reads the page in the job's tab: a Facebook page. */
export async function readIn(tab: JobTab): Promise<ReadResult> {
  const answer = await tab.ask({ type: 'hfos-read' });
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

/** Reads the page in the job's tab, on whichever network it is. */
export async function readPageIn(tab: JobTab): Promise<PageRead> {
  return (await readIn(tab)) as PageRead;
}

/** A warning on the page: noted, and the end of the job, in its network's words. Null when there's none. */
export async function warnedOn(job: Job, page: PageRead): Promise<JobEnd | null> {
  if (!page.warnings.length) return null;
  await job.warn(page.warnings, page.url);
  return { line: warnedLine(page.warnings, NETWORKS[platformOf(page)].name), warned: true };
}

/** What HandsFreeOS answered, or the problem it said, thrown. */
export function valueOf<T>(answer: HfosAnswer<T>): T {
  if (!answer.ok) throw new Error(answer.problem.message);
  return answer.value;
}
