/**
 * An embedded booking page's frame rule (the owner, 2026-11-18: a calendar on the business's own website, like a
 * form). `/book/<site>/<calendar>?embed=1` runs inside businesses' own sites when they paste the calendar's snippet,
 * so its response carries `Content-Security-Policy: frame-ancestors 'self' <the site it's on>`, and browsers refuse to
 * show it anywhere else.
 *
 * The site it's on comes from the request's own Referer (the snippet's iframe asks for one), and is written into the
 * rule only when it's one the calendar lists (Booking link → On your website). A page that lies about its Referer
 * gains nothing: the browser compares the rule with the real ancestor and refuses. Without `embed=1`, or for a
 * calendar nobody has listed a site for, the rule is the one every page of ours has (lib/frames.ts): 'self' alone.
 *
 * Only the booking page itself: the pages it leads to (Change or cancel, paying a deposit) open in a tab of their own,
 * where nothing frames them.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { publicEnv } from '../env';
import { exactOrigin } from '../forms/frame';
import { sameOriginFrames } from '../frames';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;
/** Long enough that a busy embedded calendar doesn't spend the worker's per-address limits on frame checks. */
const CACHE_MS = process.env.NODE_ENV === 'production' ? 60_000 : 0;

interface Cached {
  readonly origins: readonly string[];
  readonly at: number;
}
const cache = new Map<string, Cached>();

async function allowedOrigins(site: string, calendar: string): Promise<readonly string[]> {
  const key = `${site.toLowerCase()}/${calendar.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.origins;
  try {
    const res = await fetch(
      `${publicEnv.workerUrl}/public/book/${encodeURIComponent(site)}/${encodeURIComponent(calendar)}/embed`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { embedOrigins?: string[] };
    const origins = (body.embedOrigins ?? []).map((o) => o.toLowerCase());
    cache.set(key, { origins, at: Date.now() });
    return origins;
  } catch {
    return [];
  }
}

/** The calendar an embeddable address names: `/book/<site>/<calendar>`, or the permanent `/book/c/<id>`. */
export function embeddedCalendarOf(
  pathname: string,
): { readonly site: string; readonly calendar: string } | null {
  const [, book, site, calendar, ...rest] = pathname.split('/');
  if (book !== 'book' || !site || !calendar || rest.length) return null;
  // The permanent link's id has hyphens in the middle, like a link name, so the one pattern fits both.
  if (!SLUG.test(site) || !SLUG.test(calendar)) return null;
  return { site, calendar };
}

/**
 * proxy.ts: the frame rule on a booking page's response. The site it's on when the page asks to be embedded, the
 * calendar lists that site, and the request came from it; otherwise 'self' alone, as on every page of ours.
 */
export async function bookingFrames<R extends NextResponse>(
  request: NextRequest,
  response: R,
): Promise<R> {
  const url = request.nextUrl;
  const named = url.searchParams.get('embed') === '1' ? embeddedCalendarOf(url.pathname) : null;
  const from = exactOrigin(request.headers.get('referer'));
  if (!named || !from || from === url.origin) return sameOriginFrames(response);
  const origins = await allowedOrigins(named.site, named.calendar);
  if (!origins.includes(from)) return sameOriginFrames(response);
  response.headers.set('content-security-policy', `frame-ancestors 'self' ${from}`);
  // X-Frame-Options can't name another site, and a browser that knows frame-ancestors ignores it anyway.
  response.headers.delete('x-frame-options');
  return response;
}
