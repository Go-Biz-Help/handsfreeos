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

/** "Only mine" on the board: the ideas somebody shared, voted for, or follows. */
export const IDEA_MINE = ['shared', 'voted', 'following'] as const;
export type IdeaMine = (typeof IDEA_MINE)[number];

export const IDEA_MINE_WORDS: Record<IdeaMine, string> = {
  shared: 'Shared by me',
  voted: 'My votes',
  following: 'Following',
};

/**
 * The words on Ideas, the Roadmap and What's new, in the web app and the phone app alike, so neither says it
 * differently. The statuses, the sorts and the kinds have their own maps above.
 */
export const IDEAS_WORDS = {
  title: 'Ideas',
  intro:
    'Tell us what would make HandsFreeOS better, vote for what matters to you, and follow it from idea to done.',
  /** The phone's More row. */
  moreDetail: 'Share an idea, vote, and see what’s new',
  tabs: { ideas: 'Ideas', roadmap: 'Roadmap', whatsNew: 'What’s new' },

  // Sharing
  share: 'Share an idea',
  shareFirst: 'Share the first one',
  shareIntro:
    'What would make HandsFreeOS better for your business? Other businesses can vote for it, and the team reads every one.',
  titleLabel: 'Your idea, in a few words',
  titlePlaceholder: 'Send invoices by text with a pay link',
  similar: 'Is it one of these? A vote counts for more.',
  bodyLabel: 'Tell us more',
  bodyHint: 'What you are trying to do, and what gets in the way today. Examples help.',
  areaLabel: 'What is it about?',
  pickArea: 'Pick one',
  needsTitle: 'Give it a title of a few words.',
  needsArea: 'Pick what it is about.',
  shareButton: 'Share it',
  shared: (number: number) => `Thanks — that’s idea #${number}. You’ll hear when it moves.`,

  // The board
  search: 'Search ideas',
  sortLabel: 'Sort ideas',
  openIdeas: 'Open ideas',
  everyIdea: 'Every idea',
  everyArea: 'Every part of HandsFreeOS',
  everybodys: 'Everybody’s',
  statusLabel: 'Status',
  areaFilterLabel: 'Area',
  mineLabel: 'Whose',
  filters: 'Filters',
  clearFilters: 'Clear filters',
  /** The phone's filters sheet: each choice applies as it is pressed. */
  done: 'Done',
  noIdeas: 'No ideas yet',
  noIdeasBody: 'What would make HandsFreeOS better for your business? Be the first to say.',
  noMatch: 'No ideas match that',
  noMatchBody: 'Try another word, or clear the filters.',
  showMore: 'Show more ideas',
  somethingElse: 'Something else',
  someone: 'Someone',
  you: 'You',

  // One idea
  allIdeas: 'All ideas',
  sharedBy: (name: string, you: boolean) =>
    you ? 'Shared by you' : `Shared by ${name || 'someone'}`,
  votes: (count: number) => (count === 1 ? '1 vote' : `${count} votes`),
  votesLine: (count: number, voted: boolean) =>
    `${count === 1 ? '1 vote' : `${count} votes`}${voted ? ', yours among them' : ''}.`,
  vote: (count: number) => `Vote for this (${count === 1 ? '1 vote' : `${count} votes`})`,
  unvote: (count: number) => `Take back your vote (${count === 1 ? '1 vote' : `${count} votes`})`,
  votingClosed: 'Voting has closed on this idea',
  whereItStands: 'Where it stands',
  followTitle: 'Email me updates',
  followDetail: 'When the team moves it along the roadmap, or ships it.',
  followLabel: 'Email me updates about this idea',
  followOn: 'You’ll get an email when this moves.',
  followOff: 'No more emails about this idea.',
  mergedBefore: 'This idea asks for the same thing as',
  mergedAfter: 'Its votes and followers went there, so vote and comment there.',
  hidden: 'The HandsFreeOS team took this idea off the board. Only you can see it.',
  inWhatsNew: (title: string, day: string) => `In What’s new: ${title} · ${day}`,
  whatHappened: 'What happened',
  comments: (count: number) => (count ? `Comments (${count})` : 'Comments'),
  noComments: 'No comments yet. How would you use it? What does it need to do?',
  commentLabel: 'Add a comment',
  commentPlaceholder: 'Add a comment: how you would use it, or what it needs to do',
  commentButton: 'Comment',
  deleteComment: 'Delete',
  commentDeleted: 'Comment deleted.',
  team: 'HandsFreeOS team',
  edit: 'Edit your idea',
  save: 'Save',
  saved: 'Saved.',
  cancel: 'Cancel',

  // The roadmap
  roadmapEmpty: {
    planned: 'Nothing planned right now. Vote for what you want next.',
    in_progress: 'Nothing being built right now.',
    done: 'Nothing shipped in the last ninety days.',
  } as Readonly<Record<'planned' | 'in_progress' | 'done', string>>,
  doneLately: 'Done lately',

  // What's new
  whatsNewEmpty: 'Nothing here yet',
  whatsNewEmptyBody: 'When something new reaches HandsFreeOS, it shows up here first.',
  newForYou: 'New for you',
  /** Beside Ideas in the phone's More while What's new has something they haven't read. */
  unseenBadge: 'New',
  answers: 'The ideas this answers',
  showOlder: 'Show older',
  newDot: (count: number) => `${count} new in What’s new`,

  // The phone, which is live or says so: none of this is kept on the phone.
  loading: 'Getting the ideas…',
  needsSignal: 'Ideas need a signal. Try again when you’re back online.',
  retry: 'Try again',
  notFound: 'This idea isn’t on the board. It may have been taken down.',
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 9, 2026": the day something happened, written the same way on the web and the phone. */
export function ideaDay(iso: string): string {
  const at = new Date(iso);
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`;
}

/** One line of an idea's story: "Moved to Planned", "Shipped", "Merged into #12". */
export function ideaUpdateLine(update: {
  readonly kind: 'status' | 'merged' | 'merged_in';
  readonly fromStatus: IdeaStatus | null;
  readonly toStatus: IdeaStatus | null;
  readonly other: { readonly number: number } | null;
  readonly whatsNew: unknown;
}): string {
  if (update.kind === 'merged') return `Merged into #${update.other?.number ?? '?'}`;
  if (update.kind === 'merged_in')
    return `#${update.other?.number ?? '?'} was merged into this idea`;
  const to = update.toStatus ?? 'under_review';
  if (to === 'done' && update.whatsNew) return 'Shipped';
  if (update.fromStatus === to) return `Still ${IDEA_STATUS_WORDS[to].toLowerCase()}`;
  return `Moved to ${IDEA_STATUS_WORDS[to]}`;
}

/** Whether people can still vote on an idea in this status. */
export const votingOpenFor = (status: IdeaStatus): boolean => OPEN_IDEA_STATUSES.includes(status);

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
