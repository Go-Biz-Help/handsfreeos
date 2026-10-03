/**
 * A deal's tours, CMAs and offers on the phone (Real Estate round six): each view over the phone's copy answers what
 * the server's query answers. Built through the add-on's commands, read back as the rows a phone is sent
 * (`realestate-phone-fixture.ts`), and checked for the deal's agent, who holds the deal whole, and for an owner who
 * sees every deal, who holds it only as its summary: there the tours, CMAs and offers wait for signal.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar/index';
import { localDateOf } from '../../src/calendar/engine/zoned';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { cmaOfCopy, cmasOfCopy } from '../../src/addons/realestate/views/cma';
import { offersCompareOfCopy, offersOfCopy } from '../../src/addons/realestate/views/offers';
import { toursOfCopy } from '../../src/addons/realestate/views/tours';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalSendCode,
  scheduleSet,
  type CommandDef,
  type CustomerActor,
  type HumanActor,
  type QueryDef,
  type RequestMeta,
} from '../../src/server';
import { CHI, isoAt, makeCalendar, nextWeekday, WEEKDAYS, type Team } from '../calendar-helpers';
import { phoneCopy } from './realestate-phone-fixture';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (name: string, input: Record<string, unknown>, as: TestUser): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(as),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>, as: TestUser): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(as), meta());

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let today: string;
let timeZone: string;
let maria: string;
let nguyen: string;
let listing: string;
let cmaIds: string[] = [];

/** A file on a deal, ready, as the files screen leaves it. */
async function fileOn(dealId: string, name: string): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    },
    human(agent),
    meta(),
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId as string;
}

const documentOn = async (dealId: string, name: string, kind: string, extra = {}) =>
  (
    await run(
      'realestate.document.add',
      { dealId, fileId: await fileOn(dealId, name), kind, ...extra },
      agent,
    )
  ).documentId as string;

/** Maria in her portal, as the seller who says what she thinks of the offers. */
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

