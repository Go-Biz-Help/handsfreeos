import { useSyncExternalStore } from 'react';
import type { BadgeVariant } from '@/components/ui/badge';
import type { Appointment } from '@/lib/api/types';

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

export function statusOf(
  a: Pick<Appointment, 'status' | 'startsAt' | 'endsAt'>,
  now: number | null,
): { label: string; variant: BadgeVariant } {
  if (a.status === 'cancelled') return { label: 'Cancelled', variant: 'danger' };
  if (a.status === 'completed') return { label: 'Completed', variant: 'ok' };
  if (a.status === 'no_show') return { label: 'No-show', variant: 'gray' };
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
