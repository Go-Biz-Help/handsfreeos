/**
 * The application form's door, proxied.
 *
 * The form could post to the worker directly, but the worker's CORS allowlist is the app's origin and this
 * site is a different one. Adding the marketing site to that list would widen it for every route behind it;
 * forwarding here costs one hop and widens nothing. It also keeps the worker's address server-side, which
 * means it can change without a rebuild of anything a browser has cached.
 *
 * Nothing is validated here on purpose. The worker validates, rate-limits per address and holds the
 * honeypot; a second copy of those rules in a second language is a second thing to keep in step, and the one
 * that drifts is the one nobody is testing.
 */
import { NextResponse } from 'next/server';
import { workerUrl } from '@/lib/founding';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  try {
    const res = await fetch(`${workerUrl()}/public/founding/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // So the worker's per-address limits count the person, not this server.
        'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    /**
     * 502, not 500: this server is fine, the one behind it did not answer. The form says so and keeps what
     * they typed, because asking somebody to write out why their phone rings all day twice is how you stop
     * hearing from them.
     */
    return NextResponse.json({ error: 'upstream_unavailable' }, { status: 502 });
  }
}
