/**
 * Real Estate Agent, round three: the listing (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"). The pure parts first (each fact's sources and whether they agree, a page's address, the MLS words), then on
 * the database: a listing's facts from the seller's questionnaire, the old listing's words and the agent, confirmed by
 * a person only; its photos in order; and a buyer deal refused all of it.
 */
import { randomUUID } from 'node:crypto';
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
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type RequestMeta,
} from '../../src/server';
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
      { workspaceId: ws, firstName: 'Maria', lastName: 'Alvarez' },
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
