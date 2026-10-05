/**
 * The buyer's pages on the phone (Real Estate round six, step 15): what the buyer wants, their homes, what's remembered
 * about them and their saved search's matches, worked out from the phone's copy (views/buyer.ts). Everything here is
 * built through the add-on's commands (the agent's, the worker's and the clients' in their portal), and each page is
 * held to the server's answer: for the deal's agent, who holds the deal whole, and for an owner who sees every deal,
 * who holds their own deal whole and the agent's as its summary.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MlsSnapshot } from '../../src/addons/realestate/feed';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  buyerProfileOfCopy,
  homesOfCopy,
  matchesOfCopy,
  memoryOfCopy,
  type HomesFilter,
  type MatchesFilter,
  type MemoryFilter,
} from '../../src/addons/realestate/views/buyer';
import {
  executeCommand,
  executeQuery,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';
import { phoneCopy } from './realestate-phone-fixture';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const portalMeta = () => ({ correlationId: randomUUID(), channel: 'portal' as const });
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const system = () => ({ type: 'system' as const, workspaceId: ws, organizationId: org });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (name: string, input: Record<string, unknown>, as: TestUser = agent): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(as),
    meta(),
  ).then((r) => r.output);
/** The worker's commands: what the AI read, what the feed found. */
const work = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    worker(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    system(),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>, as: TestUser): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(as), meta());
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
let ws: string;
let org: string;
/** The agent's buyer deal, with everything on it; the owner's own; and a listing. */
let nguyen: string;
let owens: string;
let lopez: string;

/** A client signed in to their portal. */
async function signIn(personId: string) {
  const { accessId } = (
    await executeCommand(
      api(),
      portalAccessGive,
      { workspaceId: ws, personId },
      human(owner),
      meta(),
    )
  ).output;
  const sent = (
    await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, system(), meta())
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
      system(),
      meta(),
    )
  ).output;
  const who: CustomerActor = {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId,
    sessionId: hit.sessionId!,
  };
  return (name: string, input: Record<string, unknown>): Promise<Any> =>
    executeCommand(
      worker(),
      op(name) as CommandDef,
      { workspaceId: ws, ...input },
      who,
      portalMeta(),
    ).then((r) => r.output);
}

