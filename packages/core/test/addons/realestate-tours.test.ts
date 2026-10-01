/**
 * Real Estate Agent, round two, step 8: tours, and the agreement rule. A tour needs a signed buyer agreement that
 * covers its day: refused without one, or after it ends, unless an owner or admin lets it through with a reason
 * (never a member, never the AI). Planned, it's one appointment on the agent's calendar, private to the deal, with the
 * client on it and the homes in order; moving, changing or canceling the tour does the same to the appointment.
 * After it, each home is seen or skipped, and what each client thought of the homes they saw is kept.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/calendar/index';
import { localDateOf } from '../../src/calendar/engine/zoned';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  agreementState,
  agreementWords,
  defaultTourMinutes,
  tourNotes,
  tourTitle,
} from '../../src/addons/realestate/tours';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  personCreate,
  scheduleSet,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { CHI, isoAt, makeCalendar, nextWeekday, WEEKDAYS, type Team } from '../calendar-helpers';
import { realestateBusiness } from './realestate-fixture';

describe('the agreement rule', () => {
  const signed = { documentId: randomUUID(), title: 'Buyer agreement' };
  it('needs a signed agreement with an end date that covers the tour’s day', () => {
    expect(agreementState({ signed: null, endsOn: '2026-12-31' }, '2026-10-06')).toMatchObject({
      ok: false,
      rule: 'buyer_agreement_needed',
      reason: 'none',
    });
    expect(agreementState({ signed, endsOn: null }, '2026-10-06')).toMatchObject({
      ok: false,
      rule: 'buyer_agreement_needed',
      reason: 'no_end_date',
    });
    expect(agreementState({ signed, endsOn: '2026-10-05' }, '2026-10-06')).toMatchObject({
      ok: false,
      rule: 'buyer_agreement_expired',
    });
    // It covers the whole of its last day.
    expect(agreementState({ signed, endsOn: '2026-10-06' }, '2026-10-06')).toMatchObject({
      ok: true,
    });
  });

  it('says what’s wrong and what to do', () => {
    const ended = agreementState({ signed, endsOn: '2026-10-05' }, '2026-10-06');
    if (ended.ok) throw new Error('allowed');
    expect(agreementWords(ended, 'Nguyen purchase', '2026-10-06')).toBe(
      'The buyer agreement on Nguyen purchase ends Oct 5, before this tour on Oct 6. Add the signed extension under Documents and change “Buyer agreement ends” under Key dates. An owner or admin can let it through with a reason.',
    );
  });

  it('names a tour by its first home, and lists them in order', () => {
    expect(tourTitle(['418 Maple Ave, Austin, TX'])).toBe('Home tour: 418 Maple Ave');
    expect(tourTitle(['418 Maple Ave, Austin, TX', '9 Oak Ln', '1 Elm St'])).toBe(
      'Home tour: 418 Maple Ave and 2 more',
    );
    expect(tourNotes(['418 Maple Ave', '9 Oak Ln'], 'Lockbox on the side door')).toBe(
      '1. 418 Maple Ave\n2. 9 Oak Ln\n\nLockbox on the side door',
    );
    expect([defaultTourMinutes(1), defaultTourMinutes(3), defaultTourMinutes(40)]).toEqual([
      30, 90, 480,
    ]);
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = (channel: 'test' | 'assistant' = 'test') => ({ correlationId: randomUUID(), channel });
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
const run = (
  who: TestUser,
  name: string,
  input: Record<string, unknown>,
  channel: 'test' | 'assistant' = 'test',
): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(channel),
  ).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(who), meta());
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
let member: TestUser;
let ws: string;
let deal: string;
let client: string;
let calendarId: string;
let maple: string;
let ending: string;
let oak: string;
const day = nextWeekday(2);
const tourAt = isoAt(day, '10:00');

const appointment = async (id: string) =>
  (
    await rows<{ status: string; sealed: boolean; title: string; notes: string; starts: string }>(
      admin(),
      sql`select status::text, sealed, title, notes, starts_at::text as starts from app.appointments where id = ${id}`,
    )
  )[0]!;
const history = async () =>
  (
    await rows<{ what: string; note: string | null }>(
      admin(),
      sql`select what, note from addon_realestate.deal_history where deal_record_id = ${deal} order by at, what`,
    )
  ).filter((h) => h.what.startsWith('tour_'));

/** A signed buyer agreement on the deal, ending on `ends`. */
async function agreement(ends: string): Promise<{ entryId: string }> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: deal,
      name: 'Buyer agreement.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    },
    human(agent),
    meta(),
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  const doc = await run(agent, 'realestate.document.add', {
    dealId: deal,
    fileId: up.output.fileId,
    kind: 'buyer_agreement',
  });
  await run(agent, 'realestate.document.mark_signed', { documentId: doc.documentId });
  return run(agent, 'realestate.term.enter', {
    dealId: deal,
    key: 'buyer_agreement_expiry',
    date: ends,
  });
}

