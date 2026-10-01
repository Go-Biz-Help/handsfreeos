/**
 * Real Estate Agent, round two, step 6: the buyer's profile and their homes. The pure parts first (how a home fits,
 * how an address compares, and the strict check on the AI's listing facts), then on the database: saving a profile
 * and keeping each version, refusing words about who lives somewhere, adding homes (not twice, not on a listing),
 * the worker's suggested facts and a person confirming them, a home's status, and all of it kept to the deal's people.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addressKey, homeFit, type FitProfile } from '../../src/addons/realestate/homes';
import { checkedListingFacts, numbersIn } from '../../src/addons/realestate/prompts';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const want: FitProfile = {
  budgetMinCents: null,
  budgetMaxCents: 50_000_000,
  areas: ['Austin'],
  homeTypes: ['single_family', 'townhouse'],
  bedsMin: 3,
  bathsMin: 2,
  sqftMin: null,
};

describe('how a home fits', () => {
  it('says what’s met, what’s missed and what isn’t known yet', () => {
    const fit = homeFit(
      want,
      { price_cents: 52_500_000, beds: 3, property_type: 'condo' },
      '12 Main St, Austin, TX',
    );
    expect(fit.lines.map((l) => [l.key, l.met, l.words])).toEqual([
      ['budget', false, '$25,000 over budget'],
      ['area', true, 'In Austin'],
      ['type', false, 'Condo, not what they want'],
      ['beds', true, '3 bedrooms'],
      ['baths', null, 'Bathroom not known yet'],
    ]);
    expect([fit.met, fit.missed, fit.unknown]).toEqual([2, 2, 1]);
  });

  it('compares addresses the way people write them', () => {
    expect(addressKey('12 Main Street, Austin, TX')).toBe(addressKey('12 main st austin tx'));
    expect(addressKey('418 Maple Avenue #2')).toBe(addressKey('418 maple ave 2'));
  });
});

describe('the AI’s listing facts', () => {
  const text =
    'Charming townhouse! 3 beds, 2.5 baths, 1,850 sq ft. Built in 1998. Offered at $525,000. HOA $210/month. Great schools nearby.';
  it('reads the numbers people write', () => {
    expect(numbersIn('$525,000')).toEqual([525000]);
    expect(numbersIn('$525K')).toEqual([525000]);
    expect(numbersIn('2.5 baths')).toEqual([2.5]);
  });

  it('keeps a fact only when its words are in the listing and its number is in its words', () => {
    const out = checkedListingFacts(
      {
        facts: [
          { key: 'price_cents', value: 525000, quote: 'Offered at $525,000' },
          { key: 'beds', value: 3, quote: '3 beds' },
          { key: 'baths', value: 2.5, quote: '2.5 baths' },
          // Made up: not in the listing.
          { key: 'sqft', value: 2000, quote: '2,000 sq ft' },
          // Its number isn't in its words.
          { key: 'year_built', value: 1999, quote: 'Built in 1998' },
          { key: 'property_type', value: 'townhouse', quote: 'Charming townhouse' },
          { key: 'hoa_monthly_cents', value: 210, quote: 'HOA $210/month' },
        ],
      },
      text,
    );
    expect(out.facts).toEqual({
      price_cents: 52_500_000,
      beds: 3,
      baths: 2.5,
      property_type: 'townhouse',
      hoa_monthly_cents: 21_000,
    });
    expect(out.sources['beds']).toBe('3 beds');
    expect(out.dropped).toBe(2);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const op = <T extends 'commands' | 'queries'>(kind: T, name: string) => {
  const found = (realestateAddonServer[kind] ?? []).find((x) => x.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const run = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    api(),
    op('commands', name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  ).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(
    api(),
    op('queries', name) as QueryDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(),
  );
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string };
    return err.rule ?? err.code ?? String(e);
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let other: TestUser;
let ws: string;
let org: string;
let deal: string;
let listing: string;
let home: string;

beforeAll(async () => {
  [owner, agent, other] = await Promise.all([
    createTestUser('reh-owner'),
    createTestUser('reh-agent'),
    createTestUser('reh-other'),
  ]);
  ws = await realestateBusiness(owner, 'Homes Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  await admin()
    .insert(workspaceMemberships)
    .values(
      [agent, other].map((u) => ({ workspaceId: ws, userId: u.id, role: 'member' as const })),
    );
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
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
    })
  ).dealId;
  listing = (await run(agent, 'realestate.deal.open', { side: 'listing', name: 'Lopez sale' }))
    .dealId;
}, 90_000);
afterAll(closeTestDbs);

describe('the buyer’s profile', () => {
  it('is saved whole, each save kept, and an unchanged save changes nothing', async () => {
    const profile = {
      budgetMaxCents: 50_000_000,
      areas: ['Austin', '78704'],
      homeTypes: ['single_family'],
      bedsMin: 3,
      bathsMin: 2,
      mustHaves: ['A fenced yard'],
    };
    expect(
      await run(agent, 'realestate.buyer_profile.save', { dealId: deal, profile }),
    ).toMatchObject({
      version: 1,
      changed: true,
    });
    expect(
      await run(agent, 'realestate.buyer_profile.save', { dealId: deal, profile }),
    ).toMatchObject({
      version: 1,
      changed: false,
    });
    await run(agent, 'realestate.buyer_profile.save', {
      dealId: deal,
      profile: { ...profile, bedsMin: 4 },
    });
    const got = await ask(agent, 'realestate.buyer_profile.get', { dealId: deal });
    expect(got.profile).toMatchObject({
      bedsMin: 4,
      bathsMin: 2,
      version: 2,
      areas: ['Austin', '78704'],
    });
    const versions = await rows<{ version: number }>(
      admin(),
      sql`select version from addon_realestate.buyer_profile_versions where deal_record_id = ${deal} order by version`,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('refuses words about who lives somewhere, and a listing’s', async () => {
    expect(
      await refused(
        run(agent, 'realestate.buyer_profile.save', {
          dealId: deal,
          profile: { mustHaves: ['A family-friendly street'] },
        }),
      ),
    ).toBe('realestate_fair_housing');
    expect(
      await refused(run(agent, 'realestate.buyer_profile.save', { dealId: listing, profile: {} })),
    ).toBe('realestate_buyer_only');
  });
});

describe('homes', () => {
  it('are added once each, and the pasted listing waits for the AI', async () => {
    const out = await run(agent, 'realestate.home.add', {
      dealId: deal,
      address: '12 Main Street, Austin, TX',
      link: 'https://listings.example.com/12-main',
      pastedText: 'Charming townhouse! 3 beds, 2.5 baths. Offered at $525,000.',
    });
    expect(out.filling).toBe(true);
    home = out.homeId;
    expect(
      await refused(
        run(agent, 'realestate.home.add', { dealId: deal, address: '12 main st austin tx' }),
      ),
    ).toBe('realestate_home_already');
    const [e] = await rows<{ payload: { fill: boolean } }>(
      admin(),
      sql`select payload from app.events where event_type = 'realestate.home.added'
          and payload ->> 'homeId' = ${home}`,
    );
    expect(e!.payload.fill).toBe(true);
  });

  it('take the AI’s facts as suggestions, which a person confirms', async () => {
    await executeCommand(
      worker(),
      op('commands', 'realestate.home.fill_facts') as CommandDef,
      {
        workspaceId: ws,
        homeId: home,
        facts: { price_cents: 52_500_000, beds: 3, baths: 2.5, property_type: 'townhouse' },
        sources: { beds: '3 beds' },
        model: 'scripted',
      },
      { type: 'system', workspaceId: ws, organizationId: org },
      meta(),
    );
    let got = (await ask(agent, 'realestate.homes', { dealId: deal })).homes[0];
    expect(got).toMatchObject({ factsState: 'suggested', factSources: { beds: '3 beds' } });
    expect(got.fit.lines.find((l: { key: string }) => l.key === 'budget')).toMatchObject({
      met: false,
    });
    await run(agent, 'realestate.home.confirm_facts', {
      homeId: home,
      facts: { price_cents: 49_900_000, beds: 3, baths: 2.5, property_type: 'townhouse' },
    });
    got = (await ask(agent, 'realestate.homes', { dealId: deal })).homes[0];
    expect(got).toMatchObject({ factsState: 'confirmed', factSources: {} });
    expect(got.fit.lines.find((l: { key: string }) => l.key === 'budget')).toMatchObject({
      met: true,
    });
  });

  it('move along, and are kept to the deal’s people', async () => {
    expect(
      await run(agent, 'realestate.home.set_status', { homeId: home, status: 'shortlisted' }),
    ).toMatchObject({
      changed: true,
    });
    expect(await refused(ask(other, 'realestate.homes', { dealId: deal }))).toBe('not_found');
    expect(
      await refused(run(other, 'realestate.home.set_status', { homeId: home, status: 'passed' })),
    ).toBe('not_found');
    expect(
      await refused(run(agent, 'realestate.home.add', { dealId: listing, address: '1 Elm St' })),
    ).toBe('realestate_buyer_only');
    const history = await ask(agent, 'realestate.deal.history', { dealId: deal });
    expect(history.lines.map((l: { what: string }) => l.what)).toEqual(
      expect.arrayContaining(['buyer_profile', 'home_added', 'home_facts', 'home_status']),
    );
  });
});
