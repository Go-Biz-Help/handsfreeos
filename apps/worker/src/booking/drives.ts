/**
 * Drive times between visits (docs/outreach.md, decision 179; the owner, 18 Nov 2026: a local meeting calendar that
 * works out driving times from the last known location is a core feature, "e.g. mobile car detailer").
 *
 * On a calendar with Leave time to drive between visits on, the booking page asks for the customer's address first.
 * For that place, this works out by road how long each person on the calendar needs to get there: from each of
 * their appointments that has an address (the last known location, the owner's 1a), and from where their day starts
 * for the first visit of a day (their own address in Settings → My calendar, else the business's: the owner's 2a).
 * The engine (`withDrives`) then offers only times that leave room for the drives.
 *
 * Every address is found on the map once and kept (app.geocodes; one found nowhere is remembered for a day), and
 * drives are kept in memory, so a customer paging through a month costs one road lookup per new place. Past the
 * booking page's daily budget for map lookups (geo/budget.ts), an address not yet found is left out and a drive not
 * yet timed is a rough guess.
 */
import {
  dayStartAddresses,
  uuidArray,
  type Drives,
  type GeoPoint,
  type LoadedCalendar,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { LookupsPaused } from '../geo/budget';
import { roughMinutes, type DriveTimer } from '../geo/driving';
import { placeOf, type Geocoder } from '../geo/geocoder';

const DAY = 86_400_000;
/** The most places one request times: a busy team's month, without letting one page view run up the bill. */
const MOST_PLACES = 60;
/** Drives kept in memory, by both ends rounded to about 10 m. */
const KEPT = 5000;
const kept = new Map<string, number>();

const keyOf = (a: GeoPoint, b: GeoPoint) =>
  `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;

function keep(key: string, minutes: number): void {
  if (kept.size >= KEPT) kept.delete(kept.keys().next().value!);
  kept.set(key, minutes);
}

/** Minutes from the customer's place to each place, kept or asked for in one go. */
async function minutesTo(
  driving: DriveTimer,
  from: GeoPoint,
  places: readonly GeoPoint[],
): Promise<number[]> {
  const unknown = places.filter((p) => !kept.has(keyOf(from, p)));
  if (unknown.length) {
    const got = await driving.many(from, unknown).catch((e: unknown) => {
      if (e instanceof LookupsPaused) return null;
      throw e;
    });
    // The booking page's daily budget is spent: a rough guess for now, not kept, so the road is asked tomorrow.
    if (!got) return places.map((p) => kept.get(keyOf(from, p)) ?? roughMinutes(from, p));
    unknown.forEach((p, i) => keep(keyOf(from, p), got[i]!));
  }
  return places.map((p) => kept.get(keyOf(from, p))!);
}

/** Forget the drives kept in memory (tests). */
export function forgetDrives(): void {
  kept.clear();
}

export interface DriveDeps {
  readonly geocoder: Geocoder;
  readonly driving: DriveTimer;
}

/**
 * The drives to one customer's place for everyone on the calendar, over the days asked for (a day either side, so
 * the visit before and the one after count). Null when the calendar doesn't leave time to drive, there's no place
 * to drive to, or nothing can be found on a map.
 */
export async function drivesFor(
  deps: DriveDeps,
  tx: Tx,
  calendar: LoadedCalendar,
  place: GeoPoint | null,
  span: { readonly from: number; readonly to: number },
  opts: { readonly excludeAppointmentIds?: readonly string[] } = {},
): Promise<Drives | null> {
  if (!calendar.config.buffers.driveBetween || !place || deps.geocoder.name === 'off') return null;
  const ws = calendar.workspaceId;
  const userIds =
    calendar.config.team.assignment === 'none'
      ? []
      : [...new Set(calendar.config.team.members.map((m) => m.userId))];
  if (!userIds.length) return null;
  const near = await rows<{ appointment_id: string; address: string }>(
    tx,
    sql`select distinct s.appointment_id, btrim(a.location ->> 'address') as address
        from app.appointment_staff s join app.appointments a on a.id = s.appointment_id
        where s.workspace_id = ${ws} and s.active and s.user_id = any(${uuidArray(userIds)})
          and s.blocked && tstzrange(${new Date(span.from - DAY).toISOString()}::timestamptz,
                                     ${new Date(span.to + DAY).toISOString()}::timestamptz)
          and length(btrim(coalesce(a.location ->> 'address', ''))) > 0
          and not (s.appointment_id = any(${uuidArray(opts.excludeAppointmentIds ?? [])}))
        order by s.appointment_id`,
  );
  const starts = await dayStartAddresses(tx, ws, userIds);
  // Each address once, the day starts first so a busy month never leaves anyone's first drive out.
  const addresses = [
    ...new Set([
      ...[...starts.values()].filter((a): a is string => !!a),
      ...near.map((n) => n.address),
    ]),
  ].slice(0, MOST_PLACES);
  const places = new Map<string, GeoPoint>();
  for (const address of addresses) {
    const found = await placeOf(tx, deps.geocoder, address).catch(() => null);
    if (found) places.set(address, { lat: found.lat, lng: found.lng });
  }
  if (!places.size) return null;
  const list = [...places.entries()];
  const minutes = await minutesTo(
    deps.driving,
    place,
    list.map(([, p]) => p),
  );
  const byAddress = new Map(list.map(([a], i) => [a, minutes[i]!]));
  const fromStart: Record<string, number> = {};
  for (const [userId, address] of starts) {
    const m = address ? byAddress.get(address) : undefined;
    if (m !== undefined) fromStart[userId] = m;
  }
  const around: Record<string, number> = {};
  for (const n of near) {
    const m = byAddress.get(n.address);
    if (m !== undefined) around[n.appointment_id] = m;
  }
  return { fromStart, around };
}
