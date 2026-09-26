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
 *
 * The one thing added here is the lead, told to Opinly with the secret key once the worker has taken it — after
 * the answer has gone back, so nobody waits on it. `anonId` is ours, for that, and comes off before forwarding:
 * the worker's schema is strict and would refuse a field it does not know.
 */
import { after, NextResponse } from 'next/server';
import { workerUrl } from '@/lib/founding';
import { trackServerEvent } from '@/lib/opinly/events';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const { anonId, ...application } = (body ?? {}) as Record<string, unknown>;

  try {
    const res = await fetch(`${workerUrl()}/public/founding/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // So the worker's per-address limits count the person, not this server.
        'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
      },
      body: JSON.stringify(application),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (res.ok) trackLead(text, application, anonId);
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

/**
 * The server's copy of a founding application, as a `generate_lead`. Keyed on the application, which the worker
 * answers with the same id however often the form is sent, and which the browser uses too — so it is one lead.
 * A crawler caught by the honeypot gets no id back, and so is never counted.
 */
function trackLead(answer: string, application: Record<string, unknown>, anonId: unknown): void {
  let parsed: { applicationId?: unknown; status?: unknown; offerId?: unknown };
  try {
    parsed = JSON.parse(answer) as typeof parsed;
  } catch {
    return;
  }
  if (typeof parsed.applicationId !== 'string') return;
  const applicationId = parsed.applicationId;
  const email = typeof application['email'] === 'string' ? application['email'].trim() : '';
  after(() =>
    trackServerEvent({
      event: 'generate_lead',
      // The same name, fields and id the browser sends (founding-form.tsx), so Opinly merges the two.
      properties: {
        offer: typeof parsed.offerId === 'string' ? parsed.offerId : undefined,
        status: typeof parsed.status === 'string' ? parsed.status : undefined,
      },
      externalEventId: applicationId,
      email: email || undefined,
      anonId:
        typeof anonId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(anonId) ? anonId : undefined,
    }),
  );
}
