/**
 * Real Estate Agent, round five, step 4, in the worker: the listing feed at work, against the stand-in MLS.
 *
 * - A buyer's new home is looked up on the MLS when a feed is connected: what it says is kept as it said it, and
 *   fills only the facts still empty, for the agent to confirm. What a person confirmed is never overwritten; where
 *   the MLS disagrees, both are shown.
 * - An address the MLS doesn't have says so; a home can be looked up again by its MLS number.
 * - Our own listing gets the MLS as one more source for each fact.
 * - A CMA's comps: homes sold near it come in from the MLS, nearest first, and don't count until ticked.
 * - With no feed connected, nothing is looked up.
 */
import { randomUUID } from 'node:crypto';
import {
  addonConnectionCommands,
  ADDON_CATALOG,
  ADDON_SERVER_MODULES,
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
import { addonJobs, withAddons } from '../src/addons/index';
import { createStandinFeed } from '../src/addons/realestate/feed/standin';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
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
let buyerDeal: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-feed-${randomUUID().slice(0, 8)}`;
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

/** A stand-in home to look up, found the way the feed would. */
async function standinHome(status: 'active' | 'sold', index = 0) {
  const page = await createStandinFeed().search(
    FeedSearchSchema.parse({ statuses: [status], zips: ['78704'], limit: 100 }),
    AbortSignal.timeout(1000),
  );
  return page.listings.filter((l) => !l.address.unit)[index]!;
}
const homeOf = async (homeId: string) =>
  ((await ask('realestate.homes', { dealId: buyerDeal })).homes as Any[]).find(
    (h) => h.id === homeId,
  );

beforeAll(async () => {
  s = testServices();
  agent = await createTestUser('feed-lookups-agent', { fullName: 'Sam Rivera' });
  ws = await realestateBusiness(agent, 'Feed Lookups Realty');
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
  buyerDeal = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
    })
  ).dealId;
}, 90_000);
afterAll(closeTestDbs);

describe('with no listing feed connected', () => {
  it('looks nothing up, and says how to connect one when asked', async () => {
    const home = await standinHome('active');
    const added = await run('realestate.home.add', {
      dealId: buyerDeal,
      address: `${home.address.line}, Austin, TX ${home.address.zip}`,
    });
    expect(added.looking).toBe(false);
    await drain();
    expect((await homeOf(added.homeId)).mlsState).toBe('none');
    await expect(run('realestate.home.lookup', { homeId: added.homeId })).rejects.toMatchObject({
      rule: 'realestate_no_feed',
    });
    // Connected from here on: the business's own account, which the stand-in answers.
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
    // Asked again, it's found now.
    await run('realestate.home.lookup', { homeId: added.homeId });
    await drain();
    expect((await homeOf(added.homeId)).mls.mlsNumber).toBe(home.mlsNumber);
  });
});

describe('a buyer’s home', () => {
  it('is looked up when it’s added, filling its empty facts for the agent to confirm', async () => {
    const home = await standinHome('active', 1);
    const added = await run('realestate.home.add', {
      dealId: buyerDeal,
      address: `${home.address.line}, Austin, TX ${home.address.zip}`,
    });
    expect(added.looking).toBe(true);
    await drain();
    const h = await homeOf(added.homeId);
    expect(h).toMatchObject({
      mlsState: 'found',
      mlsWords: null,
      factsState: 'suggested',
      facts: { beds: home.facts.beds, sqft: home.facts.sqft, price_cents: home.listPriceCents },
      mls: {
        mlsNumber: home.mlsNumber,
        status: 'active',
        statusWords: 'For sale',
        sourceWords: 'From the stand-in MLS',
        differs: [],
        display: { courtesy: home.display.courtesy, notice: home.display.notice },
      },
    });
    expect(h.factSources.beds).toBe('From the stand-in MLS');
    expect(h.mls.photos.length).toBeGreaterThan(0);
  });

  it('never overwrites what a person confirmed: both are shown where they differ', async () => {
    const home = await standinHome('active', 2);
    const added = await run('realestate.home.add', {
      dealId: buyerDeal,
      address: `${home.address.line}, Austin, TX ${home.address.zip}`,
    });
    await drain();
    await run('realestate.home.confirm_facts', {
      homeId: added.homeId,
      facts: { ...(await homeOf(added.homeId)).facts, beds: home.facts.beds! + 1 },
    });
    await run('realestate.home.lookup', { homeId: added.homeId });
    await drain();
    const h = await homeOf(added.homeId);
    expect(h.factsState).toBe('confirmed');
    expect(h.facts.beds).toBe(home.facts.beds! + 1);
    expect(h.mls.facts.beds).toBe(home.facts.beds);
    expect(h.mls.differs).toEqual(['beds']);
  });

  it('says when the MLS has no listing there, and finds one by its MLS number', async () => {
    const added = await run('realestate.home.add', {
      dealId: buyerDeal,
      address: '9 Nowhere Ln, Austin, TX 78704',
    });
    await drain();
    expect(await homeOf(added.homeId)).toMatchObject({
      mlsState: 'not_found',
      mls: null,
      mlsWords: expect.stringMatching(/has no listing at this address/),
    });
    const sold = await standinHome('sold');
    await run('realestate.home.lookup', { homeId: added.homeId, mlsNumber: sold.mlsNumber });
    await drain();
    expect((await homeOf(added.homeId)).mls).toMatchObject({
      mlsNumber: sold.mlsNumber,
      status: 'sold',
    });
  });
});

describe('our own listing', () => {
  it('gets the MLS as one more source for each fact', async () => {
    const home = await standinHome('active', 3);
    const { dealId } = await run('realestate.deal.open', {
      side: 'listing',
      name: 'Garcia listing',
      newPropertyAddress: `${home.address.line}, Austin, TX ${home.address.zip}`,
    });
    await run('realestate.listing.lookup', { dealId });
    await drain();
    const { listing } = await ask('realestate.listing', { dealId });
    expect(listing.feed).toMatchObject({ state: 'found', mls: { mlsNumber: home.mlsNumber } });
    const beds = (listing.choices as Any[]).find((c) => c.key === 'beds');
    expect(beds.candidates).toContainEqual(
      expect.objectContaining({ from: 'mls', value: home.facts.beds }),
    );
    // Picked by the agent, it's confirmed as from the MLS.
    await run('realestate.listing.confirm_facts', {
      dealId,
      facts: { beds: home.facts.beds },
      sources: { beds: 'mls' },
    });
    const after = (await ask('realestate.listing', { dealId })).listing;
    expect((after.choices as Any[]).find((c) => c.key === 'beds').confirmed.from).toBe('mls');
  });
});

describe('a CMA’s comps from the MLS', () => {
  it('come in nearest first and don’t count until the agent ticks them', async () => {
    const home = await standinHome('active', 4);
    const added = await run('realestate.home.add', {
      dealId: buyerDeal,
      address: `${home.address.line}, Austin, TX ${home.address.zip}`,
    });
    await drain();
    const { cmaId } = await run('realestate.cma.start', {
      dealId: buyerDeal,
      homeId: added.homeId,
    });
    await run('realestate.cma.find_comps', { cmaId, miles: 3, months: 12 });
    await drain();
    const { cma } = await ask('realestate.cma', { cmaId });
    expect(cma.findComps).toMatchObject({
      state: 'found',
      asked: { miles: 3, months: 12 },
      words: expect.stringMatching(/Tick the ones to count/),
    });
    const comps = cma.comps as Any[];
    expect(comps.length).toBeGreaterThan(0);
    expect(comps.every((c) => c.source === 'mls' && c.used === false && c.status === 'sold')).toBe(
      true,
    );
    expect(
      comps.every((c) => c.mls?.mlsNumber && c.mls.sourceWords === 'From the stand-in MLS'),
    ).toBe(true);
    const distances = comps.map((c) => c.distanceMiles as number);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(cma.range).toBeNull();

    // Asked again: nothing it already has comes in twice.
    await run('realestate.cma.find_comps', { cmaId, miles: 3, months: 12 });
    await drain();
    expect(((await ask('realestate.cma', { cmaId })).cma.comps as Any[]).length).toBe(comps.length);

    // Ticked, it counts.
    await run('realestate.cma.update_comp', { compId: comps[0].id, used: true });
    expect((await ask('realestate.cma', { cmaId })).cma.comps[0].counted).toBe(true);
  });
});
