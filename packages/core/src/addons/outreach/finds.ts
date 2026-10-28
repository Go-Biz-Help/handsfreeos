/**
 * People found by topic on Instagram, LinkedIn and Alignable (docs/outreach.md, decision 92): the writers of posts the
 * AI called good, who liked or reacted to them and who commented, the businesses an Alignable search showed, the
 * members of Alignable groups, the followers of an Instagram account like the business's (decision 110), and the hosts
 * and guests of Alignable events near the person (decision 112). Each is kept in `finds`, the person's own, as a
 * profile with no customer: never in `engagements` (warm leads who engaged with the person's own posts) and never in
 * Contacts.
 *
 * - **Each is checked by the AI from their own page** before any like, follow, invitation or connection: a check
 *   marked `via = 'found'` (decision 46's checks, its own count a day), and only a good one puts them on Today.
 * - **What a commenter said** (`said`) waits for that check and goes once it's read, or after 14 days, so nothing a
 *   stranger wrote is kept.
 * - **Nobody new is read while 3 days of checks wait** (`findsWaitingMost`), so people found never run ahead of what
 *   gets checked.
 *
 * Browser-safe: the extension, the web, the phone and the worker read these words and shapes. The server's side is
 * ./ops/finds.ts.
 */
import { z } from 'zod';
import { GroupRef } from './activity';
import { quoted, says } from './fit';
import { NETWORKS, PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import type { PlaybookDetails } from './playbooks';
import { PersonName, ProfileRef } from './saves';

/**
 * How someone was found, the strongest first: they wrote a post the AI called good, commented on one, liked or reacted
 * to one, are in a group, host or go to an event near the person (decision 112), follow an account like the
 * business's (decision 110), or a search showed them. Found again, a find changes only to a stronger one, and the
 * people to check go in this order.
 */
export const FIND_HOWS = {
  posted: 'Wrote a good post',
  commented: 'Commented on a good post',
  liked: 'Liked or reacted to a good post',
  member: 'In a group',
  event: 'At an event near you',
  follows: 'Follows an account like yours',
  searched: 'Found by a search',
} as const;
export type FindHow = keyof typeof FIND_HOWS;
export const FIND_HOW_KEYS = Object.keys(FIND_HOWS) as [FindHow, ...FindHow[]];

/** The stronger of two ways someone was found (`FIND_HOWS`' order): a find keeps it when they're found again. */
export const strongerHow = (a: FindHow, b: FindHow): FindHow =>
  FIND_HOW_KEYS.indexOf(a) <= FIND_HOW_KEYS.indexOf(b) ? a : b;

/**
 * What a check is of (`checks.via`): someone the person knows (decision 46), someone found by topic, or one of their
 * followers on Facebook who isn't their friend (decision 113), checked like a friend. The server sets it at each look;
 * the readers about people the person knows decide by who they know now, never by this, and the day's checks are
 * counted by it: a follower's with the people they know, someone found's on its own.
 */
export const CHECK_VIAS = {
  known: 'Someone you know',
  found: 'Someone found',
  follower: 'Someone who follows you',
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
/**
 * How many days of the network's likes the good fits found may wait for theirs (the warm-up before a request): past
 * it, nobody more is checked till Today catches up.
 */
export const FIND_LIKES_BEHIND_DAYS = 2;
/** What a commenter said, cut to this, kept only until the AI's check reads it. */
export const FIND_SAID_MOST = 300;
/** The hashtag, phrase or kind of business someone was found with, and the place a search showed. */
export const FIND_WORDS_MOST = 160;
export const FIND_PLACE_MOST = 100;
/** Someone found is checked, and offered on Today after a good check, within this many days of being found. */
export const FIND_FRESH_DAYS = 14;
/**
 * A group's members are reached only once its leaders were read first, as Facebook's admins are (decision 92): a
 * members page read with no leaders on it marks them read, and so does this many days after the person joined, so a
 * reader drawn from guessed markup never holds the members back for good.
 */
export const LEADERS_WAIT_DAYS = 7;

/** A find as its fact line reads it: how, on which network, with what words, where, and in which group. */
export interface FindOf {
  readonly platform: Platform;
  readonly how: FindHow;
  /**
   * The hashtag (without its #), the phrase or the kind of business it was found with; an account like the business's
   * with its @ ("@austinchamber"), whose post or followers it was.
   */
  readonly words: string | null;
  /** The place an Alignable search showed, or the town an event is in: "Austin, TX". */
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
  // An account like the business's (decision 110): its own post.
  if (find.words.startsWith('@')) return `a post by ${find.words}`;
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
    case 'event': {
      const where = find.place ? ` in ${find.place}` : '';
      return find.words
        ? `Hosting or going to the ${name} event “${find.words}”${where}`
        : `Hosting or going to an event on ${name}${where}`;
    }
    case 'follows':
      return find.words
        ? `Follows ${find.words} on ${name}`
        : `Follows an account like yours on ${name}`;
    case 'searched': {
      const where = find.place ? ` in ${find.place}` : '';
      return find.words
        ? `Found by your ${name} search for “${find.words}”${where}`
        : `Found by your ${name} search${where}`;
    }
  }
}

/**
 * Whether what someone shows says a playbook's skip word in quotes ("“Realtor”"), any playbook's, as a post's words
 * are weighed (./posts.ts `postLook`): the word, or null. Someone who says one is never kept as found.
 */
export function skipWordIn(
  playbooks: readonly { readonly details: Pick<PlaybookDetails, 'skip'> }[],
  lines: readonly string[],
): string | null {
  if (!lines.length) return null;
  return (
    playbooks.flatMap((p) => p.details.skip.flatMap(quoted)).find((w) => says(lines, w)) ?? null
  );
}

// ------------------------------------------------------------------------------------------------- the extension

/** The most lines kept from under someone's name in a list: a headline, a bio, a kind of business. */
export const FIND_LINES = 4;
export const FIND_LINE_MOST = 300;
/** The most people one ask for who to check next takes: a day's at most. */
export const FINDS_NEXT_MOST = 40;

/**
 * How the extension's saves find people (`outreach.finds.save`): who liked or commented on a good post, what a search
 * showed, a group's members, an event's hosts and guests, an account like yours's followers. A good post's writer is
 * found by the AI's check of the post itself.
 */
export const FIND_SAVE_HOWS = [
  'liked',
  'commented',
  'searched',
  'member',
  'event',
  'follows',
] as const;
export type FindSaveHow = (typeof FIND_SAVE_HOWS)[number];

/** Someone as a post's people, a search's results or a group's members showed them. */
export const FindIn = z.object({
  profile: ProfileRef,
  name: PersonName,
  /** What the page showed under their name: a headline, a bio, a kind of business. */
  lines: z.array(z.string().trim().min(1).max(FIND_LINE_MOST)).max(FIND_LINES).default([]),
  /** What a commenter said, cut to fit: kept only until the AI's check reads it, or 14 days. */
  said: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .transform((t) =>
      t.length > FIND_SAID_MOST ? `${t.slice(0, FIND_SAID_MOST - 1).trimEnd()}…` : t,
    )
    .nullable()
    .default(null),
  /** Where a search's result or a group's member says they are: "Austin, TX". */
  place: z.string().trim().min(1).max(FIND_PLACE_MOST).nullable().default(null),
});
export type FindIn = z.input<typeof FindIn>;

export const FindsSaveInput = z
  .object({
    workspaceId: z.uuid(),
    /** A network that checks people found (`foundChecksPerDay`): Instagram, LinkedIn or Alignable. */
    platform: z.enum(PLATFORM_KEYS),
    how: z.enum(FIND_SAVE_HOWS),
    /** The good post whose likers or commenters these are (`outreach.posts.people_next`). */
    postId: z.uuid().nullable().default(null),
    /** The group whose members these are. */
    group: GroupRef.nullable().default(null),
    /**
     * The kind of business a search went with (`outreach.finds.searches`); for followers, the account like yours
     * whose they are, with its @ ("@austinchamber"); for an event's people, the event's name.
     */
    words: z.string().trim().min(1).max(FIND_WORDS_MOST).nullable().default(null),
    /** The town a search looked in (none when it looked anywhere), or an event is in. */
    place: z.string().trim().min(1).max(FIND_PLACE_MOST).nullable().default(null),
    /** Everyone the page showed, once: none when it showed nobody, which still marks a post's people read. */
    people: z.array(FindIn).max(FINDS_SAVE_MOST).default([]),
  })
  .refine((i) => (i.how === 'liked' || i.how === 'commented') === (i.postId !== null), {
    error:
      'Send the post whose people these are, and a post only for who liked or commented on it.',
    path: ['postId'],
  })
  .refine((i) => i.how !== 'member' || i.group !== null, {
    error: 'Say which group they’re in.',
    path: ['group'],
  })
  .refine((i) => i.how !== 'follows' || /^@[a-z0-9._]{1,30}$/.test(i.words ?? ''), {
    error: 'Say whose followers they are, by the account’s @username.',
    path: ['words'],
  })
  .refine((i) => i.how !== 'event' || i.words !== null, {
    error: 'Say which event they’re hosting or going to, by its name.',
    path: ['words'],
  });
export type FindsSaveInput = z.input<typeof FindsSaveInput>;

export const FindsSaveOutput = z.object({
  /** New people kept to check. */
  added: z.number().int().min(0),
  /**
   * People left out: the person, the post's writer, anyone known or reached, a customer, anyone left alone or skipped
   * for where they are, and anyone new past the finds that may wait.
   */
  skipped: z.number().int().min(0),
});
export type FindsSaveOutput = z.output<typeof FindsSaveOutput>;

export const PostsPeopleNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
});
export type PostsPeopleNextInput = z.input<typeof PostsPeopleNextInput>;

