/**
 * The day's plan on a network, seen in the app (docs/outreach.md, decision 195; the owner, 25 Nov 2026: "what i'd
 * prefer is the web app/phone app has the knowledge and schedule and tasks etc and the extension just knows how to do
 * the things that the app send it… we could also see the schedule of things in the app and see what it plans to do
 * when").
 *
 * This is the first step of that (HANDSFREEOS_OUTREACH_PLAN_IN_APP_IMPLEMENTATION_PLAN.md): the plan is seen. The
 * extension still decides each move, by the rules in ./plan-rules.ts. From 0.155.0 it tells HandsFreeOS where its day
 * is up to on each network (`outreach.plan.note`, a `PlanState`: what's done, what's tried, when it goes next), and
 * HandsFreeOS works the rest of the day out from that with the same rules (`nextMove`, `planAhead`) and what it keeps
 * already: today's list, the person's choices and hours, their lists, their day and any warning. Today's Plan part
 * shows it (`outreach.plan`), and the Assistant reads it. Nothing the extension does changes.
 *
 * What the plan can't see yet, and says so in its own words rather than guess: whether the person is away from their
 * computer (some reads wait for that, decision 120), a referral to do (decision 185), the helpful post going up on its
 * own (decision 50), and how long each read takes (`MOVE_MINUTES`, a rough guide). The next move's time is the
 * extension's own; every later one is "about". The second step of the plan moves the deciding here, and these with it.
 *
 * Browser-safe: the web, the phone and the extension read these.
 */
import { z } from 'zod';
import { addDays, localInstant } from '../../calendar/engine/zoned';
import { appVersionAtLeast } from '../../mobile';
import {
  businessDay,
  underAPost,
  workHours,
  workWindow,
  type NetworkChoices,
  type WorkingHours,
} from './automation';
import { atKey, PRE_DAY_WORDS_ON, type ListMark, type ListsSaved } from './lists';
import {
  clockWords,
  isOffline,
  offlineWords,
  warnedTodayWords,
  type LiveDay,
  type ReportedState,
} from './live';
import { todayKindsOn } from './network-words';
import { NETWORKS, PLATFORM_KEYS, type Platform } from './networks';
import {
  answersAnyTime,
  beforeDay,
  gapAfter,
  holdsTheDay,
  IDLE_MS,
  listSays,
  listTurn,
  lookOutsideAt,
  markOf,
  networkDay,
  networkWaitWords,
  nextRound,
  nextStart,
  nextWatch,
  replyWaiting,
  retryWake,
  roundDue,
  soonestAgain,
  stillReplied,
  waitsAgain,
  watchDue,
  withoutRequests,
  workKey,
  workLeft,
  type AutoState,
  type BeforeDay,
  type NetworkDay,
  type PlanItem,
  type PlanList,
  type Work,
} from './plan-rules';
import { RUNNERS, type RunnerJob, type RunnerKit } from './runners';

/** The first build of the extension that says where its day is up to. */
export const PLAN_SINCE = '0.155.0';

/** The most rows of what's coming the plan lists; the rest are counted (`more`). */
export const PLAN_ROWS_MOST = 40;
/** The most of the day's tried steps a note carries, and the longest of each. */
export const PLAN_TRIED_MOST = 2000;
export const PLAN_KEY_MOST = 300;
/** The longest line a note carries for how a job went. */
export const PLAN_LINE_MOST = 500;

/** While an ask of the person's goes first, the runner looks again after this. */
const ASK_FIRST_MS = 2 * 60_000;
/** While noting is off, the runner looks again this often. */
const LOOK_AGAIN_MS = 30 * 60_000;
/** The middle of every random wait: the plan's times are what's likely, never a promise. */
const LIKELY = 0.5;

// ------------------------------------------------------------------------------------------------- what's reported

const ms = z.number().int().min(0).max(8_640_000_000_000_000);
const key = z.string().min(1).max(60);
const line = z
  .string()
  .transform((s) => (s.length > PLAN_LINE_MOST ? s.slice(0, PLAN_LINE_MOST) : s));

/**
 * Where a network's runner is in its day, as the extension says it: the part of its own state (./plan-rules.ts
 * `AutoState`) the day is planned from. Times are on the extension's clock, in milliseconds; HandsFreeOS moves them
 * onto its own as it keeps them.
 */
export const PlanState = z.object({
  /** The business's day these are for: "2026-11-25". A later day starts afresh. */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  started: z.boolean(),
  stopped: z.string().max(40).nullable(),
  /** Those on the list done or passed over today (`workKey`). */
  tried: z.array(z.string().min(1).max(PLAN_KEY_MOST)).max(PLAN_TRIED_MOST),
  /** How many of each it did today. */
  done: z.record(key, z.number().int().min(0).max(100_000)).default({}),
  /** The once-a-day jobs done today, and what was done before the day, each with how it went. */
  daily: z.record(key, line).default({}),
  before: z.record(key, line).default({}),
  readLast: z.boolean().default(false),
  replied: z.array(z.string().max(80)).max(50).default([]),
  againAt: z.record(key, ms).default({}),
  round: z.number().int().min(0).max(50).default(0),
  roundAt: ms.nullable().default(null),
  watchAt: ms.nullable().default(null),
  helpfulAt: ms.nullable().default(null),
  helpfulUp: z.boolean().default(false),
  referAt: ms.nullable().default(null),
  requestsOff: z.boolean().default(false),
  /** What it's doing, or last did, in words, and when. */
  line: line.nullable().default(null),
  lineAt: ms.nullable().default(null),
  /** When it goes next: null when it isn't going to. */
  nextAt: ms.nullable().default(null),
  working: z.boolean().default(false),
  needs: z.boolean().default(false),
});
export type PlanState = z.output<typeof PlanState>;

