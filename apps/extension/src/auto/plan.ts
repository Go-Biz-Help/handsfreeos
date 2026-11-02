/**
 * What the runner that works on its own (./run.ts) does next, and when: plain workings, kept apart so they can be
 * tested. It goes down the list for today (packages/core/src/addons/outreach/today.ts): requests to confirm, friend
 * requests, posts to like and comments (decisions 26, 30 and 33), and the messages it drafts
 * (packages/core/src/addons/outreach/sends.ts), each kind taking turns with the others (decision 138), so one that
 * keeps failing never holds up the rest. A reply to someone who wrote back is drafted before anything else (decision
 * 125), then the ones OK'd go; with Approve all, the drafts have the first turn. Within the working hours it spreads the day's steps out, at random times; after **Start my day** it goes at
 * a person's pace, a minute or few apart. Once a day, it checks the person's friend requests, checks their groups for
 * their people and joins good ones when people left to reach run low (decision 48), saves their groups' members, finds
 * posts, reads their chats (decision 32) and checks their friends for good fits (decision 46), which fill that list;
 * from 0.112.0 that reading and the list take turns at a person's pace till the reading's done (decision 123,
 * `listTurn`), so nothing on the list waits for all of it. In the working hours, every hour or two, it looks at the
 * newest posts in their best groups (decision 49), so one asking for what they offer is answered fast.
 */
import {
  businessDay,
  nextInHours,
  startAfterToday,
  underAPost,
  waitsForWorkDay,
  workHours,
  workWindow,
  type WorkingHours,
} from '@hfos/core/addons/outreach/automation';
import { startWords, type LiveDay } from '@hfos/core/addons/outreach/live';
import { SEARCH_AGAIN } from '@hfos/core/addons/outreach/goal';
import { WATCH_EVERY_MINUTES } from '@hfos/core/addons/outreach/posts';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import type { NeedNoteInput, TodayList, TodayListItem } from '../hfos/messages';
import type { ListMark, ListsSaved } from '@hfos/core/addons/outreach/lists';
import type { JobEnd } from '../jobs/job';
import type { TriedBefore } from './lists';

/** Where the runner keeps its state, which the panel watches. */
export const AUTO_STATE_KEY = 'hfos.auto';
/** Where LinkedIn's runner keeps its own (./linkedin.ts). */
export const LINKEDIN_STATE_KEY = 'hfos.auto.linkedin';
/** Where Alignable's runner keeps its own (./alignable.ts). */
export const ALIGNABLE_STATE_KEY = 'hfos.auto.alignable';
/** Where Instagram's runner keeps its own (./instagram.ts). */
export const INSTAGRAM_STATE_KEY = 'hfos.auto.instagram';

/**
 * The kinds it does on its own, in the order of their turns: a friend request before a like (decision 138), so one a
 * like made ready (or nothing to like did) goes before the next likes.
 */
export const AUTO_KINDS = ['confirm', 'friend_request', 'warm_up', 'comment'] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
/**
 * What it counts as done today: the steps above, messages drafted, and messages sent; and on Instagram the stories its
 * warm-ups liked (decision 111), against the kit's `storyLikesPerDay`.
 */
export type DoneKind = AutoKind | 'drafted' | 'sent' | 'story_like';

