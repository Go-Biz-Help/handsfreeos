/**
 * When a funnel's messages are due, and what's next for someone. Browser-safe: the worker schedules with it, a
 * person's funnel line says "Next: … at 6:00 PM" with it, and trying it as a lead plays out with it.
 */
import { addDays, localDateOf, localInstant } from '../calendar/engine/zoned';
import { funnelGoodFor, type FunnelMessage, type FunnelStage } from './definition';

export interface FunnelClock {
  /** When they reached the stage (ms). */
  readonly reachedAt: number;
  /** The booking the stage is timed around, when there is one. */
  readonly booking: { readonly startsAt: number } | null;
  /** The business's time zone. */
  readonly timeZone: string;
}

/**
 * When the message is due, in ms, or null when it's timed around a booking they don't have. A message counted
 * from a booking that's due before they reached the stage (booked at the last minute) goes as they arrive, while
 * it's still within its good-until (`funnelMessageStale` counts from this time, not from their arriving).
 */
export function funnelMessageDueAt(m: FunnelMessage, c: FunnelClock): number | null {
  switch (m.when.kind) {
    case 'arrive':
      return c.reachedAt + m.when.minutes * 60_000;
    case 'booking':
      return c.booking ? c.booking.startsAt + m.when.minutes * 60_000 : null;
    case 'booking_day': {
      if (!c.booking) return null;
      const day = addDays(localDateOf(c.booking.startsAt, c.timeZone), -m.when.daysBefore);
      return localInstant(day, m.when.at, c.timeZone);
    }
  }
}

/** Past its good-until: it's too late to send. */
export function funnelMessageStale(m: FunnelMessage, dueAt: number, now: number): boolean {
  return now > dueAt + funnelGoodFor(m) * 60_000;
}

export interface FunnelNext {
  readonly message: FunnelMessage;
  readonly dueAt: number;
}

/**
 * The stage's messages still to come for someone, soonest first: not sent, not past their good-until, and not
 * ruled out by an "only if" that's already settled (one that needs them to have done something they've done, or
 * not done it when they have).
 */
export function funnelUpcoming(
  stage: FunnelStage,
  c: FunnelClock & {
    readonly sent: readonly string[];
    readonly seen: readonly string[];
    readonly now: number;
  },
): FunnelNext[] {
  const out: FunnelNext[] = [];
  for (const m of stage.messages) {
    if (c.sent.includes(m.id)) continue;
    const dueAt = funnelMessageDueAt(m, c);
    if (dueAt === null) continue;
    // "The day before" isn't sent to someone who booked an hour ahead.
    if (funnelMessageStale(m, dueAt, Math.max(c.now, c.reachedAt))) continue;
    // "Only if they haven't joined" is off once they have; "only if they have" waits to see.
    if (m.onlyIf && !m.onlyIf.has && c.seen.includes(m.onlyIf.event)) continue;
    out.push({ message: m, dueAt: Math.max(dueAt, c.reachedAt) });
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

/** Whether a message's "only if" holds now. */
export function funnelOnlyIfHolds(m: FunnelMessage, seen: readonly string[]): boolean {
  if (!m.onlyIf) return true;
  return seen.includes(m.onlyIf.event) === m.onlyIf.has;
}
