/**
 * The website chat's test world, on top of the booking tests' (booking-world.ts): a business whose owner is
 * Dale, its AI teammate Ava answering website chat at any hour, a widget on lonestarhvac.com (and the local
 * test site), the worker's HTTP server with whatever chat options a test asks for, and a visitor's calls:
 * start, messages, identify, polling, read receipts, heartbeats, and the live stream read over a real socket.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { aiTeammateCreate, chatWidgetCreate, messageSend } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { testDbs } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { CHAT_LIMITS, type ChatLimits } from '../src/chat/limiter';
import { tokenHashOf } from '../src/chat/store';
import type { HandlerMap } from '../src/handlers/types';
import type { ChatHttpOptions } from '../src/http/chat';
import { buildHttpServer } from '../src/http/server';
import { processOnce } from '../src/outbox';
import { admin, makeWorld, run, type World } from './booking-world';

export * from './booking-world';

export const SITE = 'https://lonestarhvac.com';
export const PAGE = '/services/ac-repair';
export const GREETING =
  'Hi, thanks for stopping by. Questions about heating, cooling or your roof?';
export const AWAY = 'We’re away right now. Leave your details and we’ll get back to you.';

/** Room for every test's requests (repeats keep their real rule); limit tests set their own. */
export const ROOMY: ChatLimits = Object.fromEntries(
  Object.entries(CHAT_LIMITS).map(([key, rule]) => [
    key,
    key === 'repeats' ? rule : { max: 10_000, timeWindow: rule.timeWindow },
  ]),
) as unknown as ChatLimits;

/** Turns the teammate off or on, straight in the database (a training teammate needs its start date). */
export async function setTeammateStatus(
  teammateId: string,
  status: 'off' | 'training',
): Promise<void> {
  await rows(
    admin(),
    sql`update app.ai_teammates set status = ${status}::app.ai_teammate_status,
          training_started_at = case when ${status}::text = 'training'
            then coalesce(training_started_at, now()) else training_started_at end
        where id = ${teammateId}`,
  );
}

export interface ChatWorld extends World {
  readonly teammateId: string;
  readonly widgetId: string;
  /** The widget's public key (wk_…). */
  readonly key: string;
}

export async function chatWorld(label: string): Promise<ChatWorld> {
  const w = await makeWorld(label);
  const { teammateId } = await run(w, aiTeammateCreate, {
    workspaceId: w.workspaceId,
    preset: 'lead_responder',
    name: 'Ava',
  });
  // Ava answers website chat, whatever the time.
  await rows(
    admin(),
    sql`update app.ai_teammates
        set config = config || jsonb_build_object(
          'channels', coalesce(config -> 'channels', '{}'::jsonb) || '{"chat": true}'::jsonb,
          'hours', '{"mode": "always"}'::jsonb)
        where id = ${teammateId}`,
  );
  // On, in training (straight in the database: the builder's checks aren't what these tests are about).
  await setTeammateStatus(teammateId, 'training');
  const widget = await run(w, chatWidgetCreate, {
    workspaceId: w.workspaceId,
    allowedOrigins: ['lonestarhvac.com', 'http://localhost:4191'],
    teammateId,
    greeting: GREETING,
    awayMessage: AWAY,
  });
  return Object.assign(w, { teammateId, widgetId: widget.widgetId, key: widget.publicKey });
}

const servers: FastifyInstance[] = [];

/** The worker's HTTP server with these chat options (roomy limits and a fast feed unless the test says). */
export async function chatServer(w: World, chat: ChatHttpOptions = {}): Promise<FastifyInstance> {
  const app = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    chat: { feedIntervalMs: 50, ...chat, limits: { ...ROOMY, ...chat.limits } },
  });
  servers.push(app);
  return app;
}

export async function closeServers(): Promise<void> {
  for (const app of servers.splice(0)) await app.close().catch(() => undefined);
}

/** Listens on a free local port (the stream needs a real socket); returns the port. */
export async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

type Json = Record<string, unknown>;

export const errorOfChat = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string; rule?: string; message: string; details?: unknown } })
    .error;

/** One browser's chat window on one widget: its address and, once started, its token. */
export class Visitor {
  readonly app: FastifyInstance;
  readonly key: string;
  readonly ip: string;
  token: string | null = null;

  constructor(app: FastifyInstance, key: string, ip = '198.51.100.7') {
    this.app = app;
    this.key = key;
    this.ip = ip;
  }

