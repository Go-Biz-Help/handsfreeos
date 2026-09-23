/**
 * Ideas, the roadmap and What's new (0100): the words the board, the admin side and the emails share, so an
 * idea is "Planned" in the same word wherever it shows up. Browser-safe.
 */

/** Where an idea stands. Every idea starts `under_review`; `not_planned` is a plain no, said out loud. */
export const IDEA_STATUSES = [
  'under_review',
  'planned',
  'in_progress',
  'done',
  'not_planned',
] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_STATUS_WORDS: Record<IdeaStatus, string> = {
  under_review: 'Under review',
  planned: 'Planned',
  in_progress: 'In progress',
  done: 'Done',
  not_planned: 'Not planned',
};

/** What each one means, for somebody reading the board for the first time. */
export const IDEA_STATUS_MEANING: Record<IdeaStatus, string> = {
  under_review: 'New, and waiting for the team to read it.',
  planned: 'We are going to build this.',
  in_progress: 'We are building this now.',
  done: 'This is in HandsFreeOS now.',
  not_planned: 'We have decided not to build this for now.',
};

/** Still open: people can vote on these, and the board shows them unless asked for something else. */
export const OPEN_IDEA_STATUSES: readonly IdeaStatus[] = ['under_review', 'planned', 'in_progress'];

/** The roadmap's three columns, left to right. */
export const ROADMAP_STATUSES: readonly IdeaStatus[] = ['planned', 'in_progress', 'done'];

export const IDEA_SORTS = ['trending', 'top', 'new'] as const;
export type IdeaSort = (typeof IDEA_SORTS)[number];

export const IDEA_SORT_WORDS: Record<IdeaSort, string> = {
  trending: 'Trending',
  top: 'Most votes',
  new: 'Newest',
};

/** What an entry in What's new is. */
export const WHATS_NEW_KINDS = ['new', 'improved', 'fixed'] as const;
export type WhatsNewKind = (typeof WHATS_NEW_KINDS)[number];

export const WHATS_NEW_KIND_WORDS: Record<WhatsNewKind, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

/** How many ideas one person may share in a day, and comments in an hour (the database holds the line). */
export const IDEAS_PER_DAY = 10;
export const IDEA_COMMENTS_PER_HOUR = 30;

/** The first line of the email a follower gets, and its subject. */
export function ideaUpdateHeadline(status: IdeaStatus): string {
  switch (status) {
    case 'planned':
      return 'is planned';
    case 'in_progress':
      return 'is being built';
    case 'done':
      return 'is in HandsFreeOS now';
    case 'not_planned':
      return 'is not planned for now';
    case 'under_review':
      return 'is back under review';
  }
}

/** A few lines of an idea's details for a list: whole words, and no more than `max` characters. */
export function ideaExcerpt(body: string, max = 180): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/** Words too common to say two ideas are about the same thing. */
const COMMON = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'would',
  'could',
  'should',
  'please',
  'add',
  'able',
  'can',
  'into',
  'when',
  'what',
  'where',
  'there',
  'their',
  'your',
  'our',
  'more',
  'less',
  'make',
  'like',
  'want',
  'need',
  'allow',
  'option',
  'feature',
  'handsfreeos',
]);

/**
 * The words worth looking for when somebody is still typing a title: letters and digits, three or more of
 * them, the common ones left out, at most eight. Empty when there is nothing worth searching for yet.
 */
export function ideaSearchWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept: string[] = [];
  for (const word of words) {
    if (word.length < 3 || COMMON.has(word) || kept.includes(word)) continue;
    kept.push(word);
    if (kept.length === 8) break;
  }
  return kept;
}
