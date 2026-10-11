/**
 * The extension on its own (docs/outreach.md, decisions 26 to 36): what each person lets it do for them on Facebook
 * without pressing anything, and when. It works only in the build loaded by hand (decision 1), in Chrome on the
 * person's computer, while it's open.
 *
 * - **Sending** (decision 26): off, the person does everything (the default); (a) friend requests, likes and comments
 *   on their own, and each message the AI drafts waits for one tap; (c) the same, with the day's messages drafted
 *   first thing for **Approve all**; or (b) everything on its own, messages too. Messages go through `outreach.sends`
 *   (./sends.ts): the extension drafts each one, it waits for the person's OK or goes as it is, and the extension
 *   sends it in Messenger.
 * - **Replies** (decision 27): (a) every reply waits for the person (the default); (b) simple ones go on their own and
 *   the rest are handed to the person with a push; (c) every reply goes on its own. Even with (c), a reply that needs
 *   the person (a refund, a complaint, a legal threat, cancelling, someone upset or asking for them, an emergency, or
 *   one of the business's own hand-off topics) comes to them with a push, as the AI teammate's do (./sends.ts).
 * - **Training wheels** (proposed with the plan): choosing Sending (b), or Replies (b) or (c), starts them. For the first 7 days, and until the person
 *   has OK'd 25 messages, every message waits for them anyway, and their daily limits are half. More than 3 changed
 *   of the last 10 they OK'd keeps them on. An owner or admin can end them early; a warning from Facebook puts them
 *   back on for 7 days.
 * - **When** (decision 28): in the person's working hours (9 to 5, Monday to Friday, to start), in the business's time
 *   zone, at random times; and when they press **Start my day**.
 * - **Like a post first** (decision 33): someone is sent a friend request only a day or more after one of their posts
 *   was liked; a profile with no post to like goes without.
 * - **Confirm requests that fit** (decision 30): requests they got from people who fit a playbook well are confirmed.
 * - **Once a day** (decision 32): checking friend requests, saving group members, Find posts and Read my chats, at the
 *   start of the working day, while it works on its own; and checking friends and groups (decisions 46 and 48).
 * - **Join groups** (decision 48): when people left to reach in the groups run low, finding groups and asking to join
 *   up to 3 good ones a day, with the AI answering their questions.
 *
 * - **Where they're set** (decisions 37 to 40): in HandsFreeOS, on Social Outreach's Settings tab, on the web and the
 *   phone; never in the extension, which loads them when the person signs in and follows each change within seconds.
 *   They take in the extension's three switches (noting steps, reading chats as they're opened, looking for posts while
 *   scrolling) and how the phone hears what waits. Each person picks their own, inside the business's rules
 *   (`BusinessRules`): the choices it allows, its own daily limits under the starting ones, and the defaults a new
 *   person starts with. Owners and admins can change anyone's; the person sees who did.
 *
 * Every step keeps the daily limits, goes at a person's pace, and stops for the day on any Facebook warning.
 * Browser-safe: the extension, the web and the API read it.
 */
import { z } from 'zod';
import { localDateOf, localInstant, zonedParts } from '../../calendar/engine/zoned';
import { DAILY_LIMITS } from './limits';
import type { TodayKind } from './today';

export const SENDING_MODES = {
  off: 'You do everything',
  steps: 'Friend requests, likes and comments on their own; each message waits for one tap',
  approve_all: 'The same, with the day’s messages ready each morning to Approve all',
  everything: 'Everything on its own, messages too',
} as const;
export type SendingMode = keyof typeof SENDING_MODES;
export const SENDING_MODE_KEYS = Object.keys(SENDING_MODES) as [SendingMode, ...SendingMode[]];

/** Replies (decision 27): kept as `draft`, `simple` and `everything`. */
export const REPLY_MODES = {
  draft: 'Every reply waits for you',
  simple: 'Simple replies go on their own; the rest come to you with a push',
  everything: 'Every reply goes on its own, except ones that need you',
} as const;
export type ReplyMode = keyof typeof REPLY_MODES;
export const REPLY_MODE_KEYS = Object.keys(REPLY_MODES) as [ReplyMode, ...ReplyMode[]];

/**
 * How the phone, and the extension's pop-ups, tell of messages and steps waiting for the person (decision 15): a reply
 * handed over always pushes at once.
 */
