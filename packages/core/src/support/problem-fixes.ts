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
    fixedIn: '0.126.1',
    pr: 500,
    said: 'On a profile with no username, a tab’s word (Check-ins) was taken for the name, so Add Friend with their name didn’t count.',
  },
  {
    area: 'linkedin',
    job: 'friend_request',
    note: 'LinkedIn didn’t take the invitation',
    fixedIn: '0.126.1',
    pr: 500,
    said: 'The invitation box shows inside LinkedIn’s interop box now, so Send without a note was never pressed.',
  },
];

/** Whether an entry can clear anything: it names its version or its time. */
export const problemFixReady = (fix: ProblemFix): boolean =>
  Boolean(fix.fixedIn) || (Boolean(fix.before) && !Number.isNaN(Date.parse(fix.before!)));
