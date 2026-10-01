/**
 * Real Estate Agent, round two, step 6, in the worker: a home added with a listing's pasted words has its facts read
 * by the model (the stand-in here) from those words alone. Each fact comes back with the words it was found in;
 * anything the words don't say is dropped, and nothing is confirmed until a person says so. A home with no pasted
 * words, or a model that can't be asked, leaves the agent to type them in.
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
let deal: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-homes-${randomUUID().slice(0, 8)}`;
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
  agent = await createTestUser('reh-worker-agent', { fullName: 'Sam Rivera' });
  ws = await realestateBusiness(agent, 'Listing Facts Realty');
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
}, 90_000);

afterAll(closeTestDbs);

describe('a home’s facts from its pasted listing', () => {
  it('are read from the words alone, each with where it was found, and wait for a person', async () => {
    const { homeId } = await run('realestate.home.add', {
      dealId: deal,
      address: '418 Maple Ave, Austin, TX',
      link: 'https://listings.example.com/418-maple',
      pastedText:
        'Single-family charmer. 3 beds, 2 baths, 1,650 sq ft. Built in 1987. Offered at $489,000. Great schools nearby!',
    });
    await drain();
    const home = (await ask('realestate.homes', { dealId: deal })).homes.find(
      (h: { id: string }) => h.id === homeId,
    );
    expect(home.factsState).toBe('suggested');
    expect(home.facts).toEqual({
      price_cents: 48_900_000,
      beds: 3,
      baths: 2,
      sqft: 1650,
      year_built: 1987,
      property_type: 'single_family',
    });
    expect(home.factSources).toMatchObject({ price_cents: '$489,000', beds: '3 beds' });
    // The made-up garage was dropped; the model's use is the add-on's.
    expect(home.facts.garage_spaces).toBeUndefined();
    const [use] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${ws} and source = 'addon'`,
    );
    expect(use!.n).toBeGreaterThan(0);
  });

  it('aren’t asked for when nothing was pasted', async () => {
    const { homeId, filling } = await run('realestate.home.add', {
      dealId: deal,
      address: '9 Oak Ln, Austin, TX',
    });
    expect(filling).toBe(false);
    await drain();
    const home = (await ask('realestate.homes', { dealId: deal })).homes.find(
      (h: { id: string }) => h.id === homeId,
    );
    expect(home).toMatchObject({ factsState: 'none', facts: {} });
  });

  it('are left to the agent when the model can’t be asked', async () => {
    const saved = s;
    s = testServices({ ai: { provider: null, dailyTokens: 5_000_000 } });
    try {
      const { homeId } = await run('realestate.home.add', {
        dealId: deal,
        address: '77 Pine Ct, Austin, TX',
        pastedText: '2 beds, 1 bath condo. $250,000.',
      });
      await drain();
      const home = (await ask('realestate.homes', { dealId: deal })).homes.find(
        (h: { id: string }) => h.id === homeId,
      );
      expect(home.factsState).toBe('failed');
      expect(home.factsFailure).toContain('Enter the home’s facts');
    } finally {
      s = saved;
    }
  });
});
