/**
 * The team's side of Ideas (0102): what the web's /admin/ideas and the phone's Support desk both say and decide when
 * the people who answer support read the board, answer an idea, move it along the roadmap, keep the areas and write
 * What's new. What a business sees is `IDEAS_WORDS`; this is only what the team sees. Browser-safe.
 */

import { IDEA_STATUS_WORDS, type IdeaStatus } from './words';

/** The tabs the team reads the board by. "Under review" is the queue: nobody here has answered those yet. */
export const IDEA_TRIAGE_TABS = [
  { key: 'under_review', label: 'Under review' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
  { key: 'not_planned', label: 'Not planned' },
  { key: 'all', label: 'Everything' },
  { key: 'hidden', label: 'Taken down' },
  { key: 'merged', label: 'Merged' },
] as const;

export type IdeaTriageTab = (typeof IDEA_TRIAGE_TABS)[number]['key'];

/** What each tab asks `idea.triage` for. */
export function ideaTriageQuery(tab: IdeaTriageTab): {
  show: 'board' | 'hidden' | 'merged';
  status: IdeaStatus | 'all';
} {
  if (tab === 'hidden') return { show: 'hidden', status: 'all' };
  if (tab === 'merged') return { show: 'merged', status: 'all' };
  if (tab === 'all') return { show: 'board', status: 'all' };
  return { show: 'board', status: tab };
}

type TriageCounts = Readonly<Record<IdeaStatus | 'hidden', number>>;

/** The count beside a tab, from `idea.triage`'s counts; Everything and Merged have none. */
export function ideaTriageCount(tab: IdeaTriageTab, counts: TriageCounts): number | null {
  if (tab === 'all' || tab === 'merged') return null;
  return counts[tab];
}

/** The line under the list's title: "3 waiting for an answer · 2 planned · 1 being built". */
export const ideaTriageSummary = (counts: TriageCounts): string =>
  `${counts.under_review} waiting for an answer · ${counts.planned} planned · ${counts.in_progress} being built`;

/** One line of an idea's story as the team reads it: "Planned → In progress", "#12 merged in". */
export function ideaTeamUpdateLine(update: {
  readonly kind: 'status' | 'merged' | 'merged_in';
  readonly fromStatus: IdeaStatus | null;
  readonly toStatus: IdeaStatus | null;
  readonly other: { readonly number: number } | null;
}): string {
  if (update.kind === 'merged') return `Merged into #${update.other?.number ?? '?'}`;
  if (update.kind === 'merged_in') return `#${update.other?.number ?? '?'} merged in`;
  const to = IDEA_STATUS_WORDS[update.toStatus as IdeaStatus];
  return update.fromStatus === update.toStatus
    ? `Update while ${to}`
    : `${IDEA_STATUS_WORDS[update.fromStatus as IdeaStatus]} → ${to}`;
}

const businesses = (n: number) => (n === 1 ? '1 business' : `${n} businesses`);
const votes = (n: number) => (n === 1 ? '1 vote' : `${n} votes`);

/** The words on the team's list of ideas and on one idea as the team sees it. */
export const IDEAS_TEAM_WORDS = {
  // The list
  areas: 'Areas',
  everyArea: 'Every area',
  sort: 'Sort',
  emptyTitle: 'Nothing here.',
  emptyUnderReview: 'Every idea has an answer. That is the whole idea.',
  emptyFiltered: 'No ideas match this.',
  businesses,
  commentCount: (n: number) => (n === 1 ? '1 comment' : `${n} comments`),
  takenDown: 'Taken down',
  mergedIntoNumber: (n: number) => `Merged into #${n}`,
  someoneWhoLeft: 'Someone who left',
  nextPage: 'Next page',

  // One idea
  titleLabel: 'Title',
  detailsLabel: 'Details',
  areaLabel: 'Area',
  archivedSuffix: ' (archived)',
  save: 'Save',
  cancel: 'Cancel',
  mergedInto: 'Merged into',
  noDetails: 'No details.',
  tidy: 'Tidy the words',
  hide: 'Take it off the board',
  unhide: 'Put it back on the board',
  comments: 'Comments',
  team: 'Team',
  takeDown: 'Take down',
  putBack: 'Put back',
  noComments: 'No comments yet.',
  answer: 'Answer as the team',
  answerPlaceholder:
    'Everybody sees this with the HandsFreeOS badge, and whoever shared the idea is emailed.',
  postAnswer: 'Post answer',
  notePlaceholderMove: 'A note for the people following it (optional)',
  notePlaceholderUpdate: 'Or post an update without moving it',
  noteLabel: 'Note for followers',
  emailFollowers: (n: number) => `Email the ${n === 1 ? 'one person' : `${n} people`} following it`,
  moveTo: (status: IdeaStatus) => `Move to ${IDEA_STATUS_WORDS[status]}`,
  postUpdate: 'Post the update',
  whoIsBehind: 'Who is behind it',
  sharedBy: 'Shared by',
  authorLeft: 'Shared by someone who has since left.',
  support: (voteCount: number, businessCount: number, followerCount: number) =>
    `${votes(voteCount)} from ${businesses(businessCount)} · ${followerCount} following`,
  noBusiness: 'No business',
  duplicate: 'Is it a duplicate?',
  duplicateDetail:
    'Merging moves its votes and followers to the other idea and tells them where it went.',
  findDuplicate: 'Find the idea it repeats',
  mergeInto: 'Merge into',
  mergeQuestion: (from: number, into: number) => `Merge #${from} into #${into}?`,
  mergeNote: 'A note for its followers (optional)',
  noDuplicates: 'No other idea sounds like it.',
} as const;

/** An area's id from its name: "Service plans" is service_plans. */
export const ideaAreaIdFrom = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);

