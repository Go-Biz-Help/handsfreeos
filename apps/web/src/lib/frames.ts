/**
 * The frame rule for every page that isn't meant to be embedded: only our own pages may frame it. Set by
 * proxy.ts (and on a business's own domain, lib/hosting/branded-host.ts); a public form and the chat window
 * set their own, wider rule instead (lib/forms/frame.ts, lib/chat/frame.ts).
 */
import type { NextResponse } from 'next/server';

export function sameOriginFrames<R extends NextResponse>(response: R): R {
  response.headers.set('content-security-policy', "frame-ancestors 'self'");
  // For browsers that predate frame-ancestors.
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  return response;
}