  url(route: string): string {
    return `/public/chat/${this.key}/${route}`;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      'x-forwarded-for': this.ip,
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  get(route: string): Promise<LightMyRequestResponse> {
    return this.app.inject({ method: 'GET', url: this.url(route), headers: this.headers(false) });
  }

  post(route: string, body: unknown): Promise<LightMyRequestResponse> {
    return this.app.inject({
      method: 'POST',
      url: this.url(route),
      headers: this.headers(true),
      payload: JSON.stringify(body),
    });
  }

  /** Starts or picks up the visit, keeping a new token when one comes back. */
  async start(opts: { origin?: string; pagePath?: string } = {}): Promise<LightMyRequestResponse> {
    const res = await this.post('start', {
      origin: opts.origin ?? SITE,
      pagePath: opts.pagePath ?? PAGE,
    });
    if (res.statusCode === 200) {
      const token = (res.json() as { token: string | null }).token;
      if (token) this.token = token;
    }
    return res;
  }

  send(body: string, extra: Json = {}): Promise<LightMyRequestResponse> {
    return this.post('messages', { body, clientId: randomUUID(), pagePath: PAGE, ...extra });
  }

  identify(body: Json): Promise<LightMyRequestResponse> {
    return this.post('identify', body);
  }

  poll(after?: string | null): Promise<LightMyRequestResponse> {
    return this.get(after ? `messages?after=${encodeURIComponent(after)}` : 'messages');
  }

  read(through: string): Promise<LightMyRequestResponse> {
    return this.post('read', { through });
  }

  heartbeat(origin = SITE, pagePath = PAGE): Promise<LightMyRequestResponse> {
    return this.post('heartbeat', { origin, pagePath });
  }
}

/** A started visitor; fails the test when starting doesn't work. */
export async function startedVisitor(
  app: FastifyInstance,
  key: string,
  ip?: string,
): Promise<Visitor> {
  const v = new Visitor(app, key, ip);
  const res = await v.start();
  expect(res.statusCode, res.body).toBe(200);
  return v;
}

/** The visitor's row (by their current token). */
export async function visitorRow(
  v: Visitor,
): Promise<{ id: string; conversation_id: string | null }> {
  const [row] = await rows<{ id: string; conversation_id: string | null }>(
    admin(),
    sql`select id, conversation_id from app.chat_visitors
        where token_hash = decode(${tokenHashOf(v.token!)}, 'hex')`,
  );
  return row!;
}

export async function conversationOf(v: Visitor): Promise<string> {
  const row = await visitorRow(v);
  expect(row.conversation_id).not.toBeNull();
  return row.conversation_id!;
}

/** A reply from Dale in the inbox. */
export function staffReply(w: World, conversationId: string, body: string) {
  return run(w, messageSend, {
    workspaceId: w.workspaceId,
    conversationId,
    channel: 'chat',
    body,
  });
}

/** Runs these handlers over this workspace's waiting events (anything else is marked done untouched). */
export async function processChatEvents(w: World, handlers: HandlerMap) {
  await rows(
    admin(),
    sql`update app.outbox set locked_at = now(), locked_by = ${w.workerId}
        where status = 'pending' and workspace_id = ${w.workspaceId}`,
  );
  const stats = await processOnce({
    ...w.s,
    handlers,
    workerId: w.workerId,
    batchSize: 500,
    reservedOnly: true,
  });
  expect(stats.retried + stats.failed).toBe(0);
  return stats;
}

/** The payload of the event that filed this message. */
export async function receivedPayload(messageId: string): Promise<Json> {
  const [e] = await rows<{ payload: Json }>(
    admin(),
    sql`select payload from app.events where entity_id = ${messageId} and event_type = 'message.received'`,
  );
  return e!.payload;
}

// ---- The stream, over a real socket ----

export interface SseEvent {
  readonly id: string | null;
  readonly data: Json & { readonly type: string };
}

export interface OpenSse {
  readonly status: number;
  readonly events: SseEvent[];
  readonly ended: boolean;
  waitFor(match: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  untilEnded(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openSse(
  port: number,
  v: Visitor,
  opts: { lastEventId?: string } = {},
): Promise<OpenSse> {
  const stop = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${v.url('stream')}`, {
    headers: {
      'x-forwarded-for': v.ip,
      authorization: `Bearer ${v.token}`,
      ...(opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {}),
    },
    signal: stop.signal,
  });
  const events: SseEvent[] = [];
  let ended = false;
  const pump = (async () => {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let id: string | null = null;
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) events.push({ id, data: JSON.parse(data) as SseEvent['data'] });
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      ended = true;
    });
  return {
    status: res.status,
    events,
    get ended() {
      return ended;
    },
    async waitFor(match, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(match);
        if (hit) return hit;
        if (Date.now() > deadline || ended)
          throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.data))}`);
        await pause(20);
      }
    },
    async untilEnded(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ended) {
        if (Date.now() > deadline) throw new Error('the stream stayed open');
        await pause(20);
      }
    },
    async close() {
      stop.abort();
      await pump;
    },
  };
}

/** A message event with this body. */
export const messageWith =
  (body: string) =>
  (e: SseEvent): boolean =>
    e.data.type === 'message' && (e.data['message'] as { body?: string }).body === body;
