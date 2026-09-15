'use client';
/**
 * The chat window's connection to the worker's public chat routes (apps/worker/src/http/chat.ts), used by
 * /chat/<key> for real visitors. The preview page uses lib/chat/preview.ts instead.
 *
 * The visitor's token lives in this window's own storage, on our origin (browsers partition it by the site the
 * window is embedded in). It goes only to the worker, as a bearer header, and never to the page around the
 * window. `start` may hand out a new one (a week old, or the previous one inside its grace): it's kept at once.
 */
import { ApiError } from '../api/errors';
import { publicEnv } from '../env';

export type ChatSender = 'visitor' | 'teammate' | 'person' | 'business';

export interface ChatMessage {
  readonly id: string;
  readonly from: ChatSender;
  /** The teammate's name or the person's first name; null for the visitor and the business. */
  readonly name: string | null;
  readonly body: string;
  readonly at: string;
  /** A person's first message in this chat ("Dale joined"). */
  readonly joined: boolean;
}

/** Which details the visitor has given; never the details themselves. */
export interface Gave {
  readonly name: boolean;
  readonly phone: boolean;
  readonly email: boolean;
}

/** Cloudflare Turnstile: `required` when the next message needs it; a null site key means this app's own. */
export interface HumanCheck {
  readonly siteKey: string | null;
  readonly required: boolean;
}

export interface Started {
  /** A new token, or null to keep the one sent. */
  readonly token: string | null;
  readonly resumed: boolean;
  /** They've written before: the stream can open. */
  readonly chatStarted: boolean;
  readonly gave: Gave;
  readonly humanCheck: HumanCheck | null;
  readonly messages: readonly ChatMessage[];
  readonly cursor: string | null;
  readonly typing: boolean;
}

export interface Sent {
  readonly message: ChatMessage | null;
  readonly cursor: string | null;
  readonly duplicate: boolean;
  readonly newChat: boolean;
  readonly humanCheck: HumanCheck | null;
}

export interface Polled {
  readonly messages: readonly ChatMessage[];
  readonly cursor: string | null;
  readonly typing: boolean;
}

export type StreamEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'message'; readonly message: ChatMessage; readonly cursor: string | null }
  | { readonly type: 'typing'; readonly name: string | null }
  | { readonly type: 'joined'; readonly name: string | null }
  | { readonly type: 'bye'; readonly reason: 'expired' | 'shutdown' };

export interface SendInput {
  readonly body: string;
  readonly clientId: string;
  readonly pagePath?: string;
  readonly turnstileToken?: string;
  readonly honeypot?: string;
}

export interface IdentifyInput {
  readonly name?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly smsConsent: boolean;
  readonly turnstileToken?: string;
  readonly honeypot?: string;
}

/** A refusal from the chat routes: `rule` says which (chat_not_found, rate_limited, daily_cap, …). */
export class ChatError extends ApiError {}

const UNREACHABLE = 'We couldn’t reach the chat. Check your connection and try again.';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const SENDERS: readonly ChatSender[] = ['visitor', 'teammate', 'person', 'business'];

export function parseMessage(raw: unknown): ChatMessage | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const from = SENDERS.find((s) => s === raw.from);
  if (!id || !from) return null;
  return {
    id,
    from,
    name: str(raw.name),
    body: str(raw.body) ?? '',
    at: str(raw.at) ?? new Date().toISOString(),
    joined: raw.joined === true,
  };
}

const messagesOf = (v: unknown): ChatMessage[] =>
  Array.isArray(v) ? v.flatMap((m) => parseMessage(m) ?? []) : [];

function humanCheckOf(v: unknown): HumanCheck | null {
  return isObj(v) ? { siteKey: str(v.siteKey), required: v.required === true } : null;
}

function refusal(res: Response, json: unknown): ChatError {
  const err = isObj(json) && isObj(json.error) ? json.error : {};
  return new ChatError(
    res.status,
    str(err.code) ?? (res.status === 404 ? 'not_found' : 'internal'),
    str(err.message) ?? 'Something went wrong. Please try again.',
    str(err.rule) ?? undefined,
    err.details,
  );
}

