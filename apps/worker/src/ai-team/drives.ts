/**
 * Drive times for the AI teammate (docs/outreach.md, decision 179; the owner, 23 Nov 2026: "Yes, teach the AI drive
 * time").
 *
 * On a calendar that leaves time to drive between visits, the teammate asks where the visit is, and the drives to
 * that place are timed by road the way the booking page times them (booking/drives.ts): from each nearby visit that
 * has an address, and from where each person's day starts. The times it offers then leave room to drive from the
 * visit before and on to the next.
 *
 * The drives go with each time it offers and with the booking it holds, so the booking is checked against the same
 * drives whether it goes out with the reply or a person approves it later (an approval runs where no map can be
 * asked). A move is timed afresh from the visit's own address, leaving the visit itself out.
 */
import { loadCalendar, type Drives } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { drivesFor, type DriveDeps } from '../booking/drives';
import { placeOf } from '../geo/geocoder';

const DAY = 86_400_000;

/** The drives to one address on one calendar, over a span; null when nothing can be timed. */
export async function drivesTo(
  deps: DriveDeps,
  tx: Tx,
  workspaceId: string,
  calendarId: string,
  address: string | null,
  span: { readonly from: number; readonly to: number },
  opts: { readonly excludeAppointmentIds?: readonly string[] } = {},
): Promise<Drives | null> {
  if (!address?.trim()) return null;
  const place = await placeOf(tx, deps.geocoder, address).catch(() => null);
  if (!place) return null;
  const calendar = await loadCalendar(tx, workspaceId, calendarId);
  return drivesFor(deps, tx, calendar, { lat: place.lat, lng: place.lng }, span, opts);
}

/** The drives for moving one of their visits to a new time: from the visit's own address, the visit left out. */
export async function moveDrives(
  deps: DriveDeps,
  tx: Tx,
  workspaceId: string,
  appointment: { readonly id: string; readonly calendarId: string },
  startsAt: string,
): Promise<Drives | null> {
  const [visit] = await rows<{ address: string | null }>(
    tx,
    sql`select btrim(location ->> 'address') as address from app.appointments
         where id = ${appointment.id} and workspace_id = ${workspaceId}`,
  );
  const start = Date.parse(startsAt);
  return drivesTo(
    deps,
    tx,
    workspaceId,
    appointment.calendarId,
    visit?.address ?? null,
    { from: start, to: start + 1 },
    { excludeAppointmentIds: [appointment.id] },
  );
}

/** How far a series of repeat visits reaches, so the drives cover its last visit too. */
export function seriesSpan(
  startsAt: string,
  every: 'week' | 'month',
  interval: number,
  times: number,
): { from: number; to: number } {
  const from = Date.parse(startsAt);
  const step = (every === 'month' ? 31 : 7) * DAY * Math.max(1, interval);
  return { from, to: from + step * Math.max(0, times - 1) + 1 };
}
