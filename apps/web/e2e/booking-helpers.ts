/**
 * Setup for the public booking specs: an owner signs up through the app, then everything else (hours, the
 * booking site, calendars, sessions) goes through API commands with the owner's token, not the staff UI.
 * Customers use their own signed-out browser contexts.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

const API = 'http://127.0.0.1:4000';
export const WORKER = (process.env.WORKER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
const DAY = 86_400_000;
/** Open every day, all day, so the specs never depend on the weekday they run on. */
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

type Json = Record<string, unknown>;

/** The owner's access token and user id, from the local Auth server. */
export async function signInOwner(
  email: string,
  password = PASSWORD,
): Promise<{ token: string; userId: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and _PUBLISHABLE_KEY are needed');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!res.ok || !body.access_token || !body.user)
    throw new Error(`sign-in failed (${res.status})`);
  return { token: body.access_token, userId: body.user.id };
}

/** One API command or query as the owner. */
export async function api<T = Json>(
  token: string,
  kind: 'commands' | 'queries',
  name: string,
  input: unknown,
): Promise<T> {
  const res = await fetch(`${API}/v1/${kind}/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(`${name} failed (${res.status}): ${JSON.stringify(body)}`);
  return body as T;
}

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/** Objects merge key by key; arrays and plain values replace (like the calendar builder's patches). */
function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

export interface Owner {
  readonly token: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly site: string;
  readonly business: string;
}

/** A new business whose owner works every hour of every day, with a booking site. */
export async function ownerWithSite(page: Page, label: string, business: string): Promise<Owner> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: business });
  const { token, userId } = await signInOwner(email);
  await api(token, 'commands', 'schedule.set', { workspaceId, ownerId: userId, weekly: ALL_WEEK });
  const site = `e2e-${randomUUID().slice(0, 8)}`;
  await api(token, 'commands', 'booking_site.update', { workspaceId, slug: site, name: business });
  return { token, userId, workspaceId, site, business };
}

/** A public calendar for the owner, bookable right away, changes and cancels allowed until the start. */
export async function makeCalendar(
  owner: Owner,
  name: string,
  patch: Json = {},
  status: 'active' | 'paused' = 'active',
): Promise<{ id: string; slug: string; path: string }> {
  const { workspaceId, token, userId } = owner;
  const created = await api<{ calendarId: string; slug: string }>(
    token,
    'commands',
    'calendar.create',
    { workspaceId, name, preset: 'scratch' },
  );
  const { calendar } = await api<{ calendar: { config: Json; revision: number } }>(
    token,
    'queries',
    'calendar.get',
    { workspaceId, calendarId: created.calendarId },
  );
  const draft = merge(
    merge(calendar.config, {
      public: true,
      team: { members: [{ userId }] },
      window: { minNoticeMinutes: 0 },
      policies: { cancel: { cutoffHours: 0 }, reschedule: { cutoffHours: 0, maxTimes: 2 } },
    }),
    patch,
  );
  await api(token, 'commands', 'calendar.save', {
    workspaceId,
    calendarId: created.calendarId,
    baseRevision: calendar.revision,
    draft,
  });
  await api(token, 'commands', 'calendar.set_status', {
    workspaceId,
    calendarId: created.calendarId,
    status,
  });
  return {
    id: created.calendarId,
    slug: created.slug,
    path: `/book/${owner.site}/${created.slug}`,
  };
}

/** A US mobile number no other booking in the run is likely to share. */
export const randomPhone = () =>
  `(713) 555-${String(Math.floor(Math.random() * 9000) + 1000).padStart(4, '0')}`;

/** The worker's open times for a calendar, the next week. */
export async function openTimes(
  site: string,
  calendar: string,
): Promise<{ startsAt: string; sessionId: string | null }[]> {
  const q = new URLSearchParams({
    from: new Date().toISOString(),
    to: new Date(Date.now() + 7 * DAY).toISOString(),
  });
  const res = await fetch(`${WORKER}/public/book/${site}/${calendar}/slots?${q}`);
  if (!res.ok) throw new Error(`open times failed (${res.status})`);
  return ((await res.json()) as { slots: { startsAt: string; sessionId: string | null }[] }).slots;
}

/** Another customer books straight through the worker (the "someone was faster" case). */
export async function bookThroughWorker(
  site: string,
  calendar: string,
  startsAt: string,
): Promise<number> {
  const res = await fetch(`${WORKER}/public/book/${site}/${calendar}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: randomUUID(),
      startsAt,
      name: 'Faster Customer',
      phone: randomPhone(),
      email: `faster-${randomUUID().slice(0, 8)}@hfos.test`,
    }),
  });
  return res.status;
}

/** Today plus `days` at 15:00 UTC. */
export function daysFromNow(days: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}
