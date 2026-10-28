/**
 * M10 step 4 over HTTP: what the API does with a request from the phone app.
 * - Its headers become the command's details: the app's channel, its command id, and its moments on the server's
 *   clock (an hour-fast phone still says when things happened).
 * - A repeat of a command gets the same answer and events back, and its receipt hashes the body as the app sent
 *   it, before the route filled in defaults.
 * - An app build older than the API takes is told to update (426), before anything else.
 * - Every error body says what to do with it: final, retry or ask.
 */
import { randomUUID } from 'node:crypto';
import { inputHashOf } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { readEnv } from '../src/env';
import { apiEnv, testApp } from './helpers';

let app: Awaited<ReturnType<typeof testApp>>;
let owner: TestUser;
let token: string;
let workspaceId: string;

const post = (url: string, body: unknown, headers: Record<string, string> = {}, bearer = token) =>
  app.inject({
    method: 'POST',
    url,
    payload: body as Record<string, unknown>,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
  });

/** The app's headers, with its own clock running an hour fast. */
const fromApp = (over: Record<string, string> = {}) => {
  const hourFast = (d: Date) => new Date(d.getTime() + 60 * 60_000).toISOString();
  return {
    'x-hfos-client': 'mobile',
    'x-hfos-app-version': '1.0.0',
    'x-hfos-command-id': randomUUID(),
    'x-hfos-occurred-at': hourFast(new Date(Date.now() - 10 * 60_000)),
    'x-hfos-sent-at': hourFast(new Date()),
    ...over,
  };
};

beforeAll(async () => {
  app = await testApp();
  owner = await createTestUser('api-mobile-owner');
  token = await signInTestUser(owner);
  const org = await post('/v1/commands/organization.create', { businessName: 'Pocket HVAC' });
  expect(org.statusCode).toBe(200);
  workspaceId = org.json().workspaceId;
});
afterAll(async () => {
  await app.close();
  await closeTestDbs();
});

describe('a command from the app', () => {
  it('is recorded as the phone’s, with when it was really done, and a repeat gets the same answer', async () => {
    const headers = fromApp();
    const body = { workspaceId, firstName: 'Paula', lastName: 'Pocket', phone: '(512) 555-0199' };
    const first = await post('/v1/commands/person.create', body, headers);
    expect(first.statusCode).toBe(200);
    const again = await post('/v1/commands/person.create', body, headers);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(again.headers['x-hfos-events']).toBe(first.headers['x-hfos-events']);

    const personId = first.json().personId as string;
    const created = await rows<{ n: number }>(
      testDbs().admin.db,
      sql`select count(*)::int as n from app.people where workspace_id = ${workspaceId} and first_name = 'Paula'`,
    );
    expect(created[0]!.n).toBe(1);
    const [event] = await rows<{ occurred_at: string; channel: string }>(
      testDbs().admin.db,
      sql`select e.occurred_at, a.channel from app.events e join app.audit_logs a on a.event_id = e.id
          where e.entity_id = ${personId} and e.event_type = 'person.created'`,
    );
    expect(event!.channel).toBe('mobile');
    // Ten minutes ago, though the phone's clock said an hour later.
    expect(Math.abs(Date.parse(event!.occurred_at) - (Date.now() - 10 * 60_000))).toBeLessThan(
      15_000,
    );
    // The receipt hashes the body as the app sent it, not the one the route filled defaults into.
    const [receipt] = await rows<{ input_hash: string; outcome: string }>(
      testDbs().admin.db,
      sql`select input_hash, outcome::text from app.command_receipts
          where user_id = ${owner.id} and command_id = ${headers['x-hfos-command-id']}`,
    );
    expect(receipt).toEqual({ input_hash: inputHashOf(body), outcome: 'applied' });
    expect(receipt!.input_hash).not.toBe(inputHashOf({ ...body, ignoreDuplicates: false }));
  });

  it('is refused without its id, or with details it can’t use', async () => {
    const { 'x-hfos-command-id': _id, ...noId } = fromApp();
    const missing = await post('/v1/commands/tag.create', { workspaceId, name: 'No id' }, noId);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'validation', disposition: 'final' });
    const garbled = await post(
      '/v1/commands/tag.create',
      { workspaceId, name: 'Garbled' },
      fromApp({ 'x-hfos-occurred-at': 'a while ago' }),
    );
    expect(garbled.statusCode).toBe(400);
    expect(garbled.json().error.details).toEqual([
      { path: 'x-hfos-occurred-at', message: 'Send a time like 2026-09-21T14:03:11.402Z.' },
    ]);
    // A query from the app needs no command id.
    const me = await post('/v1/queries/account.me', {}, noId);
    expect(me.statusCode).toBe(200);
  });

  it('says final, retry or ask on every refusal', async () => {
    const late = await post(
      '/v1/commands/tag.create',
      { workspaceId, name: 'Too late' },
      fromApp(),
    );
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatchObject({ rule: 'online_only', disposition: 'final' });

    const phone = '(512) 555-0142';
    expect(
      (await post('/v1/commands/person.create', { workspaceId, firstName: 'Dup', phone }))
        .statusCode,
    ).toBe(200);
    const dup = await post('/v1/commands/person.create', { workspaceId, firstName: 'Dup', phone });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ rule: 'duplicate', disposition: 'ask' });

    const invalid = await post('/v1/commands/tag.create', { workspaceId, name: '' });
    expect(invalid.json().error).toMatchObject({ code: 'validation', disposition: 'final' });
    const noRoute = await post('/v1/commands/nothing.here', {});
    expect(noRoute.json().error).toMatchObject({ code: 'not_found', disposition: 'final' });
    const signedOut = await post('/v1/queries/account.me', {}, {}, '');
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.json().error).toMatchObject({ code: 'unauthenticated', disposition: 'retry' });
    let limited: { error: { code: string; disposition: string } } | null = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const res = await post('/v1/commands/invitation.accept', {
        token: 'tok_0000000000000000000000',
      });
      if (res.statusCode === 429) limited = res.json();
    }
    expect(limited?.error).toMatchObject({ code: 'rate_limited', disposition: 'retry' });
  });
});

