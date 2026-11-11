/**
 * A computer whose clock is wrong. Supabase's sign-in library decides a sign-in is about to run out by the computer's
 * own clock, so on one running an hour fast every sign-in looks spent: each request renewed it, Supabase's limit on
 * renewals refused one, and the library then dropped the sign-in part way through setting up ("Sign in to continue.",
 * 10 Nov 2026). A renewed sign-in was issued a moment ago, so its issue time tells how far the clock is off, and the
 * apps judge the sign-in's time left by the server's clock instead.
 */

/** How long before a sign-in runs out (by the server's clock) the apps renew it. */
export const SIGN_IN_RENEW_BEFORE_MS = 60_000;

/** A clock off by less than this isn't worth a word: a renewal's own trip takes a second or two. */
export const CLOCK_OFF_SAY_FROM_MS = 2 * 60_000;

/** A sign-in token's issue time (seconds since 1970), or null when it can't be read. */
export function signInIssuedAt(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(globalThis.atob(padded)) as { iat?: unknown };
    return typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? claims.iat : null;
  } catch {
    return null;
  }
}

/** How far this computer's clock is ahead of the server's (behind when negative), from a sign-in issued just now. */
export function clockOffsetMs(issuedAt: number, nowMs: number): number {
  return nowMs - issuedAt * 1000;
}

/** A sign-in's time left by the server's clock, given how far this computer's clock is off. */
export function signInTimeLeftMs(expiresAt: number, nowMs: number, offsetMs: number): number {
  return expiresAt * 1000 - (nowMs - offsetMs);
}

function amount(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 55) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'a day' : `${days} days`;
}

/** What the web app says while this computer's clock is off, or null when it's close enough. */
export function clockOffWords(offsetMs: number): string | null {
  if (Math.abs(offsetMs) < CLOCK_OFF_SAY_FROM_MS) return null;
  const which = offsetMs > 0 ? 'fast' : 'slow';
  return `Your computer’s clock is about ${amount(offsetMs)} ${which}, so it can sign you out part way through. Turn on Set time automatically in your computer’s date and time settings, then reload this page.`;
}
