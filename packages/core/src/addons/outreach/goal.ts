/**
 * The day's goal on each network (docs/outreach.md, decision 126; the owner, 29 Oct 2026: "its main purpose is to
 * send out new messages to good leads"), answered 1a 2a 3c 4a 5a 6a 7a 8a 9a:
 *
 * - **The goal is first messages** (1a): a new chat started with someone who fits. Friend requests, likes and comments
 *   help, but don't count.
 * - **Each network's goal is its daily limit for them** (2a): the business's own under the kit's, half while the
 *   person is new there or on training wheels, and after a warning.
 * - **Friends first, never strangers** (3c): a first message still goes only to someone who accepted their request, a
 *   friend who fits and has been quiet a month, or (Instagram's) one short message to their Requests. Every way of
 *   finding people sends more requests instead.
 * - **Ready ahead** (6a): while fewer good fits than `GOAL_AHEAD_DAYS` days of first messages are ready, the network
 *   checks more people (4a, each kit's `checksMost`), takes those who might fit after the good ones (5a), and searches
 *   again later in the day with the next words.
 * - **Told when it can't** (7a): as soon as the reason is one that won't fix itself, or by the middle of the working
 *   hours, a push and a note on Today say which network, how many short, the real reason, and what to try; the day's
 *   report says it again.
 * - **Messages waiting for an OK count as found** (8a): a push at the start of the day and at midday says how many.
 *
 * Plain words, short sentences, curly apostrophes. Browser-safe and pure: Today's note on the web and the phone, and
 * the worker's pushes, read these.
 */
