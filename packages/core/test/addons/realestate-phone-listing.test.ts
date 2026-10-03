/**
 * Real Estate's listing pages on the phone (round six): the listing, its price changes, its marketing and flyer, its
 * open houses and showings, and our listings suggested to a buyer, each worked out from the phone's copy
 * (views/listing.ts, views/showings.ts, views/suggestions.ts) and held to what the server's query answers. Whoever is
 * on the deal holds it whole; an owner who sees every deal keeps another agent's as its summary, so these wait for
 * signal there. What the server keeps to itself (the pasted words' facts, the fair housing checks, the lockbox code,
 * who may let a change through) is left out of both sides of each comparison.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWords, FAIR_HOUSING_WORDS_VERSION } from '../../src/addons/realestate/fair-housing';
import { textHashOf } from '../../src/addons/realestate/ops/client-updates';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  firstNamesOf,
  listingFlyerOfCopy,
  listingMarketingOfCopy,
  listingOfCopy,
  listingPricesOfCopy,
} from '../../src/addons/realestate/views/listing';
import { openHousesOfCopy, showingListOfCopy } from '../../src/addons/realestate/views/showings';
import { suggestionsOfCopy } from '../../src/addons/realestate/views/suggestions';
import type { RealestateCopy } from '../../src/addons/realestate/views/synced';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  localDateOf,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  scheduleSet,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type PublicActor,
  type QueryDef,
  type RequestMeta,
} from '../../src/server';
import { makeCalendar, type Team } from '../calendar-helpers';
import { realestateBusiness } from './realestate-fixture';
import { phoneCopy, phoneRows } from './realestate-phone-fixture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
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
const op = (name: string) => {
  const found = [
    ...(realestateAddonServer.commands ?? []),
    ...(realestateAddonServer.queries ?? []),
  ].find((x) => x.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};
const as = (actor: Any, db: Any, name: string, input: Record<string, unknown>, channel?: Any) => {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        db,
        found as CommandDef,
        { workspaceId: ws, ...input },
        actor,
        meta(channel),
      ).then((r) => r.output as Any)
    : (executeQuery(
        db,
        found as QueryDef,
        { workspaceId: ws, ...input },
        actor,
        meta(channel),
      ) as Promise<Any>);
};
const run = (name: string, input: Record<string, unknown>, who: TestUser = agent) =>
  as(human(who), api(), name, input);
const ask = (name: string, input: Record<string, unknown>, who: TestUser = agent) =>
  as(human(who), api(), name, input);
const system = (name: string, input: Record<string, unknown>) =>
  as({ type: 'system', workspaceId: ws, organizationId: org }, worker(), name, input, 'worker');
const visitor = (): PublicActor => ({
  type: 'public',
  workspaceId: ws,
  organizationId: org,
  site,
  visitor: 'hmac',
});
const asVisitor = (name: string, input: Record<string, unknown>) =>
  as(visitor(), worker(), name, input, 'booking_page');
/** The server's refusal: its rule and its words. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { rule?: string; message: string }) => ({ rule: e.rule, words: e.message }),
  );

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let site: string;
let tz: string;
let today: string;
let maria: CustomerActor;
/** The agent's listings: Alvarez has everything; Chen is live with no signed description; Bare has no home. */
let alvarez: string;
let chen: string;
let bare: string;
/** The agent's buyer, with a home and our listings suggested to them. */
let nguyen: string;
/** The owner's own listing. */
let owens: string;

/** A customer signed in to their portal, as the worker signs them in. */
async function signIn(personId: string): Promise<CustomerActor> {
  const sys = { type: 'system' as const, workspaceId: ws, organizationId: org };
  const { accessId } = (
    await executeCommand(
      api(),
      portalAccessGive,
      { workspaceId: ws, personId },
      human(agent),
      meta(),
    )
  ).output;
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
    personId,
    sessionId: hit.sessionId!,
  };
}
const asSeller = (name: string, input: Record<string, unknown>) =>
  as(maria, worker(), name, input, 'portal');