/** Where a new area goes in the list: after the last one, with "Something else" (`other`) still at the foot. */
export const nextIdeaAreaSort = (
  areas: readonly { readonly id: string; readonly sort: number }[],
): number => (areas.filter((a) => a.id !== 'other').at(-1)?.sort ?? 0) + 10;

/** The words on the team's list of areas. */
export const IDEA_AREAS_WORDS = {
  title: 'Areas',
  intro: 'What people pick when they share an idea, in this order.',
  archived: 'Archived',
  line: (description: string, openCount: number) =>
    `${description || 'No description'} · ${openCount} open`,
  archive: 'Archive',
  bringBack: 'Bring back',
  add: 'Add an area',
  namePlaceholder: 'Service plans',
  nameLabel: 'Name',
  descriptionPlaceholder: 'What belongs in it (optional)',
  descriptionLabel: 'Description',
  addButton: 'Add it',
  saved: 'Saved.',
  needsName: 'Name it with a word or two.',
} as const;

/** The words on writing What's new. */
export const WHATS_NEW_TEAM_WORDS = {
  write: 'Write an entry',
  intro:
    'Every business reads these under Ideas → What’s new, with a dot in their menu until they do.',
  titleLabel: 'Title',
  titlePlaceholder: 'Photos on estimates and invoices',
  kindLabel: 'What it is',
  areaLabel: 'Part of HandsFreeOS',
  noArea: 'None in particular',
  bodyLabel: 'What changed',
  bodyHint:
    'Plain words. A blank line starts a new paragraph; lines that start with “- ” make a list.',
  ideasLabel: 'The ideas it delivers',
  ideasHint: 'Their followers are emailed when this is published, and the ideas show it.',
  removeIdea: (n: number) => `Remove #${n}`,
  findIdea: 'Find an idea to link',
  saveDraft: 'Save draft',
  cancel: 'Cancel',
  markDone: 'Publishing marks the ideas an entry delivers Done, and emails their followers',
  published: (day: string) => `Published ${day}`,
  draft: 'Draft',
  delivers: 'Delivers:',
  edit: 'Edit',
  unpublish: 'Unpublish',
  publish: 'Publish',
  delete: 'Delete',
  savedDraft: 'Saved as a draft.',
  publishedToast: 'Published.',
  unpublished: 'Back to a draft.',
  deleted: 'Deleted.',
  /** What Publish asks first: which ideas become Done and who is emailed, when it will do that. */
  publishQuestion: (title: string, notDoneYet: number, markDone: boolean): string =>
    notDoneYet && markDone
      ? `Publish “${title}”? ${notDoneYet === 1 ? 'Its idea becomes' : `Its ${notDoneYet} ideas become`} Done and everybody following ${notDoneYet === 1 ? 'it' : 'them'} is emailed.`
      : `Publish “${title}” for every business to read?`,
  deleteQuestion: (title: string) => `Delete the draft “${title}”?`,
} as const;
