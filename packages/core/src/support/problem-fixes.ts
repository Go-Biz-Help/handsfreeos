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
    fixedIn: '0.128.4',
    pr: 562,
    said: 'A tab’s word was taken for the name on profiles with no username (0.126.1, #500); a profile with no Add friend at all, only Message or Follow, read as a page it couldn’t read (0.126.3, #510); and in professional mode the owner’s own button (“Book now”, “Call now”) hid that there was no Add friend: all three are passed over now.',
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
  {
    area: 'facebook',
    job: 'warm_up',
    note: 'No post of',
    fixedIn: '0.130.1',
    pr: 565,
    said: 'Their profile still showed only Facebook’s loading boxes where the posts go after the four scrolls: a loading box is waited on, in view, a little longer now while no post is drawn yet (0.126.6, #552); and on a profile where Facebook’s own line says there are no posts, the warm-up ends as found done, with no report.',
  },
  {
    area: 'facebook',
    job: 'warm_up',
    note: 'None of (their name)’s posts were right to like',
    fixedIn: '0.128.3',
    pr: 556,
    said: 'Only one of their posts was drawn, with more still loading below it, so the AI picked from that one alone: the wait on a loading box goes on now while fewer than six posts are drawn.',
  },
  {
    area: 'facebook',
    job: 'send',
    note: 'couldn’t find a chat open with them',
    fixedIn: '0.134.3',
    pr: 595,
    said: 'Their new chat’s window showed Facebook’s loading mark where the box goes: the writer waits up to ten seconds more now while a chat window is still drawing its box (0.128.4, #562). Then 6 chat windows were left open over the page, and 5 more in the corner, from earlier messages: each window a message went in is closed once it has gone now (0.134.1, #577). Then one person’s message failed twice, a day apart: the first try left their window open, linking to them by a number HandsFreeOS didn’t keep, and their Message only brought it up again. That window is checked now as one that just opened: their number’s profile is opened, and the message goes once Facebook shows it’s theirs.',
  },
  {
    area: 'linkedin',
    job: 'send',
    note: 'couldn’t find the box to write in',
    fixedIn: '0.128.4',
    pr: 562,
    said: 'LinkedIn opened the conversation as a messaging page in its interop frame while the tab stayed at their profile: that box counts now when the frame’s conversation is with them.',
  },
  {
    area: 'instagram',
    job: 'read.posts',
    note: 'Profile: Instagram’s answer had no account id',
    fixedIn: '0.130.0',
    pr: 564,
    said: 'Instagram’s profile answer is gone (404), so a creator’s profile came from their page with no account number and their posts read stopped: their posts are asked for by the number their page names itself with, then by their name, then one at a time from their grid.',
  },
  {
    area: 'facebook',
    job: 'draft',
    note: 'The AI couldn’t write that just now',
    // The worker's fix, not the extension's: by when it was made, as for a tool without versions.
    before: '2026-11-13T02:00:00Z',
    pr: 608,
    said: 'About 1 in 25 of the AI’s answers for outreach came back with no words at all (#565 asks once more), and some came back empty twice: on that second try the backup AI writes the draft now (decision 162).',
  },
  {
    area: 'instagram',
    job: 'read.posts',
    note: 'Posts: Instagram’s list of their posts didn’t come',
    fixedIn: '0.131.0',
    pr: 566,
    said: 'Neither of Instagram’s lists of a creator’s posts comes any more (404 by number and by name), so their posts are read one at a time from their grid, scrolled for up to 50: the usual way now, so a read done that way isn’t reported.',
  },
  {
    area: 'instagram',
    job: 'warm_up',
    note: 'Couldn’t like (their name)’s post on this visit',
    fixedIn: '0.136.1',
    pr: 607,
    said: 'A reel opens in the reels player, with the next reel under it, no article and a Comment named by its count, so no author was found and no like on a reel ever went: the reel it opened on is found by its own Like and its account’s links.',
  },
];

/** Whether an entry can clear anything: it names its version or its time. */
export const problemFixReady = (fix: ProblemFix): boolean =>
  Boolean(fix.fixedIn) || (Boolean(fix.before) && !Number.isNaN(Date.parse(fix.before!)));
