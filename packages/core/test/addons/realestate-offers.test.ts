/**
 * Real Estate Agent, round two, step 10: offers and counters. Every version kept as it was sent; who answers next
 * follows the newest; the client sees a version's one-page summary only once it's shared; accepted, its terms go to
 * the deal's key dates unconfirmed and the deal moves to Under contract; lost with no other offer out, the deal goes
 * back to Touring.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { asPortal, closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clockWords,
  dueWords,
  offerSummary,
  termLines,
} from '../../src/addons/realestate/offer-words';
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

const terms = {
  priceCents: 40_550_000,
  emdCents: 500_000,
  emdDays: 3,
  sellerCreditCents: 300_000,
  inspectionDays: 7,
  loanType: 'conventional' as const,
  financingDays: 21,
  appraisalContingency: null,
  closingDate: '2026-11-06',
  otherTerms: null,
};

describe('an offer in words', () => {
  const CHI = 'America/Chicago';
  const now = Date.parse('2026-10-02T15:00:00Z'); // 10:00 AM in Chicago

  it('reads its terms the way the client says them', () => {
    expect(termLines(terms)).toEqual([
      { label: 'Price', value: '$405,500' },
      { label: 'Earnest money', value: '$5,000, within 3 days' },
      { label: 'Seller pays toward your costs', value: '$3,000' },
      { label: 'Inspections', value: '7 days to inspect and ask' },
      { label: 'Your loan', value: 'Conventional, 21 days' },
      { label: 'Closing', value: 'Friday, November 6' },
    ]);
  });

  it('says what happens next, and when', () => {
    const s = offerSummary(
      { ...terms, number: 3, side: 'us', respondBy: '2026-10-02T23:00:00Z' },
      {
        address: '418 Maple Ave, Austin, TX',
        status: 'waiting_them',
        agentFirstName: 'Dana',
        timeZone: CHI,
        now,
      },
    );
    expect(s.title).toBe('Your counteroffer on 418 Maple Ave');
    expect(s.next).toBe(
      'The seller has until today at 6:00 PM to accept, counter or decline. Dana will let you know right away. If they accept, your inspection days start the next day.',
    );
    expect(dueWords('2026-10-03T17:00:00Z', CHI, now)).toBe('tomorrow at 12:00 PM');
    expect(clockWords('2026-10-02T17:14:00Z', now)).toBe('2 h 14 min left');
    expect(clockWords('2026-10-02T14:00:00Z', now)).toBe('passed 1 h ago');
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
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
let client: string;
let deal: string;
let maple: string;
let offer: string;

const stageOf = async (id: string) =>
  (
    await rows<{ stage: string }>(
      admin(),
      sql`select stage from addon_realestate.deals where record_id = ${id}`,
    )
  )[0]!.stage;

async function buyerDeal(name: string): Promise<{ dealId: string; homeId: string }> {
  const dealId = (
    await run('realestate.deal.open', {
      side: 'buyer',
      name,
      clientPersonId: client,
      stage: 'offer',
    })
  ).dealId;
  const homeId = (
    await run('realestate.home.add', {
      dealId,
      address: `${randomUUID().slice(0, 4)} Oak Ln, Austin, TX`,
    })
  ).homeId;
  return { dealId, homeId };
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rof-owner'),
    createTestUser('rof-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Offer Realty');
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
      stage: 'offer',
    })
  ).dealId;
  maple = (await run('realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' }))
    .homeId;
}, 120_000);

afterAll(closeTestDbs);

describe('an offer', () => {
  it('keeps each version as it was sent, and who answers next follows the newest', async () => {
    const started = await run('realestate.offer.start', {
      dealId: deal,
      homeId: maple,
      theirAgentName: 'Kim Ortiz',
      theirBrokerage: 'Oakwood Realty',
      terms: { ...terms, priceCents: 40_100_000, sellerCreditCents: 600_000 },
      respondBy: '2026-10-09T22:00:00Z',
      note: 'Seller wants a quick close',
    });
    offer = started.offerId;
    expect(started.number).toBe(1);
    expect(
      (await refused(run('realestate.offer.start', { dealId: deal, homeId: maple, terms }))).rule,
    ).toBe('realestate_offer_live');
    expect(
      await run('realestate.offer.add_version', {
        offerId: offer,
        side: 'them',
        terms: { ...terms, priceCents: 40_900_000, sellerCreditCents: 0 },
        respondBy: '2026-10-10T17:00:00Z',
      }),
    ).toMatchObject({ number: 2, status: 'waiting_us' });
    expect(
      await run('realestate.offer.add_version', {
        offerId: offer,
        side: 'us',
        terms,
        respondBy: '2026-10-10T23:00:00Z',
      }),
    ).toMatchObject({ number: 3, status: 'waiting_them' });
    // Kept as it was sent.
    await expect(
      admin().execute(
        sql`update addon_realestate.offer_versions set price_cents = 1 where offer_id = ${offer}`,
      ),
    ).rejects.toThrow();
    const [o] = (await ask('realestate.offers', { dealId: deal })).offers;
    expect(
      o.versions.map((v: { side: string; priceCents: number }) => [v.side, v.priceCents]),
    ).toEqual([
      ['us', 40_100_000],
      ['them', 40_900_000],
      ['us', 40_550_000],
    ]);
    expect(o.clock).toMatchObject({ waitingOn: 'them', respondBy: '2026-10-10T23:00:00.000Z' });
    expect(o.summary.title).toBe('Your counteroffer on 418 Maple Ave');
    // The home is marked as offered on.
    const homes = (await ask('realestate.homes', { dealId: deal })).homes;
    expect(homes.find((h: { id: string }) => h.id === maple).status).toBe('offered');
  });

  it('is in the client’s portal only once its summary is shared, and only that version, without the notes', async () => {
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
    const versions = () =>
      asPortal(hit.sessionId!)((tx) =>
        rows<{ number: number }>(
          tx,
          sql`select number from addon_realestate.offer_versions order by number`,
        ),
      );
    expect(await versions()).toEqual([]);
    await run('realestate.offer.share_summary', { offerId: offer });
    expect(await versions()).toEqual([{ number: 3 }]);
    await expect(
      asPortal(hit.sessionId!)((tx) =>
        rows(tx, sql`select note from addon_realestate.offer_versions`),
      ),
    ).rejects.toThrow();
  });

  it('accepted, puts its terms on the deal for a person to confirm, and moves the deal to Under contract', async () => {
    const out = await run('realestate.offer.record_response', {
      offerId: offer,
      outcome: 'accepted',
      at: '2026-10-10T20:00:00Z',
    });
    expect(out).toMatchObject({ status: 'accepted', termsEntered: 9, dealStage: 'under_contract' });
    const entered = await rows<{
      key: string;
      date: string | null;
      cents: number | null;
      confirmed: boolean;
    }>(
      admin(),
      sql`select key, value_date::text as date, value_cents::float8 as cents, confirmed_at is not null as confirmed
          from addon_realestate.term_entries where deal_record_id = ${deal} order by key`,
    );
    expect(entered.every((e) => !e.confirmed)).toBe(true);
    expect(Object.fromEntries(entered.map((e) => [e.key, e.date ?? e.cents]))).toMatchObject({
      acceptance: '2026-10-10',
      emd_due: '2026-10-13',
      inspection_end: '2026-10-17',
      financing_end: '2026-10-31',
      closing: '2026-11-06',
      price: 40_550_000,
      seller_credit: 300_000,
    });
    expect(await stageOf(deal)).toBe('under_contract');
    expect(
      (await refused(run('realestate.offer.add_version', { offerId: offer, side: 'them', terms })))
        .rule,
    ).toBe('realestate_offer_ended');
  });

  it('lost with no other offer out, takes the deal back to Touring; with one still out, doesn’t', async () => {
    const a = await buyerDeal('Second purchase');
    const second = await run('realestate.home.add', {
      dealId: a.dealId,
      address: '77 Pine Ct, Austin, TX',
    });
    const first = await run('realestate.offer.start', {
      dealId: a.dealId,
      homeId: a.homeId,
      terms,
    });
    await run('realestate.offer.start', { dealId: a.dealId, homeId: second.homeId, terms });
    expect(
      await run('realestate.offer.withdraw', {
        offerId: first.offerId,
        reason: 'They chose the other home',
      }),
    ).toMatchObject({ status: 'withdrawn', dealStage: null });
    expect(await stageOf(a.dealId)).toBe('offer');
    const [other] = (await ask('realestate.offers', { dealId: a.dealId })).offers.filter(
      (o: { status: string }) => o.status === 'waiting_them',
    );
    expect(
      await run('realestate.offer.record_response', { offerId: other.id, outcome: 'declined' }),
    ).toMatchObject({
      status: 'declined',
      dealStage: 'touring',
    });
    expect(await stageOf(a.dealId)).toBe('touring');
  });
});