/** A photo uploaded to the deal's files, as the files screen leaves it. */
async function photo(dealId: string, name: string, who: TestUser): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType: 'image/jpeg',
      sizeBytes: 4096,
    },
    human(who),
    meta(),
  );
  await asUser(api(), who.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId as string;
}

/** A listing live on the MLS with its facts and list price, as matching needs it. */
async function liveListing(name: string, address: string, cents: number, beds: number) {
  const dealId = (
    await run('realestate.deal.open', {
      side: 'listing',
      name,
      stage: 'active',
      newPropertyAddress: address,
    })
  ).dealId as string;
  await run('realestate.listing.confirm_facts', {
    dealId,
    facts: { beds, baths: 2, sqft: 1800 },
    sources: {},
  });
  await run('realestate.term.enter', { dealId, key: 'list_price', cents, source: 'agreement' });
  await run('realestate.listing.mark_live', {
    dealId,
    mlsNumber: String(4_000_000 + Math.floor(Math.random() * 999_999)),
    liveOn: today,
  });
  return dealId;
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rpl-owner', { fullName: 'Rosa Owens' }),
    createTestUser('rpl-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Phone Listing Realty');
  const [w] = await rows<{ org: string; tz: string }>(
    admin(),
    sql`select organization_id as org, timezone as tz from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  tz = w!.tz;
  today = localDateOf(Date.now(), tz);
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const person = async (firstName: string, lastName: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        {
          workspaceId: ws,
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        },
        human(agent),
        meta(),
      )
    ).output.personId as string;
  const mariaId = await person('Maria', 'Alvarez');

  // ---------- Alvarez: the whole listing ----------
  alvarez = (
    await run('realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'pre_listing',
      clientPersonId: mariaId,
      newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
    })
  ).dealId;
  maria = await signIn(mariaId);
  // The seller's questionnaire, asked for and sent from her portal.
  await run('realestate.listing.request_questionnaire', { dealId: alvarez });
  await asSeller('realestate.portal.questionnaire.save', {
    dealId: alvarez,
    facts: { beds: 4, sqft: 2400, hoa_monthly_cents: 4500 },
    updates: 'New kitchen in 2021. Roof 2019.',
    loves: 'The patio under the oaks.',
  });
  await asSeller('realestate.portal.questionnaire.submit', { dealId: alvarez });
  // The old listing's words, read by the worker; then the facts confirmed by the agent.
  await run('realestate.listing.paste', {
    dealId: alvarez,
    text: 'Light-filled 4 bed, 3 bath home with 2,340 sq ft of living space. Built in 2004.',
  });
  await system('realestate.listing.fill_facts', {
    dealId: alvarez,
    facts: { beds: 4, baths: 3, sqft: 2340, year_built: 2004 },
    sources: { sqft: '2,340 sq ft of living space', year_built: 'Built in 2004' },
  });
  await run('realestate.listing.confirm_facts', {
    dealId: alvarez,
    facts: { beds: 4, baths: 3, sqft: 2340, year_built: 2004, hoa_monthly_cents: 4500 },
    sources: { beds: 'seller', baths: 'pasted', sqft: 'pasted', hoa_monthly_cents: 'seller' },
    highlights: 'Kitchen redone in 2021 with quartz and a gas range.',
  });
  // Photos: three, put in order, one kept for the agent and the seller.
  for (const name of ['front.jpg', 'kitchen.jpg', 'yard.jpg'])
    await run('realestate.listing.photo_add', {
      dealId: alvarez,
      fileId: await photo(alvarez, name, agent),
    });
  const { listing: before } = await ask('realestate.listing', { dealId: alvarez });
  const ids = Object.fromEntries(
    (before.photos as { name: string; id: string }[]).map((p) => [p.name, p.id]),
  );
  await run('realestate.listing.photos_arrange', {
    dealId: alvarez,
    photos: [
      { id: ids['kitchen.jpg'], caption: 'The 2021 kitchen', public: true },
      { id: ids['front.jpg'], caption: null, public: true },
      { id: ids['yard.jpg'], caption: null, public: false },
    ],
  });
  // The description: the agent's words, signed off by Maria in her portal; then an AI draft, flagged and kept.
  const words =
    'Welcome to 2207 Juniper Trail. It has 4 bedrooms, 3 bathrooms and 2,340 square feet. Room to spread out, with the patio under the oaks.';
  const saved = await run('realestate.listing.description.save', { dealId: alvarez, words });
  await system('realestate.listing.description.checked', {
    descriptionId: saved.descriptionId,
    textHash: textHashOf(null, words),
    version: 'stand-in',
    status: 'passed',
    flags: [],
  });
  await run('realestate.listing.description.send', { descriptionId: saved.descriptionId });
  const [signOff] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.client_tasks where ref_id = ${saved.descriptionId}`,
  );
  await asSeller('realestate.portal.task.complete', { taskId: signOff!.id, signedWords: words });
  const draft = await run('realestate.listing.description.request', { dealId: alvarez });
  const flagged = words.replace('Room to spread out', 'Perfect for a growing family');
  await system('realestate.listing.description.drafted', {
    descriptionId: draft.descriptionId,
    words: flagged,
    model: 'stand-in',
    checks: [
      {
        source: 'words',
        version: FAIR_HOUSING_WORDS_VERSION,
        status: 'flagged',
        flags: checkWords(flagged),
      },
      { source: 'model', version: 'stand-in', status: 'passed', flags: [] },
    ],
  });
  await run('realestate.listing.description.acknowledge_flags', {
    descriptionId: draft.descriptionId,
    reason: 'It describes the space, not who should live there.',
  });
  // Its price: entered, then changed twice (signed in the portal, let through) and a third change waiting.
  await run('realestate.term.enter', {
    dealId: alvarez,
    key: 'list_price',
    cents: 49_900_000,
    source: 'agreement',
  });
  const first = await run('realestate.listing.price.propose', {
    dealId: alvarez,
    priceCents: 48_900_000,
    note: 'Two weeks, no offers.',
  });
  const [asking] = await rows<{ words: string }>(
    admin(),
    sql`select words from addon_realestate.listing_prices where id = ${first.priceId}`,
  );
  await asSeller('realestate.portal.task.complete', {
    taskId: first.taskId,
    signedWords: asking!.words,
  });
  const second = await run('realestate.listing.price.propose', {
    dealId: alvarez,
    priceCents: 47_900_000,
  });
  await run(
    'realestate.listing.price.let_through',
    { priceId: second.priceId, reason: 'Maria signed the change on paper.' },
    owner,
  );
  await run('realestate.listing.price.propose', { dealId: alvarez, priceCents: 47_500_000 });
  // Live on the MLS, its page up (the first page gives the business its public name), and what the MLS says.
  await run('realestate.listing.mark_live', {
    dealId: alvarez,
    mlsNumber: '4821937',
    liveOn: today,
  });
  site = (await run('realestate.listing.page_publish', { dealId: alvarez }, owner)).site;
  const snapshot = {
    provider: 'standin',
    mls: { id: 'unlock', name: 'Unlock MLS' },
    listingKey: 'st-4821937',
    mlsNumber: '4821937',
    status: 'active',
    standardStatus: 'Active',
    address: {
      line: '2207 Juniper Trail',
      unit: null,
      city: 'Austin',
      state: 'TX',
      zip: '78745',
      hidden: false,
    },
    lat: null,
    lng: null,
    facts: { beds: 4, baths: 3, sqft: 2300 },
    listPriceCents: 49_900_000,
    originalPriceCents: 49_900_000,
    soldPriceCents: null,
    listedOn: today,
    soldOn: null,
    daysOnMarket: 3,
    description: 'Light-filled home under the oaks.',
    photos: [],
    listAgent: 'Dana Reyes',
    listOffice: 'Phone Listing Realty',
    updatedAt: null,
    display: { notice: null, logoUrl: null, courtesy: 'Listing courtesy of Phone Listing Realty.' },
    checkedAt: new Date().toISOString(),
  };
  await rows(
    admin(),
    sql`update addon_realestate.listings set mls = ${JSON.stringify(snapshot)}::jsonb, mls_state = 'found',
          mls_checked_at = now()
        where deal_record_id = ${alvarez}`,
  );
  // Social posts: three drafts, one edited.
  await run('realestate.listing.posts_request', { dealId: alvarez });
  await system('realestate.listing.posts_drafted', {
    dealId: alvarez,
    batch: 1,
    model: 'stand-in',
    posts: [
      'Just listed: 2207 Juniper Trail.',
      'Four bedrooms and a 2021 kitchen.',
      'Open house Sunday.',
    ].map((w) => ({
      words: w,
      checks: [
        { source: 'words', version: FAIR_HOUSING_WORDS_VERSION, status: 'passed', flags: [] },
        { source: 'model', version: 'stand-in', status: 'passed', flags: [] },
      ],
    })),
  });
  const { posts } = await ask('realestate.listing.marketing', { dealId: alvarez });
  await run('realestate.listing.post_save', {
    postId: posts.items[2].id,
    words: 'Open house Sunday, 1 to 4.',
  });
  // Open houses: one about to start with two visitors signed in (one followed up), one planned and cancelled.
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
  await makeCalendar(
    { owner, wsId: ws, scope: { workspaceId: ws, organizationId: org } } as unknown as Team,
    'Showings',
    { team: { members: [{ userId: agent.id }] } },
  );
  const quarter = 15 * 60_000;
  const soon = Math.ceil((Date.now() + 30 * 60_000) / quarter) * quarter;
  const open = (
    await run('realestate.open_house.plan', {
      dealId: alvarez,
      startsAt: new Date(soon).toISOString(),
      durationMinutes: 120,
      acknowledgeWarnings: true,
    })
  ).openHouseId;
  await asVisitor('realestate.public.open_house.sign_in', {
    slug: '2207-juniper-trail',
    openHouseId: open,
    firstName: 'Kayla',
    lastName: 'Brooks',
    phone: '+15125550187',
    smsConsent: true,
  });
  await asVisitor('realestate.public.open_house.sign_in', {
    slug: '2207-juniper-trail',
    openHouseId: open,
    firstName: 'Sofia',
    email: 'sofia.r@example.com',
    withAgent: true,
    agentName: 'Kim Ortiz, Oakwood Realty',
  });
  const { openHouses } = await ask('realestate.open_houses', { dealId: alvarez });
  await run('realestate.open_house.follow_up', {
    visitorId: openHouses[0].visitors[0].id,
    note: 'Called; she’ll come back Saturday.',
  });
  const later = (
    await run('realestate.open_house.plan', {
      dealId: alvarez,
      startsAt: new Date(soon + 3 * 86_400_000).toISOString(),
      durationMinutes: 120,
      acknowledgeWarnings: true,
    })
  ).openHouseId;
  await run('realestate.open_house.cancel', { openHouseId: later, reason: 'Rain' });
  // Showings: open all day, with how to get in; one added by hand ahead, one past with feedback shared, two asked
  // for on the page (one turned down), and one from ShowingTime's emails with its feedback, still to check.
  await run('realestate.showing.settings', {
    dealId: alvarez,
    from: '00:00',
    to: '23:30',
    days: [0, 1, 2, 3, 4, 5, 6],
    access: 'Lockbox on the back door, code 4417.',
  });
  await run('realestate.showing.add', {
    dealId: alvarez,
    startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    agentName: 'Lee Park',
    brokerage: 'eXp',
    agentPhone: '(512) 555-0101',
  });
  const past = await run('realestate.showing.add', {
    dealId: alvarez,
    startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    agentName: 'Jo Kim',
    agentEmail: 'jo@kw.example',
  });
  await run('realestate.showing.feedback', {
    showingId: past.showingId,
    interest: 4,
    liked: 'Loved the patio and the big oaks.',
    pause: 'Kitchen felt small for the price.',
    price: 'high',
  });
  await run('realestate.showing.share_feedback', { showingId: past.showingId });
  const { times } = await asVisitor('realestate.public.showing_times', {
    slug: '2207-juniper-trail',
  });
  const agentAsks = (name: string, email: string, startsAt: string) =>
    asVisitor('realestate.public.request_showing', {
      slug: '2207-juniper-trail',
      agentName: name,
      brokerage: 'Compass',
      license: '0712345',
      email,
      phone: '(512) 555-0177',
      startsAt,
    });
  await agentAsks('Ana Ruiz', 'ana@compass.example', times[4]);
  await agentAsks('Sam Ortiz', 'sam@compass.example', times[8]);
  const asked = (await ask('realestate.showing.list', { dealId: alvarez })).showings.find(
    (s: { agentName: string }) => s.agentName === 'Sam Ortiz',
  );
  await run('realestate.showing.decide', {
    showingId: asked.id,
    decision: 'decline',
    note: 'The seller is away that day.',
  });
  const st = `st-${randomUUID()}`;
  await system('realestate.showing.from_email', {
    dealId: alvarez,
    externalId: st,
    kind: 'requested',
    startsAt: new Date(Date.now() - 86_400_000).toISOString(),
    agentName: 'Pat Lin',
    brokerage: 'KW',
  });
  await system('realestate.showing.from_email', {
    dealId: alvarez,
    externalId: st,
    kind: 'confirmed',
  });
  await system('realestate.showing.from_email', {
    dealId: alvarez,
    externalId: st,
    kind: 'feedback',
    feedback: { interest: 2, liked: null, pause: 'Price high for the area.', price: 'high' },
  });
  await system('realestate.showing.themes_saved', {
    dealId: alvarez,
    themes: {
      liked: [
        { theme: 'The patio and the oaks', count: 1, quotes: ['the patio and the big oaks'] },
      ],
      disliked: [{ theme: 'The price', count: 2, quotes: ['Price high for the area'] }],
    },
  });

  // ---------- the other listings, and a buyer they're suggested to ----------
  chen = await liveListing('Chen listing', '418 Maple Ave, Austin, TX 78704', 45_000_000, 3);
  await run('realestate.listing.request_questionnaire', { dealId: chen });
  await run('realestate.listing.description.request', { dealId: chen });
  const park = await liveListing('Park listing', '9 Elm St, Austin, TX 78702', 46_000_000, 3);
  const diaz = await liveListing('Diaz listing', '77 Oak Ln, Austin, TX 78703', 44_000_000, 3);
  bare = (await run('realestate.deal.open', { side: 'listing', name: 'Bare listing' })).dealId;
  nguyen = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      newPropertyAddress: '12 Cedar Bend, Austin, TX 78750',
    })
  ).dealId;
  await run('realestate.buyer_profile.save', {
    dealId: nguyen,
    profile: {
      budgetMaxCents: 50_000_000,
      areas: ['Austin'],
      bedsMin: 3,
      mustHaves: [],
      dealBreakers: [],
    },
  });
  await system('realestate.match.run', { buyerDealId: nguyen });
  const { suggestions } = await ask('realestate.suggestions', { dealId: nguyen });
  const by = (dealAddress: string) =>
    suggestions.find((s: { address: string }) => s.address === dealAddress).id;
  await run('realestate.suggestion.add', {
    suggestionId: by('2207 Juniper Trail, Austin, TX 78745'),
  });
  await run('realestate.suggestion.not_a_fit', {
    suggestionId: by('418 Maple Ave, Austin, TX 78704'),
    reason: 'They want a newer home.',
  });
  // Off the market: its suggestion is gone.
  await run('realestate.deal.end', {
    dealId: diaz,
    how: 'withdrawn',
    reason: 'The sellers are staying.',
  });
  await system('realestate.match.run', { listingDealId: diaz });
  // The worker counts again once one is decided.
  await system('realestate.match.run', { listingDealId: alvarez });
  expect(park).toBeTruthy();

  // ---------- the owner's own listing ----------
  owens = (
    await run(
      'realestate.deal.open',
      { side: 'listing', name: 'Owens listing', newPropertyAddress: '5 Pine Ct, Austin, TX 78731' },
      owner,
    )
  ).dealId;
  await run(
    'realestate.listing.confirm_facts',
    { dealId: owens, facts: { beds: 2, baths: 1 }, sources: {} },
    owner,
  );
  await run(
    'realestate.term.enter',
    { dealId: owens, key: 'list_price', cents: 39_000_000, source: 'agreement' },
    owner,
  );
  await run(
    'realestate.showing.add',
    {
      dealId: owens,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      agentName: 'Ana Ruiz',
    },
    owner,
  );
}, 300_000);
afterAll(closeTestDbs);

