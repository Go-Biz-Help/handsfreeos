import { registry } from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEnv } from '../src/env';
import { testApp } from './helpers';

describe('GET /healthz', () => {
  let app: Awaited<ReturnType<typeof testApp>>;
  beforeAll(async () => {
    app = await testApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDbs();
  });

  it('reports ok and echoes a correlation id', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: 'api' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a caller-supplied correlation id only when it is a UUID', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const kept = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': id },
    });
    expect(kept.headers['x-correlation-id']).toBe(id);
    const replaced = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': 'not-a-uuid; drop table' },
    });
    expect(replaced.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.headers['x-correlation-id']).not.toContain('drop');
  });

  it('serves the OpenAPI document with every command people run and every query', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json().paths);
    const forPeople = registry.commands.filter((c) => (c.actors ?? ['human']).includes('human'));
    const expected = [
      ...forPeople.map((c) => `/v1/commands/${c.name}`),
      ...registry.queries.map((q) => `/v1/queries/${q.name}`),
    ];
    expect(paths).toEqual(expect.arrayContaining(expected));
    expect(paths.filter((p) => p.startsWith('/v1/'))).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThanOrEqual(71);
  });

  it('keeps worker-only commands (carrier answers, inbound texts) off the public API', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const paths = Object.keys(res.json().paths);
    const workerOnly = registry.commands
      .filter((c) => !(c.actors ?? ['human']).includes('human'))
      .map((c) => c.name);
    expect(workerOnly).toEqual(
      expect.arrayContaining(['message.receive', 'message.update_status', 'phone_number.activate']),
    );
    for (const name of workerOnly) expect(paths).not.toContain(`/v1/commands/${name}`);
    const direct = await app.inject({
      method: 'POST',
      url: '/v1/commands/message.receive',
      payload: {},
    });
    expect(direct.statusCode).toBe(404);
  });
});

describe('readEnv', () => {
  const base = {
    SUPABASE_URL: 'http://127.0.0.1:54421',
    DATABASE_URL: 'postgresql://hfos_api:x@127.0.0.1:54422/postgres',
  };
  it('refuses privileged keys in the API process', () => {
    expect(() => readEnv({ ...base, SUPABASE_SECRET_KEY: 'x' })).toThrow(/privileged/);
    expect(() => readEnv({ ...base, SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow(/privileged/);
    // Provider credentials and the worker's sealing key belong to the worker only.
    for (const name of [
      'TWILIO_AUTH_TOKEN',
      'POSTMARK_SERVER_TOKEN',
      'GOOGLE_OAUTH_CLIENT_ID',
      'MICROSOFT_OAUTH_CLIENT_SECRET',
      'WORKER_ENCRYPTION_KEY',
      'ANTHROPIC_API_KEY',
      // Any OAuth client setting, the calendar's own Google project included, and Turnstile's keys.
      'GOOGLE_CALENDAR_OAUTH_CLIENT_ID',
      'GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET',
      'ACME_OAUTH_CLIENT_ID',
      'TURNSTILE_SECRET_KEY',
      'TURNSTILE_SITE_KEY',
      // The website chat's key for hashing visitors' IP addresses.
      'CHAT_IP_KEY',
      // Expo: the worker's push access token, and EAS's build token.
      'EXPO_ACCESS_TOKEN',
      'EXPO_TOKEN',
    ])
      expect(() => readEnv({ ...base, [name]: 'x' })).toThrow(/privileged/);
    // Claude Code's own names in a developer's shell, names that merely end in OAUTH, and the phone app's public
    // build settings are fine.
    for (const name of [
      'CLAUDE_CODE_OAUTH_SCOPES',
      'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
      'USE_LOCAL_OAUTH',
      'EXPO_PUBLIC_API_URL',
    ])
      expect(() => readEnv({ ...base, [name]: 'x' })).not.toThrow();
  });
  it('refuses to connect as postgres and derives the JWKS url', () => {
    expect(() =>
      readEnv({ ...base, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' }),
    ).toThrow(/postgres role/);
    expect(readEnv(base).jwksUrl).toBe('http://127.0.0.1:54421/auth/v1/.well-known/jwks.json');
  });
});