/** The same, as the rules read it: the runner's own state, less what's only the extension's (its tab, its lists). */
export type PlanDay = Required<
  Pick<
    AutoState,
    | 'day'
    | 'started'
    | 'stopped'
    | 'tried'
    | 'done'
    | 'daily'
    | 'before'
    | 'readLast'
    | 'replied'
    | 'againAt'
    | 'round'
    | 'roundAt'
    | 'watchAt'
    | 'helpfulAt'
    | 'helpfulUp'
    | 'referAt'
    | 'requestsOff'
    | 'line'
    | 'lineAt'
    | 'nextAt'
    | 'working'
    | 'needs'
  >
>;

/** A day with nothing done yet. */
export function freshPlanDay(day: string | null): PlanDay {
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
    round: 0,
    roundAt: null,
    watchAt: null,
    helpfulAt: null,
    helpfulUp: false,
    referAt: null,
    requestsOff: false,
    line: null,
    lineAt: null,
    nextAt: null,
    working: false,
    needs: false,
  };
}

/** What a note kept says, as the rules read it. Its jobs' names are the extension's own, read only where known. */
export const planDayOf = (kept: PlanState): PlanDay => kept as unknown as PlanDay;

/**
 * What the extension sends of a runner's state (`outreach.plan.note`): the part the day is planned from, with the
 * newest of a very long day's tried steps and each line cut to what a note carries. `quiet` names once-a-day jobs to
 * leave out with the line each has when it didn't run for this person (the comment research, HandsFreeOS's own staff's).
 */
export function planStateOf(
  state: AutoState,
  quiet: Readonly<Partial<Record<RunnerJob, string>>> = {},
): z.input<typeof PlanState> {
  const clip = (words: string) => words.slice(0, PLAN_LINE_MOST);
  const lines = (kept: Readonly<Partial<Record<string, string>>> | undefined, drop = false) =>
    Object.fromEntries(
      Object.entries(kept ?? {})
        .filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !(drop && quiet[entry[0] as RunnerJob] === entry[1]),
        )
        .map(([job, words]) => [job, clip(words)]),
    );
  return {
    day: state.day,
    started: state.started,
    stopped: state.stopped,
    tried: state.tried.slice(-PLAN_TRIED_MOST).map((k) => k.slice(0, PLAN_KEY_MOST)),
    done: Object.fromEntries(
      Object.entries(state.done).filter((e): e is [string, number] => e[1] !== undefined),
    ),
    daily: lines(state.daily, true),
    before: lines(state.before),
    readLast: state.readLast ?? false,
    replied: [...(state.replied ?? [])],
    againAt: Object.fromEntries(
      Object.entries(state.againAt ?? {}).filter((e): e is [string, number] => e[1] !== undefined),
    ),
    round: state.round ?? 0,
    roundAt: state.roundAt ?? null,
    watchAt: state.watchAt ?? null,
    helpfulAt: state.helpfulAt ?? null,
    helpfulUp: state.helpfulUp ?? false,
    referAt: state.referAt ?? null,
    requestsOff: state.requestsOff ?? false,
    line: state.line === null ? null : clip(state.line),
    lineAt: state.lineAt,
    nextAt: state.nextAt,
    working: state.working,
    needs: state.needs ?? false,
  };
}

/**
 * What of a note is worth sending again: everything but its line, which changes with every page a job reads. The
 * extension sends a note only when this changed since the last one kept, so a long read tells HandsFreeOS twice (it
 * started, it ended), not at every line.
 */
export function planNoteKey(state: z.input<typeof PlanState>): string {
  const { line: _line, lineAt: _lineAt, ...rest } = state;
  return JSON.stringify(rest);
}

/** A note's times, moved from the extension's clock onto HandsFreeOS's by how far apart they are (`skew`, in ms). */
export function onPlanClock(state: PlanState, skew: number): PlanState {
  if (!skew) return state;
  const move = (at: number | null) => (at === null ? null : Math.max(0, at + skew));
  return {
    ...state,
    againAt: Object.fromEntries(
      Object.entries(state.againAt).map(([job, at]) => [job, Math.max(0, at + skew)]),
    ),
    roundAt: move(state.roundAt),
    watchAt: move(state.watchAt),
    helpfulAt: move(state.helpfulAt),
    referAt: move(state.referAt),
    lineAt: move(state.lineAt),
    nextAt: move(state.nextAt),
  };
}

