/**
 * The worker's statements have a time limit (the speed audit, Nov 2026). They had none, so one waiting on a lock
 * held its connection for as long as it liked, and the outbox on that machine with it.
 *   - `asWorker` gives a statement a minute, for that transaction only.
 *   - A statement over its limit fails, and the next transaction runs as if nothing happened.
 *   - `noStatementLimit` lifts it, for the one statement that deletes a whole business.
 *   - An open worker transaction with nothing running is given no limit: a file import honestly leaves one open
 *     for minutes. The last two tests hold what happens if the database ever ends one: the transaction is told at
 *     once, and the process carries on when the work comes back (the driver alone stopped it; its patch doesn't).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { noStatementLimit, rows, sql, WORKER_STATEMENT_TIMEOUT, type Tx } from '../src/client';
import { asService, closeAll, dbs, testEnv } from './harness';

afterAll(closeAll);

/** A setting as milliseconds, however Postgres spells it back (`1min`, `60s`, `0`). */
const ms = async (tx: Tx, name: string) =>
  (
    await rows<{ ms: number }>(
      tx,
      sql`select (extract(epoch from (case when current_setting(${name}) ~ '^[0-9]+$'
            then current_setting(${name}) || 'ms' else current_setting(${name}) end)::interval) * 1000)::int as ms`,
    )
  )[0]!.ms;
const asWorkerHere = asService({});
const one = (tx: Tx) => rows<{ one: number }>(tx, sql`select 1 as one`);

describe('the worker’s statement limit', () => {
  it('gives a statement a minute', async () => {
    expect(WORKER_STATEMENT_TIMEOUT).toBe('60s');
    expect(await asWorkerHere((tx) => ms(tx, 'statement_timeout'))).toBe(60_000);
  });

  it('keeps it to its own transaction: the connection goes back as it came', async () => {
    const before = await dbs.worker.db.transaction((tx) => ms(tx, 'statement_timeout'));
    await asWorkerHere(one);
    expect(await dbs.worker.db.transaction((tx) => ms(tx, 'statement_timeout'))).toBe(before);
    expect(before).not.toBe(60_000);
  });

  it('fails a statement that runs over, and the next transaction runs', async () => {
    const ran = asWorkerHere(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '100ms', true)`);
      await tx.execute(sql`select pg_sleep(2)`);
    });
    await expect(ran).rejects.toMatchObject({ cause: { code: '57014' } });
    await expect(asWorkerHere(one)).resolves.toEqual([{ one: 1 }]);
  });

  it('lifts the limit where a whole business is deleted, and only there', async () => {
    const lifted = await asWorkerHere(async (tx) => {
      await noStatementLimit(tx);
      return ms(tx, 'statement_timeout');
    });
    expect(lifted).toBe(0);
    expect(await asWorkerHere((tx) => ms(tx, 'statement_timeout'))).toBe(60_000);
  });
});

describe('a worker’s open transaction with nothing running', () => {
  /** The driver alone, in a process of its own: the transaction sits idle past a limit of 150 ms. */
  const idleEnded = (how: 'returns' | 'never') =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/idle-transaction-ended.mjs', import.meta.url)), how],
      {
        env: { ...process.env, IDLE_DB_URL: testEnv.workerDbUrl },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

  it('is given no limit by asWorker', async () => {
    const [inside, outside] = [
      await asWorkerHere((tx) => ms(tx, 'idle_in_transaction_session_timeout')),
      await dbs.worker.db.transaction((tx) => ms(tx, 'idle_in_transaction_session_timeout')),
    ];
    expect(inside).toBe(outside);
  });

  it('would be told at once if the database ended it, and the pool would carry on', () => {
    const ran = idleEnded('never');
    expect(ran.stdout).toContain('rejected CONNECTION_CLOSED');
    expect(ran.stdout).toContain('next 1');
    expect(ran.status).toBe(0);
  });

  /**
   * The work coming back (a provider answering late) had the driver write COMMIT to the socket the database closed,
   * which threw outside any promise and stopped the process. `patches/postgres@3.4.9.patch` ends that: nothing goes
   * out on a transaction that is over. If this fails after the driver is updated, the patch is gone
   * ("Round trips to the database" in `docs/operations.md`).
   */
  it('carries on when the work comes back after the database ended it', () => {
    const ran = idleEnded('returns');
    expect(ran.stdout).toContain('rejected CONNECTION_CLOSED');
    expect(ran.stdout).toContain('next 1');
    expect(ran.stderr).not.toContain('TypeError');
    expect(ran.status).toBe(0);
  });
});
