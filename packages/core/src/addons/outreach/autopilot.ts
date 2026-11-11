/**
 * Autopilot (docs/outreach.md, decision 151; Chris, 3 Nov 2026: "need a feature where the ai goes on full autopilot for
 * the social outreach tool all it does is ask if the people it plans to reach out to that day are ok", then "1a 2a 3a
 * 4a 5a 6a 7a"). A setting of its own beside Everything on its own, which sends without asking:
 *
 * - **What it turns on** (answer 1a): on every network the person works, messages, replies and posts go on their own,
 *   and the AI decides the requests they get (`AUTOPILOT_PICKS` in ./automation.ts). The few that wait for an OK of
 *   their own under any other choice (a partner's messages, birthday and new-job notes, another time after a no-show,
 *   Alignable forum answers) go on their own too, for people OK'd. A reply where someone needs the person still comes
 *   to them. Their own picks stay kept underneath, and come back when it's off.
 * - **Who's on the day's list** (2a): the people it plans to reach today who aren't OK'd yet: someone new at their
 *   first like, friend request, comment or message, and on the first days, the people it was talking to already. Once
 *   OK'd, the steps after go without asking again. Someone who reached the person first (a reply, their comment, their
 *   request) is answered without it (`AUTOPILOT_ANSWERS`).
 * - **When** (3a): ready an hour before the working hours start (`autopilotTimes`), with a push; nothing goes to
 *   anyone on it until they OK it; a reminder push in the middle of the hours while any wait; whoever they don't get to
 *   is on the next day's list.
 * - **Found later** (4a): anyone found after the day's list was made waits for the next day's, so it asks once a day.
 * - **Spares** (5a): a few past the day's limits (`autopilotSpares`), at the bottom, which go instead of anyone taken off.
 * - **Training wheels** (6a) stay: someone new still OKs each message until they've earned it.
 * - **Where** (7a): one switch, Settings → You, for every network; one list, on Needs you, grouped by network. The
 *   business allows it or not, like the other choices (`BusinessRules.autopilotAllowed`). The list is first there only
 *   while someone on it waits for the OK; otherwise it's one line at the bottom, opened with Show (`autopilotPlace`,
 *   `autopilotLine`, decision 160).
 *
 * Browser-safe: the web, the phone, the worker and the API read it.
 */
import { z } from 'zod';
import { addDays, localDateOf, localInstant, weekdayOf } from '../../calendar/engine/zoned';
import { workHours, type WorkingHours } from './automation';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from './networks';
import { TODAY_KIND_KEYS, TODAY_KINDS, TODAY_LIMIT, type TodayKind } from './today';

const MINUTE = 60_000;

/** Where someone on Autopilot's list stands: waiting for the OK, OK'd for good, or left out for the day. */
export const AUTOPILOT_STATES = ['waiting', 'ok', 'not_today'] as const;
export type AutopilotState = (typeof AUTOPILOT_STATES)[number];

/** What the person can answer about someone on the list: OK, Not today, or Put back (waiting again). */
export const AUTOPILOT_ANSWER_KEYS = ['ok', 'not_today', 'waiting'] as const;
export type AutopilotAnswer = (typeof AUTOPILOT_ANSWER_KEYS)[number];

/**
 * The steps that answer someone who reached the person first: a reply, a partner's reply, an answer to their comment,
 * confirming their request; and Recommend them, which only the person does by hand. These go without the day's OK.
 */
export const AUTOPILOT_ANSWERS = [
  'reply',
  'partner_reply',
  'warm_lead',
  'confirm',
  'recommend',
] as const satisfies readonly TodayKind[];

/** Whether a step waits for the person to OK whoever it's for, under Autopilot: every step but the answers. */
export const waitsForPeopleOk = (kind: string): boolean =>
  !(AUTOPILOT_ANSWERS as readonly string[]).includes(kind);

/**
 * The spares on a day's list for a daily limit (answer 5a): a fifth of it, at least 2, past the day's own. None for a
 * limit of none.
 */
export const autopilotSpares = (most: number): number =>
  most > 0 ? Math.max(2, Math.ceil(most / 5)) : 0;

/** The daily limit a step on the list counts against, for its spares: null for one with none. */
export const autopilotStepOf = (kind: TodayKind) => TODAY_LIMIT[kind];

/** The day's list is ready this long before the working hours start (answer 3a). */
export const AUTOPILOT_EARLY_MINUTES = 60;

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/**
 * A day's two moments on the business's clock: the list an hour before the hours start, and the reminder in the
 * middle of them. On every day the extension works (`workHours`): likes and requests go every day unless the person
 * turned that off (decision 139).
 */