/** The jobs it does once a day, in order (./daily.ts, decision 32), by turns with the list (decision 123). */
export const DAILY_JOBS = [
  'requests',
  'tidy',
  'occasions',
  'group_checks',
  'join',
  'members',
  'posts',
  'active',
  'chats',
  'followers',
  'checks',
  'partners',
  'helpful',
  'profile',
] as const;
export type DailyJob = (typeof DAILY_JOBS)[number];
/**
 * A once-a-day job only some networks' runners do: Instagram's look at the accounts the person followed for who follows
 * them back (../jobs/instagram/follow-backs.ts); and finding people by topic (decision 92): who liked or reacted to and
 * commented on good posts, on Instagram and LinkedIn (`post_people`), the checks of the people found, on all three
 * (`found_checks`, ../jobs/found-checks.ts), and on Alignable its search of businesses (`search`), the person's own
 * groups read first (`my_groups`) and the posts of the groups they joined (`group_posts`), beside Facebook's
 * `group_checks`, `join` and `members`; from 0.101.0 the week's helpful post asked for on Instagram and Alignable
 * (`weekly_post`, decision 109); from 0.102.0 Instagram's accounts like the business's (`like_yours`, decision
 * 110, ../jobs/instagram/like-yours.ts); and from 0.104.0 the events near the person on Alignable, once a week
 * (`events`, decision 112, ../jobs/alignable/events.ts); and from 0.109.0 who engaged with the person's helpful posts
 * on LinkedIn on its own (`engaged`, after the day's post is asked for), as it reads with its window in front only
 * while they're away from their computer (decision 120).
 */
export type OwnDailyJob =
  | 'follow_backs'
  | 'post_people'
  | 'found_checks'
  | 'search'
  | 'my_groups'
  | 'group_posts'
  | 'weekly_post'
  | 'like_yours'
  | 'events'
  | 'engaged';

/** The shortest and longest wait between two steps in the working hours. */
export const GAP_MS = { least: 60_000, most: 45 * 60_000 } as const;
/** The wait between two steps after Start my day: a person's pace. */
export const STARTED_GAP_MS = { least: 60_000, most: 180_000 } as const;
/** How far after the hours start it may begin: never on the hour exactly. */
export const START_JITTER_MS = 20 * 60_000;
/** How often it looks again in the hours when nothing's left: a new request to confirm may come. */
export const IDLE_MS = 60 * 60_000;

/** Where the runner is, kept in the extension's storage across the background's restarts. */
export interface AutoState {
  /** The business's day these are for: "2026-10-09". A new day starts afresh. */
  readonly day: string | null;
  /** Start my day was pressed today: it goes now, at a person's pace, hours or not. */
  readonly started: boolean;
  /** Why it stopped for today: Stop for today, or a warning from Facebook. Null while it goes. */
  readonly stopped: string | null;
  /** Those on the list done or passed over today, by `itemKey`, so none is tried twice. */
  readonly tried: readonly string[];
  /** How many of each it did today. */
  readonly done: Readonly<Partial<Record<DoneKind, number>>>;
  /** The once-a-day jobs it did today, each with how it went in words. Missing in a state kept by 0.11. */
  readonly daily?: Readonly<Partial<Record<DailyJob | OwnDailyJob, string>>>;
  /** What it did before the day today (./lists.ts), each with how it went in words. Missing in a state kept by 0.26. */
  readonly before?: TriedBefore;
  /**
   * The last go did a part of the morning's reading: the next does a step on the list, when there's one (decision 123,
   * `listTurn`). Missing in a state kept by 0.111.
   */
  readonly readLast?: boolean;
  /**
   * Who wrote back since their reply was last drafted today, by profile (decision 125): their reply is drafted next,
   * though it was tried before today, and the next go is the list's. Missing in a state kept by 0.112.
   */
  readonly replied?: readonly string[];
  /**
   * The once-a-day jobs with more of today's room left, each with when its next batch goes (decision 126, `afterDaily`):
   * the checks, a batch at a time through the hours, while the day's first messages need more good fits. Missing in a
   * state kept by 0.113.
   */
  readonly againAt?: Readonly<Partial<Record<DailyJob | OwnDailyJob, number>>>;
  /**
   * Whether today's list last said the network needs more good fits (decision 126, its goal's `more`), and the rounds of
   * finding it did again today for it, with when the last began (`roundDue`). Missing in a state kept by 0.113.
   */
  readonly more?: boolean;
  readonly round?: number;
  readonly roundAt?: number | null;
  /**
   * When the next message tried again on the network may go, as today's list last said (decision 132): the runner
   * looks again by then, though nothing else is left. Missing in a state kept by 0.115.
   */
  readonly retryAt?: number | null;
  /**
   * The person's lists as HandsFreeOS last said, and the step before the day under way now: for the panel's live
   * checklist. Missing in a state kept by 0.27.
   */
  readonly lists?: ListsSaved | null;
  readonly beforeNow?: ListMark | null;
  /** When it next looks at the newest posts in the groups (decision 49). Missing in a state kept by 0.22: due now. */
  readonly watchAt?: number | null;
  /**
   * Today's helpful post, when the person lets it post on its own (decision 50): when it next looks for one written,
   * and whether it's up. Missing in a state kept by 0.23.
   */
  readonly helpfulAt?: number | null;
  readonly helpfulUp?: boolean;
  /** What it's doing, or last did, in words for the person, and when. */
  readonly line: string | null;
  readonly lineAt: number | null;
  /** When it goes next: null when it isn't going to. */
  readonly nextAt: number | null;
  /** Whether a step is under way now. */
  readonly working: boolean;
  /**
   * It stopped for now and needs the person: noting is off, or something went wrong and it tries again later.
   * Missing in a state kept by 0.16; cleared at the next line it says.
   */
  readonly needs?: boolean;
  /** The tab in its window, while it's open. */
  readonly tabId: number | null;
}

