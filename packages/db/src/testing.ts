/**
 * Shared test helpers for suites that run against the local Supabase stack (db, core, api).
 * Import from '@hfos/db/testing'. Test-only: reads the repo-root .env.local written by `pnpm env:local`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  asUser,
  asWorker,
  createDb,
  rows,
  sql,
  type DbHandle,
  type SystemScope,
  type Tx,
  type UserClaims,
} from './client';

/** Loads the repo-root .env.local (walking up from cwd). Safe to call more than once. */
export function loadLocalEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, '.env.local');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    dir = resolve(dir, '..');
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(
      `${name} is not set. Run \`pnpm env:local\` with the local Supabase stack running.`,
    );
  return v;
}

let envCache: TestEnv | undefined;
export interface TestEnv {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly apiDbUrl: string;
  readonly workerDbUrl: string;
  readonly adminDbUrl: string;
  readonly mailpitUrl: string;
}
export function testEnv(): TestEnv {
  if (!envCache) {
    loadLocalEnv();
    envCache = {
      supabaseUrl: required('SUPABASE_URL'),
      publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
      secretKey: required('SUPABASE_SECRET_KEY'),
      apiDbUrl: required('DATABASE_URL'),
      workerDbUrl: required('DATABASE_URL_WORKER'),
      adminDbUrl: required('SUPABASE_DB_URL'),
      mailpitUrl: process.env.MAILPIT_URL ?? 'http://127.0.0.1:54424',
    };
  }
  return envCache;
}

let dbCache: { api: DbHandle; worker: DbHandle; admin: DbHandle } | undefined;
export function testDbs(): { api: DbHandle; worker: DbHandle; admin: DbHandle } {
  if (!dbCache) {
    const env = testEnv();
    dbCache = {
      api: createDb(env.apiDbUrl, { max: 4, applicationName: 'hfos-test-api' }),
      worker: createDb(env.workerDbUrl, { max: 2, applicationName: 'hfos-test-worker' }),
      admin: createDb(env.adminDbUrl, { max: 2, applicationName: 'hfos-test-admin' }),
    };
  }
  return dbCache;
}

export async function closeTestDbs(): Promise<void> {
  if (!dbCache) return;
  const d = dbCache;
  dbCache = undefined;
  await Promise.all([d.api.close(), d.worker.close(), d.admin.close()]);
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
  readonly claims: UserClaims;
}

export const uniq = (): string => randomUUID().slice(0, 8);

/** Creates a confirmed user through GoTrue (so the app.users mirror trigger really runs). */
export async function createTestUser(
  label: string,
  opts: { email?: string; password?: string; fullName?: string } = {},
): Promise<TestUser> {
  const env = testEnv();
  const adminAuth = createClient(env.supabaseUrl, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const email = (opts.email ?? `${label}-${uniq()}@hfos.test`).toLowerCase();
  const password = opts.password ?? `correct-horse-${uniq()}-battery`;
  const fullName = opts.fullName ?? `Test ${label}`;
  const { data, error } = await adminAuth.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message ?? 'no user'}`);
  const id = data.user.id;
  const mirrored = await rows<{ id: string }>(
    testDbs().admin.db,
    sql`select id from app.users where id = ${id}`,
  );
  if (mirrored.length !== 1) throw new Error(`app.users mirror row missing for ${email}`);
  return { id, email, password, fullName, claims: { sub: id, email } };
}

/** Signs a test user in through GoTrue and returns a real access token. */
export async function signInTestUser(user: TestUser): Promise<string> {
  const env = testEnv();
  const client = createClient(env.supabaseUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error || !data.session) throw new Error(`signIn failed: ${error?.message ?? 'no session'}`);
  return data.session.access_token;
}

export const as =
  (user: TestUser) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    asUser(testDbs().api.db, user.claims, fn);

export const asService =
  (scope: SystemScope) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    asWorker(testDbs().worker.db, scope, fn);

export interface OrgBootstrap {
  readonly orgId: string;
  readonly wsId: string;
}

export async function bootstrapOrganization(
  user: TestUser,
  orgName: string,
  wsName: string,
): Promise<OrgBootstrap> {
  const suffix = uniq();
  const [row] = await as(user)((tx) =>
    rows<{ org_id: string; ws_id: string }>(
      tx,
      sql`select * from private.create_organization(${orgName}, ${slugify(orgName) + '-' + suffix}, ${wsName}, ${slugify(wsName) + '-' + suffix}, 'America/Chicago', 'home_services')`,
    ),
  );
  if (!row) throw new Error('create_organization returned no row');
  return { orgId: row.org_id, wsId: row.ws_id };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export interface PgError {
  code?: string;
  detail?: string;
  message: string;
}

/** Drizzle wraps driver errors in DrizzleQueryError; the Postgres error is the innermost cause. */
export function pgError(e: unknown): PgError {
  let err: unknown = e;
  while (err instanceof Error && err.cause instanceof Error) err = err.cause;
  return err as PgError;
}

/** Runs `fn` and returns the Postgres error it throws (fails the test if it does not throw). */
export async function expectPgError(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn();
  } catch (e) {
    return pgError(e);
  }
  throw new Error('expected the statement to fail, but it succeeded');
}