export function autopilotTimes(
  day: string,
  hours: WorkingHours,
  timeZone: string,
): { list: number; reminder: number; end: number } {
  const open = localInstant(day, clock(hours.start), timeZone);
  const length = (hours.end - hours.start) * 60 * MINUTE;
  return {
    list: open - AUTOPILOT_EARLY_MINUTES * MINUTE,
    reminder: open + length / 2,
    end: open + length,
  };
}

/** When the next day's list is made after `now`: an hour before the next working hours. */
export function nextAutopilotList(hours: WorkingHours, timeZone: string, now: number): Date {
  const works = workHours(hours);
  const today = localDateOf(now, timeZone);
  for (let i = -1; i <= 8; i++) {
    const day = addDays(today, i);
    if (!works.days.includes(weekdayOf(day))) continue;
    const { list } = autopilotTimes(day, hours, timeZone);
    if (list > now) return new Date(list);
  }
  return new Date(now + 7 * 24 * 60 * MINUTE);
}

/**
 * The working day whose list is due at `now`: from an hour before its hours till they end, so a worker that ran late
 * still makes it. Null otherwise, and on a day it doesn't work.
 */
export function autopilotDayDue(hours: WorkingHours, timeZone: string, now: number): string | null {
  const works = workHours(hours);
  const today = localDateOf(now, timeZone);
  for (const day of [today, addDays(today, 1), addDays(today, -1)]) {
    if (!works.days.includes(weekdayOf(day))) continue;
    const { list, end } = autopilotTimes(day, hours, timeZone);
    if (now >= list && now < end) return day;
  }
  return null;
}

/** What Autopilot says, on the web and the phone, in its pushes and its refusals. */
export const AUTOPILOT_WORDS = {
  name: 'Autopilot',
  about:
    'Everything goes on its own, on every network you work: likes, friend requests, comments, messages, replies and posts, and the AI decides the requests you get. Each morning it asks you to OK the people it plans to reach, so you can catch anyone who should be Don’t pitch or Never contact first.',
  /** Under the switch, as it stands. */
  howItAsks:
    'Once you OK someone, the next steps with them go without asking again. A reply where someone needs you still comes to you: asking to stop, a refund, a complaint, or upset.',
  offPutsBack: 'Turning it off puts your own choices back.',
  wheels: 'While your training wheels are on, each message still waits for your OK too.',
  /** Beside a choice Autopilot makes while it's on. */
  picked: 'Autopilot picks this while it’s on. Turn it off under Settings → You to pick your own.',
  notAllowed:
    'Your business doesn’t allow Autopilot. Ask an owner of this business to allow it under Social Outreach → Settings → Team.',
  /** Team's choices people may pick. */
  allow: 'Autopilot',
  allowAbout: 'Everything on its own, with the people it reaches OK’d by each person once a day.',
  listTitle: 'People to OK for today',
  listAbout:
    'Autopilot reaches them once you OK the list. Tap a name to mark them Don’t pitch or Never contact first.',
  okAll: (n: number) => (n === 1 ? 'OK them' : `OK all ${n}`),
  okRest: (n: number) => (n === 1 ? 'OK the one left' : `OK everyone else (${n})`),
  ok: 'OK',
  notToday: 'Not today',
  putBack: 'Put back',
  notTodayLine: 'Not today. They’re on tomorrow’s list again.',
  okdLine: 'OK’d',
  spares: 'If you take anyone off, these go instead',
  okdCount: (n: number) => `${n} OK’d today`,
  /** The bottom line once everyone's answered (decision 160): "Today’s list: 12 OK’d, 2 not today". */
  answered: (ok: number, off: number) =>
    `Today’s list: ${[ok ? `${ok} OK’d` : null, off ? `${off} not today` : null].filter(Boolean).join(', ')}`,
  show: 'Show',
  hide: 'Hide',
  none: 'Nobody new to OK today. Anyone it finds later today waits for tomorrow’s list.',
  making: 'Making today’s list. It’s ready in a minute.',
  /** Before today's list is made: when it comes. */
  comes: (at: string) => `Today’s list comes at ${at}, an hour before your working hours.`,
  /** A message drafted for someone not OK'd yet waits (`needsYou`). */
  notOkd: 'they aren’t on a list you OK’d yet',
  push: (n: number) => ({
    title: `${n} ${n === 1 ? 'person' : 'people'} to OK for today`,
    body: 'Autopilot reaches them once you OK the list.',
  }),
  reminder: (n: number) => ({
    title: `${n} still ${n === 1 ? 'waits' : 'wait'} for your OK`,
    body: 'Nobody on today’s list is reached till you OK them.',
  }),
  /** What it plans for someone, in a few words: a step on Today. */
  plans: (kind: TodayKind, platform: Platform) => `${TODAY_KINDS[kind]} · ${PLATFORMS[platform]}`,
} as const;

