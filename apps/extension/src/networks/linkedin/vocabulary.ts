/**
 * LinkedIn's own words, in English: its buttons and their labels for screen readers, its tabs, and the lines it
 * writes about people ("2nd degree connection", "Sam Lee and 11 other mutual connections", "Sent 3 weeks ago").
 * The readers go by them and skip them when they look for a name or a detail. LinkedIn shows these in the language
 * the person uses it in, so for now the readers expect English, as Facebook's do (../facebook/vocabulary.ts).
 */
import { isWhen as facebookWhen, parseCount } from '../facebook/vocabulary';
import type { Degree, Notice } from './types';

export { parseCount };

/** Lower-case, exactly as LinkedIn shows them. */
export const UI_WORDS: ReadonlySet<string> = new Set([
  'about',
  'accept',
  'activity',
  'add profile section',
  'all',
  'all filters',
  'analytics',
  'comment',
  'comments',
  'connect',
  'connections',
  'contact info',
  'delivered',
  'education',
  'edited',
  'enhance profile',
  'experience',
  'featured',
  'focused',
  'follow',
  'followers',
  'following',
  'for business',
  'highlights',
  'home',
  'ignore',
  'inmail',
  'invitations',
  'jobs',
  'like',
  'linkedin',
  'load more',
  'locations',
  'manage',
  'manage invitations',
  'me',
  'mentions',
  'message',
  'messaging',
  'more',
  'more actions',
  'my network',
  'my posts',
  'new message',
  'notifications',
  'open to',
  'other',
  'pages',
  'pending',
  'people',
  'posts',
  'posts you share will be displayed here.',
  'premium',
  'private to you',
  'promoted',
  'received',
  'recently added',
  'reply',
  'repost',
  'resources',
  'search',
  'search messages',
  'see all',
  'see more',
  'seen',
  'send',
  'sent',
  'show all',
  'show more results',
  'skills',
  'sort by:',
  'starred',
  'status is away',
  'status is offline',
  'status is online',
  'status is reachable',
  'suggested for you',
  'top skills',
  'unread',
  'verified',
  'view profile',
  'visible to anyone on or off linkedin',
  'withdraw',
  'write a message…',
  'you',
  'you haven’t posted yet',
  "you haven't posted yet",
  '…more',
  '…see more',
]);

// ------------------------------------------------------------------------------------------------ buttons

/**
 * The buttons that say where you stand with someone, each by its words ("Connect") or its label for screen readers
 * ("Invite Dana Reyes to connect"), whichever the page gives.
 */
