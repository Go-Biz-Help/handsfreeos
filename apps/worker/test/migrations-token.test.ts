/**
 * The second door onto the old CRM, on the real database (0069): a private integration token, pasted.
 *
 * What is proved here is the set of promises that door makes, rather than that a happy path works:
 *
 *   - nothing is stored until the old system has actually answered with the token — a pair nobody tried is a
 *     connection that fails a week later, halfway through an import;
 *   - a refused paste leaves the form alive, so a mistyped sub-account id is corrected rather than started
 *     again, and it closes after ten wrong tries rather than staying open for the rest of its ten minutes;
 *   - the token is sealed before it touches the database, and the row says what door it came in through;
 *   - a private token claims no access it has not been given: `scopes` is empty on purpose, and the scan is
 *     what finds out;
 *   - the two doors are not interchangeable — a sign-in's state cannot be pasted to, and a token's state
 *     cannot be signed in with;
 *   - the token is the door taken when none is named, and a connection that stops working asks for a new
 *     token rather than a sign-in GoHighLevel no longer offers.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  migrationConnect,
  migrationCreate,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { createMigrationAdapters } from '../src/migrations/adapters/registry';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

/** The stand-in agency's Austin sub-account: the one a pasted token is allowed to name. */
const AUSTIN = 'loc_austin';

let owner: TestUser;
let organizationId: string;
let services: TestServices;
let app: FastifyInstance;

beforeAll(async () => {
  owner = await createTestUser('migrations-token-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  organizationId = output.organizationId;
  services = testServices();
  app = await buildHttpServer({
    ...services,
    httpDb: worker(),
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    // The stand-in, so nothing in this file can reach a real account.
    migrationAdapters: createMigrationAdapters({
      live: false,
      goHighLevel: { clientId: '', clientSecret: '', configured: false },
    }),
  });
}, 60_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await closeTestDbs();
});

/** Starting a connection through the command, the way the screen does. No door named takes the default. */
async function start(authKind?: 'oauth' | 'private_token') {
  const { output } = await executeCommand(
    api(),
    migrationConnect,
    { organizationId, source: 'gohighlevel', ...(authKind ? { authKind } : {}) },
    actorOf(owner),
    meta(),
  );
  return output;
}

/** What starting a migration from a connection is refused with, or null when it isn't. */
async function refusedToStart(
  connectionId: string,
): Promise<{ rule?: string; message: string } | null> {
  return executeCommand(
    api(),
    migrationCreate,
    { organizationId, connectionId, name: 'From GoHighLevel' },
    actorOf(owner),
    meta(),
  ).then(
    () => null,
    (e: unknown) => e as { rule?: string; message: string },
  );
}

/** As the worker leaves a connection whose token or sign-in the old system stopped accepting. */
const stopAccepting = (id: string) =>
  asWorker(worker(), { organizationId }, (tx) =>
    rows(
      tx,
      sql`update app.migration_connections set status = 'reauth_required' where id = ${id} returning id`,
    ),
  );

const paste = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/migrations/token', payload: body });

type Row = {
  status: string;
  install_kind: string;
  auth_kind: string;
  external_account_id: string | null;
  display_name: string | null;
  scopes: string[];
  missing_scopes: string[];
  token_enc: string | null;
  token_expires_at: Date | null;
  failures: number;
  last_error: string | null;
};

const connectionRow = async (id: string): Promise<Row> => {
  const [row] = await asWorker(worker(), { organizationId }, (tx) =>
    rows<Row>(
      tx,
      sql`select status::text as status, install_kind::text as install_kind,
            auth_kind::text as auth_kind, external_account_id, display_name, scopes, missing_scopes,
            token_enc, token_expires_at, failures, last_error
          from app.migration_connections where id = ${id}`,
    ),
  );
  return row!;
};

