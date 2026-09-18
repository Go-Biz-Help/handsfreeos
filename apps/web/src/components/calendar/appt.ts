import { useSyncExternalStore } from 'react';
import {
  areaOf,
  bookedSeatsOf,
  firstName,
  holdOf,
  holdWords,
  isPast,
  namesText,
  reservedText,
  statusOf as statusWordOf,
  type AgendaAppointment,
  type Hold,
} from '@hfos/core';
import type { BadgeVariant } from '@/components/ui/badge';
import type { Appointment } from '@/lib/api/types';

/**
 * An appointment as the calendar screens read it. The wording and the rules now live in `@hfos/core`
 * (`calendar/agenda.ts`), so the phone app says the same thing (M10 step 16); this file is the web's names for
 * them, and the one thing that can't move — React's `useNow`.
 */
export { areaOf, firstName, holdOf, holdWords, isPast, namesText, reservedText, type Hold };

/** Customers still on an appointment (not cancelled off it). */
export const customersOf = (a: Pick<Appointment, 'attendees'>) => bookedSeatsOf(a.attendees);

/** The open times a 409 resource_full offers instead: `details.slots[].startsAt`, as with slot_taken. */
export function freshTimes(details: unknown): string[] {
  const slots = (details as { slots?: unknown } | null | undefined)?.slots;
  if (!Array.isArray(slots)) return [];
  return slots
    .map((s: unknown) =>
      typeof s === 'string' ? s : (s as { startsAt?: unknown } | null)?.startsAt,
    )
    .filter((s): s is string => typeof s === 'string');
}

/** Core's status word, with the badge variant the web's kit draws it in. */
export function statusOf(
  a: Pick<Appointment, 'status' | 'startsAt' | 'endsAt'> & { heldUntil?: string | null },
  now: number | null,
): { label: string; variant: BadgeVariant } {
  const { label, tone } = statusWordOf(a as unknown as AgendaAppointment, now);
  return { label, variant: tone as BadgeVariant };
}

const subscribe = (tick: () => void) => {
  const t = setInterval(tick, 15_000);
  return () => clearInterval(t);
};

/** The current minute, after the page has mounted (null while rendering on the server). */
export function useNow(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / 60_000) * 60_000,
    () => null,
  );
}