// ------------------------------------------------------------------------------------------------- the next move

/** What HandsFreeOS knows of a network's day, beside where the extension said it's up to. */
export interface PlanFacts<I extends PlanItem = PlanItem> {
  readonly platform: Platform;
  readonly now: number;
  readonly timeZone: string;
  readonly hours: WorkingHours;
  /** The person's choices on the network. */
  readonly choices: Pick<NetworkChoices, 'on' | 'sending' | 'collect' | 'watchPosts'>;
  /** It notes the person's steps: it works on its own only while it does. */
  readonly noting: boolean;
  /** Their day there, as pressed: null when HandsFreeOS keeps none. */
  readonly day: Pick<LiveDay, 'date' | 'state' | 'why'> | null;
  /** The network showed them a warning today. */
  readonly warned: boolean;
  /** How many things they asked of the extension there wait or are under way: those go first. */
  readonly asks: number;
  /** Their lists there, as last saved. */
  readonly lists: ListsSaved;
  /** Today's list there. */
  readonly list: PlanList<I> & {
    readonly goal?: { readonly more?: boolean | undefined } | null | undefined;
    readonly retryAt?: string | null | undefined;
  };
}

/** Why nothing goes now. */
export type PlanWait = 'off' | 'stopped' | 'warned' | 'noting' | 'asks' | 'hours' | 'idle';

/** What the runner does next, by the rules: a wait, a part of the day's reading, or a piece of the list's work. */
export type PlanMove<I extends PlanItem = PlanItem> =
  | { readonly do: 'wait'; readonly why: PlanWait; readonly until: number | null }
  | { readonly do: 'before'; readonly step: BeforeDay; readonly gap: number }
  | { readonly do: 'daily'; readonly job: RunnerJob; readonly gap: number }
  | { readonly do: 'search'; readonly gap: number }
  | { readonly do: 'watch'; readonly gap: number }
  | {
      readonly do: 'work';
      readonly work: Work<I>;
      /** How many more are left on the list after it. */
      readonly left: number;
      /** How long it waits after it before the next go. */
      readonly gap: number;
    };

/** What's left on the network's list for its runner: only the kinds it does there, and messages where it writes them. */
export function leftOn<I extends PlanItem>(
  kit: RunnerKit,
  list: PlanList<I>,
  state: Pick<PlanDay, 'tried' | 'replied' | 'requestsOff'>,
): Work<I>[] {
  const left = workLeft(
    { ...list, auto: list.auto.filter((kind) => kit.auto.includes(kind)) },
    state.tried,
    state.replied,
  ).filter((w) => kit.messages || w.do === 'step' || underAPost(w.item.kind));
  return withoutRequests(left, state.requestsOff);
}

/**
 * The once-a-day job a before-the-day step stands for, done with it: the morning's requests and the first checks; on
 * a follow network the newest followers saved are the day's `requests`.
 */
export function standsFor(platform: Platform, step: BeforeDay): RunnerJob | null {
  const mark = markOf(step);
  if (NETWORKS[platform].follows)
    return mark === 'friends' ? 'requests' : mark === 'checks' ? mark : null;
  return mark === 'requests' || mark === 'checks' || mark === 'group_checks' ? mark : null;
}

/**
 * What a network's runner does next (the runners' own order, apps/extension/src/auto/, each one's `go`): nothing while
 * Sending is off there, the day is stopped, the network warned, or noting is off; outside the working hours only
 * replies to those who wrote back (decision 133); what the person asked first (decision 43); then the lists before
 * the day, the once-a-day jobs and the hourly search, by turns with the list (decision 123); the newest posts every
 * hour or two (decision 49); and the list, its steps spread over what's left of the hours. `random` is from 0 to 1,
 * for every wait it picks. The state comes back as the move leaves it before it's done (a new day begun, a round of
 * finding again begun).
 */
