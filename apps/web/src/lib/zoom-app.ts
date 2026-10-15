/**
 * HandsFreeOS's app inside Zoom (AI Sales Coach, round three): Zoom opens our pages in its own browser and refuses
 * to show one without these security headers (its "OWASP headers": Strict-Transport-Security,
 * X-Content-Type-Options, Content-Security-Policy and Referrer-Policy). The frame rule (lib/frames.ts) is already the
 * page's Content-Security-Policy. Set by proxy.ts on /zoom, where the Zoom app starts, and on any page Zoom's
 * browser asks for (its user agent names Zoom), so the add-on page it goes on to is covered too.
 */
import type { NextRequest, NextResponse } from 'next/server';

export const isZoomApp = (request: NextRequest): boolean =>
  request.nextUrl.pathname === '/zoom' ||
  request.nextUrl.pathname.startsWith('/zoom/') ||
  /\bzoom/i.test(request.headers.get('user-agent') ?? '');

export function zoomAppHeaders<R extends NextResponse>(request: NextRequest, response: R): R {
  if (!isZoomApp(request)) return response;
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  return response;
}
