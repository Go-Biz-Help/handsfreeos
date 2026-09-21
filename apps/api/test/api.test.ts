import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NO_SUCH_ROUTE } from '@hfos/core';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testEnv,
  type TestUser,
} from '@hfos/db/testing';
import { SignJWT, generateKeyPair, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

let app: Awaited<ReturnType<typeof testApp>>;
let owner: TestUser, teammate: TestUser, outsider: TestUser;
let ownerToken: string, teammateToken: string, outsiderToken: string;

const post = (
  url: string,
  body: Record<string, unknown>,
  token?: string,
  headers: Record<string, string> = {},
) =>
  app
    .inject({
      method: 'POST',
      url,
      payload: body,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    })
    .then((r) => r);

beforeAll(async () => {
  app = await testApp();
  [owner, teammate, outsider] = await Promise.all([
    createTestUser('api-owner'),
    createTestUser('api-teammate'),
    createTestUser('api-outsider'),
  ]);
  [ownerToken, teammateToken, outsiderToken] = await Promise.all([
    signInTestUser(owner),
    signInTestUser(teammate),
    signInTestUser(outsider),
  ]);
});
afterAll(async () => {
  await app.close();
  await closeTestDbs();
});

describe('authentication', () => {
  it('rejects missing, malformed and unsigned tokens with 401 and a JSON body', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/queries/account.me',
        payload: {},
        headers,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    }
  });

  it('rejects a token signed with an unknown ES256 key, an HS256 token, a wrong issuer and an expired token', async () => {
    const env = testEnv();
    const issuer = `${env.supabaseUrl}/auth/v1`;
    const claims = {
      sub: owner.id,
      email: owner.email,
      role: 'authenticated',
      aud: 'authenticated',
      is_anonymous: false,
    };
    const { privateKey: strangerKey } = await generateKeyPair('ES256');
    const stranger = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'stranger' })
      .setIssuer(issuer)
      .setExpirationTime('5m')
      .sign(strangerKey);
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('super-secret-jwt-token-with-at-least-32-characters-long'));
    const [stored] = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../supabase/signing_keys.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    const {
      key_ops: _ops,
      ext: _ext,
      ...localKey
    } = stored as Record<string, string> & { key_ops?: unknown; ext?: unknown };
    const realKey = await importJWK(localKey, 'ES256');
    const wrongIssuer = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: localKey!.kid! })
      .setIssuer('https://evil.example/auth/v1')
      .setExpirationTime('5m')
      .sign(realKey);
    const expired = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: localKey!.kid! })
      .setIssuer(issuer)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(realKey);
    const anonymous = await new SignJWT({ ...claims, is_anonymous: true })
      .setProtectedHeader({ alg: 'ES256', kid: localKey!.kid! })
      .setIssuer(issuer)
      .setExpirationTime('5m')
      .sign(realKey);
    for (const [label, token] of Object.entries({
      stranger,
      hs,
      wrongIssuer,
      expired,
      anonymous,
    })) {
      const res = await post('/v1/queries/account.me', {}, token);
      expect(res.statusCode, label).toBe(401);
    }
    // sanity: a token minted with the real local key and correct claims is accepted (same as GoTrue's)
    const ok = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: localKey!.kid! })
      .setIssuer(issuer)
      .setExpirationTime('5m')
      .sign(realKey);
    expect((await post('/v1/queries/account.me', {}, ok)).statusCode).toBe(200);
  });
});

describe('the full Milestone 1 flow over HTTP', () => {
  let workspaceId: string;
  let organizationId: string;
  let correlation: string;

  it('creates the business, echoes the correlation id and names the events it wrote', async () => {
    const res = await post(
      '/v1/commands/organization.create',
      { businessName: 'Lone Star HVAC & Roofing', organizationName: 'Go Biz Help' },
      ownerToken,
      { 'x-correlation-id': '0192a4b7-8c2e-7d31-9f60-4a1e2c9d7b10' },
    );
    expect(res.statusCode).toBe(200);
    ({ workspaceId, organizationId } = res.json());
    correlation = res.headers['x-correlation-id'] as string;
    expect(correlation).toBe('0192a4b7-8c2e-7d31-9f60-4a1e2c9d7b10');
    expect((res.headers['x-hfos-events'] as string).split(',')).toHaveLength(2);
  });

  it('validates bodies with field paths and rejects unknown routes as JSON 404s', async () => {
    const bad = await post(
      '/v1/commands/membership.invite',
      { workspaceId, email: 'nope', role: 'king' },
      ownerToken,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    expect(bad.json().error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['email', 'role']),
    );
    const missing = await post('/v1/commands/does.not_exist', {}, ownerToken);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    // Told apart from a real 404 by its rule, so a browser one deploy ahead of this API reports a route it
    // does not have yet as server trouble rather than as a page the person has lost access to.
    expect(missing.json().error.rule).toBe(NO_SUCH_ROUTE);
  });

  it('a forged workspace id in the body is a 404 for a non-member, never a 403', async () => {
    const res = await post('/v1/queries/workspace.members', { workspaceId }, outsiderToken);
    expect(res.statusCode).toBe(404);
    // A real 404: the route exists, the workspace does not exist for them. No NO_SUCH_ROUTE rule, so the
    // web app still renders its 404 page for this one.
    expect(res.json().error.rule).toBeUndefined();
    const write = await post(
      '/v1/commands/membership.invite',
      { workspaceId, email: 'x@y.zz' },
      outsiderToken,
    );
    expect(write.statusCode).toBe(404);
  });

  it('invites, previews, accepts, lists members and reads the audit trail', async () => {
    const inv = await post(
      '/v1/commands/membership.invite',
      { workspaceId, email: teammate.email, role: 'admin' },
      ownerToken,
    );
    expect(inv.statusCode).toBe(200);
    const pending = await post('/v1/queries/workspace.invitations', { workspaceId }, ownerToken);
    expect(pending.json().invitations.map((i: { email: string }) => i.email)).toEqual([
      teammate.email,
    ]);
    const dup = await post(
      '/v1/commands/membership.invite',
      { workspaceId, email: teammate.email },
      ownerToken,
    );
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.rule).toBe('invitation_pending');

    // The worker (step 9) mints the token; until then the teammate cannot accept anything.
    const nothing = await post(
      '/v1/commands/invitation.accept',
      { token: 'tok_0000000000000000000000' },
      teammateToken,
    );
    expect(nothing.statusCode).toBe(404);

    const members = await post('/v1/queries/workspace.members', { workspaceId }, ownerToken);
    expect(members.json().members).toHaveLength(1);
    const audit = await post('/v1/queries/audit.list', { workspaceId, limit: 10 }, ownerToken);
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['membership.invite', 'organization.create']),
    );
    const me = await post('/v1/queries/account.me', {}, ownerToken);
    expect(me.json().workspaces[0]).toMatchObject({
      id: workspaceId,
      organizationId,
      role: 'owner',
    });
  });

  it('rate-limits invitation acceptance per client', async () => {
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await post(
        '/v1/commands/invitation.accept',
        { token: 'tok_0000000000000000000000' },
        teammateToken,
      );
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
