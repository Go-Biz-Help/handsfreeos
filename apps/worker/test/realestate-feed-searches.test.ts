/**
 * Real Estate Agent, round five, step 5, in the worker: each buyer's saved search on the listing feed, against the
 * stand-in MLS.
 *
 * - Every fifteen minutes the buyer's profile is asked of the feed; new homes wait for the agent, with how each fits.
 * - A Home card for the agent at most once a day per buyer, taken down once nothing waits. Never to the client.
 * - The same listing is one match; one the MLS changed since is marked.
 * - Sending a match makes it one of the deal's homes, with what the MLS said; setting it aside keeps it from coming
 *   back. A search that's off, or a profile without an area, asks nothing.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  ADDON_CATALOG,
  ADDON_SERVER_MODULES,
  catalogAddon,
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
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
import { FeedSearchSchema } from '@hfos/core/addons/realestate/feed';

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

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-search-${randomUUID().slice(0, 8)}`;
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

/** The feed check, now. */
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
    sql`update app.scheduled_jobs set run_at = now() where status = 'pending' and workspace_id = ${ws} and kind = ${FEED_CHECK}`,
  );
  await drain();
}
const matches = () => ask('realestate.matches', { dealId: deal });
const card = async () =>
  (
    await rows<{ title: string; severity: string; cleared: boolean }>(
      admin(),
      sql`select title, severity, cleared_at is not null as cleared from app.addon_alerts
          where workspace_id = ${ws} and key = ${`matches:${deal}`}`,
    )
  )[0];

beforeAll(async () => {
  resetStandin();
  s = testServices();
  agent = await createTestUser('feed-search-agent', { fullName: 'Sam Rivera' });
  ws = await realestateBusiness(agent, 'Saved Search Realty');
  [{ organization_id: org }] = (await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  )) as [{ organization_id: string }];
  const client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
    })
  ).dealId;
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

describe('a buyer’s saved search', () => {
  it('waits for an area before it asks anything', async () => {
    await run('realestate.buyer_profile.save', { dealId: deal, profile: { bedsMin: 2 } });
    await check();
    const m = await matches();
    expect(m.search).toMatchObject({
      on: true,
      feedConnected: true,
      missing: expect.stringMatching(/Add the areas the buyer wants/),
    });
    expect(m.matches).toEqual([]);
  });

  it('brings new homes for the agent, with how each fits, and one Home card', async () => {
    await run('realestate.buyer_profile.save', {
      dealId: deal,
      profile: { bedsMin: 3, areas: ['78704'], budgetMaxCents: 200_000_000 },
    });
    await check();
    const m = await matches();
    expect(m.search).toMatchObject({
      missing: null,
      words: expect.stringMatching(/3\+ beds.*in 78704/),
    });
    expect(m.matches.length).toBeGreaterThan(0);
    expect(m.counts).toEqual({ new: m.matches.length, sent: 0, dismissed: 0 });
    for (const x of m.matches as Any[]) {
      expect(x.state).toBe('new');
      expect(['active', 'coming_soon']).toContain(x.mls.status);
      expect(x.mls.facts.beds).toBeGreaterThanOrEqual(3);
      expect(x.address).toMatch(/78704$/);
      expect(x.fit.lines.find((l: Any) => l.key === 'beds').met).toBe(true);
    }
    expect(await card()).toEqual({
      title: `${m.matches.length} new homes for Nguyen purchase`,
      severity: 'info',
      cleared: false,
    });
  });

  it('keeps the same listing as one match, marks what the MLS changed, and puts up no second card that day', async () => {
    const before = (await matches()).matches as Any[];
    const first = before[0];
    // The MLS lowers one's price, and a new home comes on.
    const page = await createStandinFeed().search(
      FeedSearchSchema.parse({
        mlsNumbers: [first.mls.mlsNumber],
        statuses: ['active', 'coming_soon'],
      }),
      AbortSignal.timeout(1000),
    );
    const listing = page.listings[0]!;
    putStandinListing({
      ...listing,
      listPriceCents: listing.listPriceCents! - 1_000_000,
      updatedAt: new Date().toISOString(),
    });
    putStandinListing({
      ...listing,
      mlsNumber: 'NEW-1',
      listingKey: 'standin-new-1',
      address: { ...listing.address, line: '2 Brand New Ln' },
      updatedAt: new Date().toISOString(),
    });
    await rows(
      admin(),
      sql`update app.addon_alerts set title = 'seen' where workspace_id = ${ws} and key = ${`matches:${deal}`}`,
    );
    await check();
    const after = (await matches()).matches as Any[];
    expect(after.length).toBe(before.length + 1);
    expect(after.find((x) => x.id === first.id).changedAt).not.toBeNull();
    expect(after.some((x) => x.mls.mlsNumber === 'NEW-1')).toBe(true);
    // Today's card already went up.
    expect((await card())!.title).toBe('seen');
  });

  it('sends a match to the client as one of the deal’s homes, and sets the rest aside', async () => {
    const list = (await matches()).matches as Any[];
    const pick = list[0];
    const { homeId } = await run('realestate.match.send', { matchId: pick.id });
    const homes = (await ask('realestate.homes', { dealId: deal })).homes as Any[];
    const home = homes.find((h) => h.id === homeId);
    expect(home).toMatchObject({
      source: 'mls',
      mlsState: 'found',
      factsState: 'suggested',
      mls: { mlsNumber: pick.mls.mlsNumber, sourceWords: 'From the stand-in MLS' },
    });
    await expect(run('realestate.match.send', { matchId: pick.id })).rejects.toMatchObject({
      rule: 'realestate_match_decided',
    });
    for (const x of list.slice(1)) await run('realestate.match.dismiss', { matchId: x.id });
    await drain();
    const m = await matches();
    expect(m.counts).toEqual({ new: 0, sent: 1, dismissed: list.length - 1 });
    expect(m.matches[0]).toMatchObject({ state: 'sent', homeId });
    // Nothing waits: the card comes down.
    expect((await card())!.cleared).toBe(true);
    // Set aside, they don't come back.
    await rows(
      admin(),
      sql`update addon_realestate.buyer_profiles set search_checked_at = null where deal_record_id = ${deal}`,
    );
    await check();
    expect((await matches()).counts.new).toBe(0);
  });

  it('asks nothing while it’s off', async () => {
    expect(await run('realestate.search.set', { dealId: deal, on: false })).toMatchObject({
      changed: true,
    });
    const one = (
      await createStandinFeed().search(
        FeedSearchSchema.parse({ zips: ['78704'], bedsMin: 3, limit: 1 }),
        AbortSignal.timeout(1000),
      )
    ).listings[0]!;
    putStandinListing({
      ...one,
      mlsNumber: 'NEW-2',
      listingKey: 'standin-new-2',
      address: { ...one.address, line: '4 Quiet Off Ln' },
      updatedAt: new Date().toISOString(),
    });
    await check();
    expect((await matches()).matches.some((x: Any) => x.mls.mlsNumber === 'NEW-2')).toBe(false);
    await run('realestate.search.set', { dealId: deal, on: true });
    await check();
    expect((await matches()).matches.some((x: Any) => x.mls.mlsNumber === 'NEW-2')).toBe(true);
  });
});