/** A listing as the feed sends it. */
function listing(
  n: number,
  where: { line: string; city: string; zip: string },
  facts: Record<string, unknown>,
  status: 'active' | 'coming_soon' = 'active',
): MlsSnapshot {
  const now = new Date().toISOString();
  return {
    provider: 'repliers',
    mls: { id: 'actris', name: 'Unlock MLS' },
    listingKey: `rpb-${n}`,
    mlsNumber: `ACT${n}`,
    status,
    standardStatus: status === 'active' ? 'Active' : 'Coming Soon',
    address: { ...where, unit: null, state: 'TX', hidden: false },
    lat: null,
    lng: null,
    facts,
    listPriceCents: (facts.price_cents as number) ?? null,
    originalPriceCents: null,
    soldPriceCents: null,
    listedOn: '2026-09-28',
    soldOn: null,
    daysOnMarket: 5,
    description: 'Light-filled rooms and a big back yard.',
    photos: [{ url: `https://photos.example.com/${n}/front.jpg`, caption: 'Front' }],
    listAgent: 'Pat Lee',
    listOffice: 'Hill Country Realty',
    updatedAt: now,
    display: {
      notice: 'Information deemed reliable but not guaranteed.',
      logoUrl: null,
      courtesy: 'Listing courtesy of Hill Country Realty.',
    },
    checkedAt: now,
  } as MlsSnapshot;
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rpb-owner', { fullName: 'Rosa Owens' }),
    createTestUser('rpb-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Buyer Phone Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  const person = async (firstName: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        {
          workspaceId: ws,
          firstName,
          lastName: 'Nguyen',
          email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
        },
        human(agent),
        meta(),
      )
    ).output.personId as string;
  const linhId = await person('Linh');
  const tuanId = await person('Tuan');

  nguyen = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: linhId,
      stage: 'touring',
    })
  ).dealId;
  await run('realestate.party.add', { dealId: nguyen, role: 'client', personId: tuanId });
  lopez = (await run('realestate.deal.open', { side: 'listing', name: 'Lopez sale' })).dealId;

  // What the buyer wants, saved twice.
  const profile = {
    budgetMinCents: 40_000_000,
    budgetMaxCents: 55_000_000,
    areas: ['Austin', '78704'],
    homeTypes: ['single_family', 'townhouse'],
    bedsMin: 3,
    bathsMin: 2.5,
    sqftMin: 1500,
    moveBy: '2027-01-15',
    mustHaves: ['A fenced yard', 'A garage'],
    dealBreakers: ['No HOA over $300'],
  };
  await run('realestate.buyer_profile.save', { dealId: nguyen, profile });
  await run('realestate.buyer_profile.save', {
    dealId: nguyen,
    profile: { ...profile, bathsMin: 2 },
  });

  // Homes: one the AI read (suggested), one confirmed, one shortlisted, one removed.
  const main = (
    await run('realestate.home.add', {
      dealId: nguyen,
      address: '12 Main Street, Austin, TX',
      link: 'https://listings.example.com/12-main',
      pastedText: 'Charming townhouse! 3 beds, 2.5 baths. Offered at $525,000.',
    })
  ).homeId;
  await work('realestate.home.fill_facts', {
    homeId: main,
    facts: { price_cents: 52_500_000, beds: 3, baths: 2.5, property_type: 'townhouse' },
    sources: { beds: '3 beds', baths: '2.5 baths', price_cents: 'Offered at $525,000' },
    model: 'scripted',
  });
  const maple = (
    await run('realestate.home.add', { dealId: nguyen, address: '418 Maple Ave, Austin, TX' })
  ).homeId;
  await run('realestate.home.confirm_facts', {
    homeId: maple,
    facts: { price_cents: 58_000_000, beds: 2, baths: 2, sqft: 1400, property_type: 'condo' },
  });
  await run('realestate.home.set_status', {
    homeId: maple,
    status: 'shortlisted',
    note: 'Ask about the parking',
  });
  const elm = (
    await run('realestate.home.add', { dealId: nguyen, address: '9 Elm St, Round Rock, TX' })
  ).homeId;
  await run('realestate.home.set_status', {
    homeId: elm,
    status: 'removed',
    note: 'Sold before we saw it',
  });

  // The clients, in their portal: Linh adds one she found; each says what they think.
  const linh = await signIn(linhId);
  const tuan = await signIn(tuanId);
  const found = (
    await linh('realestate.portal.home.add', {
      dealId: nguyen,
      address: '77 Oak Lane, Austin, TX 78704',
      link: 'https://listings.example.com/77-oak',
      note: 'Love the porch',
    })
  ).homeId;
  await tuan('realestate.portal.home.react', {
    homeId: found,
    reaction: 'passed',
    note: 'Too far from work',
  });
  await tuan('realestate.portal.home.react', { homeId: main, reaction: 'saved' });
  await linh('realestate.portal.home.react', { homeId: main, reaction: 'saved', note: '' });

  // Their saved search: three new homes; one sent to the clients, one set aside; then the MLS moves one's price.
  const near = listing(
    1,
    { line: '1204 Elm St', city: 'Austin', zip: '78704' },
    { price_cents: 49_900_000, beds: 3, baths: 2, sqft: 1650, property_type: 'single_family' },
  );
  const soon = listing(
    2,
    { line: '55 Cedar Ct', city: 'Austin', zip: '78745' },
    { price_cents: 61_000_000, beds: 4, property_type: 'single_family' },
    'coming_soon',
  );
  const far = listing(
    3,
    { line: '8 Pine Rd', city: 'Pflugerville', zip: '78660' },
    { price_cents: 45_000_000, beds: 2, baths: 1, property_type: 'condo' },
  );
  await work('realestate.search.found', { dealId: nguyen, listings: [near, soon, far] });
  const { matches } = await ask('realestate.matches', { dealId: nguyen }, agent);
  const idOf = (n: string) => matches.find((m: Any) => m.mls.mlsNumber === n).id as string;
  const sent = (await run('realestate.match.send', { matchId: idOf('ACT1') })).homeId;
  await run('realestate.match.dismiss', { matchId: idOf('ACT3') });
  await work('realestate.search.found', {
    dealId: nguyen,
    listings: [near, { ...soon, listPriceCents: 59_500_000 }, far],
  });
  // The agent keeps a price of their own for the sent home: it differs from the MLS's.
  await run('realestate.home.confirm_facts', {
    homeId: sent,
    facts: {
      price_cents: 48_500_000,
      beds: 3,
      baths: 2,
      sqft: 1650,
      property_type: 'single_family',
    },
  });

  // What's remembered: the agent's own, and the AI's suggestions (two left out for fair housing), decided.
  await run('realestate.memory.add', {
    dealId: nguyen,
    kind: 'must_have',
    words: 'A fenced yard for the dog',
  });
  const timing = (
    await run('realestate.memory.add', {
      dealId: nguyen,
      kind: 'timing',
      words: 'Lease ends in March',
    })
  ).itemId;
  await work('realestate.memory.suggest', {
    dealId: nguyen,
    items: [
      {
        kind: 'likes',
        words: 'Likes big kitchens',
        quote: 'We cook a lot, so the kitchen matters.',
        sourceKind: 'message',
        sourceId: randomUUID(),
      },
      {
        kind: 'dislikes',
        words: 'Doesn’t want carpet',
        quote: 'No carpet, please.',
        sourceKind: 'call',
        sourceId: randomUUID(),
      },
      {
        kind: 'money',
        words: 'Wants to keep the payment under $3,000',
        quote: 'Under three grand a month.',
        sourceKind: 'note',
        sourceId: randomUUID(),
      },
    ],
    readThrough: new Date().toISOString(),
    protectedDropped: 2,
  });
  const memory = await ask('realestate.memory', { dealId: nguyen }, agent);
  const item = (w: string) => memory.items.find((i: Any) => i.words === w).id as string;
  await run('realestate.memory.decide', {
    itemId: item('Likes big kitchens'),
    decision: 'confirm',
    words: 'Likes big, open kitchens',
  });
  await run('realestate.memory.decide', {
    itemId: item('Doesn’t want carpet'),
    decision: 'reject',
    note: 'They said rugs are fine',
  });
  await run('realestate.memory.decide', { itemId: timing, decision: 'retire' });

  // The owner's own buyer deal: a profile, a home, something remembered.
  owens = (await run('realestate.deal.open', { side: 'buyer', name: 'Owens purchase' }, owner))
    .dealId;
  await run(
    'realestate.buyer_profile.save',
    { dealId: owens, profile: { areas: ['Austin'], bedsMin: 2 } },
    owner,
  );
  await run('realestate.home.add', { dealId: owens, address: '300 Bowie St, Austin, TX' }, owner);
  await run(
    'realestate.memory.add',
    { dealId: owens, kind: 'likes', words: 'A view of the river' },
    owner,
  );
}, 180_000);

