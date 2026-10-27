/**
 * LiveKit, which carries HandsFreeOS video calls (docs/video-calls.md), without the network: the worker's settings
 * for it, the tickets it signs, and the webhooks it believes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { LISTENER_IDENTITY } from '@hfos/core';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env';
import { createFakeVideo, fakeVideoWebhook, readFakeTicket } from '../src/video-calls/fake';
import { createLiveKit, reportOf } from '../src/video-calls/livekit';

const KEY = 'APIexample123';
const SECRET = 's'.repeat(43);
const ROOM = 'hf-6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b';
const ANA = '0b6c4e8e-1f2a-4c3d-8e9f-0a1b2c3d4e5f';

/** A webhook as LiveKit signs one: a ticket of its own, carrying the body's SHA-256. */
async function signed(body: string, secret = SECRET): Promise<string> {
  const at = new AccessToken(KEY, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

describe('the worker’s video call settings', () => {
  const base = {
    DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db',
    SMTP_URL: 'smtp://h',
    WORKER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  const production = {
    ...base,
    NODE_ENV: 'production',
    TWILIO_ACCOUNT_SID: 'ACx',
    TWILIO_AUTH_TOKEN: 'y',
    WORKER_PUBLIC_URL: 'https://hooks.example.com',
    POSTMARK_SERVER_TOKEN: 'p',
    POSTMARK_ACCOUNT_TOKEN: 'a',
    POSTMARK_WEBHOOK_PASSWORD: 'w'.repeat(32),
    CHAT_IP_KEY: 'c'.repeat(40),
    TURNSTILE_SECRET_KEY: 't',
  };
  const livekit = {
    LIVEKIT_URL: 'wss://handsfreeos-abc123.livekit.cloud/',
    LIVEKIT_API_KEY: KEY,
    LIVEKIT_API_SECRET: SECRET,
  };

  it('uses the stand-in locally, LiveKit once its keys are there, and calls off in production before then', () => {
    expect(readEnv(base).videoProvider).toBe('fake');
    // No LiveKit yet: the worker starts with calls off rather than refusing to start.
    expect(readEnv(production)).toMatchObject({ videoProvider: 'none', livekitUrl: null });
    expect(readEnv({ ...production, ...livekit })).toMatchObject({
      videoProvider: 'livekit',
      livekitUrl: 'wss://handsfreeos-abc123.livekit.cloud',
      livekitApiKey: KEY,
    });
    // `livekit-server --dev` on a laptop.
    expect(
      readEnv({
        ...base,
        VIDEO_PROVIDER: 'livekit',
        LIVEKIT_URL: 'ws://127.0.0.1:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret',
      }).videoProvider,
    ).toBe('livekit');
  });

  it('says so at deploy when a value is missing or wrong, and never runs the stand-in in production', () => {
    expect(() => readEnv({ ...production, VIDEO_PROVIDER: 'fake' })).toThrow(
      /development and tests/,
    );
    expect(() => readEnv({ ...production, VIDEO_PROVIDER: 'livekit' })).toThrow(/LIVEKIT_URL/);
    expect(() => readEnv({ ...production, LIVEKIT_URL: livekit.LIVEKIT_URL })).toThrow(
      /go together/,
    );
    expect(() =>
      readEnv({ ...production, ...livekit, LIVEKIT_URL: 'ws://handsfreeos-abc123.livekit.cloud' }),
    ).toThrow(/wss:\/\//);
    expect(() =>
      readEnv({ ...production, ...livekit, LIVEKIT_URL: 'https://handsfreeos.livekit.cloud' }),
    ).toThrow(/LIVEKIT_URL/);
    expect(() => readEnv({ ...base, VIDEO_PROVIDER: 'zoom' })).toThrow(/VIDEO_PROVIDER/);
    expect(readEnv({ ...base, VIDEO_PROVIDER: 'none' }).videoProvider).toBe('none');
  });
});

describe('LiveKit', () => {
  const lk = createLiveKit({
    url: 'wss://handsfreeos-abc123.livekit.cloud',
    apiKey: KEY,
    apiSecret: SECRET,
  });

  it('signs a ticket into one room, for one person, for a few minutes', async () => {
    const t = await lk.ticket({
      room: ROOM,
      identity: ANA,
      name: 'Ana Customer',
      kind: 'customer',
    });
    expect(t.url).toBe('wss://handsfreeos-abc123.livekit.cloud');
    const claims = await new TokenVerifier(KEY, SECRET).verify(t.token);
    expect(claims).toMatchObject({
      sub: ANA,
      name: 'Ana Customer',
      attributes: { 'hfos.kind': 'customer' },
      video: {
        roomJoin: true,
        room: ROOM,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: true,
      },
    });
    // Never a room's admin: taking people out goes through HandsFreeOS.
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(15 * 60);
    expect(claims.roomConfig).toMatchObject({ departureTimeout: 120, maxParticipants: 12 });
    await expect(new TokenVerifier(KEY, 'x'.repeat(43)).verify(t.token)).rejects.toThrow();
  });

  it('lets the AI’s listener in unseen, hearing everyone and sending only captions', async () => {
    const t = await lk.listenerTicket(ROOM);
    const claims = await new TokenVerifier(KEY, SECRET).verify(t.token);
    expect(claims).toMatchObject({
      sub: LISTENER_IDENTITY,
      kind: 'agent',
      video: {
        roomJoin: true,
        room: ROOM,
        hidden: true,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
      },
    });
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.video?.canUpdateOwnMetadata).toBeFalsy();
  });

  it('believes a webhook only when it’s signed with our key and its body is as signed', async () => {
    const body = JSON.stringify({
      event: 'participant_joined',
      id: 'EV_joined',
      createdAt: '1761530000',
      room: { sid: 'RM_one', name: ROOM },
      participant: { sid: 'PA_one', identity: ANA },
    });
    expect(await lk.readReport(body, await signed(body))).toEqual({
      event: 'joined',
      id: 'EV_joined',
      room: ROOM,
      roomSid: 'RM_one',
      identity: ANA,
      participantSid: 'PA_one',
      at: new Date(1761530000_000).toISOString(),
    });
    expect(await lk.readReport(`${body} `, await signed(body))).toBeNull();
    expect(await lk.readReport(body, await signed(body, 'x'.repeat(43)))).toBeNull();
    expect(await lk.readReport(body, undefined)).toBeNull();
    expect(await lk.readReport('not json', await signed('not json'))).toBeNull();
  });

  it('reads who came and went, and a room closing; the rest is nothing to do', () => {
    const room = { sid: 'RM_one', name: ROOM };
    const participant = { sid: 'PA_one', identity: ANA };
    expect(reportOf({ event: 'participant_left', id: 'a', room, participant }).event).toBe('left');
    expect(
      reportOf({ event: 'participant_connection_aborted', id: 'b', room, participant }).event,
    ).toBe('left');
    expect(reportOf({ event: 'room_finished', id: 'c', room, createdAt: 10 })).toEqual({
      event: 'finished',
      id: 'c',
      room: ROOM,
      roomSid: 'RM_one',
      at: new Date(10_000).toISOString(),
    });
    expect(reportOf({ event: 'room_started', id: 'd', room })).toEqual({ event: 'other', id: 'd' });
    expect(reportOf({ event: 'track_published', id: 'e', room, participant }).event).toBe('other');
  });
});

describe('the stand-in', () => {
  it('keeps what it was asked, and believes only its own webhooks', async () => {
    const fake = createFakeVideo();
    const t = await fake.ticket({ room: ROOM, identity: ANA, name: 'Ana', kind: 'customer' });
    expect(t.url).toBe('fake:');
    expect(readFakeTicket(t.token)).toEqual({
      room: ROOM,
      identity: ANA,
      name: 'Ana',
      kind: 'customer',
    });
    await fake.remove(ROOM, ANA);
    expect(await fake.mute(ROOM, ANA)).toBe(true);
    await fake.close(ROOM);
    expect(fake.removed).toEqual([{ room: ROOM, identity: ANA }]);
    expect(fake.muted).toEqual([{ room: ROOM, identity: ANA }]);
    expect(fake.closed).toEqual([ROOM]);

    const hook = fakeVideoWebhook({
      event: 'participant_joined',
      id: 'EV_1',
      createdAt: 1761530000n,
      room: { sid: 'RM_one', name: ROOM },
      participant: { sid: 'PA_one', identity: ANA },
    });
    expect(await fake.readReport(hook.body, hook.authorization)).toMatchObject({
      event: 'joined',
      identity: ANA,
    });
    expect(await fake.readReport(hook.body, 'wrong')).toBeNull();
  });
});