describe('an old app build', () => {
  it('is told to update before anything else, and a new enough one goes on', async () => {
    const strict = await buildApp({
      env: { ...apiEnv(), minAppVersion: '2.0.0' },
      logger: false,
      db: testDbs().api,
    });
    try {
      const call = (headers: Record<string, string>, bearer: string | null = token) =>
        strict.inject({
          method: 'POST',
          url: '/v1/queries/account.me',
          payload: {},
          headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
        });
      const old = await call(fromApp({ 'x-hfos-app-version': '1.9.3' }));
      expect(old.statusCode).toBe(426);
      expect(old.json()).toEqual({
        error: {
          code: 'upgrade_required',
          message: 'Update the HandsFreeOS app to keep going. Nothing you did is lost.',
          details: { minVersion: '2.0.0' },
          disposition: 'retry',
        },
      });
      // Even signed out, and even with no version at all.
      expect((await call(fromApp({ 'x-hfos-app-version': '1.0.0' }), null)).statusCode).toBe(426);
      const { 'x-hfos-app-version': _v, ...noVersion } = fromApp();
      expect((await call(noVersion)).statusCode).toBe(426);
      expect((await call(fromApp({ 'x-hfos-app-version': '2.0.1' }))).statusCode).toBe(200);
      // The web is never asked.
      expect((await call({})).statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it('refuses a minimum version that isn’t one', () => {
    const base = {
      SUPABASE_URL: 'http://127.0.0.1:54421',
      DATABASE_URL: 'postgresql://hfos_api:x@127.0.0.1:54422/postgres',
    };
    expect(() => readEnv({ ...base, MIN_APP_VERSION: 'soon' })).toThrow(/MIN_APP_VERSION/);
    expect(readEnv({ ...base, MIN_APP_VERSION: '1.4' }).minAppVersion).toBe('1.4');
    expect(readEnv(base).minAppVersion).toBeNull();
    expect(() => readEnv({ ...base, MIN_EXTENSION_VERSION: 'next' })).toThrow(
      /MIN_EXTENSION_VERSION/,
    );
    expect(readEnv({ ...base, MIN_EXTENSION_VERSION: '0.96' }).minExtensionVersion).toBe('0.96');
    // Never older than the build that checks whose chat it types in (decision 94), set or not.
    expect(readEnv({ ...base, MIN_EXTENSION_VERSION: '0.2' }).minExtensionVersion).toBe('0.94.1');
    expect(readEnv(base).minExtensionVersion).toBe('0.94.1');
  });
});

describe('the browser extension', () => {
  const fromExtension = (version: string) =>
    fromApp({ 'x-hfos-client': 'extension', 'x-hfos-app-version': version });

  it('is recorded as the extension’s, with the same repeat protection as the app', async () => {
    const headers = fromExtension('0.95.0');
    const body = { workspaceId, firstName: 'Evan', lastName: 'Extension' };
    const first = await post('/v1/commands/person.create', body, headers);
    expect(first.statusCode).toBe(200);
    const again = await post('/v1/commands/person.create', body, headers);
    expect(again.json()).toEqual(first.json());
    const [audit] = await rows<{ channel: string }>(
      testDbs().admin.db,
      sql`select a.channel from app.events e join app.audit_logs a on a.event_id = e.id
          where e.entity_id = ${first.json().personId as string} and e.event_type = 'person.created'`,
    );
    expect(audit!.channel).toBe('extension');
  });

  it('is held to its own oldest build, never the app’s', async () => {
    const strict = await buildApp({
      env: { ...apiEnv(), minAppVersion: '2.0.0', minExtensionVersion: '0.2.0' },
      logger: false,
      db: testDbs().api,
    });
    try {
      const call = (headers: Record<string, string>) =>
        strict.inject({
          method: 'POST',
          url: '/v1/queries/account.me',
          payload: {},
          headers: { authorization: `Bearer ${token}`, ...headers },
        });
      const old = await call(fromExtension('0.1.3'));
      expect(old.statusCode).toBe(426);
      expect(old.json().error).toMatchObject({
        code: 'upgrade_required',
        message: 'Update the HandsFreeOS Social extension to keep going.',
        details: { minVersion: '0.2.0' },
      });
      expect((await call(fromExtension('0.2.0'))).statusCode).toBe(200);
      // An app build that new would be too old, but the app's minimum isn't the extension's.
      expect((await call(fromApp({ 'x-hfos-app-version': '0.2.0' }))).statusCode).toBe(426);
    } finally {
      await strict.close();
    }
  });
});
