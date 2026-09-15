import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
let member: TestUser;
/** Org B's owner. */
let outsider: TestUser;
let wsA: string;
let orgA: string;
let calendarA: string;

const worker = () => asService({ workspaceId: wsA, organizationId: orgA });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const mismatch = { code: '23514', detail: 'record_workspace_mismatch' };
const refused = { code: '42501', detail: 'attendee_confirmation_protected' };

let phones = 0;
const nextPhone = () => `+1737555${String(1000 + ++phones)}`;

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('confirm-owner'),
    createTestUser('confirm-member'),
    createTestUser('confirm-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Confirm Org A', 'Confirm A');
  wsA = a.wsId;
  orgA = a.orgId;
  await bootstrapOrganization(outsider, 'Confirm Org B', 'Confirm B');
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: wsA, userId: member.id, role: 'member' }]);
  const [c] = await worker()((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status, public)
          values (${wsA}, 'Tune-ups', ${`confirm-${uniq().toLowerCase()}`}, 'active', true) returning id`,
    ),
  );
  calendarA = c!.id;
});
afterAll(closeAll);

/** A new customer's seat on an appointment, as the booking page takes one. */
function seat(appointmentId: string): Promise<string> {
  return worker()(async (tx) => {
    const [p] = await rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name) values (${wsA}, 'Mike') returning id`,
    );
    const [s] = await rows<{ id: string }>(
      tx,
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, contact_phone_e164, sms_ok, source)
          values (${wsA}, ${appointmentId}, ${p!.id}, ${nextPhone()}, true, 'booking_page') returning id`,
    );
    return s!.id;
  });
}

/** Tomorrow's booking from the booking page (a one-on-one unless it's a session), with one customer's seat. */
async function booking(
  kind: 'booking' | 'session' = 'booking',
): Promise<{ appointmentId: string; attendeeId: string }> {
  const [a] = await worker()((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, kind, capacity, title, starts_at,
            ends_at, source)
          values (${wsA}, ${calendarA}, 1, ${kind}::app.appointment_kind, ${kind === 'session' ? 10 : 1},
            'AC tune-up', now() + interval '1 day', now() + interval '1 day 1 hour', 'booking_page')
          returning id`,
    ),
  );
  return { appointmentId: a!.id, attendeeId: await seat(a!.id) };
}

type Confirmation = {
  confirmed_via: string | null;
  confirmed_by: string | null;
  confirmed_recently: boolean | null;
  asked: boolean;
};
const unconfirmed: Confirmation = {
  confirmed_via: null,
  confirmed_by: null,
  confirmed_recently: null,
  asked: false,
};
/** "Recently" means stamped by the database just now, not whatever the caller sent. */
const confirmationOf = (attendeeId: string) =>
  rows<Confirmation>(
    dbs.admin.db,
    sql`select confirmed_via, confirmed_by, confirmed_at > now() - interval '1 minute' as confirmed_recently,
          confirm_asked_at is not null as asked
        from app.appointment_attendees where id = ${attendeeId}`,
  ).then((r) => r[0]!);

const byWorker = (attendeeId: string, set: string) =>
  worker()((tx) =>
    tx.execute(sql`update app.appointment_attendees set ${sql.raw(set)} where id = ${attendeeId}`),
  );
const byPerson = (user: TestUser, attendeeId: string, set: string) =>
  as(user)((tx) =>
    rows(
      tx,
      sql`update app.appointment_attendees set ${sql.raw(set)} where id = ${attendeeId} returning id`,
    ),
  );