import { z } from 'zod';
import { addDays, localDateOf, localInstant, weekdayOf } from '../../calendar/engine/zoned';
import type { WorkingHours } from './automation';
import { NETWORKS, PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import type { SettingsPart } from './settings-parts';

/** How many days of first messages a network keeps ready ahead before it checks and searches no more than usual. */
export const GOAL_AHEAD_DAYS = 2;
/** Too few fit: under this share of those checked in the last 7 days, once this many were checked. */
export const FEW_FITS = { checked: 20, rate: 0.1 } as const;
/** Too few accept: under this share of the requests sent in the last `days`, once this many were sent. */
export const FEW_ACCEPTS = { sent: 10, rate: 0.2, days: 14 } as const;
/** How many more times a day a network searches while it's short (6a), and how long between. */
export const SEARCH_AGAIN = { rounds: 2, minutes: 90 } as const;

/**
 * Which of the day's searches it is (6a): 0 for the day's own, then each search again; each takes the next words in
 * turn, so a search later in the day uses words it hasn't yet.
 */
export const SearchRound = z.number().int().min(0).max(SEARCH_AGAIN.rounds).default(0);

/**
 * Why a network is short today, the first that holds, in this order: nothing goes out till Get ready is done; too few
 * of those checked fit; it's still checking people the person knows; new friend requests are held; too few accept;
 * too few new people were found to ask; and otherwise first messages wait on requests to be accepted.
 */
export const GOAL_WHYS = [
  'not_ready',
  'few_fits',
  'checking',
  'requests_held',
  'few_accepts',
  'few_found',
  'waiting_accepts',
] as const;
export type GoalWhy = (typeof GOAL_WHYS)[number];

/** The reasons known in the morning: none of them fixes itself as the day goes (7a). The rest wait for midday. */
export const GOAL_KNOWN_EARLY: readonly GoalWhy[] = [
  'not_ready',
  'few_fits',
  'requests_held',
  'few_accepts',
  'few_found',
];

/** What the person can try, each a button to where they do it. */
export const GOAL_TRIES = {
  niche: {
    label: 'Widen your niche',
    line: 'Fewer limits in your playbook on who fits.',
  },
  playbook: {
    label: 'Add a playbook',
    line: 'Another kind of customer to reach.',
  },
  groups: {
    label: 'Join more groups',
    line: 'The groups it suggests, full of people who fit.',
  },
  words: {
    label: 'Add search words',
    line: 'More words in your playbook to find posts and people with.',
  },
  profile: {
    label: 'Finish your profile',
    line: 'More people accept a request from a full profile.',
  },
  networks: {
    label: 'Turn on another network',
    line: 'Each one adds its own first messages a day.',
  },
} as const;
export type GoalTry = keyof typeof GOAL_TRIES;
export const GOAL_TRY_KEYS = Object.keys(GOAL_TRIES) as [GoalTry, ...GoalTry[]];

const n = z.number().int().min(0);

/** What the reason is worked out from: checks today and in the last 7 days, people still to check, and requests. */
export const GoalFacts = z.object({
  /** People the AI checked today, and of them who fit or might. */
  checked: n,
  fit: n,
  /** The same in the last 7 days. */
  weekChecked: n,
  weekFit: n,
  /** People the person knows there not checked yet. */
  unchecked: n,
  /** Requests sent in the last `FEW_ACCEPTS.days` days, and of them accepted. */
  sent: n,
  accepted: n,
});
export type GoalFacts = z.output<typeof GoalFacts>;

export const NO_GOAL_FACTS: GoalFacts = {
  checked: 0,
  fit: 0,
  weekChecked: 0,
  weekFit: 0,
  unchecked: 0,
  sent: 0,
  accepted: 0,
};

/** The day's goal on a network, on Today: what's sent and ready against it, and why it's short. */
export const TodayGoal = z.object({
  /** First messages today: the limit now. */
  most: n,
  done: n,
  /** First messages on today's list, those drafted and waiting for an OK among them. */
  listed: n,
  waitingOk: n,
  /** How many it's short: the limit less those sent and on the list. */
  short: n,
  /** Good fits ready for a first message, today's among them: to reconnect with, and new friends who accepted. */
  ahead: n,
  /** Friend requests on today's list (with the likes before them), and how many today has room for. */
  requests: z.object({ listed: n, left: n }),
  /** Checking more and searching again today (6a): fewer than `GOAL_AHEAD_DAYS` days ready ahead. */
  more: z.boolean(),
  why: z.enum(GOAL_WHYS).nullable(),
  tries: z.array(z.enum(GOAL_TRY_KEYS)),
  facts: GoalFacts,
});
export type TodayGoal = z.output<typeof TodayGoal>;

/** Whether a network keeps fewer good fits ready than its days ahead (6a): it checks more and searches again. */
export const fewAhead = (ahead: number, most: number): boolean =>
  most > 0 && ahead < GOAL_AHEAD_DAYS * most;

/** Why a network is short, or null while it isn't. */
export function goalWhy(input: {
  readonly short: number;
  readonly ready: boolean;
  readonly facts: GoalFacts;
  /** Checks today still has room for. */
  readonly checksRoom: number;
  readonly requestsHeld: boolean;
  readonly requests: { readonly listed: number; readonly left: number };
}): GoalWhy | null {
  const { facts } = input;
  if (input.short <= 0) return null;
  if (!input.ready) return 'not_ready';
  if (facts.weekChecked >= FEW_FITS.checked && facts.weekFit / facts.weekChecked < FEW_FITS.rate)
    return 'few_fits';
  if (input.checksRoom > 0 && facts.unchecked > 0) return 'checking';
  if (input.requestsHeld) return 'requests_held';
  if (facts.sent >= FEW_ACCEPTS.sent && facts.accepted / facts.sent < FEW_ACCEPTS.rate)
    return 'few_accepts';
  if (input.requests.listed < input.requests.left) return 'few_found';
  return 'waiting_accepts';
}

/** What to try for a reason on a network: joining groups where it has them, else search words; another network only while one's off. */
export function goalTries(why: GoalWhy | null, platform: Platform, othersOff: boolean): GoalTry[] {
  const more: GoalTry = NETWORKS[platform].joinsPerDay !== null ? 'groups' : 'words';
  const tries: Record<GoalWhy, GoalTry[]> = {
    not_ready: [],
    few_fits: ['niche', 'playbook', 'networks'],
    checking: [],
    requests_held: ['networks'],
    few_accepts: ['profile', more],
    few_found: [more, 'playbook', 'networks'],
    waiting_accepts: [more, 'networks'],
  };
  return why ? tries[why].filter((t) => t !== 'networks' || othersOff) : [];
}

/** Where a thing to try is done, the same on the web and the phone: Playbooks, Groups, or a part of Settings. */
export type GoalTryPlace =
  | { readonly view: 'playbooks' }
  | { readonly view: 'groups' }
  | { readonly view: 'settings'; readonly part: SettingsPart };

/**
 * Each thing to try's button: the playbooks for the niche, another playbook and search words; Facebook's Groups for its
 * groups (Alignable's are on its part of Settings, with joining on its own); the network's part of Settings for its
 * profile; and General for another network.
 */
export function goalTryPlace(t: GoalTry, platform: Platform): GoalTryPlace {
  switch (t) {
    case 'niche':
    case 'playbook':
    case 'words':
      return { view: 'playbooks' };
    case 'groups':
      return platform === 'facebook' ? { view: 'groups' } : { view: 'settings', part: platform };
    case 'profile':
      return { view: 'settings', part: platform };
    case 'networks':
      return { view: 'settings', part: 'general' };
  }
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The reason in a sentence, in the network's words. */
export function goalWhyWords(why: GoalWhy, facts: GoalFacts, platform: Platform): string {
  const { friendRequest, friendRequests, friends } = NETWORKS[platform].words;
  switch (why) {
    case 'not_ready':
      return 'Finish Get ready, and it starts reaching people.';
    case 'few_fits':
      return `Only ${facts.weekFit.toLocaleString('en-US')} of the ${count(facts.weekChecked, 'person', 'people')} it checked this week fit your playbooks.`;
    case 'checking':
      return `It’s still checking the people you know (${facts.unchecked.toLocaleString('en-US')} to go), and more come as it finds who fits.`;
    case 'requests_held':
      return `New ${friendRequests} are on hold, so fewer new ${friends} come in to write to.`;
    case 'few_accepts':
      return `Only ${facts.accepted.toLocaleString('en-US')} of the ${count(facts.sent, friendRequest, friendRequests)} sent in the last ${FEW_ACCEPTS.days} days were accepted.`;
    case 'few_found':
      return `It found too few new people who fit to send today’s ${friendRequests}.`;
    case 'waiting_accepts':
      return facts.sent
        ? `First messages go to new ${friends}, and most of the ${count(facts.sent, friendRequest, friendRequests)} sent in the last ${FEW_ACCEPTS.days} days are still waiting for an answer.`
        : `First messages go to new ${friends}, and no ${friendRequests} went out in the last ${FEW_ACCEPTS.days} days.`;
  }
}

/** Today's note on a network that's short: how many, why, and that it's looking for more. Null while it isn't. */
export function goalNote(goal: TodayGoal, platform: Platform): string | null {
  if (!goal.short || !goal.why) return null;
  const lead = `${PLATFORMS[platform]} is ${goal.short.toLocaleString('en-US')} short of today’s ${count(goal.most, 'first message')}.`;
  const looking =
    goal.more && goal.why !== 'not_ready'
      ? ' It’s checking more people and searching again today on its own.'
      : '';
  return `${lead} ${goalWhyWords(goal.why, goal.facts, platform)}${looking}`;
}

/** A network short today, for the pushes and the day's report. */
export const GoalShort = z.object({
  platform: z.enum(PLATFORM_KEYS),
  short: n,
  most: n,
  why: z.enum(GOAL_WHYS),
  facts: GoalFacts,
});
export type GoalShort = z.output<typeof GoalShort>;

const names = (shorts: readonly GoalShort[]) => {
  const all = shorts.map((s) => PLATFORMS[s.platform]);
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0]!;
};

/**
 * The push at the start of the day and at midday (7a, 8a): messages waiting for an OK, and the networks that won't
 * reach today's first messages. Null when there's neither.
 */
export function goalPushWords(
  waitingOk: number,
  shorts: readonly GoalShort[],
): { title: string; body: string } | null {
  if (!waitingOk && !shorts.length) return null;
  const parts: string[] = [];
  if (waitingOk)
    parts.push(
      `${count(waitingOk, 'message')} ${waitingOk === 1 ? 'is' : 'are'} ready for your OK.`,
    );
  const [one] = shorts;
  if (shorts.length === 1 && one)
    parts.push(
      `${PLATFORMS[one.platform]} won’t reach today’s ${count(one.most, 'first message')}: ${lower(goalWhyWords(one.why, one.facts, one.platform))}`,
    );
  else if (shorts.length)
    parts.push(
      `${names(shorts)} won’t reach today’s first messages. Today says why, and what to try.`,
    );
  return { title: 'Today’s first messages', body: parts.join(' ') };
}

/** The day's report's line for the networks that fell short (7a): empty when none did. */
export function goalReportLine(shorts: readonly GoalShort[]): string {
  const [one] = shorts;
  if (!one) return '';
  if (shorts.length === 1)
    return ` ${PLATFORMS[one.platform]} fell ${one.short.toLocaleString('en-US')} short: ${lower(goalWhyWords(one.why, one.facts, one.platform))}`;
  return ` ${names(shorts)} fell short of today’s first messages. Today says why.`;
}

/** A reason carried on after a colon: its first letter small (none starts with a name). */
const lower = (s: string) => s[0]!.toLowerCase() + s.slice(1);

// ---- When the worker looks (7a, 8a) ----

const MINUTE = 60_000;
/** The first look, this long into the working hours: the list is made and the first drafts are in. */
export const GOAL_START_MINUTES = 30;
/** A look that runs this late (the worker was down) still goes; later, it waits for the next working day. */
export const GOAL_LATE_MS = 2 * 60 * MINUTE;

/** A working day's two looks on the business's clock: half an hour in, and the middle of the hours. */
export function goalTimes(
  day: string,
  hours: WorkingHours,
  timeZone: string,
): { start: number; midday: number } {
  const open = localInstant(day, `${String(hours.start).padStart(2, '0')}:00`, timeZone);
  const half = ((hours.end - hours.start) * 60 * MINUTE) / 2;
  return {
    start: open + Math.min(GOAL_START_MINUTES * MINUTE, half),
    midday: open + half,
  };
}

/** When the next first look goes: half an hour into the person's next working hours after `now`. */
export function nextGoalStart(hours: WorkingHours, timeZone: string, now: number): Date {
  const today = localDateOf(now, timeZone);
  for (let i = -1; i <= 7; i++) {
    const day = addDays(today, i);
    if (!hours.days.includes(weekdayOf(day))) continue;
    const at = goalTimes(day, hours, timeZone).start;
    if (at > now) return new Date(at);
  }
  return new Date(now + 7 * 24 * 60 * MINUTE);
}

/** The working day whose first look is due at `now`: it passed under `GOAL_LATE_MS` ago. Null otherwise. */
export function goalStartDue(hours: WorkingHours, timeZone: string, now: number): string | null {
  const today = localDateOf(now, timeZone);
  for (const day of [today, addDays(today, -1)]) {
    if (!hours.days.includes(weekdayOf(day))) continue;
    const { start } = goalTimes(day, hours, timeZone);
    if (now >= start && now < start + GOAL_LATE_MS) return day;
  }
  return null;
}
