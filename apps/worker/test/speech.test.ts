/**
 * Talking out loud (the Assistant's voice mode and the test console's calls): POST /v1/speech/hear turns one
 * recording into words and POST /v1/speech/say answers a clip to play, on the real database with the stand-in
 * speech. They need assistant.use or ai_team.manage; a clip is in the voice asked for, or the AI teammate's own
 * saved phone voice; and with no speech services they say talking out loud isn't set up.
 */
import { createTokenVerifier } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, signInTestUser, testDbs, testEnv } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { clipListenParams, heardClipOf } from '../src/voice-agent/deepgram-speech';
import { createFakeSpeech, FAKE_HEARD, silentWav } from '../src/voice-agent/fake-speech';
import type { SpeechServices } from '../src/voice-agent/speech';
import { admin, saveTeammate, teammateWorld, type TeammateWorld } from './ai-team-world';
import { setBalance } from './helpers';

const env = testEnv();
let w: TeammateWorld;
let app: FastifyInstance;
let off: FastifyInstance;
let tight: FastifyInstance;
let ownerToken: string;
let memberToken: string;
let outsiderToken: string;
const voices: string[] = [];

beforeAll(async () => {
  w = await teammateWorld('speech');
  const fake = createFakeSpeech();
  const speech: SpeechServices = {
    ...fake,
    voiceClip: (text, options) => {
      voices.push(options.voice);
      return fake.voiceClip(text, options);
    },
  };
  const base = {
    ...w.s,
    httpDb: testDbs().worker.db,
    verifyToken: createTokenVerifier({
      jwksUrl: `${env.supabaseUrl}/auth/v1/.well-known/jwks.json`,
      jwtIssuer: `${env.supabaseUrl}/auth/v1`,
    }),
    webOrigins: ['http://localhost:3000'],
  };
  app = await buildHttpServer({ ...base, speech });
  off = await buildHttpServer({ ...base, speech: null });
  tight = await buildHttpServer({
    ...base,
    speech,
    speechLimits: { hear: { max: 2, timeWindow: 60_000 }, say: { max: 1, timeWindow: 60_000 } },
  });
  const member = await createTestUser('speech-member', { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  const outsider = await createTestUser('speech-outsider', { fullName: 'Olive Outsider' });
  [ownerToken, memberToken, outsiderToken] = await Promise.all([
    signInTestUser(w.owner),
    signInTestUser(member),
    signInTestUser(outsider),
  ]);
});
afterAll(async () => {
  await app.close();
  await off.close();
  await tight.close();
  await w.app.close();
  await closeTestDbs();
});

function hear(
  token: string | null,
  body: string | Buffer,
  contentType = 'text/plain',
  server = app,
) {
  return server.inject({
    method: 'POST',
    url: `/v1/speech/hear?workspaceId=${w.workspaceId}`,
    headers: {
      'content-type': contentType,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body,
  });
}

function say(token: string | null, body: Record<string, unknown>, server = app) {
  return server.inject({
    method: 'POST',
    url: '/v1/speech/say',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { workspaceId: w.workspaceId, ...body },
  });
}

describe('hearing a recording', () => {
  it('needs someone who may use the Assistant or test the AI teammate', async () => {
    expect((await hear(null, 'Hi')).statusCode).toBe(401);
    const res = await hear(outsiderToken, 'Hi');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('answers the words in it, and the language they were in', async () => {
    const res = await hear(memberToken, 'What needs my attention today?');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'What needs my attention today?', language: 'en' });
    expect((await hear(ownerToken, '[es] ¿Tienen citas el jueves?')).json()).toEqual({
      text: '¿Tienen citas el jueves?',
      language: 'es',
    });
  });

  it('takes the recording as the app made it', async () => {
    const res = await hear(
      ownerToken,
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      'audio/webm;codecs=opus',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: FAKE_HEARD, language: 'en' });
  });

  it('refuses nothing at all, and anything that isn’t a recording', async () => {
    const empty = await hear(ownerToken, Buffer.alloc(0), 'audio/mp4');
    expect(empty.statusCode).toBe(400);
    const json = await hear(ownerToken, JSON.stringify({ text: 'Hi' }), 'application/json');
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({
      error: { code: 'validation', details: [{ path: 'body', message: 'Send a recording.' }] },
    });
  });
});

describe('saying a clip', () => {
  it('answers audio to play, in the AI teammate’s own voice unless one is asked for', async () => {
    await saveTeammate(w, { phone: { voice: 'bright' } });
    voices.length = 0;
    const res = await say(ownerToken, { text: 'Thanks for calling. How can I help?' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^audio\/wav/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    const asked = await say(memberToken, { text: 'You have three visits today.', voice: 'calm' });
    expect(asked.statusCode).toBe(200);
    expect(voices).toEqual(['bright', 'calm']);
  });

  it('needs the same people, and something to say', async () => {
    expect((await say(null, { text: 'Hi' })).statusCode).toBe(401);
    expect((await say(outsiderToken, { text: 'Hi' })).statusCode).toBe(403);
    expect((await say(ownerToken, { text: '  ' })).statusCode).toBe(400);
    expect((await say(ownerToken, { text: 'x'.repeat(1001) })).statusCode).toBe(400);
  });
});

describe('what it costs', () => {
  const tally = () =>
    rows<{ rate_key: string; quantity: string; source: string }>(
      admin(),
      sql`select rate_key, quantity::text, source from app.speech_usage
          where workspace_id = ${w.workspaceId} order by created_at`,
    );

  it('adds what was heard and said to the business’s running totals', async () => {
    const before = (await tally()).length;
    // Five words is two seconds to the stand-in.
    await hear(ownerToken, 'Do you have Thursday open?');
    await say(ownerToken, { text: 'Yes, Thursday at 10.' });
    const added = (await tally()).slice(before);
    expect(added.map((r) => [r.rate_key, r.source])).toEqual([
      ['speech.recording.minute', 'talk'],
      ['speech.voice.kchar', 'talk'],
    ]);
    expect(Number(added[0]!.quantity)).toBeCloseTo(2 / 60, 5);
    // 20 characters, in thousands.
    expect(Number(added[1]!.quantity)).toBe(0.02);
  });

  it('stops when the balance has run out and the wallet is enforced, as the rest of the AI does', async () => {
    // A new business is Stopped at zero already, with $5 to start: spending it is all that's left.
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const was = await setBalance(scope, 0);
    try {
      for (const res of [await hear(ownerToken, 'Hi'), await say(ownerToken, { text: 'Hi' })]) {
        expect(res.statusCode).toBe(402);
        expect(res.json()).toMatchObject({ error: { rule: 'wallet_empty' } });
      }
    } finally {
      await setBalance(scope, was);
    }
  });
});

describe('the allowance', () => {
  it('stops someone talking far more than a person can, and counts each person apart', async () => {
    expect((await hear(ownerToken, 'One', 'text/plain', tight)).statusCode).toBe(200);
    expect((await hear(ownerToken, 'Two', 'text/plain', tight)).statusCode).toBe(200);
    const third = await hear(ownerToken, 'Three', 'text/plain', tight);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { rule: 'rate_limited' } });
    expect((await hear(memberToken, 'Hi', 'text/plain', tight)).statusCode).toBe(200);
    expect((await say(ownerToken, { text: 'Hi' }, tight)).statusCode).toBe(200);
    expect((await say(ownerToken, { text: 'Hi' }, tight)).statusCode).toBe(429);
  });
});

describe('with nobody to listen or speak', () => {
  it('says talking out loud isn’t set up', async () => {
    for (const res of [
      await hear(ownerToken, 'Hi', 'text/plain', off),
      await say(ownerToken, { text: 'Hi' }, off),
    ]) {
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { rule: 'speech_not_configured' } });
    }
  });
});

describe('Deepgram’s side', () => {
  it('hears a clip in English or Spanish without being told which', () => {
    expect(Object.fromEntries(clipListenParams())).toMatchObject({
      model: 'nova-3',
      language: 'multi',
      smart_format: 'true',
    });
    expect(
      heardClipOf({
        results: {
          channels: [{ alternatives: [{ transcript: ' Hola. ', languages: ['es'] }] }],
        },
      }),
    ).toEqual({ text: 'Hola.', language: 'es', seconds: 0 });
    // How long the recording was is what hearing it is billed on.
    expect(heardClipOf({ metadata: { duration: 3.2 } }).seconds).toBe(3.2);
    expect(heardClipOf({})).toEqual({ text: '', language: null, seconds: 0 });
  });

  it('the stand-in’s clip is a real, quiet WAV', () => {
    const wav = silentWav(0.5);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.length).toBe(44 + 8000);
  });
});
