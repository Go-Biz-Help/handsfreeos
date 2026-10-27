/**
 * People found by topic on Instagram, LinkedIn and Alignable (docs/outreach.md, decision 92): the writers of posts the
 * AI called good, who liked or reacted to them and who commented, the businesses an Alignable search showed, and the
 * members of Alignable groups. Each is kept in `finds`, the person's own, as a profile with no customer: never in
 * `engagements` (warm leads who engaged with the person's own posts) and never in Contacts.
 *
 * - **Each is checked by the AI from their own page** before any like, follow, invitation or connection: a check
 *   marked `via = 'found'` (decision 46's checks, its own count a day), and only a good one puts them on Today.
 * - **What a commenter said** (`said`) waits for that check and goes once it's read, or after 14 days, so nothing a
 *   stranger wrote is kept.
 * - **Nobody new is read while 3 days of checks wait** (`findsWaitingMost`), so people found never run ahead of what
 *   gets checked.
 *
 * Browser-safe: the extension, the web, the phone and the worker read these words and shapes.
 */
import { NETWORKS, PLATFORMS, type Platform } from './networks';

/**
 * How someone was found, the strongest first: they wrote a post the AI called good, commented on one, liked or reacted
 * to one, are in a group, or a search showed them. Found again, a find changes only to a stronger one, and the people
 * to check go in this order.
 */
export const FIND_HOWS = {
  posted: 'Wrote a good post',
  commented: 'Commented on a good post',
  liked: 'Liked or reacted to a good post',
  member: 'In a group',
  searched: 'Found by a search',
} as const;
export type FindHow = keyof typeof FIND_HOWS;
export const FIND_HOW_KEYS = Object.keys(FIND_HOWS) as [FindHow, ...FindHow[]];

/** The stronger of two ways someone was found (`FIND_HOWS`' order): a find keeps it when they're found again. */
export const strongerHow = (a: FindHow, b: FindHow): FindHow =>
  FIND_HOW_KEYS.indexOf(a) <= FIND_HOW_KEYS.indexOf(b) ? a : b;

/**
 * What a check is of (`checks.via`): someone the person knows (decision 46), or someone found by topic. The server
 * sets it at each look; the readers about people the person knows decide by who they know now, never by this, and the
 * day's found checks are counted by it.
 */
export const CHECK_VIAS = {
  known: 'Someone you know',
  found: 'Someone found',
} as const;
export type CheckVia = keyof typeof CHECK_VIAS;
export const CHECK_VIA_KEYS = Object.keys(CHECK_VIAS) as [CheckVia, ...CheckVia[]];

/** The most people one save of finds takes: a Likes box's two screens, or a page of a group's members. */
export const FINDS_SAVE_MOST = 50;
/** How many days of a network's found checks may wait: past it, nobody new is read there. */
export const FINDS_WAITING_DAYS = 3;
/**
 * The most finds that wait for the AI's check on a network (the plan's `FINDS_WAITING_MOST`): 3 days of its found
 * checks. While that many wait, no likers, commenters, search results or members are read.
 */
export const findsWaitingMost = (foundChecksPerDay: number): number =>
  FINDS_WAITING_DAYS * Math.max(0, foundChecksPerDay);
/** What a commenter said, cut to this, kept only until the AI's check reads it. */
export const FIND_SAID_MOST = 300;
/** The hashtag, phrase or kind of business someone was found with, and the place a search showed. */
export const FIND_WORDS_MOST = 160;
export const FIND_PLACE_MOST = 100;
/** Someone found is checked, and offered on Today after a good check, within this many days of being found. */
export const FIND_FRESH_DAYS = 14;

/** A find as its fact line reads it: how, on which network, with what words, where, and in which group. */
export interface FindOf {
  readonly platform: Platform;
  readonly how: FindHow;
  /** The hashtag (without its #), the phrase or the kind of business it was found with. */
  readonly words: string | null;
  /** The place an Alignable search showed: "Austin, TX". */
  readonly place?: string | null;
  /** The name of the group they're in, or the group the post was in. */
  readonly group?: string | null;
}

/** What a like is called where people react instead: LinkedIn's reactions, Facebook's. */
const LIKED: Readonly<Record<Platform, string>> = {
  facebook: 'Reacted to',
  linkedin: 'Reacted to',
  instagram: 'Liked',
  alignable: 'Liked',
};

/** A post, as where it was found says: "a post under #austinroofing", "a post your search for “roofing” found". */
function postWhere(find: FindOf): string {
  const name = PLATFORMS[find.platform];
  if (find.group) return `a post in the ${name} group ${find.group}`;
  if (!find.words) return `a post on ${name}`;
  // A network that looks at hashtags found it under one; any other searched its posts with the words.
  return NETWORKS[find.platform].hashtags
    ? `a post under #${find.words}`
    : `a post your search for “${find.words}” found`;
}

/**
 * How someone was found, in one line for the AI's check and for Today's why: "Commented on a post under
 * #austinroofing", "Reacted to a post your search for “missed calls” found", "Found by your Alignable search for
 * “roofing contractor” in Austin", "In the Alignable group Austin Trades Circle".
 */
export function findFact(find: FindOf): string {
  const name = PLATFORMS[find.platform];
  switch (find.how) {
    case 'posted':
      return `Wrote ${postWhere(find)}`;
    case 'commented':
      return `Commented on ${postWhere(find)}`;
    case 'liked':
      return `${LIKED[find.platform]} ${postWhere(find)}`;
    case 'member':
      return find.group ? `In the ${name} group ${find.group}` : `In a group on ${name}`;
    case 'searched': {
      const where = find.place ? ` in ${find.place}` : '';
      return find.words
        ? `Found by your ${name} search for “${find.words}”${where}`
        : `Found by your ${name} search${where}`;
    }
  }
}
