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

  it('serves the OpenAPI document with every command and query', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json().paths);
    const expected = [
      ...registry.commands.map((c) => `/v1/commands/${c.name}`),
      ...registry.queries.map((q) => `/v1/queries/${q.name}`),
    ];
    expect(paths).toEqual(expect.arrayContaining(expected));
    expect(paths.filter((p) => p.startsWith('/v1/'))).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThanOrEqual(71);
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
  });
  it('refuses to connect as postgres and derives the JWKS url', () => {
    expect(() =>
      readEnv({ ...base, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' }),
    ).toThrow(/postgres role/);
    expect(readEnv(base).jwksUrl).toBe('http://127.0.0.1:54421/auth/v1/.well-known/jwks.json');
  });
});
