/**
 * Real Estate Agent, round three: the listing (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"). The pure parts first (each fact's sources and whether they agree, a page's address, the MLS words), then on
 * the database: a listing's facts from the seller's questionnaire, the old listing's words and the agent, confirmed by
 * a person only; its photos in order; and a buyer deal refused all of it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  factChoices,
  listingSlugFrom,
  notOnMlsWords,
  streetOf,
} from '../../src/addons/realestate/listing';
import { homeFit, suggestsListing } from '../../src/addons/realestate/homes';
import { netEstimate, shareOf } from '../../src/addons/realestate/net';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { checkWords, FAIR_HOUSING_WORDS_VERSION } from '../../src/addons/realestate/fair-housing';
import { textHashOf } from '../../src/addons/realestate/ops/client-updates';
import {
  executeCommand,
  executeQuery,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  scheduleSet,
  tagCreate,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type PublicActor,
  type QueryDef,
  type RequestMeta,
} from '../../src/server';
import { makeCalendar, type Team } from '../calendar-helpers';
import { realestateBusiness } from './realestate-fixture';

describe('a listing’s facts, pure', () => {
  it('lines up what the seller and the old listing say, and says when they disagree', () => {
    const choices = factChoices({
      confirmed: { beds: 4 },
      confirmedSources: { beds: { from: 'seller' } },
      seller: { beds: 4, sqft: 2400 },
      pasted: { beds: 4, sqft: 2340, year_built: 2004 },
      pastedQuotes: { sqft: '2,340 sq ft of living space', year_built: 'Built in 2004' },
    });
    const by = Object.fromEntries(choices.map((c) => [c.key, c]));
    expect(by['beds']!.disagree).toBe(false);
    expect(by['beds']!.confirmed).toMatchObject({ from: 'seller', value: 4, words: '4' });
    expect(by['sqft']!.disagree).toBe(true);
    expect(by['sqft']!.candidates.map((c) => [c.from, c.value, c.quote])).toEqual([
      ['seller', 2400, null],
      ['pasted', 2340, '2,340 sq ft of living space'],
    ]);
    expect(by['year_built']!.candidates).toHaveLength(1);
    // A listing's price is its own: never one of its facts.
    expect(choices.map((c) => c.key)).not.toContain('price_cents');
  });

  it('names the page by the street, and says why nothing public goes before the MLS', () => {
    expect(listingSlugFrom('2207 Juniper Trail, Austin, TX 78745')).toBe('2207-juniper-trail');
    expect(listingSlugFrom('12 Café Ct. #4, Austin')).toBe('12-cafe-ct-4');
    expect(streetOf('2207 Juniper Trail, Austin, TX')).toBe('2207 Juniper Trail');
    expect(notOnMlsWords('2207 Juniper Trail, Austin, TX')).toBe(
      '2207 Juniper Trail isn’t live on the MLS yet, so it can’t be shared outside your office. Mark it live on the listing page once it is.',
    );
  });
});

describe('the seller’s estimate, pure', () => {
  const figures = {
    payoffCents: 21_240_000,
    listingFeeBp: 300,
    listingFeeCents: null,
    titleEscrowCents: 385_000,
    transferTaxBp: 0,
    otherCents: 75_000,
    otherNote: 'HOA transfer',
  };

  it('takes each cost from the price, every line labelled, in whole cents', () => {
    // The Chens: cash at $535,000, their agent asking 2% of the seller.
    const chen = netEstimate(
      {
        priceCents: 53_500_000,
        sellerCreditCents: 0,
        buyerAgentFeeBp: 200,
        buyerAgentFeeCents: null,
      },
      figures,
    );
    expect(chen.lines.map((l) => [l.label, l.cents])).toEqual([
      ['Price', 53_500_000],
      ['Listing fee · 3%', -1_605_000],
      ['Their agent’s fee · 2%', -1_070_000],
      ['Seller credit', -0],
      ['Mortgage payoff', -21_240_000],
      ['Title and escrow', -385_000],
      ['Transfer tax · 0%', -0],
      ['Other costs · HOA transfer', -75_000],
    ]);
    expect(chen.netCents).toBe(29_125_000);
    // The Patels: $10,000 more, with a credit and a bigger fee: they'd leave the seller less.
    const patel = netEstimate(
      {
        priceCents: 54_500_000,
        sellerCreditCents: 800_000,
        buyerAgentFeeBp: 300,
        buyerAgentFeeCents: null,
      },
      figures,
    );
    expect(patel.netCents).toBe(28_730_000);
  });

  it('takes a fee as an amount, and rounds a share to the nearest cent', () => {
    expect(shareOf(33_333, 250)).toBe(833);
    const flat = netEstimate(
      {
        priceCents: 40_000_000,
        sellerCreditCents: 0,
        buyerAgentFeeBp: null,
        buyerAgentFeeCents: 500_000,
      },
      { ...figures, listingFeeBp: null, listingFeeCents: 1_000_000, transferTaxBp: 50 },
    );
    expect(flat.lines.find((l) => l.key === 'listing_fee')).toEqual({
      key: 'listing_fee',
      label: 'Listing fee',
      cents: -1_000_000,
    });
    expect(flat.lines.find((l) => l.key === 'transfer_tax')!.cents).toBe(-200_000);
    expect(flat.netCents).toBe(
      40_000_000 - 1_000_000 - 500_000 - 21_240_000 - 385_000 - 200_000 - 75_000,
    );
  });
});

describe('suggesting our listing to a buyer, pure', () => {
  const want = {
    budgetMinCents: null,
    budgetMaxCents: 50_000_000,
    areas: ['Austin'],
    homeTypes: [],
    bedsMin: 3,
    bathsMin: null,
    sqftMin: null,
  };
  const home = { price_cents: 47_900_000, beds: 4, baths: 3, sqft: 2340 };

  it('suggests one within budget with nothing they asked for missed', () => {
    expect(suggestsListing(homeFit(want, home, '2207 Juniper Trail, Austin, TX'))).toBe(true);
    // Not in an area they named is "check the area", never a miss.
    expect(suggestsListing(homeFit(want, home, '9 Elm St, Round Rock, TX'))).toBe(true);
  });

  it('never suggests one over budget, short of what they need, or with no budget to go by', () => {
    expect(suggestsListing(homeFit({ ...want, budgetMaxCents: 40_000_000 }, home, 'Austin'))).toBe(
      false,
    );
    expect(suggestsListing(homeFit({ ...want, bedsMin: 5 }, home, 'Austin'))).toBe(false);
    expect(suggestsListing(homeFit({ ...want, budgetMaxCents: null }, home, 'Austin'))).toBe(false);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});
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
const run = (
  who: TestUser,
  name: string,
  input: Record<string, unknown>,
  channel?: RequestMeta['channel'],
): Promise<Any> =>
  executeCommand(
    api(),
    op('commands', name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(channel),
  ).then((r) => r.output);
const system = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeCommand(
    worker(),
    op('commands', name) as CommandDef,
    { workspaceId: ws, ...input },
    { type: 'system', workspaceId: ws, organizationId: org },
    meta('worker'),
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
let ws: string;
let org: string;
let maria: string;
let listing: string;
let buyerDeal: string;

/** A file uploaded to the listing deal, as the files screen leaves it. */
async function upload(name: string, mime: string): Promise<string> {
  const [f] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes,
          status, created_by)
        values (${ws}, 'custom_record', ${listing}, ${`${ws}/${randomUUID()}/${name}`}, ${name}, ${mime}, 1024,
          'ready', ${agent.id})
        returning id`,
  );
  return f!.id;
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rel-owner'),
    createTestUser('rel-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Listing Realty');
  const [w] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${ws}`,
  );
  org = w!.organization_id;
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' as const });
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
    await run(agent, 'realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'pre_listing',
      clientPersonId: maria,
      newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
    })
  ).dealId;
  buyerDeal = (await run(agent, 'realestate.deal.open', { side: 'buyer', name: 'Nguyen purchase' }))
    .dealId;
}, 90_000);
afterAll(closeTestDbs);

