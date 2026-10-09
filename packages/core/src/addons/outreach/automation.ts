/**
 * The extension on its own (docs/outreach.md, decisions 26 to 36): what each person lets it do for them on Facebook
 * without pressing anything, and when. It works only in the build loaded by hand (decision 1), in Chrome on the
 * person's computer, while it's open.
 *
 * - **Sending** (decision 26): off, the person does everything (the default); or friend requests, likes and comments
 *   on their own, while messages wait for the person. The fully automatic choices come with messages on their own.
 * - **When** (decision 28): in the person's working hours (9 to 5, Monday to Friday, to start), in the business's time
 *   zone, at random times; and when they press **Start my day**.
 * - **Like a post first** (decision 33): someone is sent a friend request only a day or more after one of their posts
 *   was liked; a profile with no post to like goes without.
 * - **Confirm requests that fit** (decision 30): requests they got from people who fit a playbook well are confirmed.
 * - **Once a day** (decision 32): checking friend requests, saving group members, Find posts and Read my chats, at the
 *   start of the working day, while it works on its own.
 *
 * Every step keeps the daily limits, goes at a person's pace, and stops for the day on any Facebook warning.
 * Browser-safe: the extension, the web and the API read it.
 */
import { z } from 'zod';
import { localDateOf, localInstant, zonedParts } from '../../calendar/engine/zoned';
import type { TodayKind } from './today';

export const SENDING_MODES = {
  off: 'You do everything',
  steps: 'Friend requests, likes and comments on their own',
} as const;
export type SendingMode = keyof typeof SENDING_MODES;
export const SENDING_MODE_KEYS = Object.keys(SENDING_MODES) as [SendingMode, ...SendingMode[]];

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
  warmUp: z.boolean(),
  confirmRequests: z.boolean(),
  /** The once-a-day jobs (decision 32): they fill the list it works from. On when left out, as 0.11 of the extension does. */
  collect: z.boolean().default(true),
  hours: WorkingHours,
});
export type AutomationSettings = z.output<typeof AutomationSettings>;

export const AUTOMATION_DEFAULTS: AutomationSettings = {
  sending: 'off',
  warmUp: true,
  confirmRequests: true,
  collect: true,
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
};

/**
 * The kinds on the list for today the extension does on its own for someone, in the order it does them: requests
 * to confirm first, then likes, friend requests and comments. Messages wait for the person.
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

export const AutomationInput = z.object({ workspaceId: z.uuid() });
export type AutomationInput = z.input<typeof AutomationInput>;

export const AutomationOutput = z.object({
  settings: AutomationSettings,
  /** The business's time zone, which the working hours are on. */
  timezone: z.string(),
  /** Whether the person has saved their own yet: until then, these are the defaults. */
  saved: z.boolean(),
});
export type AutomationOutput = z.output<typeof AutomationOutput>;

export const AutomationSaveInput = z.object({
  workspaceId: z.uuid(),
  settings: AutomationSettings,
});
export type AutomationSaveInput = z.input<typeof AutomationSaveInput>;

export const AutomationSaveOutput = AutomationOutput;

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