export function freshState(day: string | null, tabId: number | null = null): AutoState {
  return {
    day,
    started: false,
    stopped: null,
    tried: [],
    done: {},
    daily: {},
    before: {},
    readLast: false,
    replied: [],
    againAt: {},
    more: false,
    round: 0,
    roundAt: null,
    watchAt: null,
    helpfulAt: null,
    helpfulUp: false,
    line: null,
    lineAt: null,
    nextAt: null,
    working: false,
    tabId,
  };
}

/** Whether something read from storage has the shape of a state. */
export function isState(value: unknown): value is AutoState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.tried) &&
    typeof v.done === 'object' &&
    v.done !== null &&
    typeof v.started === 'boolean'
  );
}

/**
 * The once-a-day job to do next, when it collects: the first not done today whose next batch isn't still to come
 * (`waitsAgain`).
 */
export const nextDaily = (
  state: Pick<AutoState, 'daily' | 'againAt'>,
  now = Date.now(),
): DailyJob | null =>
  DAILY_JOBS.find((job) => state.daily?.[job] === undefined && !waitsAgain(state, job, now)) ??
  null;

/** How long after a batch with more of today's room left the next goes (decision 126): spread through the hours. */
export const AGAIN_MINUTES = [35, 60] as const;

/** Whether a once-a-day job waits for its next batch. */
export const waitsAgain = (
  state: Pick<AutoState, 'againAt'>,
  job: DailyJob | OwnDailyJob,
  now: number,
): boolean => (state.againAt?.[job] ?? 0) > now;

/** When the first once-a-day job waiting for its next batch goes, or null with none waiting. */
export function soonestAgain(
  state: Pick<AutoState, 'againAt' | 'daily'>,
  now: number,
): number | null {
  const at = Object.entries(state.againAt ?? {})
    .filter(([job, when]) => state.daily?.[job as DailyJob] === undefined && (when ?? 0) > now)
    .map(([, when]) => when!);
  return at.length ? Math.min(...at) : null;
}

/**
 * What a once-a-day job leaves in the state: done for today with how it went; or, a batch done with more of today's
 * room left (`again`, decision 126), its next batch 35 to 60 minutes later (`random` 0 to 1), not done yet.
 */
