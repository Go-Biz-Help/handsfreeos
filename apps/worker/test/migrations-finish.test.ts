/**
 * Finishing a sign-in to the old CRM, on the real database (SEC-M7): the callback connects nothing and hands the
 * app a seal, and `/v1/migrations/finish` connects only for the person who pressed Connect.
 *
 *   - the owner who started it finishes it, and the connection is active;
 *   - somebody else, signed in to their own business, gets told it wasn't theirs, and the connection is ended:
 *     it is in error and its state is spent, so the link can't be tried a second time;
 *   - nobody signed in gets a 401, and nothing changes.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  migrationConnect,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_YOURS } from '../src/http/handoff';
import { buildHttpServer } from '../src/http/server';
import { createMigrationAdapters } from '../src/migrations/adapters/registry';
import { finishSignIn, testTokenVerifier } from './finish-sign-in';
import { testServices } from './helpers';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let ownerToken: string;
let organizationId: string;
let app: FastifyInstance;

beforeAll(async () => {
  owner = await createTestUser('migrations-finish-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  organizationId = output.organizationId;
  ownerToken = await signInTestUser(owner);
  app = await buildHttpServer({
    ...testServices(),
    httpDb: worker(),
    verifyToken: testTokenVerifier(),
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

type Row = {
  status: string;
  token_enc: string | null;
  oauth_state_hash: string | null;
  last_error: string | null;
};

const connectionRow = async (id: string): Promise<Row> => {
  const [row] = await asWorker(worker(), { organizationId }, (tx) =>
    rows<Row>(
      tx,
      sql`select status::text as status, token_enc, oauth_state_hash, last_error
          from app.migration_connections where id = ${id}`,
    ),
  );
  return row!;
};

/**
 * The owner presses Connect; the stand-in sends the browser straight back to the callback with a code; the app
 * finishes it signed in as `token` (null: signed out).
 */
async function signIn(token: string | null) {
  const { output } = await executeCommand(
    api(),
    migrationConnect,
    { organizationId, source: 'gohighlevel', authKind: 'oauth' },
    actorOf(owner),
    meta(),
  );
  const start = await app.inject({
    method: 'GET',
    url: `/migrations/start?state=${encodeURIComponent(output.state)}`,
  });
  expect(start.statusCode).toBe(302);
  const callback = new URL(String(start.headers.location));
  const answered = await app.inject({
    method: 'GET',
    url: `${callback.pathname}${callback.search}`,
  });
  // The callback itself connects nothing: it hands the app a seal after the `#`.
  expect(answered.statusCode).toBe(302);
  expect(new URL(String(answered.headers.location)).pathname).toBe('/app/oauth/finish');
  expect((await connectionRow(output.connectionId)).status).toBe('pending');
  return { connectionId: output.connectionId, finished: await finishSignIn(app, answered, token) };
}

describe('finishing a sign-in to the old system', () => {
  it('connects when the person who pressed Connect finishes it', async () => {
    const { connectionId, finished } = await signIn(ownerToken);
    expect(finished.status).toBe(302);
    expect(finished.location).toContain('connected=1');
    const row = await connectionRow(connectionId);
    expect(row.status).toBe('active');
    expect(row.token_enc).toBeTruthy();
  }, 60_000);

  it('ends the sign-in when somebody else finishes a link they were sent', async () => {
    // Riley, in another business, is sent the owner's link and opens it signed in as himself.
    const riley = await createTestUser('migrations-finish-riley');
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Somebody Else Electric' },
      actorOf(riley),
      meta(),
    );
    const { connectionId, finished } = await signIn(await signInTestUser(riley));
    expect(finished.location).toBeNull();
    expect(finished.body).toContain(NOT_YOURS.title);
    const row = await connectionRow(connectionId);
    expect(row.status).toBe('error');
    expect(row.token_enc).toBeNull();
    expect(row.last_error).toContain('somebody other than the person who started it');
    // And the link is spent: the owner can't be tricked into finishing it afterwards either.
    expect(row.oauth_state_hash).toBeNull();
  }, 60_000);

  it('connects nothing when the sign-in comes back to somebody signed out', async () => {
    const { connectionId, finished } = await signIn(null);
    expect(finished.status).toBe(401);
    const row = await connectionRow(connectionId);
    expect(row.status).toBe('pending');
    expect(row.token_enc).toBeNull();
  }, 60_000);
});