/** The server's listing without what only the server works out (views/listing.ts says why). */
function withoutServerOnly(listing: Any) {
  const {
    choices: _choices,
    can: _can,
    pasted: { found: _found, ...pasted },
    description: { working, ...description },
    ...rest
  } = listing;
  const kept = working
    ? (({ flags: _f, checked: _c, blocked: _b, ...w }) => w)(working as Any)
    : null;
  return { ...rest, pasted, description: { ...description, working: kept } };
}
const marketingWithoutChecks = (m: Any) => ({
  ...m,
  posts: {
    ...m.posts,
    items: m.posts.items.map(({ flags: _f, checked: _c, ...p }: Any) => p),
  },
});
const withoutAccess = (s: Any) => {
  const { access: _a, ...settings } = s.settings;
  return { ...s, settings };
};

/** The phone's copy for `u`, and the first names it keeps. */
async function phoneOf(u: TestUser): Promise<{
  copy: RealestateCopy;
  firstName: (personId: string) => string | null;
}> {
  return { copy: await phoneCopy(u, ws), firstName: firstNamesOf(await phoneRows(u, ws)) };
}

/** Every listing page from the phone, as the server answers it, for one deal and one person who holds it whole. */
async function sameAsServer(u: TestUser, dealId: string) {
  const { copy, firstName } = await phoneOf(u);
  const label = `${u.email} ${dealId}`;
  const ctx = { userId: u.id };
  expect(listingOfCopy(copy, dealId, ctx), label).toEqual(
    withoutServerOnly((await ask('realestate.listing', { dealId }, u)).listing),
  );
  expect(listingPricesOfCopy(copy, dealId, { ...ctx, firstName }), label).toEqual(
    await ask('realestate.listing.prices', { dealId }, u),
  );
  expect(listingMarketingOfCopy(copy, dealId, ctx), label).toEqual(
    marketingWithoutChecks(await ask('realestate.listing.marketing', { dealId }, u)),
  );
  const flyer = listingFlyerOfCopy(copy, dealId, ctx);
  const refused = await refusal(ask('realestate.listing.flyer', { dealId }, u));
  if (refused) expect(flyer, label).toEqual({ flyer: null, refused });
  else
    expect(flyer, label).toEqual({
      flyer: await ask('realestate.listing.flyer', { dealId }, u),
      refused: null,
    });
  expect(openHousesOfCopy(copy, dealId, ctx), label).toEqual(
    await ask('realestate.open_houses', { dealId }, u),
  );
  const now = Date.now();
  expect(showingListOfCopy(copy, dealId, { ...ctx, now, timeZone: tz, firstName }), label).toEqual(
    withoutAccess(await ask('realestate.showing.list', { dealId }, u)),
  );
}