export const PUSH_MODES = {
  bundled: 'One push for what’s waiting, at most every 2 hours in your working hours',
  each: 'A push for each message or step that waits',
} as const;
export type PushMode = keyof typeof PUSH_MODES;
export const PUSH_MODE_KEYS = Object.keys(PUSH_MODES) as [PushMode, ...PushMode[]];

/** 0 is Sunday. */
export const WEEKDAY_WORDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const WorkingHours = z
  .object({
    /** The hour it starts, and the hour it stops, on the business's clock. */
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(1).max(24),
    /** The days it works, 0 being Sunday; kept each once, in order (`dayList`). */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, { error: 'Pick at least one day.' })
      .max(7),
  })
  .refine((h) => h.end - h.start >= 1, {
    error: 'Make the working hours at least an hour long, ending after they start.',
    path: ['end'],
  });
export type WorkingHours = z.output<typeof WorkingHours>;

export const AutomationSettings = z.object({
  sending: z.enum(SENDING_MODE_KEYS),
  /** Replies (decision 27): every one waits until a person picks otherwise, and from builds before 0.15. */
  replies: z.enum(REPLY_MODE_KEYS).default('draft'),
  warmUp: z.boolean(),
  confirmRequests: z.boolean(),
  /** The once-a-day jobs (decision 32): they fill the list it works from. On when left out, as 0.11 of the extension does. */
  collect: z.boolean().default(true),
  /**
   * When people left to reach in the groups run low, it finds groups and asks to join up to 3 good ones a day (decision
   * 48), with the once-a-day jobs. On when left out.
   */
  joinGroups: z.boolean().default(true),
  /**
   * In the working hours, it looks at the newest posts in the best groups every hour or two, so one asking for what
   * the business offers is answered fast (decision 49). On when left out.
   */
  watchPosts: z.boolean().default(true),
  hours: WorkingHours,
  /** The extension notes the person's own steps on Facebook (decision 8). */
  noting: z.boolean().default(true),
  /** It sends a chat the person opens in Messenger for the AI to read. */
  readChats: z.boolean().default(true),
  /** It looks for posts worth a comment as the person scrolls a group. */
  markPosts: z.boolean().default(true),
  /** How the phone hears about messages waiting for their OK. */
  pushes: z.enum(PUSH_MODE_KEYS).default('bundled'),
});
export type AutomationSettings = z.output<typeof AutomationSettings>;

export const AUTOMATION_DEFAULTS: AutomationSettings = {
  sending: 'off',
  replies: 'draft',
  warmUp: true,
  confirmRequests: true,
  collect: true,
  joinGroups: true,
  watchPosts: true,
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
  noting: true,
  readChats: true,
  markPosts: true,
  pushes: 'bundled',
};

/** The daily limits a business can set, each at most the starting one (./limits.ts). */
export const BusinessLimits = z
  .object({
    friend_request: z.number().int().min(0).max(DAILY_LIMITS.friend_request),
    first_message: z.number().int().min(0).max(DAILY_LIMITS.first_message),
    follow_up: z.number().int().min(0).max(DAILY_LIMITS.follow_up),
    comment: z.number().int().min(0).max(DAILY_LIMITS.comment),
    like: z.number().int().min(0).max(DAILY_LIMITS.like),
  })
  .partial();
export type BusinessLimits = z.output<typeof BusinessLimits>;

/**
 * What owners and admins set for everyone (decision 38): the Sending and Replies choices people may pick (doing
 * everything themselves, and every reply waiting, are always allowed), daily limits under the starting ones, and the
 * choices a new person starts with. Kept with the business's Social Outreach settings.
 */
export const BusinessRules = z.object({
  sendingAllowed: z
    .array(z.enum(SENDING_MODE_KEYS))
    .default([...SENDING_MODE_KEYS])
    .transform((modes) => SENDING_MODE_KEYS.filter((m) => m === 'off' || modes.includes(m))),
  repliesAllowed: z
    .array(z.enum(REPLY_MODE_KEYS))
    .default([...REPLY_MODE_KEYS])
    .transform((modes) => REPLY_MODE_KEYS.filter((m) => m === 'draft' || modes.includes(m))),
  dailyLimits: BusinessLimits.default({}),
  defaults: AutomationSettings.default(AUTOMATION_DEFAULTS),
});
export type BusinessRules = z.output<typeof BusinessRules>;
export const NO_RULES: BusinessRules = BusinessRules.parse({});