beforeAll(async () => {
  [owner, agent, member] = await Promise.all([
    createTestUser('rto-owner', { fullName: 'Dana Owner' }),
    createTestUser('rto-agent', { fullName: 'Sam Rivera' }),
    createTestUser('rto-member', { fullName: 'Mia Member' }),
  ]);
  ws = await realestateBusiness(owner, 'Tour Realty');
  await admin()
    .insert(workspaceMemberships)
    .values(
      [agent, member].map((u) => ({ workspaceId: ws, userId: u.id, role: 'member' as const })),
    );
  await executeCommand(
    api(),
    scheduleSet,
    { workspaceId: ws, ownerId: agent.id, weekly: WEEKDAYS },
    human(owner),
    meta(),
  );
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  const team = {
    owner,
    wsId: ws,
    scope: { workspaceId: ws, organizationId: w!.org },
  } as unknown as Team;
  calendarId = (await makeCalendar(team, 'Showings', { team: { members: [{ userId: agent.id }] } }))
    .id;
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
    await run(agent, 'realestate.deal.open', {
      side: 'buyer',
      name: 'Nguyen purchase',
      clientPersonId: client,
    })
  ).dealId;
  maple = (
    await run(agent, 'realestate.home.add', { dealId: deal, address: '418 Maple Ave, Austin, TX' })
  ).homeId;
  oak = (await run(agent, 'realestate.home.add', { dealId: deal, address: '9 Oak Ln, Austin, TX' }))
    .homeId;
}, 120_000);

afterAll(closeTestDbs);