describe('customers’ confirmations', () => {
  it('the worker records when it asked and how the customer confirmed; a text finds the open asks', async () => {
    const { attendeeId } = await booking();
    await byWorker(attendeeId, 'confirm_asked_at = now()');
    expect(await confirmationOf(attendeeId)).toEqual({ ...unconfirmed, asked: true });
    // A reply finds the sender's outstanding asks by phone.
    const [phone] = await rows<{ contact_phone_e164: string }>(
      dbs.admin.db,
      sql`select contact_phone_e164 from app.appointment_attendees where id = ${attendeeId}`,
    );
    const outstanding = () =>
      worker()((tx) =>
        rows<{ id: string }>(
          tx,
          sql`select id from app.appointment_attendees
              where workspace_id = ${wsA} and contact_phone_e164 = ${phone!.contact_phone_e164}
                and confirm_asked_at is not null and confirmed_at is null`,
        ),
      );
    expect(await outstanding()).toEqual([{ id: attendeeId }]);
    for (const set of [
      'confirmed_at = now()',
      "confirmed_via = 'sms'",
      "confirmed_at = now(), confirmed_via = 'pigeon'",
      `confirmed_at = now(), confirmed_via = 'sms', confirmed_by = '${member.id}'`,
      `confirmed_by = '${member.id}'`,
    ])
      expect(await code(() => byWorker(attendeeId, set))).toBe('23514');
    for (const via of ['sms', 'link', 'ai']) {
      await byWorker(
        attendeeId,
        `confirmed_at = now(), confirmed_via = '${via}', confirmed_by = null`,
      );
      expect(await confirmationOf(attendeeId)).toMatchObject({ confirmed_via: via, asked: true });
    }
    expect(await outstanding()).toEqual([]);
    // A staff mark names someone from the business.
    await byWorker(attendeeId, `confirmed_via = 'staff', confirmed_by = '${member.id}'`);
    expect(await failure(() => byWorker(attendeeId, `confirmed_by = '${outsider.id}'`))).toEqual(
      mismatch,
    );
    const [idx] = await rows<{ def: string }>(
      dbs.admin.db,
      sql`select indexdef as def from pg_indexes
          where schemaname = 'app' and indexname = 'appointment_attendees_confirm_asks_idx'`,
    );
    expect(idx?.def).toContain('(workspace_id, contact_phone_e164)');
    expect(idx?.def).toContain('WHERE ((confirm_asked_at IS NOT NULL) AND (confirmed_at IS NULL))');
  });
});

describe('staff confirmations', () => {
  it('people mark a booking confirmed only as staff, in their own name, and take back only a staff mark', async () => {
    const { attendeeId } = await booking();
    // A customer's confirmation can't be faked, however it's dressed up.
    for (const set of [
      "confirmed_at = now(), confirmed_via = 'sms'",
      "confirmed_at = now(), confirmed_via = 'link'",
      "confirmed_at = now(), confirmed_via = 'ai'",
      `confirmed_at = now(), confirmed_via = 'staff', confirmed_by = '${owner.id}'`,
      "confirmed_at = now(), confirmed_via = 'staff'",
    ])
      expect(await failure(() => byPerson(member, attendeeId, set))).toEqual(refused);
    // Asking is HandsFreeOS's: the column isn't granted.
    expect(await code(() => byPerson(member, attendeeId, 'confirm_asked_at = now()'))).toBe(
      '42501',
    );
    // Mark confirmed, on the database's clock.
    expect(
      await byPerson(
        member,
        attendeeId,
        `confirmed_at = '2020-01-01', confirmed_via = 'staff', confirmed_by = '${member.id}'`,
      ),
    ).toHaveLength(1);
    expect(await confirmationOf(attendeeId)).toEqual({
      confirmed_via: 'staff',
      confirmed_by: member.id,
      confirmed_recently: true,
      asked: false,
    });
    // Nobody re-names or re-dates a mark; anyone on the team may take it back.
    expect(
      await failure(() => byPerson(owner, attendeeId, `confirmed_by = '${owner.id}'`)),
    ).toEqual(refused);
    expect(
      await failure(() => byPerson(member, attendeeId, "confirmed_at = now() - interval '1 day'")),
    ).toEqual(refused);
    expect(
      await byPerson(
        owner,
        attendeeId,
        'confirmed_at = null, confirmed_via = null, confirmed_by = null',
      ),
    ).toHaveLength(1);
    expect(await confirmationOf(attendeeId)).toEqual(unconfirmed);
    // A customer's confirmation stays theirs: people neither remove it nor write over it.
    await byWorker(attendeeId, "confirmed_at = now(), confirmed_via = 'sms'");
    for (const set of [
      'confirmed_at = null, confirmed_via = null',
      `confirmed_via = 'staff', confirmed_by = '${member.id}'`,
    ])
      expect(await failure(() => byPerson(member, attendeeId, set))).toEqual(refused);
    // Someone from another business finds nothing to change.
    expect(
      await byPerson(outsider, attendeeId, 'confirmed_at = null, confirmed_via = null'),
    ).toHaveLength(0);
  });

  it('a seat a person adds starts unconfirmed and never asked', async () => {
    const { appointmentId } = await booking('session');
    const [p] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsA}, 'Dana') returning id`,
      ),
    );
    const add = (extra: string, values: string) =>
      as(member)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, created_by${sql.raw(extra)})
              values (${wsA}, ${appointmentId}, ${p!.id}, ${member.id}${sql.raw(values)}) returning id`,
        ),
      );
    expect(
      await failure(() =>
        add(', confirmed_at, confirmed_via, confirmed_by', `, now(), 'staff', '${member.id}'`),
      ),
    ).toEqual(refused);
    expect(await failure(() => add(', confirm_asked_at', ', now()'))).toEqual(refused);
    const [added] = await add('', '');
    expect(await confirmationOf(added!.id)).toEqual(unconfirmed);
  });
});

