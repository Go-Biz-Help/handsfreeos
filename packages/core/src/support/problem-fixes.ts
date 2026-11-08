/**
 * Problems fixed (20261027023100): each entry is one problem on the support desk's Problem reports that a change
 * fixed. Once it's live, the worker's `problem_reports.clear` moves every open report of that problem from before the
 * fix to Handled, as fixed: from a version before `fixedIn` (the browser extension, the phone app), or sent before
 * `before` (the web app, which has no version).
 *
 * The daily problem check adds an entry with each fix, in the same pull request, so the desk clears itself when the
 * fix ships. A report of the same problem from the fixed version or later stays open: the fix didn't hold.
 *
 * Browser-safe: plain values.
 */
import type { ProblemSource } from '../schemas/problem-report';

export interface ProblemFix {
  /** The tool that sent the reports: the browser extension unless said. */
  readonly source?: ProblemSource;
  /** Where ("facebook"), and the step ("friend_request"), as the reports say them. */
  readonly area: string;
  readonly job: string;
  /** The start of the reports' note, when only some of the step's reports are this problem. */
  readonly note?: string;
  /** The version with the fix. */
  readonly fixedIn?: string;
  /** Or, for a tool without versions: when the fix went live (an ISO time). */
  readonly before?: string;
  /** The pull request with the fix. */
  readonly pr: number;
  /** What was wrong and what changed, in a line, for whoever reads this list. */
  readonly said: string;
}

/** Newest last. */
export const PROBLEM_FIXES: readonly ProblemFix[] = [
  {
    area: 'alignable',
    job: 'friend_request',
    note: 'Alignable didn’t take the request',
    fixedIn: '0.124.0',
    pr: 478,
    said: 'Alignable’s monthly connection limit box left Connect showing; from 0.124.0 the limit is read and requests wait till the 1st.',
  },
  {
    area: 'facebook',
    job: 'friend_request',
    note: 'Facebook says it couldn’t tell where things stand',
    fixedIn: '0.126.3',
    pr: 510,
    said: 'A tab’s word was taken for the name on profiles with no username (0.126.1, #500); and a profile with no Add friend at all, only Message or Follow, read as a page it couldn’t read: it’s passed over now.',
  },
  {
    area: 'linkedin',
    job: 'friend_request',
    note: 'LinkedIn didn’t take the invitation',
    fixedIn: '0.126.1',
    pr: 500,
    said: 'The invitation box shows inside LinkedIn’s interop box now, so Send without a note was never pressed.',
  },
  {
    area: 'instagram',
    job: 'draft',
    note: 'the AI had nothing to write',
    fixedIn: '0.126.2',
    pr: 506,
    said: 'A reply seen by name alone went on Today with no chat to open, so the AI answered a chat that ended with your own message.',
  },
  {
    area: 'linkedin',
    job: 'friend_request',
    note: 'Sent (their name) an invitation to connect',
    fixedIn: '0.126.3',
    pr: 510,
    said: 'More’s menu shows outside the top card now, so Connect under More was pressed only by the AI helper; the runner looks in that menu itself.',
  },
  {
    area: 'linkedin',
    job: 'post_people.count',
    note: 'No reactions count on the post to open who reacted.',
    fixedIn: '0.126.3',
    pr: 510,
    said: 'A post minutes old with no reactions was reported; it’s reported only when HandsFreeOS saw reactions on it.',
  },
  {
    area: 'alignable',
    job: 'post_people.likers',
    note: 'Couldn’t open the post’s box of who liked it.',
    fixedIn: '0.126.3',
    pr: 510,
    said: 'On a group’s own discussion page (/groups/<group>/<discussion>) the count of likes was never pressed: only /biz/discussions counted.',
  },
  {
    area: 'alignable',
    job: 'events',
    note: 'Alignable showed no events in their town.',
    fixedIn: '0.126.4',
    pr: 528,
    said: 'Both town addresses only showed the town’s group; Alignable’s own Events page (/biz/events, its menu’s) is tried too now.',
  },
  {
    area: 'facebook',
    job: 'friend_request',
    note: 'Facebook showed a different page',
    fixedIn: '0.126.4',
    pr: 528,
    said: 'Opened by their number at their username, the read found no name (nor the post) the page showed: it looked in a part of the top bar marked main. It takes the page’s own main part now.',
  },
  {
    area: 'instagram',
    job: 'warm_up.comment',
    note: 'Couldn’t like their comment.',
    fixedIn: '0.126.5',
    pr: 549,
    said: 'The post showed 15 of its comments with only Instagram’s mark for more after them, nothing to press: the comments are scrolled down to it once now.',
  },
];

/** Whether an entry can clear anything: it names its version or its time. */
export const problemFixReady = (fix: ProblemFix): boolean =>
  Boolean(fix.fixedIn) || (Boolean(fix.before) && !Number.isNaN(Date.parse(fix.before!)));