export function nextMove<I extends PlanItem>(
  facts: PlanFacts<I>,
  kept: PlanDay,
  random: number = LIKELY,
): { readonly move: PlanMove<I>; readonly state: PlanDay } {
  const { platform, now, timeZone, hours, choices, list } = facts;
  const kit = RUNNERS[platform];
  const today = businessDay(now, timeZone);
  // A new day starts afresh; the hourly search keeps its hour.
  let state: PlanDay =
    kept.day === today
      ? kept
      : { ...freshPlanDay(today), watchAt: kit.searches ? kept.watchAt : null };
  const wait = (why: PlanWait, until: number | null) =>
    ({ move: { do: 'wait', why, until }, state }) as const;
  if (!choices.on || choices.sending === 'off') return wait('off', null);

  const own = networkDay({ day: facts.day, today, hours, timeZone, now, random });
  const tomorrow = () => nextStart(hours, timeZone, now, random);
  const pace = Math.round(kit.pace.least + random * (kit.pace.most - kit.pace.least));
  const work = (
    all: readonly Work<I>[],
    reading: boolean,
    day: Extract<NetworkDay, { go: true }>,
  ) => {
    const spread = gapAfter({
      now,
      until: day.until,
      left: all.length - 1,
      // A person's pace while the day's reading is left: the list's turn and the reading's go by turns.
      started: day.started || reading,
      random,
    });
    return {
      move: {
        do: 'work',
        work: all[0]!,
        left: all.length - 1,
        gap: kit.paced ? Math.max(pace, spread) : spread,
      },
      state,
    } as const;
  };
  const says = listSays(list);
  // A comment research that runs (HandsFreeOS's own staff's, decision 172) reads its next batch first whenever it's
  // due, outside the working hours too (decision 194, the runners' `researchNext`). It's known to run once a batch
  // of it waits: for anyone else none ever does.
  const researchAt =
    choices.collect &&
    kit.daily.includes('comment_research') &&
    state.daily.comment_research === undefined
      ? (state.againAt.comment_research ?? null)
      : null;
  const researchDue = researchAt !== null && researchAt <= now;

  if (!own.go) {
    if (own.stopped !== null)
      return wait(own.stopped === 'warning' ? 'warned' : 'stopped', own.next);
    if (facts.warned) return wait('warned', own.next);
    if (!facts.noting) return wait('noting', own.next);
    // Outside the hours a reply to someone who wrote back still goes, where it writes in their messages, and nothing
    // new does (decision 133); what the person asked goes first.
    if (kit.messages && facts.asks === 0) {
      const answers = leftOn(kit, list, state).filter(answersAnyTime);
      if (answers[0]) return work(answers, false, { go: true, started: true, until: null });
    }
    // A comment research reads outside the hours too, as it only reads (decision 194).
    if (researchDue && facts.asks === 0)
      return { move: { do: 'daily', job: 'comment_research', gap: pace }, state };
    const look = lookOutsideAt(
      kit.messages && replyWaiting(list),
      now,
      own.next,
      retryWake({ retryAt: says.retryAt }, now),
    );
    return wait('hours', researchAt !== null ? Math.min(look ?? Infinity, researchAt) : look);
  }
  if (facts.warned || state.stopped === 'warning') return wait('warned', tomorrow());
  if (!facts.noting) return wait('noting', now + LOOK_AGAIN_MS);
  if (facts.asks > 0) return wait('asks', now + ASK_FIRST_MS);

  const before = beforeDay(facts.lists, state.before, now, timeZone, platform);
  // The comment research is HandsFreeOS's own staff's (decision 172): planned only while one of its batches waits.
  const jobs = choices.collect
    ? kit.daily.filter(
        (job) => job !== 'comment_research' || state.againAt.comment_research !== undefined,
      )
    : [];
  const nextJob = () =>
    jobs.find((job) => state.daily[job] === undefined && !waitsAgain(state, job, now)) ?? null;
  let daily: RunnerJob | null = researchDue ? 'comment_research' : nextJob();
  // Short of good fits once the day's reading is done (decision 126): it finds people again, and checks them.
  if (
    choices.collect &&
    !before &&
    !daily &&
    roundDue({ more: says.more, round: state.round, roundAt: state.roundAt }, now)
  ) {
    state = { ...state, ...nextRound(state, kit.finding, now) };
    daily = nextJob();
  }
  const searching = kit.searches && choices.collect && !holdsTheDay(before) && watchDue(state, now);
  const reading = before !== null || daily !== null || searching;
  // The day's reading and the list take turns (decision 123): a step on the list now, when there's one, after a part
  // of the reading went last.
  if (listTurn(state, reading, holdsTheDay(before))) {
    const all = leftOn(kit, list, state);
    const replied = stillReplied(state.replied, all);
    if (replied.length !== state.replied.length) state = { ...state, replied };
    if (all[0]) return work(all, reading, own);
  }
  if (searching) return { move: { do: 'search', gap: pace }, state };
  if (before) return { move: { do: 'before', step: before, gap: pace }, state };
  if (daily) return { move: { do: 'daily', job: daily, gap: pace }, state };

  const window = workWindow(workHours(hours), timeZone, now);
  const inHours = window !== null && now >= window.from && now < window.to;
  const watches = kit.watches && choices.watchPosts;
  if (watches && inHours && watchDue(state, now))
    return { move: { do: 'watch', gap: pace }, state };

  const all = leftOn(kit, list, state);
  if (all[0]) return work(all, reading, own);
  // Nothing left: it looks again within the hour, or when the next batch of checks, the newest posts, its search or a
  // message tried again is due, whichever is first. Facebook's sleeps till its next hours once they're over.
  if (!kit.paced && !inHours) return wait('idle', tomorrow());
  const again = choices.collect ? soonestAgain(state, now) : null;
  return wait(
    'idle',
    Math.min(
      now + IDLE_MS,
      ...(inHours ? [window.to] : []),
      ...(again !== null ? [again] : []),
      ...(watches && state.watchAt !== null ? [Math.max(state.watchAt, now)] : []),
      ...(kit.searches && choices.collect && state.watchAt !== null ? [state.watchAt] : []),
      ...retryWake({ retryAt: says.retryAt }, now),
    ),
  );
}

// ------------------------------------------------------------------------------------------------- the day ahead