export function afterDaily(
  state: Pick<AutoState, 'daily' | 'againAt'>,
  kind: DailyJob | OwnDailyJob,
  end: Pick<JobEnd, 'line' | 'again' | 'warned' | 'failed'>,
  now: number,
  random: number,
): Pick<AutoState, 'daily' | 'againAt'> {
  const { [kind]: _was, ...againAt } = state.againAt ?? {};
  if (end.again && !end.warned && !end.failed) {
    const [least, most] = AGAIN_MINUTES;
    const at = now + Math.round((least + random * (most - least)) * 60_000);
    return { daily: state.daily ?? {}, againAt: { ...againAt, [kind]: at } };
  }
  return { daily: { ...state.daily, [kind]: end.line }, againAt };
}

/** The words a day's last line adds while the checks wait for their next batch (decision 126). */
export const AGAIN_WORDS =
  'It checks more people later today, as today’s first messages need more good fits.';

/**
 * Whether it finds people again now (decision 126, answer 6a): today's list says the network needs more good fits,
 * the day's once-a-day reading is done, and it has done fewer than `SEARCH_AGAIN.rounds` rounds today, the last at least
 * `SEARCH_AGAIN.minutes` ago.
 */
export const roundDue = (
  state: Pick<AutoState, 'more' | 'round' | 'roundAt'>,
  now: number,
): boolean =>
  state.more === true &&
  (state.round ?? 0) < SEARCH_AGAIN.rounds &&
  now - (state.roundAt ?? 0) >= SEARCH_AGAIN.minutes * 60_000;

/**
 * A round of finding again (`roundDue`): the network's finding jobs to do once more today, with the next search words
 * (each asks HandsFreeOS with the round), and the round noted.
 */
export function nextRound(
  state: Pick<AutoState, 'daily' | 'round'>,
  finding: readonly (DailyJob | OwnDailyJob)[],
  now: number,
): Pick<AutoState, 'daily' | 'round' | 'roundAt'> {
  const daily = Object.fromEntries(
    Object.entries(state.daily ?? {}).filter(([job]) => !finding.includes(job as DailyJob)),
  );
  return { daily, round: (state.round ?? 0) + 1, roundAt: now };
}

/** Facebook's jobs that find people, done again in a round (`nextRound`): groups, their members, and the checks. */
export const FINDING_JOBS: readonly DailyJob[] = ['group_checks', 'join', 'members', 'checks'];

/** When it next looks at the newest posts after one at `now`: an hour or two later, at random (`random` 0 to 1). */
export function nextWatch(now: number, random: number): number {
  const [least, most] = WATCH_EVERY_MINUTES;
  return now + Math.round((least + random * (most - least)) * 60_000);
}

/** How long after a look finds no helpful post written yet it looks again. */
export const HELPFUL_AGAIN_MS = 30 * 60_000;

/** Whether to look for today's helpful post to put up on its own: not up yet, and due. */
export const helpfulDue = (
  state: Pick<AutoState, 'helpfulAt' | 'helpfulUp'>,
  now: number,
): boolean => !state.helpfulUp && (state.helpfulAt ?? 0) <= now;

/** Whether it's time to look at the newest posts again. */
export const watchDue = (state: Pick<AutoState, 'watchAt'>, now: number): boolean =>
  (state.watchAt ?? 0) <= now;

/**
 * Someone on the list, by what they're on it for. A step tried again (decision 144) is a new one each time it's put
 * back, so it goes once more though it was tried today.
 */
export const itemKey = (
  item: Pick<TodayListItem, 'kind' | 'postId' | 'profileId' | 'name'> & {
    readonly retry?: { readonly at: string };
  },
) =>
  `${item.kind}:${item.postId ?? item.profileId ?? item.name}${item.retry ? `@${item.retry.at}` : ''}`;

/**
 * Whether the list goes before the morning's reading this go (decision 123; the owner, 29 Oct 2026, an hour into a
 * day: "all it has done is 4 likes on facebook and nothing else on any of the platforms"). While reading is left today
 * (the lists before the day and the once-a-day jobs), a step on the list and a part of the reading take turns, at a
 * person's pace, so the day's likes, requests and the messages OK'd never wait the hour or two the reading takes. The
 * first go of a day reads; a first save of the person's lists still holds the day (`held`, ./lists.ts `holdsTheDay`);
 * a list with nothing left on it reads on.
 */
