'use client';
/**
 * The test console's connection to the worker. A manager writes (or talks on a call) as a customer, and the
 * teammate answers as it would, streamed back while it works. Look-ups are real (Knowledge, open times, the
 * customer's record); anything that would change something is only described, and nothing is sent to anyone.
 * Test chats never count toward training wheels.
 *
 * The request and the events are @hfos/core's ai-team/test-console.ts, which the phone app's console reads too:
 * POST {NEXT_PUBLIC_WORKER_URL}/v1/ai-team/test with the session's token, then server-sent events. A 404 means
 * the route isn't there yet, and the console says "The test console arrives with the teammate's runtime."
 */
import { readTestEvents, type TestConsoleBody, type TestEvent } from '@hfos/core';
import { ApiError } from '../api/errors';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';

export {
  parseTestEvent,
  WOULD_KINDS,
  type TestEvent,
  type TestMessage,
  type WouldKind,
} from '@hfos/core';

export type TestBody = TestConsoleBody;

const UNREACHABLE = 'The test console isn’t reachable right now. Try again in a minute.';

async function headers(): Promise<Record<string, string>> {
  const token = (await supabaseBrowser().auth.getSession()).data.session?.access_token;
  if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-correlation-id': crypto.randomUUID(),
  };
}

/** The worker's error body ({ error: { code, message, rule } }) as an ApiError. */
async function refusal(res: Response): Promise<ApiError> {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; rule?: string; details?: unknown } | string;
  } | null;
  const err = typeof json?.error === 'object' ? json.error : undefined;
  return new ApiError(
    res.status,
    err?.code ?? (res.status === 404 ? 'not_found' : 'internal'),
    err?.message ?? 'Something went wrong. Try again.',
    err?.rule,
    err?.details,
  );
}

/** The worker doesn't have the route yet: it arrives with the teammate's runtime. */
export const testConsoleMissing = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 404;

/**
 * Sends the test chat and hands each event to `onEvent` as it arrives. EventSource can't POST or send the
 * session token, so this reads the stream from fetch. Aborting stops listening (and the worker stops the
 * test). Errors before the stream starts throw an ApiError.
 */
export async function streamTest(
  body: TestBody,
  onEvent: (event: TestEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}/v1/ai-team/test`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return;
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'unreachable', UNREACHABLE);
  }
  if (!res.ok) throw await refusal(res);
  if (!res.body) throw new ApiError(0, 'unreachable', UNREACHABLE);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const read = readTestEvents(buffer + decoder.decode(value, { stream: true }));
      buffer = read.rest;
      for (const event of read.events) onEvent(event);
    }
    for (const event of readTestEvents(`${buffer}\n\n`).events) onEvent(event);
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'dropped', 'The connection dropped before the reply finished.');
  } finally {
    reader.releaseLock();
  }
}