describe('a listing’s facts', () => {
  it('belong to listing deals only', async () => {
    expect(await refused(ask(agent, 'realestate.listing', { dealId: buyerDeal }))).toBe(
      'realestate_listing_only',
    );
    expect(
      await refused(
        run(agent, 'realestate.listing.paste', { dealId: buyerDeal, text: 'x'.repeat(40) }),
      ),
    ).toBe('realestate_listing_only');
  });

  it('start empty, with the home’s address from the deal', async () => {
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: listing });
    expect(l).toMatchObject({
      address: '2207 Juniper Trail, Austin, TX 78745',
      street: '2207 Juniper Trail',
      facts: {},
      mls: null,
      page: { state: 'none', slug: null },
      questionnaire: { state: 'none' },
      pasted: { state: 'none' },
    });
  });

  it('ask the seller once for the questionnaire', async () => {
    const first = await run(agent, 'realestate.listing.request_questionnaire', { dealId: listing });
    expect(first.created).toBe(true);
    const again = await run(agent, 'realestate.listing.request_questionnaire', { dealId: listing });
    expect(again).toEqual({ taskId: first.taskId, created: false });
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: listing });
    expect(l.questionnaire).toMatchObject({ state: 'asked', taskId: first.taskId });
  });

  it('are read from the old listing’s pasted words by the worker, and the seller’s sent answers', async () => {
    const pasted = await run(agent, 'realestate.listing.paste', {
      dealId: listing,
      text: 'Light-filled 4 bed, 3 bath home with 2,340 sq ft of living space. Built in 2004. Two-car garage. Offered at $499,000.',
    });
    expect(pasted.filling).toBe(true);
    expect(
      await system('realestate.listing.fill_facts', {
        dealId: listing,
        facts: { beds: 4, baths: 3, sqft: 2340, year_built: 2004 },
        sources: { sqft: '2,340 sq ft of living space', year_built: 'Built in 2004' },
      }),
    ).toEqual({ dealId: listing, state: 'read' });
    // Read once: a second answer for the same paste changes nothing.
    expect(
      await system('realestate.listing.fill_facts', { dealId: listing, facts: { beds: 9 } }),
    ).toEqual({ dealId: listing, state: 'skipped' });
    // The seller sends their answers (their portal does this in step 12).
    await rows(
      admin(),
      sql`insert into addon_realestate.seller_questionnaires (workspace_id, deal_record_id, answers, state,
            submitted_by_person_id, submitted_at)
          values (${ws}, ${listing}, ${JSON.stringify({
            facts: { beds: 4, sqft: 2400, hoa_monthly_cents: 4500 },
            updates: 'New kitchen in 2021. Roof 2019.',
            loves: 'The patio under the oaks.',
          })}::jsonb, 'submitted', ${maria}, now())`,
    );
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: listing });
    expect(l.pasted).toEqual({ state: 'read', failure: null, found: 4 });
    expect(l.questionnaire).toMatchObject({
      state: 'submitted',
      updates: 'New kitchen in 2021. Roof 2019.',
      loves: 'The patio under the oaks.',
    });
    const sqft = l.choices.find((c: Any) => c.key === 'sqft');
    expect(sqft.disagree).toBe(true);
    expect(sqft.candidates.map((c: Any) => [c.from, c.value])).toEqual([
      ['seller', 2400],
      ['pasted', 2340],
    ]);
  });

  it('are confirmed by a person only, each keeping where it came from, as proof for S-09', async () => {
    const facts = {
      beds: 4,
      baths: 3,
      sqft: 2340,
      year_built: 2004,
      hoa_monthly_cents: 4500,
      lot_sqft: 9148,
    };
    const sources = {
      beds: 'seller',
      baths: 'pasted',
      sqft: 'pasted',
      year_built: 'pasted',
      hoa_monthly_cents: 'seller',
    };
    expect(
      await refused(
        run(
          agent,
          'realestate.listing.confirm_facts',
          { dealId: listing, facts, sources },
          'assistant',
        ),
      ),
    ).toBe('forbidden');
    const done = await run(agent, 'realestate.listing.confirm_facts', {
      dealId: listing,
      facts,
      sources,
      highlights: 'Kitchen redone in 2021 with quartz and a gas range.',
    });
    expect(done.confirmedAt).toBeTruthy();
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: listing });
    expect(l.facts).toEqual(facts);
    expect(l.factsConfirmedBy).toEqual({ id: agent.id, fullName: 'Dana Reyes' });
    expect(l.highlights).toBe('Kitchen redone in 2021 with quartz and a gas range.');
    const by = Object.fromEntries(l.choices.map((c: Any) => [c.key, c.confirmed]));
    expect(by['sqft']).toMatchObject({ from: 'pasted', quote: '2,340 sq ft of living space' });
    expect(by['beds']).toMatchObject({ from: 'seller', quote: null });
    expect(by['lot_sqft']).toMatchObject({ from: 'agent' });
    const proof = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.workspace_id = ${ws} and e.ref_kind = 'listing' and e.ref_id = ${listing}`,
    );
    expect(proof.map((p) => p.key)).toEqual(['S-09']);
  });
});

describe('a listing’s photos', () => {
  let front: string;
  let kitchen: string;
  let yard: string;

  it('are the deal’s own uploaded images, added at the end, as proof for S-18', async () => {
    // "Organize listing photos" opens at Coming soon.
    await run(agent, 'realestate.deal.move_stage', { dealId: listing, stage: 'coming_soon' });
    [front, kitchen, yard] = [
      await upload('front.jpg', 'image/jpeg'),
      await upload('kitchen.jpg', 'image/jpeg'),
      await upload('yard.png', 'image/png'),
    ];
    const pdf = await upload('disclosure.pdf', 'application/pdf');
    for (const fileId of [front, kitchen, yard])
      await run(agent, 'realestate.listing.photo_add', { dealId: listing, fileId });
    expect(
      await refused(run(agent, 'realestate.listing.photo_add', { dealId: listing, fileId: pdf })),
    ).toBe('realestate_photo_not_image');
    expect(
      await refused(
        run(agent, 'realestate.listing.photo_add', { dealId: listing, fileId: randomUUID() }),
      ),
    ).toBe('not_found');
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: listing });
    expect(l.photos.map((p: Any) => [p.name, p.position, p.public])).toEqual([
      ['front.jpg', 0, true],
      ['kitchen.jpg', 1, true],
      ['yard.png', 2, true],
    ]);
    const [proof] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_realestate.duty_evidence
          where workspace_id = ${ws} and ref_kind = 'listing_photos'`,
    );
    expect(proof!.n).toBeGreaterThan(0);
  });

  it('are put in order with their captions, every one of them, and one taken off closes the gap', async () => {
    const { listing: before } = await ask(agent, 'realestate.listing', { dealId: listing });
    const ids = Object.fromEntries(before.photos.map((p: Any) => [p.name, p.id]));
    expect(
      await refused(
        run(agent, 'realestate.listing.photos_arrange', {
          dealId: listing,
          photos: [{ id: ids['front.jpg'], caption: null, public: true }],
        }),
      ),
    ).toBe('realestate_photos_changed');
    await run(agent, 'realestate.listing.photos_arrange', {
      dealId: listing,
      photos: [
        { id: ids['kitchen.jpg'], caption: 'The 2021 kitchen', public: true },
        { id: ids['front.jpg'], caption: null, public: true },
        { id: ids['yard.png'], caption: null, public: false },
      ],
    });
    await run(agent, 'realestate.listing.photo_remove', {
      dealId: listing,
      photoId: ids['front.jpg'],
    });
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: listing });
    expect(l.photos.map((p: Any) => [p.name, p.position, p.caption, p.public])).toEqual([
      ['kitchen.jpg', 0, 'The 2021 kitchen', true],
      ['yard.png', 1, null, false],
    ]);
  });
});

// ---------- the description (step 4) ----------

/** Maria, signed in to her portal on a device, as the worker signs her in (once: codes are limited per hour). */
let mariaSession: CustomerActor | null = null;
async function mariaSignsIn(): Promise<CustomerActor> {
  if (mariaSession) return mariaSession;
  const { accessId } = (
    await executeCommand(
      api(),
      portalAccessGive,
      { workspaceId: ws, personId: maria },
      human(agent),
      meta(),
    )
  ).output;
  const sys = { type: 'system' as const, workspaceId: ws, organizationId: org };
  const sent = (
    await executeCommand(worker(), portalSendCode, { workspaceId: ws, accessId }, sys, meta())
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
      sys,
      meta(),
    )
  ).output;
  mariaSession = {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId: maria,
    sessionId: hit.sessionId!,
  };
  return mariaSession;
}

