import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { readRef, REF_COOKIE, REF_DAYS, REF_PARAM, refCode, refCookieValue } from '@/lib/affiliate';
import { workerUrl } from '@/lib/worker-url';

/**
 * An affiliate's link arriving (`?ref=`, 20261027014000; see `lib/affiliate.ts`). The only thing this proxy does, and
 * the matcher sends it nothing else.
 *
 * The code is kept in a cookie for 90 days and the visitor goes on to the same page without `?ref=`. The first time
 * this browser arrives on a code, the worker counts a click for it, after the answer has gone. A code that isn't one
 * is dropped from the address all the same: a mistyped link still opens the page.
 */
export function proxy(request: NextRequest, event: NextFetchEvent) {
  const url = request.nextUrl.clone();
  const code = refCode(url.searchParams.get(REF_PARAM));
  url.searchParams.delete(REF_PARAM);
  const response = NextResponse.redirect(url, 307);
  if (!code) return response;

  const was = readRef(request.cookies.get(REF_COOKIE)?.value);
  response.cookies.set(REF_COOKIE, refCookieValue({ code, clickedAt: new Date() }), {
    maxAge: REF_DAYS * 86_400,
    path: '/',
    sameSite: 'lax',
    secure: url.protocol === 'https:',
  });
  if (was?.code !== code)
    event.waitUntil(
      fetch(`${workerUrl()}/public/affiliates/click`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined),
    );
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|xml|txt)$).*)',
      has: [{ type: 'query', key: 'ref' }],
    },
  ],
};
