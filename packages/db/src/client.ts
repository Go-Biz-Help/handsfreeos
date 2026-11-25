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
  /**
   * Whether the driver remembers the types of each statement's values (`StatementTypes`). On unless
   * `HFOS_DB_REMEMBER_TYPES` is `off`, the switch for a live app; a test passes `false` to compare the two.
   */
  readonly rememberTypes?: boolean;
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

/** How many statements' types are kept, and how many characters of statement text in all. */
const REMEMBERED_STATEMENTS = 4000;
const REMEMBERED_CHARACTERS = 6_000_000;
/** A statement longer than this is not kept: a many-row insert is a different statement for every count of rows. */
const LONGEST_REMEMBERED = 30_000;

/**
 * The types of the values each statement takes, as the database described them the first time it ran (the speed
 * audit, Nov 2026).
 *
 * The pooler can't keep prepared statements, so the driver runs with `prepare: false`. Then it asked the database
 * about every statement with values before running it: two round trips where one would do, and nothing else sent
 * meanwhile, so statements started together on one transaction still went one at a time. Through the pooler a round
 * trip is about 3 ms, and a page asks hundreds of statements. That waiting was more than the statements' own work.
 *
 * `patches/postgres@3.4.9.patch` lets the driver look here first. A statement it has seen goes out in one piece,
 * its values written by the remembered types, exactly as they were written before; and statements started together
 * are sent together, in the order they were started. The statement itself is sent as it always was, so the
 * database still works the types out afresh every time, and its answer is checked against what was remembered: after
 * a column changes type, the first run of each statement that takes it forgets, and the next asks first again. That
 * first run is written by the old type. It only matters between a yes/no, bytes or list column and another kind,
 * where the database refuses the value; every other value is written the same for any type.
 *
 * Kept per client, by the statement's text and the types its values show, oldest out first.
 * `packages/db/test/statement-trips.test.ts` holds all of it; "Round trips to the database" in
 * `docs/operations.md` says how to turn it off and what to do when the driver is upgraded.
 */
export class StatementTypes {
  readonly #known = new Map<string, number[]>();
  #characters = 0;

  get size(): number {
    return this.#known.size;
  }

  get(statement: string): number[] | undefined {
    return this.#known.get(statement);
  }

  set(statement: string, types: number[]): void {
    if (statement.length > LONGEST_REMEMBERED) return;
    this.delete(statement);
    this.#known.set(statement, types);
    this.#characters += statement.length;
    for (const oldest of this.#known.keys()) {
      if (this.#known.size <= REMEMBERED_STATEMENTS && this.#characters <= REMEMBERED_CHARACTERS)
        break;
      this.delete(oldest);
    }
  }

  delete(statement: string): void {
    if (this.#known.delete(statement)) this.#characters -= statement.length;
  }
}

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const client = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    // Works behind Supavisor transaction mode and needs nothing on a direct connection.
    prepare: false,
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? 'hfos' },
  });
  if (opts.rememberTypes ?? process.env.HFOS_DB_REMEMBER_TYPES !== 'off') {
    // The driver's `options.shared` is one object for every connection of this client; `remembered` is the field
    // the patch reads. An unpatched driver never looks at it, and asks first every time, as before.
    (client.options as unknown as { shared: { remembered?: StatementTypes } }).shared.remembered =
      new StatementTypes();
  }
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
