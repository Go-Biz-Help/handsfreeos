/**
 * One round trip for a statement, not two (the speed audit, Nov 2026).
 *
 * The apps run the driver with `prepare: false`, because the pooler can't keep prepared statements. The driver then
 * asked the database about every statement with values before running it, and sent nothing else meanwhile: two round
 * trips a statement, and statements started together on one transaction went one at a time. `createDb` now gives the
 * driver a place to remember what it was told (`StatementTypes`), and `patches/postgres@3.4.9.patch` has it look
 * there first.
 *   - A statement is asked about the first time only. After that it goes out in one piece.
 *   - Statements started together on one transaction are sent together, and answered in the order they were started.
 *   - Values are written exactly as before: lists, ids, documents, yes/no, bytes, times.
 *   - A column that changes type is noticed on the next run, and the statement is asked about again.
 *   - Requests never see each other's sign-in, however many run at once.
 *
 * These read the messages the driver sends, through a relay between it and the database. If the first test fails
 * after the driver was upgraded, the patch is gone: "Round trips to the database" in `docs/operations.md`.
 */
import { randomUUID } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createDb, rows, sql, StatementTypes, type DbHandle } from '../src/client';
import { closeAll, testEnv } from './harness';

/** One message the driver sent, and how many statements the database had finished answering by then. */
interface Sent {
  readonly type: string;
  readonly answered: number;
}

/**
 * A relay between the driver and the database that reads what goes by. The first message on a connection (the
 * start-up packet) has no type; every other one is a letter, then its length.
 */
class Relay {
  readonly #sockets = new Set<Socket>();
  #server!: Server;
  #sent: Sent[] = [];
  #answered = 0;
  url = '';

  async open(databaseUrl: string): Promise<this> {
    const target = new URL(databaseUrl);
    const [port, host] = [Number(target.port), target.hostname];
    this.#server = createServer((app) => {
      const database = connect(port, host);
      for (const socket of [app, database]) {
        this.#sockets.add(socket);
        socket.on('error', () => {});
      }
      let started = false;
      let fromApp: Buffer = Buffer.alloc(0);
      let fromDatabase: Buffer = Buffer.alloc(0);
      app.on('data', (chunk: Buffer) => {
        fromApp = Buffer.concat([fromApp, chunk]);
        for (;;) {
          if (!started) {
            if (fromApp.length < 4 || fromApp.length < fromApp.readUInt32BE(0)) break;
            fromApp = fromApp.subarray(fromApp.readUInt32BE(0));
            started = true;
          } else {
            if (fromApp.length < 5 || fromApp.length < 1 + fromApp.readUInt32BE(1)) break;
            this.#sent.push({ type: String.fromCharCode(fromApp[0]!), answered: this.#answered });
            fromApp = fromApp.subarray(1 + fromApp.readUInt32BE(1));
          }
        }
        database.write(chunk);
      });
      database.on('data', (chunk: Buffer) => {
        fromDatabase = Buffer.concat([fromDatabase, chunk]);
        while (
          fromDatabase.length >= 5 &&
          fromDatabase.length >= 1 + fromDatabase.readUInt32BE(1)
        ) {
          // Z: ready for the next statement.
          if (fromDatabase[0] === 0x5a) this.#answered++;
          fromDatabase = fromDatabase.subarray(1 + fromDatabase.readUInt32BE(1));
        }
        app.write(chunk);
      });
      app.on('close', () => database.destroy());
      database.on('close', () => app.destroy());
    });
    await new Promise<void>((done) => this.#server.listen(0, '127.0.0.1', done));
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('The relay has no port.');
    target.hostname = '127.0.0.1';
    target.port = String(address.port);
    this.url = target.toString();
    return this;
  }

  /** Forgets what went by, so the next read holds only what follows. */
  clear(): void {
    this.#sent = [];
  }

  sent(): readonly Sent[] {
    return this.#sent;
  }

  /** The messages as their letters: P parse, D describe, H "answer now", B bind (the values), E run, S done. */
  letters(): string {
    return this.#sent.map((m) => m.type).join('');
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((done) => this.#server.close(() => done()));
  }
}