const inDays = (n: number, hours = 0) =>
  new Date(Date.now() + n * 86_400_000 + hours * 3_600_000).toISOString();

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rpo-owner', { fullName: 'Rosa Owens' }),
    createTestUser('rpo-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Phone Offers Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const [w] = await rows<{ org: string; today: string; tz: string }>(
    admin(),
    sql`select organization_id as org, (now() at time zone timezone)::date::text as today, timezone as tz
        from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  today = w!.today;
  timeZone = w!.tz;
  await executeCommand(
    api(),
    scheduleSet,
    { workspaceId: ws, ownerId: agent.id, weekly: WEEKDAYS },
    human(owner),
    meta(),
  );
  const team = {
    owner,
    wsId: ws,
    scope: { workspaceId: ws, organizationId: org },
  } as unknown as Team;
  await makeCalendar(team, 'Showings', { team: { members: [{ userId: agent.id }] } });
  const person = async (firstName: string, lastName: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        {
          workspaceId: ws,
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
        },
        human(agent),
        meta(),
      )
    ).output.personId as string;
  const linh = await person('Linh', 'Nguyen');
  const ann = await person('Ann', 'Smith');
  maria = await person('Maria', 'Alvarez');

  // ---------- a buyer deal: its homes, agreement and tours ----------
  nguyen = (
    await run(
      'realestate.deal.open',
      { side: 'buyer', name: 'Nguyen purchase', clientPersonId: linh },
      agent,
    )
  ).dealId;
  await run('realestate.party.add', { dealId: nguyen, role: 'client', personId: ann }, agent);
  const home = async (address: string) =>
    (await run('realestate.home.add', { dealId: nguyen, address }, agent)).homeId as string;
  const maple = await home('418 Maple Ave, Austin, TX');
  const oak = await home('9 Oak Ln, Austin, TX');
  const pine = await home('77 Pine Ct, Austin, TX');
  const day = nextWeekday(2);
  // Before there's an agreement: the owner lets one through, with a reason.
  await run(
    'realestate.tour.plan',
    {
      dealId: nguyen,
      homeIds: [pine],
      startsAt: isoAt(day, '15:00'),
      agentUserId: agent.id,
      exception: { reason: 'Agreement signed on paper; scanning it tonight' },
      notifyClient: false,
    },
    owner,
  );
  const agreement = await documentOn(nguyen, 'Buyer agreement.pdf', 'buyer_agreement');
  await run('realestate.document.mark_signed', { documentId: agreement }, agent);
  await run(
    'realestate.term.enter',
    { dealId: nguyen, key: 'buyer_agreement_expiry', date: addDays(day, 60) },
    agent,
  );
  await run(
    'realestate.tour.plan',
    {
      dealId: nguyen,
      homeIds: [oak, maple],
      startsAt: isoAt(day, '10:00'),
      note: 'Lockbox on the side door',
      notifyClient: false,
    },
    agent,
  );
  const gone = await run(
    'realestate.tour.plan',
    {
      dealId: nguyen,
      homeIds: [maple],
      startsAt: isoAt(addDays(day, 1), '10:00'),
      notifyClient: false,
    },
    agent,
  );
  await run(
    'realestate.tour.cancel',
    { tourId: gone.tourId, reason: 'The seller took it off the market', notifyClient: false },
    agent,
  );
  // One that already happened: both clients say what they thought.
  const seen = await run(
    'realestate.tour.plan',
    {
      dealId: nguyen,
      homeIds: [maple, oak, pine],
      startsAt: isoAt(addDays(localDateOf(Date.now(), CHI), -1), '10:00'),
      acknowledgeWarnings: true,
      notifyClient: false,
    },
    agent,
  );
  const { tours } = await ask('realestate.tours', { dealId: nguyen }, agent);
  const [first, second, third] = tours.find((t: { id: string }) => t.id === seen.tourId).stops;
  await run(
    'realestate.tour.record_visit',
    { stopId: first.id, status: 'visited', note: 'Roof looks new' },
    agent,
  );
  await run('realestate.tour.record_visit', { stopId: second.id, status: 'visited' }, agent);
  for (const [stopId, personId, interest, words] of [
    [first.id, linh, 'love', 'The kitchen is perfect'],
    [first.id, ann, 'maybe', undefined],
    [second.id, ann, 'no', 'Too far from work'],
  ] as const)
    await run(
      'realestate.tour.feedback',
      { stopId, personId, interest, rating: interest === 'love' ? 5 : null, words },
      agent,
    );
  await run('realestate.tour.record_visit', { stopId: third.id, status: 'skipped' }, agent);

  // ---------- its CMAs ----------
  await admin().execute(
    sql`update addon_realestate.homes set facts = '{"beds": 3, "baths": 2, "sqft": 1780, "price_cents": 40900000}'
        where id = ${maple}`,
  );
  const cma = (await run('realestate.cma.start', { dealId: nguyen, homeId: maple }, agent))
    .cmaId as string;
  const comps: string[] = [];
  for (const c of [
    {
      address: '14 Maple Ave',
      priceCents: 40_200_000,
      soldOn: '2026-08-30',
      sqft: 1720,
      distanceMiles: 0.1,
    },
    {
      address: '301 Oak Hollow',
      priceCents: 41_850_000,
      soldOn: '2026-09-12',
      sqft: 1850,
      baths: 2.5,
      distanceMiles: 0.4,
    },
    {
      address: '5 Linden Pl',
      priceCents: 44_500_000,
      soldOn: '2025-06-03',
      sqft: 2240,
      distanceMiles: 1.8,
    },
    {
      address: '12 Birch Rd',
      priceCents: 42_000_000,
      status: 'pending',
      note: 'Under contract last week',
    },
  ])
    comps.push((await run('realestate.cma.add_comp', { cmaId: cma, beds: 3, ...c }, agent)).compId);
  await run(
    'realestate.cma.update_comp',
    { compId: comps[1], adjustments: [{ label: 'Newer roof', cents: -500_000 }] },
    agent,
  );
  await run('realestate.cma.update_comp', { compId: comps[2], used: false }, agent);
  // One came from the listing feed, with what its MLS asks to be shown with it.
  await admin().execute(
    sql`update addon_realestate.cma_comps set source = 'mls', mls_number = 'ATX-1042',
          mls = '{"provider": "standin", "mls": {"id": "atx", "name": "Austin MLS"},
                  "photos": [{"url": "https://example.com/14-maple.jpg"}],
                  "display": {"courtesy": "Courtesy of Oakwood Realty", "notice": null}}'::jsonb
        where id = ${comps[0]}`,
  );
  await run('realestate.cma.finalize', { cmaId: cma }, agent);
  await run(
    'realestate.cma.save_summary',
    {
      cmaId: cma,
      summary:
        'Two recent sales nearby put 418 Maple between $402,000 and $414,000. An offer at $380,000 is a stretch.',
    },
    agent,
  );
  const next = (
    await run('realestate.cma.start', { dealId: nguyen, homeId: maple, fromCmaId: cma }, agent)
  ).cmaId as string;
  cmaIds = [cma, next];

  // ---------- its offers: one countered, with its contract in two versions; one withdrawn ----------
  const contract = await documentOn(nguyen, 'Offer.pdf', 'offer');
  const terms = {
    priceCents: 40_100_000,
    emdCents: 500_000,
    emdDays: 3,
    sellerCreditCents: 600_000,
    inspectionDays: 7,
    loanType: 'conventional' as const,
    financingDays: 21,
    appraisalContingency: true,
    closingDate: '2026-11-06',
    otherTerms: null,
  };
  const offer = await run(
    'realestate.offer.start',
    {
      dealId: nguyen,
      homeId: maple,
      theirAgentName: 'Kim Ortiz',
      theirBrokerage: 'Oakwood Realty',
      terms,
      respondBy: inDays(3, 2),
      documentId: contract,
      note: 'Seller wants a quick close',
    },
    agent,
  );
  await run(
    'realestate.offer.add_version',
    {
      offerId: offer.offerId,
      side: 'them',
      terms: { ...terms, priceCents: 40_900_000, sellerCreditCents: 0 },
      respondBy: inDays(4, 1),
    },
    agent,
  );
  const counter = await documentOn(nguyen, 'Counter.pdf', 'counter');
  await run(
    'realestate.offer.add_version',
    {
      offerId: offer.offerId,
      side: 'us',
      terms: { ...terms, priceCents: 40_550_000, sellerCreditCents: 300_000 },
      respondBy: inDays(5, 3),
      documentId: counter,
    },
    agent,
  );
  await documentOn(nguyen, 'Counter v2.pdf', 'counter', {
    supersedesId: counter,
    title: 'Counter, initialed',
  });
  await run('realestate.offer.share_summary', { offerId: offer.offerId }, agent);
  const other = await run(
    'realestate.offer.start',
    { dealId: nguyen, homeId: oak, terms: { ...terms, loanType: 'cash', financingDays: null } },
    agent,
  );
  await run(
    'realestate.offer.withdraw',
    { offerId: other.offerId, reason: 'They chose the other home' },
    agent,
  );

  // ---------- a listing: its CMA, offers side by side, the seller's estimate and her choice ----------
  listing = (
    await run(
      'realestate.deal.open',
      {
        side: 'listing',
        name: 'Alvarez listing',
        stage: 'active',
        clientPersonId: maria,
        newPropertyAddress: '2207 Juniper Trail, Austin, TX 78745',
      },
      agent,
    )
  ).dealId;
  cmaIds.push((await run('realestate.cma.start', { dealId: listing }, agent)).cmaId);
  const chen = (
    await run(
      'realestate.offer.start',
      {
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
        respondBy: inDays(4, 2),
      },
      agent,
    )
  ).offerId;
  await run(
    'realestate.offer.start',
    {
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
      respondBy: inDays(5, 2),
    },
    agent,
  );
  for (const [payoffCents, otherNote] of [
    [21_000_000, null],
    [21_240_000, 'HOA transfer'],
  ] as const)
    await run(
      'realestate.net_sheet.save',
      {
        dealId: listing,
        payoffCents,
        listingFeeBp: 300,
        titleEscrowCents: 385_000,
        otherCents: 75_000,
        otherNote,
        note: otherNote ? 'Payoff from the lender’s letter' : null,
      },
      agent,
    );
  const shared = await run('realestate.offers.share_comparison', { dealId: listing }, agent);
  const mariaOnPhone = await mariaSignsIn();
  for (const [choice, words] of [
    ['talk', null],
    ['accept', 'Cash and the 20th works for us.'],
  ] as const)
    await executeCommand(
      worker(),
      op('realestate.portal.offer_choice') as CommandDef,
      {
        workspaceId: ws,
        comparisonId: shared.comparisonId,
        offerId: chen,
        choice,
        words: words ?? undefined,
      },
      mariaOnPhone,
      meta('portal'),
    );
  await run('realestate.offer.record_response', { offerId: chen, outcome: 'accepted' }, agent);
}, 240_000);

afterAll(closeTestDbs);

describe('tours on the phone', () => {
  it('answer what the server answers for the deal’s agent, with and without the canceled ones', async () => {
    const copy = await phoneCopy(agent, ws);
    for (const dealId of [nguyen, listing])
      for (const includeCanceled of [false, true]) {
        const { can: _can, ...server } = await ask(
          'realestate.tours',
          { dealId, includeCanceled },
          agent,
        );
        expect(
          toursOfCopy(copy, dealId, { userId: agent.id, today, includeCanceled }),
          `${dealId} ${includeCanceled}`,
        ).toEqual(server);
      }
  });

  it('aren’t equal by being empty', async () => {
    const copy = await phoneCopy(agent, ws);
    const view = toursOfCopy(copy, nguyen, { userId: agent.id, today, includeCanceled: true })!;
    expect(view.agreement).toMatchObject({ ok: true, signedTitle: 'Buyer agreement.pdf' });
    expect(view.tours.map((t) => t.status).sort()).toEqual([
      'canceled',
      'done',
      'planned',
      'planned',
    ]);
    const done = view.tours.find((t) => t.status === 'done')!;
    expect(done.stops.map((s) => [s.address, s.status])).toEqual([
      ['418 Maple Ave, Austin, TX', 'visited'],
      ['9 Oak Ln, Austin, TX', 'visited'],
      ['77 Pine Ct, Austin, TX', 'skipped'],
    ]);
    expect(done.stops[0]!.feedback.map((f) => [f.name, f.interest, f.words])).toEqual([
      ['Linh Nguyen', 'love', 'The kitchen is perfect'],
      ['Ann Smith', 'maybe', null],
    ]);
    expect(view.tours.find((t) => t.exception)!.exception).toMatchObject({
      reason: 'Agreement signed on paper; scanning it tonight',
      by: { id: owner.id, fullName: 'Rosa Owens' },
    });
    // The listing has no buyer agreement: tours there say so, as the server does.
    expect(toursOfCopy(copy, listing, { userId: agent.id, today })!.agreement).toMatchObject({
      ok: false,
      rule: 'buyer_agreement_needed',
    });
  });

  it('wait for signal on a deal the phone keeps as its summary', async () => {
    const copy = await phoneCopy(owner, ws);
    expect(copy.deals.has(nguyen)).toBe(true);
    expect((await ask('realestate.tours', { dealId: nguyen }, owner)).tours.length).toBe(3);
    expect(toursOfCopy(copy, nguyen, { userId: owner.id, today })).toBeNull();
  });
});

describe('CMAs on the phone', () => {
  it('answer what the server answers for the deal’s agent, but for the fair-housing checks', async () => {
    const copy = await phoneCopy(agent, ws);
    for (const dealId of [nguyen, listing])
      expect(cmasOfCopy(copy, dealId, { userId: agent.id })).toEqual(
        await ask('realestate.cmas', { dealId }, agent),
      );
    for (const cmaId of cmaIds) {
      const {
        cma: { fairHousing: _checks, shareBlocked: _blocked, ...server },
      } = await ask('realestate.cma', { cmaId }, agent);
      expect(cmaOfCopy(copy, cmaId, { userId: agent.id }), cmaId).toEqual({ cma: server });
    }
  });

  it('aren’t equal by being empty', async () => {
    const copy = await phoneCopy(agent, ws);
    expect(
      cmasOfCopy(copy, nguyen, { userId: agent.id })!.cmas.map((c) => [
        c.number,
        c.status,
        c.comps,
      ]),
    ).toEqual([
      [2, 'draft', 4],
      [1, 'final', 4],
    ]);
    const { cma } = cmaOfCopy(copy, cmaIds[0]!, { userId: agent.id })!;
    expect(cma.range).not.toBeNull();
    expect(cma.comps.map((c) => [c.address, c.counted, c.why])).toEqual([
      ['14 Maple Ave', true, null],
      ['301 Oak Hollow', true, null],
      ['5 Linden Pl', false, 'Left out'],
      ['12 Birch Rd', false, 'Pending: shown for context, not counted'],
    ]);
    expect(cma.comps[0]!.mls).toMatchObject({
      mlsNumber: 'ATX-1042',
      sourceWords: 'From the stand-in MLS',
      photoUrl: 'https://example.com/14-maple.jpg',
    });
    expect(cma.comps[1]!.adjustments).toEqual([{ label: 'Newer roof', cents: -500_000 }]);
    expect(cma.summary.unsupportedAmounts).toEqual(['$380,000']);
    // The listing's own home has no square feet yet.
    expect(cmaOfCopy(copy, cmaIds[2]!, { userId: agent.id })!.cma.missing).toMatch(/square feet/);
  });

  it('wait for signal on a deal the phone keeps as its summary', async () => {
    const copy = await phoneCopy(owner, ws);
    expect((await ask('realestate.cmas', { dealId: nguyen }, owner)).cmas.length).toBe(2);
    expect(cmasOfCopy(copy, nguyen, { userId: owner.id })).toBeNull();
    expect(cmaOfCopy(copy, cmaIds[0]!, { userId: owner.id })).toBeNull();
  });
});

describe('offers on the phone', () => {
  it('answer what the server answers for the deal’s agent, on a buyer deal and a listing', async () => {
    const copy = await phoneCopy(agent, ws);
    for (const dealId of [nguyen, listing]) {
      const server = await ask('realestate.offers', { dealId }, agent);
      expect(
        offersOfCopy(copy, dealId, { userId: agent.id, now: Date.now(), timeZone }),
        dealId,
      ).toEqual(server);
    }
  });

  it('aren’t equal by being empty', async () => {
    const copy = await phoneCopy(agent, ws);
    const { offers } = offersOfCopy(copy, nguyen, { userId: agent.id, now: Date.now(), timeZone })!;
    expect(offers.map((o) => [o.number, o.status])).toEqual([
      [2, 'withdrawn'],
      [1, 'waiting_them'],
    ]);
    const countered = offers[1]!;
    expect(
      countered.versions.map((v) => [v.side, v.priceCents, v.document?.title ?? null]),
    ).toEqual([
      ['us', 40_100_000, 'Offer.pdf'],
      ['them', 40_900_000, null],
      // The counter as it stands now: its newer version.
      ['us', 40_550_000, 'Counter, initialed'],
    ]);
    expect(countered.clock).toMatchObject({
      waitingOn: 'them',
      words: expect.stringMatching(/^Due /),
    });
    expect(countered.shared).toMatchObject({ current: true });
    expect(countered.summary.title).toBe('Your counteroffer on 418 Maple Ave');
    expect(countered.summary.next).toContain('Dana will let you know');
    const sold = offersOfCopy(copy, listing, { userId: agent.id, now: Date.now(), timeZone })!;
    expect(sold.offers.map((o) => [o.buyerNames, o.status, o.address])).toEqual([
      ['Priya Patel', 'waiting_us', '2207 Juniper Trail, Austin, TX 78745'],
      ['Wei and Lin Chen', 'accepted', '2207 Juniper Trail, Austin, TX 78745'],
    ]);
  });

  it('side by side, answer what the server answers: the estimate, the figures, what was shared and what she said', async () => {
    const copy = await phoneCopy(agent, ws);
    const server = await ask('realestate.offers.compare', { dealId: listing }, agent);
    const view = offersCompareOfCopy(copy, listing, { userId: agent.id });
    expect(view).toEqual(server);
    expect(view!.figures).toMatchObject({ version: 2, savedBy: { fullName: 'Dana Reyes' } });
    expect(view!.figureHistory.map((f) => f.version)).toEqual([1]);
    expect(view!.rows.map((r) => [r.buyers, r.status, r.best])).toEqual([
      ['Wei and Lin Chen', 'accepted', true],
      ['Priya Patel', 'waiting_us', false],
    ]);
    expect(view!.shared).not.toBeNull();
    expect(view!.choices.map((c) => [c.name, c.choice, c.words])).toEqual([
      ['Maria', 'accept', 'Cash and the 20th works for us.'],
      ['Maria', 'talk', null],
    ]);
    // A buyer deal's offers aren't compared, on the server or the phone.
    expect(offersCompareOfCopy(copy, nguyen, { userId: agent.id })).toBeNull();
  });

  it('wait for signal on a deal the phone keeps as its summary', async () => {
    const copy = await phoneCopy(owner, ws);
    expect((await ask('realestate.offers', { dealId: nguyen }, owner)).offers.length).toBe(2);
    expect(offersOfCopy(copy, nguyen, { userId: owner.id, now: Date.now(), timeZone })).toBeNull();
    expect((await ask('realestate.offers.compare', { dealId: listing }, owner)).rows.length).toBe(
      2,
    );
    expect(offersCompareOfCopy(copy, listing, { userId: owner.id })).toBeNull();
  });
});