afterAll(closeTestDbs);

const HOMES: HomesFilter[] = [{}, { includeRemoved: true }];
const MEMORY: MemoryFilter[] = [{}, { includeClosed: true }];
const MATCHES: MatchesFilter[] = [{}, { state: 'new' }, { state: 'sent' }, { state: 'dismissed' }];

/** Every buyer page of a deal, held to the server's answer, for someone holding the deal whole. */
async function sameAsServer(u: TestUser, dealId: string) {
  const copy = await phoneCopy(u, ws);
  const ctx = { userId: u.id };
  const label = `${u.email} ${dealId}`;
  expect(buyerProfileOfCopy(copy, dealId, ctx), label).toEqual({
    ...(await ask('realestate.buyer_profile.get', { dealId }, u)),
    full: true,
  });
  for (const f of HOMES)
    expect(homesOfCopy(copy, dealId, f, ctx), `${label} ${JSON.stringify(f)}`).toEqual({
      ...(await ask('realestate.homes', { dealId, ...f }, u)),
      full: true,
    });
  for (const f of MEMORY)
    expect(memoryOfCopy(copy, dealId, f, ctx), `${label} ${JSON.stringify(f)}`).toEqual({
      ...(await ask('realestate.memory', { dealId, ...f }, u)),
      full: true,
    });
  for (const f of MATCHES) {
    // Whether the feed is connected is a connector's status: the server's to say.
    const {
      search: { feedConnected: _connected, ...search },
      ...server
    } = await ask('realestate.matches', { dealId, ...f }, u);
    expect(matchesOfCopy(copy, dealId, f, ctx), `${label} ${JSON.stringify(f)}`).toEqual({
      ...server,
      search,
      full: true,
    });
  }
}