/**
 * About how long each kind of move takes, in minutes, for the plan's times alone. A rough guide: how long a read
 * takes depends on how much there is to read that day. Only what follows the next move leans on these, and each is
 * shown as "about".
 */
export const MOVE_MINUTES = {
  /** A list saved before the day, and the first checks. */
  before: 5,
  /** A once-a-day job, unless it's one of the long ones below. */
  job: 3,
  search: 4,
  watch: 3,
  /** A step on the list, a message written, a message sent. */
  work: 1,
} as const;
/** The once-a-day jobs that read many pages. */
const LONG_JOB_MINUTES: Readonly<Partial<Record<RunnerJob, number>>> = {
  chats: 10,
  checks: 10,
  found_checks: 10,
  members: 8,
  group_checks: 6,
  group_posts: 6,
  posts: 6,
  post_people: 6,
  comment_research: 8,
  partners: 5,
  like_yours: 5,
  follow_backs: 5,
};

const minutesOf = (move: Exclude<PlanMove, { do: 'wait' }>): number =>
  move.do === 'daily'
    ? (LONG_JOB_MINUTES[move.job] ?? MOVE_MINUTES.job)
    : move.do === 'before'
      ? MOVE_MINUTES.before
      : MOVE_MINUTES[move.do];

/** The words kept for a part of the day's reading the plan takes as done, while it works the day out. */
const PLANNED = 'Planned.';

/** A move taken as done, for working out what follows it: the state and the lists it leaves. */
function afterMove<I extends PlanItem>(
  platform: Platform,
  state: PlanDay,
  lists: ListsSaved,
  move: Exclude<PlanMove<I>, { do: 'wait' }>,
  now: number,
): { readonly state: PlanDay; readonly lists: ListsSaved } {
  switch (move.do) {
    case 'before': {
      const mark = markOf(move.step);
      const job = standsFor(platform, move.step);
      return {
        state: {
          ...state,
          before: { ...state.before, [mark]: PLANNED },
          ...(job ? { daily: { ...state.daily, [job]: PLANNED } } : {}),
          readLast: true,
        },
        lists: { ...lists, [atKey(mark)]: new Date(now).toISOString() },
      };
    }
    case 'daily': {
      const { [move.job]: _was, ...againAt } = state.againAt;
      return {
        state: {
          ...state,
          daily: { ...state.daily, [move.job]: PLANNED },
          againAt,
          readLast: true,
          // Find posts just read the groups: the newest posts wait an hour or two.
          ...(move.job === 'posts' && RUNNERS[platform].watches
            ? { watchAt: nextWatch(now, LIKELY) }
            : {}),
        },
        lists,
      };
    }
    case 'search': {
      const every = NETWORKS[platform].postSearch?.everyMinutes ?? 60;
      return { state: { ...state, watchAt: now + every * 60_000, readLast: true }, lists };
    }
    case 'watch':
      return { state: { ...state, watchAt: nextWatch(now, LIKELY) }, lists };
    case 'work': {
      const { work } = move;
      return {
        state: {
          ...state,
          tried: [...state.tried, workKey(work)],
          readLast: false,
          // A reply drafted is theirs answered (decision 125).
          replied:
            work.do === 'draft'
              ? state.replied.filter((id) => id !== work.item.profileId)
              : state.replied,
        },
        lists,
      };
    }
  }
}

/** A move the day has coming, and about when. */
export interface PlannedMove<I extends PlanItem = PlanItem> {
  readonly at: number;
  /** Worked out, not the extension's own time: shown as "about". */
  readonly about: boolean;
  /** Under way now. */
  readonly now: boolean;
  readonly move: Exclude<PlanMove<I>, { do: 'wait' }>;
}

/**
 * The rest of the day on a network, worked out move by move with the runner's rules: each move taken as done, in
 * about the time it takes, with the wait it would pick after it. Where the day stands now is `first`; `moves` are
 * what follows, the first at the extension's own time when it said one, till the working hours end (or the day, after
 * Start my day) or `most` moves are listed, the rest counted in `more`. What the person asked of the extension goes
 * before any of it, and isn't in it.
 */
