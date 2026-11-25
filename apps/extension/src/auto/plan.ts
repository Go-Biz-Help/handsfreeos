/**
 * What the runner that works on its own (./run.ts) does next, and when. From 0.155.0 the rules themselves are
 * HandsFreeOS's (packages/core/src/addons/outreach/plan-rules.ts, decision 195), so the app works out the same day the
 * extension does and shows it on Today's Plan; this hands them on to the runners, with the list's items as the API
 * gives them. What stays here is the extension's own: where each runner keeps its state, and the words of a step
 * handed to the person.
 */
import {
  AUTO_KINDS,
  type AutoKind,
  type Work as PlannedWork,
} from '@hfos/core/addons/outreach/plan-rules';
import type { NeedNoteInput, TodayListItem } from '../hfos/messages';

export {
  afterDaily,
  AGAIN_MINUTES,
  AGAIN_WORDS,
  ANSWERING,
  answersAnyTime,
  AUTO_KINDS,
  DAILY_JOBS,
  FINDING_JOBS,
  freshState,
  GAP_MS,
  gapAfter,
  HELPFUL_AGAIN_MS,
  helpfulDue,
  IDLE_MS,
  inTurns,
  isReplyKind,
  isState,
  itemKey,
  itemsLeft,
  listSays,
  listTurn,
  lookOutsideAt,
  networkDay,
  networkWaitWords,
  nextDaily,
  nextRound,
  nextStart,
  nextWatch,
  REFER_AGAIN_MS,
  referDue,
  REFUSED_IN_A_ROW,
  refusedAfter,
  repliedAfter,
  REPLY_KINDS,
  REPLY_LOOK_MS,
  replyWaiting,
  retryWake,
  roundDue,
  soonestAgain,
  START_JITTER_MS,
  STARTED_GAP_MS,
  stillReplied,
  waitsAgain,
  watchDue,
  withoutRequests,
  withReplied,
  workKey,
  workLeft,
  type AutoKind,
  type AutoState,
  type DailyJob,
  type DoneKind,
  type Lane,
  type NetworkDay,
  type OwnDailyJob,
} from '@hfos/core/addons/outreach/plan-rules';

/** One thing for it to do: a step on the list, drafting a message, or sending one OK'd. */
export type Work = PlannedWork<TodayListItem>;

/** Where the runner keeps its state, which the panel watches. */
export const AUTO_STATE_KEY = 'hfos.auto';
/** Where LinkedIn's runner keeps its own (./linkedin.ts). */
export const LINKEDIN_STATE_KEY = 'hfos.auto.linkedin';
/** Where Alignable's runner keeps its own (./alignable.ts). */
export const ALIGNABLE_STATE_KEY = 'hfos.auto.alignable';
/** Where Instagram's runner keeps its own (./instagram.ts). */
export const INSTAGRAM_STATE_KEY = 'hfos.auto.instagram';
/** Where Threads' and X's runners keep theirs (./follows.ts, decision 163). */
export const THREADS_STATE_KEY = 'hfos.auto.threads';
export const X_STATE_KEY = 'hfos.auto.x';

/**
 * A step it couldn't do there and then, handed to the person (decision 42): the line it shows, less its lead ("Dana
 * Reyes: ", "Dana Reyes’s post: "), is why. Null for one that isn't the person's to do: a message (HandsFreeOS hands
 * over one that didn't go itself), or one with nobody kept to do it to.
 */
export function needOf(
  item: Pick<TodayListItem, 'kind' | 'name' | 'profileId' | 'postId' | 'postUrl' | 'profileUrl'>,
  line: string,
  businessId: string,
  reportId: string | null = null,
): NeedNoteInput | null {
  if (!(AUTO_KINDS as readonly string[]).includes(item.kind) || !item.profileId) return null;
  const why = whyOf(item, line);
  return {
    workspaceId: businessId,
    step: item.kind as AutoKind,
    profileId: item.profileId,
    postId: item.kind === 'comment' ? (item.postId ?? null) : null,
    name: item.name,
    url: (item.kind === 'comment' ? item.postUrl : null) ?? item.profileUrl ?? null,
    why,
    reportId,
  };
}

/**
 * Why a step didn't go, from the line it shows, less its lead ("Dana Reyes: ", "Dana Reyes’s post: "): what Needs you
 * says, and the note on its problem report, which never names anyone (decision 142).
 */
export function whyOf(item: Pick<TodayListItem, 'name'>, line: string): string {
  return [`${item.name}’s post: `, `${item.name}: `].reduce(
    (said, lead) => (said.startsWith(lead) ? said.slice(lead.length) : said),
    line,
  );
}

/**
 * The same, for a problem report and the AI helper: their name anywhere else in it, or their first name on its own, is
 * "(their name)".
 */
export function reportWhy(item: Pick<TodayListItem, 'name'>, line: string): string {
  const name = item.name.trim().replace(/\s+/g, ' ');
  let why = whyOf(item, line);
  if (!name) return why;
  why = why.split(name).join('(their name)');
  const first = name.split(' ')[0]!;
  if (first.length < 3 || first === name) return why;
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return why.replace(
    new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'),
    '(their name)',
  );
}