export const listTurn = (
  state: Pick<AutoState, 'readLast' | 'replied'>,
  reading: boolean,
  held: boolean,
): boolean => reading && !held && (state.readLast === true || (state.replied?.length ?? 0) > 0);

/** The kinds that answer someone who wrote back (decision 125): drafted first, as soon as they're seen. */
export const REPLY_KINDS: readonly TodayKind[] = ['reply', 'partner_reply'];
export const isReplyKind = (kind: TodayKind) => REPLY_KINDS.includes(kind);

/** Whether a piece of work drafts the reply to someone who wrote back. */
const isReplyDraft = (work: Work): boolean => work.do === 'draft' && isReplyKind(work.item.kind);

/**
 * What goes outside the working hours (decision 133; the owner, 30 Oct 2026: "it should always be checking for new
 * messages and always respond in real time it just shouldn't send out new messages if it's not in the working
 * time"): a reply to someone who wrote back, drafted at once, and sent once OK'd or on its own as Replies says.
 * Nothing new goes: no first message, follow-up, like or request. Stop for today and a warning still stop it all.
 */
export const answersAnyTime = (work: Work): boolean =>
  work.do !== 'step' && isReplyKind(work.item.kind);

/** A runner's day outside its hours, for the replies alone: at a person's pace, with no end to spread them over. */
export const ANSWERING: Extract<NetworkDay, { go: true }> = {
  go: true,
  started: true,
  until: null,
};

/** Outside the hours, while a reply waits for the person's OK, how often the runner looks for it OK'd. */
export const REPLY_LOOK_MS = 2 * 60_000;

/** Whether a reply drafted on the list waits for the person's OK: outside the hours, it goes once they give it. */
export const replyWaiting = (
  list: Pick<TodayList, 'items'> & { readonly partners?: readonly TodayListItem[] },
): boolean =>
  [...list.items, ...(list.partners ?? [])].some(
    (item) => isReplyKind(item.kind) && item.send?.state === 'waiting',
  );

/**
 * When a runner outside its hours looks next: soon while a reply waits for an OK, else at the hours' next start
 * (`next`; null when there's none this week). A message tried again that waits its turn (`retry`, from `retryWake`)
 * brings it sooner, as a reply tried again goes any time too.
 */
export const lookOutsideAt = (
  waiting: boolean,
  now: number,
  next: number | null,
  retry: readonly number[] = [],
): number | null => {
  const look = waiting ? Math.min(now + REPLY_LOOK_MS, next ?? Infinity) : next;
  return retry.length ? Math.min(look ?? Infinity, ...retry) : look;
};

/** The most kept as having written back: a day's worth, far more than a list carries. */
const REPLIED_MOST = 50;

/** Who wrote back, with those just seen (decision 125). */
export const withReplied = (replied: readonly string[], profileIds: readonly string[]): string[] =>
  [...new Set([...replied, ...profileIds])].slice(-REPLIED_MOST);

/** Who wrote back still to answer after a piece of work: a reply drafted is theirs answered. */
export const repliedAfter = (replied: readonly string[], work: Work): string[] =>
  isReplyDraft(work) ? replied.filter((id) => id !== work.item.profileId) : [...replied];

/**
 * Who wrote back whose reply is still on what's left: the rest (not on today's list, or answered from the person's own
 * tab) are let go, so they never keep the list's turn.
 */
export const stillReplied = (replied: readonly string[], left: readonly Work[]): string[] =>
  replied.filter((id) => left.some((work) => isReplyDraft(work) && work.item.profileId === id));

/**
 * What's left for it to do today, in its order: the kinds it does for the person (the list's `auto`), not tried
 * yet today, with the page to do it on.
 */