/** What the worker records once it has written a draft: the words and both checks. */
const drafted = (descriptionId: string, words: string) =>
  system('realestate.listing.description.drafted', {
    descriptionId,
    words,
    model: 'stand-in',
    checks: [
      {
        source: 'words',
        version: FAIR_HOUSING_WORDS_VERSION,
        status: checkWords(words).length ? 'flagged' : 'passed',
        flags: checkWords(words),
      },
      { source: 'model', version: 'stand-in', status: 'passed', flags: [] },
    ],
  });

const description = async () =>
  (await ask(agent, 'realestate.listing', { dealId: listing })).listing.description;

describe('the description', () => {
  const flagged =
    'Welcome to 2207 Juniper Trail. It has 4 bedrooms, 3 bathrooms and 2,340 square feet. Perfect for a growing family, with the patio under the oaks.';
  const fixed =
    'Welcome to 2207 Juniper Trail. It has 4 bedrooms, 3 bathrooms and 2,340 square feet. Room to spread out, with the patio under the oaks.';

  it('waits for the home’s confirmed facts', async () => {
    const bare = (
      await run(agent, 'realestate.deal.open', { side: 'listing', name: 'Bare listing' })
    ).dealId;
    expect(
      await refused(run(agent, 'realestate.listing.description.request', { dealId: bare })),
    ).toBe('realestate_listing_no_facts');
  });

  it('is drafted by the AI, and a flagged draft can’t go to the seller', async () => {
    const asked = await run(agent, 'realestate.listing.description.request', { dealId: listing });
    expect(asked).toMatchObject({ version: 1, state: 'drafting' });
    await drafted(asked.descriptionId, flagged);
    const d = await description();
    expect(d.inUse).toBeNull();
    expect(d.working).toMatchObject({ version: 1, source: 'ai', state: 'ready' });
    expect(d.working.flags.map((f: Any) => f.phrase.toLowerCase())).toEqual(['growing family']);
    expect(d.working.blocked.rule).toBe('realestate_fair_housing_flags');
    expect(
      await refused(
        run(agent, 'realestate.listing.description.send', { descriptionId: asked.descriptionId }),
      ),
    ).toBe('realestate_fair_housing_flags');
  });

  it('is saved as the agent’s own version, read again by both checks, then sent with its exact words', async () => {
    const saved = await run(agent, 'realestate.listing.description.save', {
      dealId: listing,
      words: fixed,
    });
    expect(saved).toMatchObject({ version: 2, state: 'ready', flags: [] });
    // The model hasn't read these words yet.
    expect(
      await refused(
        run(agent, 'realestate.listing.description.send', { descriptionId: saved.descriptionId }),
      ),
    ).toBe('realestate_check_running');
    await system('realestate.listing.description.checked', {
      descriptionId: saved.descriptionId,
      textHash: textHashOf(null, fixed),
      version: 'stand-in',
      status: 'passed',
      flags: [],
    });
    const sent = await run(agent, 'realestate.listing.description.send', {
      descriptionId: saved.descriptionId,
    });
    expect(sent.state).toBe('sent');
    const d = await description();
    expect(d.working).toMatchObject({ version: 2, state: 'sent' });
    expect(d.history.map((h: Any) => [h.version, h.source, h.state])).toEqual([
      [2, 'person', 'sent'],
      [1, 'ai', 'replaced'],
    ]);
    const [task] = await rows<{ kind: string; sign_off_words: string; ref_kind: string }>(
      admin(),
      sql`select kind, sign_off_words, ref_kind from addon_realestate.client_tasks
          where ref_id = ${saved.descriptionId}`,
    );
    expect(task).toEqual({
      kind: 'sign_off',
      sign_off_words: fixed,
      ref_kind: 'listing_description',
    });
  });

  it('goes in use once the seller signs it off in her portal, as proof for S-19', async () => {
    const d0 = await description();
    const [task] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.client_tasks where ref_id = ${d0.working.id}`,
    );
    const mariaOnPhone = await mariaSignsIn();
    await executeCommand(
      worker(),
      op('commands', 'realestate.portal.task.complete') as CommandDef,
      { workspaceId: ws, taskId: task!.id, signedWords: fixed },
      mariaOnPhone,
      meta('portal'),
    );
    const d = await description();
    expect(d.inUse).toMatchObject({ version: 2, words: fixed, how: 'portal', reason: null });
    expect(d.working).toBeNull();
    const proof = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.ref_kind = 'listing_description' and e.ref_id = ${d.inUse.id}`,
    );
    expect(proof.map((p) => p.key)).toEqual(['S-19']);
  });

  it('can be let through without the portal by an owner or admin only, with a reason', async () => {
    const asked = await run(agent, 'realestate.listing.description.request', { dealId: listing });
    await drafted(asked.descriptionId, fixed.replace('Room to spread out', 'Plenty of room'));
    expect(
      await refused(
        run(agent, 'realestate.listing.description.let_through', {
          descriptionId: asked.descriptionId,
          reason: 'Maria signed it on paper.',
        }),
      ),
    ).toBe('realestate_let_through_permission');
    await run(owner, 'realestate.listing.description.let_through', {
      descriptionId: asked.descriptionId,
      reason: 'Maria signed it on paper at the office.',
    });
    const d = await description();
    expect(d.inUse).toMatchObject({
      version: 3,
      how: 'let_through',
      reason: 'Maria signed it on paper at the office.',
    });
    // The one before it is set aside.
    expect(d.history.find((h: Any) => h.version === 2).state).toBe('replaced');
  });
});

// ---------- live on the MLS, the hold and marketing (steps 5 and 6) ----------

