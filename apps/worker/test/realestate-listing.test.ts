/**
 * Real Estate Agent, round three, in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"): a listing's facts read from its old listing's pasted words by the model (the stand-in here), from those
 * words alone and without the old price, waiting for a person to confirm them.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ADDON_SERVER_MODULES,
  scheduleSet,
  type PublicActor,
  executeCommand,
  executeQuery,
  localDateOf,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
} from '@hfos/core/server';
import type { ScriptRule } from '@hfos/ai';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateBusiness } from '../../../packages/core/test/addons/realestate-fixture';
import { makeCalendar, type Team } from '../../../packages/core/test/calendar-helpers';
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
let maria: string;

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
  maria = (
    await executeCommand(
      api(),
      personCreate,
      {
        workspaceId: ws,
        firstName: 'Maria',
        lastName: 'Alvarez',
        email: `maria-${randomUUID().slice(0, 8)}@example.com`,
      },
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

describe('a listing’s description', () => {
  it('is drafted from the confirmed facts and the seller’s own words, and both checks read it', async () => {
    await run('realestate.listing.confirm_facts', {
      dealId: listing,
      facts: { beds: 4, baths: 3, sqft: 2340, year_built: 2004 },
      sources: { beds: 'pasted', baths: 'pasted', sqft: 'pasted', year_built: 'pasted' },
      highlights: 'The kitchen was redone in 2021',
    });
    await rows(
      admin(),
      sql`insert into addon_realestate.seller_questionnaires (workspace_id, deal_record_id, answers, state,
            submitted_at)
          values (${ws}, ${listing}, ${JSON.stringify({
            loves: 'Perfect for a growing family, with the patio under the oaks',
          })}::jsonb, 'submitted', now())`,
    );
    await run('realestate.listing.description.request', { dealId: listing });
    await drain();
    const { listing: l } = await ask('realestate.listing', { dealId: listing });
    const w = l.description.working;
    expect(w).toMatchObject({ version: 1, source: 'ai', state: 'ready' });
    expect(w.words).toContain('2207 Juniper Trail');
    expect(w.words).toContain('4 bedrooms');
    expect(w.words).toContain('The kitchen was redone in 2021.');
    expect(w.checked).toEqual({ words: true, model: true });
    expect(w.flags.map((f: Any) => f.phrase.toLowerCase())).toContain('growing family');
    expect(w.blocked.rule).toBe('realestate_fair_housing_flags');
  });

  it('reads the agent’s own words again with the model', async () => {
    await run('realestate.listing.description.save', {
      dealId: listing,
      words:
        'Welcome to 2207 Juniper Trail. It has 4 bedrooms and 3 bathrooms, with the patio under the oaks.',
    });
    await drain();
    const { listing: l } = await ask('realestate.listing', { dealId: listing });
    expect(l.description.working).toMatchObject({
      version: 2,
      source: 'person',
      checked: { words: true, model: true },
      flags: [],
      blocked: null,
    });
  });
});

describe('a listing’s social posts', () => {
  it('are drafted three at a time from the home’s facts, each read by both checks', async () => {
    await run('realestate.listing.posts_request', { dealId: listing });
    await drain();
    const m = await ask('realestate.listing.marketing', { dealId: listing });
    expect(m.posts.state).toBe('ready');
    expect(m.posts.items).toHaveLength(3);
    expect(m.posts.items[0].words).toContain('2207 Juniper Trail');
    expect(m.posts.items.every((p: Any) => p.checked.words && p.checked.model)).toBe(true);
    const [proof] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_realestate.listing_posts
          where deal_record_id = ${listing} and state = 'ready' and model is not null`,
    );
    expect(proof!.n).toBe(3);
  });
});

describe('an open house’s next morning', () => {
  it('reminds the host about visitors not followed up, and clears once they are', async () => {
    await executeCommand(
      api(),
      scheduleSet,
      {
        workspaceId: ws,
        ownerId: agent.id,
        weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
      },
      human(agent),
      meta(),
    );
    const [w] = await rows<{ org: string; tz: string }>(
      admin(),
      sql`select organization_id as org, timezone as tz from app.workspaces where id = ${ws}`,
    );
    const team = {
      owner: agent,
      wsId: ws,
      scope: { workspaceId: ws, organizationId: w!.org },
    } as unknown as Team;
    await makeCalendar(team, 'Showings', { team: { members: [{ userId: agent.id }] } });
    await run('realestate.listing.mark_live', {
      dealId: listing,
      mlsNumber: '4821937',
      liveOn: localDateOf(Date.now(), w!.tz),
    });
    await rows(
      admin(),
      sql`update addon_realestate.listings set slug = '2207-juniper-trail' where deal_record_id = ${listing}`,
    );
    const quarter = 15 * 60_000;
    const { openHouseId } = await run('realestate.open_house.plan', {
      dealId: listing,
      startsAt: new Date(Math.ceil((Date.now() + 30 * 60_000) / quarter) * quarter).toISOString(),
      acknowledgeWarnings: true,
    });
    const visitor: PublicActor = {
      type: 'public',
      workspaceId: ws,
      organizationId: w!.org,
      site: 'x',
      visitor: 'hmac',
    };
    await executeCommand(
      testDbs().worker.db,
      op('realestate.public.open_house.sign_in') as CommandDef,
      {
        workspaceId: ws,
        slug: '2207-juniper-trail',
        openHouseId,
        firstName: 'Marcus',
        phone: '+17375550110',
      },
      visitor,
      { correlationId: randomUUID(), channel: 'booking_page' },
    );
    await drain();
    // The next morning comes now.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now()
          where workspace_id = ${ws} and kind = 'realestate.open_house_follow_up' and status = 'pending'`,
    );
    await drain();
    const alert = async () =>
      (
        await rows<{ title: string; cleared: boolean }>(
          admin(),
          sql`select title, cleared_at is not null as cleared from app.addon_alerts
              where workspace_id = ${ws} and key = ${`open_house:${openHouseId}`}`,
        )
      )[0];
    expect(await alert()).toEqual({
      title: '1 open house visitor to follow up at 2207 Juniper Trail',
      cleared: false,
    });
    const { openHouses } = await ask('realestate.open_houses', { dealId: listing });
    await run('realestate.open_house.follow_up', { visitorId: openHouses[0].visitors[0].id });
    await drain();
    expect((await alert())!.cleared).toBe(true);
  });
});

describe('a new price', () => {
  it('reminds the listing’s agent to change it on the MLS', async () => {
    await run('realestate.term.enter', {
      dealId: listing,
      key: 'list_price',
      cents: 49_900_000,
      source: 'agreement',
    });
    const { priceId } = await run('realestate.listing.price.propose', {
      dealId: listing,
      priceCents: 48_900_000,
    });
    // The agent here owns the business, so they may let it through.
    await run('realestate.listing.price.let_through', {
      priceId,
      reason: 'Maria signed the change on paper.',
    });
    await drain();
    const [alert] = await rows<{ title: string; href: string }>(
      admin(),
      sql`select title, href from app.addon_alerts
          where workspace_id = ${ws} and key = ${`price_mls:${listing}`}`,
    );
    expect(alert).toEqual({
      title: 'Change the price on the MLS: 2207 Juniper Trail is now $489,000',
      href: `/a/realestate/deals/${listing}/price`,
    });
  });
});

describe('our listing and our buyers', () => {
  it('tells a buyer’s agent when one of our listings fits what their buyer wants', async () => {
    const { dealId } = await run('realestate.deal.open', { side: 'buyer', name: 'Ortiz search' });
    await run('realestate.buyer_profile.save', {
      dealId,
      profile: { budgetMaxCents: 50_000_000, areas: ['Austin'], mustHaves: [], dealBreakers: [] },
    });
    await drain();
    const [alert] = await rows<{ title: string; href: string; assignee: string }>(
      admin(),
      sql`select title, href, assignee_user_id as assignee from app.addon_alerts
          where workspace_id = ${ws} and key like ${`suggested:${dealId}:%`}`,
    );
    expect(alert).toEqual({
      title: 'Our listing at 2207 Juniper Trail fits Ortiz search',
      href: `/a/realestate/deals/${dealId}/homes`,
      assignee: agent.id,
    });
    const { listing: l } = await ask('realestate.listing', { dealId: listing });
    expect(l.matches.suggested).toBe(1);
  });
});

describe('a seller’s answer on an offer', () => {
  it('tells the listing’s agent what she wants, without accepting anything', async () => {
    const { offerId } = await run('realestate.offer.start', {
      dealId: listing,
      buyerNames: 'Wei and Lin Chen',
      terms: { priceCents: 53_500_000, loanType: 'cash' },
    });
    const { comparisonId } = await run('realestate.offers.share_comparison', { dealId: listing });
    const [w] = await rows<{ org: string }>(
      admin(),
      sql`select organization_id as org from app.workspaces where id = ${ws}`,
    );
    const sys = { type: 'system' as const, workspaceId: ws, organizationId: w!.org };
    const { accessId } = (
      await executeCommand(
        api(),
        portalAccessGive,
        { workspaceId: ws, personId: maria },
        human(agent),
        meta(),
      )
    ).output;
    const sent = (
      await executeCommand(
        testDbs().worker.db,
        portalSendCode,
        { workspaceId: ws, accessId },
        sys,
        meta(),
      )
    ).output;
    const hit = (
      await executeCommand(
        testDbs().worker.db,
        portalCheckCode,
        {
          workspaceId: ws,
          accessId,
          code: sent.code,
          tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        },
        sys,
        meta(),
      )
    ).output;
    const mariaOnPhone: CustomerActor = {
      type: 'customer',
      workspaceId: ws,
      organizationId: w!.org,
      personId: maria,
      sessionId: hit.sessionId!,
    };
    await executeCommand(
      testDbs().worker.db,
      op('realestate.portal.offer_choice') as CommandDef,
      { workspaceId: ws, comparisonId, offerId, choice: 'counter', words: 'Ask for the 20th.' },
      mariaOnPhone,
      { correlationId: randomUUID(), channel: 'portal' },
    );
    await drain();
    const [alert] = await rows<{ title: string; href: string; assignee: string }>(
      admin(),
      sql`select title, href, assignee_user_id as assignee from app.addon_alerts
          where workspace_id = ${ws} and key = ${`seller_chose:${listing}:${offerId}`}`,
    );
    expect(alert).toEqual({
      title: 'Maria wants to counter offer 1 from Wei and Lin Chen',
      href: `/a/realestate/deals/${listing}/offers`,
      assignee: agent.id,
    });
  });
});
