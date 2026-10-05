/**
 * Real Estate Agent, round two, step 9: the CMA. The range from comps the agent adds (adjusted price per square foot,
 * recent sales weighted more), each comp's value and why it isn't counted; a draft that changes and a final one that
 * doesn't; a summary checked twice for fair-housing risk; and sharing refused until it's final and any flag is fixed
 * or kept with a reason. The client's portal reads a CMA only once it's shared.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { asPortal, closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cmaValues, unsupportedAmounts, type CmaComp } from '../../src/addons/realestate/cma';
import { textHashOf } from '../../src/addons/realestate/ops/client-updates';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const comp = (over: Partial<CmaComp> & Pick<CmaComp, 'id' | 'priceCents'>): CmaComp => ({
  address: `${over.id} Maple Ave`,
  status: 'sold',
  soldOn: '2026-09-01',
  beds: 3,
  baths: 2,
  sqft: 1800,
  distanceMiles: 0.3,
  adjustments: [],
  used: true,
  ...over,
});
const home = { beds: 3, baths: 2, sqft: 1800, listPriceCents: 40_900_000, yearBuilt: 1990 };

describe('the range', () => {
  it('weights recent sales more, and rounds low down, high up and likely to the nearest $1,000', () => {
    const r = cmaValues(
      home,
      [
        comp({ id: 'a', priceCents: 40_000_000, soldOn: '2026-09-30' }),
        // Six months older: it counts half as much.
        comp({ id: 'b', priceCents: 43_000_000, soldOn: '2026-04-03' }),
      ],
      '2026-09-30',
    );
    expect(r.comps.map((c) => Math.round(c.weight * 100) / 100)).toEqual([1, 0.5]);
    // (400,000 × 1 + 430,000 × 0.5) / 1.5 = 410,000.
    expect(r.range).toMatchObject({
      lowCents: 40_000_000,
      likelyCents: 41_000_000,
      highCents: 43_000_000,
      counted: 2,
    });
  });

  it('values each comp at the home’s size, after the agent’s adjustments', () => {
    const r = cmaValues(
      { ...home, sqft: 2000 },
      [
        comp({
          id: 'a',
          priceCents: 36_000_000,
          sqft: 1800,
          adjustments: [{ label: 'Newer roof', cents: 900_000 }],
        }),
      ],
      '2026-09-30',
    );
    // ($360,000 + $9,000) / 1,800 × 2,000 = $410,000.
    expect(r.comps[0]).toMatchObject({
      valueCents: 41_000_000,
      adjustmentCents: 5_000_000,
      counted: true,
    });
  });

  it('says why a comp isn’t counted, and what to look at', () => {
    const r = cmaValues(
      home,
      [
        comp({ id: 'out', priceCents: 40_000_000, used: false }),
        comp({ id: 'pend', priceCents: 41_000_000, status: 'pending', soldOn: null }),
        comp({ id: 'nosize', priceCents: 41_000_000, sqft: null }),
        comp({
          id: 'old',
          priceCents: 39_000_000,
          soldOn: '2025-06-01',
          distanceMiles: 1.6,
          sqft: 2400,
        }),
      ],
      '2026-09-30',
    );
    expect(r.comps.map((c) => c.why)).toEqual([
      'Left out',
      'Pending: shown for context, not counted',
      'Add its square feet to count it',
      null,
    ]);
    expect(r.comps[3]!.warnings).toEqual([
      'Sold over a year ago',
      'Over a mile away',
      'Much bigger',
    ]);
  });

  it('needs the home’s size and a sold comp', () => {
    expect(
      cmaValues({ ...home, sqft: null }, [comp({ id: 'a', priceCents: 1 })], '2026-09-30').missing,
    ).toBe('Add the home’s square feet to work out a range.');
    expect(cmaValues(home, [], '2026-09-30').missing).toBe(
      'Add a sold comp with its price, date and square feet to work out a range.',
    );
  });

  it('points out dollar amounts nothing in the CMA supports', () => {
    expect(
      unsupportedAmounts(
        'Sales point to $401,000 to $414,000. 14 Maple sold for $402,000. Offer $380,000, or $405k.',
        [40_200_000],
        { lowCents: 40_100_000, highCents: 41_400_000 },
      ),
    ).toEqual(['$380,000']);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = (channel: 'test' | 'assistant' = 'test') => ({ correlationId: randomUUID(), channel });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (
  name: string,
  input: Record<string, unknown>,
  channel: 'test' | 'assistant' = 'test',
): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(agent),
    meta(channel),
  ).then((r) => r.output);
const system = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    worker(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    { type: 'system', workspaceId: ws, organizationId: org },
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());
async function refused(p: Promise<unknown>): Promise<{ rule: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string; message: string };
    return { rule: err.rule ?? err.code ?? '', message: err.message };
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let deal: string;
let client: string;
let maple: string;
let cma: string;

/** The model's check of the summary as it is now, as the worker records it. */
async function modelReads(flags: unknown[] = []) {
  const { cma: c } = await ask('realestate.cma', { cmaId: cma });
  await system('realestate.cma.summary_checked', {
    cmaId: cma,
    textHash: textHashOf(null, c.summary.text),
    version: 'test-model',
    status: flags.length ? 'flagged' : 'passed',
    flags,
  });
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rcm-owner'),
    createTestUser('rcm-agent', { fullName: 'Sam Rivera' }),
  ]);
  ws = await realestateBusiness(owner, 'Comps Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  client = (
    await executeCommand(
      api(),
      personCreate,
      {
        workspaceId: ws,
        firstName: 'Linh',
        lastName: 'Nguyen',
        email: `linh-${randomUUID().slice(0, 6)}@example.com`,
      },
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
  maple = (await run('realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' }))
    .homeId;
  await admin().execute(
    sql`update addon_realestate.homes set facts = '{"beds": 3, "baths": 2, "sqft": 1780, "price_cents": 40900000}'
        where id = ${maple}`,
  );
}, 120_000);

