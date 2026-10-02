/**
 * Real Estate Agent, round five, step 6, in the worker: our own listings' status from the listing feed, against the
 * stand-in MLS.
 *
 * - Before it's on the MLS, nothing is said. Seen Active there, it's marked live here (the hold lifts, the deal
 *   moves to Active) with the feed as proof.
 * - A price or status on the MLS that differs from the deal's is flagged on a Home card for the deal's people, never
 *   copied over; once they agree the card comes down.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  ADDON_CATALOG,
  ADDON_SERVER_MODULES,
  catalogAddon,
  executeCommand,
  executeQuery,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import { FeedSearchSchema } from '@hfos/core/addons/realestate/feed';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonScope } from '../src/addons/context';
import { addonJobs, withAddons } from '../src/addons/index';
import { putStandinListing, resetStandin } from '../src/addons/realestate/feed/index';
import { armFeedCheck, FEED_CHECK } from '../src/addons/realestate/feed/searches';
import { createStandinFeed } from '../src/addons/realestate/feed/standin';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { workerMeta } from '../src/services';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const realestate = ADDON_SERVER_MODULES.find((m) => m.manifest.id === 'realestate')!;
const op = (name: string) =>
  [...realestate.commands!, ...realestate.queries!].find((c) => c.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;
const ADDRESS = '77 Feedback Way, Austin, TX 78704';

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-status-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()
            and kind <> 'realestate.sweep'`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

async function check() {
  await armFeedCheck(
    addonScope(
      s,
      catalogAddon('realestate'),
      { workspaceId: ws, organizationId: org },
      1,
      workerMeta(),
    ),
  );
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now()
        where status = 'pending' and workspace_id = ${ws} and kind = ${FEED_CHECK}`,
  );
  await drain();
}
const listing = async () => (await ask('realestate.listing', { dealId: deal })).listing;
const card = async () =>
  (
    await rows<{ title: string; detail: string; severity: string; cleared: boolean }>(
      admin(),
      sql`select title, detail, severity, cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and key = ${`feed:${deal}`}`,
    )
  )[0];

/** Our listing as the stand-in MLS has it, changed as asked. */
async function onTheMls(change: { status?: 'active' | 'pending'; listPriceCents?: number }) {
  const base = (
    await createStandinFeed().search(
      FeedSearchSchema.parse({ zips: ['78704'], limit: 1 }),
      AbortSignal.timeout(1000),
    )
  ).listings[0]!;
  putStandinListing({
    ...base,
    mlsNumber: 'OURS-77',
    listingKey: 'standin-ours-77',
    address: { ...base.address, line: '77 Feedback Way', unit: null, zip: '78704' },
    status: change.status ?? 'active',
    standardStatus: change.status === 'pending' ? 'Pending' : 'Active',
    listPriceCents: change.listPriceCents ?? 52_500_000,
    listedOn: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  resetStandin();
  s = testServices();
  agent = await createTestUser('feed-status-agent', { fullName: 'Sam Rivera' });
  ws = await realestateBusiness(agent, 'Listing Status Realty');
  [{ organization_id: org }] = (await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  )) as [{ organization_id: string }];
  deal = (
    await run('realestate.deal.open', {
      side: 'listing',
      name: 'Feedback Way listing',
      newPropertyAddress: ADDRESS,
    })
  ).dealId;
  await run('realestate.term.enter', {
    dealId: deal,
    key: 'list_price',
    cents: 52_500_000,
    source: 'agreement',
  });
  await executeCommand(
    testDbs().worker.db,
    addonConnectionCommands(ADDON_CATALOG).save,
    {
      workspaceId: ws,
      addonId: 'realestate',
      connector: 'listing_data',
      provider: 'repliers',
      auth: 'key',
      label: 'Stand-in Repliers account',
      accountRef: null,
      secretEnc: s.sealer.seal(JSON.stringify({ apiKey: 'k' })),
      keyId: s.sealer.keyId,
      connectedBy: agent.id,
    },
    { type: 'system', workspaceId: ws, organizationId: org, onBehalfOf: agent.id },
    meta(),
  );
}, 90_000);
afterAll(async () => {
  resetStandin();
  await closeTestDbs();
});

describe('our listing on the MLS', () => {
  it('says nothing before it’s there', async () => {
    await check();
    const l = await listing();
    expect(l.mls).toBeNull();
    expect(l.feed).toMatchObject({ state: 'none', differences: [] });
    expect(await card()).toBeUndefined();
  });

  it('is marked live once the MLS shows it Active, with the feed as proof', async () => {
    await onTheMls({});
    await check();
    const l = await listing();
    expect(l.mls).toMatchObject({ number: 'OURS-77' });
    expect(l.feed).toMatchObject({
      state: 'found',
      mls: { mlsNumber: 'OURS-77' },
      differences: [],
    });
    const { deal: d } = await ask('realestate.deal.get', { dealId: deal });
    expect(d.stage).toBe('active');
    // Its history says the feed saw it, as the system.
    const [line] = await rows<{ actor_type: string; after: Record<string, string> }>(
      admin(),
      sql`select actor_type, after from addon_realestate.deal_history
          where deal_record_id = ${deal} and what = 'listing_live'`,
    );
    expect(line).toMatchObject({
      actor_type: 'system',
      after: { mlsNumber: 'OURS-77', from: 'seen on the MLS, from the stand-in MLS' },
    });
    expect(await card()).toBeUndefined();
  });

  it('flags a price or status that differs, never copying it, until they agree', async () => {
    await onTheMls({ listPriceCents: 51_000_000 });
    await check();
    expect((await listing()).feed.differences.map((d: Any) => d.key)).toEqual(['price']);
    expect(await card()).toMatchObject({
      title: 'The MLS and HandsFreeOS disagree on Feedback Way listing',
      severity: 'attention',
      cleared: false,
      detail: expect.stringMatching(/The MLS shows \$510,000; the deal’s list price is \$525,000/),
    });
    // Ours stays ours.
    const [price] = await rows<{ cents: string }>(
      admin(),
      sql`select value_cents::text as cents from addon_realestate.term_entries
          where deal_record_id = ${deal} and key = 'list_price' and superseded_at is null`,
    );
    expect(price!.cents).toBe('52500000');

    await onTheMls({ status: 'pending' });
    await check();
    expect((await listing()).feed.differences.map((d: Any) => d.key)).toEqual(['status']);
    expect((await card())!.detail).toMatch(/The MLS shows it pending; here it’s for sale/);

    await onTheMls({});
    await check();
    expect((await listing()).feed.differences).toEqual([]);
    expect((await card())!.cleared).toBe(true);
  });
});