const visitor = (): PublicActor => ({
  type: 'public',
  workspaceId: ws,
  organizationId: org,
  site: 'listing-realty',
  visitor: 'hmac',
});
const asVisitor = (name: string, input: Record<string, unknown>): Promise<Any> => {
  const found = [
    ...(realestateAddonServer.commands ?? []),
    ...(realestateAddonServer.queries ?? []),
  ].find((x) => x.name === name)!;
  return found.kind === 'command'
    ? executeCommand(
        worker(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        visitor(),
        meta('booking_page'),
      ).then((r) => r.output)
    : executeQuery(
        worker(),
        found as QueryDef,
        { workspaceId: ws, ...input },
        visitor(),
        meta('booking_page'),
      );
};

describe('before the MLS', () => {
  it('holds everything public: the page, the flyer and an email or text to contacts', async () => {
    const hold =
      '2207 Juniper Trail isn’t live on the MLS yet, so it can’t be shared outside your office. Mark it live on the listing page once it is.';
    const m = await ask(agent, 'realestate.listing.marketing', { dealId: listing });
    expect(m.mls).toBeNull();
    expect(m.hold).toBe(hold);
    expect(await refused(run(agent, 'realestate.listing.page_publish', { dealId: listing }))).toBe(
      'realestate_not_on_mls',
    );
    expect(await refused(ask(agent, 'realestate.listing.flyer', { dealId: listing }))).toBe(
      'realestate_not_on_mls',
    );
    expect(
      await refused(
        run(agent, 'realestate.listing.campaign', {
          dealId: listing,
          channel: 'sms',
          audience: { tagIds: [randomUUID()] },
          pageUrl: 'http://localhost:3000/a/x/realestate/y',
        }),
      ),
    ).toBe('realestate_not_on_mls');
  });

  it('lifts once the agent marks it live, which moves it to Active and is proof for S-20', async () => {
    expect(
      await refused(
        run(agent, 'realestate.listing.mark_live', {
          dealId: listing,
          mlsNumber: '4821937',
          liveOn: '2999-01-01',
        }),
      ),
    ).toBe('validation');
    const live = await run(agent, 'realestate.listing.mark_live', {
      dealId: listing,
      mlsNumber: '4821937',
      liveOn: new Date().toISOString().slice(0, 10),
    });
    expect(live.movedTo).toBe('active');
    const m = await ask(agent, 'realestate.listing.marketing', { dealId: listing });
    expect(m.mls).toMatchObject({ number: '4821937' });
    expect(m.hold).toBeNull();
    const proof = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.ref_kind = 'listing_mls' and e.ref_id = ${listing}`,
    );
    expect(proof.map((p) => p.key)).toEqual(['S-20']);
  });
});

describe('the public page', () => {
  let path: string;

  it('goes up under the business’s site with the street for its address', async () => {
    // The business has no public address yet: a member can't give it one.
    expect(await refused(run(agent, 'realestate.listing.page_publish', { dealId: listing }))).toBe(
      'realestate_no_public_name',
    );
    const page = await run(owner, 'realestate.listing.page_publish', { dealId: listing });
    expect(page).toMatchObject({ state: 'published', slug: '2207-juniper-trail' });
    expect(page.site).toBeTruthy();
    path = page.path;
    expect(path).toBe(`/a/${page.site}/realestate/2207-juniper-trail`);
  });

  it('shows a visitor only what was published: confirmed facts, the photos for the page, the signed words', async () => {
    const p = await asVisitor('realestate.public.listing', { slug: '2207-juniper-trail' });
    expect(p).toMatchObject({
      street: '2207 Juniper Trail',
      cityLine: 'Austin, TX 78745',
      status: 'for_sale',
      mlsNumber: '4821937',
      agentName: 'Dana Reyes',
    });
    expect(p.description).toContain('Plenty of room');
    expect(p.facts.map((f: Any) => f.label)).toContain('Bedrooms');
    // The yard photo is kept for the agent and the seller.
    expect(p.photos).toHaveLength(1);
    expect(p.photos[0].caption).toBe('The 2021 kitchen');
    expect(await refused(asVisitor('realestate.public.listing', { slug: 'nope' }))).toBe(
      'not_found',
    );
  });

  it('takes a visitor’s question as a lead for the agent, with their yes to texts', async () => {
    expect(
      await refused(
        asVisitor('realestate.public.ask', {
          slug: '2207-juniper-trail',
          firstName: 'Kayla',
          question: 'Is the garage wired for a car charger?',
        }),
      ),
    ).toBe('validation');
    await asVisitor('realestate.public.ask', {
      slug: '2207-juniper-trail',
      firstName: 'Kayla',
      lastName: 'Brooks',
      phone: '+15125550187',
      question: 'Is the garage wired for a car charger?',
      smsConsent: true,
    });
    const [p] = await rows<{ id: string; sms_consent: string; sms_consent_source: string }>(
      admin(),
      sql`select id, sms_consent::text, sms_consent_source from app.people
          where workspace_id = ${ws} and first_name = 'Kayla'`,
    );
    expect(p).toMatchObject({
      sms_consent: 'opted_in',
      sms_consent_source: 'Listing page: 2207 Juniper Trail',
    });
    const [lead] = await rows<{ title: string; assignee_user_id: string }>(
      admin(),
      sql`select title, assignee_user_id from app.leads where person_id = ${p!.id}`,
    );
    expect(lead).toEqual({ title: 'Asked about 2207 Juniper Trail', assignee_user_id: agent.id });
  });

  it('feeds the flyer and a text to contacts with exact, checked words', async () => {
    const f = await ask(agent, 'realestate.listing.flyer', { dealId: listing });
    expect(f).toMatchObject({ street: '2207 Juniper Trail', mlsNumber: '4821937' });
    expect(f.page.path).toBe(path);
    const { tagId } = (
      await executeCommand(
        api(),
        tagCreate,
        { workspaceId: ws, name: 'Past clients' },
        human(owner),
        meta(),
      )
    ).output;
    const [lucy] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, sms_consent)
          values (${ws}, 'Lucy', 'Past', '+15125550199', 'opted_in') returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
          values (${ws}, ${tagId}, 'person', ${lucy!.id})`,
    );
    expect(
      await refused(
        run(owner, 'realestate.listing.campaign', {
          dealId: listing,
          channel: 'sms',
          audience: { tagIds: [tagId] },
          pageUrl: 'http://localhost:3000/somewhere/else',
        }),
      ),
    ).toBe('validation');
    const made = await run(owner, 'realestate.listing.campaign', {
      dealId: listing,
      channel: 'sms',
      audience: { tagIds: [tagId] },
      pageUrl: `http://localhost:3000${path}`,
    });
    expect(made.recipients).toBe(1);
    const [r] = await rows<{ draft: string; status: string }>(
      admin(),
      sql`select draft, status from app.campaign_recipients where campaign_id = ${made.campaignId}`,
    );
    expect(r!.status).toBe('ready');
    expect(r!.draft).toBe(
      `Just listed: 2207 Juniper Trail. 4 beds, 3 baths. Photos: http://localhost:3000${path}`,
    );
  });

  it('comes down when taken down', async () => {
    await run(agent, 'realestate.listing.page_take_down', { dealId: listing });
    expect(
      await refused(asVisitor('realestate.public.listing', { slug: '2207-juniper-trail' })),
    ).toBe('not_found');
    await run(agent, 'realestate.listing.page_publish', { dealId: listing });
  });
});

describe('social posts', () => {
  it('are drafted in threes, each checked, and an edit is read again', async () => {
    const asked = await run(agent, 'realestate.listing.posts_request', { dealId: listing });
    expect(asked).toMatchObject({ batch: 1, state: 'drafting' });
    await system('realestate.listing.posts_drafted', {
      dealId: listing,
      batch: 1,
      model: 'stand-in',
      posts: [
        'Just listed: 2207 Juniper Trail.',
        'Four bedrooms and a 2021 kitchen.',
        'Open house Sunday.',
      ].map((words) => ({
        words,
        checks: [
          { source: 'words', version: FAIR_HOUSING_WORDS_VERSION, status: 'passed', flags: [] },
          { source: 'model', version: 'stand-in', status: 'passed', flags: [] },
        ],
      })),
    });
    const m = await ask(agent, 'realestate.listing.marketing', { dealId: listing });
    expect(m.posts.state).toBe('ready');
    expect(m.posts.items.map((p: Any) => [p.words, p.checked])).toEqual([
      ['Just listed: 2207 Juniper Trail.', { words: true, model: true }],
      ['Four bedrooms and a 2021 kitchen.', { words: true, model: true }],
      ['Open house Sunday.', { words: true, model: true }],
    ]);
    const saved = await run(agent, 'realestate.listing.post_save', {
      postId: m.posts.items[2].id,
      words: 'Open house Sunday. Perfect for a growing family.',
    });
    expect(saved.flags.map((f: Any) => f.phrase.toLowerCase())).toEqual(['growing family']);
    const after = await ask(agent, 'realestate.listing.marketing', { dealId: listing });
    expect(after.posts.items[2]).toMatchObject({
      edited: true,
      checked: { words: true, model: false },
    });
  });
});

// ---------- open houses (step 7) ----------

