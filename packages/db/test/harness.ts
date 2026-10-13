export * from '../src/testing';
import { testDbs, closeTestDbs, testEnv as env } from '../src/testing';
export const dbs = testDbs();
export const closeAll = closeTestDbs;
export const testEnv = env();

/**
 * Runs a test's own schema change (an add-on's table, its policies, a trigger), again if Postgres picked it to
 * break a deadlock. Turbo runs the other packages' suites against the same database at the same time, and DDL
 * takes locks in its own order, so now and then it meets a session writing the same tables the other way round.
 * Postgres rolls the loser back whole, so running it again is safe: `fn` is one statement or one transaction.
 */
export async function retryDeadlock<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !isDeadlock(e)) throw e;
      await new Promise((r) => setTimeout(r, 50 * attempt + Math.random() * 100));
    }
  }
}

function isDeadlock(e: unknown): boolean {
  for (let x: unknown = e; x && typeof x === 'object'; x = (x as { cause?: unknown }).cause)
    if ((x as { code?: unknown }).code === '40P01') return true;
  return false;
}