describe('a listing on the phone', () => {
  it('answers what the server answers, page by page, for the deal’s agent', async () => {
    for (const dealId of [alvarez, chen, bare]) await sameAsServer(agent, dealId);
  });

  it('answers what the server answers for an owner on their own listing', async () => {
    await sameAsServer(owner, owens);
  });

  it('waits for signal on another agent’s listing, kept as its summary on an owner’s phone', async () => {
    const { copy, firstName } = await phoneOf(owner);
    const ctx = { userId: owner.id };
    // The owner's phone has the deal, but none of its listing's own rows.
    expect(copy.deals.has(alvarez)).toBe(true);
    expect(copy.rows('listings', alvarez)).toEqual([]);
    for (const dealId of [alvarez, chen]) {
      // The server answers with signal.
      expect((await ask('realestate.listing', { dealId }, owner)).listing.dealId).toBe(dealId);
      expect(listingOfCopy(copy, dealId, ctx)).toBeNull();
      expect(listingPricesOfCopy(copy, dealId, { ...ctx, firstName })).toBeNull();
      expect(listingMarketingOfCopy(copy, dealId, ctx)).toBeNull();
      expect(listingFlyerOfCopy(copy, dealId, ctx)).toBeNull();
      expect(openHousesOfCopy(copy, dealId, ctx)).toBeNull();
      expect(
        showingListOfCopy(copy, dealId, { ...ctx, now: Date.now(), timeZone: tz, firstName }),
      ).toBeNull();
    }
  });

  it('isn’t equal by being empty', async () => {
    const { copy, firstName } = await phoneOf(agent);
    const ctx = { userId: agent.id };
    const l = listingOfCopy(copy, alvarez, ctx)!;
    expect(l).toMatchObject({
      street: '2207 Juniper Trail',
      factsConfirmedBy: { id: agent.id, fullName: 'Dana Reyes' },
      highlights: 'Kitchen redone in 2021 with quartz and a gas range.',
      pasted: { state: 'read', failure: null },
      questionnaire: { state: 'submitted', loves: 'The patio under the oaks.' },
      mls: { number: '4821937', liveOn: today },
      page: { state: 'published', slug: '2207-juniper-trail' },
      listPriceCents: 47_900_000,
      feed: { state: 'found', mls: { mlsNumber: '4821937', differs: ['sqft'] } },
    });
    expect(l.feed.differences.map((d) => d.key)).toEqual(['price']);
    expect(l.photos.map((p) => [p.name, p.position, p.caption, p.public])).toEqual([
      ['kitchen.jpg', 0, 'The 2021 kitchen', true],
      ['front.jpg', 1, null, true],
      ['yard.jpg', 2, null, false],
    ]);
    expect(l.description.inUse).toMatchObject({ version: 1, how: 'portal' });
    expect(l.description.working).toMatchObject({
      version: 2,
      source: 'ai',
      state: 'ready',
      acknowledged: { reason: 'It describes the space, not who should live there.' },
    });
    expect(l.matches).toMatchObject({ suggested: 1, added: 1 });
    expect(listingOfCopy(copy, chen, ctx)!.questionnaire.state).toBe('asked');
    expect(listingOfCopy(copy, chen, ctx)!.description.working!.state).toBe('drafting');

    const prices = listingPricesOfCopy(copy, alvarez, { ...ctx, firstName })!;
    expect(prices.currentCents).toBe(47_900_000);
    expect(prices.history.map((p) => [p.toCents, p.state, p.how, p.signedBy])).toEqual([
      [47_500_000, 'waiting', null, null],
      [47_900_000, 'applied', 'let_through', null],
      [48_900_000, 'applied', 'portal', 'Maria'],
    ]);
    expect(prices.showings.words).toBe('3 showings · 2 answered · 2 said the price was high');

    const m = listingMarketingOfCopy(copy, alvarez, ctx)!;
    expect(m).toMatchObject({
      hold: null,
      ready: { facts: true, description: true, photos: 2 },
      posts: { state: 'ready' },
    });
    expect(m.page.path).toBe(`/a/${site}/realestate/2207-juniper-trail`);
    expect(m.posts.items.map((p) => [p.words, p.edited])).toEqual([
      ['Just listed: 2207 Juniper Trail.', false],
      ['Four bedrooms and a 2021 kitchen.', false],
      ['Open house Sunday, 1 to 4.', true],
    ]);
    expect(listingMarketingOfCopy(copy, bare, ctx)!.hold).toBe(
      'Bare listing isn’t live on the MLS yet, so it can’t be shared outside your office. Mark it live under Marketing once it is.',
    );

    const { flyer } = listingFlyerOfCopy(copy, alvarez, ctx)!;
    expect(flyer).toMatchObject({
      street: '2207 Juniper Trail',
      cityLine: 'Austin, TX 78745',
      priceCents: 47_900_000,
      agentName: 'Dana Reyes',
      page: { path: `/a/${site}/realestate/2207-juniper-trail` },
    });
    expect(flyer!.photos.map((p) => p.caption)).toEqual(['The 2021 kitchen', null]);
    expect(listingFlyerOfCopy(copy, chen, ctx)!.refused!.rule).toBe(
      'realestate_description_unsigned',
    );
    expect(listingFlyerOfCopy(copy, bare, ctx)!.refused!.rule).toBe(
      'realestate_listing_no_address',
    );
    // A buyer deal has no listing: never live on the MLS.
    expect(listingFlyerOfCopy(copy, nguyen, ctx)!.refused!.rule).toBe('realestate_not_on_mls');

    const { openHouses } = openHousesOfCopy(copy, alvarez, ctx)!;
    expect(openHouses.map((o) => [o.state, !!o.signInPath, o.visitors.length])).toEqual([
      ['planned', true, 2],
      ['cancelled', false, 0],
    ]);
    expect(
      openHouses[0]!.visitors.map((v) => [v.firstName, v.withAgent, !!v.followedUpAt]),
    ).toEqual([
      ['Kayla', false, true],
      ['Sofia', true, false],
    ]);

    const shows = showingListOfCopy(copy, alvarez, {
      ...ctx,
      now: Date.now(),
      timeZone: tz,
      firstName,
    })!;
    expect(shows.sellerFirstName).toBe('Maria');
    expect(shows.settings).toMatchObject({ from: '00:00', to: '23:30', confirm: 'seller' });
    expect(JSON.stringify(shows)).not.toMatch(/4417/);
    expect(shows.showings.map((s) => [s.agentName, s.stateWords])).toEqual(
      expect.arrayContaining([
        ['Ana Ruiz', 'Waiting on Maria'],
        ['Sam Ortiz', 'Declined'],
        ['Pat Lin', 'Done'],
      ]),
    );
    expect(shows.showings.find((s) => s.agentName === 'Pat Lin')!.can.check).toBe(true);
    expect(shows.themes).toMatchObject({ likedWords: 'The patio and the oaks (1)' });
  });
});