export function itemsLeft(
  items: readonly TodayListItem[],
  auto: readonly TodayKind[],
  tried: readonly string[],
): TodayListItem[] {
  const done = new Set(tried);
  const left = AUTO_KINDS.filter((kind) => auto.includes(kind)).flatMap((kind) =>
    items.filter(
      (item) =>
        item.kind === kind &&
        !done.has(itemKey(item)) &&
        (kind === 'comment'
          ? item.postUrl !== null && item.profileUrl !== null
          : item.profileUrl !== null),
    ),
  );
  // A post asking for what the business offers goes first (decision 49): answered while it's fresh.
  return [...left.filter((item) => item.asking), ...left.filter((item) => !item.asking)];
}

/** When to look again for a message tried again that waits its turn (decision 132): its time, once it's after `now`. */
export const retryWake = (state: Pick<AutoState, 'retryAt'>, now: number): number[] =>
  state.retryAt != null && state.retryAt > now ? [state.retryAt] : [];

/** What today's list says for the runner's state: whether it needs more good fits, and when a retry may go. */
export const listSays = (list: Pick<TodayList, 'goal' | 'retryAt'>) => ({
  more: list.goal?.more === true,
  retryAt: list.retryAt ? Date.parse(list.retryAt) : null,
});

/** One thing for it to do: a step on the list, drafting a message, or sending one OK'd. */
export type Work =
  | { readonly do: 'step'; readonly item: TodayListItem }
  | { readonly do: 'draft'; readonly item: TodayListItem }
  | { readonly do: 'send'; readonly item: TodayListItem };

/** A piece of work by what it is, so none is tried twice in a day: a send by its own id. */
export const workKey = (work: Work): string =>
  work.do === 'step'
    ? itemKey(work.item)
    : work.do === 'send'
      ? `send:${work.item.send?.sendId ?? itemKey(work.item)}`
      : `draft:${itemKey(work.item)}`;

/**
 * The messages on a list it drafts and sends: a kind it writes, to someone kept, with their chat or profile. A comment
 * that goes through `sends` (decision 92: where `comment` is among the list's `messages`), and the day's reply in a
 * group (decision 114: `group_reply`), also needs its post, kept and with its link.
 */
const messagesOn = (items: readonly TodayListItem[], kinds: readonly string[]) =>
  items.filter(
    (item) =>
      kinds.includes(item.kind) &&
      item.profileId !== null &&
      (item.profileUrl !== null || item.threadKey !== null) &&
      (!underAPost(item.kind) || (item.postId !== null && item.postUrl !== null)),
  );

/**
 * The lanes that take turns (decision 138; the owner, 31 Oct 2026: "all of the tasks should be independent… so
 * comments work even if likes don't or messages work even if comments don't"): each kind of step, a partner's steps,
 * and the messages to draft.
 */
export type Lane = AutoKind | 'partner' | 'message';

const laneOf = (work: Work): Lane =>
  work.do === 'draft'
    ? 'message'
    : work.item.kind === 'partner_warm_up'
      ? 'partner'
      : (work.item.kind as AutoKind);

/** The lane of a piece of work tried today, by its key (`workKey`): none for a send, which goes before the turns. */
function laneOfKey(key: string): Lane | null {
  if (key.startsWith('draft:')) return 'message';
  const kind = key.slice(0, key.indexOf(':'));
  if (kind === 'partner_warm_up') return 'partner';
  return (AUTO_KINDS as readonly string[]).includes(kind) ? (kind as AutoKind) : null;
}

/**
 * The work in turns: each go, the lane tried least today goes next, ties in `order`. A lane that keeps failing (likes
 * a network won't take) gets its turns and no more, so friend requests, comments and messages carry on beside it.
 */
