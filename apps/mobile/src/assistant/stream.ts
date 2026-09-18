import { AssistantEvent, type AssistantCard, type PageRecord } from '@hfos/core';
import { fetch as streamingFetch } from 'expo/fetch';

import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { isTestOffline } from '@/lib/network';

/**
 * The Assistant on the phone talks to the worker, exactly as the web's panel does: one question over server-sent
 * events, and the confirm, cancel, undo and stop routes for its cards. The API has none of this — only the worker
 * holds the model — so every call here needs signal, and with none the screen says so rather than queueing
 * anything (`design/m10/Assistant.dc.html`, "No signal").
 *
 * React Native's own `fetch` reads a whole response before handing it over, so the stream comes through
 * `expo/fetch`, which gives a real `response.body`.
 */

/** One question, as the worker takes it (AssistantAskInput). */
export interface AskBody {
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly text: string;
  /** The customer, lead or conversation the mark was pressed on, so "text her…" means them. */
  readonly page: PageRecord | null;
}

/** Where a card stands after Confirm, Cancel or Undo. */
export interface DecisionOut {
  readonly id: string;
  readonly tool: string;
  readonly status: 'confirmed' | 'cancelled' | 'failed' | 'done';
  readonly outcome: string | null;
  readonly href: string | null;
  readonly error: string | null;
  /** True once Undo took a task or note back. */
  readonly undone?: boolean;
}

export type AssistantFailure =
  | 'no_signal'
  | 'not_configured'
  | 'consent_required'
  | 'unauthenticated'
  | 'already_running'
  | 'budget_reached'
  | 'busy'
  | 'gone'
  | 'failed';

/** What went wrong, in the shape the screen reads: the worker's own words, and why. */
export class AssistantError extends Error {
  constructor(
    message: string,
    readonly failure: AssistantFailure,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'AssistantError';
  }
}

const NO_SIGNAL = 'The Assistant needs signal.';

/** Whether this build knows where the worker is; without it the Assistant can't be reached at all. */
export function assistantConfigured(): boolean {
  return Boolean(config.workerUrl);
}

async function headers(): Promise<Record<string, string>> {
  const token = await session.accessToken();
  if (!token) throw new AssistantError('Sign in to continue.', 'unauthenticated', 401);
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/** The worker's refusal body ({ error: { code, message, rule } }) as an AssistantError. */
async function refusal(res: { status: number; json: () => Promise<unknown> }) {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; rule?: string };
  } | null;
  const err = json?.error;
  const message = err?.message ?? 'Something went wrong. Try again.';
  const rule = err?.rule;
  const failure: AssistantFailure =
    rule === 'assistant_not_configured'
      ? 'not_configured'
      : rule === 'assistant_consent_required'
        ? 'consent_required'
        : res.status === 401 || res.status === 403
          ? 'unauthenticated'
          : res.status === 409
            ? 'already_running'
            : res.status === 429
              ? 'budget_reached'
              : res.status === 503
                ? 'busy'
                : res.status === 404
                  ? 'gone'
                  : 'failed';
  return new AssistantError(message, failure, res.status);
}

/** One event block's `data:` lines as an event; pings, comments and anything unreadable are skipped. */
export function parseBlock(block: string): AssistantEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    const parsed = AssistantEvent.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Splits what has arrived so far into whole events, and keeps the rest for the next chunk. `\r\n` line endings are
 * made plain first, so a proxy that rewrites them can't hide the blank line between events.
 */
export function readEvents(buffer: string): { events: AssistantEvent[]; rest: string } {
  let rest = buffer.replace(/\r\n/g, '\n');
  const events: AssistantEvent[] = [];
  for (let end = rest.indexOf('\n\n'); end >= 0; end = rest.indexOf('\n\n')) {
    const event = parseBlock(rest.slice(0, end));
    rest = rest.slice(end + 2);
    if (event) events.push(event);
  }
  return { events, rest };
}

/**
 * Asks the worker and hands each event to `onEvent` as it arrives. Aborting stops listening only: the run finishes
 * and saves on the worker (Stop is `stopRun`). Anything that fails before the stream starts throws.
 */
export async function streamAnswer(
  body: AskBody,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (isTestOffline()) throw new AssistantError(NO_SIGNAL, 'no_signal');
  if (!assistantConfigured()) throw new AssistantError(NO_SIGNAL, 'not_configured');
  const init = {
    method: 'POST',
    headers: { ...(await headers()), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  };
  let res: Awaited<ReturnType<typeof streamingFetch>>;
  try {
    res = await streamingFetch(`${config.workerUrl}/v1/assistant/messages`, init);
  } catch {
    if (signal.aborted) return;
    throw new AssistantError(NO_SIGNAL, 'no_signal');
  }
  if (!res.ok) throw await refusal(res);
  if (!res.body) throw new AssistantError(NO_SIGNAL, 'no_signal');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const read = readEvents(buffer + decoder.decode(value, { stream: true }));
      buffer = read.rest;
      for (const event of read.events) onEvent(event);
    }
  } catch {
    if (signal.aborted) return;
    throw new AssistantError('The connection dropped before the answer finished.', 'no_signal');
  } finally {
    reader.releaseLock();
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  if (isTestOffline()) throw new AssistantError(NO_SIGNAL, 'no_signal');
  if (!assistantConfigured()) throw new AssistantError(NO_SIGNAL, 'not_configured');
  let res: Response;
  try {
    res = await fetch(`${config.workerUrl}${path}`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError(NO_SIGNAL, 'no_signal');
  }
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/** Stop: the worker ends the run and says "stopped" on its stream. */
export const stopRun = (runId: string) =>
  post<{ stopping: boolean }>(`/v1/assistant/runs/${encodeURIComponent(runId)}/stop`, {});

/** Runs exactly what the card shows (409 once answered or lapsed, 404 when gone). */
export const confirmToolCall = (id: string, workspaceId: string, lostReason?: string) =>
  post<DecisionOut>(`/v1/assistant/tool-calls/${encodeURIComponent(id)}/confirm`, {
    workspaceId,
    ...(lostReason ? { lostReason } : {}),
  });

export const cancelToolCall = (id: string, workspaceId: string) =>
  post<DecisionOut>(`/v1/assistant/tool-calls/${encodeURIComponent(id)}/cancel`, { workspaceId });

/** Takes back a task or note the Assistant added on its own. */
export const undoToolCall = (id: string, workspaceId: string) =>
  post<DecisionOut>(`/v1/assistant/tool-calls/${encodeURIComponent(id)}/undo`, { workspaceId });

export type { AssistantCard };
