/**
 * Arming follow-ups (plan M7, "Other work"; Automations' "Follow-ups after silence"). When the teammate's message
 * asks the customer something and they go quiet, follow-ups go on the business's ladder, counted from that message:
 * by default 4 hours, then days 1, 2, 4, 7, 10, 14, 21 and 30, then once a month for 6 months (core's
 * followUpDueAt). Each one it sends arms the next, whatever it says; only the first unanswered message has to ask.
 * A text due in quiet hours waits for them to end, unless it's set for QUIET_FOLLOW_UP_MINUTES or less (the
 * conversation is still live), and then goes at a random time early on (spreadAfter).
 * A reply, a booking, a hand-off, a take-over, a closed lead or STOP stops them: the follow-up job checks before
 * each one (follow-up.ts).
 *
 * Two of Automations' rows ride on the same ladder:
 * - "Follow-ups when a lead never replied" (followUp.neverReplied): the customer has never written in this
 *   conversation, so the teammate's first message is the one they didn't answer;
 * - "Chase an offered time" (followUp.chaseTimes): the unanswered message offered times, so the first follow-up
 *   comes sooner (before those times go) and says which are still open.
 */
import {
  followUpDueAt,
  followUpScheduleMinutes,
  QUIET_FOLLOW_UP_MINUTES,
  QUIET_FOLLOW_UP_SPREAD_MINUTES,
  QUIET_FOLLOW_UP_WINDOW_MS,
  type TeammateConfig,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { scheduleDebouncedJob } from '../jobs';
import type { TenantScope } from '../services';
import { followUpJobKey, QUIET_GRACE_MS, TEAMMATE_JOBS } from './constants';

const HOUR = 3_600_000;
/** A chase goes this long before the earliest time it offered, at the latest... */
export const CHASE_BEFORE_MS = 3 * HOUR;
/** ...and never sooner than this after the offer. */
export const CHASE_AFTER_MS = HOUR;

/** A message that asks them something. */
export const asksSomething = (body: string): boolean => body.includes('?');

/** A time the teammate offered, as the follow-up job carries it. */
export interface OfferedSlot {
  readonly calendarId: string;
  /** UTC ISO. */
  readonly startsAt: string;
  readonly label: string;
  readonly serviceId: string | null;
  readonly durationMinutes: number | null;
}

/** The offered times a job payload carries (anything else is dropped). */
export function offeredOf(v: unknown): OfferedSlot[] {
  if (!Array.isArray(v)) return [];
  const out: OfferedSlot[] = [];
  for (const x of v.slice(0, 12)) {
    if (typeof x !== 'object' || x === null) continue;
    const o = x as Record<string, unknown>;
    if (typeof o['calendarId'] !== 'string' || typeof o['startsAt'] !== 'string') continue;
    if (!Number.isFinite(Date.parse(o['startsAt']))) continue;
    out.push({
      calendarId: o['calendarId'],
      startsAt: o['startsAt'],
      label: typeof o['label'] === 'string' ? o['label'].slice(0, 80) : '',
      serviceId: typeof o['serviceId'] === 'string' ? o['serviceId'] : null,
      durationMinutes: typeof o['durationMinutes'] === 'number' ? o['durationMinutes'] : null,
    });
  }
  return out;
}

/**
 * The times a message actually offered: of those find_times showed, the ones whose clock ("2:00 PM") the message
 * names. find_times shows up to a dozen and the teammate offers two or three; when none can be matched, all of
 * them count.
 */
export function offeredIn(body: string, shown: readonly OfferedSlot[]): OfferedSlot[] {
  const text = body.toLowerCase().replace(/\s+/g, ' ');
  const clockOf = (label: string) => /\d{1,2}(:\d{2})?\s?(am|pm)/i.exec(label)?.[0]?.toLowerCase();
  const named = shown.filter((s) => {
    const clock = clockOf(s.label);
    return !!clock && (text.includes(clock) || text.includes(clock.replace(':00', '')));
  });
  return named.length ? named : [...shown];
}

/** Where the conversation stands: the message they haven't answered, and whether they ever wrote. */
export interface Unanswered {
  /** The teammate's first message since the customer last wrote. */
  readonly anchorAt: number;
  readonly anchorBody: string;
  /** Follow-ups sent since (the teammate's later messages). */
  readonly sent: number;
  /** They have never written in this conversation: it was the teammate's first message they didn't answer. */
  readonly neverWrote: boolean;
}

/**
 * The teammate's messages since the customer last wrote. (Its hand-off lines don't count: the conversation is a
 * person's by then.)
 */
export async function unansweredOf(tx: Tx, conversationId: string): Promise<Unanswered | null> {
  const list = await rows<{ body_text: string | null; occurred_at: Date | string; wrote: boolean }>(
    tx,
    sql`with last_in as (
          select max(i.occurred_at) as at from app.messages i
          where i.conversation_id = ${conversationId} and i.direction = 'inbound')
        select m.body_text, m.occurred_at, (select at from last_in) is not null as wrote
        from app.messages m
        where m.conversation_id = ${conversationId} and m.direction = 'outbound'
          and m.sent_by_teammate_id is not null and coalesce(m.client_id, '') not like 'handoff:%'
          and m.occurred_at > coalesce((select at from last_in), '-infinity'::timestamptz)
        order by m.occurred_at, m.created_at`,
  );
  const first = list[0];
  if (!first) return null;
  return {
    anchorAt: new Date(first.occurred_at).getTime(),
    anchorBody: first.body_text ?? '',
    sent: list.length - 1,
    neverWrote: !first.wrote,
  };
}

/** Whether follow-ups apply to this conversation now, by the teammate's switches. */
export function followsUp(config: TeammateConfig, u: Unanswered): boolean {
  if (!config.followUp.enabled || !asksSomething(u.anchorBody)) return false;
  return !u.neverWrote || config.followUp.neverReplied;
}

/**
 * When the next follow-up goes: its step on the ladder, or, for the first after a message that offered times,
 * sooner (before the earliest of them), when "Chase an offered time" is on. Null when the ladder is used up.
 */
export function nextFollowUpAt(
  config: TeammateConfig,
  u: Unanswered,
  offered: readonly OfferedSlot[],
  now: number,
): number | null {
  const due = followUpDueAt(config.followUp, u.anchorAt, u.sent + 1);
  if (due === null) return null;
  if (u.sent > 0 || !offered.length || !config.followUp.chaseTimes) return due;
  const earliest = Math.min(...offered.map((o) => Date.parse(o.startsAt)));
  return Math.max(u.anchorAt + CHASE_AFTER_MS, now, Math.min(due, earliest - CHASE_BEFORE_MS));
}

/**
 * Whether the next follow-up may still go in quiet hours: its step is QUIET_FOLLOW_UP_MINUTES or less after the
 * message they didn't answer, and it isn't running so late that message.send would refuse it.
 */
export function goesInQuietHours(config: TeammateConfig, u: Unanswered, now: number): boolean {
  const minutes = followUpScheduleMinutes(config.followUp)[u.sent];
  return (
    minutes !== undefined &&
    minutes <= QUIET_FOLLOW_UP_MINUTES &&
    now - u.anchorAt <= QUIET_FOLLOW_UP_WINDOW_MS
  );
}

/**
 * When a follow-up that had to wait goes: at a random time early on, within QUIET_FOLLOW_UP_SPREAD_MINUTES of
 * `opensAt` (quiet hours ending, or the teammate starting work), so a night's worth don't all land at once.
 */
export function spreadAfter(opensAt: number, random: () => number = Math.random): number {
  const spread = QUIET_FOLLOW_UP_SPREAD_MINUTES * 60_000 - QUIET_GRACE_MS;
  return opensAt + QUIET_GRACE_MS + Math.floor(random() * spread);
}

/**
 * After the teammate's message went out (or an approved draft of it): the next follow-up waits, if one applies.
 * `shown` is what find_times showed in that run, so a message that offered times can be chased.
 */
export async function scheduleFollowUp(
  tx: Tx,
  scope: TenantScope,
  conversationId: string,
  config: TeammateConfig,
  body: string,
  now: number = Date.now(),
  shown: readonly OfferedSlot[] = [],
): Promise<void> {
  const u = await unansweredOf(tx, conversationId);
  if (!u || !followsUp(config, u)) return;
  // Only the message they didn't answer can offer the times a chase is about.
  const offered = u.sent === 0 && shown.length ? offeredIn(body, shown) : [];
  const at = nextFollowUpAt(config, u, offered, now);
  if (at === null) return;
  await scheduleDebouncedJob(tx, {
    kind: TEAMMATE_JOBS.followUp,
    dedupeKey: followUpJobKey(conversationId),
    runAt: new Date(at),
    // Always carries `offered`, so a later message that offered nothing clears an earlier one's times.
    payload: { conversationId, offered },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    mergePayload: true,
  });
}