/** Someone on the day's list, as the web and the phone show them. */
export const AutopilotPerson = z.object({
  profileId: z.uuid(),
  name: z.string(),
  url: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  /** What it plans for them first today, and why it picked them. */
  kind: z.enum(TODAY_KIND_KEYS),
  why: z.array(z.string()),
  /** One past the day's limits: goes only when someone's taken off (answer 5a). */
  spare: z.boolean(),
  state: z.enum(AUTOPILOT_STATES),
  /** The business's marks on them now, set from the person menu. */
  dontPitch: z.boolean(),
  neverContact: z.boolean(),
  personId: z.uuid().nullable(),
});
export type AutopilotPerson = z.output<typeof AutopilotPerson>;

export const AutopilotInput = z.object({ workspaceId: z.uuid() });
export type AutopilotInput = z.input<typeof AutopilotInput>;
export const AutopilotOutput = z.object({
  /** Autopilot is on for them now, and the business allows it. */
  on: z.boolean(),
  /** The business lets people turn it on. */
  allowed: z.boolean(),
  /** The business's day today: "2026-11-04", and its time zone, which `listAt` is shown on. */
  day: z.string(),
  timezone: z.string(),
  /** Today's list is made: when it isn't, `listAt` says when it comes, or it's being made now. */
  made: z.boolean(),
  /** When today's list comes, while it isn't made: null on a day off. */
  listAt: z.iso.datetime().nullable(),
  /** Everyone on today's list, the spares last: waiting, left out today, and OK'd today. */
  people: z.array(AutopilotPerson),
  /** How many wait for the OK, spares too. */
  waiting: z.number().int(),
});
export type AutopilotOutput = z.output<typeof AutopilotOutput>;

/** Where the day's list sits on Needs you (decision 160). */
export type AutopilotPlace = 'top' | 'bottom';

/**
 * Where the day's list sits on Needs you, on the web and the phone (decision 160; Chris, 11 Nov 2026: "after ok’ing the
 * people to contact in the social outreach it should go away instead of staying at the top", then "Shrink to a line at
 * the bottom"): first, whole, while someone on it waits for the OK; otherwise one line at the bottom (`autopilotLine`),
 * whose Show opens the list there, to put back someone left Not today. Nowhere while Autopilot is off.
 */
export const autopilotPlace = (
  list: { on: boolean; made: boolean; people: readonly { state: AutopilotState }[] } | null,
): AutopilotPlace | null =>
  !list?.on ? null : list.made && list.people.some((p) => p.state === 'waiting') ? 'top' : 'bottom';

/**
 * The bottom line's words (decision 160): when today's list comes, that it's being made, that nobody's new today, or
 * how it was answered. `at` shows a moment on the business's clock.
 */
export function autopilotLine(
  list: { made: boolean; listAt: string | null; people: readonly { state: AutopilotState }[] },
  at: (iso: string) => string,
): string {
  const A = AUTOPILOT_WORDS;
  if (!list.made) return list.listAt ? A.comes(at(list.listAt)) : A.making;
  if (!list.people.length) return A.none;
  const count = (state: AutopilotState) => list.people.filter((p) => p.state === state).length;
  return A.answered(count('ok'), count('not_today'));
}

export const AutopilotAnswerInput = z.object({
  workspaceId: z.uuid(),
  answer: z.enum(AUTOPILOT_ANSWER_KEYS),
  /** Who it's for: with OK and none named, everyone on today's list still waiting. */
  profileIds: z.array(z.uuid()).max(500).optional(),
});
export type AutopilotAnswerInput = z.input<typeof AutopilotAnswerInput>;
export const AutopilotAnswerOutput = z.object({
  /** How many it changed. */
  changed: z.number().int(),
  /** How many on today's list still wait. */
  waiting: z.number().int(),
});

export const AutopilotPlanInput = z.object({ workspaceId: z.uuid() });
export type AutopilotPlanInput = z.input<typeof AutopilotPlanInput>;
export const AutopilotPlanOutput = z.object({
  /** The business's day it's for; null while Autopilot is off. */
  day: z.string().nullable(),
  /** Made now: false when it was made already today, or Autopilot is off. */
  made: z.boolean(),
  /** How many wait for the OK on it. */
  waiting: z.number().int(),
});
