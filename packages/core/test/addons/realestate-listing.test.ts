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
  tagCreate,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type PublicActor,
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

/** Maria, signed in to her portal on a device, as the worker signs her in. */
async function mariaSignsIn(): Promise<CustomerActor> {
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
  return {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId: maria,
    sessionId: hit.sessionId!,
  };
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
