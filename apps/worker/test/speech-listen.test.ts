/**
 * The Assistant's smart listening (GET /v1/speech/listen), on the real database with the stand-in speech: one turn
 * streamed live and heard as it comes, the words sent back the moment the listener says they've finished, Done
 * sending what's been heard so far, and the same doors as a recording (permission, set up, balance). It asks the
 * listener for Flux's smart turns on clear 16 kHz sound, and bills the seconds streamed as live listening.
 */
import { createTokenVerifier } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { createFakeSpeech } from '../src/voice-agent/fake-speech';
import type { ListenOptions, SpeechServices } from '../src/voice-agent/speech';
import { admin, teammateWorld, type TeammateWorld } from './ai-team-world';
import { setBalance } from './helpers';

const env = testEnv();
let w: TeammateWorld;
let app: FastifyInstance;
let off: FastifyInstance;
let ownerToken: string;
let outsiderToken: string;
const asked: (ListenOptions | undefined)[] = [];

type Message = Record<string, unknown> & { type: string };

async function serve(speech: SpeechServices | null): Promise<FastifyInstance> {
  const server = await buildHttpServer({
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
    speech,
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  return server;
}

beforeAll(async () => {
  w = await teammateWorld('speechlive');
  const fake = createFakeSpeech();
  app = await serve({
    ...fake,
    listen: (handlers, options) => {
      asked.push(options);
      return fake.listen(handlers, options);
    },
  });
  off = await serve(null);
  const outsider = await createTestUser('speechlive-outsider', { fullName: 'Olive Outsider' });
  [ownerToken, outsiderToken] = await Promise.all([
    signInTestUser(w.owner),
    signInTestUser(outsider),
  ]);
});
afterAll(async () => {
  await app.close();
  await off.close();
  await w.app.close();
  await closeTestDbs();
});

async function waitFor<T>(what: string, get: () => T | null | undefined | false, ms = 8_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The browser's end: opens the socket, says who it is, and keeps every message. */
async function openListening(token: string, server = app) {
  const port = (server.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/speech/listen`);
  const messages: Message[] = [];
  let closed = false;
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as Message));
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'start', token, workspaceId: w.workspaceId }));
  return {
    ws,
    messages,
    closed: () => closed,
    of: (type: string) => messages.find((m) => m.type === type),
  };
}

const tally = () =>
  rows<{ rate_key: string; quantity: string; source: string }>(
    admin(),
    sql`select rate_key, quantity::text, source from app.speech_usage
        where workspace_id = ${w.workspaceId} order by created_at`,
  );

describe('listening live', () => {
  it('hears a turn as it comes, and sends the words once they’ve finished', async () => {
    const before = (await tally()).length;
    const l = await openListening(ownerToken);
    await waitFor('ready', () => l.of('ready'));
    // The stand-in takes words sent as text as the turn, finished.
    l.ws.send(Buffer.from('Block off today and tomorrow', 'utf8'));
    const turn = await waitFor('the turn', () => l.of('turn'));
    expect(turn).toEqual({ type: 'turn', text: 'Block off today and tomorrow', language: 'en' });
    expect(l.messages.map((m) => m.type)).toEqual(['ready', 'talking', 'turn']);
    await waitFor('the socket to close', l.closed);
    // Flux's smart turns, on clear sound.
    expect(asked.at(-1)).toEqual({ audio: 'wide', smartTurns: true });
    // Billed as live listening, on the bytes streamed.
    let added = (await tally()).slice(before);
    for (let i = 0; i < 40 && !added.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      added = (await tally()).slice(before);
    }
    expect(added.map((r) => [r.rate_key, r.source])).toEqual([['speech.live.minute', 'talk']]);
  });

  it('sends what it has heard so far when they press Done', async () => {
    const l = await openListening(ownerToken);
    await waitFor('ready', () => l.of('ready'));
    // A sound, then the start of their words, not yet finished.
    l.ws.send(Buffer.from('[talking]', 'utf8'));
    await waitFor('talking', () => l.of('talking'));
    l.ws.send(JSON.stringify({ type: 'done' }));
    const turn = await waitFor('the turn', () => l.of('turn'));
    expect(turn).toEqual({ type: 'turn', text: 'Wait', language: 'en' });
  });

  it('says nothing was heard when Done comes before any words', async () => {
    const l = await openListening(ownerToken);
    await waitFor('ready', () => l.of('ready'));
    l.ws.send(JSON.stringify({ type: 'done' }));
    expect(await waitFor('the turn', () => l.of('turn'))).toEqual({
      type: 'turn',
      text: '',
      language: null,
    });
  });
});

describe('who can listen', () => {
  it('refuses someone outside the business, and says why', async () => {
    const l = await openListening(outsiderToken);
    const error = await waitFor('the refusal', () => l.of('error'));
    expect(error).toMatchObject({ type: 'error', rule: 'forbidden' });
    await waitFor('the socket to close', l.closed);
  });

  it('refuses a token that isn’t a sign-in', async () => {
    const l = await openListening('not-a-token');
    expect(await waitFor('the refusal', () => l.of('error'))).toMatchObject({ type: 'error' });
  });

  it('says talking out loud isn’t set up when there’s no speech', async () => {
    const l = await openListening(ownerToken, off);
    expect(await waitFor('the refusal', () => l.of('error'))).toMatchObject({
      rule: 'speech_not_configured',
    });
  });

  it('stops when the balance has run out', async () => {
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const was = await setBalance(scope, 0);
    try {
      const l = await openListening(ownerToken);
      expect(await waitFor('the refusal', () => l.of('error'))).toMatchObject({
        rule: 'wallet_empty',
      });
    } finally {
      await setBalance(scope, was);
    }
  });
});
