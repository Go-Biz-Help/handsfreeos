/**
 * Real Estate Agent, round two, step 9, in the worker: a CMA's summary is drafted by the model (the stand-in here)
 * from the CMA's numbers alone, and checked for fair-housing risk by the word list and the model; the agent's own
 * words are read by the model again. A model that can't be asked leaves the agent to write it.
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
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { scriptedAi } from '../src/ai/scripted';
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

const handlers = withAddons({});
const jobs = { ...addonJobs };

let s: TestServices;
let agent: TestUser;
let ws: string;
let deal: string;
let cma: string;

async function drain() {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-cma-${randomUUID().slice(0, 8)}`;
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

const read = async () => (await ask('realestate.cma', { cmaId: cma })).cma;

beforeAll(async () => {
  s = testServices({ ai: { provider: scriptedAi() } });
  agent = await createTestUser('rcw-agent', { fullName: 'Sam Rivera' });
  ws = await realestateBusiness(agent, 'Summary Realty');
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
  const home = (
    await run('realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' })
  ).homeId;
  cma = (await run('realestate.cma.start', { dealId: deal, homeId: home })).cmaId;
  await run('realestate.cma.set_subject', {
    cmaId: cma,
    beds: 3,
    baths: 2,
    sqft: 1780,
    listPriceCents: 40_900_000,
    yearBuilt: null,
  });
  for (const c of [
    { address: '14 Maple Ave', priceCents: 40_200_000, soldOn: '2026-08-30', sqft: 1720 },
    { address: '301 Oak Hollow', priceCents: 41_850_000, soldOn: '2026-09-12', sqft: 1850 },
  ])
    await run('realestate.cma.add_comp', { cmaId: cma, ...c });
  await run('realestate.cma.add_comp', {
    cmaId: cma,
    address: '9 Elm St',
    priceCents: 43_000_000,
    status: 'active',
  });
  await run('realestate.cma.finalize', { cmaId: cma });
  await drain();
}, 120_000);

afterAll(closeTestDbs);

describe('a CMA’s summary', () => {
  it('is drafted from the CMA’s numbers, read by both checks, and can then be shared', async () => {
    await run('realestate.cma.request_summary', { cmaId: cma });
    expect((await read()).summary.state).toBe('drafting');
    await drain();
    const c = await read();
    expect(c.summary).toMatchObject({ state: 'ready', byAi: true, unsupportedAmounts: [] });
    expect(c.summary.text).toMatch(/between \$[\d,]+ and \$[\d,]+, most likely about \$[\d,]+/);
    expect(c.summary.text).toContain('14 Maple Ave sold for $402,000');
    expect(c.summary.text).toContain('I left out 9 Elm St.');
    expect(c.fairHousing).toMatchObject({ checked: true, flags: [] });
    const [use] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.ai_usage where workspace_id = ${ws} and source = 'addon'`,
    );
    expect(use!.n).toBeGreaterThan(0);
    expect(c.shareBlocked).toBeNull();
  });

  it('reads the agent’s own words again before they’re shared', async () => {
    await run('realestate.cma.save_summary', {
      cmaId: cma,
      summary: 'Recent sales nearby put 418 Maple between $402,000 and $418,000.',
    });
    expect((await read()).fairHousing.checked).toBe(false);
    await drain();
    const c = await read();
    expect(c.fairHousing.checked).toBe(true);
    expect(c.summary.byAi).toBe(false);
    expect(await run('realestate.cma.share', { cmaId: cma })).toEqual({
      cmaId: cma,
      status: 'shared',
    });
  });

  it('is left to the agent when the model can’t be asked', async () => {
    const saved = s;
    s = testServices({ ai: { provider: null } });
    try {
      const home = (
        await run('realestate.home.add', { dealId: deal, address: '9 Oak Ln, Austin, TX' })
      ).homeId;
      const other = (await run('realestate.cma.start', { dealId: deal, homeId: home })).cmaId;
      await run('realestate.cma.request_summary', { cmaId: other });
      await drain();
      const c = (await ask('realestate.cma', { cmaId: other })).cma;
      expect(c.summary.state).toBe('failed');
      expect(c.summary.failure).toBeTruthy();
    } finally {
      s = saved;
    }
  });
});