export const CONNECT = /^(connect|invite .+ to connect)$/i;
export const PENDING = /^(pending|pending,? click to withdraw invitation sent to .+)$/i;
export const WITHDRAW = /^(withdraw|withdraw (an )?invitation( sent to .+)?)$/i;
export const ACCEPT =
  /^(accept|accept .+[’']s? invitation|accept (an )?invitation (to connect )?from .+)$/i;
export const IGNORE =
  /^(ignore|ignore .+[’']s? invitation|ignore (an )?invitation (to connect )?from .+)$/i;
export const MESSAGE = /^(message|message .+|send (a )?message to .+)$/i;
/** "Follow", "+ Follow", "Follow Dana Reyes"; and "Following" once you do. */
export const FOLLOW = /^(\+\s*)?follow( .+)?$/i;
export const FOLLOWING = /^(following|following .+|unfollow .+)$/i;
export const MORE = /^(more|more actions)$/i;
/** Under More on a connection's profile. */
export const REMOVE_CONNECTION = /^(remove connection|remove your connection( to .+)?)$/i;
/** The buttons on your own profile, and only there. */
export const OWN_PROFILE =
  /^(edit intro|open to|add profile section|add section|enhance profile|resources)$/i;

/**
 * A post's own bar, after what it says: Like (or "React Like"), Comment, Repost, Send. LinkedIn's newer layout (the
 * owner's outlines of 16 Oct 2026) labels the reaction button by its state ("Reaction button state: no reaction"),
 * and the readers find that one by where it is (./posts.ts, `barOf`), never by these words.
 */
export const LIKE = /^(like|react like|unreact like)$/i;
export const COMMENT = /^comment$/i;
export const REPOST = /^repost$/i;
export const SEND = /^(send|send in a private message)$/i;
/** A comment's own bar ends with Reply. */
export const REPLY = /^reply$/i;
/** The menu at the top of every post: "Open control menu for post by Dana Reyes". A comment's says "comment". */
export const POST_MENU = /^open control menu for post\b/i;
/** Who the post's menu says wrote it: "Open control menu for post by Dana Reyes" names Dana Reyes. */
export const POST_MENU_BY = /^open control menu for post by (.+)$/i;
/** What LinkedIn writes at the top of a post it was paid to show: "Promoted", "Promoted by SolarBridge". */
export const PROMOTED = /^promoted\b/i;
/**
 * A reaction button's words, where LinkedIn says whether one of yours is on it: "Reaction button state: like" or
 * "Unreact Like" (one is), "Reaction button state: no reaction", "React Like" or "Like" (none is). The readers go by
 * what changes when it's pressed and use these only to say which way it changed (./posts.ts, `hasYours`).
 */
export const REACTED = /^unreact\b|\bbutton state:\s*(?!no reaction\b)\S/i;
export const NOT_REACTED =
  /\bno reaction\b|^react\b|^(like|celebrate|support|love|insightful|funny)$/i;

/** Whether a button or its label is one of the above: one of LinkedIn's actions on someone, never a name or a place. */
export function isAction(label: string): boolean {
  return [
    CONNECT,
    PENDING,
    WITHDRAW,
    ACCEPT,
    IGNORE,
    MESSAGE,
    FOLLOW,
    FOLLOWING,
    MORE,
    REMOVE_CONNECTION,
    OWN_PROFILE,
  ].some((pattern) => pattern.test(label));
}

// ----------------------------------------------------------------------------------------- about people

/** How far someone is, wherever a line says it: "• 2nd", "2nd degree connection", "3rd+". */
const DEGREE = /(?:^|[\s•·(])(1st|2nd|3rd)\+?(?=$|[\s•·),])/i;
/** A line that says nothing but how far someone is. */
const DEGREE_ONLY = /^[\s•·]*(?:(?:1st|2nd|3rd)\+?(?:\s+degree(?:\s+connection)?)?[\s•·]*)+$/i;

export function degreeIn(text: string): Degree | null {
  const match = DEGREE.exec(text);
  return match ? (match[1]!.toLowerCase() as Degree) : null;
}

/** How far someone is, when that's all a line says. */
export function degreeOnly(line: string): Degree | null {
  return DEGREE_ONLY.test(line) ? degreeIn(line) : null;
}

/** How many names "Sam Lee, Avery Lane and Jordan Blake" holds. */
const namesCount = (names: string) => names.split(/,\s*|\s+and\s+/).filter(Boolean).length;

/**
 * How many mutual connections a line says there are: "12 mutual connections", "Sam Lee and 11 other mutual
 * connections" (12), "Sam Lee and Avery Lane are mutual connections" (2), "Sam Lee is a mutual connection" (1).
 */
export function mutualCount(line: string): number | null {
  let match = /^([\d,]+)\s+(?:mutual|shared) connections?$/i.exec(line);
  if (match) return parseCount(match[1]!);
  match = /^(.+?)\s+and\s+([\d,]+)\s+other (?:mutual|shared) connections?$/i.exec(line);
  if (match) return namesCount(match[1]!) + (parseCount(match[2]!) ?? 0);
  match = /^(.+?)\s+(?:is a|are) (?:mutual|shared) connections?$/i.exec(line);
  return match ? namesCount(match[1]!) : null;
}

/** "1,234 followers", "12K followers": how many follow someone, as their profile's top says (decision 81). */
export function followerCount(line: string): number | null {
  const match = /^([\d.,]+\s*[km]?)\+?\s+followers?$/i.exec(line.trim());
  return match ? parseCount(match[1]!) : null;
}

/** "500+ connections", "1,234 followers": counts about someone, never about them in their words. */
const COUNTS = /^[\d.,]+\+?\s*[km]?\s+(connections?|followers?|reactions?|comments?|reposts?)$/i;
/** "She/Her", "(They/Them)": what a member says to call them, beside their name. */
export const PRONOUNS = /^\(?(?:she|he|they|ze|xe)\s*\/\s*[a-z]+(?:\s*\/\s*[a-z]+)?\)?$/i;
/** "Current: Owner at Acme Plumbing", "Past: …": what people search adds under someone, beside their own words. */
export const SUMMARY = /^(current|past|summary|skills|services):\s/i;
/** "Connected on October 3, 2026", "Connected 2 weeks ago": on your connections. */
export const CONNECTED = /^connected\s+(on\s+.+|today|yesterday|.+\s+ago)$/i;

// ------------------------------------------------------------------------------------------------ times

/** LinkedIn's short times, beyond Facebook's: "2mo", "1yr". */
const SHORT = /^\d+\s?(?:s|m|h|d|w|mo|mos|y|yr|yrs)$/i;

/**
 * How LinkedIn says when something happened: "3h", "2mo", "Yesterday", "Oct 3", "2:15 PM", "3 days ago", and the
 * rest of Facebook's ways (../facebook/vocabulary.ts).
 */
export function isWhen(text: string): boolean {
  return facebookWhen(text) || SHORT.test(text.trim());
}

/** A time that is only a time of day: "2:15 PM". */
export const CLOCK = /^\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?$/i;

/** "Sent 3 weeks ago", "Sent today": when you sent an invitation. */
export function isSentWhen(line: string): boolean {
  const match = /^sent\s+(.+)$/i.exec(line.trim());
  return match !== null && (isWhen(match[1]!) || /^(today|yesterday)$/i.test(match[1]!));
}

/** A post's time as printed at its top: "3h" from "3h • Edited •", or "3 hours ago" where only that's written. */
export function postTimeOf(text: string): string | null {
  const first = text.split(/\s*[•·]\s*/)[0]?.trim() ?? '';
  return first && isWhen(first) && !CLOCK.test(first) ? first : null;
}

/** Whether a piece of text is LinkedIn's own words rather than something a person wrote. */
export function isLinkedInText(text: string): boolean {
  const t = text.trim();
  return (
    UI_WORDS.has(t.toLowerCase()) ||
    COUNTS.test(t) ||
    isWhen(t) ||
    isSentWhen(t) ||
    CONNECTED.test(t) ||
    degreeOnly(t) !== null ||
    mutualCount(t) !== null ||
    /^[·•|]$/.test(t)
  );
}

// ------------------------------------------------------------------------------------------------ names

/**
 * A member's name from the words around it on a link or a picture: "View Dana Reyes’ profile", "View: Dana Reyes •
 * 2nd Owner at …", "Dana Reyes’s profile picture", "Photo of Dana Reyes", "Dana Reyes • 2nd" are all "Dana Reyes".
 */
export function nameFrom(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^view:?\s+/i, '')
    .replace(/^(profile (picture|photo) of|photo of|picture of)\s+/i, '')
    .replace(/[’']s?\s+(profile( picture| photo)?|photo|picture)$/i, '')
    .replace(/\s+(profile picture|profile photo)$/i, '')
    .replace(/\s*[•·].*$/, '')
    .trim();
}

// ---------------------------------------------------------------------------------------------- notices

/** What a notification is about, from its words. The first that matches wins. */
export const NOTICE_KINDS: readonly (readonly [RegExp, Notice['kind']])[] = [
  [/\baccepted your invitation\b/i, 'accepted'],
  [/\b(viewed your profile|your profile was viewed)\b/i, 'viewed'],
  [/\b(mentioned|tagged) you\b/i, 'mention'],
  [/\b(commented on|replied to)\b/i, 'comment'],
  [
    /\b(reacted to|likes?|liked|loves?|celebrates?|supports?|finds? .* (funny|insightful))\b.*\byour\b/i,
    'reaction',
  ],
];

/** The words a notification uses after the names: "Sam Lee and 3 others reacted to…". */
export const AFTER_NAMES =
  /\s(accepted|viewed|mentioned|tagged|commented|replied|reacted|likes?|liked|loves?|celebrates?|supports?|finds?|reposted|shared|posted|started|is|was|has|have|just|also|followed|endorsed|invited|appeared|wants?)\b/i;

// --------------------------------------------------------------------------------------------- warnings

/**
 * LinkedIn's warnings: the weekly invitation limit, a restricted account, a security check, the search limit for free
 * accounts. Any of them stops LinkedIn for the day (the plan's "Each network on its own"), and only LinkedIn.
 */
export const WARNINGS: readonly RegExp[] = [
  /\b(reached|hit) the weekly invitation limit\b/i,
  /\bweekly (invitation|invite) limit\b/i,
  /\byou['’]re out of invitations\b/i,
  /\btoo many (pending )?invitations\b/i,
  /\b(account|profile) (has been|was|is) (temporarily )?restricted\b/i,
  /\b(we['’]ve|we have) (temporarily )?restricted your account\b/i,
  /\btemporarily restricted\b/i,
  /\bquick security check\b/i,
  /\b(complete|pass|do) (a|this|the) security (check|verification)\b/i,
  /\bverify (your identity|it['’]s (really )?you)\b/i,
  /\breached the (monthly|commercial use) limit\b/i,
  /\bmonthly limit for (profile )?searches\b/i,
  /\bcommercial use limit\b/i,
  /\bunusual activity\b/i,
];
