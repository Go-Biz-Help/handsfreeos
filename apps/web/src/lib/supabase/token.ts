'use client';
import {
  clockOffsetMs,
  SIGN_IN_RENEW_BEFORE_MS,
  signInIssuedAt,
  signInTimeLeftMs,
} from '@hfos/core';
import type { Session } from '@supabase/supabase-js';
import { supabaseBrowser } from './client';

/**
 * The sign-in a request from the browser carries. supabase-js judges a sign-in's time left by the computer's clock,
 * so on one running an hour fast every request renewed it, until Supabase's limit refused a renewal and supabase-js
 * dropped the sign-in ("Sign in to continue.", 10 Nov 2026). Here the time left is judged by the server's clock
 * (`auth/clock` in core): the sign-in supabase-js last handed out is used while it has time left, and renewed once
 * when it hasn't.
 */

/** The sign-in as supabase-js last said (undefined until it first says). */
let current: Session | null | undefined;
/** How far this computer's clock is ahead of the server's, learnt from each renewal. */
let offset = 0;
let watching = false;
let renewing: Promise<Session | null> | null = null;
const listeners = new Set<() => void>();

function watch() {
  if (watching) return;
  watching = true;
  supabaseBrowser().auth.onAuthStateChange((event, session) => {
    current = session;
    // A renewed sign-in was issued just now (here or in another tab), so its issue time says how far the clock is off.
    if (event !== 'TOKEN_REFRESHED' || !session) return;
    const issuedAt = signInIssuedAt(session.access_token);
    if (issuedAt === null) return;
    offset = clockOffsetMs(issuedAt, Date.now());
    for (const listener of listeners) listener();
  });
}

function renew(): Promise<Session | null> {
  renewing ??= supabaseBrowser()
    .auth.refreshSession()
    .then(
      ({ data }) => data.session ?? null,
      () => null,
    )
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

/** The signed-in session, renewed only when it's truly about to run out; null when signed out. */
export async function browserSession(): Promise<Session | null> {
  watch();
  // Before supabase-js first says, its own read, which renews a sign-in near its end.
  const session = current !== undefined ? current : (await supabaseBrowser().auth.getSession()).data.session;
  if (!session) return null;
  const left = signInTimeLeftMs(session.expires_at ?? 0, Date.now(), offset);
  if (left > SIGN_IN_RENEW_BEFORE_MS) return session;
  const renewed = await renew();
  // A renewal refused while the sign-in still has time: it still works until then.
  return renewed ?? (left > 0 ? session : null);
}

/** The access token a request from the browser carries, or null when signed out. */
export async function browserAccessToken(): Promise<string | null> {
  return (await browserSession())?.access_token ?? null;
}

/** A token the server refused: renewed now, whatever its time left says. Null when it can't be. */
export async function renewedAccessToken(): Promise<string | null> {
  watch();
  return (await renew())?.access_token ?? null;
}

/** How far this computer's clock is ahead of the server's, as last measured (0 until a renewal says). */
export function browserClockOffsetMs(): number {
  return offset;
}

/** Called whenever a renewal measures the clock again; returns the way to stop. */
export function onBrowserClockMeasured(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
