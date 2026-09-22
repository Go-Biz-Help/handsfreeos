'use client';
/**
 * The test console's connection to the worker. A manager writes as a customer, and the teammate answers as
 * it would, streamed back while it works. Look-ups are real (Knowledge, open times, the customer's record);
 * anything that would change something is only described, and nothing is sent to anyone. Test chats never
 * count toward training wheels.
 *
 * The route arrives with the teammate's runtime (Milestone 7 step 7). Its contract:
 *
 *   POST {NEXT_PUBLIC_WORKER_URL}/v1/ai-team/test
 *   Authorization: Bearer <the session's access token>. Needs ai_team.manage.
 *   Accept: text/event-stream
 *   Body (JSON):
 *     workspaceId  string
 *     personId     string | null   who to be: someone in Customers, or null for an unknown visitor
 *     channel      'sms' | 'email' | 'chat'
 *     at           string | null   pretend it's this time (ISO 8601); null is now
 *     config       object | null   the settings to test (the builder's unsaved draft); null tests the saved ones
 *     messages     { from: 'customer' | 'teammate', text: string }[]
 *                  the test chat so far, oldest first, ending with the customer's new message (at most 40)
 *
 *   A refusal before the stream starts is the API's JSON error, { error: { code, message, rule } }: 403
 *   without ai_team.manage, 429 when the AI limit is reached. A 404 means the route isn't there yet, and the
 *   console says "The test console arrives with the teammate's runtime."
 *
 *   Then server-sent events: one JSON object on `data:` lines, ended by a blank line. ": ping" comments keep
 *   the connection open and are ignored. Every `at` is ISO 8601.
 *     { type: 'started', runId, at }
 *     { type: 'delta', text }                     the reply grows by `text`
 *     { type: 'context', title, detail, at }      what it read first ("Read who he is")
 *     { type: 'knowledge', query, items: { id, title }[], at }
 *     { type: 'tool', name, title, detail, at }   a look-up (name is a TeammateToolName)
 *     { type: 'would', kind, summary, at }        a change it would have made; kind is one of WOULD_KINDS,
 *                                                 summary like "booked Thu 10 AM"
 *     { type: 'check', ok, passed: ReplyRule[], problems: { rule, message }[], rewritten, at }
 *                                                 checkTeammateReply on the final reply
 *     { type: 'note', title, detail, at }         anything else worth a line ("Disclosure line")
 *     { type: 'done', outcome, reply, draft, toolSteps, ms }
 *                                                 outcome: replied, drafted, handed_off or no_reply; draft:
 *                                                 training wheels would hold it for an OK
 *     { type: 'error', message }                  the run stopped; the message is for people
 *   `detail`, `query` and `reply` may be null. Unknown event types are skipped.
 */
import { ApiError } from '../api/errors';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import type { RunOutcome, TeammateChannelKey } from './types';

export interface TestMessage {
  readonly from: 'customer' | 'teammate';
  readonly text: string;
}

export interface TestBody {
  readonly workspaceId: string;
  readonly personId: string | null;
  readonly channel: TeammateChannelKey;
  readonly at: string | null;
  readonly config: unknown;
  readonly messages: readonly TestMessage[];
}

export const WOULD_KINDS = [
  'book',
  'reschedule',
  'cancel',
  'repeat',
  'waitlist',
  'note',
  'task',
  'stage',
  'answers',
  'discount',
  'money',
  'hand_off',
] as const;
export type WouldKind = (typeof WOULD_KINDS)[number];

export type TestEvent =
  | { readonly type: 'started'; readonly runId: string; readonly at: string }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'context' | 'note';
      readonly title: string;
      readonly detail: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'knowledge';
      readonly query: string | null;
      readonly items: readonly { readonly id: string; readonly title: string }[];
      readonly at: string;
    }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly title: string;
      readonly detail: string | null;
      readonly at: string;
    }
  | {
      readonly type: 'would';
      readonly kind: WouldKind;
      readonly summary: string;
      readonly at: string;
    }
  | {
      readonly type: 'check';
      readonly ok: boolean;
      readonly passed: readonly string[];
      readonly problems: readonly { readonly rule: string; readonly message: string }[];
      readonly rewritten: boolean;
      readonly at: string;
    }
  | {
      readonly type: 'done';
      readonly outcome: RunOutcome;
      readonly reply: string | null;
      readonly draft: boolean;
      readonly toolSteps: number;
      readonly ms: number;
    }
  | { readonly type: 'error'; readonly message: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const words = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const when = (v: unknown): string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString();
const OUTCOMES: readonly RunOutcome[] = ['replied', 'drafted', 'handed_off', 'no_reply'];

/** One event as the worker sent it, or null when it isn't one this console knows. */
export function parseTestEvent(raw: unknown): TestEvent | null {
  if (!isObj(raw)) return null;
  const at = when(raw.at);
  switch (raw.type) {
    case 'started': {
      const runId = words(raw.runId);
      return runId ? { type: 'started', runId, at } : null;
    }
    case 'delta': {
      const text = str(raw.text);
      return text !== null ? { type: 'delta', text } : null;
    }
    case 'context': {
      const title = words(raw.title);
      return title ? { type: 'context', title, detail: words(raw.detail), at } : null;
    }
    case 'note': {
      const title = words(raw.title);
      return title ? { type: 'note', title, detail: words(raw.detail), at } : null;
    }
    case 'knowledge': {
      const items = Array.isArray(raw.items)
        ? raw.items.flatMap((i) => {
            const title = isObj(i) ? words(i.title) : null;
            return title && isObj(i) ? [{ id: str(i.id) ?? '', title }] : [];
          })
        : [];
      return { type: 'knowledge', query: words(raw.query), items, at };
    }
    case 'tool': {
      const name = words(raw.name);
      return name
        ? { type: 'tool', name, title: words(raw.title) ?? name, detail: words(raw.detail), at }
        : null;
    }
    case 'would': {
      const summary = words(raw.summary);
      const kind = WOULD_KINDS.find((k) => k === raw.kind) ?? 'note';
      return summary ? { type: 'would', kind, summary, at } : null;
    }
    case 'check': {
      const passed = Array.isArray(raw.passed)
        ? raw.passed.filter((r): r is string => typeof r === 'string')
        : [];
      const problems = Array.isArray(raw.problems)
        ? raw.problems.flatMap((p) =>
            isObj(p) && typeof p.rule === 'string'
              ? [{ rule: p.rule, message: str(p.message) ?? '' }]
              : [],
          )
        : [];
      return {
        type: 'check',
        ok: typeof raw.ok === 'boolean' ? raw.ok : problems.length === 0,
        passed,
        problems,
        rewritten: raw.rewritten === true,
        at,
      };
    }
    case 'done': {
      const outcome = OUTCOMES.find((o) => o === raw.outcome);
      return outcome
        ? {
            type: 'done',
            outcome,
            reply: words(raw.reply),
            draft: raw.draft === true,
            toolSteps: num(raw.toolSteps),
            ms: num(raw.ms),
          }
        : null;
    }
    case 'error':
      return { type: 'error', message: words(raw.message) ?? 'The test stopped. Try again.' };
    default:
      return null;
  }
}

/** One event block's `data:` lines as an event; pings, comments and anything unreadable are skipped. */
function parseBlock(block: string): TestEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return parseTestEvent(JSON.parse(data));
  } catch {
    return null;
  }
}

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
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const event = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) onEvent(event);
      }
    }
    const last = parseBlock(buffer);
    if (last) onEvent(last);
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'dropped', 'The connection dropped before the reply finished.');
  } finally {
    reader.releaseLock();
  }
}