describe('the buyer’s pages on the phone', () => {
  it('answer what the server answers, for the deal’s agent', async () => {
    await sameAsServer(agent, nguyen);
  });

  it('answer what the server answers about a listing: no profile, homes or memory, and no saved search', async () => {
    const copy = await phoneCopy(agent, ws);
    const ctx = { userId: agent.id };
    expect(buyerProfileOfCopy(copy, lopez, ctx)).toEqual({
      ...(await ask('realestate.buyer_profile.get', { dealId: lopez }, agent)),
      full: true,
    });
    expect(homesOfCopy(copy, lopez, {}, ctx)).toEqual({ homes: [], full: true });
    expect(memoryOfCopy(copy, lopez, {}, ctx)).toEqual({
      ...(await ask('realestate.memory', { dealId: lopez }, agent)),
      full: true,
    });
    expect(await refused(ask('realestate.matches', { dealId: lopez }, agent))).toBe(
      'realestate_buyer_only',
    );
    expect(matchesOfCopy(copy, lopez, {}, ctx)).toBeNull();
  });

  it('for an owner who sees every deal: their own deal whole, and another agent’s as its summary', async () => {
    await sameAsServer(owner, owens);

    const copy = await phoneCopy(owner, ws);
    const ctx = { userId: owner.id };
    // The server reads the agent's deal whole; the owner's phone keeps its summary, and the rest waits for signal.
    expect(
      (await ask('realestate.buyer_profile.get', { dealId: nguyen }, owner)).profile,
    ).not.toBeNull();
    expect(buyerProfileOfCopy(copy, nguyen, ctx)).toEqual({ profile: null, full: false });
    expect((await ask('realestate.homes', { dealId: nguyen }, owner)).homes.length).toBe(4);
    expect(homesOfCopy(copy, nguyen, {}, ctx)).toEqual({ homes: [], full: false });
    const memory = await ask('realestate.memory', { dealId: nguyen }, owner);
    expect(memory.items.length).toBeGreaterThan(0);
    // How many suggestions fair housing left out is on the deal's own row, which the summary keeps.
    expect(memoryOfCopy(copy, nguyen, {}, ctx)).toEqual({
      ...memory,
      items: [],
      waiting: 0,
      full: false,
    });
    expect((await ask('realestate.matches', { dealId: nguyen }, owner)).matches.length).toBe(3);
    expect(matchesOfCopy(copy, nguyen, {}, ctx)).toEqual({
      search: null,
      matches: [],
      counts: { new: 0, sent: 0, dismissed: 0 },
      full: false,
    });
    // A deal the phone doesn't hold at all.
    const gone = randomUUID();
    expect(buyerProfileOfCopy(copy, gone, ctx)).toBeNull();
    expect(homesOfCopy(copy, gone, {}, ctx)).toBeNull();
    expect(memoryOfCopy(copy, gone, {}, ctx)).toBeNull();
    expect(matchesOfCopy(copy, gone, {}, ctx)).toBeNull();
  });

  it('aren’t equal by being empty', async () => {
    const copy = await phoneCopy(agent, ws);
    const ctx = { userId: agent.id };

    expect(buyerProfileOfCopy(copy, nguyen, ctx)!.profile).toMatchObject({
      version: 2,
      bathsMin: 2,
      moveBy: '2027-01-15',
      areas: ['Austin', '78704'],
      updatedBy: { id: agent.id, fullName: 'Dana Reyes' },
    });

    const { homes } = homesOfCopy(copy, nguyen, { includeRemoved: true }, ctx)!;
    expect(homes.map((h) => [h.address, h.source, h.status, h.factsState])).toEqual([
      ['12 Main Street, Austin, TX', 'agent', 'saved', 'suggested'],
      ['418 Maple Ave, Austin, TX', 'agent', 'shortlisted', 'confirmed'],
      ['9 Elm St, Round Rock, TX', 'agent', 'removed', 'none'],
      ['77 Oak Lane, Austin, TX 78704', 'client', 'saved', 'none'],
      ['1204 Elm St, Austin, TX 78704', 'mls', 'saved', 'confirmed'],
    ]);
    const [main, maple, , oak, sent] = homes;
    expect(main!.factSources).toMatchObject({ beds: '3 beds' });
    expect(main!.hasPastedText).toBe(true);
    expect(main!.reactions.map((r) => [r.name, r.reaction, r.note])).toEqual([
      ['Tuan Nguyen', 'saved', null],
      ['Linh Nguyen', 'saved', ''],
    ]);
    expect(maple!.statusNote).toBe('Ask about the parking');
    expect(maple!.fit.missed).toBeGreaterThan(0);
    expect(oak!.addedByClient).toMatchObject({ name: 'Linh Nguyen' });
    expect(oak!.reactions.map((r) => [r.name, r.reaction, r.note])).toEqual([
      ['Linh Nguyen', 'saved', 'Love the porch'],
      ['Tuan Nguyen', 'passed', 'Too far from work'],
    ]);
    expect(sent!.mls).toMatchObject({
      mlsNumber: 'ACT1',
      sourceWords: 'From the MLS (Unlock MLS, through Repliers)',
      differs: ['price_cents'],
    });

    const memory = memoryOfCopy(copy, nguyen, { includeClosed: true }, ctx)!;
    expect(memory.waiting).toBe(1);
    expect(memory.protectedDropped).toBe(2);
    expect(memory.items.map((i) => [i.words, i.status, i.suggestedBy])).toEqual(
      expect.arrayContaining([
        ['A fenced yard for the dog', 'confirmed', 'person'],
        ['Lease ends in March', 'retired', 'person'],
        ['Likes big, open kitchens', 'confirmed', 'ai'],
        ['Doesn’t want carpet', 'rejected', 'ai'],
        ['Wants to keep the payment under $3,000', 'suggested', 'ai'],
      ]),
    );
    expect(memory.items.find((i) => i.kind === 'money')!.quote).toBe('Under three grand a month.');

    const m = matchesOfCopy(copy, nguyen, {}, ctx)!;
    expect(m.search).toMatchObject({ on: true, missing: null, checkedAt: expect.any(String) });
    expect(m.search!.words).toMatch(/3\+ beds/);
    expect(m.counts).toEqual({ new: 1, sent: 1, dismissed: 1 });
    expect(m.matches.map((x) => [x.mls.mlsNumber, x.state, x.changedAt !== null])).toEqual([
      ['ACT2', 'new', true],
      ['ACT1', 'sent', false],
      ['ACT3', 'dismissed', false],
    ]);
    expect(m.matches[1]!.homeId).toBe(sent!.id);
    expect(m.matches[2]!.decidedBy).toEqual({ id: agent.id, fullName: 'Dana Reyes' });
  });
});