/** One event block: its `id:` (a message's cursor) and its `data:` JSON; pings and anything unknown are skipped. */
function parseBlock(block: string): StreamEvent | null {
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim() || null;
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'ready':
      return { type: 'ready' };
    case 'message': {
      const message = parseMessage(raw.message);
      return message ? { type: 'message', message, cursor: id } : null;
    }
    case 'typing':
    case 'joined':
      return { type: raw.type, name: str(raw.name) };
    case 'bye':
      return { type: 'bye', reason: raw.reason === 'shutdown' ? 'shutdown' : 'expired' };
    default:
      return null;
  }
}

const storageKey = (key: string) => `hfos-chat:${key}`;

function readToken(key: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

function writeToken(key: string, token: string | null): void {
  try {
    if (token) window.localStorage.setItem(storageKey(key), token);
    else window.localStorage.removeItem(storageKey(key));
  } catch {
    // Storage is off (a private window, blocked site data): the token lives as long as this window.
  }
}

export type ChatClient = ReturnType<typeof chatClient>;

/** The public chat routes for one widget key. */
export function chatClient(key: string) {
  const base = `${publicEnv.workerUrl}/public/chat/${encodeURIComponent(key)}`;
  let token = readToken(key);
  const auth = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}/${path}`, {
        method,
        headers: {
          ...auth(),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw new ChatError(0, 'unreachable', UNREACHABLE);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw refusal(res, json);
    return json as T;
  }

  return {
    hasToken: () => token !== null,
    /** The token wasn't recognised (chat_not_found): the next `start` begins a new visit. */
    forget() {
      token = null;
      writeToken(key, null);
    },

    async start(origin: string, pagePath: string | null): Promise<Started> {
      const raw = await call<Obj>('POST', 'start', {
        origin,
        ...(pagePath ? { pagePath } : {}),
      });
      const next = str(raw.token);
      if (next) {
        token = next;
        writeToken(key, next);
      }
      const gave = isObj(raw.gave) ? raw.gave : {};
      return {
        token: next,
        resumed: raw.resumed === true,
        chatStarted: raw.chatStarted === true,
        gave: { name: gave.name === true, phone: gave.phone === true, email: gave.email === true },
        humanCheck: humanCheckOf(raw.humanCheck),
        messages: messagesOf(raw.messages),
        cursor: str(raw.cursor),
        typing: raw.typing === true,
      };
    },

    async send(input: SendInput): Promise<Sent> {
      const raw = await call<Obj>('POST', 'messages', input);
      return {
        message: parseMessage(raw.message),
        cursor: str(raw.cursor),
        duplicate: raw.duplicate === true,
        newChat: raw.newChat === true,
        humanCheck: humanCheckOf(raw.humanCheck),
      };
    },

    async identify(input: IdentifyInput): Promise<Gave> {
      const raw = await call<Obj>('POST', 'identify', input);
      const gave = isObj(raw.gave) ? raw.gave : {};
      return { name: gave.name === true, phone: gave.phone === true, email: gave.email === true };
    },

    async poll(after: string | null): Promise<Polled> {
      const raw = await call<Obj>(
        'GET',
        `messages${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      );
      return {
        messages: messagesOf(raw.messages),
        cursor: str(raw.cursor),
        typing: raw.typing === true,
      };
    },

    read: (through: string) => call<{ ok: boolean }>('POST', 'read', { through }),

    heartbeat: (origin: string, pagePath: string | null) =>
      call<{ ok: boolean }>('POST', 'heartbeat', { origin, ...(pagePath ? { pagePath } : {}) }),

    /**
     * Listens to the live stream until it ends (the worker closes it after 5 minutes with `bye`, or on shutdown).
     * EventSource can't send the token, so this reads it from fetch, sending where it got to as Last-Event-ID.
     * Refusals before the stream starts throw a ChatError; a dropped connection just returns.
     */
    async stream(
      after: string | null,
      onEvent: (event: StreamEvent) => void,
      signal: AbortSignal,
    ): Promise<void> {
      let res: Response;
      try {
        res = await fetch(`${base}/stream`, {
          headers: {
            ...auth(),
            accept: 'text/event-stream',
            ...(after ? { 'last-event-id': after } : {}),
          },
          cache: 'no-store',
          credentials: 'omit',
          signal,
        });
      } catch {
        if (signal.aborted) return;
        throw new ChatError(0, 'unreachable', UNREACHABLE);
      }
      if (!res.ok) throw refusal(res, await res.json().catch(() => null));
      if (!res.body) throw new ChatError(0, 'unreachable', UNREACHABLE);
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
        // Dropped or aborted: the caller reconnects (or has gone).
      } finally {
        reader.releaseLock();
      }
    },
  };
}
