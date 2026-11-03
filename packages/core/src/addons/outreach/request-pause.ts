/**
 * A network's own monthly limit on the person's requests (docs/outreach.md, decision 147). Alignable lets an account
 * send only so many connection requests a month, then puts up a box saying they've reached their monthly limit and
 * asking them to upgrade. When the extension sees it after Connect, new connection requests there wait till the 1st of
 * next month (the business's day), and so do the likes before them, as when too many wait for an answer (decision 97).
 * Likes, comments and messages go on. Start again, under Today's note, ends it sooner, after an upgrade.
 *
 * Never a warning (./tidy.ts): a limit the person's plan sets slows nothing else and stops nothing else.
 */
import { z } from 'zod';
import { addDays, formatLocalDate, localDateOf } from '../../calendar/engine/zoned';
import { NETWORKS, PLATFORM_KEYS, type Platform } from './networks';

const DAY = 86_400_000;

/**
 * Hit again within this many days of the last pause ending: a limit the network counts over the last 30 days, not by
 * the calendar month. Requests try again a week on, not a whole month on.
 */
export const PAUSE_AGAIN_DAYS = 7;

/**
 * The business day new requests start again: the 1st of next month, or a week on when the last pause ended less than a
 * week ago (`PAUSE_AGAIN_DAYS`), whichever is sooner.
 */
export function pauseEndsOn(now: number, timeZone: string, lastEnded: number | null): string {
  const today = localDateOf(now, timeZone);
  const [year, month] = today.split('-').map(Number) as [number, number];
  const first = formatLocalDate(year, month + 1, 1);
  if (lastEnded === null || now - lastEnded >= PAUSE_AGAIN_DAYS * DAY) return first;
  const week = addDays(today, PAUSE_AGAIN_DAYS);
  return week < first ? week : first;
}

/** Whether a network has requests a limit of its own can pause: never a follow network's (Instagram's). */
export const pausesRequests = (platform: Platform): boolean =>
  NETWORKS[platform].requestsMessageAfterDays === null;

export const RequestsPauseInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
  /** The network's own words, as the extension read them: kept for the person's note and the business's records. */
  words: z.array(z.string().trim().min(1).max(300)).min(1).max(3),
});
export type RequestsPauseInput = z.input<typeof RequestsPauseInput>;

export const RequestsPauseOutput = z.object({
  /** The business day new requests start again: "2026-12-01". */
  until: z.string(),
  /** Paused already: left as it was. */
  already: z.boolean(),
});
export type RequestsPauseOutput = z.output<typeof RequestsPauseOutput>;

export const RequestsAgainInput = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(PLATFORM_KEYS),
});
export type RequestsAgainInput = z.input<typeof RequestsAgainInput>;

export const RequestsAgainOutput = z.object({
  /** A pause was on, and isn't now. */
  ended: z.boolean(),
});
export type RequestsAgainOutput = z.output<typeof RequestsAgainOutput>;