export function inTurns(
  lanes: ReadonlyMap<Lane, readonly Work[]>,
  order: readonly Lane[],
  tried: readonly string[],
): Work[] {
  const turns = new Map<Lane, number>();
  for (const key of tried) {
    const lane = laneOfKey(key);
    if (lane) turns.set(lane, (turns.get(lane) ?? 0) + 1);
  }
  const at = new Map<Lane, number>();
  const all: Work[] = [];
  for (;;) {
    let pick: Lane | null = null;
    for (const lane of order) {
      if ((at.get(lane) ?? 0) >= (lanes.get(lane)?.length ?? 0)) continue;
      if (pick === null || (turns.get(lane) ?? 0) < (turns.get(pick) ?? 0)) pick = lane;
    }
    if (pick === null) return all;
    const i = at.get(pick) ?? 0;
    all.push(lanes.get(pick)![i]!);
    at.set(pick, i + 1);
    turns.set(pick, (turns.get(pick) ?? 0) + 1);
  }
}

/**
 * What's left for it to do today, in its order: replies to those who wrote back first (decision 125), then messages
 * OK'd, then a comment on a post asking for what the business offers (decision 49); then the rest in turns (decision
 * 138): each kind of step and the messages to draft, the drafts' turn first with Approve all. A message needs the
 * person kept, and their chat or profile to send in. A partner's steps (decision 81) take turns as a lane of their own,
 * after the customers' when it's a tie: a like while it may like on its own, and messages that each wait for an OK of
 * their own. Someone who wrote back again since (`replied`) has their reply drafted again, though it was tried today.
 */
export function workLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'> & {
    readonly partners?: readonly TodayListItem[];
    readonly newMessagesWait?: boolean;
  },
  tried: readonly string[],
  replied: readonly string[] = [],
): Work[] {
  const done = new Set(tried);
  const again = new Set(replied);
  const steps = itemsLeft(list.items, list.auto, tried).map(
    (item) => ({ do: 'step', item }) as const,
  );
  const partners = list.partners ?? [];
  const partnerSteps = list.auto.includes('warm_up')
    ? partners
        .filter((item) => item.kind === 'partner_warm_up' && item.profileUrl !== null)
        .map((item) => ({ do: 'step', item }) as const)
    : [];
  // Not one of the person's working days: what starts or nudges a conversation waits for one (decision 139).
  const messages = [
    ...messagesOn(list.items, list.messages),
    ...messagesOn(partners, list.messages),
  ].filter((item) => !(list.newMessagesWait && waitsForWorkDay(item.kind)));
  const sends = messages
    .filter((item) => item.send?.state === 'approved')
    .map((item) => ({ do: 'send', item }) as const);
  const drafts = messages
    .filter((item) => item.send === null)
    .map((item) => ({ do: 'draft', item }) as const);
  const replies = drafts.filter(isReplyDraft);
  const others = drafts.filter((work) => !isReplyDraft(work));
  const open = (work: Work) =>
    !done.has(workKey(work)) ||
    (isReplyDraft(work) && work.item.profileId !== null && again.has(work.item.profileId));
  const lanes = new Map<Lane, Work[]>();
  for (const work of [...steps.filter((w) => !w.item.asking), ...partnerSteps, ...others].filter(
    open,
  ))
    lanes.set(laneOf(work), [...(lanes.get(laneOf(work)) ?? []), work]);
  const order: Lane[] =
    list.sending === 'approve_all'
      ? ['message', ...AUTO_KINDS, 'partner']
      : [...AUTO_KINDS, 'partner', 'message'];
  return [
    ...[...replies, ...sends, ...steps.filter((w) => w.item.asking)].filter(open),
    ...inTurns(lanes, order, tried),
  ];
}

/**
 * How long to wait before the next step: in the hours, what's left of them shared among the steps left, more or
 * less by half, so the day's steps spread out at random times; after Start my day, a person's pace. `random` is
 * from 0 to 1.
 */
export function gapAfter(input: {
  readonly now: number;
  /** When the working hours end today: null after Start my day outside them. */
  readonly until: number | null;
  readonly left: number;
  readonly started: boolean;
  readonly random: number;
}): number {
  const { least, most } = input.started || input.until === null ? STARTED_GAP_MS : GAP_MS;
  if (input.started || input.until === null)
    return Math.round(least + input.random * (most - least));
  const even = (input.until - input.now) / Math.max(1, input.left);
  return Math.round(Math.min(most, Math.max(least, even * (0.5 + input.random))));
}