export function planAhead<I extends PlanItem>(
  facts: PlanFacts<I>,
  reported: PlanDay | null,
  most: number = PLAN_ROWS_MOST,
): {
  readonly first: PlanMove<I>;
  readonly moves: PlannedMove<I>[];
  readonly more: number;
  /** When the plan ends: the working hours' end, or the day's. */
  readonly until: number;
  /** The day's state, as it stands now. */
  readonly state: PlanDay;
} {
  const { now, timeZone, hours } = facts;
  const today = businessDay(now, timeZone);
  const at0 = nextMove(facts, reported ?? freshPlanDay(today));
  let state = at0.state;
  const window = workWindow(workHours(hours), timeZone, now);
  const dayEnd = localInstant(addDays(today, 1), '00:00', timeZone);
  const pressed = facts.day?.date === today && facts.day.state === 'started';
  const until = !pressed && window !== null && now < window.to ? window.to : dayEnd;
  const working = state.working && at0.move.do !== 'wait';
  // The extension's own next time, when it's ahead: what follows is spaced from there.
  const said = !working && state.nextAt !== null && state.nextAt > now && state.nextAt < until;
  let t = said ? state.nextAt! : now;
  let lists = facts.lists;
  const moves: PlannedMove<I>[] = [];
  let more = 0;
  const first = at0.move;
  // Each go is a move or a wait: a day has a few hundred at most.
  for (let go = 0; go < 600 && t < until; go++) {
    const next = nextMove({ ...facts, now: t, lists, asks: 0 }, state);
    state = next.state;
    const { move } = next;
    if (move.do === 'wait') {
      const waits = move.why === 'hours' || move.why === 'idle';
      if (!waits || move.until === null || move.until <= t || move.until >= until) break;
      t = move.until;
      continue;
    }
    if (moves.length < most)
      moves.push({
        at: t,
        about: moves.length > 0 || (!said && !working),
        now: moves.length === 0 && working,
        move,
      });
    else more++;
    ({ state, lists } = afterMove(facts.platform, state, lists, move, t));
    t += minutesOf(move) * 60_000 + move.gap;
  }
  return { first, moves, more, until, state: at0.state };
}

// ------------------------------------------------------------------------------------------------- what's shown

/** Where the day stands on a network, for the plan's heading. */
export const PLAN_STANDS = {
  none: 'No computer yet',
  signed_out: 'Signed out of the extension',
  offline: 'Offline',
  off: 'Off',
  stopped: 'Stopped for today',
  warned: 'Stopped for today',
  noting: 'Needs you',
  asks: 'Doing what you asked',
  waiting: 'Starts later',
  working: 'Working now',
  going: 'Going',
  idle: 'Done for now',
} as const;
export type PlanStand = keyof typeof PLAN_STANDS;
export const PLAN_STAND_KEYS = Object.keys(PLAN_STANDS) as [PlanStand, ...PlanStand[]];

/** A stand's place, for a coloured chip. */
export function planTone(stand: PlanStand): 'good' | 'waiting' | 'warn' | 'plain' {
  if (stand === 'working' || stand === 'going' || stand === 'asks') return 'good';
  if (stand === 'waiting' || stand === 'idle') return 'waiting';
  if (stand === 'offline' || stand === 'warned' || stand === 'noting' || stand === 'signed_out')
    return 'warn';
  return 'plain';
}

/** What a row is: a part of the day's reading, or a piece of the list's work. */
export const PLAN_ROW_KINDS = ['lists', 'job', 'search', 'watch', 'step', 'draft', 'send'] as const;
export type PlanRowKind = (typeof PLAN_ROW_KINDS)[number];

export const PlanRow = z.object({
  /** When, on HandsFreeOS's clock. */
  at: z.iso.datetime(),
  /** Worked out, not the extension's own time: shown as "about 2:15 PM". */
  about: z.boolean(),
  /** Under way now. */
  now: z.boolean(),
  kind: z.enum(PLAN_ROW_KINDS),
  /** What: "Check my friends", "Send a friend request". */
  title: z.string(),
  /** Who it's for, when it's for someone on the list. */
  who: z.string().nullable(),
  /** For a message, what kind: "First message", "Reply". */
  detail: z.string().nullable(),
});
export type PlanRow = z.output<typeof PlanRow>;

export const PlanInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose plan: Facebook's when left out. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type PlanInput = z.input<typeof PlanInput>;

const n = z.number().int().min(0);

export const PlanOutput = z.object({
  platform: z.enum(PLATFORM_KEYS),
  timezone: z.string(),
  now: z.iso.datetime(),
  /**
   * Whether the extension has said where its day is up to there (it does from `PLAN_SINCE`). Until it has, what's
   * done today isn't known, so nothing's listed as coming and `line` says to update it.
   */
  reported: z.boolean(),
  /** Where the day stands, and a line that says it. */
  stand: z.enum(PLAN_STAND_KEYS),
  line: z.string(),
  /** What it's doing now, in its own words, while a move is under way. */
  doing: z.string().nullable(),
  /** When the plan ends: the working hours' end today, or the day's after Start my day. Null with nothing coming. */
  until: z.iso.datetime().nullable(),
  /** What the person asked of the extension there that waits or is under way: it goes before the plan. */
  asked: z.array(z.object({ askId: z.uuid(), title: z.string(), working: z.boolean() })),
  /** What's coming, in order. */
  coming: z.array(PlanRow).max(PLAN_ROWS_MOST),
  /** How many more follow those listed, before the plan ends. */
  more: n,
  /** The day's reading done so far: each part with how it went. */
  done: z.array(z.object({ title: z.string(), line: z.string() })),
  /** The list's work done so far today: "3 friend requests sent". */
  counts: z.array(z.object({ label: z.string(), count: n })),
  /** What repeats through the day, and what the plan can't see. */
  notes: z.array(z.string()),
});
export type PlanOutput = z.output<typeof PlanOutput>;

