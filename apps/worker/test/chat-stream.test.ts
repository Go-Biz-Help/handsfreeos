/**
 * The website chat's live delivery (M7 step 8), over a real socket: the stream needs a started chat; a staff
 * reply reaches an open stream with "Dale joined" first; the AI teammate's "typing" and reply arrive; polling
 * catches up; reconnecting with Last-Event-ID misses nothing; a stream ends after its time, and every stream
 * closes cleanly on shutdown. Nothing about the customer the chat matched ever arrives.
 */
import { randomUUID } from 'node:crypto';
import { personCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  chatServer,
  chatWorld,
  closeServers,
  conversationOf,
  errorOfChat,
  listen,
  messageWith,
  nextPhone,
  openSse,
  run,
  staffReply,
  startedVisitor,
  type ChatWorld,
  type SseEvent,
} from './chat-world';

let w: ChatWorld;
let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  w = await chatWorld('chat-stream');
  app = await chatServer(w);
  port = await listen(app);
});
afterAll(async () => {
  await closeServers();
  await closeTestDbs();
});

type Message = { id: string; from: string; name: string | null; body: string; joined: boolean };
const messageOf = (e: SseEvent) => e.data['message'] as Message;

describe('the stream', () => {
  it('opens only once the visitor has written', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.30');
    const early = await v.get('stream');
    expect(early.statusCode).toBe(409);
    expect(errorOfChat(early).rule).toBe('chat_not_started');
  });

  it('brings a staff reply live with "Dale joined" first, then Ava’s typing and reply; polling sees the same', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.31');
    const sent = (await v.send('Is anyone there?')).json() as { cursor: string };
    const conversationId = await conversationOf(v);
    const s = await openSse(port, v);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.data.type === 'ready');

    await staffReply(w, conversationId, 'Hi, Dale here. How can I help?');
    const reply = await s.waitFor(messageWith('Hi, Dale here. How can I help?'));
    expect(messageOf(reply)).toMatchObject({ from: 'person', name: 'Dale', joined: true });
    expect(reply.id).toMatch(/^\d+\.[0-9a-f-]{36}$/);
    const joinedAt = s.events.findIndex((e) => e.data.type === 'joined');
    expect(s.events[joinedAt]?.data).toEqual({ type: 'joined', name: 'Dale' });
    expect(joinedAt).toBeLessThan(s.events.indexOf(reply));

    // Dale's second message: no second "joined".
    await staffReply(w, conversationId, 'Are you in 77008?');
    expect(messageOf(await s.waitFor(messageWith('Are you in 77008?')))).toMatchObject({
      joined: false,
    });
    expect(s.events.filter((e) => e.data.type === 'joined')).toHaveLength(1);

    // Ava writing, as the runtime signals it, then her reply.
    await rows(
      admin(),
      sql`insert into app.chat_signals (workspace_id, conversation_id) values (${w.workspaceId}, ${conversationId})`,
    );
    expect((await s.waitFor((e) => e.data.type === 'typing')).data).toEqual({
      type: 'typing',
      name: 'Ava',
    });
    const avaSays = 'I’m Ava, Lone Star’s AI assistant. What’s your ZIP code?';
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
            sent_by_teammate_id, sent_at)
          values (${w.workspaceId}, ${conversationId}, 'chat', 'outbound', 'sent', ${avaSays}, ${w.teammateId}, now())`,
    );
    expect(messageOf(await s.waitFor(messageWith(avaSays)))).toMatchObject({
      from: 'teammate',
      name: 'Ava',
      joined: false,
    });
    // Each message arrives once.
    const ids = s.events.filter((e) => e.data.type === 'message').map((e) => messageOf(e).id);
    expect(new Set(ids).size).toBe(ids.length);
    await s.close();

    // Polling after the visitor's own message catches everything up, and sees Ava still typing.
    const polled = (await v.poll(sent.cursor)).json() as {
      messages: Message[];
      cursor: string;
      typing: boolean;
    };
    expect(polled.messages.map((m) => m.body)).toEqual(
      expect.arrayContaining(['Hi, Dale here. How can I help?', 'Are you in 77008?', avaSays]),
    );
    expect(polled.typing).toBe(true);
    expect(polled.cursor).toMatch(/^\d+\.[0-9a-f-]{36}$/);
    // Up to date: nothing new beyond the overlap.
    const later = (await v.poll(polled.cursor)).json() as { messages: Message[] };
    expect(later.messages.every((m) => polled.messages.some((p) => p.id === m.id))).toBe(true);
  });

  it('misses nothing when the window reconnects with Last-Event-ID', async () => {
    const v = await startedVisitor(app, w.key, '198.51.100.32');
    await v.send('Hello?');
    const conversationId = await conversationOf(v);
    const first = await openSse(port, v);
    await first.waitFor((e) => e.data.type === 'ready');
    await staffReply(w, conversationId, 'One moment please.');
    const seen = await first.waitFor(messageWith('One moment please.'));
    await first.close();
    // While the window was away.
    await staffReply(w, conversationId, 'Thanks for waiting.');
    await staffReply(w, conversationId, 'We can come Thursday.');
    const again = await openSse(port, v, { lastEventId: seen.id! });
    await again.waitFor(messageWith('Thanks for waiting.'));
    await again.waitFor(messageWith('We can come Thursday.'));
    // And live again after that.
    await staffReply(w, conversationId, 'Does 1 PM work?');
    await again.waitFor(messageWith('Does 1 PM work?'));
    await again.close();
  });

  it('never carries anything about the customer the chat matched', async () => {
    const phone = nextPhone();
    const email = `rosa-${randomUUID().slice(0, 6)}@example.com`;
    const rosa = await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Rosalind',
      lastName: 'Quintero',
      phone,
      email,
    });
    const v = await startedVisitor(app, w.key, '198.51.100.33');
    await v.send('Can you cancel my visit?');
    expect((await v.identify({ phone })).statusCode).toBe(200);
    const conversationId = await conversationOf(v);
    const s = await openSse(port, v);
    await s.waitFor((e) => e.data.type === 'ready');
    await staffReply(w, conversationId, 'We’ll text the number on file to confirm.');
    await s.waitFor(messageWith('We’ll text the number on file to confirm.'));
    await s.close();
    const all = JSON.stringify(s.events);
    for (const secret of ['Rosalind', 'Quintero', email, rosa.personId, phone.slice(2)])
      expect(all).not.toContain(secret);
  });

  it('ends after its time with a goodbye, so the window reconnects', async () => {
    const short = await chatServer(w, { streamMs: 300 });
    const shortPort = await listen(short);
    const v = await startedVisitor(short, w.key, '198.51.100.34');
    await v.send('Quick question');
    const s = await openSse(shortPort, v);
    await s.untilEnded(3_000);
    // Ready first and goodbye last; in between only messages (the visitor's own one, fresh in the feed).
    expect(s.events[0]?.data).toEqual({ type: 'ready' });
    expect(s.events.at(-1)?.data).toEqual({ type: 'bye', reason: 'expired' });
    expect(s.events.slice(1, -1).every((e) => e.data.type === 'message')).toBe(true);
  });

  it('closes every open stream cleanly when the worker shuts down', async () => {
    const srv = await chatServer(w);
    const srvPort = await listen(srv);
    const a = await startedVisitor(srv, w.key, '198.51.100.35');
    await a.send('First window');
    const b = await startedVisitor(srv, w.key, '198.51.100.36');
    await b.send('Second window');
    const streams = [await openSse(srvPort, a), await openSse(srvPort, b)];
    for (const s of streams) await s.waitFor((e) => e.data.type === 'ready');
    const started = Date.now();
    await srv.close();
    expect(Date.now() - started).toBeLessThan(3_000);
    for (const s of streams) {
      await s.untilEnded(3_000);
      expect(s.events.at(-1)?.data).toEqual({ type: 'bye', reason: 'shutdown' });
    }
  });
});
