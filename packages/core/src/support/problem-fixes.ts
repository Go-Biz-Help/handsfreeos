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
    pr: 609,
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
    area: 'alignable',
    job: 'events',
    note: 'Alignable showed nobody hosting or going to an event.',
    fixedIn: '0.139.1',
    pr: 615,
    said: 'A group’s event draws its hosts in a part of their own, twice, under a label that isn’t a heading, so the rows around them took in the whole page: they’re read from that part now, once each, with the event’s name, and a link to Alignable’s own search of events is passed over.',
  },
  {
    area: 'facebook',
    job: 'send',
    note: 'couldn’t find a chat open with them',
    fixedIn: '0.139.1',
    pr: 615,
    said: 'Their new chat’s window showed Facebook’s loading mark where the box goes: the writer waits up to ten seconds more now while a chat window is still drawing its box (0.128.4, #562). Then 6 chat windows were left open over the page, and 5 more in the corner, from earlier messages: each window a message went in is closed once it has gone now (0.134.1, #577). Then one person’s message failed twice, a day apart: the first try left their window open, linking to them by a number HandsFreeOS didn’t keep, and their Message only brought it up again. That window is checked now as one that just opened: their number’s profile is opened, and the message goes once Facebook shows it’s theirs (0.134.3, #595). Then five windows were left open with other people, covering the page, and theirs never showed: every chat window left open is closed before their Message is pressed now, unless the person was writing in it (the owner’s pick).',
  },
  {
    area: 'instagram',
    job: 'post.feed',
    note: 'Instagram didn’t show the box to write a post',
    fixedIn: '0.139.2',
    pr: 619,
    said: 'Create’s menu is on the page all along, hidden, and its icons carry a title, so its Post read “PostPost” and was never picked: a control’s words are what a person sees now.',
  },
  {
    area: 'linkedin',
    job: 'post.feed',
    note: 'LinkedIn didn’t take its pictures',
    fixedIn: '0.139.2',
    pr: 619,
    said: 'LinkedIn’s newer box opens a window of its own for pictures (Upload from computer or a drop place, then Next): the files go in there now.',
  },
  {
    area: 'facebook',
    job: 'post.page',
    note: 'Meta Business Suite didn’t show Create post',
    fixedIn: '0.139.2',
    pr: 619,
    said: 'A newer Page’s link has its profile number, which Business Suite won’t open: the Page’s own number (delegate_page) is tried first now, then the others.',
  },
  {
    area: 'facebook',
    job: 'warm_up',
    note: 'Couldn’t like (their name)’s post',
    fixedIn: '0.140.2',
    pr: 626,
    said: 'Outlines kept the words on a post’s buttons from 0.139.1 (#615), with chat windows closed before a like (the owner’s pick). They showed the posts that never took a like were cover photo updates with only “Share (their name)’s post” and who reacted, no Like at all: a post with no Like is never picked now, and a profile whose posts all have none has nothing to like, with nothing to report.',
  },
  {
    area: 'facebook',
    job: 'send',
    note: 'couldn’t find “Message” on their profile',
    fixedIn: '0.139.3',
    pr: 621,
    said: 'Their profile showed Facebook’s “This content isn’t available right now” (they blocked the person, or closed or hid their profile), with no Message on it: a profile Facebook won’t show is passed over now, as one with nothing to report.',
  },
  {
    area: 'instagram',
    job: 'post_people.likers',
    note: 'Couldn’t open the post’s Likes box.',
    fixedIn: '0.140.4',
    pr: 632,
    said: 'On a post the person had liked, its bar says Unlike before the count of likes, and only a Like was looked for: an Unlike counts now (0.139.1, #615). Then a reel opened in the reels player, where the bar’s Comment is named by its own count beside its icon, so the count of likes before it was never found: the Comment is known by its icon now.',
  },
  {
    area: 'facebook',
    job: 'post.page',
    note: 'It pressed Post on your Page, but Facebook didn’t show the post going up',
    fixedIn: '0.140.5',
    pr: 631,
    said: 'Both posts went up: Business Suite was still publishing 30 seconds after Publish (its progress bar and a notice with Learn more over the page), with the Page’s Instagram picked in Post to too. Instagram comes off Post to now, Business Suite gets 90 seconds, and then the Page is read for the post before it says it didn’t go up.',
  },
  {
    area: 'threads',
    job: 'checkup.like',
    note: 'Liking: no Like on the post',
    fixedIn: '0.140.7',
    pr: 636,
    said: 'Threads names its posts’ Like and Reply icons by a title on the icon (and a <title> inside), not an aria-label, which was all the kit read: it reads all three now.',
  },
  {
    area: 'threads',
    job: 'checkup.comment',
    note: 'Commenting: no box to reply in',
    fixedIn: '0.140.7',
    pr: 636,
    said: 'The post’s Reply wasn’t found (its icon is named by a title), and the box Threads draws under a post on its own page, named only “Empty text field…”, wasn’t taken for the box to reply in. Both are now, and that box sends with its arrow named Reply.',
  },
  {
    area: 'threads',
    job: 'checkup.comment',
    note: 'Commenting: the reply box didn’t empty again',
    fixedIn: '0.140.8',
    pr: 638,
    said: 'Threads’ reply box ignores the “select all, delete” the extension used to take its word out again. It now waits for the box to see the selection and types nothing over it, which Threads’ editor takes.',
  },
  {
    area: 'threads',
    job: 'checkup.follow',
    note: 'Following: not tried, you follow them already',
    fixedIn: '0.141.2',
    pr: 644,
    said: 'Threads’ side menu lists Following among its feeds, as a link, and the profile reader took it for the profile’s own Following, so every profile read as followed. The header now leaves out side menus and the posts under it, and starts from a button that isn’t a link.',
  },
  {
    area: 'threads',
    job: 'checkup.followers',
    note: 'Your followers: pressed your count of followers',
    fixedIn: '0.141.4',
    pr: 647,
    said: 'Threads wraps the button around the count of followers in two parts that say just the same, and the outer one was pressed, which opens nothing. The innermost part is taken now and the button around it pressed, as tried in the owner’s own Chrome.',
  },
  {
    area: 'instagram',
    job: 'draft',
    note: 'the AI had nothing to say on it',
    fixedIn: '0.141.3',
    pr: 646,
    said: 'Each came right after the AI wrote, with its drafts all taken out by the checks: no comment is the right answer when there’s nothing real to say (decision 165), so it’s passed over now with nothing reported. A reel in the reels player is now looked at before its comment is drafted, as a post is: till now the AI had only its words.',
  },
  {
    area: 'facebook',
    job: 'comment',
    note: 'the AI had nothing to say on it',
    fixedIn: '0.141.3',
    pr: 646,
    said: 'Each came right after the AI wrote, with its drafts all taken out by the checks: no comment is the right answer when there’s nothing real to say (decision 165), so it’s passed over now with nothing reported.',
  },
  {
    area: 'alignable',
    job: 'members',
    note: 'Alignable showed no members of a group.',
    fixedIn: '0.147.1',
    pr: 656,
    said: 'The last read of the group stopped just as its member list ended, so this read scrolled past the end keeping nothing (decision 148) and saved no depth, so it would every time. When the list ends before where the last read got to, nothing is reported now and the next read starts at the top.',
  },
  {
    area: 'facebook',
    job: 'post.page',
    note: 'It pressed Publish for your Page in Meta Business Suite, but didn’t find the post on your Page after',
    fixedIn: '0.147.6',
    pr: 668,
    said: 'The post was on the Page, first, but Facebook leaves a new post’s own link empty until it’s pointed at, and cut its words short with “…” before See more, so it was never matched (0.147.5, 17 Nov). A post now counts as there by its words, with or without a link, and the “…” is left off. Before that, the Page was read while its posts still said “Loading...”, fixed in 0.147.3 (#660).',
  },
  {
    area: 'threads',
    job: 'post.feed',
    note: 'Threads didn’t show the box to write a post',
    fixedIn: '0.147.5',
    pr: 662,
    said: 'Create opened Threads’ New thread box, but Threads now draws it as a menu, not a box over the page, so it was never found. A menu with a box to write in counts now; one without (More’s) never does (0.147.4, #659). Then a page showed no Create, and the feed’s box, labelled “Empty text field…” while it shows “What’s new?”, wasn’t known by its words, so nothing was pressed: every way Threads shows to open the box (the feed’s box, New thread, Create) is found by its label or its words now, and tried in turn till one opens it.',
  },
  {
    area: 'linkedin',
    job: 'friend_request',
    note: 'you’re connected already',
    fixedIn: '0.147.9',
    pr: 670,
    said: 'They weren’t connected: LinkedIn’s newer profile can say “· 1st” beside the real “· 2nd”, and with Follow first and Connect under More (not on the page until More is pressed) the “· 1st” was taken as theirs. The other degree is theirs now whenever both show, so More is opened and the invitation sent. Someone truly connected is passed over without a report, as nothing’s left to do.',
  },
  {
    area: 'x',
    job: 'checkup.comment',
    note: 'Commenting: no button to send by the reply box',
    fixedIn: '0.147.11',
    pr: 675,
    said: 'X wraps its box to reply in more than 14 parts deep below its Reply, and the Reply was looked for only 14 parts up, so it was never found and no comment could go. It’s looked for as far up as it takes now, never past the post’s own cell or a box over the page.',
  },
  {
    area: 'instagram',
    job: 'send',
    note: 'couldn’t find the post’s own box to comment in',
    fixedIn: '0.147.13',
    pr: 680,
    said: 'The reel’s Comment opened its comments, but their box (“Add a comment…”) is now an input beside Emoji, in no form, and only inputs marked as text boxes were looked for, so one with no type was never found (0.147.11, 18 Nov; the likely cause, as the outline doesn’t show an input’s type). An input with no type counts as a box to write in now. Before that, a reel opened in the reels player, which shows no box till its own Comment opens its comments: the comment goes on the reel the player opened on, while it’s theirs, by pressing its Comment and writing in the box that shows (0.141.1, #643).',
  },
  {
    area: 'linkedin',
    job: 'warm_up',
    note: 'LinkedIn showed a different page',
    fixedIn: '0.148.1',
    pr: 689,
    said: 'LinkedIn went on to its security check (/checkpoint/challenge/…) after the step had read the page, so the check’s warning was never seen: three warm-ups were handed over in turn, and LinkedIn wasn’t stopped for the day. A step that didn’t go reads the page again after a moment now, and a warning there stops LinkedIn for the day.',
  },
  {
    area: 'instagram',
    job: 'posts.page',
    note: 'No posts on the page.',
    fixedIn: '0.148.1',
    pr: 689,
    said: 'A hashtag’s search showed nothing but Instagram’s loading mark when it was read, and its list ended at once as the page had nowhere to scroll. While the page’s main part shows only the loading mark, it’s read again after the list’s pause now.',
  },
  {
    area: 'facebook',
    job: 'draft',
    note: 'The AI is busy right now',
    // The worker's fix, not the extension's: by when it went live, as for a tool without versions.
    before: '2026-11-20T18:30:00Z',
    pr: 689,
    said: 'Now and then Claude, and the backup AI behind it, were both overloaded or out of reach for a draft (5 on the evening of 19 Nov among about 380 answers), and the draft failed at once. A busy AI is asked once more after 3 seconds now, as an empty answer already was.',
  },
  {
    area: 'instagram',
    job: 'warm_up',
    note: 'Couldn’t like (their name)’s post on this visit',
    fixedIn: '0.150.3',
    pr: 703,
    said: 'A reel opens in the reels player, with the next reel under it, no article and a Comment named by its count, so no author was found and no like on a reel ever went: the reel it opened on is found by its own Like and its account’s links (0.136.1, #607). Then a post or reel on their grid made with other accounts reads “(someone) and 2 others” over it, so its author was someone else: one they made with its author is liked now (0.140.2, #626). Then, on a reel whose account is Verified, the tick’s own title (“Verified”) read as words between the account and “and”: an icon’s title is passed over now.',
  },
  {
    area: 'facebook',
    job: 'comment',
    note: 'couldn’t find the box to comment in',
    fixedIn: '0.150.3',
    pr: 703,
    said: 'The post’s bar had Like and Share but no Comment, and no box: its author limited who can comment. The step passes such a post over (“it doesn’t let you comment on it”) with nothing reported (0.141.1, #643). Then a post’s own page showed only Facebook’s “This content isn’t available right now”, as its writer deleted or hid it after it was found: such a post is passed over too now, before the AI is asked for a comment.',
  },
  {
    area: 'facebook',
    job: 'friend_request',
    note: 'Facebook didn’t take it',
    fixedIn: '0.151.2',
    pr: 734,
    said: 'From 20 Nov 2026 Facebook answered Add friend with a box of its own (a heading, a line and one button), and the request didn’t go: none of 8 on 22 Nov, the box’s words hidden from the reports. The step now says Facebook showed a box, in its words, the desk sorts that as Facebook’s limit, and after 2 in a row no more friend requests go that day (decision 192).',
  },
  {
    area: 'instagram',
    job: 'post_people.likers',
    note: 'Nobody read in the post’s Likes box',
    fixedIn: '0.157.1',
    pr: 0,
    said: 'The Likes box opened and listed only the person’s own row, which is never read, so nobody else was there to read and nothing was wrong. It’s noted now only when the box shows nobody at all.',
  },
];

/** Whether an entry can clear anything: it names its version or its time. */
export const problemFixReady = (fix: ProblemFix): boolean =>
  Boolean(fix.fixedIn) || (Boolean(fix.before) && !Number.isNaN(Date.parse(fix.before!)));