/** The nearest choice the business allows, at or before this one: a choice it stopped allowing steps back. */
function allowedOf<T extends string>(order: readonly T[], allowed: readonly T[], want: T): T {
  for (let i = order.indexOf(want); i > 0; i--) if (allowed.includes(order[i]!)) return order[i]!;
  return order[0]!;
}

/** A person's choices as they stand inside the business's rules. */
export function withinRules(
  settings: AutomationSettings,
  rules: BusinessRules,
): AutomationSettings {
  return {
    ...settings,
    sending: allowedOf(SENDING_MODE_KEYS, rules.sendingAllowed, settings.sending),
    replies: allowedOf(REPLY_MODE_KEYS, rules.repliesAllowed, settings.replies),
  };
}

/** What the business doesn't allow of these choices, in words to refuse them with; null when it's all allowed. */
export function notAllowedWords(settings: AutomationSettings, rules: BusinessRules): string | null {
  const off = [
    rules.sendingAllowed.includes(settings.sending) ? null : `“${SENDING_MODES[settings.sending]}”`,
    rules.repliesAllowed.includes(settings.replies) ? null : `“${REPLY_MODES[settings.replies]}”`,
  ].filter(Boolean);
  return off.length
    ? `Your business doesn’t allow ${off.join(' or ')}. Pick another, or ask an owner of this business to allow it under Social Outreach → Settings → Business settings.`
    : null;
}

/**
 * The kinds on the list for today the extension does on its own for someone, in the order it does them: requests
 * to confirm first, then likes, friend requests and comments. Messages go their own way (`MESSAGE_KINDS`).
 */
export function autoKinds(settings: AutomationSettings): TodayKind[] {
  if (settings.sending === 'off') return [];
  return [
    ...(settings.confirmRequests ? (['confirm'] as const) : []),
    ...(settings.warmUp ? (['warm_up'] as const) : []),
    'friend_request',
    'comment',
  ];
}

/** The kinds on the list that are messages: the extension drafts each, and sends it once it's OK'd (./sends.ts). */
export const MESSAGE_KINDS = [
  'opener',
  'reconnect',
  'pitch',
  'follow_up',
  'reply',
] as const satisfies readonly TodayKind[];
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The messages the extension drafts for the person: none while it's off. */
export const messageKinds = (settings: AutomationSettings): MessageKind[] =>
  settings.sending === 'off' ? [] : [...MESSAGE_KINDS];

/** What choosing Sending (b), or Replies (b) or (c), means, said where it's chosen. */
export const WHEELS_START_WORDS =
  'Choosing this starts training wheels: for your first 7 days, and until you’ve OK’d 25 messages, each message waits for your OK and your daily limits are half.';

/** Training wheels: how long, how many OK'd, and how many changed of the last ones keep them on. */
export const WHEELS = { days: 7, ok: 25, last: 10, edits: 3 } as const;

/** Where a person's training wheels stand, as kept. */
export interface WheelsKept {
  readonly from: Date | string | null;
  readonly ok: number;
  readonly edits: readonly boolean[];
  readonly doneAt: Date | string | null;
}

/** Whether they've done enough to come off: 7 days, 25 OK'd, and few enough changed of the last 10. */
export function wheelsEarned(kept: WheelsKept, now: number): boolean {
  if (kept.from === null) return false;
  const days = (now - new Date(kept.from).getTime()) / 86_400_000;
  return (
    days >= WHEELS.days &&
    kept.ok >= WHEELS.ok &&
    kept.edits.slice(-WHEELS.last).filter(Boolean).length <= WHEELS.edits
  );
}

/** Whether training wheels are on: started, not ended, and not earned yet. */
export const wheelsOn = (kept: WheelsKept, now: number) =>
  kept.from !== null && kept.doneAt === null && !wheelsEarned(kept, now);

/**
 * The choices training wheels are for: messages on their own (Sending (b)), or replies on their own (Replies (b) or
 * (c)) while the extension writes messages at all. They start when one is chosen.
 */
export const wheelsMatter = (settings: Pick<AutomationSettings, 'sending' | 'replies'>) =>
  settings.sending === 'everything' || (settings.sending !== 'off' && settings.replies !== 'draft');