afterAll(closeTestDbs);

describe('a CMA', () => {
  it('starts from the home’s facts, and takes comps', async () => {
    const started = await run('realestate.cma.start', { dealId: deal, homeId: maple });
    cma = started.cmaId;
    expect(started).toMatchObject({ number: 1, comps: 0 });
    for (const c of [
      {
        address: '14 Maple Ave',
        priceCents: 40_200_000,
        soldOn: '2026-08-30',
        beds: 3,
        baths: 2,
        sqft: 1720,
        distanceMiles: 0.1,
      },
      {
        address: '301 Oak Hollow',
        priceCents: 41_850_000,
        soldOn: '2026-09-12',
        beds: 3,
        baths: 2,
        sqft: 1850,
        distanceMiles: 0.4,
      },
      {
        address: '5 Linden Pl',
        priceCents: 44_500_000,
        soldOn: '2026-09-03',
        beds: 4,
        baths: 3,
        sqft: 2240,
        distanceMiles: 0.8,
      },
    ])
      await run('realestate.cma.add_comp', { cmaId: cma, ...c });
    expect(
      (
        await refused(
          run('realestate.cma.add_comp', {
            cmaId: cma,
            address: '14 maple ave.',
            priceCents: 1,
            soldOn: '2026-08-30',
          }),
        )
      ).rule,
    ).toBe('realestate_cma_comp_already');
    expect(
      (
        await refused(
          run('realestate.cma.add_comp', {
            cmaId: cma,
            address: '418 Maple Ave, Austin, TX',
            priceCents: 1,
            soldOn: '2026-08-30',
          }),
        )
      ).rule,
    ).toBe('realestate_cma_comp_already');
    const { cma: c } = await ask('realestate.cma', { cmaId: cma });
    expect(c.subject).toMatchObject({
      address: '418 Maple Ave, Austin, TX',
      sqft: 1780,
      listPriceCents: 40_900_000,
    });
    expect(c.comps.map((x: { counted: boolean }) => x.counted)).toEqual([true, true, true]);
    expect(c.range).not.toBeNull();
  });

  it('leaves out what the agent unticks, and is kept as it is once final', async () => {
    const { cma: before } = await ask('realestate.cma', { cmaId: cma });
    const linden = before.comps.find((x: { address: string }) => x.address === '5 Linden Pl');
    await run('realestate.cma.update_comp', { compId: linden.id, used: false });
    const { cma: c } = await ask('realestate.cma', { cmaId: cma });
    expect(c.comps.find((x: { id: string }) => x.id === linden.id)).toMatchObject({
      counted: false,
      why: 'Left out',
    });
    expect(c.range.counted).toBe(2);
    expect(await run('realestate.cma.finalize', { cmaId: cma })).toEqual({
      cmaId: cma,
      status: 'final',
    });
    const [kept] = await rows<{ low: number; likely: number; high: number }>(
      admin(),
      sql`select low_cents::float8 as low, likely_cents::float8 as likely, high_cents::float8 as high
          from addon_realestate.cmas where id = ${cma}`,
    );
    expect(kept).toEqual({
      low: c.range.lowCents,
      likely: c.range.likelyCents,
      high: c.range.highCents,
    });
    expect(
      (await refused(run('realestate.cma.update_comp', { compId: linden.id, used: true }))).rule,
    ).toBe('realestate_cma_final');
  });

  it('isn’t shared until its summary has been checked and its flags are fixed or kept with a reason', async () => {
    expect((await refused(run('realestate.cma.share', { cmaId: cma }))).rule).toBe(
      'realestate_cma_no_summary',
    );
    const saved = await run('realestate.cma.save_summary', {
      cmaId: cma,
      summary:
        'Two recent sales nearby put 418 Maple between $402,000 and $414,000. Great for families, too.',
    });
    expect(saved.flags.map((f: { phrase: string }) => f.phrase.toLowerCase())).toEqual([
      'great for families',
    ]);
    expect((await refused(run('realestate.cma.share', { cmaId: cma }))).rule).toBe(
      'realestate_check_running',
    );
    await modelReads();
    const flagged = await refused(run('realestate.cma.share', { cmaId: cma }));
    expect(flagged.rule).toBe('realestate_fair_housing_flags');
    // The Assistant never keeps flagged words.
    expect(
      (
        await refused(
          run(
            'realestate.cma.acknowledge_flags',
            { cmaId: cma, reason: 'It’s about the yard' },
            'assistant',
          ),
        )
      ).rule,
    ).toBe('forbidden');
    // Fixed: the words change, and both checks read them again.
    await run('realestate.cma.save_summary', {
      cmaId: cma,
      summary:
        'Two recent sales nearby put 418 Maple between $402,000 and $414,000. An offer at $380,000 is a stretch.',
    });
    await modelReads();
    const { cma: c } = await ask('realestate.cma', { cmaId: cma });
    expect(c.fairHousing).toMatchObject({ checked: true, flags: [] });
    expect(c.summary).toMatchObject({
      state: 'ready',
      byAi: false,
      unsupportedAmounts: ['$380,000'],
    });
    expect(c.shareBlocked).toBeNull();
  });

  it('is in the client’s portal only once shared, and stays as it is', async () => {
    const { accessId } = (
      await executeCommand(
        api(),
        portalAccessGive,
        { workspaceId: ws, personId: client },
        human(owner),
        meta(),
      )
    ).output;
    const scope = { type: 'system' as const, workspaceId: ws, organizationId: org };
    const sent = (
      await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, scope, meta())
    ).output;
    const hit = (
      await executeCommand(
        worker(),
        portalCheckCode,
        {
          workspaceId: ws,
          accessId,
          code: sent.code,
          tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        },
        scope,
        meta(),
      )
    ).output;
    const seen = () =>
      asPortal(hit.sessionId!)((tx) =>
        rows<{ id: string; summary: string }>(
          tx,
          sql`select id, summary from addon_realestate.cmas`,
        ),
      );
    const comps = () =>
      asPortal(hit.sessionId!)((tx) =>
        rows<{ id: string }>(tx, sql`select id from addon_realestate.cma_comps`),
      );
    expect(await seen()).toEqual([]);
    expect(await comps()).toEqual([]);
    expect(await run('realestate.cma.share', { cmaId: cma })).toEqual({
      cmaId: cma,
      status: 'shared',
    });
    expect((await seen()).map((c) => c.id)).toEqual([cma]);
    expect(await comps()).toHaveLength(3);
    expect((await refused(run('realestate.cma.reopen', { cmaId: cma }))).rule).toBe(
      'realestate_cma_final',
    );
    expect(
      (
        await refused(
          run('realestate.cma.save_summary', { cmaId: cma, summary: 'Something else.' }),
        )
      ).rule,
    ).toBe('realestate_cma_final');
    // Another CMA starts from its comps.
    const next = await run('realestate.cma.start', { dealId: deal, homeId: maple, fromCmaId: cma });
    expect(next).toMatchObject({ number: 2, comps: 3 });
    const list = await ask('realestate.cmas', { dealId: deal });
    expect(list.cmas.map((c: { number: number; status: string }) => [c.number, c.status])).toEqual([
      [2, 'draft'],
      [1, 'shared'],
    ]);
  });
});
