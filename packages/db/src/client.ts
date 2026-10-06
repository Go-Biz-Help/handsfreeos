/**
 * Role-scoped database access.
 *
 * The API connects as `hfos_api`, a NOINHERIT login role that can do nothing until a transaction
 * runs `SET LOCAL ROLE authenticated` with the user's verified JWT claims (`asUser`). The worker
 * connects as `hfos_worker` and switches to `service_actor`, whose policies are bounded by the
 * tenant scope set for the job (`asWorker`), or to `portal_actor` for a customer signed in to their portal
 * (`asCustomer`). Every setting is transaction-local, so a pooled connection carries nothing into the next request.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface UserClaims {
  /** auth.users.id */
  readonly sub: string;
  readonly email?: string;
  readonly role?: 'authenticated';
  readonly aud?: string;
  readonly [key: string]: unknown;
}

export interface SystemScope {
  readonly organizationId?: string | null;
  readonly workspaceId?: string | null;
}

export interface DbHandle {
  readonly db: Db;
  readonly client: ReturnType<typeof postgres>;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  readonly max?: number;
  readonly applicationName?: string;
}

/**
 * Seconds an unused connection stays open. Behind Supavisor's session mode every open connection holds one of
 * the pool's slots (15 by default) whether or not it is doing anything, and postgres.js keeps them for ever
 * unless told otherwise. Two API machines that had each been busy once held every slot between them, idle, and
 * every new connection was refused with `max clients reached in session mode`. Letting go of idle ones gives
 * the slots back; the next request that needs one opens a fresh connection.
 */
const IDLE_TIMEOUT_SECONDS = 20;

/**
 * Bounds on a person's transaction. The API has only a handful of pooled connections, and a request holds one for
 * the whole of its transaction: one slow read, or a transaction left open while nothing runs, would otherwise keep
 * its slot for as long as it liked, and every other business's requests on that machine would queue behind it.
 * Generous for anything a screen asks for; the slow work (imports, sends, workflows) runs in the worker.
 */
const USER_STATEMENT_TIMEOUT = '15s';
const USER_IDLE_IN_TRANSACTION_TIMEOUT = '30s';

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    // Works behind Supavisor transaction mode and needs nothing on a direct connection.
    prepare: false,
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? 'hfos' },
  });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

/** Runs `fn` in one transaction as the signed-in user; RLS applies exactly as under PostgREST. */
export async function asUser<T>(
  db: Db,
  claims: UserClaims,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const payload = JSON.stringify({ role: 'authenticated', aud: 'authenticated', ...claims });
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${payload}, true)`);
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(
      sql`select set_config('statement_timeout', ${USER_STATEMENT_TIMEOUT}, true),
            set_config('idle_in_transaction_session_timeout', ${USER_IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
    );
    return fn(tx);
  });
}

/** Runs `fn` in one transaction as the worker's service actor, bounded to one tenant. */
export async function asWorker<T>(
  db: Db,
  scope: SystemScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // One round trip: `set_config('role', …, true)` is `set local role`, with the same membership check.
    await tx.execute(
      sql`select set_config('role', 'service_actor', true),
            set_config('app.system_scope.workspace_id', ${scope.workspaceId ?? ''}, true),
            set_config('app.system_scope.organization_id', ${scope.organizationId ?? ''}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Runs `fn` in one transaction as a customer signed in to their portal (Real Estate round two): the worker switches
 * to `portal_actor`, whose policies read only that customer's own rows, and only while the device's session is still
 * signed in. The database finds who it is from the session; nothing else the worker says is taken on trust.
 */
export async function asCustomer<T>(
  db: Db,
  sessionId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('role', 'portal_actor', true),
            set_config('app.portal.session_id', ${sessionId}, true),
            set_config('statement_timeout', ${USER_STATEMENT_TIMEOUT}, true),
            set_config('idle_in_transaction_session_timeout', ${USER_IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Runs `fn` in one transaction as the customer the AI teammate is answering (round seven): `portal_actor` again,
 * with the teammate's run in place of a device's session. The database finds the customer from the run, and only
 * while it is still answering, so the teammate reads what that client's portal shows them and nothing else.
 */
export async function asCustomerTeammate<T>(
  db: Db,
  runId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('role', 'portal_actor', true),
            set_config('app.portal.teammate_run', ${runId}, true),
            set_config('statement_timeout', ${USER_STATEMENT_TIMEOUT}, true),
            set_config('idle_in_transaction_session_timeout', ${USER_IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
    );
    return fn(tx);
  });
}

/** Rows from a raw `sql` query, typed by the caller. */
export async function rows<T extends Record<string, unknown>>(
  tx: Tx | Db,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await tx.execute(query);
  return Array.from(result as unknown as Iterable<T>);
}

export { schema, sql };