/** Training wheels as kept before anyone chose (b): not started. */
export const NO_WHEELS: WheelsKept = { from: null, ok: 0, edits: [], doneAt: null };

export const WheelsState = z.object({
  /** Every message waits for the person, and their daily limits are half: only while messages or replies go on their own. */
  on: z.boolean(),
  /** Since when; null when they never started. */
  from: z.iso.datetime().nullable(),
  /** Messages OK'd so far, of the 25. */
  ok: z.number().int().min(0),
  /** Days left of the 7: 0 once they're past. */
  daysLeft: z.number().int().min(0),
  /** Of the last 10 OK'd, how many were changed first. */
  edits: z.number().int().min(0),
});
export type WheelsState = z.output<typeof WheelsState>;

export function wheelsState(kept: WheelsKept, now: number, matter = true): WheelsState {
  const from = kept.from === null ? null : new Date(kept.from);
  return {
    on: matter && wheelsOn(kept, now),
    from: from?.toISOString() ?? null,
    ok: kept.ok,
    daysLeft: from
      ? Math.max(0, Math.ceil(WHEELS.days - (now - from.getTime()) / 86_400_000))
      : WHEELS.days,
    edits: kept.edits.slice(-WHEELS.last).filter(Boolean).length,
  };
}

/** Where training wheels stand, in words for the person. */
export function wheelsWords(state: WheelsState): string {
  const left = [
    state.ok < WHEELS.ok ? `${WHEELS.ok - state.ok} more messages to OK` : null,
    state.daysLeft ? `${state.daysLeft} ${state.daysLeft === 1 ? 'day' : 'days'} to go` : null,
    state.edits > WHEELS.edits
      ? `fewer changes: you changed ${state.edits} of the last ${WHEELS.last}`
      : null,
  ].filter(Boolean);
  return `Training wheels: every message waits for your OK, and your daily limits are half${left.length ? `. Still: ${left.join(', ')}` : ''}.`;
}

export const AutomationInput = z.object({
  workspaceId: z.uuid(),
  /** Someone else's, for an owner or admin; the person's own when left out. */
  userId: z.uuid().optional(),
});
export type AutomationInput = z.input<typeof AutomationInput>;

export const AutomationOutput = z.object({
  settings: AutomationSettings,
  /** The business's time zone, which the working hours are on. */
  timezone: z.string(),
  /** Whether the person has saved their own yet: until then, these are the defaults. */
  saved: z.boolean(),
  /** Their training wheels. */
  wheels: WheelsState,
  /** Whose they are. */
  userId: z.uuid(),
  name: z.string(),
  /** An owner or admin who changed them last, when it wasn't the person. */
  changedBy: z.string().nullable(),
  /** What the business allows (decision 38). */
  rules: z.object({
    sendingAllowed: z.array(z.enum(SENDING_MODE_KEYS)),
    repliesAllowed: z.array(z.enum(REPLY_MODE_KEYS)),
    dailyLimits: BusinessLimits,
  }),
});
export type AutomationOutput = z.output<typeof AutomationOutput>;

export const AutomationSaveInput = z.object({
  workspaceId: z.uuid(),
  /** Someone else's, for an owner or admin; the person's own when left out. */
  userId: z.uuid().optional(),
  settings: AutomationSettings,
});
export type AutomationSaveInput = z.input<typeof AutomationSaveInput>;

export const AutomationSaveOutput = AutomationOutput;

/** An owner or admin ends someone's training wheels early. */
export const WheelsEndInput = z.object({ workspaceId: z.uuid(), userId: z.uuid() });
export type WheelsEndInput = z.input<typeof WheelsEndInput>;
export const WheelsEndOutput = z.object({ userId: z.uuid(), ended: z.boolean() });

export const WheelsListInput = z.object({ workspaceId: z.uuid() });
export type WheelsListInput = z.input<typeof WheelsListInput>;
/** Everyone in the business on training wheels now, for owners and admins. */
export const WheelsListOutput = z.object({
  people: z.array(z.object({ userId: z.uuid(), name: z.string(), wheels: WheelsState })),
});
export type WheelsListOutput = z.output<typeof WheelsListOutput>;

