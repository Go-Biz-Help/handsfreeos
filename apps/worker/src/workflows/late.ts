/**
 * Events that reached HandsFreeOS late (M10). A change made on a phone with no signal is recorded when the phone
 * reconnects, with the moment it really happened (`events.occurred_at`). A run started by one keeps how far behind it
 * is (`_late` in its context), and:
 * - waits count from when it happened ("wait 1 day" after a lead made at 9:00 wakes at 9:00 the next day);
 * - a step that would contact the customer while the run is more than LATE_EVENT_MS behind doesn't send, and the run
 *   says why in plain words: "thanks for calling just now" three hours later says the wrong thing.
 * A wait that wakes on time catches the run up, and so does a person's decision (an approval). An event a waiting run
 * wakes for can be late too. Nothing the worker does late on its own (a busy queue, a restart) counts: only an event
 * that arrived after it happened makes a run late.
 */
import { waitInWords } from '@hfos/core/server';
import type { EventRow } from '../handlers/types';
import { LATE_EVENT_MS, LATE_NOTED_MS } from './constants';
import type { ExecCtx, Json, Outcome } from './types';

export interface Late {
  /** How far behind the run is. */
  readonly ms: number;
  /** When what started it really happened, and when it reached HandsFreeOS. */
  readonly happenedAt: string;
  readonly arrivedAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** How late an event reached HandsFreeOS, or null when it came in as it happened. */
export function lateOfEvent(e: Pick<EventRow, 'createdAt' | 'occurredAt'>): Late | null {
  if (!e.occurredAt) return null;
  const ms = e.createdAt.getTime() - e.occurredAt.getTime();
  return ms >= LATE_NOTED_MS
    ? { ms, happenedAt: e.occurredAt.toISOString(), arrivedAt: e.createdAt.toISOString() }
    : null;
}

/** How far behind a run is, from its context. */
export function lateOf(context: Json): Late | null {
  const late = context['_late'];
  if (!isRecord(late) || typeof late['ms'] !== 'number' || late['ms'] < LATE_NOTED_MS) return null;
  return {
    ms: late['ms'],
    happenedAt: String(late['happenedAt'] ?? ''),
    arrivedAt: String(late['arrivedAt'] ?? ''),
  };
}

/** How far behind a run is in milliseconds (0 when it isn't). */
export const lateMsOf = (context: Json): number => lateOf(context)?.ms ?? 0;

/**
 * After a wait that was due at `wakeAt`: behind by no more than before, and no more than it ended past its time. A
 * run that wasn't behind never becomes behind here.
 */
export function lateAfterWait(context: Json, wakeAt: number, now: number): Late | null {
  const late = lateOf(context);
  if (!late) return null;
  const ms = Math.min(late.ms, Math.max(0, now - wakeAt));
  return ms >= LATE_NOTED_MS ? { ...late, ms } : null;
}

/** The context patch that records how far behind a run now is (null clears it). */
export const lateContext = (late: Late | null): { _late: Late | null } => ({ _late: late });

/** A step that would contact the customer, skipped because the run is too far behind; null when it may go. */
export function lateSkip(ec: ExecCtx, input: Json): Outcome | null {
  if (ec.testMode !== null) return null;
  const late = lateOf(ec.context);
  if (!late || late.ms <= LATE_EVENT_MS) return null;
  return {
    kind: 'skipped',
    reason: 'late_event',
    input,
    output: {
      happenedAt: late.happenedAt,
      arrivedAt: late.arrivedAt,
      lateMinutes: Math.round(late.ms / 60_000),
      why: `Not sent: what started this happened ${waitInWords(late.ms)} before it reached HandsFreeOS, so a message now could be out of date.`,
    },
  };
}