const ASKED_FIRST = 'PDHBES';
const ONE_PIECE = 'PDBES';

let relay: Relay;
let adminRelay: Relay;
const open: DbHandle[] = [];
/** One connection, so the messages of a test come in the order the test asked. */
const through = (to: Relay, rememberTypes?: boolean): DbHandle => {
  const handle = createDb(to.url, { max: 1, applicationName: 'hfos-test-trips', rememberTypes });
  open.push(handle);
  return handle;
};
/** Opens the connection (sign-in, and the driver's own look-up of list types) and clears the relay. */
const ready = async (handle: DbHandle, on: Relay): Promise<void> => {
  await rows(handle.db, sql`select 1 as one`);
  on.clear();
};

beforeAll(async () => {
  relay = await new Relay().open(testEnv.apiDbUrl);
  adminRelay = await new Relay().open(testEnv.adminDbUrl);
});

afterAll(async () => {
  await Promise.all(open.map((handle) => handle.close()));
  await relay.close();
  await adminRelay.close();
  await closeAll();
});

describe('a statement with values', () => {
  it('is asked about the first time only, and then goes out in one piece', async () => {
    const handle = through(relay);
    await ready(handle, relay);
    const ask = (n: number, word: string) =>
      rows<{ n: number; word: string }>(
        handle.db,
        sql`select ${n}::int as n, ${word}::text as word`,
      );

    expect(await ask(1, 'one')).toEqual([{ n: 1, word: 'one' }]);
    expect(relay.letters()).toBe(ASKED_FIRST);

    relay.clear();
    expect(await ask(2, 'two')).toEqual([{ n: 2, word: 'two' }]);
    expect(await ask(3, 'three')).toEqual([{ n: 3, word: 'three' }]);
    expect(relay.letters()).toBe(ONE_PIECE + ONE_PIECE);
  });

  it('is asked about every time where remembering is off, as the driver does on its own', async () => {
    const handle = through(relay, false);
    await ready(handle, relay);
    const ask = (n: number) => rows<{ n: number }>(handle.db, sql`select ${n}::int as n`);

    await ask(1);
    await ask(2);
    expect(relay.letters()).toBe(ASKED_FIRST + ASKED_FIRST);
  });

  it('is on unless the app says otherwise', async () => {
    const shared = (handle: DbHandle) =>
      (handle.client.options as unknown as { shared: { remembered?: unknown } }).shared.remembered;
    expect(shared(through(relay))).toBeInstanceOf(StatementTypes);
    expect(shared(through(relay, false))).toBeUndefined();
  });
});

describe('statements started together on one transaction', () => {
  /**
   * Five statements started together, and how many answers had come back when each one left the app (read before
   * the transaction's own `commit` goes by).
   */
  const five = (handle: DbHandle) =>
    handle.db.transaction(async (tx) => {
      const ask = (n: number) => rows<{ n: number }>(tx, sql`select ${n}::int as n`);
      await ask(0);
      relay.clear();
      const found = await Promise.all([1, 2, 3, 4, 5].map(ask));
      const answeredAtEachStart = relay
        .sent()
        .filter((m) => m.type === 'P')
        .map((m) => m.answered);
      return { found, answeredAtEachStart };
    });
  const inOrder = [[{ n: 1 }], [{ n: 2 }], [{ n: 3 }], [{ n: 4 }], [{ n: 5 }]];

  it('are sent together, and answered in the order they were started', async () => {
    const handle = through(relay);
    await ready(handle, relay);

    const { found, answeredAtEachStart } = await five(handle);
    expect(found).toEqual(inOrder);
    expect(answeredAtEachStart).toHaveLength(5);
    // All five had left before the first was answered.
    expect(new Set(answeredAtEachStart).size).toBe(1);
  });

  it('went one at a time before, each waiting for the last one’s answer', async () => {
    const handle = through(relay, false);
    await ready(handle, relay);

    const { found, answeredAtEachStart } = await five(handle);
    expect(found).toEqual(inOrder);
    expect(new Set(answeredAtEachStart).size).toBe(5);
  });

  it('give the real error when one of them fails, and the next transaction runs', async () => {
    const handle = through(relay);
    const failed = handle.db.transaction((tx) =>
      Promise.all([
        rows(tx, sql`select ${1}::int as n`),
        rows(tx, sql`select ${'not a number'}::int as n`),
        rows(tx, sql`select ${3}::int as n`),
      ]),
    );
    await expect(failed).rejects.toMatchObject({ cause: { code: '22P02' } });
    expect(await rows(handle.db, sql`select ${7}::int as n`)).toEqual([{ n: 7 }]);
  });
});