describe('open houses', () => {
  let openHouseId: string;

  it('go on the host’s calendar, say the listing has open houses, and are proof for S-36', async () => {
    await executeCommand(
      api(),
      scheduleSet,
      {
        workspaceId: ws,
        ownerId: agent.id,
        weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
      },
      human(owner),
      meta(),
    );
    const team = {
      owner,
      wsId: ws,
      scope: { workspaceId: ws, organizationId: org },
    } as unknown as Team;
    await makeCalendar(team, 'Showings', { team: { members: [{ userId: agent.id }] } });
    const quarter = 15 * 60_000;
    const startsAt = new Date(
      Math.ceil((Date.now() + 30 * 60_000) / quarter) * quarter,
    ).toISOString();
    const planned = await run(agent, 'realestate.open_house.plan', {
      dealId: listing,
      startsAt,
      durationMinutes: 120,
      acknowledgeWarnings: true,
    });
    openHouseId = planned.openHouseId;
    const [appt] = await rows<{ title: string }>(
      admin(),
      sql`select title from app.appointments where id = ${planned.appointmentId}`,
    );
    expect(appt!.title).toBe('Open house: 2207 Juniper Trail');
    const [deal] = await rows<{ facts: string[] }>(
      admin(),
      sql`select facts from addon_realestate.deals where record_id = ${listing}`,
    );
    expect(deal!.facts).toContain('open_house');
    const proof = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.appointment_id = ${planned.appointmentId}`,
    );
    expect(proof.map((p) => p.key)).toEqual(['S-36']);
    const page = await asVisitor('realestate.public.listing', { slug: '2207-juniper-trail' });
    expect(page.openHouses).toEqual([
      expect.objectContaining({ id: openHouseId, signInOpen: true }),
    ]);
  });

  it('sign a visitor in: on their own a customer with a lead; with an agent, only recorded', async () => {
    const page = await asVisitor('realestate.public.open_house', {
      slug: '2207-juniper-trail',
      openHouseId,
    });
    expect(page).toMatchObject({
      street: '2207 Juniper Trail',
      open: true,
      cancelled: false,
      hostName: 'Dana Reyes',
    });
    const kayla = {
      slug: '2207-juniper-trail',
      openHouseId,
      firstName: 'Kayla',
      lastName: 'Brooks',
      phone: '+15125550187',
      smsConsent: true,
    };
    await asVisitor('realestate.public.open_house.sign_in', kayla);
    // Signing in again is the same visit.
    await asVisitor('realestate.public.open_house.sign_in', kayla);
    await asVisitor('realestate.public.open_house.sign_in', {
      slug: '2207-juniper-trail',
      openHouseId,
      firstName: 'Sofia',
      email: 'sofia.r@example.com',
      withAgent: true,
      agentName: 'Kim Ortiz, Oakwood Realty',
      smsConsent: true,
    });
    const { openHouses } = await ask(agent, 'realestate.open_houses', { dealId: listing });
    const visitors = openHouses[0].visitors;
    expect(
      visitors.map((v: Any) => [v.firstName, v.withAgent, v.smsConsent, !!v.personId]),
    ).toEqual([
      ['Kayla', false, true, true],
      ['Sofia', true, false, false],
    ]);
    expect(openHouses[0].signInPath).toMatch(
      /\/a\/.+\/realestate\/2207-juniper-trail\/open-house\//,
    );
    const [person] = await rows<{ sms_consent_source: string }>(
      admin(),
      sql`select sms_consent_source from app.people where id = ${visitors[0].personId}`,
    );
    // Kayla asked on the page earlier: her yes then still stands, with where it came from.
    expect(person!.sms_consent_source).toMatch(/2207 Juniper Trail/);
    const [sofia] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.people where workspace_id = ${ws} and first_name = 'Sofia'`,
    );
    expect(sofia!.n).toBe(0);
  });

  it('mark a visitor followed up, as proof for S-39, and close sign-in when cancelled', async () => {
    const { openHouses } = await ask(agent, 'realestate.open_houses', { dealId: listing });
    const kayla = openHouses[0].visitors[0];
    const done = await run(agent, 'realestate.open_house.follow_up', {
      visitorId: kayla.id,
      note: 'Called; she’ll come back Saturday.',
    });
    expect(done.followedUpAt).toBeTruthy();
    const [proof] = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.ref_kind = 'open_house_visitor' and e.ref_id = ${kayla.id}`,
    );
    expect(proof!.key).toBe('S-39');
    await run(agent, 'realestate.open_house.cancel', { openHouseId, reason: 'Rain' });
    expect(
      await refused(
        asVisitor('realestate.public.open_house.sign_in', {
          slug: '2207-juniper-trail',
          openHouseId,
          firstName: 'Late',
          phone: '+15125550111',
        }),
      ),
    ).toBe('realestate_open_house_cancelled');
  });
});

// ---------- price changes (step 10) ----------

describe('a price change', () => {
  const prices = () => ask(agent, 'realestate.listing.prices', { dealId: listing });

  it('waits for a list price to change, and is asked of the seller with its exact words', async () => {
    expect(
      await refused(
        run(agent, 'realestate.listing.price.propose', { dealId: listing, priceCents: 1 }),
      ),
    ).toBe('realestate_no_list_price');
    // The first list price is a key term, with no sign-off.
    await run(agent, 'realestate.term.enter', {
      dealId: listing,
      key: 'list_price',
      cents: 49_900_000,
      source: 'agreement',
    });
    expect(
      await refused(
        run(agent, 'realestate.listing.price.propose', { dealId: listing, priceCents: 49_900_000 }),
      ),
    ).toBe('realestate_price_same');
    const asked = await run(agent, 'realestate.listing.price.propose', {
      dealId: listing,
      priceCents: 48_900_000,
      note: 'Two weeks, no offers.',
    });
    const [task] = await rows<{ sign_off_words: string; ref_kind: string; status: string }>(
      admin(),
      sql`select sign_off_words, ref_kind, status from addon_realestate.client_tasks where id = ${asked.taskId}`,
    );
    expect(task).toEqual({
      sign_off_words: 'Change the list price of 2207 Juniper Trail from $499,000 to $489,000.',
      ref_kind: 'listing_price',
      status: 'open',
    });
    expect(
      await refused(
        run(agent, 'realestate.listing.price.propose', { dealId: listing, priceCents: 47_000_000 }),
      ),
    ).toBe('realestate_price_waiting');
    // Not around it either: a new list price typed in is refused until the seller signs.
    expect(
      await refused(
        run(agent, 'realestate.term.enter', {
          dealId: listing,
          key: 'list_price',
          cents: 48_900_000,
        }),
      ),
    ).toBe('realestate_price_needs_signoff');
    const p = await prices();
    expect(p.currentCents).toBe(49_900_000);
    expect(p.waiting).toMatchObject({
      toCents: 48_900_000,
      state: 'waiting',
      taskId: asked.taskId,
    });
  });

  it('is used once the seller signs it in her portal, as proof for S-34', async () => {
    const { waiting } = await prices();
    const mariaOnPhone = await mariaSignsIn();
    await executeCommand(
      worker(),
      op('commands', 'realestate.portal.task.complete') as CommandDef,
      { workspaceId: ws, taskId: waiting.taskId, signedWords: waiting.words },
      mariaOnPhone,
      meta('portal'),
    );
    const p = await prices();
    expect(p.currentCents).toBe(48_900_000);
    expect(p.waiting).toBeNull();
    expect(p.history[0]).toMatchObject({ state: 'applied', how: 'portal', signedBy: 'Maria' });
    // The agent who asked for exactly this price confirms it; the old one stays in its history.
    const entries = await rows<{ cents: number; confirmed: string | null; superseded: boolean }>(
      admin(),
      sql`select value_cents::float8 as cents, confirmed_by as confirmed, superseded_at is not null as superseded
          from addon_realestate.term_entries
          where deal_record_id = ${listing} and key = 'list_price' order by entered_at`,
    );
    expect(entries).toEqual([
      { cents: 49_900_000, confirmed: agent.id, superseded: true },
      { cents: 48_900_000, confirmed: agent.id, superseded: false },
    ]);
    const [proof] = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.ref_kind = 'listing_price' and e.ref_id = ${waiting.id}`,
    );
    expect(proof!.key).toBe('S-34');
    const [event] = await rows<{ payload: Any }>(
      admin(),
      sql`select payload from app.events
          where workspace_id = ${ws} and event_type = 'realestate.listing.price_changed'`,
    );
    expect(event!.payload).toMatchObject({ toCents: 48_900_000, onMls: true, letThrough: false });
  });

  it('can be let through by an owner or admin only, with a reason, or withdrawn', async () => {
    const second = await run(agent, 'realestate.listing.price.propose', {
      dealId: listing,
      priceCents: 47_900_000,
    });
    expect(
      await refused(
        run(agent, 'realestate.listing.price.let_through', {
          priceId: second.priceId,
          reason: 'Maria signed the change on paper.',
        }),
      ),
    ).toBe('realestate_let_through_permission');
    const done = await run(owner, 'realestate.listing.price.let_through', {
      priceId: second.priceId,
      reason: 'Maria signed the change on paper.',
    });
    expect(done).toMatchObject({
      state: 'applied',
      how: 'let_through',
      overrideReason: 'Maria signed the change on paper.',
    });
    const [task] = await rows<{ status: string }>(
      admin(),
      sql`select status from addon_realestate.client_tasks where id = ${second.taskId}`,
    );
    expect(task!.status).toBe('canceled');
    const third = await run(agent, 'realestate.listing.price.propose', {
      dealId: listing,
      priceCents: 46_900_000,
    });
    const gone = await run(agent, 'realestate.listing.price.withdraw', {
      priceId: third.priceId,
      reason: 'They want to wait a week.',
    });
    expect(gone).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: 'They want to wait a week.',
    });
    const p = await prices();
    expect(p.currentCents).toBe(47_900_000);
    expect(p.history.map((h: Any) => [h.toCents, h.state])).toEqual([
      [46_900_000, 'withdrawn'],
      [47_900_000, 'applied'],
      [48_900_000, 'applied'],
    ]);
  });
});

// ---------- our listing suggested to our buyers (step 11) ----------

