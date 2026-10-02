/**
 * Real Estate Agent, round five, step 8: showings of our listings, in core.
 *
 * - The seller's open times, worked out in the business's time zone: their days and hours, an hour's notice, and
 *   none that a showing already holds.
 * - A buyer's agent asks on the listing's page; the seller says yes or no in their portal (or it's confirmed on its
 *   own); the agent can answer or cancel for them. Feedback comes from the link, by hand or from ShowingTime's
 *   emails, and goes to the seller only once the agent shares it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  feedbackSummary,
  openShowingTimes,
  showingStateWords,
  themesWords,
} from '../../src/addons/realestate/showings';
import { localInstant } from '../../src/calendar/engine/zoned';
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
  type PublicActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const meta = (channel: 'test' | 'booking_page' | 'portal' = 'test') => ({
  correlationId: randomUUID(),
  channel,
});
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const op = (name: string) =>
  [...(realestateAddonServer.commands ?? []), ...(realestateAddonServer.queries ?? [])].find(
    (x) => x.name === name,
  )!;
const runAs = (
  actor: Any,
  db: Any,
  name: string,
  input: Record<string, unknown>,
  channel?: Any,
) => {
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
const run = (name: string, input: Record<string, unknown>) =>
  runAs(human(agent), api(), name, input);
const visitor = (): PublicActor => ({
  type: 'public',
  workspaceId: ws,
  organizationId: org,
  site: 'showing-realty',
  visitor: 'hmac',
});
const asVisitor = (name: string, input: Record<string, unknown>) =>
  runAs(visitor(), worker(), name, { slug: '2207-juniper-trail', ...input }, 'booking_page');
const asSystem = (name: string, input: Record<string, unknown>) =>
  runAs({ type: 'system', workspaceId: ws, organizationId: org }, worker(), name, input);
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let agent: TestUser;
let ws: string;
let org: string;
let maria: string;
let deal: string;
let seller: CustomerActor;

async function signIn(personId: string): Promise<CustomerActor> {
  const scope = { type: 'system' as const, workspaceId: ws, organizationId: org };
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
  return {
    type: 'customer',
    workspaceId: ws,
    organizationId: org,
    personId,
    sessionId: hit.sessionId!,
  };
}
const asSeller = (name: string, input: Record<string, unknown>) =>
  runAs(seller, worker(), name, input, 'portal');

const AGENT = {
  agentName: 'Ana Ruiz',
  brokerage: 'Compass',
  license: '0712345',
  email: 'ana@compass.example',
  phone: '(512) 555-0177',
};

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rsh-owner'),
    createTestUser('rsh-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Showing Realty');
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  maria = (
    await executeCommand(
      api(),
      personCreate,
      {
        workspaceId: ws,
        firstName: 'Maria',
        lastName: 'Alvarez',
        email: `maria-${randomUUID().slice(0, 6)}@example.com`,
      },
      human(agent),
      meta(),
    )
  ).output.personId;
  deal = (
    await run('realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'active',
      clientPersonId: maria,
      newPropertyAddress: '2207 Juniper Trail, Austin, TX 78704',
    })
  ).dealId;
  // Live on the MLS with its page up (round three's own steps are tested there).
  await run('realestate.showing.settings', {
    dealId: deal,
    from: '00:00',
    to: '23:30',
    days: [0, 1, 2, 3, 4, 5, 6],
  });
  await rows(
    admin(),
    sql`update addon_realestate.listings set mls_number = '4821937', mls_live_on = current_date,
          slug = '2207-juniper-trail', page_state = 'published'
        where deal_record_id = ${deal}`,
  );
  seller = await signIn(maria);
}, 120_000);
afterAll(closeTestDbs);

describe('the seller’s open times', () => {
  const zone = 'America/Chicago';
  const settings = { days: [1, 2, 3, 4, 5], from: '10:00', to: '12:00', minutes: 30 };
  // Monday, 2026-10-05, 8:00 AM in Austin.
  const now = localInstant('2026-10-05', '08:00', zone);

  it('are their weekday hours in the business’s time zone, a slot at a time, with an hour’s notice', () => {
    const times = openShowingTimes(settings, zone, [], now);
    expect(times.slice(0, 4)).toEqual([
      new Date(localInstant('2026-10-05', '10:00', zone)).toISOString(),
      new Date(localInstant('2026-10-05', '10:30', zone)).toISOString(),
      new Date(localInstant('2026-10-05', '11:00', zone)).toISOString(),
      new Date(localInstant('2026-10-05', '11:30', zone)).toISOString(),
    ]);
    // Not at the weekend.
    expect(times.some((t) => t.startsWith('2026-10-10') || t.startsWith('2026-10-11'))).toBe(false);
    // Asked at 10:15: 10:30 is too soon, 11:30 isn't.
    const later = openShowingTimes(settings, zone, [], localInstant('2026-10-05', '10:15', zone));
    expect(later[0]).toBe(new Date(localInstant('2026-10-05', '11:30', zone)).toISOString());
  });

  it('leave out any a showing already holds', () => {
    const held = {
      startsAt: new Date(localInstant('2026-10-05', '10:15', zone)),
      endsAt: new Date(localInstant('2026-10-05', '10:45', zone)),
    };
    const times = openShowingTimes(settings, zone, [held], now);
    expect(times[0]).toBe(new Date(localInstant('2026-10-05', '11:00', zone)).toISOString());
  });

  it('say what buyers said, counted', () => {
    expect(
      feedbackSummary([
        { state: 'done', feedback: { interest: 4, liked: 'Patio', pause: null, price: 'right' } },
        { state: 'done', feedback: { interest: 3, liked: null, pause: 'Kitchen', price: 'high' } },
        { state: 'done', feedback: null },
        { state: 'declined', feedback: null },
      ]),
    ).toMatchObject({
      showings: 3,
      answered: 2,
      averageInterest: 3.5,
      price: { low: 0, right: 1, high: 1 },
      words: '3 showings · 2 answered',
    });
    expect(showingStateWords('requested', 'Maria')).toBe('Waiting on Maria');
    expect(
      themesWords([
        { theme: 'The patio and the oaks', count: 3, quotes: [] },
        { theme: 'The main-floor suite', count: 2, quotes: [] },
      ]),
    ).toBe('The patio and the oaks (3), the main-floor suite (2)');
  });
});

describe('a showing asked for on the listing’s page', () => {
  let first: string;
  let times: string[];

  it('takes one of the open times, waits for the seller, and won’t take the same agent twice', async () => {
    const page = await asVisitor('realestate.public.showing_times', {});
    expect(page).toMatchObject({ street: '2207 Juniper Trail', open: true, confirm: 'seller' });
    times = page.times;
    expect(times.length).toBeGreaterThan(10);
    const asked = await asVisitor('realestate.public.request_showing', {
      ...AGENT,
      startsAt: times[0],
    });
    expect(asked).toEqual({ state: 'requested', startsAt: times[0] });
    expect(
      await refused(
        asVisitor('realestate.public.request_showing', { ...AGENT, startsAt: times[1] }),
      ),
    ).toBe('realestate_showing_asked');
    // The time it holds is gone for everyone else.
    expect(
      await refused(
        asVisitor('realestate.public.request_showing', {
          ...AGENT,
          email: 'lee@exp.example',
          startsAt: times[0],
        }),
      ),
    ).toBe('realestate_showing_time_gone');
    expect((await asVisitor('realestate.public.showing_times', {})).times).not.toContain(times[0]);
    const list = await run('realestate.showing.list', { dealId: deal });
    first = list.showings[0].id;
    expect(list.showings[0]).toMatchObject({
      source: 'page',
      sourceLabel: 'Our page',
      state: 'requested',
      stateWords: 'Waiting on Maria',
      agentName: 'Ana Ruiz',
      agentEmail: 'ana@compass.example',
      checked: true,
      can: { confirm: true, decline: true, cancel: true, share: false },
    });
  });

  it('is the seller’s to answer in their portal, who never sees how to get in', async () => {
    await run('realestate.showing.settings', {
      dealId: deal,
      access: 'Lockbox on the back door, code 4417.',
    });
    const mine = await asSeller('realestate.portal.showings', { dealId: deal });
    expect(mine.waiting).toEqual([expect.objectContaining({ id: first, agentName: 'Ana Ruiz' })]);
    expect(JSON.stringify(mine)).not.toMatch(/4417|ana@compass/);
    const yes = await asSeller('realestate.portal.showing_answer', {
      showingId: first,
      answer: 'yes',
    });
    expect(yes.state).toBe('confirmed');
    expect(
      await refused(
        asSeller('realestate.portal.showing_answer', { showingId: first, answer: 'no' }),
      ),
    ).toBe('realestate_showing_settled');
    expect((await asSeller('realestate.portal.showings', { dealId: deal })).upcoming).toEqual([
      expect.objectContaining({ id: first }),
    ]);
    const [h] = await rows<{ by: string }>(
      admin(),
      sql`select after->>'by' as by from addon_realestate.deal_history
          where deal_record_id = ${deal} and what = 'showing_confirmed'`,
    );
    expect(h!.by).toBe('Maria');
  });

  it('takes feedback from its link once, and goes to the seller only when shared', async () => {
    const token = randomBytes(32).toString('base64url');
    await asSystem('realestate.showing.sent', {
      showingId: first,
      what: 'feedback',
      tokenHash: createHash('sha256').update(token).digest('hex'),
    });
    expect((await run('realestate.showing.list', { dealId: deal })).showings[0].state).toBe('done');
    const form = await asVisitor('realestate.public.showing_feedback_form', { token });
    expect(form).toMatchObject({
      street: '2207 Juniper Trail',
      agentName: 'Ana Ruiz',
      answered: false,
    });
    expect(
      await refused(
        asVisitor('realestate.public.showing_feedback_form', {
          token: randomBytes(32).toString('base64url'),
        }),
      ),
    ).toBe('not_found');
    await asVisitor('realestate.public.showing_feedback', {
      token,
      interest: 4,
      liked: 'Loved the patio and the big oaks.',
      pause: 'Kitchen felt small for the price.',
      price: 'high',
    });
    expect(
      await refused(asVisitor('realestate.public.showing_feedback', { token, interest: 2 })),
    ).toBe('realestate_showing_answered');
    const list = await run('realestate.showing.list', { dealId: deal });
    expect(list.summary).toMatchObject({
      showings: 1,
      answered: 1,
      averageInterest: 4,
      interestWords: '4 of 5 on average',
      price: { high: 1 },
    });
    expect((await asSeller('realestate.portal.showings', { dealId: deal })).feedback).toEqual([]);
    // The price review sees it too.
    expect((await run('realestate.listing.prices', { dealId: deal })).showings).toEqual({
      showings: 1,
      answered: 1,
      averageInterest: 4,
      priceHigh: 1,
      words: '1 showing · 1 answered · 1 said the price was high',
    });
    await run('realestate.showing.share_feedback', { showingId: first });
    expect((await asSeller('realestate.portal.showings', { dealId: deal })).feedback).toEqual([
      expect.objectContaining({
        id: first,
        feedback: expect.objectContaining({ interest: 4, price: 'high' }),
      }),
    ]);
  });

  it('is confirmed on its own when the listing says so, and the agent can turn one down or cancel', async () => {
    await run('realestate.showing.settings', { dealId: deal, confirm: 'auto' });
    const page = await asVisitor('realestate.public.showing_times', {});
    expect(page.confirm).toBe('auto');
    const asked = await asVisitor('realestate.public.request_showing', {
      ...AGENT,
      agentName: 'Lee Park',
      brokerage: 'eXp',
      email: 'lee@exp.example',
      startsAt: page.times[3],
    });
    expect(asked.state).toBe('confirmed');
    const lee = (await run('realestate.showing.list', { dealId: deal })).showings.find(
      (s: Any) => s.agentName === 'Lee Park',
    );
    const cancelled = await run('realestate.showing.decide', {
      showingId: lee.id,
      decision: 'cancel',
      note: 'The seller is home sick.',
    });
    expect(cancelled.state).toBe('cancelled');
    expect(
      await refused(run('realestate.showing.decide', { showingId: lee.id, decision: 'confirm' })),
    ).toBe('realestate_showing_settled');
    await run('realestate.showing.settings', { dealId: deal, confirm: 'seller', open: false });
    const closed = await asVisitor('realestate.public.showing_times', {});
    expect(closed).toMatchObject({ open: false, times: [] });
    expect(closed.closedWords).toMatch(/isn’t taking showing requests here right now/);
    expect(
      await refused(
        asVisitor('realestate.public.request_showing', { ...AGENT, startsAt: page.times[5] }),
      ),
    ).toBe('realestate_showings_closed');
    await run('realestate.showing.settings', { dealId: deal, open: true });
  });
});

describe('ShowingTime’s emails', () => {
  it('become showings to check, confirmed and with their feedback, by ShowingTime’s reference', async () => {
    const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const base = { dealId: deal, externalId: `st-${randomUUID()}` };
    const asked = await asSystem('realestate.showing.from_email', {
      ...base,
      kind: 'requested',
      startsAt,
      agentName: 'Sam Ortiz',
      brokerage: 'KW',
    });
    expect(asked.state).toBe('requested');
    const confirmed = await asSystem('realestate.showing.from_email', {
      ...base,
      kind: 'confirmed',
    });
    expect(confirmed).toEqual({ showingId: asked.showingId, state: 'confirmed' });
    await asSystem('realestate.showing.from_email', {
      ...base,
      kind: 'feedback',
      feedback: { interest: 2, liked: null, pause: 'Price high for the area.', price: 'high' },
    });
    let sam = (await run('realestate.showing.list', { dealId: deal })).showings.find(
      (s: Any) => s.id === asked.showingId,
    );
    expect(sam).toMatchObject({
      source: 'showingtime',
      state: 'done',
      checked: false,
      feedbackSource: 'showingtime',
      can: { check: true },
    });
    await run('realestate.showing.check', { showingId: sam.id });
    sam = (await run('realestate.showing.list', { dealId: deal })).showings.find(
      (s: Any) => s.id === asked.showingId,
    );
    expect(sam.checked).toBe(true);
  });
});