/**
 * When the working hours next start after `now`, every day while the person keeps working on other days (decision
 * 139); a little after the hour, at random. Today's start while it's ahead, else a later day's by the business's
 * calendar, as the words say it (`networkWaitWords`): a day of 23 hours, when the clocks go forward, is never skipped.
 */
export function nextStart(
  hours: WorkingHours,
  timeZone: string,
  now: number,
  random: number,
): number | null {
  const today = workWindow(workHours(hours), timeZone, now);
  const at =
    today && today.from > now
      ? today.from
      : startAfterToday(workHours(hours), timeZone, businessDay(now, timeZone));
  return at === null ? null : at + Math.round(random * START_JITTER_MS);
}

/**
 * Where a network's day stands for its runner (LinkedIn's, Instagram's and Alignable's, as Facebook's in ./run.ts;
 * decision 28, and the owner, 28 Oct 2026: "they should just start at the time selected in our settings"): after Start
 * my day there it goes now, at a person's pace, hours or not; with nothing pressed today it goes on its own in the
 * person's working hours, spread out over them; Stop for today, or a warning's stop, holds it for the rest of the
 * business's day, till the working hours of a later one. A press from another day changes nothing. `random` is from 0
 * to 1, for when in the first minutes it starts.
 */
export type NetworkDay =
  | { readonly go: true; readonly started: boolean; readonly until: number | null }
  | { readonly go: false; readonly stopped: string | null; readonly next: number | null };

export function networkDay(input: {
  /** The network's day as HandsFreeOS last said it (`days.<network>`); null when it hasn't. */
  readonly day: Pick<LiveDay, 'date' | 'state' | 'why'> | null;
  /** The business's day now. */
  readonly today: string;
  readonly hours: WorkingHours;
  readonly timeZone: string;
  readonly now: number;
  readonly random: number;
}): NetworkDay {
  const pressed = input.day?.date === input.today ? input.day : null;
  const next = () => nextStart(input.hours, input.timeZone, input.now, input.random);
  if (pressed?.state === 'stopped') {
    // Held for the rest of the business's day, whatever its hours: it starts again on a later one.
    const again = startAfterToday(workHours(input.hours), input.timeZone, input.today);
    const jitter = Math.round(input.random * START_JITTER_MS);
    return {
      go: false,
      stopped: pressed.why ?? 'person',
      next: again === null ? null : again + jitter,
    };
  }
  if (pressed?.state === 'started') return { go: true, started: true, until: null };
  const window = workWindow(workHours(input.hours), input.timeZone, input.now);
  if (window && input.now >= window.from && input.now < window.to)
    return { go: true, started: false, until: window.to };
  return { go: false, stopped: null, next: next() };
}

/**
 * What a network's runner says while its day waits: when it starts on its own (the hours' start, as Today shows it),
 * and that Start my day starts it now. `name` is the network's.
 */
export function networkWaitWords(
  name: string,
  wait: { readonly stopped: string | null },
  hours: WorkingHours,
  timeZone: string,
  now: number,
): string {
  const at = wait.stopped
    ? startAfterToday(workHours(hours), timeZone, businessDay(now, timeZone))
    : nextInHours(workHours(hours), timeZone, now);
  const when = at !== null && at > now ? startWords(at, timeZone, now) : null;
  if (wait.stopped)
    return when
      ? `Stopped on ${name} for today. It starts again on its own ${when}.`
      : `Stopped on ${name} for today.`;
  return when
    ? `Starts on its own on ${name} ${when}. To start now, press Start my day for ${name} on Today in HandsFreeOS.`
    : `Waiting for you to start your day on ${name}: press Start my day for ${name} on Today in HandsFreeOS.`;
}

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