describe('our listing suggested to our buyers', () => {
  const profile = (dealId: string, budgetMaxCents: number) =>
    run(agent, 'realestate.buyer_profile.save', {
      dealId,
      profile: { budgetMaxCents, areas: ['Austin'], bedsMin: 3, mustHaves: [], dealBreakers: [] },
    });
  const counts = async () =>
    (await ask(agent, 'realestate.listing', { dealId: listing })).listing.matches;
  let patel: string;

  it('goes to the agents of the buyers it fits, with a copy of its public facts, as S-23’s note', async () => {
    await profile(buyerDeal, 50_000_000);
    patel = (await run(agent, 'realestate.deal.open', { side: 'buyer', name: 'Patel search' }))
      .dealId;
    await profile(patel, 40_000_000);
    expect(await system('realestate.match.run', { listingDealId: listing })).toEqual({
      suggested: 1,
      refreshed: 0,
      gone: 0,
    });
    const { suggestions } = await ask(agent, 'realestate.suggestions', { dealId: buyerDeal });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      address: '2207 Juniper Trail, Austin, TX 78745',
      priceCents: 47_900_000,
      mlsNumber: expect.any(String),
      state: 'new',
    });
    expect(suggestions[0].facts).toMatchObject({ beds: 4, baths: 3, sqft: 2340 });
    expect(suggestions[0].fit.map((f: Any) => [f.key, f.met])).toEqual([
      ['budget', true],
      ['area', true],
      ['beds', true],
    ]);
    // Over the Patels' budget: nothing for them.
    expect((await ask(agent, 'realestate.suggestions', { dealId: patel })).suggestions).toEqual([]);
    // The listing's side sees how many, never who.
    expect(await counts()).toMatchObject({ suggested: 1, added: 0 });
    const notes = await rows<{ body: string }>(
      admin(),
      sql`select e.body from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where d.deal_record_id = ${listing} and d.duty_key = 'S-23' and e.kind = 'note'`,
    );
    expect(notes.map((n) => n.body)).toEqual(['Suggested to the agents of 1 of our buyers']);
    // Run again, it's refreshed, not suggested twice.
    expect(await system('realestate.match.run', { listingDealId: listing })).toEqual({
      suggested: 0,
      refreshed: 1,
      gone: 0,
    });
    // A buyer's new profile is matched against every live listing.
    await profile(patel, 48_000_000);
    expect(await system('realestate.match.run', { buyerDealId: patel })).toMatchObject({
      suggested: 1,
    });
    expect(await counts()).toMatchObject({ suggested: 2 });
    expect(await refused(ask(agent, 'realestate.suggestions', { dealId: listing }))).toBe(
      'realestate_buyer_only',
    );
  });

  it('is added to their homes with its facts confirmed, or set aside, and the listing sees how many added', async () => {
    const [mine] = (await ask(agent, 'realestate.suggestions', { dealId: buyerDeal })).suggestions;
    const added = await run(agent, 'realestate.suggestion.add', { suggestionId: mine.id });
    expect(added.state).toBe('added');
    const [home] = await rows<{ source: string; facts_state: string; beds: number }>(
      admin(),
      sql`select source, facts_state, (facts->>'beds')::int as beds from addon_realestate.homes
          where id = ${added.homeId}`,
    );
    expect(home).toEqual({ source: 'our_listing', facts_state: 'confirmed', beds: 4 });
    const [theirs] = (await ask(agent, 'realestate.suggestions', { dealId: patel })).suggestions;
    const set = await run(agent, 'realestate.suggestion.not_a_fit', {
      suggestionId: theirs.id,
      reason: 'They want a newer home.',
    });
    expect(set.state).toBe('not_a_fit');
    // The worker counts again once one is decided.
    await system('realestate.match.run', { listingDealId: listing });
    expect(await counts()).toMatchObject({ suggested: 2, added: 1 });
    // Already one of their homes: never suggested again.
    expect(await system('realestate.match.run', { buyerDealId: buyerDeal })).toMatchObject({
      suggested: 0,
    });
  });

  it('is gone when it no longer fits', async () => {
    const kim = (await run(agent, 'realestate.deal.open', { side: 'buyer', name: 'Kim search' }))
      .dealId;
    await profile(kim, 48_000_000);
    await system('realestate.match.run', { buyerDealId: kim });
    expect((await ask(agent, 'realestate.suggestions', { dealId: kim })).suggestions[0].state).toBe(
      'new',
    );
    await profile(kim, 45_000_000);
    expect(await system('realestate.match.run', { buyerDealId: kim })).toMatchObject({ gone: 1 });
    const [s] = (await ask(agent, 'realestate.suggestions', { dealId: kim })).suggestions;
    expect(s.state).toBe('gone');
    expect(await refused(run(agent, 'realestate.suggestion.add', { suggestionId: s.id }))).toBe(
      'realestate_suggestion_gone',
    );
  });
});

// ---------- offers on a listing (step 8) ----------

