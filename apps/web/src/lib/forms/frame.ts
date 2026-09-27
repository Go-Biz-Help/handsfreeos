/**
 * A public form's frame rule. /f/<site>/<form> runs inside businesses' own sites when they embed it, so its
 * response carries `Content-Security-Policy: frame-ancestors 'self' <the site it's on>` — and browsers
 * refuse to show it anywhere else.
 *
 * The site it's on comes from the request's own Referer, and is written into the rule only when it is one
 * the business listed. A page that lies about its Referer gains nothing: the browser compares the rule with
 * the real ancestor and refuses. A form nobody has listed a site for is framed by nothing but us.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '../env';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;
/** Long enough that a busy embedded form doesn't spend the worker's per-address limits on frame checks. */
const CACHE_MS = process.env.NODE_ENV === 'production' ? 60_000 : 0;

interface Cached {
  readonly origins: readonly string[];
  readonly at: number;
}
const cache = new Map<string, Cached>();

/** The exact origin of a URL, or null when it isn't one. */
export function exactOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

async function allowedOrigins(site: string, slug: string): Promise<readonly string[]> {
  const key = `${site}/${slug}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.origins;
  try {
    const res = await fetch(
      `${publicEnv.workerUrl}/public/form/${encodeURIComponent(site)}/${encodeURIComponent(slug)}`,
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

/**
 * proxy.ts: the frame rule on a public form's response. On a business's own domain the request is rewritten
 * onto the form's own path first (`rewriteTo`), and the rule is the same.
 */
export async function formFrameProxy(request: NextRequest, rewriteTo?: URL): Promise<NextResponse> {
  const response = rewriteTo ? NextResponse.rewrite(rewriteTo) : NextResponse.next();
  const [, , site, slug] = (rewriteTo ?? request.nextUrl).pathname.split('/');
  const from = exactOrigin(request.headers.get('referer'));
  let rule = "frame-ancestors 'self'";
  if (
    site &&
    slug &&
    SLUG.test(site) &&
    SLUG.test(slug) &&
    from &&
    from !== request.nextUrl.origin
  ) {
    const origins = await allowedOrigins(site, slug);
    if (origins.includes(from)) rule = `frame-ancestors 'self' ${from}`;
  }
  response.headers.set('content-security-policy', rule);
  return response;
}