describe('planning a tour', () => {
  it('is refused without a signed agreement, saying what to do', async () => {
    const no = await refused(
      run(agent, 'realestate.tour.plan', { dealId: deal, homeIds: [maple], startsAt: tourAt }),
    );
    expect(no.rule).toBe('buyer_agreement_needed');
    expect(no.message).toContain('Nguyen purchase has no signed buyer agreement');
    const view = await ask(agent, 'realestate.tours', { dealId: deal });
    expect(view.agreement).toMatchObject({
      ok: false,
      rule: 'buyer_agreement_needed',
      signedTitle: null,
    });
    expect(view.can.except).toBe(false);
  });

  it('lets only an owner or admin, never a member or the AI, make an exception, and keeps the reason', async () => {
    const exception = { reason: 'Agreement signed on paper; scanning it tonight' };
    expect(
      (
        await refused(
          run(agent, 'realestate.tour.plan', {
            dealId: deal,
            homeIds: [maple],
            startsAt: tourAt,
            exception,
          }),
        )
      ).rule,
    ).toBe('realestate_tour_exception_permission');
    expect(
      (
        await refused(
          run(
            owner,
            'realestate.tour.plan',
            { dealId: deal, homeIds: [maple], startsAt: tourAt, agentUserId: agent.id, exception },
            'assistant',
          ),
        )
      ).rule,
    ).toBe('realestate_tour_exception_person');
    const out = await run(owner, 'realestate.tour.plan', {
      dealId: deal,
      homeIds: [maple],
      startsAt: tourAt,
      agentUserId: agent.id,
      exception,
    });
    expect(out).toMatchObject({ exception: true, startsAt: tourAt });
    const [t] = await rows<{ exception_reason: string; exception_by: string }>(
      admin(),
      sql`select exception_reason, exception_by from addon_realestate.tours where id = ${out.tourId}`,
    );
    expect(t).toEqual({ exception_reason: exception.reason, exception_by: owner.id });
    expect(await history()).toEqual(
      expect.arrayContaining([{ what: 'tour_exception', note: exception.reason }]),
    );
    await run(owner, 'realestate.tour.cancel', { tourId: out.tourId, notifyClient: false });
  });

  it('is refused when the agreement ends before the tour', async () => {
    ending = (await agreement(addDays(day, -1))).entryId;
    const late = await refused(
      run(agent, 'realestate.tour.plan', { dealId: deal, homeIds: [maple], startsAt: tourAt }),
    );
    expect(late.rule).toBe('buyer_agreement_expired');
    expect(late.message).toContain('before this tour');
  });

  it('books one private appointment on the agent’s calendar, with the client and the homes in order', async () => {
    // The signed extension's new end date replaces the old one.
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'buyer_agreement_expiry',
      date: addDays(day, 60),
      replaces: ending,
    });
    const out = await run(agent, 'realestate.tour.plan', {
      dealId: deal,
      homeIds: [oak, maple],
      startsAt: tourAt,
      note: 'Lockbox on the side door',
      notifyClient: false,
    });
    expect(out.exception).toBe(false);
    // Half an hour a home, on the agent's only calendar.
    expect(Date.parse(out.endsAt) - Date.parse(out.startsAt)).toBe(60 * 60_000);
    const a = await appointment(out.appointmentId);
    expect(a).toMatchObject({
      status: 'scheduled',
      sealed: true,
      title: 'Home tour: 9 Oak Ln and 1 more',
    });
    expect(a.notes).toBe(
      '1. 9 Oak Ln, Austin, TX\n2. 418 Maple Ave, Austin, TX\n\nLockbox on the side door',
    );
    const [seat] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.appointment_attendees where appointment_id = ${out.appointmentId}`,
    );
    expect(seat!.person_id).toBe(client);
    const [cal] = await rows<{ calendar_id: string }>(
      admin(),
      sql`select calendar_id from app.appointments where id = ${out.appointmentId}`,
    );
    expect(cal!.calendar_id).toBe(calendarId);
    const view = await ask(agent, 'realestate.tours', { dealId: deal });
    expect(view.agreement).toMatchObject({ ok: true, signedTitle: 'Buyer agreement.pdf' });
    const tour = view.tours.find((t: { id: string }) => t.id === out.tourId);
    expect(tour.stops.map((s: { address: string }) => s.address)).toEqual([
      '9 Oak Ln, Austin, TX',
      '418 Maple Ave, Austin, TX',
    ]);
    // A member off the deal sees neither the tour nor its appointment.
    expect((await refused(ask(member, 'realestate.tours', { dealId: deal }))).rule).toBe(
      'not_found',
    );
  });

  it('changes its homes, time and status with its appointment', async () => {
    const view = await ask(agent, 'realestate.tours', { dealId: deal });
    const tour = view.tours.find((t: { status: string }) => t.status === 'planned');
    await run(agent, 'realestate.tour.set_stops', { tourId: tour.id, homeIds: [maple] });
    expect(await appointment(tour.appointmentId)).toMatchObject({
      title: 'Home tour: 418 Maple Ave',
      notes: '1. 418 Maple Ave, Austin, TX\n\nLockbox on the side door',
    });
    // Past the agreement's end: refused, as planning is.
    expect(
      (
        await refused(
          run(agent, 'realestate.tour.reschedule', {
            tourId: tour.id,
            startsAt: isoAt(addDays(day, 63), '10:00'),
            notifyClient: false,
          }),
        )
      ).rule,
    ).toBe('buyer_agreement_expired');
    const later = isoAt(addDays(day, 1), '14:00');
    const moved = await run(agent, 'realestate.tour.reschedule', {
      tourId: tour.id,
      startsAt: later,
      notifyClient: false,
    });
    expect(moved).toMatchObject({ status: 'planned', startsAt: later });
    expect((await appointment(tour.appointmentId)).starts).toContain(addDays(day, 1));
    const gone = await run(agent, 'realestate.tour.cancel', {
      tourId: tour.id,
      reason: 'The seller took it off the market',
      notifyClient: false,
    });
    expect(gone.status).toBe('canceled');
    expect((await appointment(tour.appointmentId)).status).toBe('cancelled');
    expect((await ask(agent, 'realestate.tours', { dealId: deal })).tours).toEqual([]);
    expect(
      (await ask(agent, 'realestate.tours', { dealId: deal, includeCanceled: true })).tours.length,
    ).toBe(2);
    expect((await history()).map((h) => h.what)).toEqual(
      expect.arrayContaining(['tour_planned', 'tour_stops', 'tour_moved', 'tour_canceled']),
    );
  });
});

describe('after the tour', () => {
  let tourId: string;
  let stops: { id: string; homeId: string }[];

  beforeAll(async () => {
    // Yesterday morning, as the agent puts in one that already happened.
    const yesterday = addDays(localDateOf(Date.now(), CHI), -1);
    const out = await run(agent, 'realestate.tour.plan', {
      dealId: deal,
      homeIds: [maple, oak],
      startsAt: isoAt(yesterday, '10:00'),
      acknowledgeWarnings: true,
      notifyClient: false,
    });
    tourId = out.tourId;
    const view = await ask(agent, 'realestate.tours', { dealId: deal });
    stops = view.tours.find((t: { id: string }) => t.id === tourId).stops;
  });

  it('keeps what each client thought of the homes they saw, and is done once every home is', async () => {
    const [first, second] = stops;
    expect(
      (
        await refused(
          run(agent, 'realestate.tour.feedback', {
            stopId: first!.id,
            personId: client,
            interest: 'love',
          }),
        )
      ).rule,
    ).toBe('realestate_tour_not_seen');
    expect(
      await run(agent, 'realestate.tour.record_visit', {
        stopId: first!.id,
        status: 'visited',
        note: 'Roof looks new',
      }),
    ).toMatchObject({ tourStatus: 'planned' });
    expect(
      await run(agent, 'realestate.tour.feedback', {
        stopId: first!.id,
        personId: client,
        interest: 'love',
        rating: 5,
        words: 'The kitchen is perfect',
      }),
    ).toMatchObject({ updated: false });
    expect(
      await run(agent, 'realestate.tour.feedback', {
        stopId: first!.id,
        personId: client,
        interest: 'maybe',
      }),
    ).toMatchObject({ updated: true });
    expect(
      (
        await refused(
          run(agent, 'realestate.tour.feedback', {
            stopId: first!.id,
            personId: randomUUID(),
            interest: 'no',
          }),
        )
      ).rule,
    ).toBe('realestate_tour_not_client');
    expect(
      (
        await refused(
          run(agent, 'realestate.tour.feedback', {
            stopId: first!.id,
            personId: client,
            interest: 'love',
            words: 'Great for families, she said',
          }),
        )
      ).rule,
    ).toBe('realestate_fair_housing');
    expect(
      await run(agent, 'realestate.tour.record_visit', { stopId: second!.id, status: 'skipped' }),
    ).toMatchObject({
      tourStatus: 'done',
    });
    const view = await ask(agent, 'realestate.tours', { dealId: deal });
    const tour = view.tours.find((t: { id: string }) => t.id === tourId);
    expect(tour.status).toBe('done');
    expect(tour.stops[0].feedback).toEqual([
      expect.objectContaining({
        name: 'Linh Nguyen',
        interest: 'maybe',
        recordedBy: { id: agent.id, fullName: 'Sam Rivera' },
      }),
    ]);
    // The home seen is marked toured; the one skipped isn't.
    const homes = (await ask(agent, 'realestate.homes', { dealId: deal })).homes;
    const statusOf = (id: string) => homes.find((h: { id: string }) => h.id === id).status;
    expect([statusOf(first!.homeId), statusOf(second!.homeId)]).toEqual(['toured', 'saved']);
  });

  it('isn’t marked before it starts', async () => {
    const out = await run(agent, 'realestate.tour.plan', {
      dealId: deal,
      homeIds: [oak],
      startsAt: tourAt,
      notifyClient: false,
    });
    const view = await ask(agent, 'realestate.tours', { dealId: deal });
    const stop = view.tours.find((t: { id: string }) => t.id === out.tourId).stops[0];
    expect(
      (
        await refused(
          run(agent, 'realestate.tour.record_visit', { stopId: stop.id, status: 'visited' }),
        )
      ).rule,
    ).toBe('realestate_tour_not_yet');
  });
});
