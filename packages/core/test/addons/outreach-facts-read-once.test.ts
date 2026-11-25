/**
 * Social Outreach reads the business's small facts once for a query (src/addons/outreach/ops/common.ts, `readOnce`):
 * its settings and its playbooks, however many parts of the query ask. A command reads them each time it asks, since
 * it may have just changed them.
 *
 * A day's list (`outreach.today`) is the query with the most parts, so it's the one watched here, through the driver's
 * own note of each statement it sends: the person's choices, their first steps, the playbooks, a network's warning, its
 * pause on requests and their computer's build are each asked for once, however many parts of the list need them.
 */
import { randomUUID } from 'node:crypto';
import { createDb, type DbHandle } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testEnv, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readOnce, type Ctx } from '../../src/addons/outreach/ops/common';
import { today } from '../../src/addons/outreach/ops/today';
import { executeQuery, type QueryDef } from '../../src/server';
import { computerOn, human, outreachBusiness, runAs } from './outreach-fixture';

const query = () => ({ tx: {}, scope: { workspaceId: 'w' } }) as unknown as Ctx;
const command = () => ({ ...query(), emit: () => undefined }) as unknown as Ctx;

describe('a small fact of the business', () => {
  it('is read once for a query, each fact its own, and again for the next query', async () => {
    let reads = 0;
    const read = async () => ++reads;
    const first = query();
    expect(
      await Promise.all([readOnce(first, 'settings', read), readOnce(first, 'settings', read)]),
    ).toEqual([1, 1]);
    expect(await readOnce(first, 'settings', read)).toBe(1);
    expect(await readOnce(first, 'playbooks', read)).toBe(2);
    expect(await readOnce(query(), 'settings', read)).toBe(3);
  });

  it('keeps the answer, not the question: a query builder, which runs each time it’s awaited, runs once', async () => {
    let runs = 0;
    // As a query builder is: nothing is asked till it's awaited, and each await asks again.
    const builder = (): PromiseLike<number> => ({
      then: (done, failed) => Promise.resolve(++runs).then(done, failed),
    });
    const first = query();
    expect(await readOnce(first, 'warning', builder)).toBe(1);
    expect(await readOnce(first, 'warning', builder)).toBe(1);
    expect(runs).toBe(1);
  });

  it('is read every time a command asks', async () => {
    let reads = 0;
    const read = async () => ++reads;
    const saving = command();
    expect(await readOnce(saving, 'settings', read)).toBe(1);
    expect(await readOnce(saving, 'settings', read)).toBe(2);
  });
});

describe('a day’s list', () => {
  let owner: TestUser;
  let ws: string;
  let watched: DbHandle;
  const asked: string[] = [];

  /** The statements one day's list sends, on a connection of its own that notes each. */
  const listOn = async (platform: string): Promise<string[]> => {
    asked.length = 0;
    await executeQuery(
      watched.db,
      today as unknown as QueryDef,
      { workspaceId: ws, platform },
      human(owner),
      { correlationId: randomUUID(), channel: 'extension' },
    );
    return [...asked];
  };
  /** How many of them read one of the add-on's tables on its own, as the small facts are read. */
  const reads = (statements: readonly string[], table: string) =>
    statements.filter((s) => s.includes(`from "addon_outreach"."${table}"`)).length;
  /** Those of them sent more than once, word for word: the same question asked again. */
  const askedAgain = (statements: readonly string[], tables: readonly string[]) => [
    ...new Set(
      statements.filter(
        (s, i) =>
          statements.indexOf(s) !== i &&
          tables.some((table) => s.includes(`from "addon_outreach"."${table}"`)),
      ),
    ),
  ];
  const SMALL_FACTS = [
    'automation',
    'network_starts',
    'playbooks',
    'warnings',
    'request_pauses',
    'computers',
  ];

  beforeAll(async () => {
    owner = await createTestUser('reads-once');
    ws = await outreachBusiness(owner, 'Reads Once Co');
    await computerOn(owner, ws, '0.200.0');
    // The fixture gets the person ready and past their first weeks on the way to a first list.
    await runAs(owner, ws, 'outreach.today', { platform: 'facebook' });
    watched = createDb(testEnv().apiDbUrl, { max: 1, applicationName: 'hfos-test-reads-once' });
    (watched.client.options as { debug?: unknown }).debug = (
      _connection: number,
      statement: string,
    ) => asked.push(statement);
  });
  afterAll(async () => {
    await watched.close();
    await closeTestDbs();
  });

  it('asks once for the person’s choices, their first steps, the playbooks, the network’s warning and its pause', async () => {
    const sent = await listOn('facebook');
    expect(sent.length).toBeGreaterThan(20);
    // Each is asked for, so the list below isn't empty for want of asking.
    for (const table of ['automation', 'network_starts', 'playbooks', 'warnings', 'request_pauses'])
      expect(reads(sent, table), table).toBeGreaterThanOrEqual(1);
    expect(askedAgain(sent, SMALL_FACTS)).toEqual([]);
    expect(reads(sent, 'automation')).toBe(1);
    expect(reads(sent, 'network_starts')).toBe(1);
    expect(reads(sent, 'warnings')).toBe(1);
    expect(reads(sent, 'request_pauses')).toBe(1);
    expect(reads(sent, 'computers')).toBeLessThanOrEqual(1);
  });

  it('does on every network, each with its own warning and pause', async () => {
    for (const platform of ['linkedin', 'alignable']) {
      const sent = await listOn(platform);
      expect(askedAgain(sent, SMALL_FACTS), platform).toEqual([]);
      expect(reads(sent, 'warnings'), platform).toBe(1);
    }
  });
});
