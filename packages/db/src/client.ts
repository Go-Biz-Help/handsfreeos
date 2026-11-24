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
 * Seconds an unused connection stays open. The apps connect through Supavisor's transaction pooler (since 26 Sep
 * 2026), where an open connection that is doing nothing holds no database connection: only the pooler's 200
 * clients are counted, and every app together opens a few dozen. So a connection is kept ten minutes.
 *
 * It was 20 seconds, from the days on the session pooler, where each open connection held one of 15 slots and two
 * idle API machines once filled them all. On the transaction pooler that only cost: the driver hands out the
 * connection that has waited longest, so at a request every few seconds nearly every one had just timed out, and
 * one request in seven opened a new connection first (TLS, the password exchange and the driver's 900-row type
 * look-up) before it could start.
 */
const IDLE_TIMEOUT_SECONDS = 600;

/**
 * Bounds on a person's transaction. The API has only a handful of pooled connections, and a request holds one for
 * the whole of its transaction: one slow read, or a transaction left open while nothing runs, would otherwise keep
 * its slot for as long as it liked, and every other business's requests on that machine would queue behind it.
 * Generous for anything a screen asks for; the slow work (imports, sends, workflows) runs in the worker.
 */
const USER_STATEMENT_TIMEOUT = '15s';
const USER_IDLE_IN_TRANSACTION_TIMEOUT = '30s';

/**
 * The bound on a worker's statement (the speed audit, Nov 2026). It had none: a statement waiting on a lock that its
 * own outbox transaction held waited for good, and so did every business's texts, emails and pushes on that machine
 * (handlers/telephony.ts tells of one). The longest statement the live database had on record was 3.3 seconds. One
 * that runs past a minute fails as any statement does, with its connection as good as before, and its event, delivery
 * or job is tried again. Deleting a whole business is the one statement that may honestly take longer, and says so
 * (`noStatementLimit`).
 *
 * **An open transaction with nothing running has no limit here, on purpose**, though a person's has one above:
 *
 * - The outbox runs its handlers inside one transaction, and honest work leaves it idle for minutes: a file import
 *   runs from start to end inside its handler (handlers/import-run.ts), in transactions of its own.
 * - When the database ends an idle transaction, this driver (postgres 3.4.9) rejects the transaction at once, and
 *   then writes its COMMIT or ROLLBACK to the closed socket when the work at last returns: a TypeError outside any
 *   promise, which stops the process. `packages/db/test/worker-limits.test.ts` keeps both halves in view.
 *
 * What bounds an idle worker transaction is each provider call's own time limit (Twilio, Postmark, Meta and the
 * rest), so a call made from inside the outbox's transaction always ends.
 */
export const WORKER_STATEMENT_TIMEOUT = '60s';

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
    // One round trip, where it was three on every request: `set_config('role', …, true)` is `set local role`,
    // with the same membership check. None of the four depends on another.
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${payload}, true),
            set_config('role', 'authenticated', true),
            set_config('statement_timeout', ${USER_STATEMENT_TIMEOUT}, true),
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
            set_config('app.system_scope.organization_id', ${scope.organizationId ?? ''}, true),
            set_config('statement_timeout', ${WORKER_STATEMENT_TIMEOUT}, true)`,
    );
    return fn(tx);
  });
}

/**
 * For the rest of a worker's transaction, a statement may take as long as it needs: for the one statement that
 * deletes a whole business and everything in it, which grows with the business. Nothing else should ask for it.
 */
export async function noStatementLimit(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('statement_timeout', '0', true)`);
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