describe('a booking that moves needs confirming again', () => {
  it('a new start clears every seat’s confirmation and ask; a longer visit or new notes keep them', async () => {
    const { appointmentId, attendeeId } = await booking();
    await byWorker(
      attendeeId,
      "confirm_asked_at = now(), confirmed_at = now(), confirmed_via = 'sms'",
    );
    const edit = (set: string) =>
      as(member)((tx) =>
        rows(
          tx,
          sql`update app.appointments set ${sql.raw(set)} where id = ${appointmentId} returning id`,
        ),
      );
    await edit("ends_at = ends_at + interval '30 minutes', notes = 'Bring the tall ladder'");
    expect(await confirmationOf(attendeeId)).toMatchObject({ confirmed_via: 'sms', asked: true });
    // Moved by a person, who can't write those columns themselves.
    await edit(
      "starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours'",
    );
    expect(await confirmationOf(attendeeId)).toEqual(unconfirmed);

    // A session moved by the worker: every seat starts over.
    const session = await booking('session');
    const second = await seat(session.appointmentId);
    await byWorker(
      session.attendeeId,
      "confirm_asked_at = now(), confirmed_at = now(), confirmed_via = 'link'",
    );
    await byWorker(second, 'confirm_asked_at = now()');
    await worker()((tx) =>
      tx.execute(sql`update app.appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day'
        where id = ${session.appointmentId}`),
    );
    expect(await confirmationOf(session.attendeeId)).toEqual(unconfirmed);
    expect(await confirmationOf(second)).toEqual(unconfirmed);
  });

  it('a cancelled seat taken again starts over, and a seat never changes appointments', async () => {
    const { attendeeId } = await booking('session');
    await byWorker(
      attendeeId,
      "confirm_asked_at = now(), confirmed_at = now(), confirmed_via = 'link'",
    );
    // Cancelling keeps what was recorded …
    await byWorker(attendeeId, "status = 'cancelled', cancelled_at = now()");
    expect(await confirmationOf(attendeeId)).toMatchObject({ confirmed_via: 'link', asked: true });
    // … and taking the seat again (how someone moving between sessions lands back in this one) starts over.
    await byWorker(
      attendeeId,
      "status = 'booked', cancelled_at = null, manage_version = manage_version + 1",
    );
    expect(await confirmationOf(attendeeId)).toEqual(unconfirmed);
    // The same when a person re-adds them: it clears without their writing it.
    await byWorker(
      attendeeId,
      "confirmed_at = now(), confirmed_via = 'sms', status = 'cancelled', cancelled_at = now()",
    );
    expect(
      await byPerson(member, attendeeId, "status = 'booked', cancelled_at = null"),
    ).toHaveLength(1);
    expect(await confirmationOf(attendeeId)).toEqual(unconfirmed);
    // A move to another session is a seat there, never a changed appointment_id.
    const other = await booking('session');
    expect(
      await code(() => byWorker(attendeeId, `appointment_id = '${other.appointmentId}'`)),
    ).toBe('23514');
  });
});