describe('connecting with a private token', () => {
  it('connects the one sub-account the token names, and seals it', async () => {
    const started = await start('private_token');
    expect(started.authKind).toBe('private_token');
    expect(started.startPath).toBe('/migrations/token');

    const res = await paste({
      state: started.state,
      token: 'pit-not-a-real-token',
      accountId: AUSTIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      connectionId: started.connectionId,
      status: 'active',
      displayName: 'Lone Star HVAC — Austin',
    });

    const row = await connectionRow(started.connectionId);
    expect(row.status).toBe('active');
    // A private token reaches one sub-account, and says nothing about what it may read.
    expect(row.install_kind).toBe('location');
    expect(row.auth_kind).toBe('private_token');
    expect(row.external_account_id).toBe(AUSTIN);
    expect(row.scopes).toEqual([]);
    expect(row.missing_scopes).toEqual([]);
    // Nothing to refresh and nothing to expire, and what is stored is sealed rather than the token itself.
    expect(row.token_expires_at).toBeNull();
    expect(row.token_enc).toBeTruthy();
    expect(row.token_enc).not.toContain('fake-not-a-real-private-token');
    expect(JSON.parse(services.sealer.open(row.token_enc!))).toEqual({
      accessToken: 'fake-not-a-real-private-token',
      refreshToken: null,
    });
  }, 60_000);

  it('stores nothing when the old system will not answer with it, and lets the same form try again', async () => {
    const started = await start('private_token');
    const wrong = await paste({
      state: started.state,
      token: 'pit-not-a-real-token',
      accountId: 'loc_nowhere',
    });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { error: { rule?: string } }).error.rule).toBe(
      'migration_token_rejected',
    );

    const refused = await connectionRow(started.connectionId);
    expect(refused.status).toBe('pending');
    expect(refused.token_enc).toBeNull();
    expect(refused.failures).toBe(1);
    expect(refused.last_error).toContain('loc_nowhere');

    // The form is still alive, so a mistyped id is a correction rather than a fresh start.
    const right = await paste({
      state: started.state,
      token: 'pit-not-a-real-token',
      accountId: AUSTIN,
    });
    expect(right.statusCode, right.body).toBe(200);
    expect((await connectionRow(started.connectionId)).status).toBe('active');
  }, 60_000);

  it('closes the form after ten wrong tries', async () => {
    const started = await start('private_token');
    for (let i = 0; i < 10; i++)
      expect(
        (
          await paste({
            state: started.state,
            token: 'pit-not-a-real-token',
            accountId: 'loc_nowhere',
          })
        ).statusCode,
      ).toBe(400);

    const closed = await connectionRow(started.connectionId);
    expect(closed.status).toBe('error');
    const after = await paste({
      state: started.state,
      token: 'pit-not-a-real-token',
      accountId: AUSTIN,
    });
    expect(after.statusCode).toBe(410);
  }, 60_000);

  it('refuses an empty token and a missing sub-account without asking the old system', async () => {
    const started = await start('private_token');
    expect((await paste({ state: started.state, token: '', accountId: AUSTIN })).statusCode).toBe(
      400,
    );
    expect(
      (await paste({ state: started.state, token: 'pit-not-a-real-token', accountId: '' }))
        .statusCode,
    ).toBe(400);
    expect((await connectionRow(started.connectionId)).status).toBe('pending');
  }, 60_000);

  it('will not let one door stand in for the other', async () => {
    const signIn = await start('oauth');
    expect(signIn.startPath).toContain('/migrations/start');
    const pastedToASignIn = await paste({
      state: signIn.state,
      token: 'pit-not-a-real-token',
      accountId: AUSTIN,
    });
    expect(pastedToASignIn.statusCode).toBe(410);

    const token = await start('private_token');
    const signedInWithAToken = await app.inject({
      method: 'GET',
      url: `/migrations/start?state=${encodeURIComponent(token.state)}`,
    });
    expect(signedInWithAToken.statusCode).toBe(400);
    expect(signedInWithAToken.body).toContain('different way in');
  }, 60_000);

  it('is gone when the state is not one of ours', async () => {
    const res = await paste({
      state: 'x'.repeat(40),
      token: 'pit-not-a-real-token',
      accountId: AUSTIN,
    });
    expect(res.statusCode).toBe(410);
  }, 60_000);

  it('is the door taken when none is named, because it is the one the screens offer', async () => {
    const started = await start();
    expect(started.authKind).toBe('private_token');
    expect(started.startPath).toBe('/migrations/token');
  }, 60_000);
});

describe('a connection the old system stopped accepting', () => {
  it('asks for a new private token, and says where to make one', async () => {
    const started = await start('private_token');
    const res = await paste({
      state: started.state,
      token: 'pit-not-a-real-token',
      accountId: AUSTIN,
    });
    expect(res.statusCode, res.body).toBe(200);
    await stopAccepting(started.connectionId);

    const refused = await refusedToStart(started.connectionId);
    expect(refused).toMatchObject({ rule: 'migration_connection_not_active' });
    expect(refused!.message).toContain('Settings → Private Integrations');
    expect(refused!.message).not.toMatch(/sign in/i);
  }, 60_000);

  it('points a sign-in GoHighLevel no longer offers at a private token too', async () => {
    const signIn = await start('oauth');
    await stopAccepting(signIn.connectionId);

    const refused = await refusedToStart(signIn.connectionId);
    expect(refused).toMatchObject({ rule: 'migration_connection_not_active' });
    expect(refused!.message).toContain('private integration token');
    expect(refused!.message).not.toMatch(/sign in again/i);
  }, 60_000);
});
