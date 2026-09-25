import { readTestEvents, type TestConsoleBody, type TestEvent } from '@hfos/core';
import { fetch as streamingFetch } from 'expo/fetch';

import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { isTestOffline } from '@/lib/network';

/**
 * The AI teammate's test console on the phone talks to the worker, exactly as the web's does
 * (apps/web/src/lib/ai-team/test-stream.ts): one test turn over server-sent events, in @hfos/core's
 * ai-team/test-console.ts contract. Only the worker holds the model, so it needs signal, and with none the screen
 * says so rather than queueing anything: a test isn't a change.
 *
 * React Native's own `fetch` reads a whole response before handing it over, so the stream comes through
 * `expo/fetch`, which gives a real `response.body`.
 */

export type TestFailure =
  | 'no_signal'
  | 'not_configured'
  | 'unauthenticated'
  | 'budget_reached'
  /** An outgoing call with nothing to be about (no visit to confirm, no open quote). */
  | 'nothing_to_call_about'
  | 'gone'
  | 'failed';

/** What went wrong, in the shape the screen reads: the worker's own words, and why. */
export class TestConsoleError extends Error {
  constructor(
    message: string,
    readonly failure: TestFailure,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'TestConsoleError';
  }
}

export const NO_SIGNAL = 'The test console needs signal.';

/** Whether this build knows where the worker is; without it the console can't be reached at all. */
export function testConsoleConfigured(): boolean {
  return Boolean(config.workerUrl);
}

/** The worker's refusal body ({ error: { code, message, rule } }) as a TestConsoleError. */
async function refusal(res: { status: number; json: () => Promise<unknown> }) {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; rule?: string };
  } | null;
  const err = json?.error;
  const message = err?.message ?? 'Something went wrong. Try again.';
  const failure: TestFailure =
    err?.rule === 'nothing_to_call_about'
      ? 'nothing_to_call_about'
      : err?.rule === 'ai_not_configured'
        ? 'not_configured'
        : res.status === 401 || res.status === 403
          ? 'unauthenticated'
          : res.status === 429
            ? 'budget_reached'
            : res.status === 404
              ? 'gone'
              : 'failed';
  return new TestConsoleError(message, failure, res.status);
}

/**
 * Sends one test turn and hands each event to `onEvent` as it arrives. Aborting stops listening, and the worker
 * stops the test. Anything that fails before the stream starts throws a TestConsoleError.
 */
export async function streamTest(
  body: TestConsoleBody,
  onEvent: (event: TestEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (isTestOffline()) throw new TestConsoleError(NO_SIGNAL, 'no_signal');
  if (!testConsoleConfigured()) throw new TestConsoleError(NO_SIGNAL, 'not_configured');
  const token = await session.accessToken();
  if (!token) throw new TestConsoleError('Sign in to continue.', 'unauthenticated', 401);
  let res: Awaited<ReturnType<typeof streamingFetch>>;
  try {
    res = await streamingFetch(`${config.workerUrl}/v1/ai-team/test`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal.aborted) return;
    throw new TestConsoleError(NO_SIGNAL, 'no_signal');
  }
  if (!res.ok) throw await refusal(res);
  if (!res.body) throw new TestConsoleError(NO_SIGNAL, 'no_signal');
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
    throw new TestConsoleError('The connection dropped before the reply finished.', 'no_signal');
  } finally {
    reader.releaseLock();
  }
}
