/**
 * Server-side events to Opinly (`POST /v1/events`), with the secret key.
 *
 * The browser reports the same things, but a browser can be blocked or closed; this is the copy that always
 * arrives. Both carry the same `externalEventId`, so Opinly merges them into one event.
 *
 * Fire-and-forget by design: call it from `after()` so the visitor never waits on it, and it never throws.
 */
import 'server-only';

export async function trackServerEvent(input: {
  event: string;
  properties?: Record<string, unknown>;
  externalEventId: string;
  /** The join keys: the browser's anonymous id is exact, the email is the fallback. Send both when known. */
  email?: string;
  anonId?: string;
}): Promise<void> {
  const key = process.env.OPINLY_API_KEY;
  if (!key) return;
  const base = (process.env.OPINLY_API_URL ?? 'https://sdk.opinly.ai').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: input.event,
        properties: input.properties ?? {},
        externalEventId: input.externalEventId,
        ...(input.email ? { email: input.email } : {}),
        ...(input.anonId ? { anonId: input.anonId } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`[opinly] ${input.event} was refused: ${res.status}`);
  } catch (error) {
    console.warn(`[opinly] ${input.event} was not sent: ${(error as Error).message}`);
  }
}
