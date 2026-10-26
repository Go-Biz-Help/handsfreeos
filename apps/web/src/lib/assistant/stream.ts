'use client';
import { AssistantEvent } from '@hfos/core';
import { ApiError } from '../api/errors';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import type { PageRecord } from './page-record';

/** One question, as the worker takes it (AssistantAskInput). */
export interface AskBody {
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly page: PageRecord | null;
  /** Asked out loud: the answer is written to be heard. */
  readonly spoken?: boolean;
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

const UNREACHABLE = 'The Assistant isn’t reachable right now. Try again in a minute.';

async function headers(): Promise<Record<string, string>> {
  const token = (await supabaseBrowser().auth.getSession()).data.session?.access_token;
  if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    // A fresh id, never one of this tab's own: what the Assistant changes must reach this tab's live updates.
    'x-correlation-id': crypto.randomUUID(),
  };
}

/** The worker's error body ({ error: { code, message, rule } }) as an ApiError. */
async function refusal(res: Response): Promise<ApiError> {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; rule?: string; details?: unknown };
  } | null;
  const err = json?.error;
  return new ApiError(
    res.status,
    err?.code ?? 'internal',
    err?.message ?? 'Something went wrong. Try again.',
    err?.rule,
    err?.details,
  );
}

/** One event block's `data:` lines as an event; pings, comments and anything unreadable are skipped. */
function parseBlock(block: string): AssistantEvent | null {
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
 * Asks the worker and hands each server-sent event to `onEvent` as it arrives. EventSource can't POST or
 * send the session token, so this reads the stream from fetch. Aborting stops listening only: the run
 * finishes and saves on the worker (Stop is `stopRun`). Errors before the stream starts throw an ApiError.
 */
export async function streamAnswer(
  body: AskBody,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const init: RequestInit = {
    method: 'POST',
    headers: { ...(await headers()), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  };
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}/v1/assistant/messages`, init);
  } catch {
    if (signal.aborted) return;
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
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const event = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) onEvent(event);
      }
    }
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'dropped', 'The connection dropped before the answer finished.');
  } finally {
    reader.releaseLock();
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify(body),
  };
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, init);
  } catch {
    throw new ApiError(0, 'unreachable', UNREACHABLE);
  }
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/**
 * The panel opened: the worker has the AI read ahead while the person types, so the answer starts sooner. Quiet
 * on purpose: nothing is shown whatever comes back, and the worker sends nothing without their OK to use the AI.
 */
export const warmAssistant = (workspaceId: string) =>
  post<{ warmed: boolean }>('/v1/assistant/warm', { workspaceId }).catch(() => undefined);

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