describe('the listings suggested to a buyer on the phone', () => {
  it('answer what the server answers for the buyer’s agent, and wait for signal on an owner’s phone', async () => {
    const server = await ask('realestate.suggestions', { dealId: nguyen });
    const mine = suggestionsOfCopy(await phoneCopy(agent, ws), nguyen, { userId: agent.id });
    expect(mine).toEqual(server);
    expect(mine!.suggestions.map((s) => [s.address, s.state])).toEqual([
      ['9 Elm St, Austin, TX 78702', 'new'],
      ['2207 Juniper Trail, Austin, TX 78745', 'added'],
      ['418 Maple Ave, Austin, TX 78704', 'not_a_fit'],
      ['77 Oak Ln, Austin, TX 78703', 'gone'],
    ]);
    expect(mine!.suggestions[2]).toMatchObject({
      decidedBy: { fullName: 'Dana Reyes' },
      decidedReason: 'They want a newer home.',
    });
    expect((await ask('realestate.suggestions', { dealId: nguyen }, owner)).dealId).toBe(nguyen);
    expect(suggestionsOfCopy(await phoneCopy(owner, ws), nguyen, { userId: owner.id })).toBeNull();
  });

  it('are refused on the other side, and the phone shows none', async () => {
    const copy = await phoneCopy(agent, ws);
    expect((await refusal(ask('realestate.suggestions', { dealId: alvarez })))!.rule).toBe(
      'realestate_buyer_only',
    );
    expect(suggestionsOfCopy(copy, alvarez, { userId: agent.id })).toBeNull();
    expect((await refusal(ask('realestate.listing', { dealId: nguyen })))!.rule).toBe(
      'realestate_listing_only',
    );
    expect(listingOfCopy(copy, nguyen, { userId: agent.id })).toBeNull();
  });
});
