/**
 * A request arriving on a business's own domain (M17).
 *
 * `booking.lonestarhvac.com/` is that business's booking page; `booking.lonestarhvac.com/quote` is its form
 * called `quote`. The proxy rewrites the path and Next serves the page that was always there, so nothing
 * downstream — no page, no route, no link builder — has to know a branded domain exists.
 *
 * **Only the public pages.** The app itself, the sign-in pages and the webhooks stay on our own address: a
 * business's domain is for the pages its customers see, and serving a sign-in form on somebody else's name
 * is how a phishing page gets built out of a feature.
 */
import { brandedRoute } from '@hfos/core';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '../env';

/** A minute, like the form's frame rule: long enough to matter, short enough that a new domain works soon. */
const CACHE_MS = process.env.NODE_ENV === 'production' ? 60_000 : 0;

interface Cached {
  readonly site: string | null;
  readonly at: number;
}
const cache = new Map<string, Cached>();

/** The business whose site this host is, or null. Null is the ordinary answer for every request we serve. */
export async function siteForHost(host: string): Promise<string | null> {
  const key = host.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.site;
  try {
    const res = await fetch(
      `${publicEnv.workerUrl}/public/site-for-host/${encodeURIComponent(key)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { site?: string | null };
    const site = body.site ?? null;
    cache.set(key, { site, at: Date.now() });
    return site;
  } catch {
    // The worker is unreachable. Serving our own pages on their domain is wrong, so nothing is rewritten and
    // the request falls through to the 404 it would have got — which is at least honest.
    return null;
  }
}

/**
 * Whether this request came in on a name that is not ours. Compared against the app's own address rather
 * than a list, so a preview deployment and a local `pnpm dev` are both simply "ours".
 */
export function isForeignHost(request: NextRequest): boolean {
  const host = request.headers.get('host')?.toLowerCase().replace(/:\d+$/, '');
  if (!host) return false;
  let ours: string;
  try {
    ours = new URL(publicEnv.appUrlForHost).host.toLowerCase().replace(/:\d+$/, '');
  } catch {
    return false;
  }
  // A Vercel preview lands on *.vercel.app and is ours too; a business's domain never is.
  return host !== ours && !host.endsWith('.vercel.app') && host !== 'localhost';
}

/**
 * proxy.ts: rewrite a request on a business's own domain onto the page it is really for.
 *
 * Returns null when there is nothing to do, which is every request on our own address.
 */
export async function brandedHostProxy(request: NextRequest): Promise<NextResponse | null> {
  if (!isForeignHost(request)) return null;
  const host = request.headers.get('host')!.toLowerCase().replace(/:\d+$/, '');
  const site = await siteForHost(host);
  // A name pointed here by somebody who has not set it up. Nothing of ours is served on it.
  if (!site) return new NextResponse('Not found', { status: 404 });

  const path = request.nextUrl.pathname;
  const route = brandedRoute(site, path);
  if (route.kind === 'rewrite') {
    const url = request.nextUrl.clone();
    url.pathname = route.path;
    return NextResponse.rewrite(url);
  }
  // The links we send out keep their own shape, so a link in a text already sent still works on either
  // name. Handed back to the rest of proxy.ts rather than answered here, so a form on a branded domain
  // still gets its frame rule and a chat window still gets its own.
  if (route.kind === 'serve') return null;
  // Anything else — the app, sign-in, the admin side — is not served on a business's domain.
  return NextResponse.redirect(new URL(path, publicEnv.appUrlForHost));
}
