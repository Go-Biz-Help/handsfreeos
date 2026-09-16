import { useSyncExternalStore } from 'react';
import type { BadgeVariant } from '@/components/ui/badge';
import type { Appointment } from '@/lib/api/types';
import { fmtTime } from '@/lib/calendar/time';

/** Customers still on an appointment (not cancelled off it). */
export const customersOf = (a: Pick<Appointment, 'attendees'>) =>
  a.attendees.filter((x) => x.status !== 'cancelled');

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** What a booking reserves, in words: "1 Red light bed", "2 × Truck". */
export const reservedText = (quantity: number, name: string): string =>
  quantity === 1 ? `1 ${name}` : `${quantity} × ${name}`;

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

/** "Priya and Marco", "Priya, Marco and Dale". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The neighbourhood part of an address: "5107 Evergreen St, Bellaire, TX 77401" → "Bellaire". */
export function areaOf(address: string | null | undefined): string | null {
  const parts = (address ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2]!;
  return parts[parts.length - 1] ?? null;
}

/**
 * A time only **held** while a customer pays the deposit that books it.
 *
 * It is a real appointment on a real slot, so it looks like a booking to anyone reading the calendar — but
 * nobody has told the customer it is theirs, and if the deposit doesn't land it gives itself back within
 * fifteen minutes. So every screen that shows one has to say so, or somebody rings to confirm a visit that
 * isn't booked, or works around a slot that is about to free itself.
 */
export interface Hold {
  /** When the hold runs out, as an instant. */
  readonly until: number;
  /** Whole minutes left, never below zero. */
  readonly minutesLeft: number;
  /** It ran out and the time hasn't been given back yet: treat it as gone, not as booked. */
  readonly over: boolean;
}

export function holdOf(
  a: Pick<Appointment, 'status'> & { heldUntil?: string | null },
  now: number | null,
): Hold | null {
  // Only a live booking can be held: once it is cancelled or done, the hold is history.
  if (!a.heldUntil || a.status !== 'scheduled') return null;
  const until = Date.parse(a.heldUntil);
  if (Number.isNaN(until)) return null;
  const left = until - (now ?? Date.now());
  return { until, minutesLeft: Math.max(0, Math.ceil(left / 60_000)), over: left <= 0 };
}

/**
 * What a held time is, in words anybody can act on: it isn't booked, it's waiting on money, and here is when
 * it goes. Deliberately never says "hold" on its own — nobody has to know what one is.
 */
export function holdWords(h: Hold, timeZone: string): string {
  if (h.over) return 'Waiting on a deposit. The time is up, so this slot is going back.';
  const left =
    h.minutesLeft <= 1 ? 'under a minute left' : `${h.minutesLeft} minutes left to pay it`;
  return `Waiting on a deposit. Held until ${fmtTime(h.until, timeZone)} · ${left}.`;
}

export function statusOf(
  a: Pick<Appointment, 'status' | 'startsAt' | 'endsAt'> & { heldUntil?: string | null },
  now: number | null,
): { label: string; variant: BadgeVariant } {
  if (a.status === 'cancelled') return { label: 'Cancelled', variant: 'danger' };
  if (a.status === 'completed') return { label: 'Completed', variant: 'ok' };
  if (a.status === 'no_show') return { label: 'No-show', variant: 'gray' };
  // Ahead of "Happening now": a time nobody has paid for isn't happening, whatever the clock says.
  if (holdOf(a, now)) return { label: 'Not booked yet', variant: 'pending' };
  if (now !== null && Date.parse(a.startsAt) <= now && Date.parse(a.endsAt) > now)
    return { label: 'Happening now', variant: 'pending' };
  return { label: 'Scheduled', variant: 'accent' };
}

export const isPast = (a: Pick<Appointment, 'endsAt'>, now: number | null) =>
  now !== null && Date.parse(a.endsAt) <= now;

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