describe('offers on a listing', () => {
  let chen: string;
  let patel: string;
  const dealNow = async () =>
    (
      await rows<{ stage: string; facts: string[] }>(
        admin(),
        sql`select stage, facts from addon_realestate.deals where record_id = ${listing}`,
      )
    )[0]!;
  const evidence = (refKind: string, refId: string) =>
    rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.ref_kind = ${refKind} and e.ref_id = ${refId} order by 1`,
    );

  it('come in on the listing itself, and two at once mean multiple offers, as proof for S-40', async () => {
    expect(await refused(ask(agent, 'realestate.offers.compare', { dealId: buyerDeal }))).toBe(
      'realestate_listing_only',
    );
    chen = (
      await run(agent, 'realestate.offer.start', {
        dealId: listing,
        buyerNames: 'Wei and Lin Chen',
        theirAgentName: 'Sam Ortiz',
        theirBrokerage: 'Hill Country Homes',
        terms: {
          priceCents: 53_500_000,
          emdCents: 1_000_000,
          loanType: 'cash',
          inspectionDays: 7,
          possession: 'At closing',
          buyerAgentFeeBp: 200,
          closingDate: '2026-11-20',
        },
        respondBy: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      })
    ).offerId;
    expect((await dealNow()).facts).not.toContain('multiple_offers');
    patel = (
      await run(agent, 'realestate.offer.start', {
        dealId: listing,
        buyerNames: 'Priya Patel',
        theirAgentName: 'Jo Kim',
        terms: {
          priceCents: 54_500_000,
          sellerCreditCents: 800_000,
          loanType: 'conventional',
          downPaymentPct: 20,
          financingDays: 30,
          appraisalContingency: true,
          homeSaleContingency: true,
          escalationCapCents: 55_500_000,
          escalationStepCents: 250_000,
          buyerAgentFeeBp: 300,
        },
        respondBy: new Date(Date.now() + 86_400_000).toISOString(),
      })
    ).offerId;
    expect((await dealNow()).facts).toContain('multiple_offers');
    expect((await evidence('offer', chen)).map((e) => e.key)).toContain('S-40');
    const { offers } = await ask(agent, 'realestate.offers', { dealId: listing });
    expect(offers.map((o: Any) => [o.number, o.buyerNames, o.status, o.address])).toEqual(
      expect.arrayContaining([
        [1, 'Wei and Lin Chen', 'waiting_us', '2207 Juniper Trail, Austin, TX 78745'],
        [2, 'Priya Patel', 'waiting_us', '2207 Juniper Trail, Austin, TX 78745'],
      ]),
    );
    // Their summary is for a buyer's client: a listing's offers are shared side by side instead.
    expect(await refused(run(agent, 'realestate.offer.share_summary', { offerId: chen }))).toBe(
      'realestate_offer_summary_buyer',
    );
  });

  it('sit side by side with the seller’s estimate from kept figures, the best flagged, as proof for X-04', async () => {
    const before = await ask(agent, 'realestate.offers.compare', { dealId: listing });
    expect(before.figures).toBeNull();
    // With no figures yet, only the fees the offers name come off.
    expect(before.rows.find((r: Any) => r.offerId === chen).net.netCents).toBe(
      53_500_000 - 1_070_000,
    );
    await run(agent, 'realestate.net_sheet.save', {
      dealId: listing,
      payoffCents: 21_000_000,
      listingFeeBp: 300,
      titleEscrowCents: 385_000,
      otherCents: 75_000,
    });
    const saved = await run(agent, 'realestate.net_sheet.save', {
      dealId: listing,
      payoffCents: 21_240_000,
      listingFeeBp: 300,
      titleEscrowCents: 385_000,
      otherCents: 75_000,
      otherNote: 'HOA transfer',
      note: 'Payoff from the lender’s letter',
    });
    expect(saved.version).toBe(2);
    const c = await ask(agent, 'realestate.offers.compare', { dealId: listing });
    expect(c.figures).toMatchObject({
      version: 2,
      payoffCents: 21_240_000,
      savedBy: { fullName: 'Dana Reyes' },
    });
    expect(c.figureHistory.map((f: Any) => f.version)).toEqual([1]);
    expect(c.rows.map((r: Any) => [r.buyers, r.net.netCents, r.best])).toEqual([
      ['Wei and Lin Chen', 29_125_000, true],
      ['Priya Patel', 28_730_000, false],
    ]);
    expect(c.rows[1]).toMatchObject({
      paying: 'Conventional · 20% down',
      buyerAgentFee: '3% · $16,350',
      financing: '30 days · appraisal contingency',
      homeSale: true,
      escalation: 'Up to $555,000, by $2,500',
    });
    expect(c.rows[0]).toMatchObject({
      paying: 'Cash',
      financing: null,
      inspection: '7 days',
      possession: 'At closing',
    });
    expect((await evidence('net_sheet', listing)).map((e) => e.key)).toEqual(['X-04']);
  });

  it('are shared with the seller as they are, and her choice tells the agent and accepts nothing', async () => {
    const shared = await run(agent, 'realestate.offers.share_comparison', { dealId: listing });
    expect(shared.offers).toBe(2);
    expect((await evidence('offer_comparison', shared.comparisonId)).map((e) => e.key)).toEqual(
      expect.arrayContaining(['S-43']),
    );
    const mariaOnPhone = await mariaSignsIn();
    const choose = (offerId: string, choice: string, words?: string) =>
      executeCommand(
        worker(),
        op('commands', 'realestate.portal.offer_choice') as CommandDef,
        { workspaceId: ws, comparisonId: shared.comparisonId, offerId, choice, words },
        mariaOnPhone,
        meta('portal'),
      );
    // Only an offer she was shown.
    expect(await refused(choose(randomUUID(), 'accept'))).toBe('not_found');
    await choose(chen, 'accept', 'Cash and the 20th works for us.');
    const c = await ask(agent, 'realestate.offers.compare', { dealId: listing });
    expect(c.shared.comparisonId).toBe(shared.comparisonId);
    expect(c.choices).toEqual([
      expect.objectContaining({
        offerId: chen,
        name: 'Maria',
        choice: 'accept',
        words: 'Cash and the 20th works for us.',
      }),
    ]);
    // It's an instruction to her agent: the offer is still waiting on our answer.
    expect(c.rows.find((r: Any) => r.offerId === chen).status).toBe('waiting_us');
    const [line] = await rows<{ what: string; after: Any }>(
      admin(),
      sql`select what, after from addon_realestate.deal_history
          where deal_record_id = ${listing} and what = 'seller_chose'`,
    );
    expect(line!.after).toMatchObject({ name: 'Maria', choice: 'accept', number: 1 });
    const [event] = await rows<{ payload: Any }>(
      admin(),
      sql`select payload from app.events
          where workspace_id = ${ws} and event_type = 'realestate.offers.seller_chose'`,
    );
    expect(event!.payload).toMatchObject({
      offerId: chen,
      choice: 'accept',
      ownerUserId: agent.id,
    });
  });

  it('withdrawn by the buyers leaves the listing on the market; accepted puts it under contract, as proof for S-48', async () => {
    const out = await run(agent, 'realestate.offer.withdraw', {
      offerId: patel,
      reason: 'They bought another home.',
    });
    expect(out.dealStage).toBeNull();
    const stage = (await dealNow()).stage;
    const accepted = await run(agent, 'realestate.offer.record_response', {
      offerId: chen,
      outcome: 'accepted',
    });
    expect(stage).not.toBe('under_contract');
    expect(accepted.dealStage).toBe('under_contract');
    expect(accepted.termsEntered).toBeGreaterThan(0);
    expect((await evidence('offer', chen)).map((e) => e.key)).toContain('S-48');
    const mariaOnPhone = await mariaSignsIn();
    const [cmp] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.offer_comparisons where deal_record_id = ${listing}`,
    );
    expect(
      await refused(
        executeCommand(
          worker(),
          op('commands', 'realestate.portal.offer_choice') as CommandDef,
          { workspaceId: ws, comparisonId: cmp!.id, offerId: patel, choice: 'counter' },
          mariaOnPhone,
          meta('portal'),
        ),
      ),
    ).toBe('realestate_offer_ended');
  });
});

// ---------- the CMA, the inspection and the buyer's loan on a listing (step 9) ----------

