/**
 * Deleting for good, through the Deleted bin (20261027000400; the owner's decisions of 2026-10-08):
 *   - Only an owner deletes, unless an owner gives "Delete for good" out; never the AI, a workflow or the system.
 *   - A customer goes with everything only about them. Their bookings still to come are cancelled first, quietly:
 *     a booking only they were on, and their seat on a class with others.
 *   - A booking still to come is cancelled first, telling the customer when asked.
 *   - The bin lists what's in it; anything can come back until it's emptied, and "Delete now" empties it early.
 *   - What can't go says why, in the database's own words.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointmentAddAttendee,
  appointmentCreate,
  appointmentDelete,
  binEmpty,
  binList,
  binPreview,
  binRestore,
  conversationDelete,
  conversationOpen,
  personDelete,
  personGet,
  personList,
  sessionPublish,
  taskCreate,
} from '../src/server';
import {
  admin,
  ask,
  customer,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let visits: { id: string };
let classes: { id: string };

beforeAll(async () => {
  t = await setupTeam('bin');
  visits = await makeCalendar(t, 'Visits', { team: { members: [{ userId: t.priya.id }] } });
  classes = await makeCalendar(t, 'Classes', {
    team: { members: [{ userId: t.owner.id }] },
    schedule: { mode: 'sessions' },
  });
});
afterAll(closeTestDbs);

const book = async (personId: string, day = nextWeekday(2)) =>
  (
    await run(
      appointmentCreate,
      {
        workspaceId: t.wsId,
        calendarId: visits.id,
        startsAt: isoAt(day, '09:00'),
        personId,
        notify: false,
      },
      t.owner,
    )
  ).appointmentId;

const status = async (appointmentId: string) =>
  (
    await rows<{ status: string; seats_taken: number }>(
      admin(),
      sql`select status::text as status, seats_taken from app.appointments where id = ${appointmentId}`,
    )
  )[0];

const events = (type: string, entityId: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where event_type = ${type} and entity_id = ${entityId} order by occurred_at`,
  );

describe('who may delete for good', () => {
  it('is an owner, never a member unless given it, nor the system', async () => {
    const p = await customer(t, 'Wes', nextPhone());
    await expectHfos(
      () => run(personDelete, { workspaceId: t.wsId, personIds: [p] }, t.member),
      'forbidden',
      403,
    );
    await expectHfos(() => ask(binList, { workspaceId: t.wsId }, t.member), 'forbidden', 403);
    await expectHfos(
      () => runSystem(personDelete, { workspaceId: t.wsId, personIds: [p] }, t.scope),
      'forbidden',
    );
    expect(personDelete.risk).toBe(4);
    expect(binEmpty.risk).toBe(4);
  });
});

describe('deleting a customer', () => {
  it('cancels what they had still to come, quietly, then puts them in the bin', async () => {
    const dana = await customer(t, 'Dana', nextPhone());
    const sam = await customer(t, 'Sam', nextPhone());
    const visit = await book(dana);
    const { appointmentId: session } = await run(
      sessionPublish,
      {
        workspaceId: t.wsId,
        calendarId: classes.id,
        startsAt: isoAt(nextWeekday(3), '15:00'),
        userIds: [t.owner.id],
        capacity: 10,
      },
      t.owner,
    );
    for (const p of [dana, sam])
      await run(
        appointmentAddAttendee,
        { workspaceId: t.wsId, appointmentId: session, personId: p, notify: false },
        t.owner,
      );

    // The box says what goes, and that two bookings get cancelled first; nothing stops it.
    const { items } = await ask(
      binPreview,
      { workspaceId: t.wsId, kind: 'person', ids: [dana] },
      t.owner,
    );
    expect(items).toEqual([
      {
        id: dana,
        name: 'Dana Customer',
        contents: expect.objectContaining({ bookings: 2, upcoming: 2 }),
        rule: null,
        message: null,
      },
    ]);

    const out = await run(personDelete, { workspaceId: t.wsId, personIds: [dana] }, t.owner);
    expect(out.deleted).toEqual([
      { id: dana, binItemId: expect.any(String), name: 'Dana Customer' },
    ]);
    expect(new Date(out.purgeAfter).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // Her visit was cancelled without telling her, and went in the bin with her.
    expect(await status(visit)).toEqual({ status: 'cancelled', seats_taken: expect.any(Number) });
    expect((await events('appointment.cancelled', visit))[0]!.payload).toMatchObject({
      notify: false,
    });
    // The class carries on for Sam, with her seat given up.
    expect(await status(session)).toEqual({ status: 'scheduled', seats_taken: 1 });
    expect((await events('attendee.removed', session))[0]!.payload).toMatchObject({
      personId: dana,
      notify: false,
    });
    expect((await events('person.deleted', dana))[0]!.payload).toMatchObject({
      name: 'Dana Customer',
      binItemId: out.deleted[0]!.binItemId,
    });

    // She's gone from the lists, and her page says where she went.
    const list = await ask(
      personList,
      { workspaceId: t.wsId, includeArchived: true, q: 'dana' },
      t.owner,
    );
    expect(list.items.map((p) => p.id)).not.toContain(dana);
    const gone = await expectHfos(
      () => ask(personGet, { workspaceId: t.wsId, personId: dana }, t.owner),
      'person_in_bin',
      404,
    );
    expect(gone.message).toBe(
      'Dana Customer was deleted. An owner can bring them back from Settings → Deleted bin.',
    );
    // Nothing new is made about her.
    await expectHfos(
      () => run(taskCreate, { workspaceId: t.wsId, title: 'Call Dana', personId: dana }, t.owner),
      'person_in_bin',
    );
    await expectHfos(
      () => run(conversationOpen, { workspaceId: t.wsId, personId: dana }, t.owner),
      'person_in_bin',
    );

    // The bin shows her, who deleted her and when it empties.
    const bin = await ask(binList, { workspaceId: t.wsId }, t.owner);
    expect(bin.items.find((b) => b.recordId === dana)).toMatchObject({
      kind: 'person',
      name: 'Dana Customer',
      // Cancelled by then, so no longer still to come.
      contents: expect.not.objectContaining({ upcoming: expect.anything() }),
      deletedBy: { id: t.owner.id, name: 'Dale Owner' },
      purgeAfter: out.purgeAfter,
      emptying: false,
    });

    // Brought back, she's on the list again; what was cancelled stays cancelled.
    const back = await run(
      binRestore,
      { workspaceId: t.wsId, binItemId: out.deleted[0]!.binItemId },
      t.owner,
    );
    expect(back).toEqual({ kind: 'person', recordId: dana, name: 'Dana Customer', joined: 0 });
    expect(
      (await ask(personGet, { workspaceId: t.wsId, personId: dana }, t.owner)).person.archivedAt,
    ).toBeNull();
    expect(await status(visit)).toMatchObject({ status: 'cancelled' });
  });

  it('takes several at once, and says why one can’t go', async () => {
    const [a, b, c] = [
      await customer(t, 'Ann', nextPhone()),
      await customer(t, 'Bo', nextPhone()),
      await customer(t, 'Cy', nextPhone()),
    ];
    const out = await run(personDelete, { workspaceId: t.wsId, personIds: [a, b, a] }, t.owner);
    expect(out.deleted.map((d) => d.id)).toEqual([a, b]);

    // A plan still billing stops it, in the database's words, and nothing else of the delete happens.
    await rows(
      admin(),
      sql`insert into app.subscriptions (workspace_id, person_id, plan_name, price_cents, status)
          values (${t.wsId}, ${c}, 'Comfort club', 1500, 'active')`,
    );
    const visit = await book(c, nextWeekday(4));
    const e = await expectHfos(
      () => run(personDelete, { workspaceId: t.wsId, personIds: [c] }, t.owner),
      'bin_plan_running',
      409,
    );
    expect(e.message).toBe(
      'Cy Customer has a plan that’s still billing. Cancel it on their Money tab first, then delete them.',
    );
    expect(await status(visit)).toMatchObject({ status: 'scheduled' });
    const { items } = await ask(
      binPreview,
      { workspaceId: t.wsId, kind: 'person', ids: [c] },
      t.owner,
    );
    expect(items[0]).toMatchObject({ rule: 'bin_plan_running', message: e.message });
  });
});

describe('deleting a conversation or a booking', () => {
  it('takes a conversation and leaves the customer', async () => {
    const p = await customer(t, 'Lou', nextPhone());
    const { conversationId } = await run(
      conversationOpen,
      { workspaceId: t.wsId, personId: p },
      t.owner,
    );
    const out = await run(
      conversationDelete,
      { workspaceId: t.wsId, conversationIds: [conversationId] },
      t.owner,
    );
    expect(out.deleted).toEqual([
      { id: conversationId, binItemId: expect.any(String), name: 'Lou Customer' },
    ]);
    expect((await ask(personGet, { workspaceId: t.wsId, personId: p }, t.owner)).person.id).toBe(p);
    await expectHfos(
      () =>
        run(
          conversationDelete,
          { workspaceId: t.wsId, conversationIds: [conversationId] },
          t.owner,
        ),
      'bin_record_gone',
      404,
    );
  });

  it('cancels a booking still to come first, telling them when asked', async () => {
    const p = await customer(t, 'Kim', nextPhone());
    const visit = await book(p, nextWeekday(5));
    const out = await run(
      appointmentDelete,
      { workspaceId: t.wsId, appointmentId: visit, notify: true, reason: 'Moved away' },
      t.owner,
    );
    expect(out.deleted).toEqual([
      { id: visit, binItemId: expect.any(String), name: expect.any(String) },
    ]);
    expect((await events('appointment.cancelled', visit))[0]!.payload).toMatchObject({
      notify: true,
      reason: 'Moved away',
    });
    expect((await events('appointment.deleted', visit)).length).toBe(1);

    // "Delete now": it can't come back after.
    const emptied = await run(
      binEmpty,
      { workspaceId: t.wsId, binItemIds: [out.deleted[0]!.binItemId] },
      t.owner,
    );
    expect(emptied).toEqual({ emptying: 1 });
    expect(
      (await ask(binList, { workspaceId: t.wsId }, t.owner)).items.find(
        (b) => b.recordId === visit,
      ),
    ).toMatchObject({ emptying: true });
    await expectHfos(
      () => run(binRestore, { workspaceId: t.wsId, binItemId: out.deleted[0]!.binItemId }, t.owner),
      'bin_item_emptying',
      409,
    );
    // Emptying the whole bin starts what's left.
    const rest = await run(binEmpty, { workspaceId: t.wsId, all: true }, t.owner);
    expect(rest.emptying).toBeGreaterThan(0);
    expect(
      (await ask(binList, { workspaceId: t.wsId }, t.owner)).items.every((b) => b.emptying),
    ).toBe(true);
    await expectHfos(() => run(binEmpty, { workspaceId: t.wsId }, t.owner), 'validation', 400);
  });

  it('refuses something that was never there', async () => {
    await expectHfos(
      () => run(binRestore, { workspaceId: t.wsId, binItemId: randomUUID() }, t.owner),
      'bin_item_gone',
      404,
    );
  });
});