export const PostsPeopleNextOutput = z.object({
  /** The good posts whose likers and commenters to read next, in order, no more than today has room for. */
  posts: z.array(
    z.object({
      postId: z.uuid(),
      url: z.string(),
      /** Who wrote it, left out of its people. */
      name: z.string(),
      profileUrl: z.string(),
      /** The hashtag or phrase that found it. */
      words: z.string().nullable(),
      strong: z.boolean(),
      comments: z.number().int().min(0).nullable(),
      reactions: z.number().int().min(0).nullable(),
    }),
  ),
  /** How many posts' people were read today, and how many a day are. */
  today: z.number().int().min(0),
  perDay: z.number().int().min(0),
});
export type PostsPeopleNextOutput = z.output<typeof PostsPeopleNextOutput>;

export const FindsNextInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
  /** How many it wants: at most a day's. */
  most: z.number().int().min(1).max(FINDS_NEXT_MOST).default(FINDS_NEXT_MOST),
});
export type FindsNextInput = z.input<typeof FindsNextInput>;

export const FindsNextOutput = z.object({
  /** Who to check next, in order, no more than today has room for. */
  people: z.array(
    z.object({
      profileId: z.uuid(),
      name: z.string(),
      url: z.string(),
      how: z.enum(FIND_HOW_KEYS),
      /** The hashtag, phrase or kind of business they were found with. */
      words: z.string().nullable(),
      /** The post they wrote, liked or commented on. */
      postUrl: z.string().nullable(),
    }),
  ),
  /** How many found people were checked today, and how many a day are now. */
  today: z.number().int().min(0),
  perDay: z.number().int().min(0),
});
export type FindsNextOutput = z.output<typeof FindsNextOutput>;

export const FindsSearchesInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose search of businesses goes with the playbooks' kinds of business: Alignable's. */
  platform: z.enum(PLATFORM_KEYS).default('alignable'),
});
export type FindsSearchesInput = z.input<typeof FindsSearchesInput>;

export const FindsSearchesOutput = z.object({
  /**
   * Today's searches, in turn: the kind of business, and whether its playbook works with clients online, so the search
   * goes anywhere rather than the person's own town.
   */
  searches: z.array(z.object({ words: z.string(), anywhere: z.boolean() })),
});
export type FindsSearchesOutput = z.output<typeof FindsSearchesOutput>;

/**
 * Each search once (decision 92's 3), for the searches of businesses and of groups: the same words searched the same
 * way, in the person's town or anywhere, are one search, so a local playbook and an online one that share words each
 * keep their own. The first one's words are kept as written.
 */
export function eachSearchOnce<T extends { readonly words: string; readonly anywhere: boolean }>(
  searches: readonly T[],
): T[] {
  const seen = new Set<string>();
  return searches.filter((s) => {
    const key = `${s.words.toLowerCase()}|${s.anywhere}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
