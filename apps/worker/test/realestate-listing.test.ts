/**
 * Real Estate Agent, round three, in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"): a listing's facts read from its old listing's pasted words by the model (the stand-in here), from those
 * words alone and without the old price, waiting for a person to confirm them.
 */
import { randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import type { ScriptRule } from '@hfos/ai';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { scriptedAi, scriptedListingFacts } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
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

/** The stand-in reads the listing as written, and makes one fact up, which the check must drop. */
const RULES: ScriptRule[] = [
  {
    when: /Find the listing’s facts\./,
    json: (q) => ({
      facts: [
        ...scriptedListingFacts(q).facts,
        { key: 'garage_spaces', value: 2, quote: 'Two-car garage' },
      ],
    }),
  },
];

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let agent: TestUser;
let ws: string;
let listing: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-listing-${randomUUID().slice(0, 8)}`;
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

beforeAll(async () => {
  s = testServices({ ai: { provider: scriptedAi(RULES), dailyTokens: 5_000_000 } });
  agent = await createTestUser('rel-worker-agent', { fullName: 'Dana Reyes' });
  ws = await realestateBusiness(agent, 'Listing Worker Realty');
  const maria = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Maria', lastName: 'Alvarez' },
      human(agent),
      meta(),
    )
  ).output.personId;
  listing = (
    await run('realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'pre_listing',
      clientPersonId: maria,
      newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
    })
  ).dealId;
}, 90_000);

afterAll(closeTestDbs);

describe('a listing’s facts from its old listing’s words', () => {
  it('are read from the words alone, without the old price, and wait for a person', async () => {
    await run('realestate.listing.paste', {
      dealId: listing,
      text: 'Single-family home. 4 beds, 3 baths, 2,340 sq ft. Built in 2004. Offered at $499,000.',
    });
    await drain();
    const { listing: l } = await ask('realestate.listing', { dealId: listing });
    expect(l.pasted).toMatchObject({ state: 'read', failure: null });
    const said = Object.fromEntries(
      l.choices
        .filter((c: Any) => c.candidates.length)
        .map((c: Any) => [c.key, c.candidates[0].value]),
    );
    expect(said).toEqual({
      beds: 4,
      baths: 3,
      sqft: 2340,
      year_built: 2004,
      property_type: 'single_family',
    });
    // Nothing is a fact until a person confirms it.
    expect(l.facts).toEqual({});
  });
});