/** What the extension says of where its day is up to on a network, when that changes. */
export const PlanNoteInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
  /** The extension's install id, as its heartbeat gives it: only the computer that works is kept. */
  computer: z.uuid(),
  state: PlanState,
});
export type PlanNoteInput = z.input<typeof PlanNoteInput>;
export const PlanNoteOutput = z.object({
  /** Kept: false from a computer that isn't the one that works, or one HandsFreeOS doesn't know yet. */
  kept: z.boolean(),
});
export type PlanNoteOutput = z.output<typeof PlanNoteOutput>;

/** The plan's words that stay the same. */
export const PLAN_WORDS = {
  title: 'Plan',
  /** The heading when the person works more than one network. */
  titleOn: (network: string) => `Plan on ${network}`,
  about: 'What your computer will do today, and about when.',
  coming: 'Coming up',
  asked: 'You asked for these first',
  askWorking: 'Doing now',
  askWaiting: 'Next',
  done: 'Done so far today',
  nothingComing: 'Nothing more is planned for today.',
  times:
    'Times are a rough guide. It spreads its steps out and waits a little between them, the way a person would.',
  update: `Update the extension on your computer to ${PLAN_SINCE} or later, and its plan shows here.`,
  notYet:
    'Your computer hasn’t said where its day is up to yet. It does within a minute of being on.',
  /** The Plan part, when the plan couldn't be had. */
  notLoaded: 'The plan couldn’t be loaded just now. Try again in a minute.',
} as const;

/** The list's work done so far in a line: "3 friend requests sent · 5 likes". */
export const planCountsLine = (counts: PlanOutput['counts']): string =>
  counts.map((c) => `${c.count.toLocaleString('en-US')} ${c.label}`).join(' · ');

/** "about 2:15 PM", "2:15 PM", or "Now", before a row. */
export function planWhen(row: Pick<PlanRow, 'at' | 'about' | 'now'>, timeZone: string): string {
  if (row.now) return 'Now';
  const clock = clockWords(row.at, timeZone);
  return row.about ? `About ${clock}` : clock;
}

/** "and 14 more before 5:00 PM". */
export const planMoreWords = (more: number, until: string | null, timeZone: string): string =>
  more > 0 ? `And ${more} more${until ? ` before ${clockWords(until, timeZone)}` : ''}.` : '';

const DONE_WORDS = {
  confirm: ['request confirmed', 'requests confirmed'],
  warm_up: ['like', 'likes'],
  comment: ['comment', 'comments'],
  drafted: ['message written', 'messages written'],
  sent: ['message sent', 'messages sent'],
  story_like: ['story liked', 'stories liked'],
} as const;

/** The list's work done today, in the order it's counted: "3 friend requests sent", "5 likes". */
export function planCounts(
  platform: Platform,
  done: PlanDay['done'],
): { label: string; count: number }[] {
  const words = NETWORKS[platform].words;
  const of = (kind: keyof PlanDay['done']) => done[kind] ?? 0;
  const requests = of('friend_request');
  return [
    {
      count: requests,
      label: `${requests === 1 ? words.friendRequest : words.friendRequests} sent`,
    },
    ...(Object.keys(DONE_WORDS) as (keyof typeof DONE_WORDS)[]).map((kind) => ({
      count: of(kind),
      label: DONE_WORDS[kind][of(kind) === 1 ? 0 : 1],
    })),
  ].filter((c) => c.count > 0);
}

/** A move as a row: what, for whom, and about when. */
export function planRow<I extends PlanItem>(platform: Platform, planned: PlannedMove<I>): PlanRow {
  const { move } = planned;
  const base = {
    at: new Date(planned.at).toISOString(),
    about: planned.about,
    now: planned.now,
    who: null,
    detail: null,
  };
  switch (move.do) {
    case 'before':
      return { ...base, kind: 'lists', title: PRE_DAY_WORDS_ON[platform][markOf(move.step)] };
    case 'daily':
      return { ...base, kind: 'job', title: RUNNERS[platform].names[move.job] ?? move.job };
    case 'search':
      return { ...base, kind: 'search', title: 'Search for new posts' };
    case 'watch':
      return { ...base, kind: 'watch', title: 'Look at the newest posts in your groups' };
    case 'work': {
      const { work } = move;
      const kinds = todayKindsOn(platform);
      if (work.do === 'step')
        return { ...base, kind: 'step', title: kinds[work.item.kind], who: work.item.name };
      const comment = underAPost(work.item.kind);
      return {
        ...base,
        kind: work.do,
        title:
          work.do === 'draft'
            ? comment
              ? 'Write a comment'
              : 'Write a message'
            : comment
              ? 'Post the comment'
              : 'Send the message',
        who: work.item.name,
        detail: comment ? null : kinds[work.item.kind],
      };
    }
  }
}

/**
 * The plan as the app shows it, less what the person asked for (`asked`, the operation's): where the day stands in a
 * line, what's coming with about when, and what's done so far. `computer` is the one that works for the person, null
 * with none; `reported` what the extension last said of this network's day, null when it never has.
 */