describe('values written from memory', () => {
  it('are written exactly as they were the first time', async () => {
    const id = randomUUID();
    const ask = (handle: DbHandle) =>
      rows<Record<string, unknown>>(
        handle.db,
        sql`select ${sql.param(['a', 'b,c', 'd "e"', ''])}::text[] as words,
              ${sql.param([id, id])}::uuid[] as ids,
              ${sql.param([1, 2, 3])}::int[] as numbers,
              ${JSON.stringify({ a: [1, 2], b: 'x', c: null })}::jsonb as document,
              ${true}::boolean as yes, ${false}::boolean as no,
              ${'2026-11-25T01:02:03.456Z'}::timestamptz as moment,
              ${'2026-11-25'}::date as day,
              ${null}::text as nothing,
              ${12.5}::numeric as amount,
              ${Buffer.from('h\\i\0there')}::bytea as bytes,
              ${'h\\i'}::bytea as words_as_bytes,
              ${'it’s “quoted”'}::text as words_with_marks`,
      );

    const remembering = through(relay);
    const first = await ask(remembering);
    const second = await ask(remembering);
    const third = await ask(remembering);
    const asking = await ask(through(relay, false));

    expect(first[0]).toMatchObject({
      words: ['a', 'b,c', 'd "e"', ''],
      ids: [id, id],
      numbers: [1, 2, 3],
      document: { a: [1, 2], b: 'x', c: null },
      yes: true,
      no: false,
      nothing: null,
      amount: '12.5',
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(asking).toEqual(first);
  });
});

describe('a column that changes type', () => {
  it('is noticed on the next run, and the statement is asked about again', async () => {
    // One connection, so the temporary table is there for every statement.
    const { db } = through(adminRelay);
    await rows(db, sql`create temp table trips_check (v int)`);
    await rows(db, sql`insert into trips_check values (5)`);
    const find = (v: unknown) =>
      rows<{ n: number }>(
        db,
        sql`select count(*)::int as n from trips_check where v = ${sql.param(v)}`,
      );
    const run = async (v: unknown) => {
      adminRelay.clear();
      const found = await find(v);
      return { found, letters: adminRelay.letters() };
    };

    expect(await run(5)).toEqual({ found: [{ n: 1 }], letters: ASKED_FIRST });
    expect(await run(5)).toEqual({ found: [{ n: 1 }], letters: ONE_PIECE });

    // A whole number becomes a bigger whole number: the value is written the same, so nothing fails. The
    // database's answer no longer matches what was remembered, so the next run asks first.
    await rows(db, sql`alter table trips_check alter column v type bigint`);
    expect(await run(5)).toEqual({ found: [{ n: 1 }], letters: ONE_PIECE });
    expect(await run(5)).toEqual({ found: [{ n: 1 }], letters: ASKED_FIRST });
    expect(await run(5)).toEqual({ found: [{ n: 1 }], letters: ONE_PIECE });

    // A number becomes a list of numbers: a list is written another way. The one run still written the old way is
    // refused by the database (never taken as something else), and the next is right.
    await rows(db, sql`alter table trips_check alter column v type bigint[] using array[v]`);
    await expect(find([5])).rejects.toMatchObject({ cause: { code: '22P02' } });
    expect(await run([5])).toEqual({ found: [{ n: 1 }], letters: ASKED_FIRST });
    expect(await run([5])).toEqual({ found: [{ n: 1 }], letters: ONE_PIECE });
  });
});

describe('many requests at once', () => {
  it('never see each other’s sign-in', async () => {
    // Four connections for forty people, as a busy API machine has fewer connections than requests.
    const handle = createDb(testEnv.apiDbUrl, { max: 4, applicationName: 'hfos-test-trips' });
    open.push(handle);
    const people = Array.from({ length: 40 }, () => randomUUID());
    const wrong: string[] = [];

    for (let round = 0; round < 3; round++) {
      await Promise.all(
        people.map((sub, person) =>
          asUser(handle.db, { sub }, async (tx) => {
            const together = await Promise.all(
              Array.from({ length: 6 }, (_, i) =>
                rows<{ uid: string; i: number }>(
                  tx,
                  sql`select auth.uid()::text as uid, ${i + person}::int as i`,
                ),
              ),
            );
            const [after] = await rows<{ uid: string; claims: string }>(
              tx,
              sql`select auth.uid()::text as uid, current_setting('request.jwt.claims', true) as claims, ${person}::int as person`,
            );
            for (const [i, [row]] of together.entries())
              if (row!.uid !== sub || row!.i !== i + person) wrong.push(`${sub} got ${row!.uid}`);
            if (after!.uid !== sub || !after!.claims.includes(sub))
              wrong.push(`${sub} got ${after!.uid}`);
          }),
        ),
      );
    }
    expect(wrong).toEqual([]);

    // And nothing of a finished request is left on a connection.
    const left = await Promise.all(
      Array.from({ length: 12 }, () =>
        rows<{ claims: string | null; who: string }>(
          handle.db,
          sql`select nullif(current_setting('request.jwt.claims', true), '') as claims, current_user::text as who, ${1}::int as one`,
        ),
      ),
    );
    expect(left.every(([row]) => row!.claims === null && row!.who !== 'authenticated')).toBe(true);
  });
});

describe('what is remembered', () => {
  it('has a limit: the oldest statements go first', () => {
    const types = new StatementTypes();
    for (let i = 0; i < 4500; i++) types.set(`select ${i}`, [23]);
    expect(types.size).toBe(4000);
    expect(types.get('select 0')).toBeUndefined();
    expect(types.get('select 499')).toBeUndefined();
    expect(types.get('select 500')).toEqual([23]);
    expect(types.get('select 4499')).toEqual([23]);
  });

  it('has a limit on the text it holds too', () => {
    const types = new StatementTypes();
    const long = (i: number) => `select ${i} /* ${'x'.repeat(29_000)} */`;
    for (let i = 0; i < 300; i++) types.set(long(i), [25]);
    expect(types.size).toBeLessThan(210);
    expect(types.size).toBeGreaterThan(190);
    expect(types.get(long(0))).toBeUndefined();
    expect(types.get(long(299))).toEqual([25]);
  });

  it('never keeps a very long statement, such as an insert of many rows', () => {
    const types = new StatementTypes();
    const huge = `insert into t values ${'($1),'.repeat(6001)}`;
    types.set(huge, [25]);
    expect(types.size).toBe(0);
    expect(types.get(huge)).toBeUndefined();
  });

  it('forgets a statement when asked to, and counts its text back', () => {
    const types = new StatementTypes();
    types.set('select $1', [25]);
    types.set('select $1', [23]);
    expect(types.size).toBe(1);
    expect(types.get('select $1')).toEqual([23]);
    types.delete('select $1');
    types.delete('select $1');
    expect(types.size).toBe(0);
  });
});