/** Everyone who can use Social Outreach here, with their choices, for owners and admins (decision 39). */
export const AutomationPeopleInput = z.object({ workspaceId: z.uuid() });
export type AutomationPeopleInput = z.input<typeof AutomationPeopleInput>;
export const AutomationPeopleOutput = z.object({
  people: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      /** Whether they've saved their own; until then the business's defaults stand. */
      saved: z.boolean(),
      sending: z.enum(SENDING_MODE_KEYS),
      replies: z.enum(REPLY_MODE_KEYS),
      wheels: z.boolean(),
    }),
  ),
});
export type AutomationPeopleOutput = z.output<typeof AutomationPeopleOutput>;

/** A profile with no post to like (decision 33): its friend request goes without the warm-up. */
export const WarmUpMissedInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
});
export type WarmUpMissedInput = z.input<typeof WarmUpMissedInput>;
export const WarmUpMissedOutput = z.object({ profileId: z.uuid() });

/**
 * The warm-up's timing: a friend request goes at least this long after the like, so a day or two later (decision 33),
 * and a like older than the window doesn't count.
 */
export const WARM_UP_WAIT_HOURS = 20;
export const WARM_UP_WINDOW_DAYS = 14;

/** The days each once, Sunday first. */
export const dayList = (days: readonly number[]) => [...new Set(days)].sort((a, b) => a - b);

const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

/** Today's working window in the business's time zone, as instants: null on a day off. */
export function workWindow(
  hours: WorkingHours,
  timeZone: string,
  now: number,
): { readonly from: number; readonly to: number } | null {
  const { weekday } = zonedParts(now, timeZone);
  if (!hours.days.includes(weekday)) return null;
  const date = localDateOf(now, timeZone);
  return {
    from: localInstant(date, clock(hours.start), timeZone),
    to: localInstant(date, clock(hours.end), timeZone),
  };
}

/** The business's day at a moment: "2026-10-09". */
export function businessDay(now: number, timeZone: string): string {
  return localDateOf(now, timeZone);
}

/** Whether it's working hours now. */
export function inWorkingHours(hours: WorkingHours, timeZone: string, now: number): boolean {
  const w = workWindow(hours, timeZone, now);
  return w !== null && now >= w.from && now < w.to;
}

/** An hour on the clock: "9 AM", "noon", "midnight". */
export function hourWords(hour: number): string {
  if (hour === 0 || hour === 24) return 'midnight';
  if (hour === 12) return 'noon';
  return `${hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "9 AM to 5 PM, Mon to Fri". */
export function hoursWords(hours: WorkingHours): string {
  const at = hourWords;
  const days = hours.days;
  const run = days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const dayWords =
    days.length === 7
      ? 'every day'
      : run && days.length > 2
        ? `${WEEKDAY_WORDS[days[0]!]} to ${WEEKDAY_WORDS[days[days.length - 1]!]}`
        : days.map((d) => WEEKDAY_WORDS[d]).join(', ');
  return `${at(hours.start)} to ${at(hours.end)}, ${dayWords}`;
}

/** The short words for each choice, for a one-line summary (decision 39: the extension shows it, read-only). */
const SENDING_SHORT: Record<SendingMode, string> = {
  off: 'Off: you do everything',
  steps: 'Requests, likes and comments on their own; each message waits for you',
  approve_all: 'Requests, likes and comments on their own; messages ready to Approve all',
  everything: 'Everything on its own',
};
const REPLIES_SHORT: Record<ReplyMode, string> = {
  draft: 'every one waits for you',
  simple: 'simple ones on their own',
  everything: 'on their own, except ones that need you',
};

/** "On its own: … · Replies: … · 9 AM to 5 PM, Mon to Fri", one line per part. */
export function settingsSummary(settings: AutomationSettings): string[] {
  const lines = [`On its own: ${SENDING_SHORT[settings.sending]}`];
  if (settings.sending !== 'off') {
    lines.push(`Replies: ${REPLIES_SHORT[settings.replies]}`);
    lines.push(`When: ${hoursWords(settings.hours)}`);
  }
  const off = [
    !settings.noting && 'noting your steps',
    !settings.readChats && 'reading chats you open',
    !settings.markPosts && 'looking for posts as you scroll',
  ].filter((word): word is string => Boolean(word));
  if (off.length) lines.push(`Off: ${off.join(', ')}`);
  return lines;
}