export function planShown<I extends PlanItem>(input: {
  readonly facts: PlanFacts<I>;
  readonly reported: PlanDay | null;
  readonly computer: {
    readonly state: ReportedState;
    readonly lastSeenAt: string | Date;
    /** Its build, as its heartbeat said: null when it didn't. */
    readonly version: string | null;
  } | null;
}): Omit<PlanOutput, 'asked'> {
  const { facts, reported, computer } = input;
  const { platform, now, timeZone, hours } = facts;
  const name = NETWORKS[platform].name;
  const kit = RUNNERS[platform];
  const base = {
    platform,
    timezone: timeZone,
    now: new Date(now).toISOString(),
    reported: reported !== null,
    doing: null,
    until: null,
    coming: [],
    more: 0,
    done: [],
    counts: [],
    notes: [],
  } satisfies Partial<PlanOutput>;
  if (!computer)
    return {
      ...base,
      stand: 'none',
      line: 'No computer has the extension yet, so nothing runs on its own. Get it under Social Outreach → Set up.',
    };
  if (computer.state === 'signed_out')
    return {
      ...base,
      stand: 'signed_out',
      line: 'You’re signed out of the extension on your computer, so nothing runs. Open its panel there and sign in.',
    };

  const ahead = planAhead(facts, reported);
  const { first, state } = ahead;
  // What's done so far today, as the extension said: the lists before the day, then the once-a-day jobs in order.
  const done = [
    ...Object.entries(state.before).map(([mark, words]) => ({
      title: PRE_DAY_WORDS_ON[platform][mark as ListMark] ?? mark,
      line: words ?? '',
    })),
    ...kit.daily
      .filter((job) => state.daily[job] !== undefined)
      .map((job) => ({ title: kit.names[job] ?? job, line: state.daily[job]! })),
  ];
  const counts = planCounts(platform, state.done);
  const kept = { ...base, done, counts };

  if (isOffline(computer.lastSeenAt, now))
    return {
      ...kept,
      stand: 'offline',
      line: offlineWords(computer.lastSeenAt, timeZone, now),
    };
  if (first.do === 'wait' && first.why === 'off')
    return {
      ...kept,
      stand: 'off',
      line: facts.choices.on
        ? `The extension does nothing on its own on ${name} while Sending is off there. Turn it on under Social Outreach → Settings → ${name}.`
        : `${name} is off for you, so nothing is planned there. Turn it on under Social Outreach → Settings → ${name}.`,
    };
  // Its day isn't known till the extension says: a build from before it never does.
  if (reported === null)
    return {
      ...kept,
      stand: 'waiting',
      line: appVersionAtLeast(computer.version, PLAN_SINCE) ? PLAN_WORDS.notYet : PLAN_WORDS.update,
    };

  const coming = ahead.moves.map((m) => planRow(platform, m));
  const shown = {
    ...kept,
    until: coming.length ? new Date(ahead.until).toISOString() : null,
    coming,
    more: ahead.more,
    notes: planNotes(facts, state),
  };
  if (first.do === 'wait') {
    const wait = { stopped: first.why === 'stopped' ? 'person' : null };
    switch (first.why) {
      case 'stopped':
      case 'hours':
        return {
          ...shown,
          stand: first.why === 'stopped' ? 'stopped' : 'waiting',
          line: networkWaitWords(name, wait, hours, timeZone, now),
        };
      case 'warned':
        return { ...shown, stand: 'warned', line: warnedTodayWords(platform) };
      case 'noting':
        return {
          ...shown,
          stand: 'noting',
          line: `Turn on noting your steps under Social Outreach → Settings. The extension works on its own on ${name} only while it notes them.`,
        };
      case 'asks':
        return {
          ...shown,
          stand: 'asks',
          line: 'It’s doing what you asked first. The rest of its day carries on after that.',
        };
      default: {
        const again =
          first.until !== null && first.until > now
            ? ` It looks again by ${clockWords(first.until, timeZone)}.`
            : '';
        return {
          ...shown,
          stand: 'idle',
          line: `${state.tried.length ? 'Done for now.' : `Nothing on your ${name} list for it to do yet.`}${again}`,
        };
      }
    }
  }
  const next = coming[0];
  if (state.working)
    return {
      ...shown,
      stand: 'working',
      line: 'Working now.',
      doing: state.line,
    };
  return {
    ...shown,
    stand: 'going',
    line: next
      ? `Next ${next.about ? 'about ' : 'at '}${clockWords(next.at, timeZone)}: ${rowWords(next)}.`
      : 'Going.',
  };
}

/** A row in a few words: "Send a friend request (Dana Reyes)". */
export const rowWords = (row: Pick<PlanRow, 'title' | 'who'>): string =>
  row.who ? `${row.title} (${row.who})` : row.title;

/** What repeats through the day there, and what the plan leaves out. */
function planNotes(facts: PlanFacts, state: PlanDay): string[] {
  const notes: string[] = [];
  if (facts.asks > 0)
    notes.push('What you asked for goes first, so the times here may run a little later.');
  if (soonestAgain(state, facts.now) !== null)
    notes.push('It checks more people later today, a few at a time.');
  return notes;
}