describe('the CMA, the inspection and the buyer’s loan on a listing', () => {
  const proofOn = (key: string, deal = listing) =>
    rows<{ kind: string; body: string | null }>(
      admin(),
      sql`select e.kind, e.body from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where d.deal_record_id = ${deal} and d.duty_key = ${key} order by e.added_at`,
    );

  it('a CMA is for the listing’s own home, with its confirmed facts', async () => {
    const { cmaId } = await run(agent, 'realestate.cma.start', { dealId: listing });
    const { cma } = await ask(agent, 'realestate.cma', { cmaId });
    expect(cma.subject).toMatchObject({
      address: '2207 Juniper Trail, Austin, TX 78745',
      beds: 4,
      baths: 3,
      sqft: 2340,
      yearBuilt: 2004,
    });
    expect(cma.homeId).toBeNull();
    expect(
      await refused(run(agent, 'realestate.cma.start', { dealId: listing, homeId: randomUUID() })),
    ).toBe('realestate_cma_listing_home');
    expect(await refused(run(agent, 'realestate.cma.start', { dealId: buyerDeal }))).toBe(
      'validation',
    );
  });

  it('a seller’s CMA is proof for S-06 once final, and for S-07 once shared', async () => {
    const okafor = (
      await run(agent, 'realestate.deal.open', {
        side: 'listing',
        name: 'Okafor listing',
        stage: 'consultation',
        newPropertyAddress: '88 Bluebonnet Ln, Austin, TX 78704',
      })
    ).dealId;
    const { cmaId } = await run(agent, 'realestate.cma.start', { dealId: okafor });
    await run(agent, 'realestate.cma.set_subject', {
      cmaId,
      beds: 3,
      baths: 2,
      sqft: 1800,
      listPriceCents: null,
      yearBuilt: 1998,
    });
    for (const c of [
      { address: '90 Bluebonnet Ln', priceCents: 61_000_000, soldOn: '2026-09-10', sqft: 1750 },
      { address: '12 Primrose St', priceCents: 63_500_000, soldOn: '2026-08-28', sqft: 1900 },
    ])
      await run(agent, 'realestate.cma.add_comp', {
        cmaId,
        beds: 3,
        baths: 2,
        distanceMiles: 0.3,
        ...c,
      });
    await run(agent, 'realestate.cma.finalize', { cmaId });
    expect((await proofOn('S-06', okafor)).map((e) => e.kind)).toEqual(['record']);
    await run(agent, 'realestate.cma.save_summary', {
      cmaId,
      summary: 'Two nearby sales put 88 Bluebonnet between $610,000 and $635,000.',
    });
    const { cma } = await ask(agent, 'realestate.cma', { cmaId });
    await system('realestate.cma.summary_checked', {
      cmaId,
      textHash: textHashOf(null, cma.summary.text),
      version: 'test-model',
      status: 'passed',
      flags: [],
    });
    await run(agent, 'realestate.cma.share', { cmaId });
    const s07 = await proofOn('S-07', okafor);
    expect(s07).toHaveLength(1);
    expect(s07[0]!.body).toMatch(/^CMA 1 shared with the seller: \$/);
  });

  it('the buyer’s inspection at the home is S-52’s appointment', async () => {
    const [entry] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.term_entries
          where deal_record_id = ${listing} and key = 'inspection_end' and confirmed_at is null`,
    );
    await run(agent, 'realestate.term.confirm', { dealId: listing, entryId: entry!.id });
    await run(agent, 'realestate.inspection.add', {
      dealId: listing,
      kind: 'general',
      inspector: 'Lone Star Inspections',
      scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    const s52 = await proofOn('S-52');
    expect(s52.map((e) => e.kind)).toEqual(['appointment']);
    expect(s52[0]!.body).toMatch(/with Lone Star Inspections$/);
  });

  it('the buyers ask for repairs and the seller answers: S-53 and S-54, and agreed brings S-55', async () => {
    expect(
      await refused(run(agent, 'realestate.repair.send', { dealId: listing, words: 'Fix it.' })),
    ).toBe('realestate_repair_listing');
    expect(
      await refused(
        run(agent, 'realestate.repair.record_answer', {
          dealId: listing,
          outcome: 'agreed',
          words: 'We’ll fix it.',
        }),
      ),
    ).toBe('realestate_no_repair_request');
    const asked = await run(agent, 'realestate.repair.receive', {
      dealId: listing,
      words: 'Replace the water heater and service the HVAC, or a $2,500 credit.',
      creditCents: 250_000,
      respondBy: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    expect(asked.dutiesCreated).toBeGreaterThan(0);
    expect((await proofOn('S-53')).map((e) => e.body)).toEqual([
      'Replace the water heater and service the HVAC, or a $2,500 credit.',
    ]);
    expect(
      await refused(run(agent, 'realestate.repair.receive', { dealId: buyerDeal, words: 'x' })),
    ).toBe('realestate_listing_only');
    const answered = await run(agent, 'realestate.repair.record_answer', {
      dealId: listing,
      outcome: 'agreed',
      words: 'The sellers will give a $2,000 credit at closing.',
      creditCents: 200_000,
    });
    expect(answered.dutiesCreated).toBeGreaterThan(0);
    expect((await proofOn('S-54')).map((e) => e.body)).toEqual([
      'Our answer: The sellers will give a $2,000 credit at closing.',
    ]);
    const [s55] = await rows<{ status: string }>(
      admin(),
      sql`select status from addon_realestate.duties where deal_record_id = ${listing} and duty_key = 'S-55'`,
    );
    expect(s55).toBeTruthy();
    const { repairs } = await ask(agent, 'realestate.inspections', { dealId: listing });
    expect(repairs.map((r: Any) => [r.side, r.outcome, r.creditCents])).toEqual([
      ['them', null, 250_000],
      ['us', 'agreed', 200_000],
    ]);
  });

  it('the buyer’s loan is tracked on the listing, as proof for S-61, without the buyer’s own dates', async () => {
    const [d] = await rows<{ facts: string[] }>(
      admin(),
      sql`select facts from addon_realestate.deals where record_id = ${listing}`,
    );
    await run(agent, 'realestate.deal.set_facts', {
      dealId: listing,
      facts: [...d!.facts, 'financed'],
    });
    await run(agent, 'realestate.term.enter', {
      dealId: listing,
      key: 'financing_end',
      date: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
    });
    await run(agent, 'realestate.financing.set_lender', {
      dealId: listing,
      lenderName: 'Summit Lending',
      officerName: 'Jo Park',
    });
    const pre = await run(agent, 'realestate.financing.mark_done', {
      dealId: listing,
      step: 'preapproval',
      proof: { kind: 'file', id: await upload('chen-preapproval.pdf', 'application/pdf') },
      expiresOn: '2026-12-31',
    });
    // A buyer's preapproval end is the buyer deal's date, not the listing's.
    expect(pre.termsEntered).toBe(0);
    await run(agent, 'realestate.financing.mark_done', {
      dealId: listing,
      step: 'conditional_approval',
      proof: { kind: 'file', id: await upload('approval-letter.pdf', 'application/pdf') },
    });
    expect((await proofOn('S-61')).map((e) => e.body)).toEqual([
      'Conditional approval: approval-letter.pdf',
    ]);
  });
});

// ---------- the seller's portal (step 12) ----------

describe('the seller’s portal', () => {
  const asMaria = async (
    name: string,
    input: Record<string, unknown>,
    kind: 'query' | 'command',
  ) => {
    const who = await mariaSignsIn();
    return kind === 'query'
      ? executeQuery(
          worker(),
          op('queries', name) as QueryDef,
          { workspaceId: ws, ...input },
          who,
          meta('portal'),
        )
      : executeCommand(
          worker(),
          op('commands', name) as CommandDef,
          { workspaceId: ws, ...input },
          who,
          meta('portal'),
        ).then((r) => r.output);
  };

  it('shows her listing: its price and the changes she was asked, its facts, signed words and the offers she saw', async () => {
    const mine = (await asMaria('realestate.portal.listing', { dealId: listing }, 'query')) as Any;
    expect(mine).toMatchObject({
      address: '2207 Juniper Trail, Austin, TX 78745',
      street: '2207 Juniper Trail',
      priceCents: 47_900_000,
      mls: { number: expect.any(String) },
      facts: { beds: 4, baths: 3, sqft: 2340 },
      description: { words: expect.stringContaining('2207 Juniper Trail') },
      questionnaire: { state: 'submitted' },
    });
    expect(mine.priceChanges.map((p: Any) => [p.toCents, p.state])).toEqual([
      [46_900_000, 'withdrawn'],
      [47_900_000, 'applied'],
      [48_900_000, 'applied'],
    ]);
    // Its page, up again (it says under contract now).
    expect(mine.pagePath).toMatch(/^\/a\/[a-z0-9-]+\/realestate\/2207-juniper-trail$/);
    expect(mine.comparison.rows.map((r: Any) => r.buyers)).toEqual([
      'Wei and Lin Chen',
      'Priya Patel',
    ]);
    expect(mine.comparison.note).toMatch(/^An estimate/);
    expect(mine.comparison.myChoices).toEqual([
      expect.objectContaining({ choice: 'accept', words: 'Cash and the 20th works for us.' }),
    ]);
    // A buyer deal isn't a listing.
    expect(
      await refused(asMaria('realestate.portal.listing', { dealId: buyerDeal }, 'query')),
    ).toBe('not_found');
  });

  it('takes her answers about the home as she goes, then sends them once, which finishes the task', async () => {
    const condo = (
      await run(agent, 'realestate.deal.open', {
        side: 'listing',
        name: 'Alvarez condo',
        stage: 'signed',
        clientPersonId: maria,
        newPropertyAddress: '600 Congress Ave #12, Austin, TX 78701',
      })
    ).dealId;
    expect(
      await refused(
        asMaria(
          'realestate.portal.questionnaire.save',
          { dealId: condo, facts: { beds: 2 } },
          'command',
        ),
      ),
    ).toBe('realestate_questionnaire_not_asked');
    const { taskId } = await run(agent, 'realestate.listing.request_questionnaire', {
      dealId: condo,
    });
    expect(
      await refused(
        asMaria('realestate.portal.questionnaire.submit', { dealId: condo }, 'command'),
      ),
    ).toBe('realestate_questionnaire_empty');
    await asMaria(
      'realestate.portal.questionnaire.save',
      { dealId: condo, facts: { beds: 2, baths: 2 }, updates: 'New floors in 2023.' },
      'command',
    );
    const saved = (await asMaria(
      'realestate.portal.questionnaire.save',
      { dealId: condo, facts: { sqft: 1150 }, loves: 'The view of the Capitol.' },
      'command',
    )) as Any;
    expect(saved.state).toBe('draft');
    const sent = (await asMaria(
      'realestate.portal.questionnaire.submit',
      { dealId: condo },
      'command',
    )) as Any;
    expect(sent.state).toBe('submitted');
    expect(
      await refused(
        asMaria(
          'realestate.portal.questionnaire.save',
          { dealId: condo, loves: 'More.' },
          'command',
        ),
      ),
    ).toBe('realestate_questionnaire_sent');
    const [task] = await rows<{ status: string }>(
      admin(),
      sql`select status from addon_realestate.client_tasks where id = ${taskId}`,
    );
    expect(task!.status).toBe('done');
    // Her agent reads them beside the old listing's, to confirm.
    const { listing: l } = await ask(agent, 'realestate.listing', { dealId: condo });
    expect(l.questionnaire).toMatchObject({
      state: 'submitted',
      updates: 'New floors in 2023.',
      loves: 'The view of the Capitol.',
    });
    expect(
      l.choices
        .filter((c: Any) => c.candidates.length)
        .map((c: Any) => [c.key, c.candidates[0].value]),
    ).toEqual([
      ['beds', 2],
      ['baths', 2],
      ['sqft', 1150],
    ]);
  });
});
